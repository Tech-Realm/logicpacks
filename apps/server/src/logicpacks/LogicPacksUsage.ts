// @effect-diagnostics-next-line nodeBuiltinImport:off -- random ids for activity rows, no Effect needed.
import * as NodeCrypto from "node:crypto";

import {
  LP_HOST_PARTICIPANT_ID,
  type LpAchievements,
  type LpLeaderboard,
  type LpLeaderboardRange,
  type LpReportableActivityKind,
  type LpUnlockedAchievement,
  LpUsageError,
  type LpUsageSharing,
} from "@logicpacks/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import { parseRateTable, priceUsage, type RateTable } from "../usage/usagePricing.ts";
import {
  ACHIEVEMENT_SHELVES,
  achievementDefinition,
  describeAchievements,
  levelForPoints,
  type ParticipantMetrics,
  pointsFor,
  reachedAchievementIds,
  toUnlocked,
} from "./achievements.ts";
import { LogicPacksAccess } from "./LogicPacksAccess.ts";
import { isMemberInstanceId, isOwnMemberInstance } from "./memberProviders.ts";
import { memberUserIdFromSubject } from "./projectAccess.ts";
import { ProviderTurnLedger, type CompletedTurn } from "./turnLedger.ts";
import {
  buildLeaderboard,
  canSeeParticipant,
  displayNameFor,
  streaks,
  type UsageAggregateRow,
  utcDay,
} from "./usageLeaderboard.ts";

/** Who is asking: a member by user id, or the host operator. */
export interface UsageCaller {
  readonly participantId: string;
  readonly isOperator: boolean;
}

export const operatorCaller: UsageCaller = {
  participantId: LP_HOST_PARTICIPANT_ID,
  isOperator: true,
};

export const callerFromSubject = (subject: string): UsageCaller => {
  const userId = memberUserIdFromSubject(subject);
  return userId === null ? operatorCaller : { participantId: userId, isOperator: false };
};

/** Activity the server sees itself, plus the kinds callers report for themselves. */
export type ActivityKind =
  | "thread.created"
  | "project.synced"
  | LpReportableActivityKind;

export class LogicPacksUsage extends Context.Service<
  LogicPacksUsage,
  {
    readonly recordTurn: (turn: CompletedTurn) => Effect.Effect<void>;
    /** Sees every authorized RPC: who starts threads and sends messages. */
    readonly observeRpc: (
      caller: UsageCaller,
      method: string,
      payload: unknown,
      result?: unknown,
    ) => Effect.Effect<void>;
    readonly recordActivity: (input: {
      readonly participantId: string;
      readonly kind: ActivityKind;
      readonly subject: string;
      readonly projectId?: string | null | undefined;
    }) => Effect.Effect<ReadonlyArray<LpUnlockedAchievement>, LpUsageError>;
    readonly leaderboard: (input: {
      readonly caller: UsageCaller;
      readonly range: LpLeaderboardRange;
      readonly projectId: string | null;
      readonly projectTitles: ReadonlyMap<string, string>;
    }) => Effect.Effect<LpLeaderboard, LpUsageError>;
    readonly achievements: (input: {
      readonly caller: UsageCaller;
      readonly participantId?: string | undefined;
    }) => Effect.Effect<LpAchievements, LpUsageError>;
    readonly setSharing: (
      caller: UsageCaller,
      shareUsage: boolean,
    ) => Effect.Effect<LpUsageSharing, LpUsageError>;
    /** Re-checks a participant's achievements and stores any newly reached. */
    readonly evaluate: (
      participantId: string,
    ) => Effect.Effect<ReadonlyArray<LpUnlockedAchievement>, LpUsageError>;
  }
>()("logicpacks/logicpacks/LogicPacksUsage") {}

const storage = (operation: string) => (cause: unknown) =>
  new LpUsageError({
    reason: "storage",
    message: `LogicPacks usage storage failed during ${operation}: ${String(cause)}`,
  });

/** Kept outside upstream's numbered migrations so upstream merges never collide with these tables. */
const ensureSchema = (sql: SqlClient.SqlClient) =>
  Effect.all(
    [
      sql`
        CREATE TABLE IF NOT EXISTS logicpacks_turn_usage (
          turn_key TEXT PRIMARY KEY,
          participant_id TEXT NOT NULL,
          occurred_at TEXT NOT NULL,
          day TEXT NOT NULL,
          project_id TEXT,
          thread_id TEXT NOT NULL,
          driver TEXT NOT NULL,
          instance_id TEXT NOT NULL,
          model TEXT NOT NULL,
          status TEXT NOT NULL,
          input_tokens INTEGER NOT NULL,
          cached_input_tokens INTEGER NOT NULL,
          cache_creation_tokens INTEGER NOT NULL,
          output_tokens INTEGER NOT NULL,
          reasoning_tokens INTEGER NOT NULL,
          duration_ms INTEGER NOT NULL,
          autonomous INTEGER NOT NULL
        )
      `,
      sql`
        CREATE INDEX IF NOT EXISTS logicpacks_turn_usage_participant_day_idx
        ON logicpacks_turn_usage(participant_id, day)
      `,
      sql`
        CREATE TABLE IF NOT EXISTS logicpacks_thread_actor (
          thread_id TEXT PRIMARY KEY,
          participant_id TEXT NOT NULL,
          project_id TEXT,
          updated_at TEXT NOT NULL
        )
      `,
      sql`
        CREATE TABLE IF NOT EXISTS logicpacks_activity (
          activity_id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          participant_id TEXT NOT NULL,
          subject TEXT NOT NULL,
          project_id TEXT,
          occurred_at TEXT NOT NULL,
          UNIQUE (kind, participant_id, subject)
        )
      `,
      sql`
        CREATE TABLE IF NOT EXISTS logicpacks_achievements (
          participant_id TEXT NOT NULL,
          achievement_id TEXT NOT NULL,
          unlocked_at TEXT NOT NULL,
          PRIMARY KEY (participant_id, achievement_id)
        )
      `,
      sql`
        CREATE TABLE IF NOT EXISTS logicpacks_usage_sharing (
          participant_id TEXT PRIMARY KEY,
          share_usage INTEGER NOT NULL,
          updated_at TEXT NOT NULL
        )
      `,
    ],
    { discard: true },
  );

interface AggregateSqlRow {
  readonly participant_id: string;
  readonly day: string;
  readonly project_id: string | null;
  readonly driver: string;
  readonly model: string;
  readonly turns: number;
  readonly input_tokens: number;
  readonly cached_input_tokens: number;
  readonly cache_creation_tokens: number;
  readonly output_tokens: number;
  readonly duration_ms: number;
  readonly autonomous_turns: number;
  readonly last_at: string;
}

const RATES_TTL_MS = 10 * 60_000;
const decodeRatesCache = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ document: Schema.Unknown })),
);

/** Prices a turn group with the rate table the Usage page keeps on disk. */
export const priceAggregate = (
  rates: RateTable,
  row: Omit<UsageAggregateRow, "costUsd">,
): number | null => {
  if (rates.size === 0) return null;
  const priced = priceUsage(rates, {
    model: row.model,
    totals: {
      uncachedInputTokens: Math.max(
        0,
        row.inputTokens - row.cachedInputTokens - row.cacheCreationTokens,
      ),
      cachedInputTokens: row.cachedInputTokens,
      cacheCreationTokens: row.cacheCreationTokens,
      outputTokens: row.outputTokens,
      reasoningTokens: 0,
    },
    speed: "standard",
    reportedCostUsd: null,
  });
  return priced.costSource === "unpriced" ? null : priced.costUsd;
};

/** What a stored message or thread command says about who is driving a thread. */
export const threadCommandFrom = (
  method: string,
  payload: unknown,
  result?: unknown,
): {
  readonly kind: "create" | "message";
  readonly threadId: string;
  readonly projectId: string | null;
} | null => {
  if (payload === null || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  // The composer's first send creates the thread and its first message in one call;
  // the new thread's id is only in the result.
  if (method === "orchestration.launchThread") {
    const launched =
      result !== null && typeof result === "object"
        ? (result as Record<string, unknown>)["threadId"]
        : undefined;
    const threadId = typeof launched === "string" ? launched : record["threadId"];
    const projectId = record["projectId"];
    return typeof threadId === "string" && threadId.length > 0
      ? { kind: "create", threadId, projectId: typeof projectId === "string" ? projectId : null }
      : null;
  }
  if (method !== "orchestration.dispatchCommand") return null;
  const threadId = record["threadId"];
  if (typeof threadId !== "string" || threadId.length === 0) return null;
  const projectId = typeof record["projectId"] === "string" ? record["projectId"] : null;
  if (record["type"] === "thread.create") return { kind: "create", threadId, projectId };
  if (record["type"] === "message.dispatch") return { kind: "message", threadId, projectId };
  return null;
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const access = yield* LogicPacksAccess;
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* ensureSchema(sql).pipe(Effect.mapError(storage("schema setup")));

  // thread -> the person last driving it, and its project.
  const threadActors = new Map<
    string,
    { readonly participantId: string; readonly projectId: string | null }
  >();
  for (const row of yield* sql<{
    readonly thread_id: string;
    readonly participant_id: string;
    readonly project_id: string | null;
  }>`
    SELECT thread_id, participant_id, project_id FROM logicpacks_thread_actor
  `.pipe(Effect.mapError(storage("loading thread actors")))) {
    threadActors.set(row.thread_id, {
      participantId: row.participant_id,
      projectId: row.project_id,
    });
  }

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const nowDate = Clock.currentTimeMillis.pipe(
    Effect.map((ms) => DateTime.toDateUtc(DateTime.makeUnsafe(ms))),
  );

  // Member instance ids are a hash of the user id; resolve them back through the user list.
  const instanceOwner = Effect.fn("LogicPacksUsage.instanceOwner")(function* (instanceId: string) {
    if (!isMemberInstanceId(instanceId)) return LP_HOST_PARTICIPANT_ID;
    const users = yield* access.listUsers().pipe(Effect.orElseSucceed(() => []));
    const owner = users.find((user) => isOwnMemberInstance(instanceId, user.userId));
    return owner?.userId ?? LP_HOST_PARTICIPANT_ID;
  });

  const threadProject = (threadId: string) =>
    sql<{ readonly project_id: string }>`
      SELECT project_id FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}
    `.pipe(
      Effect.map((rows) => rows[0]?.project_id ?? null),
      Effect.orElseSucceed(() => null),
    );

  let rates: RateTable = new Map();
  let ratesLoadedAtMs = 0;
  const loadRates = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    if (now - ratesLoadedAtMs < RATES_TTL_MS && rates.size > 0) return rates;
    ratesLoadedAtMs = now;
    // A missing or damaged cache prices nothing until the Usage page refreshes it.
    const cached = yield* fileSystem
      .readFileString(path.join(config.stateDir, "usage-model-rates.json"))
      .pipe(
        Effect.flatMap(decodeRatesCache),
        Effect.orElseSucceed(() => null),
      );
    if (cached === null) return rates;
    const parsed = parseRateTable(cached.document);
    if (parsed.size > 0) rates = parsed;
    return rates;
  });

  const readSharing = sql<{ readonly participant_id: string; readonly share_usage: number }>`
    SELECT participant_id, share_usage FROM logicpacks_usage_sharing
  `.pipe(
    Effect.map(
      (rows) =>
        new Map<string, LpUsageSharing>(
          rows.map((row) => [
            row.participant_id,
            { shareUsage: row.share_usage === 1, isDecided: true },
          ]),
        ),
    ),
    Effect.mapError(storage("reading usage sharing")),
  );

  const readUnlocked = (participantId?: string) =>
    (participantId === undefined
      ? sql<{
          readonly participant_id: string;
          readonly achievement_id: string;
          readonly unlocked_at: string;
        }>`SELECT participant_id, achievement_id, unlocked_at FROM logicpacks_achievements`
      : sql<{
          readonly participant_id: string;
          readonly achievement_id: string;
          readonly unlocked_at: string;
        }>`
          SELECT participant_id, achievement_id, unlocked_at FROM logicpacks_achievements
          WHERE participant_id = ${participantId}
        `
    ).pipe(
      Effect.map((rows) => {
        const byParticipant = new Map<string, Array<LpUnlockedAchievement>>();
        for (const row of rows) {
          const definition = achievementDefinition(row.achievement_id);
          if (definition === null) continue;
          const list = byParticipant.get(row.participant_id) ?? [];
          list.push(toUnlocked(definition, row.unlocked_at));
          byParticipant.set(row.participant_id, list);
        }
        return byParticipant;
      }),
      Effect.mapError(storage("reading achievements")),
    );

  const countActivity = (participantId: string, kind: ActivityKind) =>
    sql<{ readonly total: number }>`
      SELECT COUNT(*) AS total FROM logicpacks_activity
      WHERE participant_id = ${participantId} AND kind = ${kind}
    `.pipe(Effect.map((rows) => Number(rows[0]?.total ?? 0)));

  /** Projects where the participant started a thread or ran a turn. */
  const workedProjects = (participantId: string) =>
    sql<{ readonly project_id: string }>`
      SELECT DISTINCT project_id FROM logicpacks_turn_usage
      WHERE participant_id = ${participantId} AND project_id IS NOT NULL
      UNION
      SELECT DISTINCT project_id FROM logicpacks_activity
      WHERE participant_id = ${participantId} AND kind = 'thread.created' AND project_id IS NOT NULL
    `.pipe(Effect.map((rows) => new Set(rows.map((row) => row.project_id))));

  const metricsFor = Effect.fn("LogicPacksUsage.metricsFor")(function* (participantId: string) {
    const totals = yield* sql<{
      readonly turns: number;
      readonly tokens: number;
      readonly duration_ms: number;
      readonly models: number;
      readonly drivers: number;
    }>`
      SELECT COUNT(*) AS turns,
             COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens,
             COALESCE(SUM(duration_ms), 0) AS duration_ms,
             COUNT(DISTINCT model) AS models,
             COUNT(DISTINCT driver) AS drivers
      FROM logicpacks_turn_usage WHERE participant_id = ${participantId}
    `;
    const days = yield* sql<{ readonly day: string }>`
      SELECT DISTINCT day FROM logicpacks_turn_usage WHERE participant_id = ${participantId}
    `;
    const isHost = participantId === LP_HOST_PARTICIPANT_ID;
    // Rows the participant added as plain members: the projects they shared.
    const shared = yield* sql<{ readonly project_id: string; readonly user_id: string }>`
      SELECT project_id, user_id FROM logicpacks_project_access
      WHERE role = 'member'
        AND ((${isHost ? 1 : 0} = 1 AND added_by IS NULL) OR added_by = ${participantId})
        AND user_id != ${participantId}
    `;
    let inviteesJoined = 0;
    for (const row of shared) {
      if ((yield* workedProjects(row.user_id)).has(row.project_id)) inviteesJoined += 1;
    }
    const worked = yield* workedProjects(participantId);
    const memberOf = isHost
      ? []
      : yield* sql<{ readonly project_id: string }>`
          SELECT project_id FROM logicpacks_project_access
          WHERE user_id = ${participantId} AND role = 'member'
        `;
    const sharedProjects = new Set(
      (yield* sql<{ readonly project_id: string }>`
        SELECT DISTINCT project_id FROM logicpacks_project_access WHERE role = 'member'
      `).map((row) => row.project_id),
    );
    const threads = yield* sql<{ readonly project_id: string | null }>`
      SELECT project_id FROM logicpacks_activity
      WHERE participant_id = ${participantId} AND kind = 'thread.created'
    `;
    const total = totals[0];
    return {
      turns: Number(total?.turns ?? 0),
      tokens: Number(total?.tokens ?? 0),
      longestStreakDays: streaks(
        days.map((row) => row.day),
        yield* nowDate,
      ).longest,
      agentHours: Number(total?.duration_ms ?? 0) / 3_600_000,
      distinctModels: Number(total?.models ?? 0),
      distinctDrivers: Number(total?.drivers ?? 0),
      projectsSynced: yield* countActivity(participantId, "project.synced"),
      invitesAccepted: memberOf.filter((row) => worked.has(row.project_id)).length,
      inviteesJoined,
      projectsShared: new Set(shared.map((row) => row.project_id)).size,
      threadsShared: threads.filter(
        (row) => row.project_id !== null && sharedProjects.has(row.project_id),
      ).length,
      conflictsResolved: yield* countActivity(participantId, "conflict.resolved"),
      helperSessionsLinked: yield* countActivity(participantId, "helper.session_linked"),
    } satisfies ParticipantMetrics;
  });

  const evaluate = Effect.fn("LogicPacksUsage.evaluate")(function* (participantId: string) {
    const metrics = yield* metricsFor(participantId).pipe(
      Effect.mapError(storage("measuring achievements")),
    );
    const already = new Set(
      (yield* readUnlocked(participantId)).get(participantId)?.map((item) => item.id) ?? [],
    );
    const unlockedAt = yield* nowIso;
    const fresh: Array<LpUnlockedAchievement> = [];
    for (const id of reachedAchievementIds(metrics)) {
      if (already.has(id)) continue;
      const definition = achievementDefinition(id);
      if (definition === null) continue;
      yield* sql`
        INSERT INTO logicpacks_achievements (participant_id, achievement_id, unlocked_at)
        VALUES (${participantId}, ${id}, ${unlockedAt})
        ON CONFLICT (participant_id, achievement_id) DO NOTHING
      `.pipe(Effect.mapError(storage("awarding an achievement")));
      fresh.push(toUnlocked(definition, unlockedAt));
    }
    return fresh;
  });

  /** A turn or thread in a shared project can unlock "invite accepted" for whoever shared it. */
  const evaluateWithInviters = Effect.fn("LogicPacksUsage.evaluateWithInviters")(function* (
    participantId: string,
    projectId: string | null,
  ) {
    yield* evaluate(participantId);
    if (projectId === null || participantId === LP_HOST_PARTICIPANT_ID) return;
    const inviters = yield* sql<{ readonly added_by: string | null }>`
        SELECT added_by FROM logicpacks_project_access
        WHERE project_id = ${projectId} AND user_id = ${participantId} AND role = 'member'
      `.pipe(Effect.mapError(storage("reading who shared a project")));
    for (const row of inviters) {
      const inviter = row.added_by ?? LP_HOST_PARTICIPANT_ID;
      if (inviter !== participantId) yield* evaluate(inviter);
    }
  });

  const rememberThreadActor = Effect.fn("LogicPacksUsage.rememberThreadActor")(function* (
    threadId: string,
    participantId: string,
    projectId: string | null,
  ) {
    const known = threadActors.get(threadId);
    if (
      known?.participantId === participantId &&
      (projectId === null || known.projectId === projectId)
    ) {
      return;
    }
    threadActors.set(threadId, { participantId, projectId: projectId ?? known?.projectId ?? null });
    yield* sql`
      INSERT INTO logicpacks_thread_actor (thread_id, participant_id, project_id, updated_at)
      VALUES (${threadId}, ${participantId}, ${projectId}, ${yield* nowIso})
      ON CONFLICT (thread_id) DO UPDATE SET
        participant_id = excluded.participant_id,
        project_id = COALESCE(excluded.project_id, logicpacks_thread_actor.project_id),
        updated_at = excluded.updated_at
    `;
  });

  const recordActivity = Effect.fn("LogicPacksUsage.recordActivity")(function* (input: {
    readonly participantId: string;
    readonly kind: ActivityKind;
    readonly subject: string;
    readonly projectId?: string | null | undefined;
  }) {
    yield* sql`
      INSERT INTO logicpacks_activity (activity_id, kind, participant_id, subject, project_id, occurred_at)
      VALUES (${NodeCrypto.randomUUID()}, ${input.kind}, ${input.participantId}, ${input.subject},
              ${input.projectId ?? null}, ${yield* nowIso})
      ON CONFLICT (kind, participant_id, subject) DO NOTHING
    `.pipe(Effect.mapError(storage("recording activity")));
    return yield* evaluate(input.participantId);
  });

  const recordTurn = Effect.fn("LogicPacksUsage.recordTurn")(
    function* (turn: CompletedTurn) {
      const actor = threadActors.get(turn.threadId);
      const participantId = actor?.participantId ?? (yield* instanceOwner(turn.providerInstanceId));
      const projectId = (yield* threadProject(turn.threadId)) ?? actor?.projectId ?? null;
      const completedAtMs = turn.completedAtMs ?? (yield* Clock.currentTimeMillis);
      const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe(completedAtMs));
      const durationMs =
        turn.startedAtMs === null ? 0 : Math.max(0, completedAtMs - turn.startedAtMs);
      yield* sql`
        INSERT INTO logicpacks_turn_usage (
          turn_key, participant_id, occurred_at, day, project_id, thread_id, driver, instance_id,
          model, status, input_tokens, cached_input_tokens, cache_creation_tokens, output_tokens,
          reasoning_tokens, duration_ms, autonomous
        ) VALUES (
          ${`${turn.providerInstanceId}:${turn.providerTurnId}`}, ${participantId},
          ${occurredAt.toISOString()}, ${utcDay(occurredAt)}, ${projectId}, ${turn.threadId},
          ${turn.driver}, ${turn.providerInstanceId}, ${turn.model ?? "unknown"}, ${turn.status},
          ${turn.inputTokens}, ${turn.cachedInputTokens}, ${turn.cacheCreationTokens},
          ${turn.outputTokens}, ${turn.reasoningTokens}, ${durationMs}, ${turn.autonomous ? 1 : 0}
        )
        ON CONFLICT (turn_key) DO NOTHING
      `;
      yield* evaluateWithInviters(participantId, projectId);
    },
    Effect.catchCause((cause) =>
      Effect.logWarning("LogicPacks could not record turn usage", { cause }),
    ),
  );

  const observeRpc = (caller: UsageCaller, method: string, payload: unknown, result?: unknown) => {
    const command = threadCommandFrom(method, payload, result);
    if (command === null) return Effect.void;
    return Effect.gen(function* () {
      const projectId = command.projectId ?? (yield* threadProject(command.threadId));
      yield* rememberThreadActor(command.threadId, caller.participantId, projectId);
      if (command.kind === "create") {
        // A fast first turn can finish before the launch response is observed; it was the
        // creator's all along, since nobody else had sent anything to the new thread.
        yield* sql`
          UPDATE logicpacks_turn_usage
          SET participant_id = ${caller.participantId},
              project_id = COALESCE(project_id, ${projectId})
          WHERE thread_id = ${command.threadId}
        `;
        yield* recordActivity({
          participantId: caller.participantId,
          kind: "thread.created",
          subject: command.threadId,
          projectId,
        });
        yield* evaluateWithInviters(caller.participantId, projectId);
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("LogicPacks could not record thread activity", { cause }),
      ),
    );
  };

  const participantNames = Effect.gen(function* () {
    const users = yield* access.listUsers();
    const names = new Map<string, string>(users.map((user) => [user.userId, user.displayName]));
    return names;
  });

  const readAggregates = Effect.gen(function* () {
    const table = yield* loadRates;
    const rows = yield* sql<AggregateSqlRow>`
      SELECT participant_id, day, project_id, driver, model,
             COUNT(*) AS turns,
             SUM(input_tokens) AS input_tokens,
             SUM(cached_input_tokens) AS cached_input_tokens,
             SUM(cache_creation_tokens) AS cache_creation_tokens,
             SUM(output_tokens) AS output_tokens,
             SUM(duration_ms) AS duration_ms,
             SUM(autonomous) AS autonomous_turns,
             MAX(occurred_at) AS last_at
      FROM logicpacks_turn_usage
      GROUP BY participant_id, day, project_id, driver, model
    `.pipe(Effect.mapError(storage("reading turn usage")));
    return rows.map((row): UsageAggregateRow => {
      const base = {
        participantId: row.participant_id,
        day: row.day,
        projectId: row.project_id,
        driver: row.driver,
        model: row.model,
        turns: Number(row.turns),
        inputTokens: Number(row.input_tokens),
        cachedInputTokens: Number(row.cached_input_tokens),
        cacheCreationTokens: Number(row.cache_creation_tokens),
        outputTokens: Number(row.output_tokens),
        durationMs: Number(row.duration_ms),
        autonomousTurns: Number(row.autonomous_turns),
        lastAt: row.last_at,
      };
      return { ...base, costUsd: priceAggregate(table, base) };
    });
  });

  const leaderboard = Effect.fn("LogicPacksUsage.leaderboard")(function* (input: {
    readonly caller: UsageCaller;
    readonly range: LpLeaderboardRange;
    readonly projectId: string | null;
    readonly projectTitles: ReadonlyMap<string, string>;
  }) {
    const rows = yield* readAggregates;
    // Awarding is idempotent; re-checking here backfills anything a missed event left out.
    const participants = new Set(rows.map((row) => row.participantId));
    participants.add(input.caller.participantId);
    for (const participantId of participants) yield* evaluate(participantId);
    const names = yield* participantNames.pipe(Effect.mapError(storage("reading members")));
    return buildLeaderboard({
      rows,
      names,
      viewer: input.caller,
      sharing: yield* readSharing,
      visibleProjectIds: input.caller.isOperator
        ? null
        : access.visibleProjectIds(input.caller.participantId),
      projectTitles: input.projectTitles,
      unlocked: yield* readUnlocked(),
      now: yield* nowDate,
      range: input.range,
      projectId: input.projectId,
    });
  });

  const achievements = Effect.fn("LogicPacksUsage.achievements")(function* (input: {
    readonly caller: UsageCaller;
    readonly participantId?: string | undefined;
  }) {
    const participantId = input.participantId ?? input.caller.participantId;
    const names = yield* participantNames.pipe(Effect.mapError(storage("reading members")));
    if (participantId !== LP_HOST_PARTICIPANT_ID && !names.has(participantId)) {
      return yield* new LpUsageError({ reason: "not_found", message: "No such participant." });
    }
    // Badges reveal usage levels, so a private profile stays private like its numbers.
    if (!canSeeParticipant(input.caller, participantId, yield* readSharing)) {
      return yield* new LpUsageError({
        reason: "not_found",
        message: "This teammate keeps their activity private.",
      });
    }
    yield* evaluate(participantId);
    const metrics = yield* metricsFor(participantId).pipe(
      Effect.mapError(storage("measuring achievements")),
    );
    const unlocked = (yield* readUnlocked(participantId)).get(participantId) ?? [];
    const unlockedAt = new Map(unlocked.map((item) => [item.id, item.unlockedAt]));
    const points = pointsFor(unlockedAt.keys());
    return {
      participantId,
      displayName: displayNameFor(names, participantId),
      points,
      ...levelForPoints(points),
      shelves: ACHIEVEMENT_SHELVES,
      achievements: describeAchievements(metrics, unlockedAt),
    } satisfies LpAchievements;
  });

  const setSharing = Effect.fn("LogicPacksUsage.setSharing")(function* (
    caller: UsageCaller,
    shareUsage: boolean,
  ) {
    yield* sql`
      INSERT INTO logicpacks_usage_sharing (participant_id, share_usage, updated_at)
      VALUES (${caller.participantId}, ${shareUsage ? 1 : 0}, ${yield* nowIso})
      ON CONFLICT (participant_id) DO UPDATE SET
        share_usage = excluded.share_usage,
        updated_at = excluded.updated_at
    `.pipe(Effect.mapError(storage("saving usage sharing")));
    return { shareUsage, isDecided: true } satisfies LpUsageSharing;
  });

  return LogicPacksUsage.of({
    recordTurn,
    observeRpc,
    recordActivity,
    leaderboard,
    achievements,
    setSharing,
    evaluate,
  });
});

export const layer = Layer.effect(LogicPacksUsage, make);

/** Feeds finished provider turns from the orchestration ingestor into the ledger. */
export const layerTurnLedger = Layer.effect(
  ProviderTurnLedger,
  Effect.gen(function* () {
    const usage = yield* LogicPacksUsage;
    return { record: usage.recordTurn };
  }),
);
