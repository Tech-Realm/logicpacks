// @effect-diagnostics globalDate:off -- due dates are local calendar days.
import * as Exit from "effect/Exit";
import { describe, expect, it } from "@effect/vitest";

import {
  addedDependencies,
  addFindings,
  canManage,
  canUpdateMilestone,
  checkMilestone,
  confirmGoal,
  decodeGoalPlan,
  draftGoal,
  editDraft,
  goalTurnLines,
  GoalRuleError,
  judgeAllowed,
  JUDGE_MIN_INTERVAL_MS,
  markDelivered,
  parseDue,
  parseVerdict,
  pathMatches,
  progress,
  resolveDrift,
  reviewMilestone,
  scopeViolations,
  updateMilestone,
  type Goal,
  type GoalActor,
  type GoalCandidate,
  type GoalPlan,
} from "./goals.ts";

// Sunday 1 Nov 2026, 10:00 local.
const NOW = new Date(2026, 10, 1, 10, 0, 0).getTime();
const DAY = 24 * 60 * 60_000;

const people: ReadonlyArray<GoalCandidate> = [
  { kind: "member", userId: "u-ana", name: "Ana Ruiz", expertId: null },
  { kind: "member", userId: "u-omar", name: "Omar Haddad", expertId: null },
  { kind: "member", userId: "u-priya", name: "Priya", expertId: null },
  { kind: "expert", userId: null, name: "Ingrid Solberg", expertId: "ingrid-solberg" },
];

const ana: GoalActor = { id: "u-ana", name: "Ana Ruiz", isHost: false, threadId: null };
const host: GoalActor = { id: "host", name: "Host", isHost: true, threadId: null };
const omar: GoalActor = { id: "u-omar", name: "Omar Haddad", isHost: false, threadId: null };
const priya: GoalActor = { id: "u-priya", name: "Priya", isHost: false, threadId: null };
const omarAgent: GoalActor = { ...omar, name: "Omar's agent", threadId: "t-omar" };
const anaAgent: GoalActor = { ...ana, name: "Ana's agent", threadId: "t-ana" };

const plan: GoalPlan = {
  title: "Ship checkout v2",
  outcome: "Customers can pay with saved cards",
  milestones: [
    {
      title: "Saved cards UI",
      assignee: "Omar",
      criteria: ["Cards list renders", "Tests pass"],
      scope: { paths: ["checkout/"], avoid: ["api/"], notes: ["don't change the API"] },
      due: "friday",
    },
    { title: "Checkout tests", assignee: "priya", criteria: ["E2E covers saved cards"] },
  ],
};

let counter = 0;
const newId = () => `id-${(counter += 1)}`;

const draft = (): Goal =>
  draftGoal({
    id: "goal-1",
    projectId: "p1",
    plan,
    owner: { id: "u-ana", name: "Ana Ruiz" },
    plannedInThreadId: "t-ana",
    candidates: people,
    nowMs: NOW,
    newId,
    by: "Ana's agent",
  });

const refused = (run: () => unknown, reason: GoalRuleError["reason"]) => {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(GoalRuleError);
    expect((error as GoalRuleError).reason).toBe(reason);
    return (error as GoalRuleError).message;
  }
  throw new Error("expected a refusal");
};

/** A confirmed goal with both milestones in their owners' threads. */
const active = () => {
  let goal = confirmGoal(draft(), ana, NOW);
  goal = markDelivered(goal, goal.milestones[0]!.id, "t-omar", NOW);
  return markDelivered(goal, goal.milestones[1]!.id, "t-priya", NOW);
};

describe("goal plan schema (the plan tool's input)", () => {
  it("accepts a plan with assignees, criteria, scope and due", () => {
    const decoded = decodeGoalPlan(plan);
    expect(Exit.isSuccess(decoded)).toBe(true);
  });

  it("rejects a plan without milestones or with a bad field", () => {
    expect(Exit.isSuccess(decodeGoalPlan({ title: "x" }))).toBe(false);
    expect(
      Exit.isSuccess(decodeGoalPlan({ title: "x", milestones: [{ title: "a", assignee: 3 }] })),
    ).toBe(false);
    expect(
      Exit.isSuccess(
        decodeGoalPlan({
          title: "x",
          milestones: Array.from({ length: 13 }, () => ({ title: "a", assignee: "Omar" })),
        }),
      ),
    ).toBe(false);
  });
});

describe("drafts", () => {
  it("resolves assignees by first name, members before experts, and parses due words", () => {
    const goal = draft();
    expect(goal.state).toBe("draft");
    expect(goal.milestones.map((m) => [m.assignee.userId, m.assignee.kind])).toEqual([
      ["u-omar", "member"],
      ["u-priya", "member"],
    ]);
    // Friday after Sunday 1 Nov is 6 Nov, end of day.
    expect(goal.milestones[0]!.dueAtMs).toBe(new Date(2026, 10, 6, 23, 59, 59).getTime());
    expect(goal.milestones[0]!.scope).toMatchObject({
      paths: ["checkout/"],
      avoid: ["api/"],
      newDependencies: false,
      notes: ["don't change the API"],
    });
  });

  it("marks unknown names and refuses to confirm until someone is picked", () => {
    const goal = draftGoal({
      id: "g",
      projectId: "p1",
      plan: { title: "T", milestones: [{ title: "Logo", assignee: "Zed" }] },
      owner: { id: "u-ana", name: "Ana" },
      plannedInThreadId: null,
      candidates: people,
      nowMs: NOW,
      newId,
      by: "Ana",
    });
    expect(goal.milestones[0]!.assignee.kind).toBe("unknown");
    expect(refused(() => confirmGoal(goal, ana, NOW), "invalid")).toMatch(/Zed/);
  });

  it("reads an expert from the catalog when no member matches", () => {
    const goal = draftGoal({
      id: "g",
      projectId: "p1",
      plan: { title: "T", milestones: [{ title: "Light it", assignee: "Ingrid" }] },
      owner: { id: "u-ana", name: "Ana" },
      plannedInThreadId: null,
      candidates: people,
      nowMs: NOW,
      newId,
      by: "Ana",
    });
    expect(goal.milestones[0]!.assignee).toMatchObject({
      kind: "expert",
      expertId: "ingrid-solberg",
    });
  });

  it("refuses unreadable due dates and empty plans", () => {
    expect(
      refused(
        () =>
          draftGoal({
            id: "g",
            projectId: "p1",
            plan: { title: "T", milestones: [{ title: "a", assignee: "Omar", due: "soonish" }] },
            owner: { id: "u-ana", name: "Ana" },
            plannedInThreadId: null,
            candidates: people,
            nowMs: NOW,
            newId,
            by: "Ana",
          }),
        "invalid",
      ),
    ).toMatch(/due date/);
    refused(
      () =>
        draftGoal({
          id: "g",
          projectId: "p1",
          plan: { title: "T", milestones: [] },
          owner: { id: "u-ana", name: "Ana" },
          plannedInThreadId: null,
          candidates: people,
          nowMs: NOW,
          newId,
          by: "Ana",
        }),
      "invalid",
    );
  });

  it("keeps milestone ids when the draft is edited", () => {
    const goal = draft();
    const first = goal.milestones[0]!;
    const edited = editDraft(goal, ana, {
      plan: {
        ...plan,
        milestones: [{ ...plan.milestones[0]!, id: first.id, title: "Saved cards UI v2" }],
      },
      candidates: people,
      nowMs: NOW + 1,
      newId,
    });
    expect(edited.milestones).toHaveLength(1);
    expect(edited.milestones[0]!.id).toBe(first.id);
    expect(edited.milestones[0]!.title).toBe("Saved cards UI v2");
  });
});

describe("parseDue", () => {
  it("reads dates, times and words", () => {
    expect(parseDue("2026-11-06", NOW)).toBe(new Date(2026, 10, 6, 23, 59, 59).getTime());
    expect(parseDue("2026-11-06T12:00:00Z", NOW)).toBe(Date.parse("2026-11-06T12:00:00Z"));
    expect(parseDue("tomorrow", NOW)).toBe(new Date(2026, 10, 2, 23, 59, 59).getTime());
    expect(parseDue("by Sunday", NOW)).toBe(new Date(2026, 10, 1, 23, 59, 59).getTime());
    expect(parseDue("next sunday", NOW)).toBe(new Date(2026, 10, 8, 23, 59, 59).getTime());
    expect(parseDue("in 3 days", NOW)).toBe(new Date(2026, 10, 4, 23, 59, 59).getTime());
    expect(parseDue("whenever", NOW)).toBeNull();
    expect(parseDue(null, NOW)).toBeNull();
  });
});

describe("permissions", () => {
  it("only the host or the goal owner confirms, approves and resolves drift; never an agent", () => {
    const goal = draft();
    expect(canManage(goal, ana)).toBe(true);
    expect(canManage(goal, host)).toBe(true);
    expect(canManage(goal, omar)).toBe(false);
    expect(canManage(goal, anaAgent)).toBe(false);
    refused(() => confirmGoal(goal, omar, NOW), "forbidden");
    refused(() => confirmGoal(goal, anaAgent, NOW), "forbidden");
    expect(confirmGoal(goal, host, NOW).state).toBe("active");
  });

  it("assignees update only their own milestones; their agent only from the milestone's thread", () => {
    const goal = active();
    const [omarsMilestone, priyasMilestone] = goal.milestones;
    expect(canUpdateMilestone(goal, omarsMilestone!, omar)).toBe(true);
    expect(canUpdateMilestone(goal, priyasMilestone!, omar)).toBe(false);
    expect(canUpdateMilestone(goal, omarsMilestone!, omarAgent)).toBe(true);
    expect(canUpdateMilestone(goal, priyasMilestone!, omarAgent)).toBe(false);
    refused(
      () =>
        updateMilestone(goal, omar, {
          milestoneId: priyasMilestone!.id,
          status: "done",
          nowMs: NOW,
        }),
      "forbidden",
    );
    // An agent cannot approve, even its owner's.
    const done = updateMilestone(goal, priya, {
      milestoneId: priyasMilestone!.id,
      status: "done",
      nowMs: NOW,
    });
    refused(
      () =>
        reviewMilestone(done, anaAgent, {
          milestoneId: priyasMilestone!.id,
          verdict: "approve",
          nowMs: NOW,
        }),
      "forbidden",
    );
    refused(
      () =>
        reviewMilestone(done, priya, {
          milestoneId: priyasMilestone!.id,
          verdict: "approve",
          nowMs: NOW,
        }),
      "forbidden",
    );
  });

  it("only the drafting agent may revise a draft, and only while it is a draft", () => {
    const goal = draft();
    expect(() =>
      editDraft(goal, anaAgent, { plan, candidates: people, nowMs: NOW, newId }),
    ).not.toThrow();
    refused(
      () => editDraft(goal, omarAgent, { plan, candidates: people, nowMs: NOW, newId }),
      "forbidden",
    );
    const confirmed = confirmGoal(goal, ana, NOW);
    refused(
      () => editDraft(confirmed, anaAgent, { plan, candidates: people, nowMs: NOW, newId }),
      "forbidden",
    );
  });
});

describe("dispatch and review", () => {
  it("delivers, then done, review and progress", () => {
    let goal = active();
    expect(goal.milestones.map((m) => [m.status, m.threadId])).toEqual([
      ["sent", "t-omar"],
      ["sent", "t-priya"],
    ]);
    const priyas = goal.milestones[1]!;
    goal = updateMilestone(goal, priya, {
      milestoneId: priyas.id,
      status: "done",
      note: "Covered",
      report: [{ criterion: "E2E covers saved cards", met: true, evidence: "e2e/cards.spec" }],
      nowMs: NOW,
    });
    expect(goal.milestones[1]).toMatchObject({ status: "done", doneNote: "Covered" });
    expect(progress(goal)).toMatchObject({ approved: 0, awaitingReview: 1, total: 2 });
    // Done opens one review request for the owner, a card with Approve / Send back.
    const request = goal.decisions.find((entry) => entry.kind === "goal.review")!;
    expect(request).toMatchObject({
      presentation: "card",
      sourceId: priyas.id,
      requester: { name: priyas.assignee.name },
      approvers: [goal.ownerId],
      summary: "Covered",
      detail: ["Met: E2E covers saved cards (e2e/cards.spec)"],
      status: "open",
    });
    expect(request.actions.map((action) => [action.id, action.needsNote])).toEqual([
      ["approve", false],
      ["changes", true],
    ]);
    // Sending back needs a note.
    refused(
      () => reviewMilestone(goal, ana, { milestoneId: priyas.id, verdict: "changes", nowMs: NOW }),
      "invalid",
    );
    const back = reviewMilestone(goal, ana, {
      milestoneId: priyas.id,
      verdict: "changes",
      note: "Add the 3DS case",
      nowMs: NOW,
    });
    expect(back.milestones[1]!.status).toBe("changes_requested");
    expect(back.decisions.find((entry) => entry.id === request.id)).toMatchObject({
      status: "resolved",
      resolution: { action: "changes", note: "Add the 3DS case", by: "Ana Ruiz" },
    });
    expect(goalTurnLines([back], "t-priya").join("\n")).toContain("Add the 3DS case");
    goal = reviewMilestone(goal, ana, { milestoneId: priyas.id, verdict: "approve", nowMs: NOW });
    expect(progress(goal)).toMatchObject({ approved: 1, percent: 50 });
    expect(goal.state).toBe("active");
    // Approving something not marked done is refused.
    refused(
      () =>
        reviewMilestone(goal, ana, {
          milestoneId: goal.milestones[0]!.id,
          verdict: "approve",
          nowMs: NOW,
        }),
      "invalid",
    );
    goal = updateMilestone(goal, omarAgent, {
      milestoneId: goal.milestones[0]!.id,
      status: "done",
      nowMs: NOW,
    });
    goal = reviewMilestone(goal, host, {
      milestoneId: goal.milestones[0]!.id,
      verdict: "approve",
      nowMs: NOW,
    });
    expect(goal.state).toBe("done");
    expect(progress(goal).percent).toBe(100);
  });

  it("a milestone that has not reached its assignee cannot be updated", () => {
    const goal = confirmGoal(draft(), ana, NOW);
    refused(
      () =>
        updateMilestone(goal, omar, {
          milestoneId: goal.milestones[0]!.id,
          status: "in_progress",
          nowMs: NOW,
        }),
      "invalid",
    );
  });
});

describe("drift checks", () => {
  it("matches folders and globs", () => {
    expect(pathMatches("checkout/cart.ts", "checkout/")).toBe(true);
    expect(pathMatches("checkout/cart.ts", "checkout")).toBe(true);
    expect(pathMatches("checkouts/cart.ts", "checkout")).toBe(false);
    expect(pathMatches("./src/a/b.ts", "src/**/*.ts")).toBe(true);
    expect(pathMatches("src/b.ts", "src/**/*.ts")).toBe(true);
    expect(pathMatches("src/b.tsx", "src/*.ts")).toBe(false);
    expect(pathMatches("README.md", "*.md")).toBe(true);
  });

  it("flags out-of-scope and avoided paths", () => {
    const milestone = active().milestones[0]!;
    expect(
      scopeViolations(milestone.scope, ["checkout/cart.ts", "api/server.ts", "README.md"]),
    ).toEqual({ outside: ["README.md"], avoided: ["api/server.ts"] });
    const findings = checkMilestone({
      milestone,
      files: ["checkout/cart.ts", "api/server.ts", "README.md"],
      branch: null,
      dependencies: [],
      nowMs: NOW,
    });
    expect(findings.map((finding) => finding.kind)).toEqual(["avoided_path", "outside_scope"]);
    expect(findings[0]!.summary).toContain("api/server.ts");
    expect(
      checkMilestone({
        milestone,
        files: ["checkout/a.ts"],
        branch: null,
        dependencies: [],
        nowMs: NOW,
      }),
    ).toEqual([]);
  });

  it("flags the wrong branch", () => {
    const base = active().milestones[0]!;
    const milestone = { ...base, scope: { ...base.scope, branch: "feat/checkout" } };
    const findings = checkMilestone({
      milestone,
      files: [],
      branch: "main",
      dependencies: [],
      nowMs: NOW,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: "wrong_branch", detail: ["main"] });
    expect(
      checkMilestone({
        milestone,
        files: [],
        branch: "feat/checkout",
        dependencies: [],
        nowMs: NOW,
      }),
    ).toEqual([]);
  });

  it("flags overdue milestones until they are done", () => {
    const milestone = active().milestones[0]!;
    const late = milestone.dueAtMs! + 1;
    expect(
      checkMilestone({ milestone, files: [], branch: null, dependencies: [], nowMs: late }).map(
        (finding) => finding.kind,
      ),
    ).toEqual(["overdue"]);
    expect(
      checkMilestone({
        milestone: { ...milestone, status: "done" },
        files: [],
        branch: null,
        dependencies: [],
        nowMs: late,
      }),
    ).toEqual([]);
    expect(
      checkMilestone({ milestone, files: [], branch: null, dependencies: [], nowMs: NOW + DAY }),
    ).toEqual([]);
  });

  it("finds new dependencies in manifests", () => {
    expect(
      addedDependencies(
        "package.json",
        JSON.stringify({ dependencies: { react: "1" } }),
        JSON.stringify({
          dependencies: { react: "1", stripe: "2" },
          devDependencies: { vitest: "3" },
        }),
      ),
    ).toEqual(["stripe", "vitest"]);
    expect(addedDependencies("requirements.txt", "flask==2\n", "flask==2\nrequests>=2\n")).toEqual([
      "requests",
    ]);
    expect(
      addedDependencies("package.json", null, JSON.stringify({ dependencies: { a: "1" } })),
    ).toEqual(["a"]);
    const milestone = active().milestones[0]!;
    const findings = checkMilestone({
      milestone,
      files: [],
      branch: null,
      dependencies: [{ path: "package.json", added: ["stripe"] }],
      nowMs: NOW,
    });
    expect(findings[0]).toMatchObject({ kind: "new_dependency" });
    expect(
      checkMilestone({
        milestone: { ...milestone, scope: { ...milestone.scope, newDependencies: true } },
        files: [],
        branch: null,
        dependencies: [{ path: "package.json", added: ["stripe"] }],
        nowMs: NOW,
      }),
    ).toEqual([]);
  });

  it("logs each finding once, and the host resolves it", () => {
    const goal = active();
    const milestone = goal.milestones[0]!;
    const finding = checkMilestone({
      milestone,
      files: ["api/server.ts"],
      branch: null,
      dependencies: [],
      nowMs: NOW,
    });
    const first = addFindings(goal, milestone, finding, { nowMs: NOW, newId });
    expect(first.added).toHaveLength(1);
    expect(first.added[0]).toMatchObject({
      kind: "goal.drift",
      presentation: "dialog",
      title: "Outside the guardrails: Omar edited api/server.ts (off limits for this milestone)",
      reason: "avoided_path",
      source: "check",
      subject: { milestoneId: milestone.id, threadId: "t-omar", who: { name: "Omar Haddad" } },
      approvers: [goal.ownerId],
      status: "open",
    });
    expect(first.added[0]!.actions.map((action) => action.id)).toEqual([
      "message",
      "watch",
      "accept",
      "ignore",
    ]);
    expect(addFindings(first.goal, milestone, finding, { nowMs: NOW, newId }).added).toHaveLength(
      0,
    );
    expect(goalTurnLines([first.goal], "t-omar").join("\n")).toContain("Off plan");
    const decisionId = first.added[0]!.id;
    refused(
      () => resolveDrift(first.goal, omar, { decisionId, action: "accept", nowMs: NOW }),
      "forbidden",
    );
    refused(
      () => resolveDrift(first.goal, ana, { decisionId, action: "message", nowMs: NOW }),
      "invalid",
    );
    const messaged = resolveDrift(first.goal, ana, {
      decisionId,
      action: "message",
      note: "Please revert api/",
      nowMs: NOW,
    });
    expect(messaged.decisions[0]).toMatchObject({
      status: "resolved",
      resolution: { action: "message", note: "Please revert api/", by: "Ana Ruiz" },
    });
    const accepted = resolveDrift(first.goal, host, { decisionId, action: "accept", nowMs: NOW });
    expect(accepted.decisions[0]!.resolution?.action).toBe("accept");
    refused(
      () => resolveDrift(accepted, host, { decisionId, action: "ignore", nowMs: NOW }),
      "invalid",
    );
    expect(goalTurnLines([accepted], "t-omar").join("\n")).not.toContain("Off plan");
  });
});

describe("agent context and the judgment", () => {
  it("tells the assignee's agent its milestone and the planner about its draft", () => {
    const lines = goalTurnLines([active()], "t-omar").join("\n");
    expect(lines).toContain("Saved cards UI");
    expect(lines).toContain("only checkout/");
    expect(lines).toContain("do not touch api/");
    expect(lines).toContain("lp_project_goal_update");
    expect(goalTurnLines([active()], "t-nobody")).toEqual([]);
    expect(goalTurnLines([draft()], "t-ana").join("\n")).toContain("waits for Ana Ruiz");
  });

  it("parses verdicts and rate-limits judgments per milestone", () => {
    expect(parseVerdict("ON_PLAN", "fine")).toBeNull();
    expect(parseVerdict("OFF_PLAN: rewrote the API client", "api/client.ts changed")).toMatchObject(
      {
        kind: "judgment",
        summary: "rewrote the API client",
      },
    );
    expect(judgeAllowed(undefined, NOW)).toBe(true);
    expect(judgeAllowed(NOW, NOW + 1000)).toBe(false);
    expect(judgeAllowed(NOW, NOW + JUDGE_MIN_INTERVAL_MS)).toBe(true);
  });
});
