/**
 * `GET /api/lp/apps/ops` and `POST /api/lp/apps/run`: the semantic ops agents
 * use on the host's apps (`lp app ops`, `lp app run blender.move Vase z 1.24`).
 * Reading is open to anyone on the project. Anything that changes a document
 * or drives an app needs the host owner, or a live control grant from the host:
 * a teammate's agent cannot act on the host's machine without that approval.
 */
import { ANY_APP_GUIDE, appGuideFor, renderAppGuide } from "@logicpacks/shared/recipes/appGuides";
import { type ProjectId } from "@logicpacks/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpRouter } from "effect/http";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { APP_OPS, AppOpError, autoSnapshotBeforeAgentEdit, findAppOp, runAppOp } from "./appOps.ts";
import { appStreamHub, rememberProjectRoot } from "./appStreamHttp.ts";
import { ExternalSessions } from "./ExternalSessions.ts";
import { resolveHelperCaller } from "./helperHttp.ts";
import { json, queryParam, readBody } from "./http.ts";
import { FEATURE_LOCKED, requireFeature } from "./features.ts";
import { LogicPacksAccess } from "./LogicPacksAccess.ts";

const Location = Schema.Struct({
  cwd: Schema.String,
  gitRoot: Schema.optionalKey(Schema.NullOr(Schema.String)),
  gitRemote: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

const RunRequest = Schema.Struct({
  projectId: Schema.optionalKey(Schema.String),
  location: Schema.optionalKey(Location),
  op: Schema.String,
  args: Schema.Array(Schema.String),
  /** The agent's own name ("Claude"); a person clicking in the app sends as: "human". */
  agent: Schema.optionalKey(Schema.String),
  as: Schema.optionalKey(Schema.Literals(["agent", "human"])),
  /** Skip the automatic snapshot before an agent's first edit. */
  noSnapshot: Schema.optionalKey(Schema.Boolean),
});

/** Which project, by id or by the agent's folder, and who is asking. */
const resolveTarget = Effect.fn("logicpacks.apps.resolveTarget")(function* (input: {
  readonly projectId?: string | undefined;
  readonly location?: typeof Location.Type | undefined;
}) {
  const caller = yield* resolveHelperCaller;
  if (caller === null) return { ok: false as const, status: 401, error: "unauthenticated" };
  if (!(yield* requireFeature(caller, "apps"))) {
    return { ok: false as const, status: 403, ...FEATURE_LOCKED };
  }
  const access = yield* LogicPacksAccess;
  let projectId = input.projectId ?? null;
  if (projectId === null && input.location) {
    const sessions = yield* ExternalSessions;
    const found = yield* sessions
      .resolveProject(caller, {
        cwd: input.location.cwd,
        gitRoot: input.location.gitRoot ?? null,
        gitRemote: input.location.gitRemote ?? null,
      })
      .pipe(Effect.orElseSucceed(() => null));
    projectId = found?.id ?? null;
  }
  if (projectId === null) {
    return {
      ok: false as const,
      status: 404,
      error: "no_project",
      message: "This folder is not a LogicPacks project. Pass --project <id> or run inside one.",
    };
  }
  if (caller.kind === "member" && access.roleOf(caller.userId, projectId) === null) {
    return { ok: false as const, status: 404, error: "not_found" };
  }
  const store = yield* ProjectStore.ProjectStoreV2;
  const shell = yield* store
    .getShell(projectId as ProjectId)
    .pipe(Effect.orElseSucceed(() => Option.none()));
  if (Option.isNone(shell)) return { ok: false as const, status: 404, error: "not_found" };
  rememberProjectRoot(projectId, shell.value.workspaceRoot);
  const user =
    caller.kind === "member"
      ? yield* access.getUser(caller.userId).pipe(Effect.orElseSucceed(() => null))
      : null;
  return {
    ok: true as const,
    projectId,
    root: shell.value.workspaceRoot,
    subject: caller.kind === "member" ? caller.userId : "operator",
    person: user?.displayName ?? (caller.kind === "operator" ? "Host" : "Member"),
    isOperator: caller.kind === "operator",
  };
});

/** The refusal as JSON; feature_locked keeps its feature so `lp app` can say which. */
const failureBody = (target: {
  readonly error: string;
  readonly message?: string;
  readonly feature?: string;
}) => ({
  error: target.error,
  ...(target.message === undefined ? {} : { message: target.message }),
  ...(target.feature === undefined ? {} : { feature: target.feature }),
});

const opsRoute = HttpRouter.add(
  "GET",
  "/api/lp/apps/ops",
  Effect.gen(function* () {
    const projectId = (yield* queryParam("projectId")) || undefined;
    const cwd = yield* queryParam("cwd");
    const target = yield* resolveTarget({
      projectId,
      ...(cwd ? { location: { cwd } } : {}),
    });
    if (!target.ok) return json(failureBody(target), target.status);
    const shared = appStreamHub.sharedApp(target.projectId);
    return json({
      projectId: target.projectId,
      shared,
      // The recipe an agent loads for the shared app (or "Any app" when nothing is shared).
      guide: renderAppGuide(shared ? appGuideFor(shared.appName) : ANY_APP_GUIDE),
      canControl: target.isOperator || appStreamHub.hasControl(target.projectId, target.subject),
      ops: APP_OPS,
    });
  }),
);

const logRoute = HttpRouter.add(
  "GET",
  "/api/lp/apps/log",
  Effect.gen(function* () {
    const target = yield* resolveTarget({ projectId: yield* queryParam("projectId") });
    if (!target.ok) return json(failureBody(target), target.status);
    return json({ entries: appStreamHub.logs(target.projectId) });
  }),
);

const runRoute = HttpRouter.add(
  "POST",
  "/api/lp/apps/run",
  Effect.gen(function* () {
    const body = yield* readBody(RunRequest);
    if (body === null) return json({ error: "bad_request" }, 400);
    const target = yield* resolveTarget(body);
    if (!target.ok) return json(failureBody(target), target.status);
    const spec = findAppOp(body.op);
    if (!spec)
      return json({ error: "unknown_op", message: `Unknown op ${body.op}. Run lp app ops.` }, 400);
    if (
      spec.mutates &&
      !target.isOperator &&
      !appStreamHub.hasControl(target.projectId, target.subject)
    ) {
      return json(
        {
          error: "not_granted",
          message: `${spec.name} changes the host's app. Ask the host for control first (Request control in the shared app).`,
        },
        403,
      );
    }
    const asHuman = body.as === "human";
    const actorName = asHuman
      ? target.person
      : body.agent
        ? `${target.person}'s ${body.agent}`
        : `${target.person}'s agent`;
    const actor = {
      kind: asHuman ? ("human" as const) : ("agent" as const),
      id: asHuman ? target.subject : `${target.subject}:agent`,
      name: actorName,
    };
    const ctx = { root: target.root, actor };
    const outcome = yield* Effect.tryPromise(async () => {
      const auto = body.noSnapshot ? null : await autoSnapshotBeforeAgentEdit(spec, ctx);
      if (auto !== null) {
        appStreamHub.log(target.projectId, {
          source: "agent",
          actor: actorName,
          subject: target.subject,
          op: "blender.snapshot",
          detail: `${auto} (before the agent's first edit)`,
          snapshot: auto,
        });
      }
      return { ...(await runAppOp(spec.name, body.args, ctx)), auto };
    }).pipe(
      Effect.map((value) => ({ ok: true as const, value })),
      Effect.catch((error) =>
        Effect.succeed({
          ok: false as const,
          message:
            error.cause instanceof AppOpError || error.cause instanceof Error
              ? error.cause.message
              : String(error),
        }),
      ),
    );
    // The page's own reads (the scene outline it polls) are not actions: keep them out of the log.
    if (asHuman && !spec.mutates && outcome.ok) {
      return json({ ok: true, result: outcome.value.result });
    }
    const entry = appStreamHub.log(target.projectId, {
      source: asHuman ? "human" : "agent",
      actor: actorName,
      subject: target.subject,
      op: spec.name,
      detail: outcome.ok ? outcome.value.detail : outcome.message.slice(0, 160),
      ok: outcome.ok,
      ...(outcome.ok && outcome.value.snapshot ? { snapshot: outcome.value.snapshot } : {}),
    });
    if (!outcome.ok) return json({ error: "op_failed", message: outcome.message, entry }, 422);
    return json({
      ok: true,
      result: outcome.value.result,
      entry,
      ...(outcome.value.auto ? { autoSnapshot: outcome.value.auto } : {}),
    });
  }),
);

export const layer = Layer.mergeAll(opsRoute, logRoute, runRoute);
