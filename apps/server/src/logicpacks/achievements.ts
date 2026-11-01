import type {
  LpAchievement,
  LpAchievementShelf,
  LpAchievementTier,
  LpUnlockedAchievement,
} from "@logicpacks/contracts";

/**
 * What one participant has done on this host. Every achievement is a
 * threshold on one of these counts, and every count is derived from stored
 * events, so evaluation is idempotent and can be re-run (and backfilled) at
 * any time. Ported from the higgs community achievements model.
 */
export interface ParticipantMetrics {
  readonly turns: number;
  readonly tokens: number;
  readonly longestStreakDays: number;
  readonly agentHours: number;
  readonly distinctModels: number;
  readonly distinctDrivers: number;
  readonly projectsSynced: number;
  /** Projects someone else shared with this participant that they then worked in. */
  readonly invitesAccepted: number;
  /** Teammates this participant added who then worked in the shared project. */
  readonly inviteesJoined: number;
  readonly projectsShared: number;
  /** Threads started in projects that more than one person can open. */
  readonly threadsShared: number;
  readonly recipesPublished: number;
  readonly recipesReused: number;
  /** Teammates who reused a pack this participant published (one per pack and teammate). */
  readonly packTeammateReuses: number;
  /** Times teammates reused packs this participant published. */
  readonly packReusesReceived: number;
  readonly conflictsResolved: number;
  readonly helperSessionsLinked: number;
}

export const EMPTY_METRICS: ParticipantMetrics = {
  turns: 0,
  tokens: 0,
  longestStreakDays: 0,
  agentHours: 0,
  distinctModels: 0,
  distinctDrivers: 0,
  projectsSynced: 0,
  invitesAccepted: 0,
  inviteesJoined: 0,
  projectsShared: 0,
  threadsShared: 0,
  recipesPublished: 0,
  recipesReused: 0,
  packTeammateReuses: 0,
  packReusesReceived: 0,
  conflictsResolved: 0,
  helperSessionsLinked: 0,
};

export interface AchievementDefinition {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly shelf: string;
  readonly tier: LpAchievementTier;
  readonly points: number;
  readonly metric: keyof ParticipantMetrics;
  readonly threshold: number;
}

export const ACHIEVEMENT_SHELVES: ReadonlyArray<LpAchievementShelf> = [
  { id: "first-steps", name: "First steps" },
  { id: "together", name: "Working together" },
  { id: "recipes", name: "Recipes" },
  { id: "milestones", name: "Milestones" },
];

const define = (
  id: string,
  name: string,
  description: string,
  shelf: string,
  tier: LpAchievementTier,
  points: number,
  metric: keyof ParticipantMetrics,
  threshold: number,
): AchievementDefinition => ({ id, name, description, shelf, tier, points, metric, threshold });

export const ACHIEVEMENTS: ReadonlyArray<AchievementDefinition> = [
  define(
    "first_turn",
    "First turn",
    "Send a prompt and see an agent finish it.",
    "first-steps",
    "bronze",
    3,
    "turns",
    1,
  ),
  define(
    "first_sync",
    "First sync",
    "Sync a project to the cloud host so the team can work in it.",
    "first-steps",
    "bronze",
    10,
    "projectsSynced",
    1,
  ),
  define(
    "open_door",
    "Open door",
    "Share a project with a teammate.",
    "first-steps",
    "bronze",
    5,
    "projectsShared",
    1,
  ),
  define(
    "joined_team",
    "Joined a team",
    "Start work in a project a teammate shared with you.",
    "first-steps",
    "bronze",
    5,
    "invitesAccepted",
    1,
  ),
  define(
    "helper_linked",
    "Helper linked",
    "Link an outside Claude Code or Codex session to a project with the helper.",
    "first-steps",
    "bronze",
    5,
    "helperSessionsLinked",
    1,
  ),
  define(
    "first_invite_accepted",
    "First invite accepted",
    "A teammate you added started working in your project.",
    "together",
    "silver",
    10,
    "inviteesJoined",
    1,
  ),
  define(
    "team_builder",
    "Team builder",
    "Five teammates you added started working with you.",
    "together",
    "gold",
    30,
    "inviteesJoined",
    5,
  ),
  define(
    "in_the_open",
    "In the open",
    "Start a thread in a shared project.",
    "together",
    "bronze",
    3,
    "threadsShared",
    1,
  ),
  define(
    "open_book",
    "Open book",
    "Start 25 threads in shared projects.",
    "together",
    "silver",
    15,
    "threadsShared",
    25,
  ),
  define(
    "peacemaker",
    "Peacemaker",
    "Resolve a sync conflict.",
    "together",
    "silver",
    10,
    "conflictsResolved",
    1,
  ),
  define(
    "merge_master",
    "Merge master",
    "Resolve 10 sync conflicts.",
    "together",
    "gold",
    30,
    "conflictsResolved",
    10,
  ),
  define(
    "cloud_native",
    "Cloud native",
    "Sync 5 projects to the cloud host.",
    "together",
    "silver",
    15,
    "projectsSynced",
    5,
  ),
  define(
    "bring_your_agent",
    "Bring your own agent",
    "Link 25 outside agent sessions with the helper.",
    "together",
    "silver",
    15,
    "helperSessionsLinked",
    25,
  ),
  define(
    "recipe_author",
    "First pack",
    "Save a thread, prompt chain or workflow as a pack others can reuse.",
    "recipes",
    "silver",
    10,
    "recipesPublished",
    1,
  ),
  define(
    "passed_around",
    "Passed around",
    "A teammate reused a pack you published.",
    "recipes",
    "silver",
    15,
    "packTeammateReuses",
    1,
  ),
  define(
    "crowd_favourite",
    "Crowd favourite",
    "Teammates reused your packs 10 times.",
    "recipes",
    "gold",
    40,
    "packReusesReceived",
    10,
  ),
  define(
    "head_chef",
    "Head chef",
    "Publish 5 recipes.",
    "recipes",
    "gold",
    30,
    "recipesPublished",
    5,
  ),
  define(
    "second_helping",
    "Second helping",
    "Reuse a recipe a teammate ran.",
    "recipes",
    "bronze",
    5,
    "recipesReused",
    1,
  ),
  define(
    "regular",
    "House favourite",
    "Reuse recipes 10 times.",
    "recipes",
    "silver",
    15,
    "recipesReused",
    10,
  ),
  define(
    "hundred_turns",
    "Hundred turns",
    "Finish 100 agent turns.",
    "milestones",
    "silver",
    15,
    "turns",
    100,
  ),
  define(
    "thousand_turns",
    "Thousand turns",
    "Finish 1,000 agent turns.",
    "milestones",
    "gold",
    40,
    "turns",
    1000,
  ),
  define(
    "million_tokens",
    "Million tokens",
    "Your agents processed one million tokens.",
    "milestones",
    "bronze",
    10,
    "tokens",
    1_000_000,
  ),
  define(
    "hundred_million",
    "Hundred million",
    "Your agents processed one hundred million tokens.",
    "milestones",
    "platinum",
    80,
    "tokens",
    100_000_000,
  ),
  define(
    "warm_up",
    "Warm up",
    "Work with an agent 3 days in a row.",
    "milestones",
    "bronze",
    5,
    "longestStreakDays",
    3,
  ),
  define(
    "week_streak",
    "Week streak",
    "Work with an agent 7 days in a row.",
    "milestones",
    "silver",
    10,
    "longestStreakDays",
    7,
  ),
  define(
    "month_streak",
    "Month streak",
    "Work with an agent 30 days in a row.",
    "milestones",
    "gold",
    30,
    "longestStreakDays",
    30,
  ),
  define(
    "agent_hour",
    "Agent hour",
    "Your agents worked a full hour for you.",
    "milestones",
    "bronze",
    5,
    "agentHours",
    1,
  ),
  define(
    "ten_hours_back",
    "Ten hours back",
    "Your agents worked 10 hours for you.",
    "milestones",
    "silver",
    15,
    "agentHours",
    10,
  ),
  define(
    "hundred_hours_back",
    "Hundred hours back",
    "Your agents worked 100 hours for you.",
    "milestones",
    "gold",
    40,
    "agentHours",
    100,
  ),
  define(
    "polyglot",
    "Polyglot",
    "Run turns on 3 different models.",
    "milestones",
    "bronze",
    5,
    "distinctModels",
    3,
  ),
  define(
    "two_engines",
    "Two engines",
    "Run turns on two providers, such as Claude and Codex.",
    "milestones",
    "silver",
    10,
    "distinctDrivers",
    2,
  ),
];

const ACHIEVEMENTS_BY_ID = new Map(ACHIEVEMENTS.map((definition) => [definition.id, definition]));

export const achievementDefinition = (id: string) => ACHIEVEMENTS_BY_ID.get(id) ?? null;

/** Ids of the achievements `metrics` reaches. */
export const reachedAchievementIds = (metrics: ParticipantMetrics): ReadonlyArray<string> =>
  ACHIEVEMENTS.filter((definition) => metrics[definition.metric] >= definition.threshold).map(
    (definition) => definition.id,
  );

export const toUnlocked = (
  definition: AchievementDefinition,
  unlockedAt: string,
): LpUnlockedAchievement => ({
  id: definition.id,
  name: definition.name,
  tier: definition.tier,
  points: definition.points,
  unlockedAt,
});

/** Level n starts at 10 * (n - 1)^2 points: 0, 10, 40, 90, 160 and so on. */
export const levelForPoints = (points: number) => {
  const level = Math.floor(Math.sqrt(Math.max(0, points) / 10)) + 1;
  const start = 10 * (level - 1) ** 2;
  const next = 10 * level ** 2;
  return {
    level,
    nextLevelPoints: next - start,
    levelProgress: Math.min(1, Math.max(0, (points - start) / (next - start))),
  };
};

/**
 * The full shelf for a profile. Anything stored as unlocked stays unlocked even
 * if a count later drops (a project unshared), so a badge is never taken back.
 */
export const describeAchievements = (
  metrics: ParticipantMetrics,
  unlockedAt: ReadonlyMap<string, string>,
): ReadonlyArray<LpAchievement> =>
  ACHIEVEMENTS.map((definition) => {
    const current = metrics[definition.metric];
    const at = unlockedAt.get(definition.id) ?? null;
    const unlocked = at !== null;
    return {
      id: definition.id,
      name: definition.name,
      description: definition.description,
      shelf: definition.shelf,
      tier: definition.tier,
      points: definition.points,
      threshold: definition.threshold,
      current,
      progress: unlocked ? 1 : Math.min(1, current / definition.threshold),
      unlocked,
      unlockedAt: at,
    };
  });

export const pointsFor = (unlockedIds: Iterable<string>) => {
  let points = 0;
  for (const id of unlockedIds) points += ACHIEVEMENTS_BY_ID.get(id)?.points ?? 0;
  return points;
};
