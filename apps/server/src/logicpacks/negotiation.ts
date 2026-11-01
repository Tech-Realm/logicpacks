/**
 * Agent-to-agent negotiation over a conflict as a pure state machine. Every transition
 * returns the effects the ledger must carry out (wake an agent, post a notice), so loops
 * stay bounded here: a round cap, a wake budget and a deadline per step.
 */

export type NegotiationChoice = "accept" | "mine" | "theirs" | "both";

export interface NegotiationPosition {
  readonly keep: ReadonlyArray<string>;
  readonly change: ReadonlyArray<string>;
  readonly drop: ReadonlyArray<string>;
  readonly insist: boolean;
  readonly note: string;
}

export interface NegotiationParty {
  readonly threadId: string;
  readonly name: string;
  readonly position: NegotiationPosition | null;
  /** The round the position was posted in; stale positions do not count. */
  readonly positionRound: number;
  /** What this party's person is asked, while a human decision is needed. */
  readonly question: string | null;
  readonly decision: NegotiationChoice | null;
}

export type NegotiationState =
  | "collecting"
  | "awaiting_humans"
  | "agreed"
  | "merged"
  | "failed"
  | "timed_out";

export interface NegotiationPlan {
  readonly strategy: "merge_both" | "keep";
  /** For "keep": whose version wins the contested parts. */
  readonly keepThreadId: string | null;
  readonly summary: string;
}

export interface Negotiation {
  readonly id: string;
  readonly projectId: string;
  readonly conflictId: string | null;
  readonly files: ReadonlyArray<string>;
  readonly state: NegotiationState;
  readonly round: number;
  readonly maxRounds: number;
  readonly parties: ReadonlyArray<NegotiationParty>;
  readonly plan: NegotiationPlan | null;
  readonly mergerThreadId: string | null;
  readonly deadlineAtMs: number;
  readonly stepTimeoutMs: number;
  readonly wakes: number;
  readonly maxWakes: number;
  readonly outcome: {
    readonly ok: boolean;
    readonly branch: string | null;
    readonly summary: string;
    readonly by: string;
  } | null;
  readonly log: ReadonlyArray<string>;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export type NegotiationEffect =
  | { readonly type: "wake"; readonly threadId: string; readonly text: string }
  | {
      readonly type: "notice";
      readonly threadIds: ReadonlyArray<string>;
      readonly text: string;
    }
  | { readonly type: "decision"; readonly text: string };

export interface Transition {
  readonly next: Negotiation;
  readonly effects: ReadonlyArray<NegotiationEffect>;
}

export class NegotiationError extends Error {}

export const DEFAULT_MAX_ROUNDS = 3;
export const DEFAULT_STEP_TIMEOUT_MS = 15 * 60_000;

const ACTIVE: ReadonlySet<NegotiationState> = new Set(["collecting", "awaiting_humans", "agreed"]);
export const isActive = (negotiation: Negotiation) => ACTIVE.has(negotiation.state);

const listText = (items: ReadonlyArray<string>) =>
  items.length === 0 ? "nothing listed" : items.join(", ");

const norm = (item: string) => item.trim().toLowerCase();

const withLog = (negotiation: Negotiation, nowMs: number, line: string): Negotiation => ({
  ...negotiation,
  updatedAtMs: nowMs,
  log: [...negotiation.log, line].slice(-40),
});

/** Keeps wakes within the budget; past it the agents are left alone and people decide. */
const budgetWakes = (
  negotiation: Negotiation,
  effects: ReadonlyArray<NegotiationEffect>,
): Transition => {
  let wakes = negotiation.wakes;
  const kept: NegotiationEffect[] = [];
  let dropped = 0;
  for (const effect of effects) {
    if (effect.type !== "wake") {
      kept.push(effect);
      continue;
    }
    if (wakes >= negotiation.maxWakes) {
      dropped += 1;
      continue;
    }
    wakes += 1;
    kept.push(effect);
  }
  const next = { ...negotiation, wakes };
  return {
    next:
      dropped === 0
        ? next
        : { ...next, log: [...next.log, `wake budget spent; ${dropped} wake(s) skipped`] },
    effects: kept,
  };
};

const partyThreads = (negotiation: Negotiation) =>
  negotiation.parties.map((party) => party.threadId);

export const startNegotiation = (input: {
  readonly id: string;
  readonly projectId: string;
  readonly conflictId: string | null;
  readonly files: ReadonlyArray<string>;
  readonly parties: ReadonlyArray<{ readonly threadId: string; readonly name: string }>;
  readonly proposerThreadId: string | null;
  readonly nowMs: number;
  readonly maxRounds?: number;
  readonly stepTimeoutMs?: number;
}): Transition => {
  const unique = new Map<string, { threadId: string; name: string }>();
  for (const party of input.parties) unique.set(party.threadId, party);
  if (unique.size < 2) {
    throw new NegotiationError("A negotiation needs at least two threads.");
  }
  const maxRounds = Math.max(1, input.maxRounds ?? DEFAULT_MAX_ROUNDS);
  const stepTimeoutMs = input.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
  const parties = Array.from(unique.values(), (party) => ({
    threadId: party.threadId,
    name: party.name,
    position: null,
    positionRound: 0,
    question: null,
    decision: null,
  }));
  const negotiation: Negotiation = {
    id: input.id,
    projectId: input.projectId,
    conflictId: input.conflictId,
    files: input.files,
    state: "collecting",
    round: 1,
    maxRounds,
    parties,
    plan: null,
    mergerThreadId:
      input.proposerThreadId !== null && unique.has(input.proposerThreadId)
        ? input.proposerThreadId
        : parties[0]!.threadId,
    deadlineAtMs: input.nowMs + stepTimeoutMs,
    stepTimeoutMs,
    wakes: 0,
    // Each agent can be woken once per round, plus the merger once.
    maxWakes: parties.length * maxRounds + 1,
    outcome: null,
    log: [`started for ${listText(input.files)} between ${parties.map((p) => p.name).join(", ")}`],
    createdAtMs: input.nowMs,
    updatedAtMs: input.nowMs,
  };
  const names = parties.map((party) => party.name).join(", ");
  return budgetWakes(negotiation, [
    {
      type: "notice",
      threadIds: partyThreads(negotiation),
      text: `Merging ${names}'s work on ${listText(input.files)}. Each agent states what to keep, change or drop.`,
    },
    ...parties.map((party) => ({
      type: "wake" as const,
      threadId: party.threadId,
      text: `LogicPacks negotiation ${input.id}: your work and ${names
        .split(", ")
        .filter((name) => name !== party.name)
        .join(
          ", ",
        )}'s collide on ${listText(input.files)}. Post your position with lp_project_propose_merge (negotiationId "${input.id}", keep/change/drop, insist only for what your user needs).`,
    })),
  ]);
};

interface Contest {
  readonly item: string;
  readonly keptBy: ReadonlyArray<NegotiationParty>;
  readonly droppedBy: ReadonlyArray<NegotiationParty>;
}

/** Items one party keeps and another drops. */
export const contestedItems = (
  parties: ReadonlyArray<NegotiationParty>,
): ReadonlyArray<Contest> => {
  const items = new Map<string, string>();
  for (const party of parties) {
    for (const item of [...(party.position?.keep ?? []), ...(party.position?.drop ?? [])]) {
      if (!items.has(norm(item))) items.set(norm(item), item);
    }
  }
  const contests: Contest[] = [];
  for (const [key, item] of items) {
    const keptBy = parties.filter((party) =>
      (party.position?.keep ?? []).some((kept) => norm(kept) === key),
    );
    const droppedBy = parties.filter((party) =>
      (party.position?.drop ?? []).some((dropped) => norm(dropped) === key),
    );
    if (keptBy.length > 0 && droppedBy.length > 0) contests.push({ item, keptBy, droppedBy });
  }
  return contests;
};

const mergeBothSummary = (parties: ReadonlyArray<NegotiationParty>) => {
  const keep = Array.from(new Set(parties.flatMap((party) => party.position?.keep ?? [])));
  const change = Array.from(new Set(parties.flatMap((party) => party.position?.change ?? [])));
  const kept = new Set(keep.map(norm));
  const drop = Array.from(
    new Set(
      parties
        .flatMap((party) => party.position?.drop ?? [])
        .filter((item) => !kept.has(norm(item))),
    ),
  );
  return `Merge both: keep ${listText(keep)}${change.length > 0 ? `; change ${listText(change)}` : ""}${drop.length > 0 ? `; drop ${listText(drop)}` : ""}.`;
};

const agree = (negotiation: Negotiation, plan: NegotiationPlan, nowMs: number): Transition => {
  const merger = negotiation.parties.find((party) => party.threadId === negotiation.mergerThreadId);
  const next = withLog(
    {
      ...negotiation,
      state: "agreed",
      plan,
      parties: negotiation.parties.map((party) => ({ ...party, question: null })),
      deadlineAtMs: nowMs + negotiation.stepTimeoutMs,
    },
    nowMs,
    `agreed: ${plan.summary}`,
  );
  return budgetWakes(next, [
    {
      type: "notice",
      threadIds: partyThreads(next),
      text: `Agreed: ${plan.summary} ${merger?.name ?? "One agent"}'s agent merges it on a branch.`,
    },
    {
      type: "wake",
      threadId: next.mergerThreadId!,
      text: `LogicPacks negotiation ${negotiation.id} is agreed: ${plan.summary} Merge it on a new branch (lp/merge-${negotiation.id}), keep everyone's agreed work, push the branch, then call lp_project_propose_merge with action "merged", the branch and a one-line summary (or action "failed" with why).`,
    },
  ]);
};

/** A question for each party about the others' insisted items. */
const askHumans = (
  negotiation: Negotiation,
  contests: ReadonlyArray<Contest>,
  nowMs: number,
  why: string,
): Transition => {
  const parties = negotiation.parties.map((party) => {
    const others = negotiation.parties.filter((other) => other.threadId !== party.threadId);
    const theirs = others
      .map((other) => {
        const kept = contests
          .filter((contest) => contest.keptBy.some((p) => p.threadId === other.threadId))
          .map((contest) => contest.item);
        if (kept.length === 0) return null;
        return `${other.name}'s version keeps ${listText(kept)}${other.position?.insist ? ` and ${other.name} insists on keeping it` : ""}`;
      })
      .filter((line): line is string => line !== null);
    const mine = contests
      .filter((contest) => contest.droppedBy.some((p) => p.threadId === party.threadId))
      .map((contest) => contest.item);
    const lead =
      theirs.length > 0
        ? `${theirs.join("; ")}.`
        : `Your version keeps ${listText(
            contests
              .filter((contest) => contest.keptBy.some((p) => p.threadId === party.threadId))
              .map((contest) => contest.item),
          )}, which the others would drop.`;
    const question = `${lead}${mine.length > 0 ? ` Your agent wanted to drop ${listText(mine)}.` : ""} What do you want: keep yours, keep theirs, or merge both?`;
    return { ...party, question, decision: null };
  });
  const next = withLog(
    {
      ...negotiation,
      state: "awaiting_humans",
      parties,
      deadlineAtMs: nowMs + negotiation.stepTimeoutMs,
    },
    nowMs,
    `asking people: ${why}`,
  );
  return {
    next,
    effects: parties.map((party) => ({
      type: "notice" as const,
      threadIds: [party.threadId],
      text: party.question ?? "",
    })),
  };
};

const evaluateRound = (negotiation: Negotiation, nowMs: number): Transition => {
  const contests = contestedItems(negotiation.parties);
  if (contests.length === 0) {
    return agree(
      negotiation,
      {
        strategy: "merge_both",
        keepThreadId: null,
        summary: mergeBothSummary(negotiation.parties),
      },
      nowMs,
    );
  }
  const insisting = new Set(
    contests.flatMap((contest) =>
      [...contest.keptBy, ...contest.droppedBy]
        .filter((party) => party.position?.insist === true)
        .map((party) => party.threadId),
    ),
  );
  if (insisting.size >= 2 || negotiation.round >= negotiation.maxRounds) {
    return askHumans(
      negotiation,
      contests,
      nowMs,
      insisting.size >= 2
        ? "more than one side insists"
        : `no agreement after ${negotiation.round} round(s)`,
    );
  }
  if (insisting.size === 1) {
    // One side insists and the other did not: the flexible side yields on the contested items.
    const winner = negotiation.parties.find((party) => insisting.has(party.threadId))!;
    return agree(
      negotiation,
      {
        strategy: "keep",
        keepThreadId: winner.threadId,
        summary: `${mergeBothSummary(negotiation.parties).replace(/\.$/, "")}; where they differ, keep ${winner.name}'s version (${listText(contests.map((contest) => contest.item))}).`,
      },
      nowMs,
    );
  }
  // Nobody insists but they disagree: one more round to converge.
  const round = negotiation.round + 1;
  const next = withLog(
    { ...negotiation, round, deadlineAtMs: nowMs + negotiation.stepTimeoutMs },
    nowMs,
    `round ${round}: contested ${listText(contests.map((contest) => contest.item))}`,
  );
  return budgetWakes(
    next,
    next.parties.map((party) => ({
      type: "wake" as const,
      threadId: party.threadId,
      text: `LogicPacks negotiation ${negotiation.id}, round ${round} of ${negotiation.maxRounds}: you disagree on ${listText(contests.map((contest) => contest.item))}. Post a revised position with lp_project_propose_merge, or insist if your user needs it.`,
    })),
  );
};

export const submitPosition = (
  negotiation: Negotiation,
  threadId: string,
  position: NegotiationPosition,
  nowMs: number,
): Transition => {
  if (negotiation.state !== "collecting") {
    throw new NegotiationError(
      negotiation.state === "awaiting_humans"
        ? "The people involved are deciding now; wait for their answer."
        : `This negotiation is ${negotiation.state}.`,
    );
  }
  const party = negotiation.parties.find((candidate) => candidate.threadId === threadId);
  if (party === undefined)
    throw new NegotiationError("This thread is not part of the negotiation.");
  const next = withLog(
    {
      ...negotiation,
      parties: negotiation.parties.map((candidate) =>
        candidate.threadId === threadId
          ? { ...candidate, position, positionRound: negotiation.round }
          : candidate,
      ),
    },
    nowMs,
    `${party.name}: keep ${listText(position.keep)}; change ${listText(position.change)}; drop ${listText(position.drop)}${position.insist ? " (insists)" : ""}`,
  );
  const waiting = next.parties.filter((candidate) => candidate.positionRound < next.round);
  if (waiting.length > 0) {
    return {
      next,
      effects: [
        {
          type: "notice",
          threadIds: partyThreads(next).filter((id) => id !== threadId),
          text: `${party.name}'s agent: keep ${listText(position.keep)}${position.drop.length > 0 ? `, drop ${listText(position.drop)}` : ""}${position.insist ? ` (${party.name} insists)` : ""}.`,
        },
      ],
    };
  }
  return evaluateRound(next, nowMs);
};

/** What a person's choice means: whose version they want, or no preference. */
const choiceTarget = (
  negotiation: Negotiation,
  threadId: string,
  choice: NegotiationChoice,
): string | null => {
  if (choice === "both") return "both";
  if (choice === "mine") return threadId;
  if (choice === "theirs") {
    const others = negotiation.parties.filter((party) => party.threadId !== threadId);
    // "Theirs" names one side only when there is exactly one other side.
    return others.length === 1 ? others[0]!.threadId : null;
  }
  return null;
};

const planFor = (negotiation: Negotiation, target: string): NegotiationPlan => {
  if (target === "both") {
    return {
      strategy: "merge_both",
      keepThreadId: null,
      summary: mergeBothSummary(negotiation.parties),
    };
  }
  const winner = negotiation.parties.find((party) => party.threadId === target);
  return {
    strategy: "keep",
    keepThreadId: target,
    summary: `Keep ${winner?.name ?? "one side"}'s version of ${listText(negotiation.files)}, and the rest of everyone's work.`,
  };
};

/**
 * A person answers their card. `override` settles the negotiation on their
 * choice at once (the human override); otherwise it settles when everyone's
 * answers agree, and goes another round when they do not.
 */
export const decide = (
  negotiation: Negotiation,
  threadId: string,
  choice: NegotiationChoice,
  nowMs: number,
  options: { readonly override?: boolean; readonly by?: string } = {},
): Transition => {
  if (negotiation.state === "merged" || negotiation.state === "failed") {
    throw new NegotiationError(`This negotiation is already ${negotiation.state}.`);
  }
  const party = negotiation.parties.find((candidate) => candidate.threadId === threadId);
  if (party === undefined)
    throw new NegotiationError("This thread is not part of the negotiation.");
  const by = options.by ?? party.name;
  if (choice === "accept" && negotiation.state === "agreed") {
    return { next: withLog(negotiation, nowMs, `${by} accepted the plan`), effects: [] };
  }
  const overriding = options.override === true || negotiation.state !== "awaiting_humans";
  if (overriding) {
    const target =
      choiceTarget(negotiation, threadId, choice) ??
      (negotiation.plan === null ? "both" : (negotiation.plan.keepThreadId ?? "both"));
    const next = withLog(negotiation, nowMs, `${by} decided: ${choice}`);
    return agree(next, planFor(next, target), nowMs);
  }
  const parties = negotiation.parties.map((candidate) =>
    candidate.threadId === threadId ? { ...candidate, decision: choice } : candidate,
  );
  const next = withLog({ ...negotiation, parties }, nowMs, `${by} chose ${choice}`);
  const undecided = parties.filter((candidate) => candidate.decision === null);
  if (undecided.length > 0) {
    return {
      next,
      effects: [
        {
          type: "notice",
          threadIds: undecided.map((candidate) => candidate.threadId),
          text: `${by} chose ${choice === "both" ? "to merge both" : choice === "mine" ? "to keep their version" : choice === "theirs" ? "to keep the other version" : "to accept"}. Waiting for your answer.`,
        },
      ],
    };
  }
  const targets = new Set(
    parties
      .map((candidate) => choiceTarget(next, candidate.threadId, candidate.decision!))
      .filter((target): target is string => target !== null),
  );
  if (targets.size <= 1) {
    const [only] = Array.from(targets);
    return agree(next, planFor(next, only ?? "both"), nowMs);
  }
  if (next.round >= next.maxRounds) {
    const stuck = withLog(
      {
        ...next,
        state: "awaiting_humans",
        round: next.round + 1,
        parties: next.parties.map((candidate) => ({ ...candidate, decision: null })),
        deadlineAtMs: nowMs + next.stepTimeoutMs,
      },
      nowMs,
      "people disagree after the last round",
    );
    return {
      next: stuck,
      effects: [
        {
          type: "notice",
          threadIds: partyThreads(stuck),
          text: `You chose different outcomes and the rounds are used up. Nothing was changed. Any of you can settle it with Override on the card.`,
        },
      ],
    };
  }
  const again = withLog(
    {
      ...next,
      round: next.round + 1,
      parties: next.parties.map((candidate) => ({ ...candidate, decision: null })),
      deadlineAtMs: nowMs + next.stepTimeoutMs,
    },
    nowMs,
    "people chose different outcomes; asking again",
  );
  return {
    next: again,
    effects: [
      {
        type: "notice",
        threadIds: partyThreads(again),
        text: `You chose different outcomes (round ${again.round} of ${again.maxRounds}). Talk it over and choose again, or merge both.`,
      },
    ],
  };
};

/** The merging agent reports the result; the outcome goes to every thread involved. */
export const recordMerge = (
  negotiation: Negotiation,
  threadId: string,
  result: { readonly ok: boolean; readonly branch: string | null; readonly summary: string },
  nowMs: number,
): Transition => {
  if (negotiation.state !== "agreed" && negotiation.state !== "timed_out") {
    throw new NegotiationError(
      negotiation.state === "merged"
        ? "The merge is already recorded."
        : "Agree on a plan before merging.",
    );
  }
  const party = negotiation.parties.find((candidate) => candidate.threadId === threadId);
  const by = party?.name ?? "An agent";
  const next = withLog(
    {
      ...negotiation,
      state: result.ok ? "merged" : "failed",
      outcome: { ...result, by },
      parties: negotiation.parties.map((candidate) => ({ ...candidate, question: null })),
    },
    nowMs,
    result.ok ? `merged on ${result.branch ?? "a branch"}` : `merge failed: ${result.summary}`,
  );
  const text = result.ok
    ? `Merged by ${by}'s agent${result.branch === null ? "" : ` on ${result.branch}`}: ${result.summary}`
    : `${by}'s agent could not merge: ${result.summary}. Nothing was lost; pick Keep mine, Keep theirs or Merge both to try again.`;
  return {
    next,
    effects: [
      { type: "notice", threadIds: partyThreads(next), text },
      ...(result.ok ? [{ type: "decision" as const, text }] : []),
    ],
  };
};

/** Deadlines: silent agents hand the choice to people; silent people stop it without changes. */
export const tick = (negotiation: Negotiation, nowMs: number): Transition | null => {
  if (!isActive(negotiation) || nowMs < negotiation.deadlineAtMs) return null;
  if (negotiation.state === "collecting") {
    const contests = contestedItems(negotiation.parties);
    const silent = negotiation.parties
      .filter((party) => party.positionRound < negotiation.round)
      .map((party) => party.name);
    return askHumans(
      negotiation,
      contests,
      nowMs,
      `no position from ${silent.join(", ") || "some agents"} in time`,
    );
  }
  const next = withLog(
    { ...negotiation, state: "timed_out", deadlineAtMs: Number.MAX_SAFE_INTEGER },
    nowMs,
    negotiation.state === "agreed"
      ? "the merge was not reported in time"
      : "nobody decided in time",
  );
  return {
    next,
    effects: [
      {
        type: "notice",
        threadIds: partyThreads(next),
        text:
          negotiation.state === "agreed"
            ? "The agreed merge was not reported in time. Nothing was changed; choose Merge both to retry."
            : "Nobody decided in time. Nothing was changed; choose an option on the card to continue.",
      },
    ],
  };
};

/** The lines a party's agent reads at its next turn. */
export const negotiationLinesFor = (
  negotiation: Negotiation,
  threadId: string,
): ReadonlyArray<string> => {
  const party = negotiation.parties.find((candidate) => candidate.threadId === threadId);
  if (party === undefined || !isActive(negotiation)) return [];
  const others = negotiation.parties.filter((candidate) => candidate.threadId !== threadId);
  const head = `Negotiation ${negotiation.id} (${negotiation.state}, round ${negotiation.round}/${negotiation.maxRounds}) on ${listText(negotiation.files)} with ${others.map((other) => other.name).join(", ")}. You speak for ${party.name}.`;
  const positions = others
    .filter((other) => other.position !== null)
    .map(
      (other) =>
        `${other.name}'s position: keep ${listText(other.position!.keep)}; change ${listText(other.position!.change)}; drop ${listText(other.position!.drop)}${other.position!.insist ? " (insists)" : ""}${other.position!.note ? ` (${other.position!.note})` : ""}.`,
    );
  const next =
    negotiation.state === "collecting"
      ? party.positionRound < negotiation.round
        ? `Your turn: post your position with lp_project_propose_merge (negotiationId "${negotiation.id}").`
        : "Your position is in; waiting for the others."
      : negotiation.state === "awaiting_humans"
        ? `Your user is asked: "${party.question ?? "keep yours, keep theirs, or merge both?"}" Relay it if they ask; their answer comes from the card.`
        : negotiation.mergerThreadId === threadId
          ? `Agreed: ${negotiation.plan?.summary ?? ""} You merge it: branch lp/merge-${negotiation.id}, then lp_project_propose_merge action "merged".`
          : `Agreed: ${negotiation.plan?.summary ?? ""} Another agent merges it.`;
  return [head, ...positions, next];
};
