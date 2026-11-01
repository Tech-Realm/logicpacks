// @effect-diagnostics effectFnOpportunity:off
// @effect-diagnostics preferSchemaOverJson:off
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { LP_HOST_PARTICIPANT_ID, type ProjectId } from "@logicpacks/contracts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest } from "effect/http";

import * as ServerConfig from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import {
  OFFER_DAYS,
  PACKAGES,
  ROLE_LABEL,
  TALENT_LEVELS,
  TALENT_ROLES,
  VETTING_CHECKS,
  type TalentLevel,
  type TalentRole,
} from "./externalConfig.ts";
import { paymentProvider } from "./externalPayments.ts";
import {
  quote,
  rateCard,
  regionByCode,
  resolveRegion,
  type ResolvedRegion,
} from "./externalPricing.ts";
import {
  acceptOffer,
  activateOffer,
  applyToJob,
  assignOffer,
  claudeDenyRules,
  DRAFT_INSTRUCTIONS,
  draftPrompt,
  endOffer,
  hoursUsed,
  isOpenJob,
  joinedLine,
  jobView,
  logHours,
  makeOffer,
  matchTalent,
  mergeClaudeDeny,
  normalizeBrief,
  OfferRuleError,
  parseModelJson,
  publicTalent,
  publishOffer,
  searchJobs,
  searchTalent,
  secretPatterns,
  settleApplications,
  talentLabel,
  templateBrief,
  withExpiry,
  type Assignment,
  type Brief,
  type Charge,
  type Offer,
} from "./externalTeam.ts";
import { ExternalTeamError, ExternalTeamService } from "./ExternalTeamService.ts";
import type { TalentProfile } from "./externalTalentSeed.ts";
import { FeatureAccess, FeatureLockedError } from "./FeatureAccess.ts";
import { featureLockedResponse } from "./featureHttp.ts";
import type { GatedFeature } from "./featureCodes.ts";
import { resolveHelperCaller } from "./helperHttp.ts";
import { json, queryParam, readBody } from "./http.ts";
import { LogicPacksAccess, type LogicPacksUser } from "./LogicPacksAccess.ts";
import { memberProviderHome } from "./memberLogin.ts";
import { ProjectGoals } from "./ProjectGoals.ts";
import { ProjectLedger } from "./ProjectLedger.ts";
import { ProjectShares } from "./ProjectShares.ts";
import { mailContext } from "./sharesHttp.ts";

/**
 * External team (Beta). A customer describes a need, sees the price at their local rates and
 * accepts; staff (or an applicant from the jobs board) are assigned and join the project as a
 * member scoped to it, with secret files hidden and the brief enforced as a goal.
 */

const errorStatus: Record<ExternalTeamError["reason"], number> = {
  not_found: 404,
  invalid: 409,
  forbidden: 403,
  storage: 500,
};
const teamError = (error: ExternalTeamError) =>
  Effect.succeed(json({ error: error.reason, message: error.message }, errorStatus[error.reason]));

/** Team errors and locked features as clean JSON answers. */
const handled = <A, R>(effect: Effect.Effect<A, ExternalTeamError | FeatureLockedError, R>) =>
  effect.pipe(
    Effect.catchTags({ ExternalTeamError: teamError, FeatureLockedError: featureLockedResponse }),
  );

const fail = (reason: ExternalTeamError["reason"], message: string) =>
  Effect.fail(new ExternalTeamError({ reason, message }));

/** Runs a pure offer rule; its refusals become team errors. */
const rule = <A>(run: () => A) =>
  Effect.try({
    try: run,
    catch: (error) =>
      new ExternalTeamError({
        reason: error instanceof OfferRuleError ? error.reason : "invalid",
        message: error instanceof Error ? error.message : String(error),
      }),
  });

const newId = (prefix: string) => `${prefix}-${NodeCrypto.randomUUID()}`;
const unauthenticated = json({ error: "unauthenticated", message: "Sign in first." }, 401);

// ── Who is asking ──

interface Person {
  readonly kind: "member" | "operator";
  readonly userId: string | null;
  readonly user: LogicPacksUser | null;
  readonly name: string;
  readonly staff: boolean;
}

/** A member (browser or `lp` token), or the host operator; staff is decided here once. */
const person = Effect.gen(function* () {
  const caller = yield* resolveHelperCaller;
  if (caller === null) return null;
  const features = yield* FeatureAccess;
  if (caller.kind === "operator") {
    return {
      kind: "operator",
      userId: null,
      user: null,
      name: "LogicPacks",
      staff: true,
    } satisfies Person;
  }
  const access = yield* LogicPacksAccess;
  const user = yield* access.getUser(caller.userId).pipe(Effect.orElseSucceed(() => null));
  return {
    kind: "member",
    userId: caller.userId,
    user,
    name: user?.displayName ?? "A member",
    staff: user !== null && features.isStaffEmail(user.email),
  } satisfies Person;
});

const requirePerson = Effect.gen(function* () {
  const who = yield* person;
  return who === null ? yield* fail("forbidden", "Sign in first.") : who;
});

const requireStaff = Effect.gen(function* () {
  const who = yield* requirePerson;
  return who.staff ? who : yield* fail("forbidden", "Only LogicPacks staff can open this.");
});

const JOBS_INVITE_ONLY = "Jobs are invite-only for now.";

/** The feature gate for a signed-in person: staff and the host owner have every feature. */
const requireFeatureOf = (feature: GatedFeature, message?: string) =>
  Effect.gen(function* () {
    const who = yield* requirePerson;
    const features = yield* FeatureAccess;
    const subject =
      who.kind === "operator"
        ? ({ kind: "operator" } as const)
        : ({ kind: "member", userId: who.userId!, email: who.user?.email ?? null } as const);
    if (features.has(subject, feature)) return who;
    return yield* new FeatureLockedError({
      feature,
      message:
        message ?? "Talent is not unlocked for your account. Redeem an access code to use it.",
    });
  });

const requireTalent = requireFeatureOf("talent");
const requireJobsAccess = requireFeatureOf("freelancer_jobs", JOBS_INVITE_ONLY);

const header = (name: string) =>
  Effect.map(HttpServerRequest.HttpServerRequest, (request) => request.headers[name] ?? null);

/** The pricing region for this request: CF-IPCountry, Accept-Language, account, then US. */
const requestRegion = (override: string | null) =>
  Effect.gen(function* () {
    const who = yield* person;
    const team = yield* ExternalTeamService;
    const account = who === null ? null : team.accountRegion(who.userId ?? "operator");
    return resolveRegion({
      override,
      cfCountry: yield* header("cf-ipcountry"),
      acceptLanguage: yield* header("accept-language"),
      accountRegion: account,
    });
  });

const regionSourceText = (resolved: ResolvedRegion) =>
  `${resolved.source}${resolved.country ? ` ${resolved.country}` : ""}`;

// ── Project helpers ──

const projectShell = Effect.fn("logicpacks.external.projectShell")(function* (projectId: string) {
  const store = yield* ProjectStore.ProjectStoreV2;
  const shell = yield* store
    .getShell(projectId as ProjectId)
    .pipe(Effect.orElseSucceed(() => Option.none()));
  return Option.isSome(shell) ? shell.value : null;
});

/** Bringing a person into a project is the owner's (or the operator's) call. */
const requireOwner = Effect.fn("logicpacks.external.requireOwner")(function* (
  who: Person,
  projectId: string,
) {
  const access = yield* LogicPacksAccess;
  if (who.kind === "operator") return;
  if (who.userId === null || access.roleOf(who.userId, projectId) !== "owner") {
    return yield* fail("forbidden", "Only the project owner can bring in a vetted freelancer.");
  }
});

const isCustomer = (who: Person, offer: Offer) =>
  who.kind === "operator" ? offer.customerUserId === null : who.userId === offer.customerUserId;

/** A notice in the customer's thread; never fails the request. */
const tellCustomer = (offer: Offer, text: string) =>
  offer.threadId === null
    ? Effect.void
    : Effect.gen(function* () {
        const ledger = yield* ProjectLedger;
        yield* ledger.send({
          projectId: offer.projectId,
          fromThreadId: null,
          fromName: "LogicPacks",
          to: offer.threadId!,
          text,
        });
      }).pipe(
        Effect.asVoid,
        Effect.catchCause((cause) =>
          Effect.logWarning("LogicPacks external notice not sent", { cause }),
        ),
      );

// ── Drafting ──

type DraftMode = "auto" | "model" | "template";
const draftMode = (): DraftMode => {
  const raw = (process.env.LOGICPACKS_EXTERNAL_DRAFT ?? "").trim().toLowerCase();
  return raw === "model" || raw === "template" ? raw : "auto";
};

/**
 * A brief from the customer's words: the host's own text-generation path (the same model
 * and login the app uses for pull request text; no paid API) when there is one, else the
 * built-in template estimator. Either way the result is checked against the template.
 */
const draftBrief = Effect.fn("logicpacks.external.draftBrief")(function* (input: {
  readonly need: string;
  readonly role: TalentRole | null;
  readonly level: TalentLevel | null;
  readonly cwd: string | null;
}) {
  const base = templateBrief({ need: input.need, role: input.role, level: input.level });
  const mode = draftMode();
  if (mode === "template" || input.cwd === null) {
    return { brief: base, note: "Drafted by the built-in estimator (no model used)." };
  }
  const textGeneration = yield* TextGeneration.TextGeneration;
  const settings = yield* ServerSettings.ServerSettingsService;
  const drafted = yield* Effect.gen(function* () {
    const current = yield* settings.getSettings;
    const result = yield* textGeneration.generatePrContent({
      cwd: input.cwd!,
      baseBranch: "brief",
      headBranch: "need",
      commitSummary: draftPrompt(input.need, ""),
      diffSummary: "(none)",
      diffPatch: "(none)",
      policy: {
        kind: "custom",
        changeRequestInstructions: DRAFT_INSTRUCTIONS,
        inferRepositoryConventions: false,
      },
      modelSelection: current.textGenerationModelSelection,
    });
    return parseModelJson(`${result.title}\n${result.body}`);
  }).pipe(
    Effect.timeout(Duration.seconds(45)),
    Effect.catchCause((cause) =>
      Effect.logDebug("Brief drafting model unavailable", { cause }).pipe(Effect.as(null)),
    ),
  );
  if (drafted === null || drafted === undefined) {
    return { brief: base, note: "Drafted by the built-in estimator: no model was available." };
  }
  const merged = normalizeBrief(drafted, base);
  return {
    brief: {
      ...merged,
      role: input.role ?? merged.role,
      level: input.level ?? merged.level,
      draftedBy: "model" as const,
    },
    note: "Drafted with the host's model. Check the hours before you accept.",
  };
});

const RoleField = Schema.optionalKey(
  Schema.NullOr(Schema.Literals(["designer", "developer", "devops"])),
);
const LevelField = Schema.optionalKey(Schema.NullOr(Schema.Literals(["junior", "mid", "senior"])));

const DraftBody = Schema.Struct({
  projectId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  need: Schema.String,
  role: RoleField,
  level: LevelField,
  region: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

const draftRoute = HttpRouter.add(
  "POST",
  "/api/lp/external/draft",
  Effect.gen(function* () {
    yield* requireTalent;
    const body = yield* readBody(DraftBody);
    if (body === null) return json({ error: "bad_request" }, 400);
    const need = body.need.trim();
    if (need.length < 10) return yield* fail("invalid", "Say a little more about what you need.");
    if (need.length > 4000) return yield* fail("invalid", "Keep it under 4000 characters.");
    const shell = body.projectId ? yield* projectShell(body.projectId) : null;
    const drafted = yield* draftBrief({
      need,
      role: body.role ?? null,
      level: body.level ?? null,
      cwd: shell?.workspaceRoot ?? null,
    });
    const resolved = yield* requestRegion(body.region ?? null);
    return json({
      ...drafted,
      quote: quote(resolved.region, drafted.brief.role, drafted.brief.level, drafted.brief.hours),
      region: rateCard(resolved).region,
      payment: paymentProvider().label,
    });
  }).pipe(handled),
);

// ── Pricing ──

const vetting = VETTING_CHECKS.map(({ id, label, detail }) => ({ id, label, detail }));

/** Public: the localised rate card. `?region=` previews another region. */
const pricingRoute = HttpRouter.add(
  "GET",
  "/api/lp/pricing",
  Effect.gen(function* () {
    yield* requireTalent;
    const override = yield* queryParam("region");
    const resolved = yield* requestRegion(override || null);
    return json({
      ...rateCard(resolved),
      vetting,
      offerDays: OFFER_DAYS,
      payment: paymentProvider().label,
    });
  }).pipe(handled),
);

const RegionBody = Schema.Struct({ region: Schema.NullOr(Schema.String) });

const accountRegionRoute = HttpRouter.add(
  "POST",
  "/api/lp/pricing/region",
  Effect.gen(function* () {
    const who = yield* requireTalent;
    const body = yield* readBody(RegionBody);
    if (body === null) return json({ error: "bad_request" }, 400);
    if (body.region !== null && regionByCode(body.region) === null) {
      return yield* fail("invalid", "Unknown region.");
    }
    const team = yield* ExternalTeamService;
    yield* team.setAccountRegion(who.userId ?? "operator", body.region?.toUpperCase() ?? null);
    return json({ region: body.region?.toUpperCase() ?? null });
  }).pipe(handled),
);

const QuoteBody = Schema.Struct({
  role: Schema.Literals(["designer", "developer", "devops"]),
  level: Schema.Literals(["junior", "mid", "senior"]),
  hours: Schema.Number,
  region: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

const quoteRoute = HttpRouter.add(
  "POST",
  "/api/lp/external/quote",
  Effect.gen(function* () {
    yield* requireTalent;
    const body = yield* readBody(QuoteBody);
    if (body === null) return json({ error: "bad_request" }, 400);
    const resolved = yield* requestRegion(body.region ?? null);
    return json({ quote: quote(resolved.region, body.role, body.level, body.hours) });
  }).pipe(handled),
);

// ── Offers ──

/** What the customer (and the person working) sees for an offer. */
const viewOffer = (offer: Offer, viewer: { readonly staff: boolean } | null = null) =>
  Effect.gen(function* () {
    const team = yield* ExternalTeamService;
    const charge = team.chargeFor(offer.id);
    const talent = offer.assignment === null ? undefined : team.talent(offer.assignment.talentId);
    return {
      ...offer,
      assignment:
        offer.assignment === null
          ? null
          : {
              ...offer.assignment,
              // Staff see the join link and email; customers do not need them.
              email: viewer?.staff ? offer.assignment.email : null,
              invitePath: viewer?.staff ? offer.assignment.invitePath : null,
              label: talentLabel(offer.assignment),
            },
      applications: viewer?.staff ? offer.applications : [],
      applicants: offer.applications.filter((a) => a.status === "applied").length,
      talent: talent === undefined ? null : publicTalent(talent),
      hoursUsed: hoursUsed(offer),
      joinedLine: joinedLine(offer),
      charge:
        charge === undefined
          ? null
          : {
              status: charge.status,
              amount: charge.amount,
              currency: charge.currency,
              reference: charge.reference,
            },
      payment: paymentProvider().label,
    };
  });

const OfferBody = Schema.Struct({
  projectId: Schema.String,
  threadId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  need: Schema.optionalKey(Schema.String),
  /** An edited or agent-drafted brief; drafted from `need` when absent. */
  brief: Schema.optionalKey(Schema.Unknown),
  role: RoleField,
  level: LevelField,
  /** Create and accept in one step: the one-screen flow. */
  accept: Schema.optionalKey(Schema.Boolean),
  /** Put it on the jobs board straight away (when accepting without picking a person). */
  publish: Schema.optionalKey(Schema.Boolean),
  region: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

const openCharge = Effect.fn("logicpacks.external.openCharge")(function* (offer: Offer) {
  const team = yield* ExternalTeamService;
  if (team.chargeFor(offer.id) !== undefined) return;
  const nowMs = yield* Clock.currentTimeMillis;
  const pending: Charge = {
    id: newId("chg"),
    offerId: offer.id,
    amount: offer.quote.price,
    currency: offer.quote.currency,
    status: "pending",
    provider: paymentProvider().id,
    reference: null,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
  };
  yield* team.putCharge(pending);
  // The provider seam: today it only records "invoiced". It never moves money here.
  const opened = yield* Effect.tryPromise(() => paymentProvider().open(pending)).pipe(
    Effect.orElseSucceed(() => null),
  );
  if (opened !== null) yield* team.putCharge({ ...pending, ...opened, updatedAtMs: nowMs });
});

const createOfferRoute = HttpRouter.add(
  "POST",
  "/api/lp/external/offers",
  Effect.gen(function* () {
    const who = yield* requireTalent;
    const body = yield* readBody(OfferBody);
    if (body === null) return json({ error: "bad_request" }, 400);
    yield* requireOwner(who, body.projectId);
    const shell = yield* projectShell(body.projectId);
    if (shell === null) return yield* fail("not_found", "No such project.");
    if (body.threadId) {
      const ledger = yield* ProjectLedger;
      const owning = yield* ledger.projectOfThread(body.threadId);
      if (owning !== null && owning !== body.projectId)
        return yield* fail("invalid", "That thread is not in this project.");
    }
    const need = (
      body.need ??
      (typeof (body.brief as { need?: unknown } | undefined)?.need === "string"
        ? (body.brief as { need: string }).need
        : "")
    ).trim();
    if (need.length < 10) return yield* fail("invalid", "Say a little more about what you need.");
    const base =
      body.brief === undefined
        ? (yield* draftBrief({
            need,
            role: body.role ?? null,
            level: body.level ?? null,
            cwd: shell.workspaceRoot,
          })).brief
        : templateBrief({ need, role: body.role ?? null, level: body.level ?? null });
    const brief: Brief =
      body.brief === undefined
        ? base
        : {
            ...normalizeBrief(body.brief, base),
            draftedBy: (body.brief as { draftedBy?: Brief["draftedBy"] }).draftedBy ?? "person",
          };
    const resolved = yield* requestRegion(body.region ?? null);
    const nowMs = yield* Clock.currentTimeMillis;
    let offer = makeOffer({
      id: newId("offer"),
      projectId: body.projectId,
      projectTitle: shell.title,
      threadId: body.threadId ?? null,
      customerUserId: who.userId,
      customerName: who.name,
      brief,
      quote: quote(resolved.region, brief.role, brief.level, brief.hours),
      regionSource: regionSourceText(resolved),
      nowMs,
    });
    if (body.accept === true) {
      offer = yield* rule(() => acceptOffer(offer, who.name, nowMs));
      if (body.publish === true) offer = yield* rule(() => publishOffer(offer, who.name, nowMs));
    }
    const team = yield* ExternalTeamService;
    yield* team.putOffer(offer);
    if (offer.status === "accepted") yield* openCharge(offer);
    return json({ offer: yield* viewOffer(offer) }, 201);
  }).pipe(handled),
);

const OfferIdBody = Schema.Struct({ offerId: Schema.String });

const loadOffer = Effect.fn("logicpacks.external.loadOffer")(function* (offerId: string) {
  const team = yield* ExternalTeamService;
  const offer = team.offer(offerId);
  if (offer === undefined) return yield* fail("not_found", "No such offer.");
  const nowMs = yield* Clock.currentTimeMillis;
  const current = withExpiry(offer, nowMs);
  if (current !== offer) yield* team.putOffer(current);
  return current;
});

const acceptRoute = HttpRouter.add(
  "POST",
  "/api/lp/external/offers/accept",
  Effect.gen(function* () {
    const who = yield* requireTalent;
    const body = yield* readBody(
      Schema.Struct({ offerId: Schema.String, publish: Schema.optionalKey(Schema.Boolean) }),
    );
    if (body === null) return json({ error: "bad_request" }, 400);
    const offer = yield* loadOffer(body.offerId);
    if (!isCustomer(who, offer)) return yield* fail("not_found", "No such offer.");
    const nowMs = yield* Clock.currentTimeMillis;
    let accepted = yield* rule(() => acceptOffer(offer, who.name, nowMs));
    if (body.publish === true)
      accepted = yield* rule(() => publishOffer(accepted, who.name, nowMs));
    const team = yield* ExternalTeamService;
    yield* team.putOffer(accepted);
    yield* openCharge(accepted);
    return json({ offer: yield* viewOffer(accepted) });
  }).pipe(handled),
);

const SharedLoginBody = Schema.Struct({ offerId: Schema.String, allow: Schema.Boolean });

/** The customer's override: let this freelancer run turns on the customer's shared login. Off by default. */
const sharedLoginRoute = HttpRouter.add(
  "POST",
  "/api/lp/external/offers/shared-login",
  Effect.gen(function* () {
    const who = yield* requireTalent;
    const body = yield* readBody(SharedLoginBody);
    if (body === null) return json({ error: "bad_request" }, 400);
    const offer = yield* loadOffer(body.offerId);
    if (!isCustomer(who, offer)) return yield* fail("not_found", "No such offer.");
    const nowMs = yield* Clock.currentTimeMillis;
    const next = { ...offer, allowSharedLogin: body.allow, updatedAtMs: nowMs };
    yield* (yield* ExternalTeamService).putOffer(next);
    return json({ offer: yield* viewOffer(next) });
  }).pipe(handled),
);

// ── Assignment, joining and ending ──

/** Writes (or with `remove`, takes out) the secret-file deny rules in a member's Claude settings. */
const applyClaudeDeny = Effect.fn("logicpacks.external.applyClaudeDeny")(function* (
  userId: string,
  remove: boolean,
) {
  const config = yield* ServerConfig.ServerConfig;
  yield* Effect.sync(() => {
    const home = memberProviderHome(config.stateDir, userId, "claude");
    const file = NodePath.join(home, "settings.json");
    let current: Record<string, unknown> = {};
    try {
      current = JSON.parse(NodeFS.readFileSync(file, "utf8")) as Record<string, unknown>;
    } catch {
      if (remove) return;
    }
    const next = mergeClaudeDeny(
      current,
      claudeDenyRules(secretPatterns(process.env.LOGICPACKS_EXTERNAL_SECRET_PATTERNS)),
      remove,
    );
    NodeFS.mkdirSync(home, { recursive: true, mode: 0o700 });
    NodeFS.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not write external Claude settings", { cause }),
    ),
  );
});

const findUserByEmail = Effect.fn("logicpacks.external.findUserByEmail")(function* (email: string) {
  const access = yield* LogicPacksAccess;
  const users = yield* access.listUsers().pipe(Effect.orElseSucceed(() => []));
  return users.find((user) => user.email.toLowerCase() === email.toLowerCase()) ?? null;
});

/** The brief's milestones as a goal assigned to the person, so drift raises the decision dialog. */
const startGoal = Effect.fn("logicpacks.external.startGoal")(function* (
  offer: Offer,
  userId: string,
) {
  const goals = yield* ProjectGoals;
  const actor = yield* goals.actorFor(
    offer.customerUserId ?? LP_HOST_PARTICIPANT_ID,
    offer.projectId,
  );
  const brief = offer.brief;
  const created = yield* goals.create({
    projectId: offer.projectId,
    actor,
    threadId: offer.threadId,
    plan: {
      title: `Brief: ${brief.title}`.slice(0, 200),
      outcome: brief.scope.slice(0, 1000),
      milestones: brief.milestones.slice(0, 12).map((milestone) => ({
        title: milestone.title.slice(0, 200),
        assignee: userId,
        criteria: milestone.criteria.slice(0, 12).map((c) => c.slice(0, 400)),
        scope: {
          paths: brief.paths.slice(0, 20),
          avoid: brief.avoid.slice(0, 20),
          notes: brief.outOfScope.slice(0, 10).map((n) => n.slice(0, 300)),
        },
      })),
    },
  });
  const confirmed = yield* goals.confirm({ goalId: created.id, actor });
  return confirmed.id;
});

/**
 * An assigned person who now has an account and access to the project joins: the goal
 * starts, their agent gets the secret-file rules and the customer is told. Runs whenever
 * offers are read, so an emailed invite that was claimed at sign-in is picked up.
 */
const reconcile = Effect.fn("logicpacks.external.reconcile")(function* (offer: Offer) {
  if (offer.status !== "assigned" || offer.assignment === null) return offer;
  const access = yield* LogicPacksAccess;
  const user =
    offer.assignment.userId !== null
      ? yield* access.getUser(offer.assignment.userId).pipe(Effect.orElseSucceed(() => null))
      : yield* findUserByEmail(offer.assignment.email);
  if (user === null || access.roleOf(user.userId, offer.projectId) === null) return offer;
  const goalId = yield* startGoal(offer, user.userId).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("External brief goal not started", { cause }).pipe(Effect.as(null)),
    ),
  );
  const nowMs = yield* Clock.currentTimeMillis;
  const active = yield* rule(() => activateOffer(offer, { userId: user.userId, goalId }, nowMs));
  yield* (yield* ExternalTeamService).putOffer(active);
  yield* applyClaudeDeny(user.userId, false);
  yield* tellCustomer(
    active,
    `${joinedLine(active)}. Brings their own AI tools and uses none of your tokens. Secret files are hidden from them, and work outside the brief raises a decision for you.`,
  );
  return active;
});

const reconcileAll = Effect.fn("logicpacks.external.reconcileAll")(function* (
  offers: ReadonlyArray<Offer>,
) {
  const out: Array<Offer> = [];
  for (const offer of offers) {
    out.push(
      yield* reconcile(offer).pipe(
        Effect.catchTags({ ExternalTeamError: () => Effect.succeed(offer) }),
      ),
    );
  }
  return out;
});

/** Adds a person (a profile, or an applicant's own account) to the offer's project. */
const assignPerson = Effect.fn("logicpacks.external.assignPerson")(function* (
  who: Person,
  offer: Offer,
  target: {
    readonly talentId: string;
    readonly name: string;
    readonly role: TalentRole;
    readonly email: string;
  },
) {
  const access = yield* LogicPacksAccess;
  const shares = yield* ProjectShares;
  const nowMs = yield* Clock.currentTimeMillis;
  const existing = yield* findUserByEmail(target.email);
  let inviteId: string | null = null;
  let invitePath: string | null = null;
  let addedMember = false;
  if (existing !== null) {
    if (access.roleOf(existing.userId, offer.projectId) === null) {
      yield* access
        .addMember({
          projectId: offer.projectId,
          actorUserId: null,
          user: existing.email,
          role: "member",
        })
        .pipe(
          Effect.mapError(
            (error) => new ExternalTeamError({ reason: "storage", message: error.message }),
          ),
        );
      addedMember = true;
    }
  } else {
    // No account yet: the ordinary pending project invite, emailed through the share path.
    const outcome = yield* shares
      .share({
        projectId: offer.projectId,
        actorUserId: null,
        user: target.email,
        mail: yield* mailContext(offer.projectId),
      })
      .pipe(
        Effect.mapError(
          (error) => new ExternalTeamError({ reason: "invalid", message: error.message }),
        ),
      );
    addedMember = true;
    if (outcome.kind === "invited") {
      inviteId = outcome.invite.inviteId;
      invitePath = `/lp/join/project?invite=${encodeURIComponent(outcome.invite.token)}`;
    }
  }
  const assignment: Assignment = {
    talentId: target.talentId,
    talentName: target.name,
    role: target.role,
    email: target.email.toLowerCase(),
    userId: existing?.userId ?? null,
    inviteId,
    invitePath,
    addedMember,
    goalId: null,
    assignedBy: who.name,
    assignedAtMs: nowMs,
    joinedAtMs: null,
  };
  const assigned = yield* rule(() => assignOffer(offer, assignment, nowMs));
  yield* (yield* ExternalTeamService).putOffer(assigned);
  return yield* reconcile(assigned);
});

const AssignBody = Schema.Struct({ offerId: Schema.String, talentId: Schema.String });

const assignRoute = HttpRouter.add(
  "POST",
  "/api/lp/ops/assign",
  Effect.gen(function* () {
    const who = yield* requireStaff;
    const body = yield* readBody(AssignBody);
    if (body === null) return json({ error: "bad_request" }, 400);
    const team = yield* ExternalTeamService;
    const offer = yield* loadOffer(body.offerId);
    const talent = team.talent(body.talentId);
    if (talent === undefined || !talent.active) return yield* fail("not_found", "No such profile.");
    const assigned = yield* assignPerson(who, settleApplications(offer, ""), {
      talentId: talent.id,
      name: talent.name,
      role: talent.role,
      email: talent.accountEmail,
    });
    return json({ offer: yield* viewOffer(assigned, who) });
  }).pipe(handled),
);

const endAccess = Effect.fn("logicpacks.external.endAccess")(function* (
  who: Person,
  offer: Offer,
  outcome: "completed" | "cancelled",
) {
  const nowMs = yield* Clock.currentTimeMillis;
  const ended = yield* rule(() => endOffer(offer, outcome, who.name, nowMs));
  const team = yield* ExternalTeamService;
  yield* team.putOffer(ended);
  const assignment = offer.assignment;
  if (assignment !== null) {
    const access = yield* LogicPacksAccess;
    const shares = yield* ProjectShares;
    if (assignment.inviteId !== null && assignment.joinedAtMs === null) {
      yield* shares
        .revokeInvite({
          projectId: offer.projectId,
          actorUserId: null,
          inviteId: assignment.inviteId,
        })
        .pipe(Effect.ignore);
    }
    const userId = offer.assignment?.userId ?? null;
    if (userId !== null) {
      const stillWorking = team
        .offers()
        .some(
          (other) =>
            other.id !== offer.id &&
            other.projectId === offer.projectId &&
            other.assignment?.userId === userId &&
            (other.status === "assigned" || other.status === "active"),
        );
      if (
        assignment.addedMember &&
        !stillWorking &&
        access.roleOf(userId, offer.projectId) === "member"
      ) {
        yield* access
          .removeMember({ projectId: offer.projectId, actorUserId: null, userId })
          .pipe(Effect.ignore);
      }
      if (!team.isExternalAnywhere({ userId, email: assignment.email }))
        yield* applyClaudeDeny(userId, true);
    }
    if (assignment.goalId !== null) {
      const goals = yield* ProjectGoals;
      const host = yield* goals.actorFor(LP_HOST_PARTICIPANT_ID, offer.projectId);
      yield* goals.cancel({ goalId: assignment.goalId, actor: host }).pipe(Effect.ignore);
    }
    yield* tellCustomer(
      ended,
      `${talentLabel(assignment)}: work ${outcome}, ${hoursUsed(ended)} of ${ended.quote.hours} hours used. Their access to this project has ended.`,
    );
  }
  const charge = team.chargeFor(offer.id);
  if (charge !== undefined && outcome === "cancelled" && assignment === null) {
    const voided = yield* Effect.tryPromise(() => paymentProvider().void(charge)).pipe(
      Effect.orElseSucceed(() => ({ status: "void" as const })),
    );
    yield* team.putCharge({ ...charge, ...voided, updatedAtMs: nowMs });
  }
  return ended;
});

const cancelRoute = HttpRouter.add(
  "POST",
  "/api/lp/external/offers/cancel",
  Effect.gen(function* () {
    const who = yield* requirePerson;
    const body = yield* readBody(OfferIdBody);
    if (body === null) return json({ error: "bad_request" }, 400);
    const offer = yield* loadOffer(body.offerId);
    if (!isCustomer(who, offer) && !who.staff) return yield* fail("not_found", "No such offer.");
    return json({ offer: yield* viewOffer(yield* endAccess(who, offer, "cancelled"), who) });
  }).pipe(handled),
);

const completeRoute = HttpRouter.add(
  "POST",
  "/api/lp/ops/complete",
  Effect.gen(function* () {
    const who = yield* requirePerson;
    const body = yield* readBody(OfferIdBody);
    if (body === null) return json({ error: "bad_request" }, 400);
    const offer = yield* loadOffer(body.offerId);
    if (!isCustomer(who, offer) && !who.staff) return yield* fail("not_found", "No such offer.");
    return json({ offer: yield* viewOffer(yield* endAccess(who, offer, "completed"), who) });
  }).pipe(handled),
);

const HoursBody = Schema.Struct({
  offerId: Schema.String,
  hours: Schema.Number,
  note: Schema.optionalKey(Schema.String),
});

/** Staff or the assigned freelancer log hours; over the quota needs a new offer. */
const hoursRoute = HttpRouter.add(
  "POST",
  "/api/lp/external/hours",
  Effect.gen(function* () {
    const who = yield* requirePerson;
    const body = yield* readBody(HoursBody);
    if (body === null) return json({ error: "bad_request" }, 400);
    const offer = yield* loadOffer(body.offerId);
    const assigned =
      offer.assignment !== null && who.userId !== null && offer.assignment.userId === who.userId;
    if (!who.staff && !assigned)
      return yield* fail("forbidden", "Only the assigned freelancer or staff log hours.");
    const nowMs = yield* Clock.currentTimeMillis;
    const next = yield* rule(() =>
      logHours(offer, {
        id: newId("hrs"),
        hours: Math.round(body.hours * 100) / 100,
        note: (body.note ?? "").trim().slice(0, 300),
        by: who.name,
        atMs: nowMs,
      }),
    );
    yield* (yield* ExternalTeamService).putOffer(next);
    return json({ offer: yield* viewOffer(next, who) });
  }).pipe(handled),
);

/** A project's offers, for its members (the customer and the person working); joins are picked up here. */
const listOffersRoute = HttpRouter.add(
  "GET",
  "/api/lp/external/offers",
  Effect.gen(function* () {
    const who = yield* requirePerson;
    const projectId = yield* queryParam("projectId");
    const team = yield* ExternalTeamService;
    const access = yield* LogicPacksAccess;
    if (projectId.length === 0) return yield* fail("invalid", "Name a project.");
    if (
      who.kind === "member" &&
      who.userId !== null &&
      access.roleOf(who.userId, projectId) === null
    ) {
      return yield* fail("not_found", "No such project.");
    }
    const offers = yield* reconcileAll(
      team.offers().filter((offer) => offer.projectId === projectId),
    );
    return json({ offers: yield* Effect.forEach(offers, (offer) => viewOffer(offer, who)) });
  }).pipe(handled),
);

/** Public directory for customers and their agents: no emails or pay. */
const talentSearchRoute = HttpRouter.add(
  "GET",
  "/api/lp/external/talent",
  Effect.gen(function* () {
    yield* requireTalent;
    const team = yield* ExternalTeamService;
    const q = yield* queryParam("q");
    const role = yield* queryParam("role");
    const need = yield* queryParam("need");
    if (need.trim().length > 0) {
      const brief = templateBrief({
        need,
        role: TALENT_ROLES.includes(role as TalentRole) ? (role as TalentRole) : null,
      });
      return json({
        talent: matchTalent(team.talents(), brief).map((match) => ({
          ...publicTalent(match.talent),
          reasons: match.reasons,
        })),
        brief,
      });
    }
    return json({
      talent: searchTalent(team.talents(), { q, role: role || undefined }).map(publicTalent),
    });
  }).pipe(handled),
);

// ── Jobs board (freelancers, invite-only beta) ──

const jobsSearchRoute = HttpRouter.add(
  "GET",
  "/api/lp/jobs",
  Effect.gen(function* () {
    const who = yield* requireJobsAccess;
    const team = yield* ExternalTeamService;
    const role = yield* queryParam("role");
    const skills = yield* queryParam("skills");
    return json({
      jobs: searchJobs(team.offers(), { role: role || undefined, skills: skills || undefined }).map(
        (offer) => jobView(offer, who.userId),
      ),
    });
  }).pipe(handled),
);

const jobShowRoute = HttpRouter.add(
  "GET",
  "/api/lp/jobs/show",
  Effect.gen(function* () {
    const who = yield* requireJobsAccess;
    const team = yield* ExternalTeamService;
    const offer = team.offer(yield* queryParam("id"));
    const mine = offer?.applications.some((a) => a.userId === who.userId) ?? false;
    if (offer === undefined || (!isOpenJob(offer) && !mine))
      return yield* fail("not_found", "No such open job.");
    return json({ job: jobView(offer, who.userId) });
  }).pipe(handled),
);

const ApplyBody = Schema.Struct({
  jobId: Schema.String,
  note: Schema.String,
  hours: Schema.optionalKey(Schema.NullOr(Schema.Number)),
});

const jobApplyRoute = HttpRouter.add(
  "POST",
  "/api/lp/jobs/apply",
  Effect.gen(function* () {
    const who = yield* requireJobsAccess;
    if (who.userId === null || who.user === null)
      return yield* fail("forbidden", "Sign in with your own account to apply.");
    const body = yield* readBody(ApplyBody);
    if (body === null) return json({ error: "bad_request" }, 400);
    const team = yield* ExternalTeamService;
    const offer = team.offer(body.jobId);
    if (offer === undefined) return yield* fail("not_found", "No such open job.");
    if (offer.customerUserId === who.userId)
      return yield* fail("invalid", "You cannot apply to your own job.");
    const nowMs = yield* Clock.currentTimeMillis;
    const hours =
      body.hours == null || !Number.isFinite(body.hours)
        ? null
        : Math.min(200, Math.max(1, Math.round(body.hours)));
    const next = yield* rule(() =>
      applyToJob(offer, {
        id: newId("app"),
        userId: who.userId!,
        name: who.name,
        email: who.user!.email,
        note: body.note.trim().slice(0, 2000),
        hours,
        status: "applied",
        atMs: nowMs,
      }),
    );
    yield* team.putOffer(next);
    return json({ job: jobView(next, who.userId) }, 201);
  }).pipe(handled),
);

const jobsMineRoute = HttpRouter.add(
  "GET",
  "/api/lp/jobs/mine",
  Effect.gen(function* () {
    const who = yield* requireJobsAccess;
    const team = yield* ExternalTeamService;
    const mine = team
      .offers()
      .filter((offer) => offer.applications.some((a) => a.userId === who.userId));
    const settled = yield* reconcileAll(mine);
    return json({
      jobs: settled.map((offer) => {
        const accepted = offer.assignment?.userId === who.userId;
        return {
          ...jobView(offer, who.userId),
          status: offer.status,
          // Once accepted the freelancer sees the real project, to open it.
          projectId: accepted ? offer.projectId : null,
          projectTitle: accepted ? offer.projectTitle : null,
          hoursUsed: accepted ? hoursUsed(offer) : null,
        };
      }),
    });
  }).pipe(handled),
);

const AcceptApplicantBody = Schema.Struct({ offerId: Schema.String, applicationId: Schema.String });

/** Staff or the customer pick an applicant: they join the project like an assigned profile. */
const acceptApplicantRoute = HttpRouter.add(
  "POST",
  "/api/lp/external/applicants/accept",
  Effect.gen(function* () {
    const who = yield* requirePerson;
    const body = yield* readBody(AcceptApplicantBody);
    if (body === null) return json({ error: "bad_request" }, 400);
    const offer = yield* loadOffer(body.offerId);
    if (!who.staff && !isCustomer(who, offer)) return yield* fail("not_found", "No such offer.");
    const application = offer.applications.find(
      (a) => a.id === body.applicationId && a.status === "applied",
    );
    if (application === undefined) return yield* fail("not_found", "No such application.");
    const team = yield* ExternalTeamService;
    const profile = team
      .talents()
      .find((t) => t.accountEmail.toLowerCase() === application.email.toLowerCase());
    const assigned = yield* assignPerson(who, settleApplications(offer, application.id), {
      talentId: profile?.id ?? `user:${application.userId}`,
      name: profile?.name ?? application.name,
      role: profile?.role ?? offer.brief.role,
      email: application.email,
    });
    return json({ offer: yield* viewOffer(assigned, who) });
  }).pipe(handled),
);

// ── Ops (LogicPacks staff) ──

const opsMeRoute = HttpRouter.add(
  "GET",
  "/api/lp/ops/me",
  Effect.gen(function* () {
    const who = yield* person;
    const features = yield* FeatureAccess;
    return json({
      signedIn: who !== null,
      staff: who?.staff ?? false,
      jobs:
        who !== null &&
        (who.staff ||
          (who.userId !== null &&
            features.has(
              { kind: "member", userId: who.userId, email: who.user?.email ?? null },
              "freelancer_jobs",
            ))),
      name: who?.name ?? null,
    });
  }),
);

const inboxRoute = HttpRouter.add(
  "GET",
  "/api/lp/ops/inbox",
  Effect.gen(function* () {
    const who = yield* requireStaff;
    const team = yield* ExternalTeamService;
    const offers = yield* reconcileAll(team.offers());
    return json({ offers: yield* Effect.forEach(offers, (offer) => viewOffer(offer, who)) });
  }).pipe(handled),
);

const opsTalentRoute = HttpRouter.add(
  "GET",
  "/api/lp/ops/talent",
  Effect.gen(function* () {
    yield* requireStaff;
    const team = yield* ExternalTeamService;
    return json({
      talent: searchTalent(team.talents(), {
        q: yield* queryParam("q"),
        role: (yield* queryParam("role")) || undefined,
        availability: (yield* queryParam("availability")) || undefined,
      }),
      roles: TALENT_ROLES.map((role) => ({ role, label: ROLE_LABEL[role] })),
      levels: TALENT_LEVELS,
      vetting,
    });
  }).pipe(handled),
);

const matchesRoute = HttpRouter.add(
  "GET",
  "/api/lp/ops/matches",
  Effect.gen(function* () {
    yield* requireStaff;
    const team = yield* ExternalTeamService;
    const offer = yield* loadOffer(yield* queryParam("offerId"));
    return json({
      matches: matchTalent(team.talents(), { ...offer.brief, hours: offer.quote.hours }).map(
        (match) => ({
          talent: match.talent,
          score: match.score,
          reasons: match.reasons,
        }),
      ),
    });
  }).pipe(handled),
);

const publishRoute = HttpRouter.add(
  "POST",
  "/api/lp/ops/publish",
  Effect.gen(function* () {
    const who = yield* requireStaff;
    const body = yield* readBody(OfferIdBody);
    if (body === null) return json({ error: "bad_request" }, 400);
    const offer = yield* loadOffer(body.offerId);
    const nowMs = yield* Clock.currentTimeMillis;
    const published = yield* rule(() => publishOffer(offer, who.name, nowMs));
    yield* (yield* ExternalTeamService).putOffer(published);
    return json({ offer: yield* viewOffer(published, who) });
  }).pipe(handled),
);

const TalentBody = Schema.Struct({
  id: Schema.String,
  availability: Schema.optionalKey(Schema.Literals(["available", "busy", "away"])),
  hoursFreePerWeek: Schema.optionalKey(Schema.Number),
  active: Schema.optionalKey(Schema.Boolean),
});

/** Quick edits from the directory: availability, free hours, retire a profile. */
const talentEditRoute = HttpRouter.add(
  "POST",
  "/api/lp/ops/talent",
  Effect.gen(function* () {
    yield* requireStaff;
    const body = yield* readBody(TalentBody);
    if (body === null) return json({ error: "bad_request" }, 400);
    const team = yield* ExternalTeamService;
    const current = team.talent(body.id);
    if (current === undefined) return yield* fail("not_found", "No such profile.");
    const next: TalentProfile = {
      ...current,
      ...(body.availability ? { availability: body.availability } : {}),
      ...(body.hoursFreePerWeek !== undefined
        ? { hoursFreePerWeek: Math.max(0, Math.round(body.hoursFreePerWeek)) }
        : {}),
      ...(body.active !== undefined ? { active: body.active } : {}),
    };
    yield* team.putTalent(next);
    return json({ talent: next });
  }).pipe(handled),
);

/** Packages, for the `lp` helper and agents. */
const packagesRoute = HttpRouter.add(
  "GET",
  "/api/lp/external/packages",
  requireTalent.pipe(
    Effect.map(() => json({ packages: PACKAGES })),
    handled,
  ),
);

export const layer = Layer.mergeAll(
  pricingRoute,
  accountRegionRoute,
  quoteRoute,
  draftRoute,
  createOfferRoute,
  acceptRoute,
  sharedLoginRoute,
  cancelRoute,
  completeRoute,
  hoursRoute,
  listOffersRoute,
  talentSearchRoute,
  jobsSearchRoute,
  jobShowRoute,
  jobApplyRoute,
  jobsMineRoute,
  acceptApplicantRoute,
  opsMeRoute,
  inboxRoute,
  opsTalentRoute,
  matchesRoute,
  assignRoute,
  publishRoute,
  talentEditRoute,
  packagesRoute,
);
