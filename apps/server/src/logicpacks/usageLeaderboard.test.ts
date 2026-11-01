// @effect-diagnostics globalDate:off -- fixed dates for a pure aggregation.
import type { LpUsageSharing } from "@logicpacks/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildLeaderboard,
  type BuildLeaderboardInput,
  streaks,
  type UsageAggregateRow,
} from "./usageLeaderboard.ts";

const NOW = new Date("2026-10-31T15:00:00Z");

const row = (overrides: Partial<UsageAggregateRow>): UsageAggregateRow => ({
  participantId: "host",
  day: "2026-10-31",
  projectId: "p-shop",
  driver: "claudeAgent",
  model: "claude-opus-4-1",
  turns: 1,
  inputTokens: 1000,
  cachedInputTokens: 600,
  cacheCreationTokens: 100,
  outputTokens: 200,
  durationMs: 60_000,
  autonomousTurns: 0,
  costUsd: 0.05,
  lastAt: "2026-10-31T12:00:00.000Z",
  ...overrides,
});

// Seeded usage: the host on the shop, Ali on shop and api, Sara (private) heavy on the api.
const ROWS: ReadonlyArray<UsageAggregateRow> = [
  row({ participantId: "host", day: "2026-10-31", turns: 3, inputTokens: 3000, outputTokens: 900 }),
  row({ participantId: "host", day: "2026-10-20", turns: 2, inputTokens: 2000, outputTokens: 500 }),
  row({
    participantId: "ali",
    day: "2026-10-31",
    turns: 4,
    inputTokens: 8000,
    outputTokens: 2000,
    projectId: "p-api",
  }),
  row({ participantId: "ali", day: "2026-10-30", turns: 2, inputTokens: 1000, outputTokens: 100 }),
  row({ participantId: "ali", day: "2026-10-29", turns: 1, inputTokens: 500, outputTokens: 50 }),
  row({
    participantId: "ali",
    day: "2026-10-22",
    driver: "codex",
    model: "gpt-5-codex",
    turns: 2,
    inputTokens: 4000,
    outputTokens: 400,
    costUsd: null,
    autonomousTurns: 2,
  }),
  row({
    participantId: "sara",
    day: "2026-10-31",
    turns: 10,
    inputTokens: 90_000,
    outputTokens: 9000,
    projectId: "p-api",
  }),
];

const NAMES = new Map([
  ["ali", "Ali"],
  ["sara", "Sara"],
]);
const SHARING = new Map<string, LpUsageSharing>([["sara", { shareUsage: false, isDecided: true }]]);

const input = (overrides: Partial<BuildLeaderboardInput>): BuildLeaderboardInput => ({
  rows: ROWS,
  names: NAMES,
  viewer: { participantId: "ali", isOperator: false },
  sharing: SHARING,
  visibleProjectIds: new Set(["p-shop"]),
  projectTitles: new Map([
    ["p-shop", "Shop"],
    ["p-api", "API"],
  ]),
  unlocked: new Map([
    [
      "ali",
      [
        {
          id: "first_turn",
          name: "First turn",
          tier: "bronze",
          points: 3,
          unlockedAt: "2026-10-22T10:00:00.000Z",
        },
      ],
    ],
    [
      "sara",
      [
        {
          id: "first_turn",
          name: "First turn",
          tier: "bronze",
          points: 3,
          unlockedAt: "2026-10-31T10:00:00.000Z",
        },
      ],
    ],
  ]),
  now: NOW,
  range: "30d",
  projectId: null,
  ...overrides,
});

describe("buildLeaderboard", () => {
  it("ranks humans by tokens and leaves a private member out for other members", () => {
    const board = buildLeaderboard(input({}));
    expect(board.entries.map((entry) => [entry.displayName, entry.rank])).toEqual([
      ["Ali", 1],
      ["Host owner", 2],
    ]);
    expect(board.hiddenParticipants).toBe(1);
    // Sara's 99k tokens appear nowhere for Ali: not in totals, models, projects or unlocks.
    expect(board.totals.tokens).toBe(16_050 + 6_400);
    expect(board.byModel.reduce((total, model) => total + model.tokens, 0)).toBe(
      board.totals.tokens,
    );
    expect(board.recentUnlocks.map((unlock) => unlock.participantId)).toEqual(["ali"]);
    const ali = board.entries[0]!;
    expect(ali.isYou).toBe(true);
    expect(ali.turns).toBe(9);
    expect(ali.points).toBe(3);
  });

  it("shows the operator everyone, marking private rows", () => {
    const board = buildLeaderboard(
      input({ viewer: { participantId: "host", isOperator: true }, visibleProjectIds: null }),
    );
    expect(board.entries.map((entry) => entry.displayName)).toEqual(["Sara", "Ali", "Host owner"]);
    expect(board.entries[0]!.private).toBe(true);
    expect(board.hiddenParticipants).toBe(0);
    expect(board.byProject.map((project) => project.title)).toEqual(["API", "Shop"]);
    expect(board.byProject[0]!.topParticipantName).toBe("Sara");
  });

  it("names only the projects a member can open", () => {
    const board = buildLeaderboard(input({}));
    expect(board.byProject.map((project) => project.projectId)).toEqual(["p-shop"]);
    const forbidden = buildLeaderboard(input({ projectId: "p-api" }));
    expect(forbidden.totals.turns).toBe(0);
    expect(forbidden.entries.every((entry) => entry.tokens === 0)).toBe(true);
  });

  it("filters by project and range", () => {
    const shop = buildLeaderboard(input({ projectId: "p-shop" }));
    expect(shop.totals.turns).toBe(3 + 2 + 2 + 1 + 2);
    const week = buildLeaderboard(input({ range: "7d" }));
    // 2026-10-25 onwards: Ali's last three days and the host's today.
    expect(week.totals.turns).toBe(4 + 2 + 1 + 3);
  });

  it("splits cost and agents by provider and model, with unknown prices kept apart", () => {
    const board = buildLeaderboard(input({}));
    const codex = board.byModel.find((model) => model.driver === "codex")!;
    expect(codex.costUsd).toBeNull();
    expect(board.pricing).toBe("partial");
    const aliCodex = board.agents.find((agent) => agent.key === "ali:codex:gpt-5-codex")!;
    expect(aliCodex.autonomousTurns).toBe(2);
    expect(aliCodex.ownerName).toBe("Ali");
    expect(aliCodex.agentHours).toBeCloseTo(1 / 60);
  });

  it("compares this week with last week", () => {
    const ali = buildLeaderboard(input({})).entries.find((entry) => entry.participantId === "ali")!;
    expect(ali.thisWeekTokens).toBe(10_000 + 1_100 + 550);
    expect(ali.lastWeekTokens).toBe(4_400);
    expect(ali.currentStreakDays).toBe(3);
  });
});

describe("streaks", () => {
  it("keeps a current streak alive until a full day is missed", () => {
    expect(streaks(["2026-10-29", "2026-10-30"], NOW)).toEqual({ current: 2, longest: 2 });
    expect(streaks(["2026-10-27", "2026-10-28"], NOW)).toEqual({ current: 0, longest: 2 });
    expect(
      streaks(["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-03", "2026-10-31"], NOW),
    ).toEqual({ current: 1, longest: 3 });
    expect(streaks([], NOW)).toEqual({ current: 0, longest: 0 });
  });
});
