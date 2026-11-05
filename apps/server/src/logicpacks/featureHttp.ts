// @effect-diagnostics globalFetchInEffect:off preferSchemaOverJson:off globalDateInEffect:off -- the laptop to cloud code check is a plain fetch with a timeout; grant re-check times are process-local.
// @effect-diagnostics effectFnOpportunity:off
import { LP_HOST_PARTICIPANT_ID } from "@logicpacks/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import {
  FeatureAccess,
  FeatureAccessError,
  FeatureLockedError,
  type FeatureSubject,
} from "./FeatureAccess.ts";
export { redeemSignInCode } from "./FeatureAccess.ts";
import {
  codeStatus,
  FEATURE_LABEL,
  GATED_FEATURES,
  isGatedFeature,
  OFFERED_FEATURES,
  REDEEM_MESSAGES,
  type GatedFeature,
} from "./featureCodes.ts";
import { resolveHelperCaller } from "./helperHttp.ts";
import * as ServerSettings from "../serverSettings.ts";
import { MEMBER_PROVIDER_KINDS, memberInstanceId } from "./memberProviders.ts";
import { LogicPacksAccess } from "./LogicPacksAccess.ts";

/**
 * Feature access over HTTP, and the one helper every gated route uses:
 *
 *   const subject = yield* requireFeature("apps");   // 403 feature_locked otherwise
 *   ...pipe(Effect.catchTags({ FeatureLockedError: featureLockedResponse }))
 */

const NO_STORE = { "cache-control": "no-store" };
const json = (body: unknown, status = 200) =>
  HttpServerResponse.jsonUnsafe(body, { status, headers: NO_STORE });

/** The caller as a feature subject (browser session or `lp` token); null when signed out. */
export const featureSubject = Effect.gen(function* () {
  const caller = yield* resolveHelperCaller;
  if (caller === null) return null;
  if (caller.kind === "operator") return { kind: "operator" } as FeatureSubject;
  const access = yield* LogicPacksAccess;
  const user = yield* access.getUser(caller.userId).pipe(Effect.orElseSucceed(() => null));
  return { kind: "member", userId: caller.userId, email: user?.email ?? null } as FeatureSubject;
});

export const lockedMessage = (feature: GatedFeature) =>
  feature === "cloud" || feature === "cloud_agents"
    ? "Cloud workspaces are coming soon. Use the LogicPacks app for Mac or Windows to work with your team now."
    : `${FEATURE_LABEL[feature]} is not unlocked for your account. Redeem an access code to use it.`;

/** The header a laptop host sends its grant in when it talks to the cloud (cloud sync). */
export const GRANT_HEADER = "x-lp-feature-grant";

/**
 * On the cloud host: whether a member may create cloud projects, sync into the cloud and keep
 * AI logins here (the `cloud` feature). A laptop's grant sent along is recorded first.
 */
export const memberHasCloud = Effect.fn("logicpacks.features.memberHasCloud")(function* (user: {
  readonly userId: string;
  readonly email: string | null;
}) {
  const service = yield* Effect.serviceOption(FeatureAccess);
  if (service._tag === "None") return true;
  const features = service.value;
  const subject = { kind: "member", userId: user.userId, email: user.email } as const;
  if (features.has(subject, "cloud")) return true;
  const request = yield* Effect.serviceOption(HttpServerRequest.HttpServerRequest);
  const token = request._tag === "Some" ? request.value.headers[GRANT_HEADER] : undefined;
  if (typeof token !== "string" || token.length === 0) return false;
  const adopted = yield* features
    .adoptGrant(user.userId, token, yield* Clock.currentTimeMillis)
    .pipe(Effect.orElseSucceed(() => false));
  return adopted && features.has(subject, "cloud");
});

/** The 403 a cloud-only action answers for a member without `cloud`. */
export const cloudLockedResponse = () =>
  json({ error: "feature_locked", feature: "cloud", message: lockedMessage("cloud") }, 403);

/** Null when the caller may create or sync projects on this (cloud) host, else the 403. */
export const cloudCreateGate = Effect.gen(function* () {
  const service = yield* Effect.serviceOption(FeatureAccess);
  if (service._tag === "None" || !service.value.isCloudHost) return null;
  const subject = yield* featureSubject;
  if (subject === null || subject.kind === "operator") return null;
  return (yield* memberHasCloud(subject)) ? null : cloudLockedResponse();
});

/** Passes for the host operator, staff and accounts with the feature; else FeatureLockedError. */
export const requireFeatureFor = (subject: FeatureSubject | null, feature: GatedFeature) =>
  Effect.gen(function* () {
    const features = yield* FeatureAccess;
    if (subject !== null && features.has(subject, feature)) return subject;
    return yield* new FeatureLockedError({ feature, message: lockedMessage(feature) });
  });

/** The request's caller must have `feature`. */
export const requireFeature = (feature: GatedFeature) =>
  Effect.flatMap(featureSubject, (subject) => requireFeatureFor(subject, feature));

/** Null when the caller may use `feature`, else the 403 feature_locked answer to return. */
export const featureGate = (feature: GatedFeature) =>
  requireFeature(feature).pipe(
    Effect.matchEffect({
      onFailure: (error) => featureLockedResponse(error),
      onSuccess: () => Effect.succeed(null),
    }),
  );

/**
 * Whether a project participant (a thread's owner: "host" or a member id) has `feature`. For
 * agents, which act for the person whose thread they run in. Allows when feature access is
 * not wired (tests, upstream builds).
 */
export const participantHas = (participantId: string, feature: GatedFeature) =>
  Effect.gen(function* () {
    const service = yield* Effect.serviceOption(FeatureAccess);
    if (service._tag === "None") return true;
    if (participantId === LP_HOST_PARTICIPANT_ID)
      return service.value.has({ kind: "operator" }, feature);
    const access = yield* Effect.serviceOption(LogicPacksAccess);
    const user =
      access._tag === "None"
        ? null
        : yield* access.value.getUser(participantId).pipe(Effect.orElseSucceed(() => null));
    return service.value.has(
      { kind: "member", userId: participantId, email: user?.email ?? null },
      feature,
    );
  });

/** For `Effect.catchTags`: the clean 403 every gated route returns. */
export const featureLockedResponse = (error: FeatureLockedError) =>
  Effect.succeed(
    json({ error: "feature_locked", feature: error.feature, message: error.message }, 403),
  );

/** Wraps a route handler so a missing feature answers 403 feature_locked. */
export const gated = <A, E, R>(feature: GatedFeature, handler: Effect.Effect<A, E, R>) =>
  requireFeature(feature).pipe(
    Effect.matchEffect({ onFailure: featureLockedResponse, onSuccess: () => handler }),
  );

const accessErrorStatus: Record<FeatureAccessError["reason"], number> = {
  invalid: 400,
  unknown: 404,
  revoked: 410,
  expired: 410,
  used_up: 410,
  rate_limited: 429,
  not_found: 404,
  storage: 500,
  unavailable: 503,
};
const accessError = (error: FeatureAccessError) =>
  Effect.succeed(
    json({ error: error.reason, message: error.message }, accessErrorStatus[error.reason]),
  );

const readJson = <A>(schema: Schema.Decoder<A>) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const body = yield* request.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(schema)),
      Effect.option,
    );
    return body._tag === "Some" ? body.value : null;
  });

const meRoute = HttpRouter.add(
  "GET",
  "/api/lp/features",
  Effect.gen(function* () {
    const subject = yield* featureSubject;
    const features = yield* FeatureAccess;
    if (!features.isCloudHost) yield* recheckHostGrant;
    const unlocked = subject === null ? [] : Array.from(features.featuresOf(subject));
    let cloudAccess = unlocked.includes("cloud");
    if (features.isCloudHost && subject !== null && !cloudAccess) {
      // Teammates invited into someone's cloud project work there without a code of their own.
      const access = yield* LogicPacksAccess;
      cloudAccess =
        subject.kind === "operator" || access.visibleProjectIds(subject.userId).size > 0;
    }
    return json({
      signedIn: subject !== null,
      staff: subject !== null && features.isStaff(subject),
      features: unlocked,
      all: GATED_FEATURES,
      /** This server is the LogicPacks cloud. */
      cloudHost: features.isCloudHost,
      /** Cloud host: the caller may use the cloud workspace (else "coming soon"). */
      cloudAccess,
      /** A laptop host's owner redeems codes through the cloud; members ask the owner. */
      canRedeem: subject !== null && (features.isCloudHost || subject.kind === "operator"),
    });
  }),
);

const redeemRoute = HttpRouter.add(
  "POST",
  "/api/lp/features/redeem",
  Effect.gen(function* () {
    const subject = yield* featureSubject;
    if (subject === null) return json({ error: "unauthenticated", message: "Sign in first." }, 401);
    const features = yield* FeatureAccess;
    const body = yield* readJson(Schema.Struct({ code: Schema.String }));
    if (body === null) return json({ error: "bad_request" }, 400);
    if (!features.isCloudHost) {
      if (subject.kind !== "operator") {
        return json(
          { error: "forbidden", message: "Ask the owner of this computer to add the access code." },
          403,
        );
      }
      return yield* redeemThroughCloud(body.code);
    }
    if (subject.kind === "operator") {
      return json({ features: GATED_FEATURES, message: "The host owner has every feature." });
    }
    const unlocked = yield* features.redeem({
      userId: subject.userId,
      code: body.code,
      rateKey: `user:${subject.userId}`,
      nowMs: yield* Clock.currentTimeMillis,
    });
    return json({ unlocked, features: Array.from(features.featuresOf(subject)) });
  }).pipe(Effect.catchTags({ FeatureAccessError: accessError })),
);

const cloudBase = () =>
  ((process.env.LOGICPACKS_CLOUD_URL ?? "").trim() || "https://app.logicpacks.io").replace(
    /\/+$/,
    "",
  );

/** POSTs JSON to the cloud with fetch (short timeout); null when it cannot be reached. */
const postCloud = (path: string, body: unknown) =>
  Effect.promise(async () => {
    try {
      const response = await fetch(`${cloudBase()}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
      const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      return { status: response.status, payload };
    } catch {
      return null;
    }
  });

/** A laptop host: the code goes to the cloud, which answers with a signed grant for this install. */
const redeemThroughCloud = Effect.fn("logicpacks.features.redeemThroughCloud")(function* (
  code: string,
) {
  const features = yield* FeatureAccess;
  const deviceId = yield* features.deviceId();
  const answer = yield* postCloud("/api/lp/features/grant", { code, deviceId });
  if (answer === null) {
    return json(
      {
        error: "unavailable",
        message: "Could not reach LogicPacks to check the code. Try again when online.",
      },
      502,
    );
  }
  const grant = answer.payload["grant"];
  if (answer.status !== 200 || typeof grant !== "string") {
    const message =
      typeof answer.payload["message"] === "string"
        ? answer.payload["message"]
        : REDEEM_MESSAGES.unknown;
    return json(
      { error: String(answer.payload["error"] ?? "unknown"), message },
      answer.status >= 400 ? answer.status : 502,
    );
  }
  const stored = yield* features.setHostGrant(grant, yield* Clock.currentTimeMillis);
  lastGrantCheckMs = Date.now();
  return json({
    unlocked: stored.features,
    features: Array.from(features.featuresOf({ kind: "operator" })),
  });
});

/** A laptop re-checks its grant with the cloud twice a day, so a revoked code stops working. */
let lastGrantCheckMs = 0;
const recheckHostGrant = Effect.gen(function* () {
  const features = yield* FeatureAccess;
  const token = features.hostGrantToken();
  if (token === null || Date.now() - lastGrantCheckMs < 12 * 60 * 60_000) return;
  lastGrantCheckMs = Date.now();
  const answer = yield* postCloud("/api/lp/features/grant/check", { grant: token });
  // Offline or an older cloud: keep the grant.
  if (answer !== null && answer.status === 200 && answer.payload["valid"] === false) {
    yield* features.clearHostGrant().pipe(Effect.ignore);
  }
});

/** The cloud: a laptop's code becomes a grant signed for that install. */
const grantRoute = HttpRouter.add(
  "POST",
  "/api/lp/features/grant",
  Effect.gen(function* () {
    const body = yield* readJson(Schema.Struct({ code: Schema.String, deviceId: Schema.String }));
    if (body === null) return json({ error: "bad_request" }, 400);
    const features = yield* FeatureAccess;
    const grant = yield* features.issueGrant({
      code: body.code,
      deviceId: body.deviceId,
      rateKey: `ip:${yield* requestAddress}`,
      nowMs: yield* Clock.currentTimeMillis,
    });
    return json({ grant });
  }).pipe(Effect.catchTags({ FeatureAccessError: accessError })),
);

const grantCheckRoute = HttpRouter.add(
  "POST",
  "/api/lp/features/grant/check",
  Effect.gen(function* () {
    const body = yield* readJson(Schema.Struct({ grant: Schema.String }));
    if (body === null) return json({ error: "bad_request" }, 400);
    const features = yield* FeatureAccess;
    if (!features.isCloudHost) return json({ error: "not_found" }, 404);
    return json({ valid: features.grantStillValid(body.grant, yield* Clock.currentTimeMillis) });
  }),
);

const requestAddress = Effect.map(HttpServerRequest.HttpServerRequest, (request) =>
  String(
    request.headers["cf-connecting-ip"] ??
      request.headers["x-forwarded-for"] ??
      request.remoteAddress ??
      "local",
  )
    .split(",")[0]!
    .trim(),
);

const requireStaff = Effect.gen(function* () {
  const subject = yield* featureSubject;
  const features = yield* FeatureAccess;
  return subject !== null && features.isStaff(subject) ? subject : null;
});
const staffOnly = json(
  { error: "forbidden", message: "Only LogicPacks staff can open this." },
  403,
);

const codesView = (nowMs: number) =>
  Effect.map(FeatureAccess, (features) =>
    features.codes().map(({ hash: _hash, redeemedBy, ...code }) => ({
      ...code,
      redeemed: redeemedBy.length,
      status: codeStatus({ ...code, hash: "", redeemedBy }, nowMs),
    })),
  );

const codesRoute = HttpRouter.add(
  "GET",
  "/api/lp/ops/codes",
  Effect.gen(function* () {
    if ((yield* requireStaff) === null) return staffOnly;
    const features = yield* FeatureAccess;
    return json({
      codes: yield* codesView(yield* Clock.currentTimeMillis),
      features: OFFERED_FEATURES.map((feature) => ({ feature, label: FEATURE_LABEL[feature] })),
      staff: features.staff(),
      cloudLogins: yield* cloudLoginsView,
    });
  }),
);

const CreateCodeBody = Schema.Struct({
  features: Schema.Array(Schema.String),
  maxUses: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  expiresInDays: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  note: Schema.optionalKey(Schema.String),
});

/**
 * Members' AI logins stored on this host, for the owner: who has one, for which agent, and
 * whether they hold cloud_agents or are grandfathered (connected before the feature existed).
 */
const cloudLoginsView = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const current = yield* settings.getSettings.pipe(Effect.orElseSucceed(() => null));
  const instances = current?.providerInstances ?? {};
  const access = yield* LogicPacksAccess;
  const users = yield* access.listUsers().pipe(Effect.orElseSucceed(() => []));
  const features = yield* FeatureAccess;
  return users.flatMap((user) => {
    const agents = MEMBER_PROVIDER_KINDS.filter((kind) =>
      Object.hasOwn(instances, memberInstanceId(kind, user.userId)),
    );
    if (agents.length === 0) return [];
    const unlocked = features.has(
      { kind: "member", userId: user.userId, email: user.email },
      "cloud",
    );
    return [
      {
        name: user.displayName,
        email: user.email,
        agents,
        status: unlocked ? "unlocked" : "locked",
      },
    ];
  });
});

const createCodeRoute = HttpRouter.add(
  "POST",
  "/api/lp/ops/codes",
  Effect.gen(function* () {
    const subject = yield* requireStaff;
    if (subject === null) return staffOnly;
    const body = yield* readJson(CreateCodeBody);
    if (body === null) return json({ error: "bad_request" }, 400);
    const features = yield* FeatureAccess;
    const nowMs = yield* Clock.currentTimeMillis;
    const days = body.expiresInDays;
    const created = yield* features.createCode({
      features: body.features.filter(isGatedFeature),
      maxUses: body.maxUses ?? null,
      expiresAtMs:
        days === null || days === undefined || !(days > 0) ? null : nowMs + days * 24 * 60 * 60_000,
      note: body.note ?? "",
      createdBy: subject.kind === "operator" ? "Host owner" : (subject.email ?? "Staff"),
      nowMs,
    });
    // The plain code is shown this once; only its hash is kept.
    return json({ code: created.code, codes: yield* codesView(nowMs) }, 201);
  }).pipe(Effect.catchTags({ FeatureAccessError: accessError })),
);

const revokeCodeRoute = HttpRouter.add(
  "POST",
  "/api/lp/ops/codes/revoke",
  Effect.gen(function* () {
    if ((yield* requireStaff) === null) return staffOnly;
    const body = yield* readJson(Schema.Struct({ id: Schema.String }));
    if (body === null) return json({ error: "bad_request" }, 400);
    const features = yield* FeatureAccess;
    const nowMs = yield* Clock.currentTimeMillis;
    yield* features.revokeCode(body.id, nowMs);
    return json({ codes: yield* codesView(nowMs) });
  }).pipe(Effect.catchTags({ FeatureAccessError: accessError })),
);

const StaffBody = Schema.Struct({
  email: Schema.String,
  remove: Schema.optionalKey(Schema.Boolean),
});

/** The staff list (everything unlocked, sees /ops). */
const staffRoute = HttpRouter.add(
  "POST",
  "/api/lp/ops/staff",
  Effect.gen(function* () {
    const subject = yield* requireStaff;
    if (subject === null) return staffOnly;
    const body = yield* readJson(StaffBody);
    if (body === null) return json({ error: "bad_request" }, 400);
    const email = body.email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return json({ error: "invalid", message: "Give an email address." }, 400);
    const features = yield* FeatureAccess;
    if (body.remove) yield* features.removeStaff(email);
    else
      yield* features.putStaff({
        email,
        addedBy: subject.kind === "operator" ? "Host owner" : (subject.email ?? "Staff"),
        addedAtMs: yield* Clock.currentTimeMillis,
      });
    return json({ staff: features.staff() });
  }).pipe(Effect.catchTags({ FeatureAccessError: accessError })),
);

export const layer = Layer.mergeAll(
  meRoute,
  redeemRoute,
  grantRoute,
  grantCheckRoute,
  codesRoute,
  createCodeRoute,
  revokeCodeRoute,
  staffRoute,
);
