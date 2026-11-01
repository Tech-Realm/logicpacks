// @effect-diagnostics globalDate:off -- due dates are local calendar days ("friday"), plain data here.
/**
 * Goals (Beta): milestones for teammates or experts with criteria and guardrails
 * (scope), checked against their turns and reviewed by the host. Plain rules, no
 * storage, unit-tested directly; `ProjectGoals.ts` runs them.
 */
import * as Schema from "effect/Schema";

import {
  DRIFT_ACTIONS,
  REVIEW_ACTIONS,
  canDecide,
  isOpen,
  resolveRequest,
  type DecisionRequest,
} from "./decisionRequests.ts";
import { clip, nameMatches } from "./ledger.ts";

// ── Shapes ────────────────────────────────────────────────────────────────

export type GoalState = "draft" | "active" | "done" | "cancelled";

/**
 * pending: confirmed, waiting for the assignee to have a thread. sent: in their
 * thread. done: marked done, waiting for the host's review.
 */
export type MilestoneStatus =
  | "pending"
  | "sent"
  | "in_progress"
  | "blocked"
  | "done"
  | "approved"
  | "changes_requested";

export type AssigneeKind = "member" | "expert" | "host" | "unknown";

export interface GoalAssignee {
  readonly kind: AssigneeKind;
  /** A member's user id, "host", or null while nobody matched the name. */
  readonly userId: string | null;
  readonly name: string;
  /** The catalog id of an expert, for their portrait. */
  readonly expertId: string | null;
}

export interface MilestoneScope {
  /** Paths and globs the work may touch; empty means anywhere not avoided. */
  readonly paths: ReadonlyArray<string>;
  /** Paths and globs the work must not touch. */
  readonly avoid: ReadonlyArray<string>;
  /** The branch the work is expected on, when it matters. */
  readonly branch: string | null;
  readonly newDependencies: boolean;
  /** Boundaries no check can read, like "don't change the API"; the judgment and the host do. */
  readonly notes: ReadonlyArray<string>;
}

export interface CriterionReport {
  readonly criterion: string;
  readonly met: boolean;
  readonly evidence: string;
}

export interface MilestoneReview {
  readonly verdict: "approved" | "changes";
  readonly note: string;
  readonly by: string;
  readonly atMs: number;
}

export interface Milestone {
  readonly id: string;
  readonly title: string;
  readonly assignee: GoalAssignee;
  readonly criteria: ReadonlyArray<string>;
  readonly scope: MilestoneScope;
  readonly dueAtMs: number | null;
  readonly status: MilestoneStatus;
  /** The assignee's thread it was delivered to. */
  readonly threadId: string | null;
  readonly deliveredAtMs: number | null;
  readonly doneNote: string | null;
  readonly report: ReadonlyArray<CriterionReport>;
  readonly review: MilestoneReview | null;
  readonly updatedAtMs: number;
}

export type DriftKind =
  | "outside_scope"
  | "avoided_path"
  | "wrong_branch"
  | "new_dependency"
  | "overdue"
  | "judgment";

/**
 * Drift findings and done milestones are decision requests on the goal (kinds
 * "goal.drift" and "goal.review"); the app's dialog and cards render the record.
 */
export type GoalDecision = DecisionRequest;

export interface GoalLogEntry {
  readonly atMs: number;
  readonly by: string;
  readonly text: string;
}

export interface Goal {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly outcome: string;
  /** Who owns the goal: a member's user id or "host". */
  readonly ownerId: string;
  readonly ownerName: string;
  /** The thread it was planned in; deliveries and replies go from there. */
  readonly plannedInThreadId: string | null;
  readonly state: GoalState;
  readonly milestones: ReadonlyArray<Milestone>;
  /** Drift and reviews waiting for (or decided by) the host, newest last. */
  readonly decisions: ReadonlyArray<GoalDecision>;
  readonly log: ReadonlyArray<GoalLogEntry>;
  /** Ask a model at turn end whether the work went beyond or against the milestone. */
  readonly judge: boolean;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly confirmedAtMs: number | null;
}

/** Someone a milestone can go to. */
export interface GoalCandidate {
  readonly kind: Exclude<AssigneeKind, "unknown">;
  readonly userId: string | null;
  readonly name: string;
  readonly expertId: string | null;
}

/** Who acts: a person through the app, or an agent in its thread. */
export interface GoalActor {
  readonly id: string;
  readonly name: string;
  /** The host operator or the project's owner. */
  readonly isHost: boolean;
  /** Set for an agent: the thread it runs in. */
  readonly threadId: string | null;
}

export class GoalRuleError extends Error {
  readonly reason: "invalid" | "forbidden" | "not_found";
  constructor(reason: "invalid" | "forbidden" | "not_found", message: string) {
    super(message);
    this.reason = reason;
  }
}

const refuse = (reason: GoalRuleError["reason"], message: string): never => {
  throw new GoalRuleError(reason, message);
};

// ── The plan an agent (or a person) hands in ────────────────────────────────

export const MAX_MILESTONES = 12;

const Text = (max: number) => Schema.String.check(Schema.isMaxLength(max));
const TextList = (item: number, count: number) =>
  Schema.Array(Text(item)).check(Schema.isMaxLength(count));

export const GoalPlanScope = Schema.Struct({
  paths: Schema.optionalKey(TextList(300, 20)),
  avoid: Schema.optionalKey(TextList(300, 20)),
  branch: Schema.optionalKey(Schema.NullOr(Text(200))),
  newDependencies: Schema.optionalKey(Schema.Boolean),
  notes: Schema.optionalKey(TextList(300, 10)),
});

export const GoalPlanMilestone = Schema.Struct({
  /** Keeps a milestone's id (and its delivery) when a draft is edited. */
  id: Schema.optionalKey(Text(40)),
  title: Text(200),
  /** A person's or expert's name, as the host said it. */
  assignee: Text(120),
  criteria: Schema.optionalKey(TextList(400, 12)),
  scope: Schema.optionalKey(GoalPlanScope),
  /** An ISO date or time, or a word: "today", "tomorrow", "friday", "in 3 days". */
  due: Schema.optionalKey(Schema.NullOr(Text(60))),
});
export type GoalPlanMilestone = typeof GoalPlanMilestone.Type;

export const GoalPlan = Schema.Struct({
  title: Text(200),
  outcome: Schema.optionalKey(Text(1000)),
  milestones: Schema.Array(GoalPlanMilestone).check(Schema.isMaxLength(MAX_MILESTONES)),
});
export type GoalPlan = typeof GoalPlan.Type;

export const decodeGoalPlan = Schema.decodeUnknownExit(GoalPlan);

// ── Due dates ─────────────────────────────────────────────────────────────

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

const endOfDay = (date: Date) =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 0).getTime();

/**
 * When a milestone is due: an ISO date (end of that day), an ISO time, or a word
 * relative to now ("today", "tomorrow", "friday" = the next Friday, today if it is
 * Friday, "in 3 days", "next week"). Null when it cannot be read.
 */
export const parseDue = (text: string | null | undefined, nowMs: number): number | null => {
  if (text === null || text === undefined) return null;
  const raw = text
    .trim()
    .toLowerCase()
    .replace(/^by\s+/, "");
  if (raw.length === 0) return null;
  const now = new Date(nowMs);
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (dateOnly) {
    const day = new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]));
    return Number.isNaN(day.getTime()) ? null : endOfDay(day);
  }
  if (/^\d{4}-\d{2}-\d{2}t/.test(raw)) {
    const at = Date.parse(text.trim());
    return Number.isNaN(at) ? null : at;
  }
  if (raw === "today" || raw === "eod" || raw === "end of day") return endOfDay(now);
  if (raw === "tomorrow") {
    return endOfDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));
  }
  const inDays = /^in (\d{1,3}) days?$/.exec(raw);
  if (inDays) {
    return endOfDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() + Number(inDays[1])));
  }
  if (raw === "next week" || raw === "in a week") {
    return endOfDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 7));
  }
  const weekday = WEEKDAYS.indexOf(raw.replace(/^(this|next)\s+/, ""));
  if (weekday >= 0) {
    let ahead = (weekday - now.getDay() + 7) % 7;
    if (raw.startsWith("next ") && ahead === 0) ahead = 7;
    return endOfDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() + ahead));
  }
  return null;
};

// ── Assignees ─────────────────────────────────────────────────────────────

/** A name to a candidate: exact or first name, members before experts. */
export const resolveAssignee = (
  candidates: ReadonlyArray<GoalCandidate>,
  name: string,
): GoalAssignee => {
  const wanted = name.trim().replace(/^@/, "");
  const byKind = (kind: GoalCandidate["kind"]) =>
    candidates.find((candidate) => candidate.kind === kind && nameMatches(candidate.name, wanted));
  const found =
    candidates.find((candidate) => candidate.userId !== null && candidate.userId === wanted) ??
    byKind("member") ??
    byKind("host") ??
    byKind("expert");
  if (found === undefined) {
    return { kind: "unknown", userId: null, name: clip(wanted, 80) || "Someone", expertId: null };
  }
  return {
    kind: found.kind,
    userId: found.userId,
    name: found.name,
    expertId: found.expertId,
  };
};

// ── Drafts ────────────────────────────────────────────────────────────────

const cleanList = (items: ReadonlyArray<string> | undefined, max: number, length: number) =>
  Array.from(
    new Set((items ?? []).map((item) => clip(item, length)).filter((item) => item.length > 0)),
  ).slice(0, max);

const normalizePath = (path: string) =>
  path.trim().replace(/^\.\//, "").replace(/^\/+/, "").replaceAll("\\", "/");

export const scopeFromPlan = (scope: GoalPlanMilestone["scope"] | undefined): MilestoneScope => ({
  paths: cleanList(scope?.paths?.map(normalizePath), 20, 300),
  avoid: cleanList(scope?.avoid?.map(normalizePath), 20, 300),
  branch: scope?.branch?.trim() ? clip(scope.branch, 200) : null,
  newDependencies: scope?.newDependencies ?? false,
  notes: cleanList(scope?.notes, 10, 300),
});

/** Builds (or rebuilds) a draft's milestones; ids of kept milestones stay. */
export const milestonesFromPlan = (input: {
  readonly plan: GoalPlan;
  readonly candidates: ReadonlyArray<GoalCandidate>;
  readonly previous: ReadonlyArray<Milestone>;
  readonly nowMs: number;
  readonly newId: () => string;
}): ReadonlyArray<Milestone> => {
  if (input.plan.milestones.length === 0) refuse("invalid", "A goal needs at least one milestone.");
  return input.plan.milestones.map((planned) => {
    const title = clip(planned.title, 200);
    if (title.length === 0) refuse("invalid", "Every milestone needs a title.");
    const kept =
      planned.id === undefined ? undefined : input.previous.find((m) => m.id === planned.id);
    const due = planned.due === undefined ? undefined : parseDue(planned.due, input.nowMs);
    if (planned.due && due === null) {
      refuse("invalid", `Could not read the due date "${planned.due}". Use YYYY-MM-DD.`);
    }
    return {
      id: kept?.id ?? input.newId(),
      title,
      assignee: resolveAssignee(input.candidates, planned.assignee),
      criteria: cleanList(planned.criteria, 12, 400),
      scope: scopeFromPlan(planned.scope),
      dueAtMs: due === undefined ? (kept?.dueAtMs ?? null) : due,
      status: kept?.status ?? "pending",
      threadId: kept?.threadId ?? null,
      deliveredAtMs: kept?.deliveredAtMs ?? null,
      doneNote: kept?.doneNote ?? null,
      report: kept?.report ?? [],
      review: kept?.review ?? null,
      updatedAtMs: input.nowMs,
    } satisfies Milestone;
  });
};

export const draftGoal = (input: {
  readonly id: string;
  readonly projectId: string;
  readonly plan: GoalPlan;
  readonly owner: { readonly id: string; readonly name: string };
  readonly plannedInThreadId: string | null;
  readonly candidates: ReadonlyArray<GoalCandidate>;
  readonly nowMs: number;
  readonly newId: () => string;
  readonly by: string;
}): Goal => {
  const title = clip(input.plan.title, 200);
  if (title.length === 0) refuse("invalid", "A goal needs a title.");
  return {
    id: input.id,
    projectId: input.projectId,
    title,
    outcome: clip(input.plan.outcome ?? "", 1000),
    ownerId: input.owner.id,
    ownerName: input.owner.name,
    plannedInThreadId: input.plannedInThreadId,
    state: "draft",
    milestones: milestonesFromPlan({
      plan: input.plan,
      candidates: input.candidates,
      previous: [],
      nowMs: input.nowMs,
      newId: input.newId,
    }),
    decisions: [],
    log: [{ atMs: input.nowMs, by: input.by, text: "Drafted the goal." }],
    judge: false,
    createdAtMs: input.nowMs,
    updatedAtMs: input.nowMs,
    confirmedAtMs: null,
  };
};

const touch = (goal: Goal, nowMs: number, by: string, text: string | null): Goal => ({
  ...goal,
  updatedAtMs: nowMs,
  log: text === null ? goal.log : [...goal.log, { atMs: nowMs, by, text }].slice(-80),
});

// ── Permissions ───────────────────────────────────────────────────────────

/** Confirm, edit, approve and resolve drift: the host or the goal's owner, never an agent. */
export const canManage = (goal: Goal, actor: GoalActor) =>
  actor.threadId === null && (actor.isHost || actor.id === goal.ownerId);

/** An assignee (or their agent, in the milestone's thread) updates their own milestone. */
export const canUpdateMilestone = (goal: Goal, milestone: Milestone, actor: GoalActor) => {
  if (canManage(goal, actor)) return true;
  if (actor.threadId !== null) {
    return milestone.threadId !== null && milestone.threadId === actor.threadId;
  }
  return milestone.assignee.userId !== null && milestone.assignee.userId === actor.id;
};

const requireManage = (goal: Goal, actor: GoalActor, what: string) => {
  if (!canManage(goal, actor)) {
    refuse("forbidden", `Only ${goal.ownerName} or the host can ${what}.`);
  }
};

const findMilestone = (goal: Goal, milestoneId: string) =>
  goal.milestones.find((milestone) => milestone.id === milestoneId) ??
  refuse("not_found", `No milestone ${milestoneId} in this goal.`);

const withMilestone = (goal: Goal, next: Milestone): Goal => ({
  ...goal,
  milestones: goal.milestones.map((milestone) => (milestone.id === next.id ? next : milestone)),
});

// ── Transitions ───────────────────────────────────────────────────────────

export const editDraft = (
  goal: Goal,
  actor: GoalActor,
  patch: {
    readonly plan?: GoalPlan | undefined;
    readonly judge?: boolean | undefined;
    readonly candidates: ReadonlyArray<GoalCandidate>;
    readonly nowMs: number;
    readonly newId: () => string;
  },
): Goal => {
  // The agent that drafted it may revise its own draft until a person confirms it.
  const draftingAgent =
    actor.threadId !== null && goal.state === "draft" && goal.plannedInThreadId === actor.threadId;
  if (!draftingAgent) requireManage(goal, actor, "edit this goal");
  if (goal.state === "done" || goal.state === "cancelled") {
    refuse("invalid", "This goal is closed.");
  }
  let next = goal;
  if (patch.plan !== undefined) {
    const milestones = milestonesFromPlan({
      plan: patch.plan,
      candidates: patch.candidates,
      previous: goal.milestones,
      nowMs: patch.nowMs,
      newId: patch.newId,
    });
    if (goal.state === "active") {
      // A delivered milestone keeps its person; a new one waits for delivery.
      for (const milestone of milestones) {
        const before = goal.milestones.find((m) => m.id === milestone.id);
        if (before?.threadId && before.assignee.userId !== milestone.assignee.userId) {
          refuse("invalid", `"${before.title}" was already sent to ${before.assignee.name}.`);
        }
      }
    }
    next = {
      ...next,
      title: clip(patch.plan.title, 200) || goal.title,
      outcome: clip(patch.plan.outcome ?? goal.outcome, 1000),
      milestones,
    };
  }
  if (patch.judge !== undefined) next = { ...next, judge: patch.judge };
  return touch(next, patch.nowMs, actor.name, "Edited the goal.");
};

export const confirmGoal = (goal: Goal, actor: GoalActor, nowMs: number): Goal => {
  requireManage(goal, actor, "confirm this goal");
  if (goal.state !== "draft") refuse("invalid", "Only a draft can be confirmed.");
  const unknown = goal.milestones.filter((milestone) => milestone.assignee.kind === "unknown");
  if (unknown.length > 0) {
    refuse(
      "invalid",
      `Pick who does ${unknown.map((milestone) => `"${milestone.title}"`).join(", ")}: nobody here is called ${unknown
        .map((milestone) => milestone.assignee.name)
        .join(", ")}.`,
    );
  }
  return touch(
    { ...goal, state: "active", confirmedAtMs: nowMs },
    nowMs,
    actor.name,
    `Confirmed; sending ${goal.milestones.length} milestone${goal.milestones.length === 1 ? "" : "s"}.`,
  );
};

export const cancelGoal = (goal: Goal, actor: GoalActor, nowMs: number): Goal => {
  requireManage(goal, actor, "close this goal");
  if (goal.state === "cancelled") return goal;
  return touch({ ...goal, state: "cancelled" }, nowMs, actor.name, "Closed the goal.");
};

export const markDelivered = (
  goal: Goal,
  milestoneId: string,
  threadId: string,
  nowMs: number,
): Goal => {
  const milestone = findMilestone(goal, milestoneId);
  return touch(
    withMilestone(goal, {
      ...milestone,
      threadId,
      deliveredAtMs: nowMs,
      status: milestone.status === "pending" ? "sent" : milestone.status,
      updatedAtMs: nowMs,
    }),
    nowMs,
    "LogicPacks",
    `Sent "${milestone.title}" to ${milestone.assignee.name}.`,
  );
};

export type AssigneeStatus = "in_progress" | "blocked" | "done";

export const updateMilestone = (
  goal: Goal,
  actor: GoalActor,
  input: {
    readonly milestoneId: string;
    readonly status: AssigneeStatus;
    readonly note?: string | undefined;
    readonly report?: ReadonlyArray<CriterionReport> | undefined;
    readonly nowMs: number;
    readonly newId?: (() => string) | undefined;
  },
): Goal => {
  if (goal.state !== "active") refuse("invalid", "This goal is not active.");
  const milestone = findMilestone(goal, input.milestoneId);
  if (!canUpdateMilestone(goal, milestone, actor)) {
    refuse("forbidden", `Only ${milestone.assignee.name} (or their agent) updates this milestone.`);
  }
  if (milestone.status === "approved") refuse("invalid", "This milestone is already approved.");
  if (milestone.status === "pending") {
    refuse("invalid", `"${milestone.title}" has not reached ${milestone.assignee.name} yet.`);
  }
  const note = clip(input.note ?? "", 1000);
  const report = (input.report ?? []).slice(0, 12).map((entry) => ({
    criterion: clip(entry.criterion, 400),
    met: entry.met,
    evidence: clip(entry.evidence, 400),
  }));
  const next: Milestone = {
    ...milestone,
    status: input.status,
    updatedAtMs: input.nowMs,
    ...(input.status === "done" ? { doneNote: note || null, report } : {}),
  };
  const verb =
    input.status === "done"
      ? "marked it done"
      : input.status === "blocked"
        ? "is blocked"
        : "started";
  const updated = withMilestone(goal, next);
  return touch(
    input.status === "done"
      ? withDecisions(updated, [
          ...updated.decisions.filter(
            (entry) =>
              !(entry.kind === "goal.review" && isOpen(entry) && entry.sourceId === milestone.id),
          ),
          reviewRequest(
            updated,
            next,
            input.newId?.() ?? `review-${milestone.id}-${input.nowMs}`,
            input.nowMs,
          ),
        ])
      : updated,
    input.nowMs,
    actor.name,
    `${milestone.assignee.name}: "${milestone.title}" ${verb}${note ? `: ${clip(note, 160)}` : "."}`,
  );
};

const withDecisions = (goal: Goal, decisions: ReadonlyArray<GoalDecision>): Goal => ({
  ...goal,
  decisions: decisions.slice(-120),
});

const subjectOf = (goal: Goal, milestone: Milestone) => ({
  type: "milestone" as const,
  goalId: goal.id,
  milestoneId: milestone.id,
  threadId: milestone.threadId,
  title: milestone.title,
  who: { id: milestone.assignee.userId, name: milestone.assignee.name },
});

/** "Priya marked Checkout tests done": a review card for the goal's owner (or the host). */
const reviewRequest = (
  goal: Goal,
  milestone: Milestone,
  id: string,
  nowMs: number,
): GoalDecision => ({
  id,
  projectId: goal.projectId,
  kind: "goal.review",
  sourceId: milestone.id,
  subject: subjectOf(goal, milestone),
  presentation: "card",
  title: `${firstName(milestone.assignee.name)} marked "${milestone.title}" done`,
  summary: milestone.doneNote ?? "",
  detail:
    milestone.report.length > 0
      ? milestone.report.map(
          (entry) =>
            `${entry.met ? "Met" : "Not met"}: ${entry.criterion}${entry.evidence ? ` (${entry.evidence})` : ""}`,
        )
      : milestone.criteria.map((criterion) => `To check: ${criterion}`),
  reason: null,
  source: "person",
  requester: { id: milestone.assignee.userId, name: milestone.assignee.name },
  approvers: [goal.ownerId],
  actions: REVIEW_ACTIONS,
  status: "open",
  resolution: null,
  createdAtMs: nowMs,
  updatedAtMs: nowMs,
});

const firstName = (name: string) => name.split(/\s+/)[0] ?? name;

export const reviewMilestone = (
  goal: Goal,
  actor: GoalActor,
  input: {
    readonly milestoneId: string;
    readonly verdict: "approve" | "changes";
    readonly note?: string | undefined;
    readonly nowMs: number;
  },
): Goal => {
  requireManage(goal, actor, "review milestones");
  const milestone = findMilestone(goal, input.milestoneId);
  if (milestone.status !== "done") {
    refuse("invalid", `"${milestone.title}" is not marked done yet.`);
  }
  const note = clip(input.note ?? "", 1000);
  if (input.verdict === "changes" && note.length === 0) {
    refuse("invalid", "Say what to change when you send it back.");
  }
  const reviewed = withMilestone(goal, {
    ...milestone,
    status: input.verdict === "approve" ? "approved" : "changes_requested",
    review: {
      verdict: input.verdict === "approve" ? "approved" : "changes",
      note,
      by: actor.name,
      atMs: input.nowMs,
    },
    updatedAtMs: input.nowMs,
  });
  const allApproved = reviewed.milestones.every((m) => m.status === "approved");
  const decided = withDecisions(
    reviewed,
    reviewed.decisions.map((entry) =>
      entry.kind === "goal.review" && isOpen(entry) && entry.sourceId === milestone.id
        ? resolveRequest(entry, { action: input.verdict, by: actor.name, note, atMs: input.nowMs })
        : entry,
    ),
  );
  return touch(
    allApproved ? { ...decided, state: "done" } : decided,
    input.nowMs,
    actor.name,
    input.verdict === "approve"
      ? `Approved "${milestone.title}".${allApproved ? " Goal done." : ""}`
      : `Sent "${milestone.title}" back: ${clip(note, 160)}`,
  );
};

export type DriftAction = "accept" | "ignore" | "message";

/** The host's answer to a drift request: message them, accept it, or ignore it. */
export const resolveDrift = (
  goal: Goal,
  actor: GoalActor,
  input: {
    readonly decisionId: string;
    readonly action: DriftAction;
    readonly note?: string | undefined;
    readonly nowMs: number;
  },
): Goal => {
  const request = findDecision(goal, input.decisionId, "goal.drift");
  if (!canDecide(request, actor)) {
    refuse("forbidden", `Only ${goal.ownerName} or the host can resolve drift.`);
  }
  const note = clip(input.note ?? "", 1000);
  if (input.action === "message" && note.length === 0) refuse("invalid", "The message is empty.");
  const next = resolveRequest(request, {
    action: input.action,
    by: actor.name,
    note,
    atMs: input.nowMs,
  });
  return touch(
    withDecisions(
      goal,
      goal.decisions.map((entry) => (entry.id === request.id ? next : entry)),
    ),
    input.nowMs,
    actor.name,
    input.action === "message"
      ? `Messaged ${request.subject.who.name} about: ${request.summary}`
      : `${input.action === "accept" ? "Accepted" : "Ignored"}: ${request.summary}`,
  );
};

export const findDecision = (goal: Goal, decisionId: string, kind?: GoalDecision["kind"]) => {
  const request =
    goal.decisions.find(
      (entry) => entry.id === decisionId && (kind === undefined || entry.kind === kind),
    ) ?? refuse("not_found", "No such request on this goal.");
  if (!isOpen(request)) refuse("invalid", "This was already decided.");
  return request;
};

export const progress = (goal: Goal) => {
  const total = goal.milestones.length;
  const approved = goal.milestones.filter((m) => m.status === "approved").length;
  const done = goal.milestones.filter((m) => m.status === "done").length;
  return {
    total,
    approved,
    awaitingReview: done,
    percent: total === 0 ? 0 : Math.round((approved / total) * 100),
  };
};

// ── Drift checks (deterministic) ────────────────────────────────────────────

const GLOB_SPECIALS = /[*?[]/;

const globToRegExp = (pattern: string) => {
  let out = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!;
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        index += 1;
        if (pattern[index + 1] === "/") {
          index += 1;
          out += "(?:.*/)?";
        } else {
          out += ".*";
        }
      } else {
        out += "[^/]*";
      }
    } else if (char === "?") {
      out += "[^/]";
    } else {
      out += char.replace(/[.+^${}()|\\[\]]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`);
};

/** "checkout/" and "checkout" cover the folder; globs use * and **. */
export const pathMatches = (path: string, pattern: string): boolean => {
  const file = normalizePath(path);
  const wanted = normalizePath(pattern);
  if (wanted.length === 0) return false;
  if (!GLOB_SPECIALS.test(wanted)) {
    const folder = wanted.replace(/\/+$/, "");
    return file === folder || file.startsWith(`${folder}/`);
  }
  if (wanted.endsWith("/")) return globToRegExp(`${wanted}**`).test(file);
  return globToRegExp(wanted).test(file) || globToRegExp(`${wanted}/**`).test(file);
};

export const scopeViolations = (scope: MilestoneScope, paths: ReadonlyArray<string>) => {
  const files = Array.from(new Set(paths.map(normalizePath))).filter((file) => file.length > 0);
  const avoided = files.filter((file) => scope.avoid.some((pattern) => pathMatches(file, pattern)));
  const outside =
    scope.paths.length === 0
      ? []
      : files.filter(
          (file) =>
            !avoided.includes(file) && !scope.paths.some((pattern) => pathMatches(file, pattern)),
        );
  return { outside, avoided };
};

const MANIFESTS = new Set([
  "package.json",
  "requirements.txt",
  "pyproject.toml",
  "go.mod",
  "Cargo.toml",
  "Gemfile",
  "composer.json",
]);

export const isManifest = (path: string) => MANIFESTS.has(path.split("/").pop() ?? "");

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

const parseJsonObject = (text: string | null): Record<string, unknown> | null => {
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

const jsonDependencies = (manifest: Record<string, unknown> | null) => {
  const names = new Set<string>();
  for (const field of DEPENDENCY_FIELDS) {
    const block = manifest?.[field];
    if (block !== null && typeof block === "object") {
      for (const name of Object.keys(block as object)) names.add(name);
    }
  }
  return names;
};

const lineDependencies = (text: string | null) =>
  new Set(
    (text ?? "")
      .split("\n")
      .map((line) => line.replace(/#.*$/, "").trim())
      .filter((line) => line.length > 0 && !line.startsWith("[") && !/^(module|go) /.test(line))
      .map((line) => line.split(/[\s=<>~!;@]/)[0]!)
      .filter((name) => name.length > 0 && name !== "require" && name !== ")"),
  );

/** Dependencies a manifest gained between `before` (HEAD, null if new) and `after`. */
export const addedDependencies = (
  path: string,
  before: string | null,
  after: string | null,
): ReadonlyArray<string> => {
  if (after === null) return [];
  const json = path.endsWith(".json");
  const had = json ? jsonDependencies(parseJsonObject(before)) : lineDependencies(before);
  const has = json ? jsonDependencies(parseJsonObject(after)) : lineDependencies(after);
  return Array.from(has).filter((name) => !had.has(name));
};

export interface DriftFinding {
  readonly kind: DriftKind;
  readonly summary: string;
  readonly detail: ReadonlyArray<string>;
}

const list = (items: ReadonlyArray<string>, max = 3) =>
  items.length <= max
    ? items.join(", ")
    : `${items.slice(0, max).join(", ")} and ${items.length - max} more`;

/**
 * The cheap checks on what an assignee's thread did: files outside the scope,
 * avoided paths, the branch, new dependencies, the due date.
 */
export const checkMilestone = (input: {
  readonly milestone: Milestone;
  readonly files: ReadonlyArray<string>;
  readonly branch: string | null;
  readonly dependencies: ReadonlyArray<{
    readonly path: string;
    readonly added: ReadonlyArray<string>;
  }>;
  readonly nowMs: number;
}): ReadonlyArray<DriftFinding> => {
  const { milestone } = input;
  const findings: DriftFinding[] = [];
  const who = milestone.assignee.name;
  const { outside, avoided } = scopeViolations(milestone.scope, input.files);
  if (avoided.length > 0) {
    findings.push({
      kind: "avoided_path",
      summary: `${who}'s agent changed ${list(avoided)}, which the milestone says not to touch (${list(milestone.scope.avoid)}).`,
      detail: avoided,
    });
  }
  if (outside.length > 0) {
    findings.push({
      kind: "outside_scope",
      summary: `${who}'s agent changed ${list(outside)}, outside the milestone's scope (${list(milestone.scope.paths)}).`,
      detail: outside,
    });
  }
  if (
    milestone.scope.branch !== null &&
    input.branch !== null &&
    input.branch !== milestone.scope.branch
  ) {
    findings.push({
      kind: "wrong_branch",
      summary: `${who} is working on ${input.branch}, not ${milestone.scope.branch}.`,
      detail: [input.branch],
    });
  }
  if (!milestone.scope.newDependencies) {
    const added = input.dependencies.flatMap((entry) =>
      entry.added.map((name) => `${name} (${entry.path})`),
    );
    if (added.length > 0) {
      findings.push({
        kind: "new_dependency",
        summary: `${who}'s agent added ${added.length === 1 ? "a dependency" : "dependencies"}: ${list(added)}. The milestone allows none.`,
        detail: added,
      });
    }
  }
  const overdue = overdueFinding(milestone, input.nowMs);
  if (overdue !== null) findings.push(overdue);
  return findings;
};

const OPEN_STATUSES = new Set<MilestoneStatus>([
  "pending",
  "sent",
  "in_progress",
  "blocked",
  "changes_requested",
]);

export const isOpenMilestone = (milestone: Milestone) => OPEN_STATUSES.has(milestone.status);

export const overdueFinding = (milestone: Milestone, nowMs: number): DriftFinding | null =>
  milestone.dueAtMs !== null && nowMs > milestone.dueAtMs && isOpenMilestone(milestone)
    ? {
        kind: "overdue",
        summary: `"${milestone.title}" was due ${new Date(milestone.dueAtMs).toISOString().slice(0, 10)} and is not done.`,
        detail: [new Date(milestone.dueAtMs).toISOString()],
      }
    : null;

/** A finding is new unless the same kind and evidence was already raised for the milestone. */
const sameFinding = (request: GoalDecision, milestoneId: string, finding: DriftFinding) =>
  request.kind === "goal.drift" &&
  request.subject.milestoneId === milestoneId &&
  request.reason === finding.kind &&
  finding.detail.every((item) => request.detail.includes(item));

/** "Omar edited api/ (not in this milestone)": what the dialog's title says after "Outside the guardrails:". */
export const driftHeadline = (who: string, kind: DriftKind, detail: ReadonlyArray<string>) => {
  const first = firstName(who);
  const paths = detail.slice(0, 2).join(", ");
  switch (kind) {
    case "avoided_path":
      return `${first} edited ${paths} (off limits for this milestone)`;
    case "outside_scope":
      return `${first} edited ${paths} (not in this milestone)`;
    case "wrong_branch":
      return `${first} is on ${detail[0] ?? "another branch"} (not the milestone's branch)`;
    case "new_dependency":
      return `${first} added ${paths} (no new dependencies allowed)`;
    case "overdue":
      return `${first}'s milestone is past its due date`;
    case "judgment":
      return `${first}'s last turn went beyond the milestone`;
  }
};

export const addFindings = (
  goal: Goal,
  milestone: Milestone,
  findings: ReadonlyArray<DriftFinding>,
  input: {
    readonly nowMs: number;
    readonly newId: () => string;
    readonly source?: "check" | "judgment";
  },
): { readonly goal: Goal; readonly added: ReadonlyArray<GoalDecision> } => {
  const fresh = findings.filter(
    (finding) => !goal.decisions.some((entry) => sameFinding(entry, milestone.id, finding)),
  );
  if (fresh.length === 0) return { goal, added: [] };
  const added = fresh.map((finding): GoalDecision => {
    const source = input.source ?? (finding.kind === "judgment" ? "judgment" : "check");
    const detail = finding.detail.slice(0, 12).map((line) => clip(line, 200));
    return {
      id: input.newId(),
      projectId: goal.projectId,
      kind: "goal.drift",
      sourceId: milestone.id,
      subject: subjectOf(goal, milestone),
      presentation: "dialog",
      title: `Outside the guardrails: ${driftHeadline(milestone.assignee.name, finding.kind, detail)}`,
      summary: clip(finding.summary, 400),
      detail,
      reason: finding.kind,
      source,
      requester: { id: null, name: source === "judgment" ? "AI check" : "LogicPacks checks" },
      approvers: [goal.ownerId],
      actions:
        milestone.threadId === null
          ? DRIFT_ACTIONS.filter((action) => action.id !== "message" && action.id !== "watch")
          : DRIFT_ACTIONS,
      status: "open",
      resolution: null,
      createdAtMs: input.nowMs,
      updatedAtMs: input.nowMs,
    };
  });
  return {
    goal: touch(
      withDecisions(goal, [...goal.decisions, ...added]),
      input.nowMs,
      "LogicPacks",
      `Off plan: ${added.map((entry) => entry.summary).join(" ")}`,
    ),
    added,
  };
};

// ── The optional model judgment at turn end ─────────────────────────────────

export const JUDGE_MIN_INTERVAL_MS = 10 * 60_000;

/** At most one judgment per milestone per interval. */
export const judgeAllowed = (lastAtMs: number | undefined, nowMs: number) =>
  lastAtMs === undefined || nowMs - lastAtMs >= JUDGE_MIN_INTERVAL_MS;

export const judgePrompt = (input: {
  readonly goal: Goal;
  readonly milestone: Milestone;
  readonly files: ReadonlyArray<string>;
  readonly lastReply: string;
}) =>
  [
    `Goal: ${input.goal.title}. ${input.goal.outcome}`,
    `Milestone for ${input.milestone.assignee.name}: ${input.milestone.title}`,
    `Acceptance criteria: ${input.milestone.criteria.join("; ") || "none given"}`,
    `Scope: ${scopeText(input.milestone.scope)}`,
    `Files the agent changed this turn: ${input.files.join(", ") || "none"}`,
    `The agent's last reply: ${clip(input.lastReply, 1500)}`,
  ].join("\n");

export const JUDGE_INSTRUCTIONS =
  'You are not writing a pull request. You check one turn of a teammate\'s agent against its milestone. Set "title" to exactly ON_PLAN when the turn stays within the milestone, or OFF_PLAN: <one short sentence> when it went beyond or against the milestone (other features, scope notes broken, unrelated refactors). Set "body" to one sentence of evidence.';

export const parseVerdict = (title: string, body: string): DriftFinding | null => {
  const head = title.trim();
  if (!/^OFF_PLAN/i.test(head)) return null;
  const reason =
    head.replace(/^OFF_PLAN[:\s-]*/i, "").trim() || "The turn went beyond the milestone.";
  return {
    kind: "judgment",
    summary: clip(reason, 300),
    detail: [clip(body, 200)].filter(Boolean),
  };
};

// ── What agents read ──────────────────────────────────────────────────────

export const scopeText = (scope: MilestoneScope) => {
  const parts: string[] = [];
  if (scope.paths.length > 0) parts.push(`only ${scope.paths.join(", ")}`);
  if (scope.avoid.length > 0) parts.push(`do not touch ${scope.avoid.join(", ")}`);
  if (scope.branch !== null) parts.push(`branch ${scope.branch}`);
  if (!scope.newDependencies) parts.push("no new dependencies");
  for (const note of scope.notes) parts.push(note);
  return parts.length === 0 ? "anywhere" : parts.join("; ");
};

const dueText = (dueAtMs: number | null) =>
  dueAtMs === null ? null : new Date(dueAtMs).toISOString().slice(0, 10);

/** The structured task delivered to an assignee's thread. */
export const taskText = (goal: Goal, milestone: Milestone) =>
  [
    `Goal "${goal.title}" from ${goal.ownerName}: your milestone ${milestone.id}`,
    `Task: ${milestone.title}`,
    ...(goal.outcome ? [`Outcome: ${goal.outcome}`] : []),
    ...(milestone.criteria.length > 0
      ? ["Done when:", ...milestone.criteria.map((criterion) => `- ${criterion}`)]
      : []),
    `Scope: ${scopeText(milestone.scope)}`,
    ...(milestone.dueAtMs === null ? [] : [`Due: ${dueText(milestone.dueAtMs)}`]),
  ].join("\n");

export const describeMilestone = (milestone: Milestone) =>
  `milestone ${milestone.id} "${milestone.title}" for ${milestone.assignee.name} (${milestone.status})${
    milestone.dueAtMs === null ? "" : `, due ${dueText(milestone.dueAtMs)}`
  }`;

export const describeGoal = (goal: Goal) => {
  const done = progress(goal);
  return [
    `Goal ${goal.id} "${goal.title}" (${goal.state}, ${done.approved}/${done.total} approved) by ${goal.ownerName}${goal.outcome ? `: ${goal.outcome}` : ""}`,
    ...goal.milestones.map(
      (milestone) =>
        `- ${describeMilestone(milestone)}; criteria: ${milestone.criteria.join("; ") || "none"}; scope: ${scopeText(milestone.scope)}`,
    ),
  ].join("\n");
};

/**
 * Lines for a thread's next turn: its milestones (goal, criteria, scope, due,
 * open drift, a review note) and the drafts it planned that wait for a person.
 */
export const goalTurnLines = (
  goals: ReadonlyArray<Goal>,
  threadId: string,
): ReadonlyArray<string> => {
  const lines: string[] = [];
  for (const goal of goals) {
    if (goal.state === "draft" && goal.plannedInThreadId === threadId) {
      lines.push(
        `Draft goal ${goal.id} "${goal.title}" waits for ${goal.ownerName} to review and confirm it in Goals; revise it with lp_project_goal_plan and goalId "${goal.id}".`,
      );
    }
    if (goal.state !== "active") continue;
    for (const milestone of goal.milestones) {
      if (milestone.threadId !== threadId || !isOpenMilestone(milestone)) continue;
      lines.push(
        `Your milestone ${milestone.id} of goal "${goal.title}" from ${goal.ownerName}: ${milestone.title}. Done when: ${milestone.criteria.join("; ") || "the task is done"}. Scope: ${scopeText(milestone.scope)}.${milestone.dueAtMs === null ? "" : ` Due ${dueText(milestone.dueAtMs)}.`} Status: ${milestone.status}. Stay inside the scope; report with lp_project_goal_update (status in_progress, blocked or done with a note and each criterion met or not).`,
      );
      if (milestone.status === "changes_requested" && milestone.review !== null) {
        lines.push(`${milestone.review.by} sent it back: "${clip(milestone.review.note, 300)}"`);
      }
      for (const request of goal.decisions) {
        if (
          request.kind === "goal.drift" &&
          request.subject.milestoneId === milestone.id &&
          isOpen(request)
        ) {
          lines.push(`Off plan (the host was told): ${request.summary}`);
        }
      }
    }
  }
  return lines;
};
