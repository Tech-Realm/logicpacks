import type { LpAchievementTier, LpLeaderboardRange, LpUsageDay } from "@logicpacks/contracts";

export type UsageView = "team" | "machine";

export const USAGE_VIEWS: ReadonlyArray<{ readonly value: UsageView; readonly label: string }> = [
  { value: "team", label: "Team" },
  { value: "machine", label: "This machine" },
];

/** The Usage route opens on the team leaderboard; `?view=machine` shows this machine's transcripts. */
export const parseUsageView = (raw: unknown): UsageView => (raw === "machine" ? "machine" : "team");

export const RANGE_OPTIONS: ReadonlyArray<{
  readonly value: LpLeaderboardRange;
  readonly label: string;
}> = [
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "90d", label: "90 days" },
  { value: "all", label: "All time" },
];

export const isLeaderboardRange = (value: unknown): value is LpLeaderboardRange =>
  RANGE_OPTIONS.some((option) => option.value === value);

export interface HeatmapCell {
  readonly day: string;
  readonly tokens: number;
  readonly turns: number;
  readonly level: 0 | 1 | 2 | 3 | 4;
  /** A day after today in the last week; drawn as an empty slot. */
  readonly future: boolean;
}

const DAY_MS = 86_400_000;

/**
 * A GitHub-style year of days ending today, in columns of weeks starting on
 * Sunday. Intensity uses quantiles of this person's own active days (ported
 * from the v1 usage heatmap), so a light user is not an empty grid and a heavy
 * one is not a solid block.
 */
export function buildHeatmap(
  days: ReadonlyArray<LpUsageDay>,
  todayIso: string,
  weeks = 53,
): ReadonlyArray<ReadonlyArray<HeatmapCell>> {
  const today = new Date(todayIso);
  const byDay = new Map(days.map((day) => [day.day, day]));
  const nonZero = days
    .map((day) => day.tokens)
    .filter((tokens) => tokens > 0)
    .toSorted((left, right) => left - right);
  const thresholds = [0.25, 0.5, 0.75].map(
    (quantile) => nonZero[Math.floor(quantile * (nonZero.length - 1))] ?? 0,
  );
  const busiest = nonZero.at(-1) ?? 0;
  const levelFor = (tokens: number, turns: number): HeatmapCell["level"] => {
    if (tokens <= 0) return turns > 0 ? 1 : 0;
    // The busiest day is always full, even when there are too few days for quantiles.
    if (tokens >= busiest) return 4;
    if (tokens <= thresholds[0]!) return 1;
    if (tokens <= thresholds[1]!) return 2;
    if (tokens <= thresholds[2]!) return 3;
    return 4;
  };
  const end = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const start = end - (today.getUTCDay() + (weeks - 1) * 7) * DAY_MS;
  const columns: Array<Array<HeatmapCell>> = [];
  for (let week = 0; week < weeks; week += 1) {
    const column: Array<HeatmapCell> = [];
    for (let weekday = 0; weekday < 7; weekday += 1) {
      const at = start + (week * 7 + weekday) * DAY_MS;
      const key = new Date(at).toISOString().slice(0, 10);
      const found = at > end ? undefined : byDay.get(key);
      const tokens = found?.tokens ?? 0;
      const turns = found?.turns ?? 0;
      column.push({ day: key, tokens, turns, level: levelFor(tokens, turns), future: at > end });
    }
    columns.push(column);
  }
  return columns;
}

/** "+42%", "-8%", "new" or "no change", for this week against last week. */
export function weekOverWeek(
  thisWeek: number,
  lastWeek: number,
): {
  readonly label: string;
  readonly direction: "up" | "down" | "flat";
} {
  if (lastWeek <= 0) {
    return thisWeek > 0 ? { label: "new", direction: "up" } : { label: "-", direction: "flat" };
  }
  const change = Math.round(((thisWeek - lastWeek) / lastWeek) * 100);
  if (change === 0) return { label: "no change", direction: "flat" };
  return change > 0
    ? { label: `+${change}%`, direction: "up" }
    : { label: `${change}%`, direction: "down" };
}

export function formatHours(hours: number): string {
  if (hours <= 0) return "0h";
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}m`;
  if (hours < 10) return `${Math.round(hours * 10) / 10}h`;
  return `${Math.round(hours)}h`;
}

export function formatCost(costUsd: number | null): string {
  if (costUsd === null) return "n/a";
  if (costUsd > 0 && costUsd < 0.01) return "<$0.01";
  return `$${costUsd.toFixed(costUsd >= 100 ? 0 : 2)}`;
}

/** Provider names as people say them. */
export function providerLabel(driver: string): string {
  switch (driver) {
    case "claudeAgent":
      return "Claude";
    case "codex":
      return "Codex";
    case "cursor":
      return "Cursor";
    case "opencode":
      return "OpenCode";
    case "grok":
      return "Grok";
    default:
      return driver;
  }
}

export const TIER_ORDER: Record<LpAchievementTier, number> = {
  bronze: 0,
  silver: 1,
  gold: 2,
  platinum: 3,
};

/** Achievements seen on this device, so only new unlocks raise a toast. */
export const SEEN_ACHIEVEMENTS_KEY = "lp.usage.achievements.seen";

export function newlyUnlocked(
  unlockedIds: ReadonlyArray<string>,
  seenRaw: string | null,
): { readonly fresh: ReadonlyArray<string>; readonly seen: string } {
  let seen: ReadonlyArray<string> | null = null;
  try {
    const parsed: unknown = seenRaw === null ? null : JSON.parse(seenRaw);
    seen = Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : null;
  } catch {
    seen = null;
  }
  // The first visit only records what is already unlocked; nothing to celebrate yet.
  const fresh = seen === null ? [] : unlockedIds.filter((id) => !seen.includes(id));
  return { fresh, seen: JSON.stringify(unlockedIds) };
}
