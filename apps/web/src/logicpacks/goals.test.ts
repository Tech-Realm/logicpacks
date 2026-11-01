import { describe, expect, it } from "vite-plus/test";

import {
  decisionFor,
  formFromGoal,
  formProblem,
  goalAttention,
  milestoneOfThread,
  planFromForm,
  resolutionLabel,
  tasksForThread,
  type LpGoal,
  type LpDecision,
  type LpMilestone,
} from "./goals";

const milestone = (over: Partial<LpMilestone>): LpMilestone => ({
  id: "ms-1",
  title: "Saved cards UI",
  assignee: { kind: "member", userId: "u-omar", name: "Omar Haddad", expertId: null },
  criteria: ["Cards render"],
  scope: { paths: ["checkout/"], avoid: ["api/"], branch: null, newDependencies: false, notes: [] },
  dueAtMs: null,
  status: "sent",
  threadId: "t-omar",
  deliveredAtMs: 1,
  doneNote: null,
  report: [],
  review: null,
  updatedAtMs: 1,
  ...over,
});

const ACTIONS = {
  drift: [
    { id: "message", label: "Message", needsNote: true, tone: "primary" as const },
    {
      id: "watch",
      label: "Watch",
      needsNote: false,
      tone: "default" as const,
      inApp: "watch" as const,
    },
    { id: "accept", label: "Accept", needsNote: false, tone: "quiet" as const },
    { id: "ignore", label: "Ignore", needsNote: false, tone: "quiet" as const },
  ],
  review: [
    { id: "approve", label: "Approve", needsNote: false, tone: "primary" as const },
    { id: "changes", label: "Send back", needsNote: true, tone: "default" as const },
  ],
};

const request = (over: Partial<LpDecision>): LpDecision => ({
  id: "d-1",
  projectId: "p1",
  kind: "goal.drift",
  sourceId: "ms-1",
  subject: {
    type: "milestone",
    goalId: "g-1",
    milestoneId: "ms-1",
    threadId: "t-omar",
    title: "Saved cards UI",
    who: { id: "u-omar", name: "Omar Haddad" },
  },
  presentation: "dialog",
  title: "Outside the guardrails: Omar edited api/server.ts (off limits for this milestone)",
  summary: "Omar's agent changed api/server.ts",
  detail: ["api/server.ts"],
  reason: "avoided_path",
  source: "check",
  requester: { id: null, name: "LogicPacks checks" },
  approvers: ["u-ana"],
  actions: ACTIONS.drift,
  status: "open",
  resolution: null,
  createdAtMs: 5,
  updatedAtMs: 5,
  ...over,
});

const review = request({
  id: "r-1",
  kind: "goal.review",
  sourceId: "ms-2",
  presentation: "card",
  subject: {
    type: "milestone",
    goalId: "g-1",
    milestoneId: "ms-2",
    threadId: "t-priya",
    title: "Tests",
    who: { id: "u-priya", name: "Priya" },
  },
  title: 'Priya marked "Tests" done',
  reason: null,
  source: "person",
  actions: ACTIONS.review,
  createdAtMs: 6,
});

const goal = (over: Partial<LpGoal>): LpGoal => ({
  id: "g-1",
  projectId: "p1",
  title: "Checkout v2",
  outcome: "",
  ownerId: "u-ana",
  ownerName: "Ana",
  plannedInThreadId: "t-ana",
  state: "active",
  milestones: [
    milestone({}),
    milestone({
      id: "ms-2",
      title: "Tests",
      assignee: { kind: "member", userId: "u-priya", name: "Priya", expertId: null },
      threadId: "t-priya",
      status: "done",
    }),
  ],
  decisions: [request({}), review],
  log: [],
  judge: false,
  createdAtMs: 0,
  updatedAtMs: 0,
  confirmedAtMs: 0,
  progress: { total: 2, approved: 0, awaitingReview: 1, percent: 0 },
  viewer: { canManage: true, participantId: "u-ana" },
  ...over,
});

describe("goal attention", () => {
  it("routes open requests by presentation to whoever may decide; nothing to others", () => {
    const attention = goalAttention([goal({}), goal({ id: "g-2", state: "draft", decisions: [] })]);
    expect(attention.dialogs.map((entry) => entry.request.id)).toEqual(["d-1"]);
    expect(attention.dialogs[0]!.milestone?.id).toBe("ms-1");
    expect(attention.cards.map((entry) => entry.request.id)).toEqual(["r-1"]);
    expect(attention.drafts.map((entry) => entry.id)).toEqual(["g-2"]);
    const other = goalAttention([goal({ viewer: { canManage: false, participantId: "u-omar" } })]);
    expect(other).toEqual({ dialogs: [], cards: [], drafts: [] });
    // A named approver decides without managing the goal.
    const approver = goalAttention([
      goal({ viewer: { canManage: false, participantId: "u-ana" } }),
    ]);
    expect(approver.dialogs).toHaveLength(1);
    const resolved = request({
      status: "resolved",
      resolution: { action: "accept", by: "Ana", note: "", atMs: 9 },
    });
    expect(goalAttention([goal({ decisions: [resolved] })]).dialogs).toEqual([]);
    expect(resolutionLabel(resolved)).toBe("Accepted");
    expect(resolutionLabel(request({ source: "judgment" }))).toBe("AI check");
  });

  it("finds a milestone's review and the tasks of a thread", () => {
    expect(decisionFor(goal({}), "goal.review", "ms-2")?.id).toBe("r-1");
    expect(decisionFor(goal({}), "goal.review", "ms-1")).toBeUndefined();
    expect(tasksForThread([goal({})], "t-omar").map((t) => t.milestone.id)).toEqual(["ms-1"]);
    expect(milestoneOfThread([goal({})], "t-priya")).toBeUndefined();
    expect(tasksForThread([goal({ state: "draft" })], "t-omar")).toEqual([]);
  });
});

describe("editor form", () => {
  it("round-trips a goal into the plan the server reads", () => {
    const form = formFromGoal(goal({}));
    expect(formProblem(form)).toBeNull();
    const plan = planFromForm({
      ...form,
      milestones: [
        { ...form.milestones[0]!, paths: "checkout/, ui/cards", notes: "keep the API\n" },
      ],
    });
    expect(plan.milestones[0]).toMatchObject({
      id: "ms-1",
      assignee: "Omar Haddad",
      criteria: ["Cards render"],
      scope: {
        paths: ["checkout/", "ui/cards"],
        avoid: ["api/"],
        notes: ["keep the API"],
        branch: null,
      },
      due: null,
    });
  });

  it("names what is missing", () => {
    const form = formFromGoal(goal({}));
    expect(formProblem({ ...form, title: " " })).toBe("Give the goal a title.");
    expect(formProblem({ ...form, milestones: [{ ...form.milestones[0]!, assignee: "" }] })).toBe(
      "Pick who does milestone 1.",
    );
  });
});
