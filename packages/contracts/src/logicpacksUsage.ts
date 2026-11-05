import * as Schema from "effect/Schema";

/**
 * LogicPacks workspace usage: a leaderboard of the humans on a host and the
 * agents that ran for them, plus the achievements those events unlock.
 *
 * A participant is a LogicPacks member (their user id) or the host operator
 * (`LP_HOST_PARTICIPANT_ID`): the desktop owner or whoever runs the host.
 */
export const LP_HOST_PARTICIPANT_ID = "host" as const;

export const LP_USAGE_WS_METHODS = {
  getLeaderboard: "logicpacks.getLeaderboard",
  getAchievements: "logicpacks.getAchievements",
  setUsageSharing: "logicpacks.setUsageSharing",
  reportActivity: "logicpacks.reportActivity",
} as const;

export const LpLeaderboardRange = Schema.Literals(["7d", "30d", "90d", "all"]);
export type LpLeaderboardRange = typeof LpLeaderboardRange.Type;

export const LpLeaderboardInput = Schema.Struct({
  range: Schema.optional(LpLeaderboardRange),
  projectId: Schema.optional(Schema.String),
});
export type LpLeaderboardInput = typeof LpLeaderboardInput.Type;

/** One day of activity. Days are UTC `YYYY-MM-DD`; days without activity are left out. */
export const LpUsageDay = Schema.Struct({
  day: Schema.String,
  tokens: Schema.Number,
  turns: Schema.Number,
});
export type LpUsageDay = typeof LpUsageDay.Type;

export const LpModelUsage = Schema.Struct({
  driver: Schema.String,
  model: Schema.String,
  turns: Schema.Number,
  tokens: Schema.Number,
  inputTokens: Schema.Number,
  outputTokens: Schema.Number,
  /** Null when no rate is known for the model. */
  costUsd: Schema.NullOr(Schema.Number),
});
export type LpModelUsage = typeof LpModelUsage.Type;

/** An agent is one participant's provider and model: "Ali's Claude (opus)". */
export const LpAgentUsage = Schema.Struct({
  key: Schema.String,
  ownerId: Schema.String,
  ownerName: Schema.String,
  driver: Schema.String,
  model: Schema.String,
  turns: Schema.Number,
  tokens: Schema.Number,
  costUsd: Schema.NullOr(Schema.Number),
  /** Time the agent spent working on turns, in hours. */
  agentHours: Schema.Number,
  /** Turns that delegated or scheduled agents started rather than a person. */
  autonomousTurns: Schema.Number,
});
export type LpAgentUsage = typeof LpAgentUsage.Type;

export const LpAchievementTier = Schema.Literals(["bronze", "silver", "gold", "platinum"]);
export type LpAchievementTier = typeof LpAchievementTier.Type;

export const LpUnlockedAchievement = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  tier: LpAchievementTier,
  points: Schema.Number,
  unlockedAt: Schema.String,
});
export type LpUnlockedAchievement = typeof LpUnlockedAchievement.Type;

export const LpLeaderboardEntry = Schema.Struct({
  participantId: Schema.String,
  displayName: Schema.String,
  rank: Schema.Number,
  isYou: Schema.Boolean,
  /** The participant keeps usage private; only they and the host operator see this row. */
  private: Schema.Boolean,
  tokens: Schema.Number,
  turns: Schema.Number,
  costUsd: Schema.NullOr(Schema.Number),
  thisWeekTokens: Schema.Number,
  lastWeekTokens: Schema.Number,
  currentStreakDays: Schema.Number,
  longestStreakDays: Schema.Number,
  activeDays: Schema.Number,
  agentHours: Schema.Number,
  lastActiveAt: Schema.NullOr(Schema.String),
  days: Schema.Array(LpUsageDay),
  byModel: Schema.Array(LpModelUsage),
  agents: Schema.Array(LpAgentUsage),
  points: Schema.Number,
  achievements: Schema.Array(LpUnlockedAchievement),
});
export type LpLeaderboardEntry = typeof LpLeaderboardEntry.Type;

export const LpProjectUsage = Schema.Struct({
  projectId: Schema.String,
  title: Schema.String,
  tokens: Schema.Number,
  turns: Schema.Number,
  costUsd: Schema.NullOr(Schema.Number),
  participants: Schema.Number,
  topParticipantName: Schema.NullOr(Schema.String),
});
export type LpProjectUsage = typeof LpProjectUsage.Type;

export const LpRecentUnlock = Schema.Struct({
  participantId: Schema.String,
  displayName: Schema.String,
  achievement: LpUnlockedAchievement,
});
export type LpRecentUnlock = typeof LpRecentUnlock.Type;

export const LpUsageSharing = Schema.Struct({
  shareUsage: Schema.Boolean,
  /** False while this is the default rather than the person's own choice. */
  isDecided: Schema.Boolean,
});
export type LpUsageSharing = typeof LpUsageSharing.Type;

export const LpLeaderboard = Schema.Struct({
  generatedAt: Schema.String,
  range: LpLeaderboardRange,
  projectId: Schema.NullOr(Schema.String),
  viewer: Schema.Struct({
    participantId: Schema.String,
    isOperator: Schema.Boolean,
    sharing: LpUsageSharing,
  }),
  totals: Schema.Struct({
    tokens: Schema.Number,
    turns: Schema.Number,
    costUsd: Schema.NullOr(Schema.Number),
    thisWeekTokens: Schema.Number,
    lastWeekTokens: Schema.Number,
    agentHours: Schema.Number,
  }),
  entries: Schema.Array(LpLeaderboardEntry),
  agents: Schema.Array(LpAgentUsage),
  /** Members who keep usage private and are left out of every number above for this viewer. */
  hiddenParticipants: Schema.Number,
  byProject: Schema.Array(LpProjectUsage),
  byModel: Schema.Array(LpModelUsage),
  days: Schema.Array(LpUsageDay),
  recentUnlocks: Schema.Array(LpRecentUnlock),
  pricing: Schema.Literals(["priced", "partial", "unpriced"]),
});
export type LpLeaderboard = typeof LpLeaderboard.Type;

export const LpAchievement = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.String,
  shelf: Schema.String,
  tier: LpAchievementTier,
  points: Schema.Number,
  threshold: Schema.Number,
  current: Schema.Number,
  /** 0 to 1. */
  progress: Schema.Number,
  unlocked: Schema.Boolean,
  unlockedAt: Schema.NullOr(Schema.String),
});
export type LpAchievement = typeof LpAchievement.Type;

export const LpAchievementShelf = Schema.Struct({ id: Schema.String, name: Schema.String });
export type LpAchievementShelf = typeof LpAchievementShelf.Type;

export const LpAchievementsInput = Schema.Struct({
  /** Someone else's profile. Omit for your own. */
  participantId: Schema.optional(Schema.String),
});
export type LpAchievementsInput = typeof LpAchievementsInput.Type;

export const LpAchievements = Schema.Struct({
  participantId: Schema.String,
  displayName: Schema.String,
  points: Schema.Number,
  level: Schema.Number,
  /** Points needed to reach the next level, from the start of this one. */
  nextLevelPoints: Schema.Number,
  levelProgress: Schema.Number,
  shelves: Schema.Array(LpAchievementShelf),
  achievements: Schema.Array(LpAchievement),
});
export type LpAchievements = typeof LpAchievements.Type;

export const LpSetUsageSharingInput = Schema.Struct({ shareUsage: Schema.Boolean });
export type LpSetUsageSharingInput = typeof LpSetUsageSharingInput.Type;

/**
 * Events the server cannot see itself, reported by the caller for themselves:
 * the helper linking an outside agent session, an agent resolving a sync
 * conflict. `subject` deduplicates (a commit, a session id), so reporting
 * twice counts once.
 */
export const LpReportableActivityKind = Schema.Literals([
  "conflict.resolved",
  "helper.session_linked",
]);
export type LpReportableActivityKind = typeof LpReportableActivityKind.Type;

export const LpReportActivityInput = Schema.Struct({
  kind: LpReportableActivityKind,
  subject: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  projectId: Schema.optional(Schema.String),
});
export type LpReportActivityInput = typeof LpReportActivityInput.Type;

export const LpReportActivityResult = Schema.Struct({
  recorded: Schema.Boolean,
  unlocked: Schema.Array(LpUnlockedAchievement),
});
export type LpReportActivityResult = typeof LpReportActivityResult.Type;

export class LpUsageError extends Schema.TaggedError<LpUsageError>()("LpUsageError", {
  reason: Schema.Literals(["not_found", "storage"]),
  message: Schema.String,
}) {}
