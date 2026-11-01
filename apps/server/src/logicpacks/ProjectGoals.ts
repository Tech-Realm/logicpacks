// @effect-diagnostics-next-line nodeBuiltinImport:off -- random ids for goal rows, no Effect needed.
import * as NodeCrypto from "node:crypto";

import {
  LP_HOST_PARTICIPANT_ID,
  type OrchestrationV2DomainEvent,
  type PresenceEntry,
  type ProjectId,
  type ThreadId,
} from "@logicpacks/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { forkParked } from "../serverActivation.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { OPEN_STATUSES } from "./experts.ts";
import { ExpertsService } from "./ExpertsService.ts";
import {
  addedDependencies,
  addFindings,
  cancelGoal,
  checkMilestone,
  confirmGoal,
  draftGoal,
  editDraft,
  GoalRuleError,
  isManifest,
  isOpenMilestone,
  judgeAllowed,
  markDelivered,
  overdueFinding,
  resolveDrift,
  reviewMilestone,
  taskText,
  updateMilestone,
  type AssigneeStatus,
  type CriterionReport,
  type DriftFinding,
  type Goal,
  type GoalActor,
  type GoalCandidate,
  type GoalDecision,
  type GoalPlan,
  type Milestone,
} from "./goals.ts";
import { canDecide } from "./decisionRequests.ts";
import { nameMatches, type LedgerThread } from "./ledger.ts";
import { LogicPacksAccess } from "./LogicPacksAccess.ts";
import { hostDisplayName } from "./presenceConnection.ts";
import { PresenceService } from "./PresenceService.ts";
import { LedgerError, LedgerStore, ProjectLedger } from "./ProjectLedger.ts";

const newId = (prefix: string) => `${prefix}-${NodeCrypto.randomUUID().slice(0, 8)}`;

/** Runs a pure goal rule; its refusals become ledger errors (one error type for the HTTP layer). */
const rule = <A>(run: () => A) =>
  Effect.try({
    try: run,
    catch: (error) =>
      new LedgerError({
        reason: error instanceof GoalRuleError ? error.reason : "invalid",
        message: error instanceof Error ? error.message : String(error),
      }),
  });

const fail = (reason: LedgerError["reason"], message: string) =>
  Effect.fail(new LedgerError({ reason, message }));

/**
 * The optional model judgment at turn end: "did this turn go beyond or against
 * the milestone?". The default judges nothing; the server wires it to the
 * provider text-generation path. Returns a finding, or null for on plan.
 */
export class GoalJudge extends Context.Reference<{
  readonly judge: (input: {
    readonly cwd: string;
    readonly goal: Goal;
    readonly milestone: Milestone;
    readonly files: ReadonlyArray<string>;
    readonly lastReply: string;
  }) => Effect.Effect<DriftFinding | null>;
}>("logicpacks/logicpacks/GoalJudge", {
  defaultValue: () => ({ judge: () => Effect.succeed(null) }),
}) {}

/** What one turn-end check reads from a thread; injected so tests need no git or runtime. */
export interface ThreadWork {
  readonly cwd: string | null;
  readonly branch: string | null;
  readonly lastReply: string;
}

export class ProjectGoals extends Context.Service<
  ProjectGoals,
  {
    readonly list: (projectId: string) => Effect.Effect<ReadonlyArray<Goal>>;
    readonly get: (goalId: string) => Goal | undefined;
    readonly candidates: (projectId: string) => Effect.Effect<ReadonlyArray<GoalCandidate>>;
    /** An agent drafts (or revises its draft of) a goal from its thread. */
    readonly plan: (input: {
      readonly threadId: string;
      readonly plan: GoalPlan;
      readonly goalId?: string | undefined;
    }) => Effect.Effect<Goal, LedgerError>;
    /** A person makes a draft by hand. */
    readonly create: (input: {
      readonly projectId: string;
      readonly actor: GoalActor;
      readonly threadId: string | null;
      readonly plan: GoalPlan;
    }) => Effect.Effect<Goal, LedgerError>;
    readonly edit: (input: {
      readonly goalId: string;
      readonly actor: GoalActor;
      readonly plan?: GoalPlan | undefined;
      readonly judge?: boolean | undefined;
    }) => Effect.Effect<Goal, LedgerError>;
    /** Confirms a draft and sends each milestone to its assignee's thread. */
    readonly confirm: (input: {
      readonly goalId: string;
      readonly actor: GoalActor;
    }) => Effect.Effect<Goal, LedgerError>;
    readonly cancel: (input: {
      readonly goalId: string;
      readonly actor: GoalActor;
    }) => Effect.Effect<Goal, LedgerError>;
    readonly updateMilestone: (input: {
      readonly milestoneId: string;
      readonly actor: GoalActor;
      readonly status: AssigneeStatus;
      readonly note?: string | undefined;
      readonly report?: ReadonlyArray<CriterionReport> | undefined;
    }) => Effect.Effect<Goal, LedgerError>;
    readonly review: (input: {
      readonly goalId: string;
      readonly milestoneId: string;
      readonly actor: GoalActor;
      readonly verdict: "approve" | "changes";
      readonly note?: string | undefined;
    }) => Effect.Effect<Goal, LedgerError>;
    /**
     * Answers a decision request on the goal with one of its actions: drift is
     * messaged (into their thread, as the host), accepted or ignored; a review is
     * approved or sent back. One entry point, whatever the kind.
     */
    readonly decide: (input: {
      readonly goalId: string;
      readonly decisionId: string;
      readonly actor: GoalActor;
      readonly action: string;
      readonly note?: string | undefined;
    }) => Effect.Effect<Goal, LedgerError>;
    /** Checks a thread's milestone work: on each agent edit and at turn end. */
    readonly checkThread: (input: {
      readonly threadId: string;
      readonly files: ReadonlyArray<string>;
      readonly turnEnd: boolean;
    }) => Effect.Effect<ReadonlyArray<GoalDecision>>;
    /** Delivers milestones waiting for a thread and logs overdue ones. */
    readonly tick: () => Effect.Effect<void>;
    /** The person an HTTP caller is in a project. */
    readonly actorFor: (participantId: string, projectId: string) => Effect.Effect<GoalActor>;
    /** An agent acting in its thread. */
    readonly agentActor: (threadId: string) => Effect.Effect<GoalActor | null>;
  }
>()("logicpacks/logicpacks/ProjectGoals") {}

export interface GoalsDeps {
  /** Reads the thread's checkout, branch and last reply for the turn-end check. */
  readonly threadWork: (threadId: string) => Effect.Effect<ThreadWork | null>;
  /** HEAD and working copy of a manifest, for the dependency check. */
  readonly manifestPair: (
    cwd: string,
    path: string,
  ) => Effect.Effect<{ readonly before: string | null; readonly after: string | null } | null>;
}

/** The service over the ledger; no background loops (see `layer`). */
export const makeGoals = Effect.fn("ProjectGoals.make")(function* (deps: GoalsDeps) {
  const store = yield* LedgerStore;
  const ledger = yield* ProjectLedger;
  const access = yield* LogicPacksAccess;
  const experts = yield* ExpertsService;
  const judge = yield* GoalJudge;
  const hostName = yield* hostDisplayName;
  const lane = yield* Semaphore.make(1);
  const now = Clock.currentTimeMillis;
  const lastJudgedAt = new Map<string, number>();
  /** Files each assignee thread changed since its milestone arrived, for the turn-end checks. */
  const touched = new Map<string, Set<string>>();

  const isHost = (participantId: string, projectId: string) =>
    participantId === LP_HOST_PARTICIPANT_ID || access.roleOf(participantId, projectId) === "owner";

  const actorFor = Effect.fn("ProjectGoals.actorFor")(function* (
    participantId: string,
    projectId: string,
  ) {
    return {
      id: participantId,
      name: yield* ledger.personName(participantId),
      isHost: isHost(participantId, projectId),
      threadId: null,
    } satisfies GoalActor;
  });

  const ownerOf = (thread: LedgerThread) =>
    thread.members[0] ?? { id: LP_HOST_PARTICIPANT_ID, name: hostName };

  const agentActor = Effect.fn("ProjectGoals.agentActor")(function* (threadId: string) {
    const projectId = yield* ledger.projectOfThread(threadId);
    const thread = store.thread(threadId);
    if (projectId === null || thread === undefined) return null;
    const owner = ownerOf(thread);
    return {
      id: owner.id,
      name: thread.agent?.name ?? `${owner.name}'s agent`,
      isHost: false,
      threadId,
    } satisfies GoalActor;
  });

  const candidates = Effect.fn("ProjectGoals.candidates")(function* (projectId: string) {
    const users = yield* access.listUsers().pipe(Effect.orElseSucceed(() => []));
    const liveExperts = new Map(
      experts
        .requests()
        .filter(
          (request) =>
            request.projectId === projectId &&
            request.expertUserId !== null &&
            OPEN_STATUSES.has(request.status),
        )
        .map((request) => [request.expertUserId!, request.expertId] as const),
    );
    const out: GoalCandidate[] = [];
    for (const user of users) {
      if (access.roleOf(user.userId, projectId) === null) continue;
      const expertId = liveExperts.get(user.userId) ?? null;
      out.push({
        kind: expertId === null ? "member" : "expert",
        userId: user.userId,
        name: user.displayName,
        expertId,
      });
    }
    // People with threads here who are not accounts: the host operator, helper sessions.
    for (const thread of store.threads(projectId)) {
      for (const member of thread.members) {
        if (out.some((candidate) => candidate.userId === member.id)) continue;
        out.push({
          kind: member.id === LP_HOST_PARTICIPANT_ID ? "host" : "member",
          userId: member.id,
          name: member.name,
          expertId: null,
        });
      }
    }
    // Experts from the catalog who have not joined yet: their milestone waits for them.
    for (const expert of experts.experts()) {
      if (out.some((candidate) => candidate.expertId === expert.id)) continue;
      out.push({ kind: "expert", userId: null, name: expert.name, expertId: expert.id });
    }
    return out;
  });

  const list = (projectId: string) => Effect.sync(() => store.goals(projectId));

  const save = (goal: Goal) => store.putGoal(goal);

  const load = (goalId: string) => {
    const goal = store.goal(goalId);
    return goal === undefined ? fail("not_found", `No goal ${goalId}.`) : Effect.succeed(goal);
  };

  /** The thread a milestone goes to: the assignee's own, most recently active. */
  const threadFor = (goal: Goal, milestone: Milestone): LedgerThread | undefined => {
    const threads = store
      .threads(goal.projectId)
      .filter((thread) => thread.branchedFrom === null || thread.branchedFrom === undefined)
      .sort((a, b) => b.lastActiveAtMs - a.lastActiveAtMs);
    const assignee = milestone.assignee;
    const owned = threads.filter(
      (thread) =>
        (assignee.userId !== null && ownerOf(thread).id === assignee.userId) ||
        (assignee.userId === null && nameMatches(ownerOf(thread).name, assignee.name)),
    );
    // A milestone for the planner themself stays in a thread other than the planning one when possible.
    return (
      owned.find((thread) => thread.threadId !== goal.plannedInThreadId) ??
      owned[0] ??
      threads.find(
        (thread) =>
          thread.threadId !== goal.plannedInThreadId &&
          thread.members.some((member) => member.id === assignee.userId),
      )
    );
  };

  /** Sends every confirmed milestone that has a thread now; the rest wait. */
  const deliver = Effect.fn("ProjectGoals.deliver")(function* (goalId: string) {
    let goal = store.goal(goalId);
    if (goal === undefined || goal.state !== "active") return goal;
    yield* ledger.refreshProject(goal.projectId);
    for (const milestone of goal.milestones) {
      if (milestone.threadId !== null || milestone.status !== "pending") continue;
      const target = threadFor(goal, milestone);
      if (target === undefined) continue;
      const nowMs = yield* now;
      if (target.threadId !== goal.plannedInThreadId && goal.plannedInThreadId !== null) {
        yield* ledger
          .send({
            projectId: goal.projectId,
            fromThreadId: goal.plannedInThreadId,
            fromName: goal.ownerName,
            to: target.threadId,
            text: taskText(goal, milestone),
            goalTask: { goalId: goal.id, milestoneId: milestone.id },
          })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("LogicPacks goal task not sent", { cause }),
            ),
          );
      }
      goal = markDelivered(goal, milestone.id, target.threadId, nowMs);
      touched.set(target.threadId, new Set());
      yield* save(goal);
    }
    return goal;
  });

  const plan = Effect.fn("ProjectGoals.plan")(function* (input: {
    readonly threadId: string;
    readonly plan: GoalPlan;
    readonly goalId?: string | undefined;
  }) {
    const actor = yield* agentActor(input.threadId);
    if (actor === null) return yield* fail("not_found", "This thread is not in a project.");
    const projectId = (yield* ledger.projectOfThread(input.threadId))!;
    const people = yield* candidates(projectId);
    const nowMs = yield* now;
    return yield* lane.withPermits(1)(
      Effect.gen(function* () {
        if (input.goalId !== undefined) {
          const existing = yield* load(input.goalId);
          const next = yield* rule(() =>
            editDraft(existing, actor, {
              plan: input.plan,
              candidates: people,
              nowMs,
              newId: () => newId("ms"),
            }),
          );
          yield* save(next);
          return next;
        }
        const thread = store.thread(input.threadId)!;
        const owner = ownerOf(thread);
        const goal = yield* rule(() =>
          draftGoal({
            id: newId("goal"),
            projectId,
            plan: input.plan,
            owner: { id: owner.id, name: owner.name },
            plannedInThreadId: input.threadId,
            candidates: people,
            nowMs,
            newId: () => newId("ms"),
            by: actor.name,
          }),
        );
        yield* save(goal);
        return goal;
      }),
    );
  });

  const create = Effect.fn("ProjectGoals.create")(function* (input: {
    readonly projectId: string;
    readonly actor: GoalActor;
    readonly threadId: string | null;
    readonly plan: GoalPlan;
  }) {
    if (input.threadId !== null) {
      const projectId = yield* ledger.projectOfThread(input.threadId);
      if (projectId !== input.projectId) {
        return yield* fail("invalid", "That thread is not in this project.");
      }
    }
    const people = yield* candidates(input.projectId);
    const nowMs = yield* now;
    const goal = yield* rule(() =>
      draftGoal({
        id: newId("goal"),
        projectId: input.projectId,
        plan: input.plan,
        owner: { id: input.actor.id, name: input.actor.name },
        plannedInThreadId: input.threadId,
        candidates: people,
        nowMs,
        newId: () => newId("ms"),
        by: input.actor.name,
      }),
    );
    yield* save(goal);
    return goal;
  });

  /** Runs a rule on a goal under the lane and saves the result. */
  const change = (goalId: string, run: (goal: Goal, nowMs: number) => Goal) =>
    lane.withPermits(1)(
      Effect.gen(function* () {
        const goal = yield* load(goalId);
        const nowMs = yield* now;
        const next = yield* rule(() => run(goal, nowMs));
        if (next !== goal) yield* save(next);
        return next;
      }),
    );

  const edit = Effect.fn("ProjectGoals.edit")(function* (input: {
    readonly goalId: string;
    readonly actor: GoalActor;
    readonly plan?: GoalPlan | undefined;
    readonly judge?: boolean | undefined;
  }) {
    const goal = yield* load(input.goalId);
    const people = yield* candidates(goal.projectId);
    const edited = yield* change(input.goalId, (current, nowMs) =>
      editDraft(current, input.actor, {
        plan: input.plan,
        judge: input.judge,
        candidates: people,
        nowMs,
        newId: () => newId("ms"),
      }),
    );
    // New milestones on an active goal go out like the first ones.
    return edited.state === "active" ? ((yield* deliver(edited.id)) ?? edited) : edited;
  });

  const confirm = Effect.fn("ProjectGoals.confirm")(function* (input: {
    readonly goalId: string;
    readonly actor: GoalActor;
  }) {
    const confirmed = yield* change(input.goalId, (goal, nowMs) =>
      confirmGoal(goal, input.actor, nowMs),
    );
    return (yield* deliver(confirmed.id)) ?? confirmed;
  });

  const cancel = Effect.fn("ProjectGoals.cancel")(function* (input: {
    readonly goalId: string;
    readonly actor: GoalActor;
  }) {
    return yield* change(input.goalId, (goal, nowMs) => cancelGoal(goal, input.actor, nowMs));
  });

  const goalOfMilestone = (milestoneId: string) => {
    for (const projectId of store.projectIds()) {
      for (const goal of store.goals(projectId)) {
        if (goal.milestones.some((milestone) => milestone.id === milestoneId)) return goal;
      }
    }
    return undefined;
  };

  /** Tells a thread something as the goal's owner; failures are logged, never fatal. */
  const tell = (goal: Goal, toThreadId: string, text: string, fromName: string) =>
    toThreadId === goal.plannedInThreadId
      ? Effect.void
      : ledger
          .send({
            projectId: goal.projectId,
            fromThreadId: goal.plannedInThreadId,
            fromName,
            to: toThreadId,
            text,
          })
          .pipe(
            Effect.asVoid,
            Effect.catchCause((cause) =>
              Effect.logWarning("LogicPacks goal message not sent", { cause }),
            ),
          );

  const updateMilestoneFn = Effect.fn("ProjectGoals.updateMilestone")(function* (input: {
    readonly milestoneId: string;
    readonly actor: GoalActor;
    readonly status: AssigneeStatus;
    readonly note?: string | undefined;
    readonly report?: ReadonlyArray<CriterionReport> | undefined;
  }) {
    const goal = goalOfMilestone(input.milestoneId);
    if (goal === undefined) return yield* fail("not_found", `No milestone ${input.milestoneId}.`);
    return yield* change(goal.id, (current, nowMs) =>
      updateMilestone(current, input.actor, {
        milestoneId: input.milestoneId,
        status: input.status,
        note: input.note,
        report: input.report,
        nowMs,
        newId: () => newId("review"),
      }),
    );
  });

  const review = Effect.fn("ProjectGoals.review")(function* (input: {
    readonly goalId: string;
    readonly milestoneId: string;
    readonly actor: GoalActor;
    readonly verdict: "approve" | "changes";
    readonly note?: string | undefined;
  }) {
    const next = yield* change(input.goalId, (goal, nowMs) =>
      reviewMilestone(goal, input.actor, {
        milestoneId: input.milestoneId,
        verdict: input.verdict,
        note: input.note,
        nowMs,
      }),
    );
    const milestone = next.milestones.find((m) => m.id === input.milestoneId);
    if (milestone?.threadId) {
      yield* tell(
        next,
        milestone.threadId,
        input.verdict === "approve"
          ? `Approved: "${milestone.title}".${input.note ? ` ${input.note}` : ""}`
          : `Sent back: "${milestone.title}". ${input.note ?? ""}`,
        input.actor.name,
      );
    }
    return next;
  });

  const decide = Effect.fn("ProjectGoals.decide")(function* (input: {
    readonly goalId: string;
    readonly decisionId: string;
    readonly actor: GoalActor;
    readonly action: string;
    readonly note?: string | undefined;
  }) {
    const goal = yield* load(input.goalId);
    const request = goal.decisions.find((entry) => entry.id === input.decisionId);
    if (request === undefined) return yield* fail("not_found", "No such request on this goal.");
    if (request.status !== "open") return yield* fail("invalid", "This was already decided.");
    if (!canDecide(request, input.actor)) {
      return yield* fail("forbidden", `Only ${goal.ownerName} or the host can decide this.`);
    }
    const action = request.actions.find(
      (entry) => entry.id === input.action && entry.inApp === undefined,
    );
    if (action === undefined)
      return yield* fail("invalid", `"${input.action}" is not an answer to this.`);
    const note = input.note?.trim() ?? "";
    if (action.needsNote && note.length === 0) {
      return yield* fail("invalid", `${action.label} needs a note.`);
    }
    switch (request.kind) {
      case "goal.review":
        return yield* review({
          goalId: goal.id,
          milestoneId: request.subject.milestoneId,
          actor: input.actor,
          verdict: action.id === "approve" ? "approve" : "changes",
          note,
        });
      case "goal.drift": {
        const threadId = request.subject.threadId;
        if (action.id === "message") {
          if (threadId === null) {
            return yield* fail(
              "invalid",
              `${request.subject.who.name} has no thread to message yet.`,
            );
          }
          // A direct message from the host into the person's thread, like any send-to-thread.
          yield* ledger.send({
            projectId: goal.projectId,
            fromThreadId: goal.plannedInThreadId !== threadId ? goal.plannedInThreadId : null,
            fromName: input.actor.name,
            to: threadId,
            text: note,
          });
        }
        return yield* change(input.goalId, (current, nowMs) =>
          resolveDrift(current, input.actor, {
            decisionId: request.id,
            action:
              action.id === "message" ? "message" : action.id === "accept" ? "accept" : "ignore",
            note,
            nowMs,
          }),
        );
      }
    }
  });

  /** The active milestone a thread works on, and its goal. */
  const assignmentOf = (threadId: string) => {
    const thread = store.thread(threadId);
    if (thread === undefined) return undefined;
    for (const goal of store.goals(thread.projectId)) {
      if (goal.state !== "active") continue;
      for (const milestone of goal.milestones) {
        if (milestone.threadId === threadId && isOpenMilestone(milestone)) {
          return { goal, milestone, thread };
        }
      }
    }
    return undefined;
  };

  const dependencyChanges = Effect.fn("ProjectGoals.dependencyChanges")(function* (
    cwd: string | null,
    files: ReadonlyArray<string>,
  ) {
    if (cwd === null) return [];
    const out: Array<{ path: string; added: ReadonlyArray<string> }> = [];
    for (const path of files.filter(isManifest)) {
      const pair = yield* deps.manifestPair(cwd, path);
      if (pair === null) continue;
      const added = addedDependencies(path, pair.before, pair.after);
      if (added.length > 0) out.push({ path, added });
    }
    return out;
  });

  const checkThread = Effect.fn("ProjectGoals.checkThread")(function* (input: {
    readonly threadId: string;
    readonly files: ReadonlyArray<string>;
    readonly turnEnd: boolean;
  }) {
    const assignment = assignmentOf(input.threadId);
    if (assignment === undefined) return [];
    const seen = touched.get(input.threadId) ?? new Set<string>();
    for (const file of input.files) seen.add(file);
    touched.set(input.threadId, seen);
    const files = input.turnEnd ? Array.from(seen) : [...input.files];
    const work = input.turnEnd ? yield* deps.threadWork(input.threadId) : null;
    const nowMs = yield* now;
    const findings = checkMilestone({
      milestone: assignment.milestone,
      files,
      branch: work?.branch ?? null,
      dependencies: input.turnEnd ? yield* dependencyChanges(work?.cwd ?? null, files) : [],
      nowMs,
    });
    let judged: DriftFinding | null = null;
    const key = assignment.milestone.id;
    if (
      input.turnEnd &&
      assignment.goal.judge &&
      work !== null &&
      work.cwd !== null &&
      judgeAllowed(lastJudgedAt.get(key), nowMs)
    ) {
      lastJudgedAt.set(key, nowMs);
      judged = yield* judge
        .judge({
          cwd: work.cwd,
          goal: assignment.goal,
          milestone: assignment.milestone,
          files,
          lastReply: work.lastReply,
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logDebug("Goal judgment skipped", { cause }).pipe(Effect.as(null)),
          ),
        );
    }
    const all = judged === null ? findings : [...findings, judged];
    if (all.length === 0) return [];
    return yield* lane.withPermits(1)(
      Effect.gen(function* () {
        const current = store.goal(assignment.goal.id);
        const milestone = current?.milestones.find((m) => m.id === key);
        if (current === undefined || milestone === undefined) return [];
        const result = addFindings(current, milestone, all, {
          nowMs,
          newId: () => newId("drift"),
        });
        if (result.added.length > 0) yield* save(result.goal);
        return result.added;
      }),
    );
  });

  const tick = Effect.fn("ProjectGoals.tick")(function* () {
    const nowMs = yield* now;
    for (const projectId of store.projectIds()) {
      for (const goal of store.goals(projectId)) {
        if (goal.state !== "active") continue;
        if (goal.milestones.some((m) => m.status === "pending" && m.threadId === null)) {
          yield* deliver(goal.id);
        }
        for (const milestone of goal.milestones) {
          const overdue = overdueFinding(milestone, nowMs);
          if (overdue === null) continue;
          yield* lane.withPermits(1)(
            Effect.gen(function* () {
              const current = store.goal(goal.id);
              const fresh = current?.milestones.find((m) => m.id === milestone.id);
              if (current === undefined || fresh === undefined) return;
              const result = addFindings(current, fresh, [overdue], {
                nowMs,
                newId: () => newId("drift"),
              });
              if (result.added.length > 0) yield* save(result.goal);
            }),
          );
        }
      }
    }
  });

  return ProjectGoals.of({
    list,
    get: (goalId) => store.goal(goalId),
    candidates,
    plan,
    create,
    edit,
    confirm,
    cancel,
    updateMilestone: updateMilestoneFn,
    review,
    decide,
    checkThread,
    tick,
    actorFor,
    agentActor,
  });
});

const TICK = Duration.seconds(30);
const FINISHED = new Set(["completed", "interrupted", "failed", "cancelled"]);

/** The service plus its watchers: agent edits, finished turns, and a slow tick. */
export const layer = Layer.effect(
  ProjectGoals,
  Effect.gen(function* () {
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const projects = yield* ProjectStore.ProjectStoreV2;
    const git = yield* GitVcsDriver.GitVcsDriver;
    const presence = yield* PresenceService;
    const fileSystem = yield* FileSystem.FileSystem;
    const nodePath = yield* Path.Path;

    const runGit = (cwd: string, args: ReadonlyArray<string>) =>
      git
        .execute({
          operation: "logicpacks.goals",
          cwd,
          args,
          allowNonZeroExit: true,
          timeoutMs: 15_000,
        })
        .pipe(
          Effect.map((result) => (Number(result.exitCode) === 0 ? result.stdout : null)),
          Effect.orElseSucceed(() => null),
        );

    const threadWork = Effect.fn("ProjectGoals.threadWork")(function* (threadId: string) {
      const shell = yield* threads
        .getThreadShell(threadId as ThreadId)
        .pipe(Effect.orElseSucceed(() => null));
      if (shell === null) return null;
      const project = yield* projects.getShell(shell.projectId as ProjectId).pipe(
        Effect.map(Option.getOrNull),
        Effect.orElseSucceed(() => null),
      );
      const cwd = shell.worktreePath ?? project?.workspaceRoot ?? null;
      const head =
        cwd === null ? null : yield* runGit(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
      const latest = shell.latestVisibleMessage;
      return {
        cwd,
        branch: head?.trim() || shell.branch || null,
        lastReply: latest?.role === "assistant" ? latest.text : "",
      } satisfies ThreadWork;
    });

    const manifestPair = Effect.fn("ProjectGoals.manifestPair")(function* (
      cwd: string,
      path: string,
    ) {
      const before = yield* runGit(cwd, ["show", `HEAD:${path}`]);
      // The working copy: an agent's edit is usually not staged or committed yet.
      const after = yield* fileSystem
        .readFileString(nodePath.join(cwd, path))
        .pipe(Effect.orElseSucceed(() => null));
      return { before, after };
    });

    const service = yield* makeGoals({ threadWork, manifestPair });

    const onPresence = (entry: PresenceEntry) =>
      entry.actor.kind === "agent" &&
      entry.location.activity === "editing" &&
      entry.threadId !== undefined &&
      entry.location.path !== undefined
        ? service.checkThread({
            threadId: entry.threadId,
            files: [entry.location.path],
            turnEnd: false,
          })
        : Effect.void;

    const onDomainEvent = (event: OrchestrationV2DomainEvent) =>
      event.type === "run.updated" && FINISHED.has(event.payload.status)
        ? service.checkThread({ threadId: event.threadId, files: [], turnEnd: true })
        : event.type === "thread.created"
          ? // A milestone waiting for its assignee's first thread goes out now.
            service.tick()
          : Effect.void;

    yield* forkParked(
      Stream.runForEach(
        presence.stream(() => true),
        (event) =>
          (event.type === "upsert" ? onPresence(event.entry) : Effect.void).pipe(
            Effect.asVoid,
            Effect.catchCause((cause) => Effect.logDebug("Goal edit check skipped", { cause })),
          ),
      ),
    );
    yield* forkParked(
      Stream.runForEach(threads.streamDomainEvents, (event) =>
        onDomainEvent(event).pipe(
          Effect.asVoid,
          Effect.catchCause((cause) => Effect.logDebug("Goal turn check skipped", { cause })),
        ),
      ),
    );
    yield* forkParked(
      service.tick().pipe(
        Effect.catchCause((cause) => Effect.logDebug("Goal tick skipped", { cause })),
        Effect.delay(TICK),
        Effect.forever,
      ),
    );
    return service;
  }),
);
