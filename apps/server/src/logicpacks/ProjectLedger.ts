// @effect-diagnostics-next-line nodeBuiltinImport:off -- random ids for ledger rows, no Effect needed.
import * as NodeCrypto from "node:crypto";

import {
  CommandId,
  LP_HOST_PARTICIPANT_ID,
  MessageId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadShell,
  type PresenceEntry,
  type ProjectId,
  type ThreadId,
} from "@logicpacks/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { forkParked } from "../serverActivation.ts";
import {
  addMember,
  clip,
  conflictParties,
  describeConflict,
  describeThread,
  recordFile,
  resolveTarget,
  summarizeGoal,
  turnContextText,
  whoIsWorkingOn,
  type LedgerConflict,
  type LedgerDecision,
  type LedgerMessage,
  type LedgerPerson,
  type LedgerThread,
} from "./ledger.ts";
import { goalTurnLines, type Goal } from "./goals.ts";
import { LogicPacksAccess } from "./LogicPacksAccess.ts";
import { externalTurnLines } from "./externalTeam.ts";
import { ExternalTeamService } from "./ExternalTeamService.ts";
import { LogicPacksSync } from "./LogicPacksSync.ts";
import { isMemberInstanceId, isOwnMemberInstance } from "./memberProviders.ts";
import {
  decide as decideNegotiation,
  isActive,
  NegotiationError,
  negotiationLinesFor,
  recordMerge as recordNegotiationMerge,
  startNegotiation,
  submitPosition,
  tick as tickNegotiation,
  type Negotiation,
  type NegotiationChoice,
  type NegotiationEffect,
  type NegotiationPosition,
  type Transition,
} from "./negotiation.ts";
import { hostDisplayName } from "./presenceConnection.ts";
import {
  readPreserved,
  readProjectFile,
  savePreserved,
  unionMerge,
  writeProjectFile,
  type PreservedVersion,
} from "./preservedVersions.ts";
import { PresenceService } from "./PresenceService.ts";
import { sharedAppContextFor } from "./sharedAppContext.ts";
import { ProjectLedgerTurnContext } from "./turnContext.ts";

export class LedgerError extends Schema.TaggedError<LedgerError>()("LedgerError", {
  reason: Schema.Literals(["not_found", "invalid", "forbidden"]),
  message: Schema.String,
}) {}

const fail = (reason: LedgerError["reason"], message: string) =>
  Effect.fail(new LedgerError({ reason, message }));

const decodeRow = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const encodeRow = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** Runs a pure negotiation rule; its refusals become ledger errors. */
const attempt = <A>(run: () => A) =>
  Effect.try({
    try: run,
    catch: (error) =>
      new LedgerError({
        reason: "invalid",
        message: error instanceof NegotiationError ? error.message : String(error),
      }),
  });

const newId = (prefix: string) => `${prefix}-${NodeCrypto.randomUUID().slice(0, 8)}`;

type RowKind = "thread" | "message" | "decision" | "conflict" | "negotiation" | "goal";

interface Row {
  readonly kind: RowKind;
  readonly id: string;
  readonly project_id: string;
  readonly body: string;
}

/** Kept outside upstream's numbered migrations, like the other LogicPacks tables. */
const ensureSchema = (sql: SqlClient.SqlClient) =>
  sql`
    CREATE TABLE IF NOT EXISTS logicpacks_ledger (
      kind TEXT NOT NULL,
      id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      body TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (kind, id)
    )
  `;

/**
 * The ledger's state: in memory for every read, written through to SQLite so
 * messages, decisions, conflicts and negotiations survive a restart.
 */
export class LedgerStore extends Context.Service<
  LedgerStore,
  {
    readonly thread: (threadId: string) => LedgerThread | undefined;
    readonly threads: (projectId: string) => ReadonlyArray<LedgerThread>;
    readonly projectIds: () => ReadonlyArray<string>;
    readonly putThread: (thread: LedgerThread, persist?: boolean) => Effect.Effect<void>;
    readonly projectTitle: (projectId: string) => string | null;
    readonly setProjectTitle: (projectId: string, title: string) => void;
    readonly messages: (projectId: string) => ReadonlyArray<LedgerMessage>;
    readonly message: (id: string) => LedgerMessage | undefined;
    readonly putMessage: (message: LedgerMessage) => Effect.Effect<void>;
    readonly decisions: (projectId: string) => ReadonlyArray<LedgerDecision>;
    readonly putDecision: (decision: LedgerDecision) => Effect.Effect<void>;
    readonly conflicts: (projectId: string) => ReadonlyArray<LedgerConflict>;
    readonly conflict: (id: string) => LedgerConflict | undefined;
    readonly putConflict: (conflict: LedgerConflict) => Effect.Effect<void>;
    readonly negotiations: (projectId: string) => ReadonlyArray<Negotiation>;
    readonly negotiation: (id: string) => Negotiation | undefined;
    readonly putNegotiation: (negotiation: Negotiation) => Effect.Effect<void>;
    readonly goals: (projectId: string) => ReadonlyArray<Goal>;
    readonly goal: (id: string) => Goal | undefined;
    readonly putGoal: (goal: Goal) => Effect.Effect<void>;
    /** The summary for a thread's next turn; marks its waiting messages as handed over. */
    readonly forTurn: (threadId: string) => Effect.Effect<string>;
  }
>()("logicpacks/logicpacks/ProjectLedger/LedgerStore") {}

const makeStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* ensureSchema(sql).pipe(Effect.orDie);

  const threads = new Map<string, LedgerThread>();
  const titles = new Map<string, string>();
  const messages = new Map<string, LedgerMessage>();
  const decisions = new Map<string, LedgerDecision>();
  const conflicts = new Map<string, LedgerConflict>();
  const negotiations = new Map<string, Negotiation>();
  const goals = new Map<string, Goal>();
  const maps: Record<RowKind, Map<string, unknown>> = {
    thread: threads,
    message: messages,
    decision: decisions,
    conflict: conflicts,
    negotiation: negotiations,
    goal: goals,
  };

  const rows = yield* sql<Row>`SELECT kind, id, project_id, body FROM logicpacks_ledger`.pipe(
    Effect.orElseSucceed((): ReadonlyArray<Row> => []),
  );
  for (const row of rows) {
    const map = maps[row.kind];
    if (map === undefined) continue;
    // A row this version cannot read is skipped, never fatal.
    const body = decodeRow(row.body);
    if (Option.isSome(body)) map.set(row.id, body.value);
  }

  const write = Effect.fn("LedgerStore.write")(
    function* (kind: RowKind, id: string, projectId: string, body: unknown) {
      const now = yield* Clock.currentTimeMillis;
      const json = encodeRow(body);
      yield* sql`
        INSERT INTO logicpacks_ledger (kind, id, project_id, body, updated_at)
        VALUES (${kind}, ${id}, ${projectId}, ${json}, ${now})
        ON CONFLICT (kind, id) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at
      `;
    },
    Effect.catchCause((cause) => Effect.logWarning("LogicPacks ledger write failed", { cause })),
  );

  const inProject = <A extends { readonly projectId: string }>(
    map: Map<string, A>,
    projectId: string,
  ) => Array.from(map.values()).filter((value) => value.projectId === projectId);

  const store: LedgerStore["Service"] = {
    thread: (threadId) => threads.get(threadId),
    threads: (projectId) => inProject(threads, projectId),
    projectIds: () => Array.from(new Set(Array.from(threads.values(), (t) => t.projectId))),
    putThread: (thread, persist = true) => {
      threads.set(thread.threadId, thread);
      return persist ? write("thread", thread.threadId, thread.projectId, thread) : Effect.void;
    },
    projectTitle: (projectId) => titles.get(projectId) ?? null,
    setProjectTitle: (projectId, title) => {
      titles.set(projectId, title);
    },
    messages: (projectId) =>
      inProject(messages, projectId).sort((a, b) => a.createdAtMs - b.createdAtMs),
    message: (id) => messages.get(id),
    putMessage: (message) => {
      messages.set(message.id, message);
      return write("message", message.id, message.projectId, message);
    },
    decisions: (projectId) => inProject(decisions, projectId).sort((a, b) => a.atMs - b.atMs),
    putDecision: (decision) => {
      decisions.set(decision.id, decision);
      return write("decision", decision.id, decision.projectId, decision);
    },
    conflicts: (projectId) =>
      inProject(conflicts, projectId).sort((a, b) => a.createdAtMs - b.createdAtMs),
    conflict: (id) => conflicts.get(id),
    putConflict: (conflict) => {
      conflicts.set(conflict.id, conflict);
      return write("conflict", conflict.id, conflict.projectId, conflict);
    },
    negotiations: (projectId) =>
      inProject(negotiations, projectId).sort((a, b) => a.createdAtMs - b.createdAtMs),
    negotiation: (id) => negotiations.get(id),
    putNegotiation: (negotiation) => {
      negotiations.set(negotiation.id, negotiation);
      return write("negotiation", negotiation.id, negotiation.projectId, negotiation);
    },
    goals: (projectId) => inProject(goals, projectId).sort((a, b) => a.createdAtMs - b.createdAtMs),
    goal: (id) => goals.get(id),
    putGoal: (goal) => {
      goals.set(goal.id, goal);
      return write("goal", goal.id, goal.projectId, goal);
    },
    forTurn: Effect.fn("LedgerStore.forTurn")(function* (threadId: string) {
      const own = threads.get(threadId);
      if (own === undefined) return "";
      const nowMs = yield* Clock.currentTimeMillis;
      const projectId = own.projectId;
      const inbox = inProject(messages, projectId).filter(
        (message) =>
          message.toThreadId === threadId &&
          message.deliveredAtMs === null &&
          message.kind !== "notice",
      );
      const text = turnContextText({
        ownThreadId: threadId,
        projectTitle: titles.get(projectId) ?? null,
        threads: inProject(threads, projectId),
        inbox,
        conflicts: inProject(conflicts, projectId),
        decisions: inProject(decisions, projectId).sort((a, b) => a.atMs - b.atMs),
        negotiationLines: inProject(negotiations, projectId).flatMap((negotiation) =>
          negotiationLinesFor(negotiation, threadId),
        ),
        goalLines: goalTurnLines(
          inProject(goals, projectId).sort((a, b) => a.createdAtMs - b.createdAtMs),
          threadId,
        ),
        nowMs,
      });
      for (const message of inbox) {
        const delivered = { ...message, deliveredAtMs: nowMs };
        messages.set(message.id, delivered);
        yield* write("message", message.id, projectId, delivered);
      }
      return text;
    }),
  };
  return store;
});

export const layerStore = Layer.effect(LedgerStore, makeStore);

/** Feeds each provider turn the ledger summary; provided to the orchestration runtime. */
export const layerTurnContext = Layer.effect(
  ProjectLedgerTurnContext,
  Effect.gen(function* () {
    const store = yield* LedgerStore;
    const team = Option.getOrNull(yield* Effect.serviceOption(ExternalTeamService));
    const access = Option.getOrNull(yield* Effect.serviceOption(LogicPacksAccess));
    /** A vetted freelancer's agent also gets the brief, milestones and the no-secrets rule. */
    const externalLines = Effect.fn("ProjectLedgerTurnContext.externalLines")(function* (
      threadId: string,
    ) {
      if (team === null) return "";
      const thread = store.thread(threadId);
      const owner = thread?.members[0];
      if (thread === undefined || owner === undefined) return "";
      const user =
        access === null
          ? null
          : yield* access.getUser(owner.id).pipe(Effect.orElseSucceed(() => null));
      const offer = team.externalAccess(
        { userId: owner.id, email: user?.email ?? null },
        thread.projectId,
      );
      return offer === undefined ? "" : externalTurnLines(offer).join("\n");
    });
    return {
      forTurn: Effect.fn("ProjectLedgerTurnContext.forTurn")(
        function* (threadId: string) {
          const ledger = yield* store.forTurn(threadId);
          const external = yield* externalLines(threadId);
          const projectId = store.thread(threadId)?.projectId;
          const shared = projectId === undefined ? "" : sharedAppContextFor(projectId);
          return [ledger, external, shared].filter((part) => part.length > 0).join("\n\n");
        },
        Effect.catchCause((cause) =>
          Effect.logWarning("LogicPacks ledger context skipped", { cause }).pipe(Effect.as("")),
        ),
      ),
    };
  }),
);

// ── The engine ─────────────────────────────────────────────────────────────

export interface ProjectLedgerView {
  readonly projectId: string;
  readonly threads: ReadonlyArray<LedgerThread>;
  readonly conflicts: ReadonlyArray<LedgerConflict>;
  readonly negotiations: ReadonlyArray<Negotiation>;
  readonly decisions: ReadonlyArray<LedgerDecision>;
}

export interface ThreadLedgerView {
  readonly threadId: string;
  readonly projectId: string;
  /** Messages and notices for this thread that nobody here dismissed yet. */
  readonly notices: ReadonlyArray<LedgerMessage>;
  readonly conflicts: ReadonlyArray<LedgerConflict>;
  readonly negotiations: ReadonlyArray<Negotiation>;
}

export class ProjectLedger extends Context.Service<
  ProjectLedger,
  {
    readonly view: (projectId: string) => Effect.Effect<ProjectLedgerView>;
    readonly threadView: (threadId: string) => Effect.Effect<ThreadLedgerView | null>;
    readonly projectOfThread: (threadId: string) => Effect.Effect<string | null>;
    readonly whoIsWorkingOn: (
      projectId: string,
      query: string,
      exceptThreadId?: string | null,
    ) => Effect.Effect<{ readonly answer: string; readonly threads: ReadonlyArray<LedgerThread> }>;
    readonly send: (input: {
      readonly projectId: string;
      readonly fromThreadId: string | null;
      readonly fromName: string;
      readonly to: string;
      readonly text: string;
      readonly replyTo?: string | null | undefined;
      readonly goalTask?: LedgerMessage["goalTask"];
    }) => Effect.Effect<LedgerMessage, LedgerError>;
    readonly markSeen: (threadId: string, messageIds: ReadonlyArray<string>) => Effect.Effect<void>;
    readonly note: (input: {
      readonly threadId: string;
      readonly goal?: string | undefined;
      readonly decision?: string | undefined;
      readonly by: string;
    }) => Effect.Effect<void, LedgerError>;
    readonly proposeMerge: (input: {
      readonly projectId: string;
      readonly callerThreadId: string | null;
      readonly conflictId?: string | undefined;
      readonly threadIds?: ReadonlyArray<string> | undefined;
      readonly people?: ReadonlyArray<string> | undefined;
    }) => Effect.Effect<Negotiation, LedgerError>;
    readonly position: (input: {
      readonly negotiationId: string;
      readonly threadId: string;
      readonly position: NegotiationPosition;
    }) => Effect.Effect<Negotiation, LedgerError>;
    readonly decide: (input: {
      readonly negotiationId: string;
      readonly threadId: string;
      readonly choice: NegotiationChoice;
      readonly by: string;
      readonly override?: boolean | undefined;
    }) => Effect.Effect<Negotiation, LedgerError>;
    readonly recordMerge: (input: {
      readonly negotiationId: string;
      readonly threadId: string;
      readonly ok: boolean;
      readonly branch: string | null;
      readonly summary: string;
    }) => Effect.Effect<Negotiation, LedgerError>;
    /** Who starts threads and writes in them, from the RPC fence. */
    readonly observeRpc: (
      participantId: string,
      method: string,
      payload: unknown,
      result?: unknown,
    ) => Effect.Effect<void>;
    readonly personName: (participantId: string) => Effect.Effect<string>;
    /** Branches a thread into a new chat that carries its context and ledger entry. */
    readonly branch: (input: {
      readonly threadId: string;
      readonly participantId: string;
      readonly title?: string | undefined;
    }) => Effect.Effect<{ readonly threadId: string }, LedgerError>;
    readonly refreshProject: (projectId: string) => Effect.Effect<void>;
    /** Puts one party's saved version of a conflicted file back; the other versions stay saved. */
    readonly restoreVersion: (input: {
      readonly projectId: string;
      readonly conflictId: string;
      readonly versionThreadId: string;
      readonly by: string;
    }) => Effect.Effect<{ readonly path: string }, LedgerError>;
    /** Writes every saved version of a conflicted file into it and resolves the conflict. */
    readonly keepBoth: (input: {
      readonly projectId: string;
      readonly conflictId: string;
      readonly by: string;
    }) => Effect.Effect<{ readonly files: ReadonlyArray<string> }, LedgerError>;
    /** Who may restore a thread's saved version: its people, besides the project owner. */
    readonly threadPeople: (threadId: string) => Effect.Effect<ReadonlyArray<string>>;
  }
>()("logicpacks/logicpacks/ProjectLedger") {}

const SYNC_POLL = Duration.seconds(3);
const NEGOTIATION_TICK = Duration.seconds(5);
const REFRESH_TTL_MS = 2_000;
const OVERLAP_WINDOW_MS = 15 * 60_000;

const epochMs = (value: unknown): number => {
  if (value === null || value === undefined) return 0;
  try {
    return DateTime.toEpochMillis(value as DateTime.DateTime);
  } catch {
    return 0;
  }
};

const make = Effect.gen(function* () {
  const store = yield* LedgerStore;
  const sql = yield* SqlClient.SqlClient;
  const threadsService = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const presence = yield* PresenceService;
  const access = yield* LogicPacksAccess;
  const sync = yield* LogicPacksSync;
  const hostName = yield* hostDisplayName;
  const lane = yield* Semaphore.make(1);
  const now = Clock.currentTimeMillis;

  const personName = Effect.fn("ProjectLedger.personName")(function* (participantId: string) {
    if (participantId === LP_HOST_PARTICIPANT_ID) return hostName;
    const user = yield* access.getUser(participantId).pipe(Effect.orElseSucceed(() => null));
    return user?.displayName ?? "Member";
  });

  const instanceOwner = Effect.fn("ProjectLedger.instanceOwner")(function* (instanceId: string) {
    if (!isMemberInstanceId(instanceId)) return { id: LP_HOST_PARTICIPANT_ID, name: hostName };
    const users = yield* access.listUsers().pipe(Effect.orElseSucceed(() => []));
    const user = users.find((candidate) => isOwnMemberInstance(instanceId, candidate.userId));
    return user === undefined
      ? { id: LP_HOST_PARTICIPANT_ID, name: hostName }
      : { id: user.userId, name: user.displayName };
  });

  /** Outside sessions the helper streams in name their owner themselves. */
  const externalOwner = (threadId: string) =>
    sql<{ readonly owner_key: string; readonly owner_label: string; readonly source: string }>`
      SELECT owner_key, owner_label, source FROM logicpacks_external_sessions WHERE thread_id = ${threadId}
    `.pipe(
      Effect.map((rows) => rows[0] ?? null),
      Effect.orElseSucceed(() => null),
    );

  const fromShell = Effect.fn("ProjectLedger.fromShell")(function* (
    shell: OrchestrationV2ThreadShell,
  ) {
    const existing = store.thread(shell.id);
    const external = yield* externalOwner(shell.id);
    const owner: LedgerPerson =
      external !== null
        ? {
            // The helper stores `user:<id>` (ExternalSessions.ownerKeyOf); older rows used `lp-user:`.
            id: external.owner_key.replace(/^(?:lp-)?user:/, ""),
            name: external.owner_label,
          }
        : yield* instanceOwner(shell.modelSelection.instanceId);
    const members = existing?.members.length ? existing.members : [owner];
    const lastActiveAtMs = Math.max(
      existing?.lastActiveAtMs ?? 0,
      epochMs(shell.latestUserMessageAt),
      epochMs(shell.latestRunStartedAt),
      epochMs(shell.latestRunCompletedAt),
      epochMs(shell.createdAt),
    );
    const latest = shell.latestVisibleMessage;
    const providerGoal = shell.goal?.objective ?? null;
    let goal = existing?.goal ?? null;
    let goalSource = existing?.goalSource ?? "title";
    if (providerGoal !== null && goalSource !== "agent") {
      goal = clip(providerGoal, 140);
      goalSource = "agent";
    } else if (goalSource !== "agent" && latest?.role === "user") {
      const summary = summarizeGoal(latest.text);
      if (summary !== null) {
        goal = summary;
        goalSource = "summary";
      }
    }
    const parent =
      shell.forkedFrom === null || shell.forkedFrom === undefined
        ? null
        : ((shell.forkedFrom as { readonly threadId?: string }).threadId ?? null);
    const parentRecord = parent === null ? undefined : store.thread(parent);
    if (goal === null && parentRecord !== undefined) {
      goal = parentRecord.goal;
      goalSource = parentRecord.goalSource;
    }
    const status =
      shell.activeRunId !== null
        ? shell.pendingRuntimeRequest !== null
          ? "waiting"
          : "working"
        : ("idle" as const);
    const syncBranch = sync.status([shell.projectId])[0]?.branch ?? null;
    const next: LedgerThread = {
      threadId: shell.id,
      projectId: shell.projectId,
      title: shell.title,
      members,
      agent: {
        name:
          external !== null
            ? `${owner.name}'s ${external.source === "codex" ? "Codex" : external.source === "claude" ? "Claude Code" : "agent"}`
            : `${(members[0] ?? owner).name}'s agent`,
        model: shell.modelSelection.model ?? null,
      },
      goal,
      goalSource,
      files:
        existing?.files.length || parentRecord === undefined
          ? (existing?.files ?? [])
          : parentRecord.files,
      branch: shell.branch ?? syncBranch,
      status,
      ...(existing?.ownerConfirmed === true ? { ownerConfirmed: true } : {}),
      lastActiveAtMs,
      branchedFrom: parent,
    };
    // @effect-diagnostics-next-line preferSchemaOverJson:off - a cheap deep compare of plain rows.
    const changed = existing === undefined || JSON.stringify(existing) !== JSON.stringify(next);
    if (changed) yield* store.putThread(next);
  });

  const refreshedAt = new Map<string, number>();
  const refreshProject = Effect.fn("ProjectLedger.refreshProject")(function* (projectId: string) {
    const nowMs = yield* now;
    if (nowMs - (refreshedAt.get(projectId) ?? 0) < REFRESH_TTL_MS) return;
    refreshedAt.set(projectId, nowMs);
    const project = yield* projects.getShell(projectId as ProjectId).pipe(
      Effect.map(Option.getOrNull),
      Effect.orElseSucceed(() => null),
    );
    if (project !== null) store.setProjectTitle(projectId, project.title);
    const shells = yield* threadsService
      .listProjectThreads({ projectId: projectId as ProjectId, includeSubagents: false })
      .pipe(Effect.orElseSucceed((): ReadonlyArray<OrchestrationV2ThreadShell> => []));
    for (const shell of shells) {
      if (shell.deletedAt !== null || shell.archivedAt !== null) continue;
      yield* fromShell(shell);
    }
  });

  const refreshThread = Effect.fn("ProjectLedger.refreshThread")(function* (threadId: string) {
    const shell = yield* threadsService
      .getThreadShell(threadId as ThreadId)
      .pipe(Effect.orElseSucceed(() => null));
    if (shell === null || shell.deletedAt !== null) return null;
    yield* fromShell(shell);
    return shell.projectId as string;
  });

  const projectOfThread = Effect.fn("ProjectLedger.projectOfThread")(function* (threadId: string) {
    const known = store.thread(threadId);
    if (known !== undefined) return known.projectId;
    return yield* refreshThread(threadId);
  });

  // ── Effects of negotiation steps: notices, wakes, decisions ──

  const notice = Effect.fn("ProjectLedger.notice")(function* (
    projectId: string,
    threadIds: ReadonlyArray<string>,
    text: string,
  ) {
    const nowMs = yield* now;
    for (const threadId of threadIds) {
      yield* store.putMessage({
        id: newId("n"),
        projectId,
        fromThreadId: null,
        fromName: "LogicPacks",
        toThreadId: threadId,
        text,
        kind: "notice",
        replyTo: null,
        createdAtMs: nowMs,
        deliveredAtMs: null,
        seenAtMs: null,
      });
    }
  });

  /** Starts (or queues) a turn in a thread so its agent acts on the ledger now. */
  const wake = Effect.fn("ProjectLedger.wake")(function* (
    projectId: string,
    threadId: string,
    text: string,
  ) {
    const id = newId("lp-ledger");
    yield* threadsService
      .sendToThread({
        projectId: projectId as ProjectId,
        commandId: CommandId.make(`command:${id}`),
        threadId: threadId as ThreadId,
        messageId: MessageId.make(`message:${id}`),
        text,
        attachments: [],
        mode: "queue",
        createdBy: "agent",
        creationSource: "server",
      })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("LogicPacks could not wake an agent for a negotiation", {
            threadId,
            cause,
          }),
        ),
      );
  });

  const addDecision = Effect.fn("ProjectLedger.addDecision")(function* (
    projectId: string,
    threadId: string | null,
    text: string,
    by: string,
  ) {
    yield* store.putDecision({
      id: newId("d"),
      projectId,
      threadId,
      text,
      by,
      atMs: yield* now,
    });
  });

  const applyEffects = Effect.fn("ProjectLedger.applyEffects")(function* (
    negotiation: Negotiation,
    effects: ReadonlyArray<NegotiationEffect>,
  ) {
    for (const effect of effects) {
      if (effect.type === "notice") {
        yield* notice(negotiation.projectId, effect.threadIds, effect.text);
      } else if (effect.type === "decision") {
        yield* addDecision(negotiation.projectId, null, effect.text, "LogicPacks");
      }
    }
    // Wakes go last and outside the lane: starting a turn reads the ledger.
    return effects.filter(
      (effect): effect is Extract<NegotiationEffect, { type: "wake" }> => effect.type === "wake",
    );
  });

  /** Runs one negotiation step under the lane, persists it, then wakes agents. */
  const step = Effect.fn("ProjectLedger.step")(function* (
    negotiationId: string,
    run: (negotiation: Negotiation, nowMs: number) => Transition | null,
  ): Effect.fn.Return<Negotiation, LedgerError> {
    const result = yield* lane.withPermits(1)(
      Effect.gen(function* () {
        const current = store.negotiation(negotiationId);
        if (current === undefined) return yield* fail("not_found", "No such negotiation.");
        const nowMs = yield* now;
        const transition = yield* attempt(() => run(current, nowMs));
        if (transition === null) return { negotiation: current, wakes: [] };
        yield* store.putNegotiation(transition.next);
        yield* syncConflictState(transition.next);
        const wakes = yield* applyEffects(transition.next, transition.effects);
        return { negotiation: transition.next, wakes };
      }),
    );
    for (const wakeEffect of result.wakes) {
      yield* wake(result.negotiation.projectId, wakeEffect.threadId, wakeEffect.text);
    }
    return result.negotiation;
  });

  /** A negotiation's conflict follows it: negotiating while active, resolved once merged. */
  const syncConflictState = Effect.fn("ProjectLedger.syncConflictState")(function* (
    negotiation: Negotiation,
  ) {
    if (negotiation.conflictId === null) return;
    const conflict = store.conflict(negotiation.conflictId);
    if (conflict === undefined) return;
    const state =
      negotiation.state === "merged"
        ? ("resolved" as const)
        : isActive(negotiation)
          ? ("negotiating" as const)
          : ("open" as const);
    if (conflict.state === state && conflict.negotiationId === negotiation.id) return;
    yield* store.putConflict({
      ...conflict,
      state,
      negotiationId: negotiation.id,
      resolvedAtMs: state === "resolved" ? yield* now : null,
    });
  });

  // ── Conflicts ──

  /** Where a thread's agent works: its worktree, else the project's own checkout. */
  const projectRootOf = Effect.fn("ProjectLedger.projectRootOf")(function* (projectId: string) {
    const [project] = yield* projects
      .listShells({ projectIds: [projectId as ProjectId] })
      .pipe(Effect.orElseSucceed(() => []));
    return project?.workspaceRoot ?? null;
  });
  const threadRootOf = Effect.fn("ProjectLedger.threadRootOf")(function* (
    threadId: string,
    projectId: string,
  ) {
    const shell = yield* threadsService
      .getThreadShell(threadId as ThreadId)
      .pipe(Effect.orElseSucceed(() => null));
    return shell?.worktreePath ?? (yield* projectRootOf(projectId));
  });

  /** What each agent last wrote, per file: the copy that survives the next writer replacing it. */
  const lastWritten = new Map<string, { readonly content: Buffer; readonly atMs: number }>();
  const writtenKey = (threadId: string, path: string) => `${threadId}\0${path}`;

  const openConflict = Effect.fn("ProjectLedger.openConflict")(function* (input: {
    readonly projectId: string;
    readonly source: LedgerConflict["source"];
    readonly files: ReadonlyArray<string>;
    readonly parties: ReadonlyArray<LedgerThread>;
    readonly people: ReadonlyArray<string>;
    readonly reason: string;
    /** Overlap: the file's path, so every party's last written version is saved. */
    readonly preservePath?: string | undefined;
  }) {
    const nowMs = yield* now;
    const id = newId("c");
    const saved: PreservedVersion[] = [];
    if (input.preservePath !== undefined) {
      const root = yield* projectRootOf(input.projectId);
      for (const party of input.parties) {
        const written = lastWritten.get(writtenKey(party.threadId, input.preservePath));
        if (root === null || written === undefined) continue;
        const version = savePreserved({
          root,
          conflictId: id,
          threadId: party.threadId,
          name: party.members[0]?.name ?? "Someone",
          path: input.preservePath,
          content: written.content,
          // When it was written, so Merge both keeps the earlier writer's lines first.
          nowMs: written.atMs,
        });
        if (version !== null) saved.push(version);
      }
    }
    const localMerge = saved.length >= 2 && (sync.status([input.projectId])[0]?.remoteUrl ?? null) === null;
    const conflict: LedgerConflict = {
      id,
      projectId: input.projectId,
      source: input.source,
      files: input.files,
      parties: input.parties.map((thread) => ({
        threadId: thread.threadId,
        name: thread.members[0]?.name ?? "Someone",
      })),
      people: input.people,
      reason: input.reason,
      state: "open",
      negotiationId: null,
      createdAtMs: nowMs,
      resolvedAtMs: null,
      ...(saved.length === 0 ? {} : { preserved: saved, localMerge }),
    };
    yield* store.putConflict(conflict);
    const offer = localMerge
      ? ` Each person's version is saved: restore one, or press Merge both to keep both in the file.`
      : input.parties.length >= 2
        ? ` Your agent can branch and merge ${input.parties.length > 2 ? `all ${input.parties.length} people's` : "both people's"} work: press Merge both, or ask it.`
        : " Your agent can merge it on a branch: press Merge both, or ask it.";
    yield* notice(
      input.projectId,
      conflict.parties.map((party) => party.threadId),
      `${input.source === "sync" ? "Sync conflict" : "Overlapping work"} in ${input.files.join(", ")}: ${input.reason}${offer}`,
    );
    return conflict;
  });

  const watchSyncConflicts = Effect.gen(function* () {
    const ids = store.projectIds();
    if (ids.length === 0) return;
    for (const status of sync.status(ids)) {
      const open = store
        .conflicts(status.projectId)
        .filter((conflict) => conflict.source === "sync" && conflict.state !== "resolved");
      if (status.state === "conflict" && status.conflictFiles.length > 0) {
        if (open.length > 0) continue;
        yield* refreshProject(status.projectId);
        const threads = store.threads(status.projectId);
        const nowMs = yield* now;
        const parties = conflictParties({
          threads,
          files: status.conflictFiles,
          theirsAuthor: status.theirsAuthor,
          nowMs,
        });
        const local = Array.from(
          new Set(
            parties
              .flatMap((thread) => thread.members.map((member) => member.name))
              .filter((name) => status.theirsAuthor === null || name !== status.theirsAuthor),
          ),
        );
        const people = Array.from(
          new Set([...local, ...(status.theirsAuthor === null ? [] : [status.theirsAuthor])]),
        );
        yield* openConflict({
          projectId: status.projectId,
          source: "sync",
          files: status.conflictFiles,
          parties,
          people,
          reason: `${status.theirsAuthor ?? "A teammate"} pushed changes to the same lines that ${local.join(" and ") || "this checkout"} changed here, so the sync could not rebase them. Nothing was lost: both versions are kept until you choose.`,
        });
      } else if (status.state === "synced" && open.length > 0) {
        for (const conflict of open) {
          const negotiation =
            conflict.negotiationId === null ? undefined : store.negotiation(conflict.negotiationId);
          if (negotiation !== undefined && isActive(negotiation)) continue;
          yield* store.putConflict({ ...conflict, state: "resolved", resolvedAtMs: yield* now });
          yield* notice(
            conflict.projectId,
            conflict.parties.map((party) => party.threadId),
            `The conflict in ${conflict.files.join(", ")} is resolved; the project is in sync again.`,
          );
        }
      }
    }
  });

  /** Two agents editing one file at once: told before it becomes a merge conflict. */
  const checkOverlap = Effect.fn("ProjectLedger.checkOverlap")(function* (
    thread: LedgerThread,
    path: string,
    nowMs: number,
  ) {
    const others = store
      .threads(thread.projectId)
      .filter(
        (other) =>
          other.threadId !== thread.threadId &&
          other.files.some(
            (file) =>
              file.path === path &&
              file.activity === "editing" &&
              nowMs - file.atMs < OVERLAP_WINDOW_MS,
          ),
      );
    if (others.length === 0) return;
    const involved = [thread, ...others];
    const ids = new Set(involved.map((candidate) => candidate.threadId));
    const already = store
      .conflicts(thread.projectId)
      .some(
        (conflict) =>
          conflict.state !== "resolved" &&
          conflict.files.includes(path) &&
          conflict.parties.every((party) => ids.has(party.threadId)) &&
          conflict.parties.length === ids.size,
      );
    if (already) return;
    const names = involved.map((candidate) => candidate.agent?.name ?? "An agent");
    yield* openConflict({
      projectId: thread.projectId,
      source: "overlap",
      files: [path],
      parties: involved,
      people: Array.from(
        new Set(involved.map((candidate) => candidate.members[0]?.name ?? "Someone")),
      ),
      reason: `${names.join(" and ")} are editing it at the same time.`,
      preservePath: path,
    });
  });

  /**
   * An agent just wrote `path`: keep that copy. When the file is already in an open conflict, the
   * writer's saved version moves to what it wrote now, so a later writer never replaces it unseen.
   */
  const rememberWrite = Effect.fn("ProjectLedger.rememberWrite")(function* (
    thread: LedgerThread,
    path: string,
    nowMs: number,
  ) {
    const root = yield* threadRootOf(thread.threadId, thread.projectId);
    const content = root === null ? null : readProjectFile(root, path);
    if (content === null) return;
    lastWritten.set(writtenKey(thread.threadId, path), { content, atMs: nowMs });
    const storeRoot = yield* projectRootOf(thread.projectId);
    if (storeRoot === null) return;
    for (const conflict of store.conflicts(thread.projectId)) {
      if (conflict.state === "resolved" || conflict.preserved === undefined) continue;
      if (!conflict.files.includes(path)) continue;
      const mine = conflict.preserved.find(
        (version) => version.threadId === thread.threadId && version.path === path,
      );
      if (mine === undefined) continue;
      const version = savePreserved({
        root: storeRoot,
        conflictId: conflict.id,
        threadId: thread.threadId,
        name: mine.name,
        path,
        content,
        nowMs,
      });
      if (version === null) continue;
      yield* store.putConflict({
        ...conflict,
        preserved: conflict.preserved.map((existing) => (existing === mine ? version : existing)),
      });
    }
  });

  const onPresence = Effect.fn("ProjectLedger.onPresence")(function* (entry: PresenceEntry) {
    const path = entry.location.path;
    if (entry.threadId === undefined || path === undefined) return;
    let thread = store.thread(entry.threadId);
    if (thread === undefined) {
      yield* refreshThread(entry.threadId);
      thread = store.thread(entry.threadId);
      if (thread === undefined) return;
    }
    const nowMs = yield* now;
    const files = recordFile(thread.files, {
      path,
      activity: entry.location.activity,
      by: entry.actor.name,
      atMs: nowMs,
    });
    const head = thread.files[0];
    const persist =
      head === undefined || head.path !== files[0]?.path || head.activity !== files[0]?.activity;
    yield* store.putThread({ ...thread, files, lastActiveAtMs: nowMs }, persist);
    if (entry.actor.kind === "agent" && entry.location.activity === "editing") {
      yield* rememberWrite(thread, path, nowMs);
      yield* checkOverlap(store.thread(entry.threadId)!, path, nowMs);
    }
  });

  const onDomainEvent = (event: OrchestrationV2DomainEvent) => {
    if (
      event.type === "thread.created" ||
      event.type === "run.created" ||
      event.type === "run.updated"
    ) {
      return refreshThread(event.threadId).pipe(Effect.asVoid);
    }
    return Effect.void;
  };

  yield* forkParked(
    Stream.runForEach(threadsService.streamDomainEvents, (event) =>
      onDomainEvent(event).pipe(
        Effect.catchCause((cause) => Effect.logDebug("Ledger event skipped", { cause })),
      ),
    ),
  );
  yield* forkParked(
    Stream.runForEach(
      presence.stream(() => true),
      (event) =>
        event.type === "upsert"
          ? onPresence(event.entry).pipe(
              Effect.catchCause((cause) => Effect.logDebug("Ledger presence skipped", { cause })),
            )
          : event.type === "snapshot"
            ? Effect.forEach(event.entries, (entry) => onPresence(entry).pipe(Effect.ignore), {
                discard: true,
              })
            : Effect.void,
    ),
  );
  yield* forkParked(
    watchSyncConflicts.pipe(
      Effect.catchCause((cause) => Effect.logDebug("Ledger sync watch skipped", { cause })),
      Effect.delay(SYNC_POLL),
      Effect.forever,
    ),
  );
  yield* forkParked(
    Effect.gen(function* () {
      const nowMs = yield* now;
      for (const projectId of store.projectIds()) {
        for (const negotiation of store.negotiations(projectId)) {
          if (!isActive(negotiation) || nowMs < negotiation.deadlineAtMs) continue;
          yield* step(negotiation.id, (current, at) => tickNegotiation(current, at)).pipe(
            Effect.ignore,
          );
        }
      }
    }).pipe(Effect.delay(NEGOTIATION_TICK), Effect.forever),
  );

  // ── The API ──

  const view = Effect.fn("ProjectLedger.view")(function* (projectId: string) {
    yield* refreshProject(projectId);
    return {
      projectId,
      threads: [...store.threads(projectId)].sort((a, b) => b.lastActiveAtMs - a.lastActiveAtMs),
      conflicts: store.conflicts(projectId),
      negotiations: store.negotiations(projectId),
      decisions: store.decisions(projectId).slice(-20),
    } satisfies ProjectLedgerView;
  });

  const threadView = Effect.fn("ProjectLedger.threadView")(function* (threadId: string) {
    const projectId = yield* projectOfThread(threadId);
    if (projectId === null) return null;
    const nowMs = yield* now;
    return {
      threadId,
      projectId,
      notices: store
        .messages(projectId)
        .filter((message) => message.toThreadId === threadId && message.seenAtMs === null)
        .slice(-20),
      conflicts: store
        .conflicts(projectId)
        .filter(
          (conflict) =>
            conflict.state !== "resolved" &&
            conflict.parties.some((party) => party.threadId === threadId),
        ),
      negotiations: store
        .negotiations(projectId)
        .filter(
          (negotiation) =>
            negotiation.parties.some((party) => party.threadId === threadId) &&
            (isActive(negotiation) ||
              negotiation.state === "timed_out" ||
              nowMs - negotiation.updatedAtMs < 10 * 60_000),
        ),
    } satisfies ThreadLedgerView;
  });

  const whoIs = Effect.fn("ProjectLedger.whoIsWorkingOn")(function* (
    projectId: string,
    query: string,
    exceptThreadId: string | null = null,
  ) {
    yield* refreshProject(projectId);
    const nowMs = yield* now;
    const threads = store.threads(projectId).filter((thread) => thread.threadId !== exceptThreadId);
    const matches = whoIsWorkingOn(threads, query);
    if (matches.length === 0) {
      return {
        answer:
          threads.length === 0
            ? "Nobody else has a thread in this project."
            : `Nobody matches "${query}". Threads: ${threads
                .map((thread) => describeThread(thread, nowMs))
                .join(" | ")}`,
        threads: [],
      };
    }
    return {
      answer: matches
        .map((match) => `${describeThread(match.thread, nowMs)} (matched by ${match.why})`)
        .join("\n"),
      threads: matches.map((match) => match.thread),
    };
  });

  const send = Effect.fn("ProjectLedger.send")(function* (input: {
    readonly projectId: string;
    readonly fromThreadId: string | null;
    readonly fromName: string;
    readonly to: string;
    readonly text: string;
    readonly replyTo?: string | null | undefined;
    readonly goalTask?: LedgerMessage["goalTask"];
  }) {
    const text = input.text.trim();
    if (text.length === 0) return yield* fail("invalid", "The message is empty.");
    if (text.length > 4000) return yield* fail("invalid", "Keep messages under 4000 characters.");
    yield* refreshProject(input.projectId);
    const original =
      input.replyTo === undefined || input.replyTo === null
        ? undefined
        : store.message(input.replyTo);
    if (input.replyTo && (original === undefined || original.projectId !== input.projectId)) {
      return yield* fail("not_found", "The message you reply to was not found.");
    }
    // A reply goes back to the asker's thread, whatever `to` says.
    const target =
      original !== undefined && original.fromThreadId !== null
        ? store.thread(original.fromThreadId)
        : (() => {
            const resolved = resolveTarget(
              store.threads(input.projectId),
              input.to,
              input.fromThreadId,
            );
            return resolved.kind === "thread" ? resolved.thread : undefined;
          })();
    if (target === undefined) {
      const resolved = resolveTarget(store.threads(input.projectId), input.to, input.fromThreadId);
      return yield* fail(
        "not_found",
        resolved.kind === "none" ? resolved.message : "No such thread.",
      );
    }
    if (target.threadId === input.fromThreadId)
      return yield* fail("invalid", "That is this thread.");
    const message: LedgerMessage = {
      id: newId("m"),
      // A reply to an ask from another project lands in the asker's project, where its thread reads it.
      projectId: target.projectId,
      fromThreadId: input.fromThreadId,
      fromName: input.fromName,
      toThreadId: target.threadId,
      text,
      kind: original === undefined ? "ask" : "reply",
      replyTo: original?.id ?? null,
      createdAtMs: yield* now,
      deliveredAtMs: null,
      seenAtMs: null,
      ...(input.goalTask === undefined ? {} : { goalTask: input.goalTask }),
    };
    yield* store.putMessage(message);
    return message;
  });

  const markSeen = Effect.fn("ProjectLedger.markSeen")(function* (
    threadId: string,
    messageIds: ReadonlyArray<string>,
  ) {
    const nowMs = yield* now;
    for (const id of messageIds) {
      const message = store.message(id);
      if (message === undefined || message.toThreadId !== threadId || message.seenAtMs !== null)
        continue;
      yield* store.putMessage({ ...message, seenAtMs: nowMs });
    }
  });

  const note = Effect.fn("ProjectLedger.note")(function* (input: {
    readonly threadId: string;
    readonly goal?: string | undefined;
    readonly decision?: string | undefined;
    readonly by: string;
  }) {
    const projectId = yield* projectOfThread(input.threadId);
    const thread = store.thread(input.threadId);
    if (projectId === null || thread === undefined)
      return yield* fail("not_found", "This thread is not in a project.");
    if (input.goal !== undefined && input.goal.trim().length > 0) {
      yield* store.putThread({ ...thread, goal: clip(input.goal, 140), goalSource: "agent" });
    }
    if (input.decision !== undefined && input.decision.trim().length > 0) {
      yield* addDecision(projectId, input.threadId, clip(input.decision, 400), input.by);
    }
  });

  const proposeMerge = Effect.fn("ProjectLedger.proposeMerge")(function* (input: {
    readonly projectId: string;
    readonly callerThreadId: string | null;
    readonly conflictId?: string | undefined;
    readonly threadIds?: ReadonlyArray<string> | undefined;
    readonly people?: ReadonlyArray<string> | undefined;
  }) {
    yield* refreshProject(input.projectId);
    const threads = store.threads(input.projectId);
    const conflict =
      input.conflictId !== undefined
        ? store.conflict(input.conflictId)
        : store
            .conflicts(input.projectId)
            .findLast(
              (candidate) =>
                candidate.state !== "resolved" &&
                (input.callerThreadId === null ||
                  candidate.parties.some((party) => party.threadId === input.callerThreadId)),
            );
    if (input.conflictId !== undefined && conflict?.projectId !== input.projectId) {
      return yield* fail("not_found", "No such conflict in this project.");
    }
    if (conflict?.negotiationId) {
      const existing = store.negotiation(conflict.negotiationId);
      if (existing !== undefined && isActive(existing)) return existing;
    }
    const wanted = new Map<string, { threadId: string; name: string }>();
    const add = (thread: LedgerThread | undefined) => {
      if (thread !== undefined)
        wanted.set(thread.threadId, {
          threadId: thread.threadId,
          name: thread.members[0]?.name ?? "Someone",
        });
    };
    if (input.callerThreadId !== null) add(store.thread(input.callerThreadId));
    for (const party of conflict?.parties ?? []) add(store.thread(party.threadId));
    for (const id of input.threadIds ?? []) {
      const thread = store.thread(id);
      if (thread === undefined || thread.projectId !== input.projectId)
        return yield* fail("not_found", `No thread ${id} in this project.`);
      add(thread);
    }
    for (const person of input.people ?? []) {
      const resolved = resolveTarget(threads, person, input.callerThreadId);
      if (resolved.kind === "none") return yield* fail("not_found", resolved.message);
      add(resolved.thread);
    }
    const nowMs = yield* now;
    const transition = yield* attempt(() =>
      startNegotiation({
        id: newId("neg"),
        projectId: input.projectId,
        conflictId: conflict?.id ?? null,
        files: conflict?.files ?? [],
        parties: Array.from(wanted.values()),
        proposerThreadId: input.callerThreadId,
        nowMs,
      }),
    );
    yield* store.putNegotiation(transition.next);
    return yield* step(transition.next.id, () => ({
      next: transition.next,
      effects: transition.effects,
    }));
  });

  const observeRpc = Effect.fn("ProjectLedger.observeRpc")(
    function* (participantId: string, method: string, payload: unknown, result?: unknown) {
      if (payload === null || typeof payload !== "object") return;
      const record = payload as Record<string, unknown>;
      let threadId: unknown;
      let text: unknown;
      if (method === "orchestration.launchThread") {
        threadId =
          result !== null && typeof result === "object"
            ? ((result as Record<string, unknown>)["threadId"] ?? record["threadId"])
            : record["threadId"];
        text = (record["initialMessage"] as { readonly text?: unknown } | undefined)?.text;
      } else if (
        method === "orchestration.dispatchCommand" &&
        record["type"] === "message.dispatch"
      ) {
        threadId = record["threadId"];
        text = record["text"];
      } else {
        return;
      }
      if (typeof threadId !== "string" || threadId.length === 0) return;
      const projectId = yield* refreshThread(threadId);
      if (projectId === null) return;
      const thread = store.thread(threadId);
      if (thread === undefined) return;
      const person = { id: participantId, name: yield* personName(participantId) };
      const summary = typeof text === "string" ? summarizeGoal(text) : null;
      // A thread on the host's own provider is first credited to the host; the first
      // person who actually writes in it is its owner.
      const placeholder =
        thread.members.length === 1 &&
        thread.members[0]!.id === LP_HOST_PARTICIPANT_ID &&
        person.id !== LP_HOST_PARTICIPANT_ID &&
        thread.ownerConfirmed !== true;
      yield* store.putThread({
        ...thread,
        members: placeholder ? [person] : addMember(thread.members, person),
        ...(placeholder && thread.agent !== null
          ? { agent: { ...thread.agent, name: `${person.name}'s agent` } }
          : {}),
        ownerConfirmed: true,
        lastActiveAtMs: yield* now,
        ...(summary !== null && thread.goalSource !== "agent"
          ? { goal: summary, goalSource: "summary" as const }
          : {}),
      });
    },
    Effect.catchCause((cause) => Effect.logDebug("Ledger could not record a message", { cause })),
  );

  const branch = Effect.fn("ProjectLedger.branch")(function* (input: {
    readonly threadId: string;
    readonly participantId: string;
    readonly title?: string | undefined;
  }) {
    const source = yield* threadsService
      .getThreadShell(input.threadId as ThreadId)
      .pipe(Effect.orElseSucceed(() => null));
    if (source === null || source.deletedAt !== null)
      return yield* fail("not_found", "No such thread.");
    const id = newId("branch");
    const targetThreadId = `thread:${id}` as ThreadId;
    yield* threadsService
      .dispatch({
        type: "thread.fork",
        commandId: CommandId.make(`command:${id}`),
        sourceThreadId: source.id,
        targetThreadId,
        sourcePoint: { type: "latest_stable" },
        title: clip(input.title?.trim() || `${source.title} (branch)`, 120),
        createdBy: "user",
        creationSource: "web",
      })
      .pipe(
        Effect.mapError(
          (error) =>
            new LedgerError({
              reason: "invalid",
              message: `Could not branch this thread: ${error.message}`,
            }),
        ),
      );
    yield* refreshThread(targetThreadId);
    const created = store.thread(targetThreadId);
    if (created !== undefined) {
      const person = { id: input.participantId, name: yield* personName(input.participantId) };
      // The person who branched owns the new chat; a host placeholder owner is dropped.
      const others = created.members.filter(
        (member) => member.id !== LP_HOST_PARTICIPANT_ID && member.id !== person.id,
      );
      yield* store.putThread({
        ...created,
        members: [person, ...others],
        ...(created.agent === null
          ? {}
          : { agent: { ...created.agent, name: `${person.name}'s agent` } }),
        ownerConfirmed: true,
        branchedFrom: source.id,
      });
    }
    return { threadId: targetThreadId as string };
  });

  /** Roots of every checkout that holds the conflicted file: each party's, plus the project's. */
  const checkoutsOf = Effect.fn("ProjectLedger.checkoutsOf")(function* (conflict: LedgerConflict) {
    const roots = new Set<string>();
    for (const party of conflict.parties) {
      const root = yield* threadRootOf(party.threadId, conflict.projectId);
      if (root !== null) roots.add(root);
    }
    const project = yield* projectRootOf(conflict.projectId);
    if (project !== null) roots.add(project);
    return [...roots];
  });

  const openConflictOf = (projectId: string, conflictId: string) => {
    const conflict = store.conflict(conflictId);
    return conflict === undefined || conflict.projectId !== projectId
      ? fail("not_found", "No such conflict in this project.")
      : Effect.succeed(conflict);
  };

  const restoreVersion = Effect.fn("ProjectLedger.restoreVersion")(function* (input: {
    readonly projectId: string;
    readonly conflictId: string;
    readonly versionThreadId: string;
    readonly by: string;
  }) {
    const conflict = yield* openConflictOf(input.projectId, input.conflictId);
    const version = conflict.preserved?.find((entry) => entry.threadId === input.versionThreadId);
    const storeRoot = yield* projectRootOf(input.projectId);
    const content =
      version === undefined || storeRoot === null
        ? null
        : readPreserved(storeRoot, conflict.id, version);
    if (version === undefined || storeRoot === null || content === null) {
      return yield* fail("not_found", "That saved version is no longer there.");
    }
    const nowMs = yield* now;
    const checkouts = yield* checkoutsOf(conflict);
    for (const root of checkouts) {
      // What is there now stays recoverable too: it may be the other person's newer work.
      const current = readProjectFile(root, version.path);
      if (current !== null && !current.equals(content)) {
        savePreserved({
          root: storeRoot,
          conflictId: conflict.id,
          threadId: `replaced-${nowMs}`,
          name: "Replaced",
          path: version.path,
          content: current,
          nowMs,
        });
      }
      writeProjectFile(root, version.path, content);
    }
    lastWritten.set(writtenKey(version.threadId, version.path), { content, atMs: nowMs });
    yield* notice(
      input.projectId,
      conflict.parties.map((party) => party.threadId),
      `${input.by} restored ${version.name}'s version of ${version.path}. The other saved versions are kept; Merge both still keeps them all.`,
    );
    return { path: version.path };
  });

  const keepBoth = Effect.fn("ProjectLedger.keepBoth")(function* (input: {
    readonly projectId: string;
    readonly conflictId: string;
    readonly by: string;
  }) {
    const conflict = yield* openConflictOf(input.projectId, input.conflictId);
    const storeRoot = yield* projectRootOf(input.projectId);
    const versions = conflict.preserved ?? [];
    if (conflict.state === "resolved" || storeRoot === null || versions.length === 0) {
      return yield* fail("invalid", "There are no saved versions to merge.");
    }
    if (conflict.negotiationId !== null) {
      return yield* fail("invalid", "The agents are already negotiating this one.");
    }
    const nowMs = yield* now;
    const checkouts = yield* checkoutsOf(conflict);
    const merged: string[] = [];
    for (const path of new Set(versions.map((version) => version.path))) {
      const mine = versions.filter((version) => version.path === path);
      if (mine.some((version) => !version.text)) {
        return yield* fail("invalid", `${path} is not a text file: restore one version instead.`);
      }
      const texts = [...mine]
        .sort((a, b) => a.savedAtMs - b.savedAtMs)
        .map((version) => readPreserved(storeRoot, conflict.id, version)?.toString("utf8"))
        .filter((text): text is string => text !== undefined);
      const current = readProjectFile(storeRoot, path);
      // Whatever is on disk now (a later edit) is kept too.
      const body = Buffer.from(
        unionMerge([...texts, ...(current === null ? [] : [current.toString("utf8")])]),
        "utf8",
      );
      for (const root of checkouts) {
        const before = readProjectFile(root, path);
        if (before !== null && !before.equals(body)) {
          savePreserved({
            root: storeRoot,
            conflictId: conflict.id,
            threadId: `replaced-${nowMs}`,
            name: "Replaced",
            path,
            content: before,
            nowMs,
          });
        }
        writeProjectFile(root, path, body);
      }
      merged.push(path);
    }
    yield* store.putConflict({ ...conflict, state: "resolved", resolvedAtMs: nowMs });
    const names = Array.from(new Set(versions.map((version) => version.name)));
    yield* notice(
      input.projectId,
      conflict.parties.map((party) => party.threadId),
      `${input.by} merged ${names.join(" and ")}'s versions of ${merged.join(", ")}: both are in the file now.`,
    );
    yield* addDecision(
      input.projectId,
      null,
      `Kept both ${names.join(" and ")} versions of ${merged.join(", ")}.`,
      input.by,
    );
    return { files: merged };
  });

  const threadPeople = Effect.fn("ProjectLedger.threadPeople")(function* (threadId: string) {
    if (store.thread(threadId) === undefined) yield* refreshThread(threadId);
    return (store.thread(threadId)?.members ?? []).map((member) => member.id);
  });

  return {
    restoreVersion,
    keepBoth,
    threadPeople,
    branch,
    view,
    threadView,
    projectOfThread,
    whoIsWorkingOn: whoIs,
    send,
    markSeen,
    note,
    proposeMerge,
    position: (input) =>
      step(input.negotiationId, (negotiation, nowMs) =>
        submitPosition(negotiation, input.threadId, input.position, nowMs),
      ),
    decide: (input) =>
      step(input.negotiationId, (negotiation, nowMs) =>
        decideNegotiation(negotiation, input.threadId, input.choice, nowMs, {
          ...(input.override === undefined ? {} : { override: input.override }),
          by: input.by,
        }),
      ),
    recordMerge: (input) =>
      step(input.negotiationId, (negotiation, nowMs) =>
        recordNegotiationMerge(
          negotiation,
          input.threadId,
          { ok: input.ok, branch: input.branch, summary: clip(input.summary, 400) },
          nowMs,
        ),
      ),
    observeRpc,
    personName,
    refreshProject,
  } satisfies ProjectLedger["Service"];
});

export const layer = Layer.effect(ProjectLedger, make);

/** Plain-text views agents read. */
export const describeConflicts = (conflicts: ReadonlyArray<LedgerConflict>) =>
  conflicts.length === 0
    ? "No open conflicts."
    : conflicts.map((conflict) => describeConflict(conflict)).join("\n");
