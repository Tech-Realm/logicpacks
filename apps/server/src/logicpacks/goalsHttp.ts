import { LP_HOST_PARTICIPANT_ID } from "@logicpacks/contracts";
import { refuseIfReadOnly } from "./readOnly.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpRouter } from "effect/http";

import { canManage, GoalPlan, progress, type Goal } from "./goals.ts";
import { json, queryParam, readBody, resolveCaller } from "./http.ts";
import { LogicPacksAccess } from "./LogicPacksAccess.ts";
import { ProjectGoals } from "./ProjectGoals.ts";
import type { LedgerError } from "./ProjectLedger.ts";

/**
 * Goals (Beta) for people in the app. Agents reach the same service through the
 * ledger tools (ledgerHttp.ts runLedgerTool, `lp_project_goal_*`, `lp mcp`).
 */

const errorStatus: Record<LedgerError["reason"], number> = {
  not_found: 404,
  invalid: 409,
  forbidden: 403,
};

const ledgerError = (error: LedgerError) =>
  Effect.succeed(json({ error: error.reason, message: error.message }, errorStatus[error.reason]));

const unauthenticated = json({ error: "unauthenticated" }, 401);
const notFound = json({ error: "not_found", message: "Not found." }, 404);
const badRequest = json({ error: "bad_request" }, 400);

/** The caller as a ledger participant, when signed in. */
const participant = Effect.gen(function* () {
  const caller = yield* resolveCaller;
  if (caller.kind === "anonymous") return null;
  return caller.kind === "member" ? caller.userId : LP_HOST_PARTICIPANT_ID;
});

const participantCaller = (participantId: string) =>
  participantId === LP_HOST_PARTICIPANT_ID
    ? ({ kind: "operator" } as const)
    : ({ kind: "member", userId: participantId } as const);

const inProject = Effect.fn("logicpacks.goals.inProject")(function* (
  participantId: string,
  projectId: string,
) {
  if (participantId === LP_HOST_PARTICIPANT_ID) return true;
  const access = yield* LogicPacksAccess;
  return access.roleOf(participantId, projectId) !== null;
});

/** A goal as the app shows it: with progress and what this viewer may do. */
const goalView = (goal: Goal, viewer: { readonly id: string; readonly isHost: boolean }) => ({
  ...goal,
  progress: progress(goal),
  viewer: {
    canManage: canManage(goal, { ...viewer, name: "", threadId: null }),
    participantId: viewer.id,
  },
});

/** Loads the caller and a goal they can see. */
const withGoal = Effect.fn("logicpacks.goals.withGoal")(function* <A, E, R>(
  goalId: string,
  run: (input: { readonly goal: Goal; readonly participantId: string }) => Effect.Effect<A, E, R>,
) {
  const participantId = yield* participant;
  if (participantId === null) return unauthenticated;
  const goals = yield* ProjectGoals;
  const goal = goals.get(goalId);
  if (goal === undefined || !(yield* inProject(participantId, goal.projectId))) return notFound;
  const readOnly = yield* refuseIfReadOnly(participantCaller(participantId), goal.projectId);
  if (readOnly !== null) return readOnly;
  return yield* run({ goal, participantId });
});

const respond = Effect.fn("logicpacks.goals.respond")(function* (
  goal: Goal,
  participantId: string,
) {
  const goals = yield* ProjectGoals;
  const actor = yield* goals.actorFor(participantId, goal.projectId);
  return json({ goal: goalView(goal, actor) });
});

const listRoute = HttpRouter.add(
  "GET",
  "/api/lp/goals",
  Effect.gen(function* () {
    const participantId = yield* participant;
    if (participantId === null) return unauthenticated;
    const projectId = yield* queryParam("projectId");
    if (projectId.length === 0 || !(yield* inProject(participantId, projectId))) return notFound;
    const goals = yield* ProjectGoals;
    const actor = yield* goals.actorFor(participantId, projectId);
    const list = yield* goals.list(projectId);
    return json({
      projectId,
      viewer: { participantId, isHost: actor.isHost, name: actor.name },
      goals: list.map((goal) => goalView(goal, actor)),
    });
  }),
);

const peopleRoute = HttpRouter.add(
  "GET",
  "/api/lp/goals/people",
  Effect.gen(function* () {
    const participantId = yield* participant;
    if (participantId === null) return unauthenticated;
    const projectId = yield* queryParam("projectId");
    if (projectId.length === 0 || !(yield* inProject(participantId, projectId))) return notFound;
    const goals = yield* ProjectGoals;
    return json({ people: yield* goals.candidates(projectId) });
  }),
);

const CreateBody = Schema.Struct({
  projectId: Schema.String,
  threadId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  plan: GoalPlan,
});

/** A member makes a goal by hand (a draft, confirmed like a planned one). */
const createRoute = HttpRouter.add(
  "POST",
  "/api/lp/goals/create",
  Effect.gen(function* () {
    const participantId = yield* participant;
    if (participantId === null) return unauthenticated;
    const body = yield* readBody(CreateBody);
    if (body === null) return badRequest;
    if (!(yield* inProject(participantId, body.projectId))) return notFound;
    const readOnly = yield* refuseIfReadOnly(participantCaller(participantId), body.projectId);
    if (readOnly !== null) return readOnly;
    const goals = yield* ProjectGoals;
    const actor = yield* goals.actorFor(participantId, body.projectId);
    const goal = yield* goals.create({
      projectId: body.projectId,
      actor,
      threadId: body.threadId ?? null,
      plan: body.plan,
    });
    return json({ goal: goalView(goal, actor) });
  }).pipe(Effect.catchTags({ LedgerError: ledgerError })),
);

const EditBody = Schema.Struct({
  goalId: Schema.String,
  plan: Schema.optionalKey(GoalPlan),
  judge: Schema.optionalKey(Schema.Boolean),
});

const editRoute = HttpRouter.add(
  "POST",
  "/api/lp/goals/edit",
  Effect.gen(function* () {
    const body = yield* readBody(EditBody);
    if (body === null) return badRequest;
    return yield* withGoal(body.goalId, ({ goal, participantId }) =>
      Effect.gen(function* () {
        const goals = yield* ProjectGoals;
        const actor = yield* goals.actorFor(participantId, goal.projectId);
        const edited = yield* goals.edit({
          goalId: goal.id,
          actor,
          plan: body.plan,
          judge: body.judge,
        });
        return yield* respond(edited, participantId);
      }),
    );
  }).pipe(Effect.catchTags({ LedgerError: ledgerError })),
);

const GoalBody = Schema.Struct({ goalId: Schema.String });

const confirmRoute = HttpRouter.add(
  "POST",
  "/api/lp/goals/confirm",
  Effect.gen(function* () {
    const body = yield* readBody(GoalBody);
    if (body === null) return badRequest;
    return yield* withGoal(body.goalId, ({ goal, participantId }) =>
      Effect.gen(function* () {
        const goals = yield* ProjectGoals;
        const actor = yield* goals.actorFor(participantId, goal.projectId);
        return yield* respond(yield* goals.confirm({ goalId: goal.id, actor }), participantId);
      }),
    );
  }).pipe(Effect.catchTags({ LedgerError: ledgerError })),
);

const cancelRoute = HttpRouter.add(
  "POST",
  "/api/lp/goals/cancel",
  Effect.gen(function* () {
    const body = yield* readBody(GoalBody);
    if (body === null) return badRequest;
    return yield* withGoal(body.goalId, ({ goal, participantId }) =>
      Effect.gen(function* () {
        const goals = yield* ProjectGoals;
        const actor = yield* goals.actorFor(participantId, goal.projectId);
        return yield* respond(yield* goals.cancel({ goalId: goal.id, actor }), participantId);
      }),
    );
  }).pipe(Effect.catchTags({ LedgerError: ledgerError })),
);

const MilestoneBody = Schema.Struct({
  goalId: Schema.String,
  milestoneId: Schema.String,
  status: Schema.Literals(["in_progress", "blocked", "done"]),
  note: Schema.optionalKey(Schema.String),
});

/** An assignee moves their own milestone (the owner and host may too). */
const milestoneRoute = HttpRouter.add(
  "POST",
  "/api/lp/goals/milestone",
  Effect.gen(function* () {
    const body = yield* readBody(MilestoneBody);
    if (body === null) return badRequest;
    return yield* withGoal(body.goalId, ({ goal, participantId }) =>
      Effect.gen(function* () {
        const goals = yield* ProjectGoals;
        const actor = yield* goals.actorFor(participantId, goal.projectId);
        const next = yield* goals.updateMilestone({
          milestoneId: body.milestoneId,
          actor,
          status: body.status,
          note: body.note,
        });
        return yield* respond(next, participantId);
      }),
    );
  }).pipe(Effect.catchTags({ LedgerError: ledgerError })),
);

const DecideBody = Schema.Struct({
  goalId: Schema.String,
  decisionId: Schema.String,
  action: Schema.String,
  note: Schema.optionalKey(Schema.String),
});

/**
 * One route for every decision request on a goal (drift, reviews; later merges,
 * spend, outside access): the request lists its actions, the client posts one.
 */
const decideRoute = HttpRouter.add(
  "POST",
  "/api/lp/goals/decide",
  Effect.gen(function* () {
    const body = yield* readBody(DecideBody);
    if (body === null) return badRequest;
    return yield* withGoal(body.goalId, ({ goal, participantId }) =>
      Effect.gen(function* () {
        const goals = yield* ProjectGoals;
        const actor = yield* goals.actorFor(participantId, goal.projectId);
        const next = yield* goals.decide({
          goalId: goal.id,
          decisionId: body.decisionId,
          actor,
          action: body.action,
          note: body.note,
        });
        return yield* respond(next, participantId);
      }),
    );
  }).pipe(Effect.catchTags({ LedgerError: ledgerError })),
);

export const layer = Layer.mergeAll(
  listRoute,
  peopleRoute,
  createRoute,
  editRoute,
  confirmRoute,
  cancelRoute,
  milestoneRoute,
  decideRoute,
);
