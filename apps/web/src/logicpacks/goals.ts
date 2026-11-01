import { useEffect } from "react";
import { create } from "zustand";

import { lpRequest } from "./api";

/**
 * Goals (Beta), "Delegate with guardrails": the shapes the server sends
 * (apps/server/src/logicpacks/goals.ts), the API, a polled store per project,
 * and the plain helpers the cards, the panel and the drift dialog share.
 */

export type LpGoalState = "draft" | "active" | "done" | "cancelled";
export type LpMilestoneStatus =
  | "pending"
  | "sent"
  | "in_progress"
  | "blocked"
  | "done"
  | "approved"
  | "changes_requested";

export interface LpGoalAssignee {
  readonly kind: "member" | "expert" | "host" | "unknown";
  readonly userId: string | null;
  readonly name: string;
  readonly expertId: string | null;
}

export interface LpGuardrails {
  readonly paths: ReadonlyArray<string>;
  readonly avoid: ReadonlyArray<string>;
  readonly branch: string | null;
  readonly newDependencies: boolean;
  readonly notes: ReadonlyArray<string>;
}

export interface LpMilestone {
  readonly id: string;
  readonly title: string;
  readonly assignee: LpGoalAssignee;
  readonly criteria: ReadonlyArray<string>;
  readonly scope: LpGuardrails;
  readonly dueAtMs: number | null;
  readonly status: LpMilestoneStatus;
  readonly threadId: string | null;
  readonly deliveredAtMs: number | null;
  readonly doneNote: string | null;
  readonly report: ReadonlyArray<{
    readonly criterion: string;
    readonly met: boolean;
    readonly evidence: string;
  }>;
  readonly review: {
    readonly verdict: "approved" | "changes";
    readonly note: string;
    readonly by: string;
    readonly atMs: number;
  } | null;
  readonly updatedAtMs: number;
}

/**
 * A decision request (server: decisionRequests.ts): drift and reviews now, merges,
 * spend and outside access later. The dialog and cards render this record and its
 * actions; nothing in the UI is written per kind.
 */
export interface LpDecisionAction {
  readonly id: string;
  readonly label: string;
  readonly needsNote: boolean;
  readonly tone: "primary" | "default" | "quiet";
  /** Done in the app (open their thread), never posted. */
  readonly inApp?: "watch" | undefined;
}

export interface LpDecision {
  readonly id: string;
  readonly projectId: string;
  readonly kind: string;
  readonly sourceId: string;
  readonly subject: {
    readonly type: "milestone";
    readonly goalId: string;
    readonly milestoneId: string;
    readonly threadId: string | null;
    readonly title: string;
    readonly who: { readonly id: string | null; readonly name: string };
  };
  readonly presentation: "dialog" | "card";
  readonly title: string;
  readonly summary: string;
  readonly detail: ReadonlyArray<string>;
  readonly reason: string | null;
  readonly source: "check" | "judgment" | "person";
  readonly requester: { readonly id: string | null; readonly name: string };
  readonly approvers: ReadonlyArray<string>;
  readonly actions: ReadonlyArray<LpDecisionAction>;
  readonly status: "open" | "resolved";
  readonly resolution: {
    readonly action: string;
    readonly by: string;
    readonly note: string;
    readonly atMs: number;
  } | null;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface LpGoal {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly outcome: string;
  readonly ownerId: string;
  readonly ownerName: string;
  readonly plannedInThreadId: string | null;
  readonly state: LpGoalState;
  readonly milestones: ReadonlyArray<LpMilestone>;
  readonly decisions: ReadonlyArray<LpDecision>;
  readonly log: ReadonlyArray<{
    readonly atMs: number;
    readonly by: string;
    readonly text: string;
  }>;
  readonly judge: boolean;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly confirmedAtMs: number | null;
  readonly progress: {
    readonly total: number;
    readonly approved: number;
    readonly awaitingReview: number;
    readonly percent: number;
  };
  readonly viewer: { readonly canManage: boolean; readonly participantId: string };
}

export interface LpGoalsView {
  readonly projectId: string;
  readonly viewer: {
    readonly participantId: string;
    readonly isHost: boolean;
    readonly name: string;
  };
  readonly goals: ReadonlyArray<LpGoal>;
}

export interface LpGoalPerson {
  readonly kind: "member" | "expert" | "host";
  readonly userId: string | null;
  readonly name: string;
  readonly expertId: string | null;
}

/** The plan the server reads (GoalPlan): what the editor sends. */
export interface LpGoalPlan {
  readonly title: string;
  readonly outcome?: string;
  readonly milestones: ReadonlyArray<{
    readonly id?: string;
    readonly title: string;
    readonly assignee: string;
    readonly criteria?: ReadonlyArray<string>;
    readonly scope?: {
      readonly paths?: ReadonlyArray<string>;
      readonly avoid?: ReadonlyArray<string>;
      readonly branch?: string | null;
      readonly newDependencies?: boolean;
      readonly notes?: ReadonlyArray<string>;
    };
    readonly due?: string | null;
  }>;
}

type GoalResult = { readonly goal: LpGoal };

export const goalsApi = {
  list: (projectId: string) =>
    lpRequest<LpGoalsView>(`/api/lp/goals?projectId=${encodeURIComponent(projectId)}`),
  people: (projectId: string) =>
    lpRequest<{ people: ReadonlyArray<LpGoalPerson> }>(
      `/api/lp/goals/people?projectId=${encodeURIComponent(projectId)}`,
    ),
  create: (input: { projectId: string; threadId: string | null; plan: LpGoalPlan }) =>
    lpRequest<GoalResult>("/api/lp/goals/create", input),
  edit: (input: { goalId: string; plan?: LpGoalPlan; judge?: boolean }) =>
    lpRequest<GoalResult>("/api/lp/goals/edit", input),
  confirm: (goalId: string) => lpRequest<GoalResult>("/api/lp/goals/confirm", { goalId }),
  cancel: (goalId: string) => lpRequest<GoalResult>("/api/lp/goals/cancel", { goalId }),
  milestone: (input: {
    goalId: string;
    milestoneId: string;
    status: "in_progress" | "blocked" | "done";
    note?: string;
  }) => lpRequest<GoalResult>("/api/lp/goals/milestone", input),
  /** Answers any decision request with one of its actions. */
  decide: (input: { goalId: string; decisionId: string; action: string; note?: string }) =>
    lpRequest<GoalResult>("/api/lp/goals/decide", input),
};

// ── Store ─────────────────────────────────────────────────────────────────

interface GoalsStoreState {
  readonly byProject: Readonly<Record<string, LpGoalsView>>;
}

const useGoalsStore = create<GoalsStoreState>(() => ({ byProject: {} }));

export async function refreshGoals(projectId: string): Promise<void> {
  const view = await goalsApi.list(projectId).catch(() => undefined);
  if (view === undefined) return;
  useGoalsStore.setState((state) => ({ byProject: { ...state.byProject, [projectId]: view } }));
}

/** Puts a goal the server just returned into the store, so the UI moves at once. */
export function storeGoal(goal: LpGoal) {
  useGoalsStore.setState((state) => {
    const view = state.byProject[goal.projectId];
    if (view === undefined) return state;
    const known = view.goals.some((candidate) => candidate.id === goal.id);
    return {
      byProject: {
        ...state.byProject,
        [goal.projectId]: {
          ...view,
          goals: known
            ? view.goals.map((candidate) => (candidate.id === goal.id ? goal : candidate))
            : [...view.goals, goal],
        },
      },
    };
  });
}

const POLL_MS = 3_000;

/** A project's goals, polled while the tab is visible (one small JSON read). */
export function useProjectGoals(projectId: string | null): LpGoalsView | null {
  // oxlint-disable-next-line logicpacks/no-unreasoned-state-sync -- polls the server's goals for the open project, like the ledger
  useEffect(() => {
    if (projectId === null) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const loop = async () => {
      if (stopped) return;
      if (typeof document === "undefined" || document.visibilityState !== "hidden") {
        await refreshGoals(projectId);
      }
      if (!stopped) timer = setTimeout(() => void loop(), POLL_MS);
    };
    void loop();
    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [projectId]);
  return useGoalsStore((state) =>
    projectId === null ? null : (state.byProject[projectId] ?? null),
  );
}

// ── Panel and watch state, shared by the tray button, cards and the dialog ──

interface GoalsUiState {
  readonly panelOpen: boolean;
  readonly goalId: string | null;
  /** "new" opens the hand-made goal editor. */
  readonly composing: boolean;
  readonly watching: { readonly threadId: string; readonly name: string } | null;
  /** Requests the host closed without deciding, this tab only; they stay on the goal. */
  readonly laterIds: ReadonlyArray<string>;
}

export const useGoalsUi = create<GoalsUiState>(() => ({
  panelOpen: false,
  goalId: null,
  composing: false,
  watching: null,
  laterIds: [],
}));

export const openGoalsPanel = (goalId: string | null = null) =>
  useGoalsUi.setState({ panelOpen: true, goalId, composing: false });
export const composeGoal = () =>
  useGoalsUi.setState({ panelOpen: true, goalId: null, composing: true });
export const closeGoalsPanel = () => useGoalsUi.setState({ panelOpen: false, composing: false });
export const watchThread = (threadId: string, name: string) =>
  useGoalsUi.setState({ watching: { threadId, name } });
export const stopWatching = () => useGoalsUi.setState({ watching: null });
export const decideLater = (decisionId: string) =>
  useGoalsUi.setState((state) => ({ laterIds: [...state.laterIds, decisionId] }));

// ── Plain helpers ─────────────────────────────────────────────────────────

const OPEN = new Set<LpMilestoneStatus>([
  "pending",
  "sent",
  "in_progress",
  "blocked",
  "changes_requested",
]);

export const isOpenMilestone = (milestone: LpMilestone) => OPEN.has(milestone.status);

export const STATUS_LABEL: Record<LpMilestoneStatus, string> = {
  pending: "Waiting to send",
  sent: "Sent",
  in_progress: "In progress",
  blocked: "Blocked",
  done: "Ready for review",
  approved: "Approved",
  changes_requested: "Sent back",
};

export const GOAL_STATE_LABEL: Record<LpGoalState, string> = {
  draft: "Draft",
  active: "Active",
  done: "Done",
  cancelled: "Closed",
};

export interface PendingDecision {
  readonly goal: LpGoal;
  readonly request: LpDecision;
  readonly milestone: LpMilestone | undefined;
}

export interface GoalAttention {
  /** Open requests this viewer decides that interrupt (drift), oldest first. */
  readonly dialogs: ReadonlyArray<PendingDecision>;
  /** Open requests this viewer decides shown as cards (reviews), oldest first. */
  readonly cards: ReadonlyArray<PendingDecision>;
  /** Drafts this viewer can confirm. */
  readonly drafts: ReadonlyArray<LpGoal>;
}

/** The host, the goal's owner, or a named approver; the server checks again. */
export const canDecide = (goal: LpGoal, request: LpDecision) =>
  goal.viewer.canManage || request.approvers.includes(goal.viewer.participantId);

export const openDecisions = (goal: LpGoal) =>
  goal.decisions.filter((request) => request.status === "open");

/** The open request of a kind about one milestone (its review, say). */
export const decisionFor = (goal: LpGoal, kind: string, milestoneId: string) =>
  openDecisions(goal).find(
    (request) => request.kind === kind && request.subject.milestoneId === milestoneId,
  );

export function goalAttention(goals: ReadonlyArray<LpGoal>): GoalAttention {
  const pending = goals
    .filter((goal) => goal.state === "active")
    .flatMap((goal) =>
      openDecisions(goal)
        .filter((request) => canDecide(goal, request))
        .map((request) => ({
          goal,
          request,
          milestone: goal.milestones.find((m) => m.id === request.subject.milestoneId),
        })),
    )
    .sort((a, b) => a.request.createdAtMs - b.request.createdAtMs);
  return {
    dialogs: pending.filter((entry) => entry.request.presentation === "dialog"),
    cards: pending.filter((entry) => entry.request.presentation === "card"),
    drafts: goals.filter((goal) => goal.viewer.canManage && goal.state === "draft"),
  };
}

/** "Messaged", "Approved": a resolved request's action, by its own label. */
export const resolutionLabel = (request: LpDecision) => {
  if (request.resolution === null) return request.source === "judgment" ? "AI check" : "Open";
  const action = request.actions.find((entry) => entry.id === request.resolution!.action);
  return PAST[request.resolution.action] ?? action?.label ?? request.resolution.action;
};

const PAST: Record<string, string> = {
  message: "Messaged",
  accept: "Accepted",
  ignore: "Ignored",
  approve: "Approved",
  changes: "Sent back",
};

/** Milestones this thread works on (the assignee's side). */
export function tasksForThread(goals: ReadonlyArray<LpGoal>, threadId: string) {
  return goals
    .filter((goal) => goal.state === "active")
    .flatMap((goal) =>
      goal.milestones
        .filter((milestone) => milestone.threadId === threadId && milestone.status !== "approved")
        .map((milestone) => ({ goal, milestone })),
    );
}

/** The milestone a thread works on, for the "who's working" rows. */
export function milestoneOfThread(goals: ReadonlyArray<LpGoal>, threadId: string) {
  return tasksForThread(goals, threadId).find(({ milestone }) => isOpenMilestone(milestone));
}

export function guardrailsText(scope: LpGuardrails): ReadonlyArray<string> {
  const lines: string[] = [];
  if (scope.paths.length > 0) lines.push(`Only ${scope.paths.join(", ")}`);
  if (scope.avoid.length > 0) lines.push(`Not ${scope.avoid.join(", ")}`);
  if (scope.branch !== null) lines.push(`Branch ${scope.branch}`);
  lines.push(scope.newDependencies ? "New dependencies allowed" : "No new dependencies");
  for (const note of scope.notes) lines.push(note);
  return lines;
}

export const formatDue = (dueAtMs: number | null) =>
  dueAtMs === null
    ? null
    : new Date(dueAtMs).toLocaleDateString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
      });

/** YYYY-MM-DD in local time, for a date input. */
export const dueInputValue = (dueAtMs: number | null) => {
  if (dueAtMs === null) return "";
  const date = new Date(dueAtMs);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

// ── The editor's form ─────────────────────────────────────────────────────

export interface MilestoneForm {
  readonly id: string | null;
  readonly title: string;
  readonly assignee: string;
  readonly criteria: string;
  readonly paths: string;
  readonly avoid: string;
  readonly branch: string;
  readonly newDependencies: boolean;
  readonly notes: string;
  readonly due: string;
}

export interface GoalForm {
  readonly title: string;
  readonly outcome: string;
  readonly milestones: ReadonlyArray<MilestoneForm>;
}

export const blankMilestone = (): MilestoneForm => ({
  id: null,
  title: "",
  assignee: "",
  criteria: "",
  paths: "",
  avoid: "",
  branch: "",
  newDependencies: false,
  notes: "",
  due: "",
});

export function formFromGoal(goal: LpGoal): GoalForm {
  return {
    title: goal.title,
    outcome: goal.outcome,
    milestones: goal.milestones.map((milestone) => ({
      id: milestone.id,
      title: milestone.title,
      assignee: milestone.assignee.kind === "unknown" ? "" : milestone.assignee.name,
      criteria: milestone.criteria.join("\n"),
      paths: milestone.scope.paths.join(", "),
      avoid: milestone.scope.avoid.join(", "),
      branch: milestone.scope.branch ?? "",
      newDependencies: milestone.scope.newDependencies,
      notes: milestone.scope.notes.join("\n"),
      due: dueInputValue(milestone.dueAtMs),
    })),
  };
}

const split = (text: string, separator: RegExp) =>
  text
    .split(separator)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

export function planFromForm(form: GoalForm): LpGoalPlan {
  return {
    title: form.title.trim(),
    outcome: form.outcome.trim(),
    milestones: form.milestones.map((milestone) => ({
      ...(milestone.id === null ? {} : { id: milestone.id }),
      title: milestone.title.trim(),
      assignee: milestone.assignee.trim(),
      criteria: split(milestone.criteria, /\n/),
      scope: {
        paths: split(milestone.paths, /[,\n]/),
        avoid: split(milestone.avoid, /[,\n]/),
        branch: milestone.branch.trim() || null,
        newDependencies: milestone.newDependencies,
        notes: split(milestone.notes, /\n/),
      },
      due: milestone.due.trim() || null,
    })),
  };
}

/** What stops the form from being sent, in words, or null. */
export function formProblem(form: GoalForm): string | null {
  if (form.title.trim().length === 0) return "Give the goal a title.";
  if (form.milestones.length === 0) return "Add a milestone.";
  const untitled = form.milestones.findIndex((milestone) => milestone.title.trim().length === 0);
  if (untitled >= 0) return `Milestone ${untitled + 1} needs a title.`;
  const nobody = form.milestones.findIndex((milestone) => milestone.assignee.trim().length === 0);
  if (nobody >= 0) return `Pick who does milestone ${nobody + 1}.`;
  return null;
}
