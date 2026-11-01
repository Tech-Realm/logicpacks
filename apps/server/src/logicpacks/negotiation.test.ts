import { describe, expect, it } from "@effect/vitest";

import {
  contestedItems,
  decide,
  negotiationLinesFor,
  NegotiationError,
  recordMerge,
  startNegotiation,
  submitPosition,
  tick,
  type Negotiation,
  type NegotiationPosition,
} from "./negotiation.ts";

const T0 = 1_000_000;
const position = (input: Partial<NegotiationPosition>): NegotiationPosition => ({
  keep: [],
  change: [],
  drop: [],
  insist: false,
  note: "",
  ...input,
});

const start = (names: ReadonlyArray<string> = ["Ana", "Ali"], maxRounds = 3) =>
  startNegotiation({
    id: "n1",
    projectId: "p1",
    conflictId: "c1",
    files: ["src/app.txt"],
    parties: names.map((name) => ({ threadId: `t-${name}`, name })),
    proposerThreadId: `t-${names[0]}`,
    nowMs: T0,
    maxRounds,
    stepTimeoutMs: 60_000,
  });

describe("startNegotiation", () => {
  it("wakes every party once and notices everyone", () => {
    const { next, effects } = start();
    expect(next.state).toBe("collecting");
    expect(next.round).toBe(1);
    expect(next.mergerThreadId).toBe("t-Ana");
    expect(effects.filter((effect) => effect.type === "wake").map((e) => e.threadId)).toEqual([
      "t-Ana",
      "t-Ali",
    ]);
    expect(effects.some((effect) => effect.type === "notice")).toBe(true);
    expect(next.wakes).toBe(2);
  });

  it("refuses fewer than two threads", () => {
    expect(() =>
      startNegotiation({
        id: "n",
        projectId: "p",
        conflictId: null,
        files: [],
        parties: [
          { threadId: "a", name: "A" },
          { threadId: "a", name: "A" },
        ],
        proposerThreadId: null,
        nowMs: T0,
      }),
    ).toThrow(NegotiationError);
  });
});

describe("submitPosition", () => {
  it("agrees to merge both when nothing is contested", () => {
    let n = start().next;
    n = submitPosition(n, "t-Ana", position({ keep: ["header"] }), T0 + 1).next;
    expect(n.state).toBe("collecting");
    const { next, effects } = submitPosition(n, "t-Ali", position({ keep: ["footer"] }), T0 + 2);
    expect(next.state).toBe("agreed");
    expect(next.plan?.strategy).toBe("merge_both");
    expect(next.plan?.summary).toContain("header");
    expect(next.plan?.summary).toContain("footer");
    const wake = effects.find((effect) => effect.type === "wake");
    expect(wake?.type === "wake" && wake.threadId).toBe("t-Ana");
  });

  it("asks both people when both insist on contested items", () => {
    let n = start().next;
    n = submitPosition(
      n,
      "t-Ana",
      position({ keep: ["blue button"], drop: ["green button"], insist: true }),
      T0 + 1,
    ).next;
    const { next, effects } = submitPosition(
      n,
      "t-Ali",
      position({ keep: ["green button"], drop: ["blue button"], insist: true }),
      T0 + 2,
    );
    expect(next.state).toBe("awaiting_humans");
    const ana = next.parties.find((party) => party.threadId === "t-Ana")!;
    expect(ana.question).toContain(
      "Ali's version keeps green button and Ali insists on keeping it",
    );
    expect(effects.filter((effect) => effect.type === "notice")).toHaveLength(2);
    expect(effects.some((effect) => effect.type === "wake")).toBe(false);
  });

  it("lets the side that insists win when the other is flexible", () => {
    let n = start().next;
    n = submitPosition(n, "t-Ana", position({ keep: ["X"], insist: true }), T0 + 1).next;
    const { next } = submitPosition(n, "t-Ali", position({ drop: ["X"] }), T0 + 2);
    expect(next.state).toBe("agreed");
    expect(next.plan).toMatchObject({ strategy: "keep", keepThreadId: "t-Ana" });
  });

  it("runs another round when nobody insists, and asks people at the cap", () => {
    let n = start(["Ana", "Ali"], 2).next;
    n = submitPosition(n, "t-Ana", position({ keep: ["X"] }), T0 + 1).next;
    const second = submitPosition(n, "t-Ali", position({ drop: ["X"] }), T0 + 2);
    expect(second.next.round).toBe(2);
    expect(second.next.state).toBe("collecting");
    expect(second.effects.filter((effect) => effect.type === "wake")).toHaveLength(2);
    n = submitPosition(second.next, "t-Ana", position({ keep: ["X"] }), T0 + 3).next;
    const third = submitPosition(n, "t-Ali", position({ drop: ["X"] }), T0 + 4);
    expect(third.next.state).toBe("awaiting_humans");
  });

  it("rejects positions from outsiders or while people decide", () => {
    const n = start().next;
    expect(() => submitPosition(n, "t-Zed", position({}), T0)).toThrow(NegotiationError);
    const asked: Negotiation = { ...n, state: "awaiting_humans" };
    expect(() => submitPosition(asked, "t-Ana", position({}), T0)).toThrow(/deciding/);
  });
});

describe("decide", () => {
  const awaiting = () => {
    let n = start().next;
    n = submitPosition(n, "t-Ana", position({ keep: ["A"], drop: ["B"], insist: true }), T0).next;
    return submitPosition(n, "t-Ali", position({ keep: ["B"], drop: ["A"], insist: true }), T0)
      .next;
  };

  it("settles when both people want the same outcome", () => {
    let n = awaiting();
    const first = decide(n, "t-Ana", "both", T0 + 10);
    expect(first.next.state).toBe("awaiting_humans");
    expect(first.effects[0]).toMatchObject({ type: "notice", threadIds: ["t-Ali"] });
    n = decide(first.next, "t-Ali", "both", T0 + 11).next;
    expect(n.state).toBe("agreed");
    expect(n.plan?.strategy).toBe("merge_both");
  });

  it("reads mine and theirs from each side", () => {
    let n = awaiting();
    n = decide(n, "t-Ana", "theirs", T0).next;
    n = decide(n, "t-Ali", "mine", T0).next;
    expect(n.state).toBe("agreed");
    expect(n.plan).toMatchObject({ strategy: "keep", keepThreadId: "t-Ali" });
  });

  it("asks again when people disagree, and stops changing anything at the cap", () => {
    let n = awaiting();
    n = decide(n, "t-Ana", "mine", T0).next;
    const disagree = decide(n, "t-Ali", "mine", T0);
    expect(disagree.next.state).toBe("awaiting_humans");
    expect(disagree.next.round).toBe(2);
    expect(disagree.next.parties.every((party) => party.decision === null)).toBe(true);
    n = decide(disagree.next, "t-Ana", "mine", T0).next;
    n = decide(n, "t-Ali", "mine", T0).next;
    expect(n.round).toBe(3);
    n = decide(n, "t-Ana", "mine", T0).next;
    const stuck = decide(n, "t-Ali", "mine", T0);
    expect(stuck.next.state).toBe("awaiting_humans");
    expect(stuck.effects[0]?.type === "notice" && stuck.effects[0].text).toContain("Override");
  });

  it("an override settles at once, even mid-collection", () => {
    const n = start().next;
    const { next } = decide(n, "t-Ali", "mine", T0, { override: true });
    expect(next.state).toBe("agreed");
    expect(next.plan).toMatchObject({ strategy: "keep", keepThreadId: "t-Ali" });
  });

  it("theirs with three or more parties is no preference", () => {
    let n = start(["Ana", "Ali", "Bo"]).next;
    n = submitPosition(n, "t-Ana", position({ keep: ["A"], insist: true }), T0).next;
    n = submitPosition(n, "t-Ali", position({ drop: ["A"], keep: ["B"], insist: true }), T0).next;
    n = submitPosition(n, "t-Bo", position({ drop: ["B"] }), T0).next;
    expect(n.state).toBe("awaiting_humans");
    n = decide(n, "t-Ana", "both", T0).next;
    n = decide(n, "t-Ali", "theirs", T0).next;
    n = decide(n, "t-Bo", "both", T0).next;
    expect(n.state).toBe("agreed");
    expect(n.plan?.strategy).toBe("merge_both");
  });
});

describe("recordMerge and tick", () => {
  const agreed = () => {
    let n = start().next;
    n = submitPosition(n, "t-Ana", position({ keep: ["A"] }), T0).next;
    return submitPosition(n, "t-Ali", position({ keep: ["B"] }), T0).next;
  };

  it("posts the outcome to every thread and records a decision", () => {
    const { next, effects } = recordMerge(
      agreed(),
      "t-Ana",
      { ok: true, branch: "lp/merge-n1", summary: "kept A and B" },
      T0 + 5,
    );
    expect(next.state).toBe("merged");
    expect(effects[0]).toMatchObject({ type: "notice", threadIds: ["t-Ana", "t-Ali"] });
    expect(effects.some((effect) => effect.type === "decision")).toBe(true);
    expect(() => recordMerge(next, "t-Ana", { ok: true, branch: null, summary: "" }, T0)).toThrow(
      /already/,
    );
  });

  it("silent agents hand the decision to people; silent people stop it", () => {
    const n = start().next;
    expect(tick(n, T0 + 1)).toBeNull();
    const asked = tick(n, T0 + 60_001)!;
    expect(asked.next.state).toBe("awaiting_humans");
    const stopped = tick(asked.next, asked.next.deadlineAtMs + 1)!;
    expect(stopped.next.state).toBe("timed_out");
    // People can still decide after a timeout.
    expect(decide(stopped.next, "t-Ana", "both", T0).next.state).toBe("agreed");
  });

  it("never wakes agents past the budget", () => {
    let n = start(["Ana", "Ali"], 50).next;
    let wakes = n.wakes;
    for (let round = 0; round < 40; round++) {
      n = submitPosition(n, "t-Ana", position({ keep: ["X"] }), T0).next;
      n = submitPosition(n, "t-Ali", position({ drop: ["X"] }), T0).next;
      wakes = n.wakes;
    }
    expect(wakes).toBeLessThanOrEqual(n.maxWakes);
  });

  it("tells each agent what to do next", () => {
    const n = start().next;
    expect(negotiationLinesFor(n, "t-Ana").join("\n")).toContain("Your turn");
    expect(negotiationLinesFor(n, "t-Zed")).toEqual([]);
    expect(contestedItems(n.parties)).toEqual([]);
  });
});
