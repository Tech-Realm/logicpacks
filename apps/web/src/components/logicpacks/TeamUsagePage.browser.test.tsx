import {
  EnvironmentId,
  type LpAchievements,
  type LpLeaderboard,
  type LpLeaderboardEntry,
} from "@logicpacks/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";

const today = "2026-10-31";

const entry = (overrides: Partial<LpLeaderboardEntry>): LpLeaderboardEntry => ({
  participantId: "host",
  displayName: "Host owner",
  rank: 1,
  isYou: false,
  private: false,
  tokens: 0,
  turns: 0,
  costUsd: null,
  thisWeekTokens: 0,
  lastWeekTokens: 0,
  currentStreakDays: 0,
  longestStreakDays: 0,
  activeDays: 0,
  agentHours: 0,
  lastActiveAt: null,
  days: [],
  byModel: [],
  agents: [],
  points: 0,
  achievements: [],
  ...overrides,
});

// Seeded usage: Sara leads, Ali (the viewer) second, one private teammate hidden.
const board: LpLeaderboard = {
  generatedAt: "2026-10-31T12:00:00.000Z",
  range: "30d",
  projectId: null,
  viewer: {
    participantId: "ali",
    isOperator: false,
    sharing: { shareUsage: true, isDecided: false },
  },
  totals: {
    tokens: 2_450_000,
    turns: 57,
    costUsd: 18.4,
    thisWeekTokens: 900_000,
    lastWeekTokens: 600_000,
    agentHours: 6.5,
  },
  entries: [
    entry({
      participantId: "sara",
      displayName: "Sara",
      rank: 1,
      tokens: 1_800_000,
      turns: 40,
      costUsd: 14.1,
      thisWeekTokens: 700_000,
      lastWeekTokens: 350_000,
      currentStreakDays: 6,
      longestStreakDays: 9,
      points: 38,
      days: [{ day: today, tokens: 400_000, turns: 9 }],
      achievements: [
        {
          id: "week_streak",
          name: "Week streak",
          tier: "silver",
          points: 10,
          unlockedAt: `${today}T09:00:00.000Z`,
        },
      ],
    }),
    entry({
      participantId: "ali",
      displayName: "Ali",
      rank: 2,
      isYou: true,
      tokens: 650_000,
      turns: 17,
      costUsd: 4.3,
      thisWeekTokens: 200_000,
      lastWeekTokens: 250_000,
      currentStreakDays: 2,
      points: 13,
      byModel: [
        {
          driver: "claudeAgent",
          model: "claude-sonnet-4-5",
          turns: 17,
          tokens: 650_000,
          inputTokens: 600_000,
          outputTokens: 50_000,
          costUsd: 4.3,
        },
      ],
    }),
  ],
  agents: [
    {
      key: "sara:codex:gpt-5-codex",
      ownerId: "sara",
      ownerName: "Sara",
      driver: "codex",
      model: "gpt-5-codex",
      turns: 40,
      tokens: 1_800_000,
      costUsd: null,
      agentHours: 4.5,
      autonomousTurns: 12,
    },
  ],
  hiddenParticipants: 1,
  byProject: [
    {
      projectId: "p-shop",
      title: "Shop",
      tokens: 2_450_000,
      turns: 57,
      costUsd: 18.4,
      participants: 2,
      topParticipantName: "Sara",
    },
  ],
  byModel: [
    {
      driver: "codex",
      model: "gpt-5-codex",
      turns: 40,
      tokens: 1_800_000,
      inputTokens: 1_700_000,
      outputTokens: 100_000,
      costUsd: null,
    },
  ],
  days: [{ day: today, tokens: 400_000, turns: 9 }],
  recentUnlocks: [
    {
      participantId: "sara",
      displayName: "Sara",
      achievement: {
        id: "week_streak",
        name: "Week streak",
        tier: "silver",
        points: 10,
        unlockedAt: `${today}T09:00:00.000Z`,
      },
    },
  ],
  pricing: "partial",
};

const achievements: LpAchievements = {
  participantId: "ali",
  displayName: "Ali",
  points: 13,
  level: 2,
  nextLevelPoints: 30,
  levelProgress: 0.1,
  shelves: [{ id: "first-steps", name: "First steps" }],
  achievements: [
    {
      id: "first_turn",
      name: "First turn",
      description: "Send a prompt and see an agent finish it.",
      shelf: "first-steps",
      tier: "bronze",
      points: 3,
      threshold: 1,
      current: 17,
      progress: 1,
      unlocked: true,
      unlockedAt: `${today}T08:00:00.000Z`,
    },
    {
      id: "first_sync",
      name: "First sync",
      description: "Sync a project to the cloud host so the team can work in it.",
      shelf: "first-steps",
      tier: "bronze",
      points: 10,
      threshold: 1,
      current: 0,
      progress: 0,
      unlocked: false,
      unlockedAt: null,
    },
  ],
};

const state = vi.hoisted(() => ({
  setSharing: vi.fn((_input: unknown) => Promise.resolve({ _tag: "Success" })),
  refresh: vi.fn(),
}));

vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  usePrimaryEnvironmentId: () => EnvironmentId.make("host-env"),
}));
vi.mock(import("../../state/logicpacksUsage"), () => ({
  logicPacksUsageEnvironment: {
    leaderboard: ((target: { readonly input: unknown }) =>
      `leaderboard:${JSON.stringify(target.input)}`) as never,
    achievements: (() => "achievements") as never,
    setUsageSharing: "set-usage-sharing" as never,
  },
}));
vi.mock(import("../../state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: ((atom: unknown) => ({
    data:
      atom === "achievements"
        ? achievements
        : typeof atom === "string" && atom.startsWith("leaderboard")
          ? board
          : null,
    error: null,
    isPending: false,
    isSuccess: atom !== null,
    refresh: state.refresh,
  })) as never,
}));
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => state.setSharing) as never,
}));

import { TeamUsagePage } from "./TeamUsagePage";

it("shows the team leaderboard with privacy, agents, heatmap and achievements", async () => {
  await using _screen = await render(<TeamUsagePage />, { router: "/usage" });

  const rowText = () =>
    Array.from(document.querySelectorAll('[data-testid="leaderboard-row"]'), (row) =>
      (row.textContent ?? "").replace(/\s+/g, " "),
    );
  await vi.waitFor(() => expect(rowText()).toHaveLength(2));
  const [first, second] = rowText();
  expect(first).toContain("Sara");
  expect(second).toContain("Ali");
  expect(second).toContain("you");
  // Sara doubled her tokens week over week; Ali dropped.
  expect(first).toContain("+100%");
  expect(second).toContain("-20%");
  await expect
    .element(page.getByText("One teammate keeps their usage private and is not counted here."))
    .toBeVisible();

  // Totals and the week-over-week summary.
  await expect.element(page.getByText("2.45M").first()).toBeVisible();
  await expect.element(page.getByText("+50% vs last week (600K)")).toBeVisible();

  // The heatmap marks today's activity at the top level.
  expect(document.querySelectorAll('[data-level="4"]').length).toBeGreaterThan(0);

  // Achievements: one earned, one locked, and Sara's unlock in the feed.
  const shelf = page.getByTestId("achievement");
  await expect.element(shelf.first()).toHaveAttribute("data-unlocked", "true");
  await expect.element(shelf.nth(1)).toHaveAttribute("data-unlocked", "false");
  await expect.element(page.getByText("Level 2 · 13 pts")).toBeVisible();
  expect(document.querySelector('[aria-label="Recent unlocks"]')?.textContent).toContain(
    "Sara unlocked Week streak",
  );

  // Agents tab ranks each person's agents.
  await userEvent.click(page.getByRole("button", { name: "Agents", exact: true }));
  await vi.waitFor(() => {
    const agent = document.querySelector('[data-testid="agent-row"]')?.textContent ?? "";
    expect(agent).toContain("Sara\u2019s Codex");
    expect(agent).toContain("4.5h");
  });

  // Turning sharing off asks the host and refreshes the board.
  // Test styles leave the switch without a box, so click it through the DOM.
  const toggle = document.querySelector<HTMLElement>(
    '[role="switch"][aria-label="Share my usage with the team"]',
  );
  expect(toggle?.getAttribute("aria-checked")).toBe("true");
  toggle!.click();
  await vi.waitFor(() => expect(state.setSharing).toHaveBeenCalled());
  expect(state.setSharing).toHaveBeenCalledWith({
    environmentId: "host-env",
    input: { shareUsage: false },
  });
  await vi.waitFor(() => expect(state.refresh).toHaveBeenCalled());
});
