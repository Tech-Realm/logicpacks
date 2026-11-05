import type { ProjectId } from "@logicpacks/contracts";
import { refuseIfReadOnly } from "./readOnly.ts";
import { refuseIfFolderLimited, refuseIfZone } from "./zoneHttp.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpRouter } from "effect/http";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { json, queryParam, readBody, resolveCaller } from "./http.ts";
import { LogicPacksAccess } from "./LogicPacksAccess.ts";
import { FeatureAccess } from "./FeatureAccess.ts";
import { cloudLockedResponse } from "./featureHttp.ts";
import { LogicPacksSync, type LogicPacksSyncError } from "./LogicPacksSync.ts";

const ProjectRequest = Schema.Struct({ projectId: Schema.String });
const ResolveRequest = Schema.Struct({
  projectId: Schema.String,
  strategy: Schema.Literals(["mine", "theirs"]),
});
const ConnectCloudRequest = Schema.Struct({
  url: Schema.String,
  mode: Schema.Literals(["signup", "login"]),
  email: Schema.String,
  password: Schema.String,
  displayName: Schema.optionalKey(Schema.String),
});

const syncErrorStatus: Record<LogicPacksSyncError["reason"], number> = {
  unknown_project: 404,
  connect_cloud: 409,
  cloud_rejected: 502,
  not_synced: 409,
  no_conflict: 409,
  busy: 409,
  failed: 500,
};

const syncErrorResponse = (error: LogicPacksSyncError) =>
  Effect.succeed(
    json({ error: error.reason, message: error.message }, syncErrorStatus[error.reason]),
  );

/** The caller may act on the project: the operator always, a member when it is shared with them. */
const projectAllowed = Effect.fn("logicpacks.sync.projectAllowed")(function* (
  projectId: string,
  changes = false,
) {
  const caller = yield* resolveCaller;
  if (caller.kind === "anonymous")
    return { ok: false as const, response: json({ error: "unauthenticated" }, 401) };
  const access = yield* LogicPacksAccess;
  if (caller.kind === "member" && access.roleOf(caller.userId, projectId) === null) {
    return { ok: false as const, response: json({ error: "not_found" }, 404) };
  }
  if (changes) {
    const readOnly = yield* refuseIfReadOnly(caller, projectId);
    if (readOnly !== null) return { ok: false as const, response: readOnly };
    // Sync commits and pushes the working copy: it needs write access to the files.
    const zoneOff = yield* refuseIfZone(caller, projectId, ["files.write"]);
    if (zoneOff !== null) return { ok: false as const, response: zoneOff };
    const limited = yield* refuseIfFolderLimited(caller, projectId);
    if (limited !== null) return { ok: false as const, response: limited };
  }
  return { ok: true as const, caller };
});

/** A laptop host's owner holds the cloud feature (their access code). */
const laptopHasCloud = Effect.gen(function* () {
  const features = yield* Effect.serviceOption(FeatureAccess);
  return features._tag === "None" || features.value.has({ kind: "operator" }, "cloud");
});

/** Every visible project's sync status, polled by the app for badges and banners. */
const statusRoute = HttpRouter.add(
  "GET",
  "/api/lp/sync/status",
  Effect.gen(function* () {
    const caller = yield* resolveCaller;
    if (caller.kind === "anonymous") return json({ error: "unauthenticated" }, 401);
    const access = yield* LogicPacksAccess;
    const sync = yield* LogicPacksSync;
    const requested = (yield* queryParam("projectIds"))
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id.length > 0);
    let ids: ReadonlyArray<string>;
    if (caller.kind === "member") {
      const visible = access.visibleProjectIds(caller.userId);
      ids = requested.length > 0 ? requested.filter((id) => visible.has(id)) : Array.from(visible);
    } else if (requested.length > 0) {
      ids = requested;
    } else {
      const store = yield* ProjectStore.ProjectStoreV2;
      ids = (yield* store.listShells().pipe(Effect.orElseSucceed(() => []))).map(
        (shell) => shell.id as ProjectId as string,
      );
    }
    const cloud = yield* sync.cloud();
    return json({
      cloud: {
        isCloudHost: cloud.isCloudHost,
        url: cloud.url,
        connected: cloud.connected,
        syncSeconds: sync.syncSeconds,
        // Which account the laptop signed in as is the operator's business only.
        account: caller.kind === "operator" ? cloud.account : null,
      },
      projects: sync.status(ids),
    });
  }),
);

const startRoute = HttpRouter.add(
  "POST",
  "/api/lp/sync/start",
  Effect.gen(function* () {
    const body = yield* readBody(ProjectRequest);
    if (body === null) return json({ error: "bad_request" }, 400);
    const allowed = yield* projectAllowed(body.projectId, true);
    if (!allowed.ok) return allowed.response;
    const sync = yield* LogicPacksSync;
    // On a laptop, Sync means syncing to the LogicPacks cloud: part of the cloud feature.
    if (!sync.isCloudHost && !(yield* laptopHasCloud)) return cloudLockedResponse();
    const status = yield* sync.start({
      projectId: body.projectId,
      actorUserId: allowed.caller.kind === "member" ? allowed.caller.userId : null,
    });
    return json({ status }, 202);
  }).pipe(Effect.catchTags({ LogicPacksSyncError: syncErrorResponse })),
);

const nowRoute = HttpRouter.add(
  "POST",
  "/api/lp/sync/now",
  Effect.gen(function* () {
    const body = yield* readBody(ProjectRequest);
    if (body === null) return json({ error: "bad_request" }, 400);
    const allowed = yield* projectAllowed(body.projectId, true);
    if (!allowed.ok) return allowed.response;
    const sync = yield* LogicPacksSync;
    return json({ status: yield* sync.syncNow(body.projectId) });
  }).pipe(Effect.catchTags({ LogicPacksSyncError: syncErrorResponse })),
);

const resolveRoute = HttpRouter.add(
  "POST",
  "/api/lp/sync/resolve",
  Effect.gen(function* () {
    const body = yield* readBody(ResolveRequest);
    if (body === null) return json({ error: "bad_request" }, 400);
    const allowed = yield* projectAllowed(body.projectId, true);
    if (!allowed.ok) return allowed.response;
    const sync = yield* LogicPacksSync;
    return json({
      status: yield* sync.resolve({
        ...body,
        actorUserId: allowed.caller.kind === "member" ? allowed.caller.userId : null,
      }),
    });
  }).pipe(Effect.catchTags({ LogicPacksSyncError: syncErrorResponse })),
);

/** What a laptop needs to know about this host before syncing to it. */
const hostRoute = HttpRouter.add(
  "GET",
  "/api/lp/sync/host",
  Effect.gen(function* () {
    const caller = yield* resolveCaller;
    if (caller.kind === "anonymous") return json({ error: "unauthenticated" }, 401);
    const sync = yield* LogicPacksSync;
    return json({
      cloudHost: sync.isCloudHost,
      githubLogin: sync.isCloudHost ? yield* sync.githubLogin() : null,
    });
  }),
);

const cloudRoute = HttpRouter.add(
  "GET",
  "/api/lp/cloud",
  Effect.gen(function* () {
    const caller = yield* resolveCaller;
    if (caller.kind !== "operator") return json({ error: "operator_only" }, 403);
    const sync = yield* LogicPacksSync;
    return json({ cloud: yield* sync.cloud() });
  }),
);

/** The laptop signs in to its cloud host once; Sync then registers projects there as that account. */
const connectCloudRoute = HttpRouter.add(
  "POST",
  "/api/lp/cloud/connect",
  Effect.gen(function* () {
    const caller = yield* resolveCaller;
    if (caller.kind !== "operator") return json({ error: "operator_only" }, 403);
    if (!(yield* laptopHasCloud)) return cloudLockedResponse();
    const body = yield* readBody(ConnectCloudRequest);
    if (body === null) return json({ error: "bad_request" }, 400);
    const sync = yield* LogicPacksSync;
    return json({ cloud: yield* sync.connectCloud(body) });
  }).pipe(Effect.catchTags({ LogicPacksSyncError: syncErrorResponse })),
);

const disconnectCloudRoute = HttpRouter.add(
  "POST",
  "/api/lp/cloud/disconnect",
  Effect.gen(function* () {
    const caller = yield* resolveCaller;
    if (caller.kind !== "operator") return json({ error: "operator_only" }, 403);
    const sync = yield* LogicPacksSync;
    return json({ cloud: yield* sync.disconnectCloud() });
  }),
);

export const layer = Layer.mergeAll(
  statusRoute,
  startRoute,
  nowRoute,
  resolveRoute,
  hostRoute,
  cloudRoute,
  connectCloudRoute,
  disconnectCloudRoute,
);
