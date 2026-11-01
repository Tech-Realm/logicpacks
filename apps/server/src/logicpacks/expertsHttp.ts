// @effect-diagnostics nodeBuiltinImport:off
import { featureGate } from "./featureHttp.ts";
import * as NodeCrypto from "node:crypto";

import type { ProjectId } from "@logicpacks/contracts";
import * as Clock from "effect/Clock";
import * as Option from "effect/Option";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpRouter } from "effect/http";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  briefFromThread,
  browseCatalog,
  OPEN_STATUSES,
  publicExpert,
  revokeGrants,
  transitionRequest,
  validateExpert,
  type AssistanceRequest,
  type Expert,
  type ProviderGrant,
  type RequestAction,
} from "./experts.ts";
import { ExpertsError, ExpertsService } from "./ExpertsService.ts";
import { actorOf, json, queryParam, readBody, resolveCaller, type Caller } from "./http.ts";
import { LogicPacksAccess } from "./LogicPacksAccess.ts";
import {
  isMemberInstanceId,
  isOwnMemberInstance,
  MEMBER_PROVIDER_KINDS,
  memberInstanceId,
} from "./memberProviders.ts";
import { LedgerError, ProjectLedger } from "./ProjectLedger.ts";

/**
 * Request assistance (beta): the expert joins through the ordinary member path and runs
 * turns on the owner's login only once granted, for that project only. Ending the session
 * revokes the grant and the membership the request added.
 */

const errorStatus: Record<ExpertsError["reason"], number> = {
  not_found: 404,
  invalid: 409,
  forbidden: 403,
  storage: 500,
};
const expertsError = (error: ExpertsError) =>
  Effect.succeed(json({ error: error.reason, message: error.message }, errorStatus[error.reason]));
const ledgerError = (error: LedgerError) =>
  Effect.succeed(
    json(
      { error: error.reason, message: error.message },
      error.reason === "not_found" ? 404 : error.reason === "forbidden" ? 403 : 409,
    ),
  );

const fail = (reason: ExpertsError["reason"], message: string) =>
  Effect.fail(new ExpertsError({ reason, message }));

const newId = (prefix: string) => `${prefix}-${NodeCrypto.randomUUID()}`;

const signedIn = Effect.gen(function* () {
  const caller = yield* resolveCaller;
  return caller.kind === "anonymous" ? null : caller;
});

const unauthenticated = json({ error: "unauthenticated" }, 401);

const callerName = Effect.fn("logicpacks.experts.callerName")(function* (caller: Caller) {
  const ledger = yield* ProjectLedger;
  return yield* ledger.personName(caller.kind === "member" ? caller.userId : "host");
});

const callerEmail = Effect.fn("logicpacks.experts.callerEmail")(function* (caller: Caller) {
  if (caller.kind !== "member") return null;
  const access = yield* LogicPacksAccess;
  const user = yield* access.getUser(caller.userId).pipe(Effect.orElseSucceed(() => null));
  return user?.email.toLowerCase() ?? null;
});

/** The caller is the one who asked (or the operator), or the expert, for this request. */
const roleIn = (
  caller: Caller,
  request: AssistanceRequest,
  expert: Expert | undefined,
  email: string | null,
) => {
  const requester =
    caller.kind === "operator"
      ? request.requesterUserId === null
      : caller.kind === "member" && caller.userId === request.requesterUserId;
  if (requester) return "requester" as const;
  if (
    caller.kind === "member" &&
    (caller.userId === request.expertUserId || (email !== null && expert?.accountEmail === email))
  ) {
    return "expert" as const;
  }
  return null;
};

const loadRequest = Effect.fn("logicpacks.experts.loadRequest")(function* (
  caller: Caller,
  requestId: string,
) {
  const experts = yield* ExpertsService;
  const request = experts.request(requestId);
  if (request === undefined) return yield* fail("not_found", "No such request.");
  const expert = experts.expert(request.expertId);
  const role = roleIn(caller, request, expert, yield* callerEmail(caller));
  if (role === null) return yield* fail("not_found", "No such request.");
  return { request, expert, role };
});

/** What the UI shows for a request: the expert card, the grant and the status. */
const viewRequest = Effect.fn("logicpacks.experts.viewRequest")(function* (
  request: AssistanceRequest,
) {
  const experts = yield* ExpertsService;
  const expert = experts.expert(request.expertId);
  const grants = experts
    .grants()
    .filter((grant) => grant.requestId === request.id)
    .map((grant) => ({
      id: grant.id,
      instanceIds: grant.instanceIds,
      ownerName: grant.ownerName,
      createdAtMs: grant.createdAtMs,
      revokedAtMs: grant.revokedAtMs,
    }));
  return {
    ...request,
    expert: expert === undefined ? null : publicExpert(expert),
    grants,
    grantActive: grants.some((grant) => grant.revokedAtMs === null),
  };
});

const step = Effect.fn("logicpacks.experts.step")(function* (
  caller: Caller,
  requestId: string,
  action: RequestAction,
) {
  const experts = yield* ExpertsService;
  const { request, role } = yield* loadRequest(caller, requestId);
  const result = transitionRequest(
    request,
    action,
    { role, name: yield* callerName(caller) },
    yield* Clock.currentTimeMillis,
  );
  if (!result.ok) return yield* fail("invalid", result.message);
  yield* experts.putRequest(result.request);
  return result.request;
});

const revokeForRequest = Effect.fn("logicpacks.experts.revokeForRequest")(function* (
  requestId: string,
) {
  const experts = yield* ExpertsService;
  const revoked = revokeGrants(
    experts.grants(),
    (grant) => grant.requestId === requestId,
    yield* Clock.currentTimeMillis,
  );
  for (const grant of revoked) yield* experts.putGrant(grant);
  return revoked.length;
});

// ── Catalog ──

const catalogRoute = HttpRouter.add(
  "GET",
  "/api/lp/experts",
  Effect.gen(function* () {
    const caller = yield* signedIn;
    if (caller === null) return unauthenticated;
    const locked = yield* featureGate("talent");
    if (locked !== null) return locked;
    const experts = yield* ExpertsService;
    const specialty = yield* queryParam("specialty");
    return json({
      beta: true,
      experts: browseCatalog(experts.experts(), { specialty: specialty || undefined }),
    });
  }),
);

/** A brief to start from, out of the thread's ledger entry and the project's decisions. */
const briefRoute = HttpRouter.add(
  "GET",
  "/api/lp/experts/brief",
  Effect.gen(function* () {
    const caller = yield* signedIn;
    if (caller === null) return unauthenticated;
    const locked = yield* featureGate("talent");
    if (locked !== null) return locked;
    const threadId = yield* queryParam("threadId");
    const ledger = yield* ProjectLedger;
    const projectId = yield* ledger.projectOfThread(threadId);
    const access = yield* LogicPacksAccess;
    if (
      projectId === null ||
      (caller.kind === "member" && access.roleOf(caller.userId, projectId) === null)
    ) {
      return json({ error: "not_found" }, 404);
    }
    const view = yield* ledger.view(projectId);
    const thread = view.threads.find((candidate) => candidate.threadId === threadId);
    return json({
      brief: briefFromThread({
        threadTitle: thread?.title ?? null,
        goal: thread?.goal ?? null,
        files: thread?.files.map((file) => file.path) ?? [],
        decisions: view.decisions.map((decision) => decision.text),
      }),
    });
  }),
);

// ── Requests ──

const CreateBody = Schema.Struct({
  projectId: Schema.String,
  expertId: Schema.String,
  brief: Schema.String,
  fromThreadId: Schema.String,
});

const createRoute = HttpRouter.add(
  "POST",
  "/api/lp/experts/requests",
  Effect.gen(function* () {
    const caller = yield* signedIn;
    if (caller === null) return unauthenticated;
    const locked = yield* featureGate("talent");
    if (locked !== null) return locked;
    const body = yield* readBody(CreateBody);
    if (body === null) return json({ error: "bad_request" }, 400);
    const access = yield* LogicPacksAccess;
    const experts = yield* ExpertsService;
    const ledger = yield* ProjectLedger;
    // Adding someone to a project is the owner's call, so asking for an expert is too.
    if (caller.kind === "member" && access.roleOf(caller.userId, body.projectId) !== "owner") {
      return yield* fail("forbidden", "Only the project owner can bring in an expert.");
    }
    if ((yield* ledger.projectOfThread(body.fromThreadId)) !== body.projectId) {
      return yield* fail("not_found", "That thread is not in this project.");
    }
    const expert = experts.expert(body.expertId);
    if (expert === undefined || !expert.active) return yield* fail("not_found", "No such expert.");
    const brief = body.brief.trim();
    if (brief.length < 10) return yield* fail("invalid", "Say a little about what you need.");
    if (brief.length > 4000) return yield* fail("invalid", "Keep the brief under 4000 characters.");
    const open = experts
      .requests()
      .find(
        (r) =>
          r.projectId === body.projectId && r.expertId === expert.id && OPEN_STATUSES.has(r.status),
      );
    if (open !== undefined)
      return yield* fail("invalid", `${expert.name} already has an open request here.`);
    const nowMs = yield* Clock.currentTimeMillis;
    const name = yield* callerName(caller);
    const request: AssistanceRequest = {
      id: newId("req"),
      projectId: body.projectId,
      projectTitle: yield* projectTitle(body.projectId),
      requesterUserId: actorOf(caller),
      requesterName: name,
      expertId: expert.id,
      expertUserId: null,
      brief,
      fromThreadId: body.fromThreadId,
      expertThreadId: null,
      status: "requested",
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
      history: [{ status: "requested", atMs: nowMs, by: name }],
    };
    yield* experts.putRequest(request);
    return json({ request: yield* viewRequest(request) }, 201);
  }).pipe(Effect.catchTags({ ExpertsError: expertsError })),
);

const projectTitle = Effect.fn("logicpacks.experts.projectTitle")(function* (projectId: string) {
  const store = yield* ProjectStore.ProjectStoreV2;
  const shell = yield* store
    .getShell(projectId as ProjectId)
    .pipe(Effect.orElseSucceed(() => Option.none()));
  return Option.isSome(shell) ? shell.value.title : "Project";
});

/** Requests in a project, for its members; or the caller's inbox as an expert. */
const listRoute = HttpRouter.add(
  "GET",
  "/api/lp/experts/requests",
  Effect.gen(function* () {
    const caller = yield* signedIn;
    if (caller === null) return unauthenticated;
    const experts = yield* ExpertsService;
    const access = yield* LogicPacksAccess;
    const projectId = yield* queryParam("projectId");
    if (projectId.length > 0) {
      if (caller.kind === "member" && access.roleOf(caller.userId, projectId) === null) {
        return json({ error: "not_found" }, 404);
      }
      const list = experts.requests().filter((request) => request.projectId === projectId);
      return json({ requests: yield* Effect.forEach(list, viewRequest) });
    }
    // The inbox: requests addressed to the expert account the caller signed in with.
    const email = yield* callerEmail(caller);
    const mine = experts.requests().filter((request) => {
      const expert = experts.expert(request.expertId);
      return (
        caller.kind === "member" &&
        (request.expertUserId === caller.userId ||
          (email !== null && expert?.accountEmail === email))
      );
    });
    return json({ requests: yield* Effect.forEach(mine, viewRequest) });
  }),
);

const RequestBody = Schema.Struct({ requestId: Schema.String });

/** The expert accepts: they join the project and get their own branch of the thread. */
const acceptRoute = HttpRouter.add(
  "POST",
  "/api/lp/experts/accept",
  Effect.gen(function* () {
    const caller = yield* signedIn;
    if (caller === null || caller.kind !== "member") return unauthenticated;
    const body = yield* readBody(RequestBody);
    if (body === null) return json({ error: "bad_request" }, 400);
    const { request, role } = yield* loadRequest(caller, body.requestId);
    if (role !== "expert") return yield* fail("forbidden", "Only the expert can accept.");
    if (request.status !== "requested")
      return yield* fail("invalid", `This request is ${request.status}.`);
    const access = yield* LogicPacksAccess;
    const user = yield* access.getUser(caller.userId).pipe(Effect.orElseSucceed(() => null));
    if (user === null) return yield* fail("not_found", "Unknown account.");
    // The ordinary member path: the same row "Share project" writes, removed again on end.
    const addedMember = access.roleOf(caller.userId, request.projectId) === null;
    if (addedMember) {
      yield* access
        .addMember({
          projectId: request.projectId,
          actorUserId: null,
          user: user.email,
          role: "member",
        })
        .pipe(
          Effect.mapError(
            (error) => new ExpertsError({ reason: "storage", message: error.message }),
          ),
        );
    }
    const ledger = yield* ProjectLedger;
    const expertThreadId =
      request.fromThreadId === null
        ? null
        : (yield* ledger.branch({
            threadId: request.fromThreadId,
            participantId: caller.userId,
            title: `Assistance: ${user.displayName}`,
          })).threadId;
    const stepped = yield* step(caller, request.id, {
      kind: "accept",
      expertUserId: caller.userId,
      expertThreadId,
    });
    const accepted = { ...stepped, addedMember };
    yield* (yield* ExpertsService).putRequest(accepted);
    if (request.fromThreadId !== null && expertThreadId !== null) {
      yield* ledger
        .send({
          projectId: request.projectId,
          fromThreadId: expertThreadId,
          fromName: user.displayName,
          to: request.fromThreadId,
          text: `${user.displayName} accepted your request and joined the project. Their thread: "Assistance: ${user.displayName}".`,
        })
        .pipe(Effect.ignore);
    }
    return json({ request: yield* viewRequest(accepted) });
  }).pipe(Effect.catchTags({ ExpertsError: expertsError, LedgerError: ledgerError })),
);

const declineRoute = HttpRouter.add(
  "POST",
  "/api/lp/experts/decline",
  Effect.gen(function* () {
    const caller = yield* signedIn;
    if (caller === null) return unauthenticated;
    const body = yield* readBody(RequestBody);
    if (body === null) return json({ error: "bad_request" }, 400);
    return json({
      request: yield* viewRequest(yield* step(caller, body.requestId, { kind: "decline" })),
    });
  }).pipe(Effect.catchTags({ ExpertsError: expertsError })),
);

const StatusBody = Schema.Struct({
  requestId: Schema.String,
  status: Schema.Literals(["working", "done"]),
});

const statusRoute = HttpRouter.add(
  "POST",
  "/api/lp/experts/status",
  Effect.gen(function* () {
    const caller = yield* signedIn;
    if (caller === null) return unauthenticated;
    const body = yield* readBody(StatusBody);
    if (body === null) return json({ error: "bad_request" }, 400);
    const updated = yield* step(caller, body.requestId, { kind: body.status });
    return json({ request: yield* viewRequest(updated) });
  }).pipe(Effect.catchTags({ ExpertsError: expertsError })),
);

const GrantBody = Schema.Struct({
  requestId: Schema.String,
  /** Which of the owner's logins; all connected ones when absent. */
  providers: Schema.optionalKey(Schema.Array(Schema.String)),
});

/**
 * The owner lets the expert run turns on their logins, in this project only. The
 * owner's member instances (`claude-lp-…`, `codex-lp-…`), or the host's for the operator.
 */
const grantRoute = HttpRouter.add(
  "POST",
  "/api/lp/experts/grant",
  Effect.gen(function* () {
    const caller = yield* signedIn;
    if (caller === null) return unauthenticated;
    const locked = yield* featureGate("talent");
    if (locked !== null) return locked;
    const body = yield* readBody(GrantBody);
    if (body === null) return json({ error: "bad_request" }, 400);
    const { request, role } = yield* loadRequest(caller, body.requestId);
    if (role !== "requester")
      return yield* fail("forbidden", "Only the person who asked can share their login.");
    if (
      request.expertUserId === null ||
      !OPEN_STATUSES.has(request.status) ||
      request.status === "requested"
    ) {
      return yield* fail("invalid", "Share your login once the expert has accepted.");
    }
    const settings = yield* ServerSettings.ServerSettingsService;
    const current = yield* settings.getSettings.pipe(
      Effect.mapError((error) => new ExpertsError({ reason: "storage", message: error.message })),
    );
    const owned = Object.keys(current.providerInstances ?? {}).filter((instanceId) =>
      caller.kind === "member"
        ? isOwnMemberInstance(instanceId, caller.userId)
        : !isMemberInstanceId(instanceId),
    );
    const wanted =
      body.providers === undefined
        ? owned
        : owned.filter((instanceId) =>
            body.providers!.some(
              (kind) =>
                instanceId === kind ||
                (caller.kind === "member" &&
                  (MEMBER_PROVIDER_KINDS as ReadonlyArray<string>).includes(kind) &&
                  instanceId ===
                    memberInstanceId(
                      kind as (typeof MEMBER_PROVIDER_KINDS)[number],
                      caller.userId,
                    )),
            ),
          );
    if (wanted.length === 0) {
      return yield* fail("invalid", "Connect your agent first, then share it.");
    }
    yield* revokeForRequest(request.id);
    const grant: ProviderGrant = {
      id: newId("grant"),
      projectId: request.projectId,
      ownerUserId: actorOf(caller),
      ownerName: yield* callerName(caller),
      granteeUserId: request.expertUserId,
      instanceIds: wanted,
      requestId: request.id,
      createdAtMs: yield* Clock.currentTimeMillis,
      revokedAtMs: null,
    };
    const experts = yield* ExpertsService;
    yield* experts.putGrant(grant);
    return json({ request: yield* viewRequest(request) });
  }).pipe(Effect.catchTags({ ExpertsError: expertsError })),
);

const revokeRoute = HttpRouter.add(
  "POST",
  "/api/lp/experts/revoke",
  Effect.gen(function* () {
    const caller = yield* signedIn;
    if (caller === null) return unauthenticated;
    const body = yield* readBody(RequestBody);
    if (body === null) return json({ error: "bad_request" }, 400);
    const { request, role } = yield* loadRequest(caller, body.requestId);
    if (role !== "requester")
      return yield* fail("forbidden", "Only the person who asked can revoke.");
    const revoked = yield* revokeForRequest(request.id);
    return json({ revoked, request: yield* viewRequest(request) });
  }).pipe(Effect.catchTags({ ExpertsError: expertsError })),
);

const DelegateBody = Schema.Struct({ requestId: Schema.String, text: Schema.String });

/** Hand the expert a task: delivered into their thread by the ledger, like any send-to-thread. */
const delegateRoute = HttpRouter.add(
  "POST",
  "/api/lp/experts/delegate",
  Effect.gen(function* () {
    const caller = yield* signedIn;
    if (caller === null) return unauthenticated;
    const locked = yield* featureGate("talent");
    if (locked !== null) return locked;
    const body = yield* readBody(DelegateBody);
    if (body === null) return json({ error: "bad_request" }, 400);
    const { request, role } = yield* loadRequest(caller, body.requestId);
    if (role !== "requester")
      return yield* fail("forbidden", "Only the person who asked can delegate.");
    if (request.expertThreadId === null || !OPEN_STATUSES.has(request.status)) {
      return yield* fail("invalid", "The expert has not joined yet.");
    }
    const ledger = yield* ProjectLedger;
    const message = yield* ledger.send({
      projectId: request.projectId,
      fromThreadId: request.fromThreadId,
      fromName: request.requesterName,
      to: request.expertThreadId,
      text: body.text,
    });
    const updated =
      request.status === "working" ? request : yield* step(caller, request.id, { kind: "working" });
    return json({ message, request: yield* viewRequest(updated) });
  }).pipe(Effect.catchTags({ ExpertsError: expertsError, LedgerError: ledgerError })),
);

/** End the session: revoke the login grant and take the expert out of the project. */
const endRoute = HttpRouter.add(
  "POST",
  "/api/lp/experts/end",
  Effect.gen(function* () {
    const caller = yield* signedIn;
    if (caller === null) return unauthenticated;
    const body = yield* readBody(RequestBody);
    if (body === null) return json({ error: "bad_request" }, 400);
    const { request } = yield* loadRequest(caller, body.requestId);
    const ended = yield* step(caller, request.id, { kind: "end" });
    const revoked = yield* revokeForRequest(request.id);
    const access = yield* LogicPacksAccess;
    let removed = false;
    if (
      request.expertUserId !== null &&
      request.addedMember === true &&
      access.roleOf(request.expertUserId, request.projectId) === "member"
    ) {
      // Only the row the request added: someone who was already a member stays one.
      const experts = yield* ExpertsService;
      const otherOpen = experts
        .requests()
        .some(
          (other) =>
            other.id !== request.id &&
            other.projectId === request.projectId &&
            other.expertUserId === request.expertUserId &&
            OPEN_STATUSES.has(other.status),
        );
      if (!otherOpen) {
        yield* access
          .removeMember({
            projectId: request.projectId,
            actorUserId: null,
            userId: request.expertUserId,
          })
          .pipe(Effect.ignore);
        removed = true;
      }
    }
    return json({ revoked, removed, request: yield* viewRequest(ended) });
  }).pipe(Effect.catchTags({ ExpertsError: expertsError })),
);

// ── Admin: the operator curates the catalog ──

const operatorOnly = json(
  { error: "forbidden", message: "Only the host operator manages experts." },
  403,
);

const adminListRoute = HttpRouter.add(
  "GET",
  "/api/lp/admin/experts",
  Effect.gen(function* () {
    const caller = yield* signedIn;
    if (caller === null) return unauthenticated;
    if (caller.kind !== "operator") return operatorOnly;
    const experts = yield* ExpertsService;
    return json({ experts: experts.experts().toSorted((a, b) => a.name.localeCompare(b.name)) });
  }),
);

const ExpertBody = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  specialty: Schema.String,
  skills: Schema.optionalKey(Schema.Array(Schema.String)),
  bio: Schema.optionalKey(Schema.String),
  rating: Schema.optionalKey(Schema.Number),
  reviews: Schema.optionalKey(Schema.Number),
  availability: Schema.optionalKey(Schema.Literals(["available", "busy", "away"])),
  avatar: Schema.optionalKey(Schema.String),
  accountEmail: Schema.String,
  sample: Schema.optionalKey(Schema.Boolean),
  active: Schema.optionalKey(Schema.Boolean),
});

const adminPutRoute = HttpRouter.add(
  "POST",
  "/api/lp/admin/experts",
  Effect.gen(function* () {
    const caller = yield* signedIn;
    if (caller === null) return unauthenticated;
    if (caller.kind !== "operator") return operatorOnly;
    const body = yield* readBody(ExpertBody);
    if (body === null) return json({ error: "bad_request" }, 400);
    const checked = validateExpert(body);
    if (!checked.ok) return json({ error: "invalid", message: checked.message }, 400);
    const experts = yield* ExpertsService;
    yield* experts.putExpert(checked.expert);
    return json({ expert: checked.expert });
  }).pipe(Effect.catchTags({ ExpertsError: expertsError })),
);

const AdminRemoveBody = Schema.Struct({ id: Schema.String });

const adminRemoveRoute = HttpRouter.add(
  "POST",
  "/api/lp/admin/experts/remove",
  Effect.gen(function* () {
    const caller = yield* signedIn;
    if (caller === null) return unauthenticated;
    if (caller.kind !== "operator") return operatorOnly;
    const body = yield* readBody(AdminRemoveBody);
    if (body === null) return json({ error: "bad_request" }, 400);
    const experts = yield* ExpertsService;
    return json({ removed: yield* experts.removeExpert(body.id) });
  }).pipe(Effect.catchTags({ ExpertsError: expertsError })),
);

export const layer = Layer.mergeAll(
  catalogRoute,
  briefRoute,
  createRoute,
  listRoute,
  acceptRoute,
  declineRoute,
  statusRoute,
  grantRoute,
  revokeRoute,
  delegateRoute,
  endRoute,
  adminListRoute,
  adminPutRoute,
  adminRemoveRoute,
);
