import {
  canCompute,
  FULL_ACCESS_WARNING,
  isPresetId,
  needsGrantWarning,
  presetOfZones,
  resolveZones,
  zonesFromInput,
} from "@logicpacks/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpRouter } from "effect/http";

import { memberSandboxSupported } from "./folderSandbox.ts";
import { accessSeatView, hostAgents } from "./hostAgents.ts";
import { memberSandboxEnabled } from "./memberSandbox.ts";
import {
  accessErrorResponse,
  actorOf,
  json,
  queryParam,
  readBody,
  resolveCaller,
} from "./http.ts";
import { LogicPacksAccess, type LogicPacksAccessError } from "./LogicPacksAccess.ts";

/**
 * The access zones over HTTP: what a seat is, who may change it, and the request flow
 * ("Request host's Claude", "Request terminal access") that ends in the host's Allow or Deny.
 * Owners (the host and project owners) decide; members only read their own seat and ask.
 */

/** Sandboxed terminals and agents need macOS (Seatbelt) or the cloud host's per-member users. */
export const sandboxStatus = () => {
  const available = memberSandboxSupported() || memberSandboxEnabled();
  return {
    available,
    reason: available
      ? null
      : process.platform === "win32"
        ? "Sandboxed terminals are not available on Windows hosts yet: there is no verified way to confine a process to folders without administrator rights. Use Unrestricted (a shell as your user) or leave the terminal off."
        : "Sandboxed terminals are available on macOS hosts. Use Unrestricted (a shell as your user) or leave the terminal off.",
  };
};

/** Everything the Share dialog needs about access, for a project owner (null for others). */
export const accessOverview = Effect.fn("logicpacks.access.overview")(function* (
  projectId: string,
  actor: string | null,
) {
  const access = yield* LogicPacksAccess;
  const settings = access.zoneSettings(projectId);
  const members = yield* access.listMembers(projectId);
  const requests = access.accessRequests(projectId).filter((request) => request.status === "open");
  const names = new Map(members.map((member) => [member.user.userId, member.user.displayName]));
  return {
    hostAgents: yield* hostAgents,
    sandbox: sandboxStatus(),
    default: accessSeatView(
      resolveZones({ isOwner: false, viewerSeat: false, projectDefault: settings.projectDefault }),
    ),
    defaultIsSet: settings.projectDefault !== null,
    members: Object.fromEntries(
      members.map((member) => [
        member.user.userId,
        accessSeatView(access.zonesOf(member.user.userId, projectId)),
      ]),
    ),
    requests: requests.map((request) => ({
      id: request.id,
      userId: request.userId,
      name: names.get(request.userId) ?? "Someone",
      zone: request.zone,
      createdAtMs: request.createdAtMs,
    })),
    log: access.accessLog(projectId, 50).map((entry) => ({
      ...entry,
      name:
        entry.userId === null ? "Host" : (names.get(entry.userId) ?? "A member"),
    })),
    mine: actor === null ? null : accessSeatView(access.zonesOf(actor, projectId)),
  };
});

const catchAccess = <A, R>(effect: Effect.Effect<A, LogicPacksAccessError, R>) =>
  effect.pipe(Effect.catchTags({ LogicPacksAccessError: accessErrorResponse }));

const SetRequest = Schema.Struct({
  projectId: Schema.String,
  /** Omitted: the project's default (the share link's setting). */
  userId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  preset: Schema.optionalKey(Schema.String),
  zones: Schema.optionalKey(Schema.Unknown),
  /** Back to following the default (a person) or to Can edit (the default). */
  clear: Schema.optionalKey(Schema.Boolean),
  /** The caller read the warning that Compute is a shell on the host. */
  confirmFull: Schema.optionalKey(Schema.Boolean),
});

export const confirmRequired = () =>
  json(
    {
      error: "confirm_required",
      message: FULL_ACCESS_WARNING,
    },
    409,
  );

/** Owner only: a person's override, or the project default. */
const setRoute = HttpRouter.add(
  "POST",
  "/api/lp/access/set",
  catchAccess(
    Effect.gen(function* () {
      const caller = yield* resolveCaller;
      if (caller.kind === "anonymous") return json({ error: "unauthenticated" }, 401);
      const body = yield* readBody(SetRequest);
      if (body === null) return json({ error: "bad_request" }, 400);
      const access = yield* LogicPacksAccess;
      const actor = actorOf(caller);
      const zones =
        body.clear === true
          ? null
          : zonesFromInput({
              preset: isPresetId(body.preset) ? body.preset : undefined,
              zones: body.zones,
            });
      if (zones === undefined || (zones === null && body.clear !== true)) {
        return json({ error: "bad_request", message: "Name a preset or the zones." }, 400);
      }
      if (zones !== null && needsGrantWarning(zones) && body.confirmFull !== true) {
        return confirmRequired();
      }
      if (body.userId === undefined || body.userId === null) {
        yield* access.setProjectZones({ projectId: body.projectId, actorUserId: actor, zones });
      } else {
        yield* access.setMemberZones({
          projectId: body.projectId,
          actorUserId: actor,
          userId: body.userId,
          zones,
        });
      }
      yield* access.logAccess({
        projectId: body.projectId,
        userId: body.userId ?? null,
        kind: "zones.changed",
        detail:
          zones === null
            ? "Access reset."
            : `Access set to ${presetOfZones(zones)}${canCompute(zones) ? " (terminal on)" : ""}.`,
      });
      return json(yield* accessOverview(body.projectId, actor));
    }),
  ),
);

const RequestBody = Schema.Struct({
  projectId: Schema.String,
  zone: Schema.Literals(["ai", "compute"]),
});

/** Members only. Never refused for Read only: asking is how a seat gets more. */
const requestRoute = HttpRouter.add(
  "POST",
  "/api/lp/access/request",
  catchAccess(
    Effect.gen(function* () {
      const caller = yield* resolveCaller;
      if (caller.kind !== "member") return json({ error: "members_only" }, 403);
      const body = yield* readBody(RequestBody);
      if (body === null) return json({ error: "bad_request" }, 400);
      const access = yield* LogicPacksAccess;
      const request = yield* access.requestAccess({
        projectId: body.projectId,
        userId: caller.userId,
        zone: body.zone,
      });
      yield* access.logAccess({
        projectId: body.projectId,
        userId: caller.userId,
        kind: "access.requested",
        detail: body.zone === "ai" ? "Asked to use the host's agent." : "Asked for terminal access.",
      });
      return json({ request: { id: request.id, zone: request.zone, status: request.status } });
    }),
  ),
);

const DecideBody = Schema.Struct({
  projectId: Schema.String,
  requestId: Schema.String,
  decision: Schema.Literals(["allow", "deny"]),
  confirmFull: Schema.optionalKey(Schema.Boolean),
});

const decideRoute = HttpRouter.add(
  "POST",
  "/api/lp/access/decide",
  catchAccess(
    Effect.gen(function* () {
      const caller = yield* resolveCaller;
      if (caller.kind === "anonymous") return json({ error: "unauthenticated" }, 401);
      const body = yield* readBody(DecideBody);
      if (body === null) return json({ error: "bad_request" }, 400);
      const access = yield* LogicPacksAccess;
      const actor = actorOf(caller);
      const pending = access.accessRequests(body.projectId).find((entry) => entry.id === body.requestId);
      if (
        body.decision === "allow" &&
        pending?.zone === "compute" &&
        pending.status === "open" &&
        body.confirmFull !== true
      ) {
        return confirmRequired();
      }
      const decided = yield* access.decideAccess({
        projectId: body.projectId,
        actorUserId: actor,
        requestId: body.requestId,
        decision: body.decision,
      });
      yield* access.logAccess({
        projectId: body.projectId,
        userId: decided.userId,
        kind: body.decision === "allow" ? "access.allowed" : "access.denied",
        detail:
          decided.zone === "ai"
            ? `The host ${body.decision === "allow" ? "allowed" : "denied"} use of their agent.`
            : `The host ${body.decision === "allow" ? "allowed" : "denied"} terminal access.`,
      });
      return json(yield* accessOverview(body.projectId, actor));
    }),
  ),
);

const accessRoute = HttpRouter.add(
  "GET",
  "/api/lp/access",
  catchAccess(
    Effect.gen(function* () {
      const caller = yield* resolveCaller;
      if (caller.kind === "anonymous") return json({ error: "unauthenticated" }, 401);
      const projectId = yield* queryParam("projectId");
      const access = yield* LogicPacksAccess;
      const actor = actorOf(caller);
      const role = actor === null ? "owner" : access.roleOf(actor, projectId);
      if (role === null) return json({ error: "not_found" }, 404);
      const view = yield* accessOverview(projectId, actor);
      return role === "owner"
        ? json(view)
        : json({ hostAgents: view.hostAgents, mine: view.mine });
    }),
  ),
);

export { accessSeatView, hostAgents };

export const layer = Layer.mergeAll(setRoute, requestRoute, decideRoute, accessRoute);
