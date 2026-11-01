// @effect-diagnostics globalDate:off -- pure date arithmetic on UTC days, no Effect here.
import type {
  LpAgentUsage,
  LpLeaderboard,
  LpLeaderboardEntry,
  LpLeaderboardRange,
  LpModelUsage,
  LpProjectUsage,
  LpRecentUnlock,
  LpUnlockedAchievement,
  LpUsageDay,
  LpUsageSharing,
} from "@logicpacks/contracts";

/** One stored turn group: a participant's turns on one day, project, provider and model. */
export interface UsageAggregateRow {
  readonly participantId: string;
  readonly day: string;
  readonly projectId: string | null;
  readonly driver: string;
  readonly model: string;
  readonly turns: number;
  /** Includes cached and cache-creation input. */
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheCreationTokens: number;
  readonly outputTokens: number;
  readonly durationMs: number;
  /** Turns a delegated, scheduled or agent-sent message started. */
  readonly autonomousTurns: number;
  /** Null when no rate is known for the model. */
  readonly costUsd: number | null;
  readonly lastAt: string;
}

export interface LeaderboardViewer {
  readonly participantId: string;
  readonly isOperator: boolean;
}

export interface BuildLeaderboardInput {
  readonly rows: ReadonlyArray<UsageAggregateRow>;
  readonly names: ReadonlyMap<string, string>;
  readonly viewer: LeaderboardViewer;
  readonly sharing: ReadonlyMap<string, LpUsageSharing>;
  /** Projects the viewer may see by name; null for every project (the operator). */
  readonly visibleProjectIds: ReadonlySet<string> | null;
  readonly projectTitles: ReadonlyMap<string, string>;
  readonly unlocked: ReadonlyMap<string, ReadonlyArray<LpUnlockedAchievement>>;
  readonly now: Date;
  readonly range: LpLeaderboardRange;
  readonly projectId: string | null;
}

export const DEFAULT_SHARING: LpUsageSharing = { shareUsage: true, isDecided: false };

const DAY_MS = 86_400_000;
const RANGE_DAYS: Record<LpLeaderboardRange, number | null> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
  all: null,
};
const HEATMAP_DAYS = 365;

export const utcDay = (date: Date) => date.toISOString().slice(0, 10);

const dayOffset = (now: Date, days: number) => utcDay(new Date(now.getTime() - days * DAY_MS));

export const rowTokens = (row: Pick<UsageAggregateRow, "inputTokens" | "outputTokens">) =>
  row.inputTokens + row.outputTokens;

/** Sums costs where known. Null only when nothing in the set has a price. */
const addCost = (total: number | null, cost: number | null) =>
  cost === null ? total : (total ?? 0) + cost;

export const hostDisplayName = "Host owner";

export const displayNameFor = (names: ReadonlyMap<string, string>, participantId: string) =>
  names.get(participantId) ?? (participantId === "host" ? hostDisplayName : "Former member");

/**
 * Current and longest runs of consecutive active UTC days. The current streak
 * survives until a full day passes without activity, so it does not reset at
 * midnight before today's first turn.
 */
export const streaks = (activeDays: ReadonlyArray<string>, now: Date) => {
  const sorted = Array.from(new Set(activeDays)).sort();
  let longest = 0;
  let run = 0;
  let previous: number | null = null;
  for (const day of sorted) {
    const at = Date.parse(`${day}T00:00:00Z`);
    run = previous !== null && at - previous === DAY_MS ? run + 1 : 1;
    longest = Math.max(longest, run);
    previous = at;
  }
  const today = utcDay(now);
  const yesterday = dayOffset(now, 1);
  const last = sorted.at(-1);
  const current = last === today || last === yesterday ? run : 0;
  return { current, longest };
};

const groupModels = (rows: ReadonlyArray<UsageAggregateRow>): Array<LpModelUsage> => {
  const byKey = new Map<string, LpModelUsage>();
  for (const row of rows) {
    const key = `${row.driver}\u0000${row.model}`;
    const previous = byKey.get(key);
    byKey.set(key, {
      driver: row.driver,
      model: row.model,
      turns: (previous?.turns ?? 0) + row.turns,
      tokens: (previous?.tokens ?? 0) + rowTokens(row),
      inputTokens: (previous?.inputTokens ?? 0) + row.inputTokens,
      outputTokens: (previous?.outputTokens ?? 0) + row.outputTokens,
      costUsd: addCost(previous?.costUsd ?? null, row.costUsd),
    });
  }
  return Array.from(byKey.values()).sort((left, right) => right.tokens - left.tokens);
};

const groupAgents = (
  rows: ReadonlyArray<UsageAggregateRow>,
  names: ReadonlyMap<string, string>,
): Array<LpAgentUsage> => {
  const byKey = new Map<string, LpAgentUsage>();
  for (const row of rows) {
    const key = `${row.participantId}:${row.driver}:${row.model}`;
    const previous = byKey.get(key);
    byKey.set(key, {
      key,
      ownerId: row.participantId,
      ownerName: displayNameFor(names, row.participantId),
      driver: row.driver,
      model: row.model,
      turns: (previous?.turns ?? 0) + row.turns,
      tokens: (previous?.tokens ?? 0) + rowTokens(row),
      costUsd: addCost(previous?.costUsd ?? null, row.costUsd),
      agentHours: (previous?.agentHours ?? 0) + row.durationMs / 3_600_000,
      autonomousTurns: (previous?.autonomousTurns ?? 0) + row.autonomousTurns,
    });
  }
  return Array.from(byKey.values()).sort(
    (left, right) => right.tokens - left.tokens || right.turns - left.turns,
  );
};

const groupDays = (rows: ReadonlyArray<UsageAggregateRow>, since: string): Array<LpUsageDay> => {
  const byDay = new Map<string, LpUsageDay>();
  for (const row of rows) {
    if (row.day < since) continue;
    const previous = byDay.get(row.day);
    byDay.set(row.day, {
      day: row.day,
      tokens: (previous?.tokens ?? 0) + rowTokens(row),
      turns: (previous?.turns ?? 0) + row.turns,
    });
  }
  return Array.from(byDay.values()).sort((left, right) => left.day.localeCompare(right.day));
};

const sumTokens = (rows: ReadonlyArray<UsageAggregateRow>) =>
  rows.reduce((total, row) => total + rowTokens(row), 0);

/**
 * Who may see a participant's numbers: themselves, the host operator (who
 * pays for the host), and everyone else only while the participant shares.
 */
export const canSeeParticipant = (
  viewer: LeaderboardViewer,
  participantId: string,
  sharing: ReadonlyMap<string, LpUsageSharing>,
) =>
  viewer.isOperator ||
  viewer.participantId === participantId ||
  (sharing.get(participantId) ?? DEFAULT_SHARING).shareUsage;

export const buildLeaderboard = (input: BuildLeaderboardInput): LpLeaderboard => {
  const { viewer, sharing, names, now } = input;
  const rangeDays = RANGE_DAYS[input.range];
  const rangeStart = rangeDays === null ? "" : dayOffset(now, rangeDays - 1);
  const thisWeekStart = dayOffset(now, 6);
  const lastWeekStart = dayOffset(now, 13);
  const heatmapStart = dayOffset(now, HEATMAP_DAYS - 1);
  const projectVisible = (projectId: string | null) =>
    projectId !== null &&
    (input.visibleProjectIds === null || input.visibleProjectIds.has(projectId));

  // A member asking for a project they cannot open gets nothing rather than its numbers.
  const scoped =
    input.projectId === null
      ? input.rows
      : projectVisible(input.projectId)
        ? input.rows.filter((row) => row.projectId === input.projectId)
        : [];

  const participantIds = new Set(scoped.map((row) => row.participantId));
  participantIds.add(viewer.participantId);
  const visibleIds = Array.from(participantIds).filter((id) =>
    canSeeParticipant(viewer, id, sharing),
  );
  const hiddenParticipants = Array.from(participantIds).filter(
    (id) =>
      !canSeeParticipant(viewer, id, sharing) && scoped.some((row) => row.participantId === id),
  ).length;
  const visibleSet = new Set(visibleIds);
  const visibleRows = scoped.filter((row) => visibleSet.has(row.participantId));
  const inRange = (row: UsageAggregateRow) => row.day >= rangeStart;

  const unsortedEntries = visibleIds.map((participantId) => {
    const all = visibleRows.filter((row) => row.participantId === participantId);
    const ranged = all.filter(inRange);
    const activeDays = all.map((row) => row.day);
    const streak = streaks(activeDays, now);
    const unlocked = input.unlocked.get(participantId) ?? [];
    const lastAt = all.reduce<string | null>(
      (latest, row) => (latest === null || row.lastAt > latest ? row.lastAt : latest),
      null,
    );
    return {
      participantId,
      displayName: displayNameFor(names, participantId),
      rank: 0,
      isYou: participantId === viewer.participantId,
      private: !(sharing.get(participantId) ?? DEFAULT_SHARING).shareUsage,
      tokens: sumTokens(ranged),
      turns: ranged.reduce((total, row) => total + row.turns, 0),
      costUsd: ranged.reduce<number | null>((total, row) => addCost(total, row.costUsd), null),
      thisWeekTokens: sumTokens(all.filter((row) => row.day >= thisWeekStart)),
      lastWeekTokens: sumTokens(
        all.filter((row) => row.day >= lastWeekStart && row.day < thisWeekStart),
      ),
      currentStreakDays: streak.current,
      longestStreakDays: streak.longest,
      activeDays: new Set(activeDays).size,
      agentHours: ranged.reduce((total, row) => total + row.durationMs, 0) / 3_600_000,
      lastActiveAt: lastAt,
      days: groupDays(all, heatmapStart),
      byModel: groupModels(ranged),
      agents: groupAgents(ranged, names),
      points: unlocked.reduce((total, achievement) => total + achievement.points, 0),
      achievements: [...unlocked].sort((left, right) =>
        right.unlockedAt.localeCompare(left.unlockedAt),
      ),
    } satisfies LpLeaderboardEntry;
  });

  const entries = unsortedEntries
    .sort(
      (left, right) =>
        right.tokens - left.tokens ||
        right.turns - left.turns ||
        right.points - left.points ||
        left.displayName.localeCompare(right.displayName),
    )
    .map((entry, index) => ({ ...entry, rank: index + 1 }));

  const ranged = visibleRows.filter(inRange);
  const byProjectMap = new Map<string, Array<UsageAggregateRow>>();
  for (const row of ranged) {
    if (!projectVisible(row.projectId)) continue;
    const list = byProjectMap.get(row.projectId!) ?? [];
    list.push(row);
    byProjectMap.set(row.projectId!, list);
  }
  const byProject: Array<LpProjectUsage> = Array.from(byProjectMap.entries())
    .map(([projectId, rows]) => {
      const perParticipant = new Map<string, number>();
      for (const row of rows) {
        perParticipant.set(
          row.participantId,
          (perParticipant.get(row.participantId) ?? 0) + rowTokens(row),
        );
      }
      const top = Array.from(perParticipant.entries()).sort((a, b) => b[1] - a[1])[0];
      return {
        projectId,
        title: input.projectTitles.get(projectId) ?? "Removed project",
        tokens: sumTokens(rows),
        turns: rows.reduce((total, row) => total + row.turns, 0),
        costUsd: rows.reduce<number | null>((total, row) => addCost(total, row.costUsd), null),
        participants: perParticipant.size,
        topParticipantName: top === undefined ? null : displayNameFor(names, top[0]),
      };
    })
    .sort((left, right) => right.tokens - left.tokens);

  const recentUnlocks: Array<LpRecentUnlock> = visibleIds
    .flatMap((participantId) =>
      (input.unlocked.get(participantId) ?? []).map((achievement) => ({
        participantId,
        displayName: displayNameFor(names, participantId),
        achievement,
      })),
    )
    .sort((left, right) => right.achievement.unlockedAt.localeCompare(left.achievement.unlockedAt))
    .slice(0, 12);

  const pricedRows = ranged.filter((row) => row.costUsd !== null).length;
  return {
    generatedAt: now.toISOString(),
    range: input.range,
    projectId: input.projectId,
    viewer: {
      participantId: viewer.participantId,
      isOperator: viewer.isOperator,
      sharing: sharing.get(viewer.participantId) ?? DEFAULT_SHARING,
    },
    totals: {
      tokens: sumTokens(ranged),
      turns: ranged.reduce((total, row) => total + row.turns, 0),
      costUsd: ranged.reduce<number | null>((total, row) => addCost(total, row.costUsd), null),
      thisWeekTokens: sumTokens(visibleRows.filter((row) => row.day >= thisWeekStart)),
      lastWeekTokens: sumTokens(
        visibleRows.filter((row) => row.day >= lastWeekStart && row.day < thisWeekStart),
      ),
      agentHours: ranged.reduce((total, row) => total + row.durationMs, 0) / 3_600_000,
    },
    entries,
    agents: groupAgents(ranged, names),
    hiddenParticipants,
    byProject,
    byModel: groupModels(ranged),
    days: groupDays(visibleRows, heatmapStart),
    recentUnlocks,
    pricing:
      ranged.length === 0 || pricedRows === ranged.length
        ? "priced"
        : pricedRows === 0
          ? "unpriced"
          : "partial",
  };
};
