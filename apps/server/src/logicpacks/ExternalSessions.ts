import {
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  EventId,
  LP_HOST_PARTICIPANT_ID,
  OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type PresenceLocation,
  type ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ThreadId,
  TurnItemId,
} from "@logicpacks/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { LogicPacksAccess } from "./LogicPacksAccess.ts";
import { LogicPacksUsage } from "./LogicPacksUsage.ts";
import { describePresence, normalizePresencePath } from "./presence.ts";
import { agentActorFor, HOST_ACTOR_ID, hostDisplayName } from "./presenceConnection.ts";
import { PresenceService } from "./PresenceService.ts";
import { memberSubject } from "./projectAccess.ts";
import {
  type ActivityEntry,
  type ExternalSessionBatch,
  type ExternalSessionLocation,
  type ExternalSessionSource,
  type ProjectCandidate,
  clip,
  deriveTitle,
  externalThreadId,
  isValidSessionId,
  mapExternalEvent,
  matchProject,
  MAX_EVENTS_PER_BATCH,
  parseEventTime,
  pathIsInside,
  projectContextText,
  remoteKey,
  SOURCE_LABEL,
  SOURCE_PROVIDER_INSTANCE,
  sessionLabel,
} from "./externalSessionMapping.ts";

/** Who sent a helper request: a member by user id, or the host operator. */
export type HelperCaller =
  | { readonly kind: "member"; readonly userId: string }
  | { readonly kind: "operator" };

export type IngestResult =
  | {
      readonly linked: true;
      readonly projectId: string;
      readonly threadId: string;
      readonly accepted: number;
      readonly duplicates: number;
    }
  | {
      readonly linked: false;
      readonly reason: "no_project" | "not_shared" | "not_owner" | "thread_deleted";
      readonly message: string;
    };

export interface ExternalSessionSummary {
  readonly threadId: string;
  readonly projectId: string;
  readonly source: ExternalSessionSource;
  readonly who: string;
  readonly device: string | null;
  readonly title: string;
  readonly lastEventAt: string;
}

export interface PresenceEntry {
  readonly threadId: string;
  readonly who: string;
  readonly source: ExternalSessionSource;
  readonly title: string;
  readonly lastActiveAt: string;
  readonly files: ReadonlyArray<{
    readonly path: string;
    readonly action: "editing" | "viewing";
    readonly at: string;
  }>;
}

export class ExternalSessionError extends Schema.TaggedError<ExternalSessionError>()(
  "ExternalSessionError",
  {
    reason: Schema.Literals(["invalid_session", "too_many_events", "storage"]),
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const storage = (operation: string) => (cause: unknown) =>
  new ExternalSessionError({
    reason: "storage",
    message: `External session storage failed during ${operation}.`,
    cause,
  });

const PRESENCE_IDLE_MS = 10 * 60_000;
/**
 * How long an outside agent's live cursor stays after its last streamed event.
 * Longer than a socket's TTL: an agent thinks between tool calls and has no heartbeat.
 */
const LIVE_PRESENCE_TTL_MS = 3 * 60_000;
const NATIVE_ACTIVITY_WINDOW_MS = 30 * 60_000;
const PLACEHOLDER_TITLE_SUFFIX = " session";

interface SessionRow {
  readonly thread_id: string;
  readonly project_id: string;
  readonly source: ExternalSessionSource;
  readonly owner_key: string;
  readonly owner_label: string;
  readonly device: string | null;
  readonly title: string;
  readonly next_ordinal: number;
  readonly last_event_at: string;
}

interface ItemRow {
  readonly ordinal: number;
  readonly status: string;
}

export class ExternalSessions extends Context.Service<
  ExternalSessions,
  {
    readonly resolveProject: (
      caller: HelperCaller,
      location: ExternalSessionLocation,
    ) => Effect.Effect<
      { readonly id: ProjectId; readonly title: string; readonly workspaceRoot: string } | null,
      ExternalSessionError
    >;
    readonly ingest: (
      caller: HelperCaller,
      batch: ExternalSessionBatch,
    ) => Effect.Effect<IngestResult, ExternalSessionError>;
    readonly context: (
      caller: HelperCaller,
      input: ExternalSessionLocation & {
        readonly source?: ExternalSessionSource | undefined;
        readonly sessionId?: string | undefined;
      },
    ) => Effect.Effect<
      | { readonly linked: false; readonly message: string }
      | {
          readonly linked: true;
          readonly projectId: string;
          readonly projectTitle: string;
          readonly synced: boolean;
          readonly text: string;
          readonly conflicts: ReadonlyArray<string>;
        },
      ExternalSessionError
    >;
    readonly presence: (projectId: string) => Effect.Effect<ReadonlyArray<PresenceEntry>>;
    readonly list: (
      projectId: string,
    ) => Effect.Effect<ReadonlyArray<ExternalSessionSummary>, ExternalSessionError>;
  }
>()("logicpacks/logicpacks/ExternalSessions") {}

/** Kept outside upstream's numbered migrations, like the other LogicPacks tables. */
const ensureSchema = (sql: SqlClient.SqlClient) =>
  Effect.all(
    [
      sql`
        CREATE TABLE IF NOT EXISTS logicpacks_external_sessions (
          thread_id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          source TEXT NOT NULL,
          session_id TEXT NOT NULL,
          owner_key TEXT NOT NULL,
          owner_label TEXT NOT NULL,
          device TEXT,
          title TEXT NOT NULL,
          next_ordinal INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          last_event_at TEXT NOT NULL
        )
      `,
      sql`
        CREATE TABLE IF NOT EXISTS logicpacks_external_items (
          thread_id TEXT NOT NULL,
          item_key TEXT NOT NULL,
          ordinal INTEGER NOT NULL,
          status TEXT NOT NULL,
          PRIMARY KEY (thread_id, item_key)
        )
      `,
    ],
    { discard: true },
  );

const decodeAppThread = Schema.decodeUnknownOption(Schema.fromJsonString(OrchestrationV2AppThread));

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const eventSink = yield* EventSink.EventSinkV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const identities = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
  const access = yield* LogicPacksAccess;
  const livePresence = yield* PresenceService;
  const usage = yield* Effect.serviceOption(LogicPacksUsage);
  yield* ensureSchema(sql).pipe(Effect.mapError(storage("schema setup")));

  const ingestLane = yield* Semaphore.make(1);
  let eventCounter = 0;
  // project -> thread -> presence. Live state only: it is rebuilt by the next tool calls after a restart.
  const presenceByProject = new Map<
    string,
    Map<
      string,
      {
        who: string;
        source: ExternalSessionSource;
        title: string;
        lastActiveAt: number;
        files: Map<string, { action: "editing" | "viewing"; at: number }>;
      }
    >
  >();

  const visibleShells = Effect.fn("ExternalSessions.visibleShells")(
    function* (caller: HelperCaller) {
      if (caller.kind === "operator") return yield* projects.listShells();
      const ids = Array.from(access.visibleProjectIds(caller.userId)) as Array<ProjectId>;
      return ids.length === 0 ? [] : yield* projects.listShells({ projectIds: ids });
    },
    Effect.mapError(storage("listing projects")),
  );

  const remoteKeysFor = (workspaceRoot: string) =>
    identities
      .resolve(workspaceRoot)
      .pipe(
        Effect.map((identity) =>
          identity === null
            ? []
            : [remoteKey(identity.locator.remoteUrl), remoteKey(identity.origin?.remoteUrl)].filter(
                (key): key is string => key !== null,
              ),
        ),
      );

  const resolveProject = Effect.fn("ExternalSessions.resolveProject")(function* (
    caller: HelperCaller,
    location: ExternalSessionLocation,
  ) {
    const shells = yield* visibleShells(caller);
    const toCandidate = (shell: (typeof shells)[number], keys: ReadonlyArray<string>) =>
      ({ id: shell.id, workspaceRoot: shell.workspaceRoot, remoteKeys: keys }) as ProjectCandidate;
    const pick = (candidate: ProjectCandidate | null) => {
      const shell = candidate === null ? undefined : shells.find((s) => s.id === candidate.id);
      return shell === undefined
        ? null
        : { id: shell.id, title: shell.title, workspaceRoot: shell.workspaceRoot };
    };
    const byFolder = matchProject(
      { cwd: location.cwd, gitRoot: location.gitRoot ?? null },
      shells.map((shell) => toCandidate(shell, [])),
    );
    if (byFolder !== null || remoteKey(location.gitRemote) === null) return pick(byFolder);
    const syncedRemotes = new Map(
      (yield* sql<{ readonly project_id: string; readonly remote_url: string }>`
        SELECT project_id, remote_url FROM logicpacks_synced_projects
      `.pipe(Effect.mapError(storage("reading synced projects")))).map((row) => [
        row.project_id,
        remoteKey(row.remote_url),
      ]),
    );
    const candidates: Array<ProjectCandidate> = [];
    for (const shell of shells) {
      const synced = syncedRemotes.get(shell.id);
      const keys = yield* remoteKeysFor(shell.workspaceRoot);
      candidates.push(toCandidate(shell, synced ? [synced, ...keys] : keys));
    }
    return pick(matchProject(location, candidates));
  });

  const ownerKeyOf = (caller: HelperCaller) =>
    caller.kind === "member" ? `user:${caller.userId}` : "operator";

  const ownerLabelOf = Effect.fn("ExternalSessions.ownerLabel")(function* (
    caller: HelperCaller,
    device: string | null,
  ) {
    if (caller.kind === "operator") return device ?? "Host owner";
    const user = yield* access.getUser(caller.userId).pipe(Effect.orElseSucceed(() => null));
    return user?.displayName ?? "A teammate";
  });

  const readSession = (threadId: string) =>
    sql<SessionRow>`SELECT * FROM logicpacks_external_sessions WHERE thread_id = ${threadId}`.pipe(
      Effect.map((rows) => rows[0] ?? null),
      Effect.mapError(storage("reading a session")),
    );

  const readThreadPayload = (threadId: string) =>
    sql<{ readonly payload_json: string; readonly deleted_at: string | null }>`
      SELECT payload_json, deleted_at FROM orchestration_v2_projection_threads
      WHERE thread_id = ${threadId}
    `.pipe(
      Effect.map((rows) => rows[0] ?? null),
      Effect.mapError(storage("reading a thread")),
    );

  const touchPresence = (input: {
    readonly projectId: string;
    readonly threadId: string;
    readonly who: string;
    readonly source: ExternalSessionSource;
    readonly title: string;
    readonly at: number;
    readonly files: ReadonlyArray<string>;
    readonly action: "editing" | "viewing";
  }) => {
    const threads = presenceByProject.get(input.projectId) ?? new Map();
    presenceByProject.set(input.projectId, threads);
    const entry = threads.get(input.threadId) ?? {
      who: input.who,
      source: input.source,
      title: input.title,
      lastActiveAt: input.at,
      files: new Map(),
    };
    entry.title = input.title;
    entry.lastActiveAt = Math.max(entry.lastActiveAt, input.at);
    for (const file of input.files) {
      const previous = entry.files.get(file);
      // Editing outranks viewing until the file goes idle.
      const action =
        previous?.action === "editing" && input.at - previous.at < PRESENCE_IDLE_MS
          ? "editing"
          : input.action;
      entry.files.set(file, { action, at: Math.max(previous?.at ?? 0, input.at) });
    }
    threads.set(input.threadId, entry);
  };

  // thread -> where its agent last was, so a batch with no file keeps the cursor in place.
  const lastLiveLocation = new Map<string, PresenceLocation>();

  /**
   * The same live presence the app shows for people and host agents: an outside
   * session's agent wears its owner's colour and moves through the files it touches.
   */
  const publishLivePresence = Effect.fn("ExternalSessions.publishLivePresence")(function* (input: {
    readonly caller: HelperCaller;
    readonly who: string;
    readonly projectId: ProjectId;
    readonly threadId: string;
    readonly source: ExternalSessionSource;
    readonly touched: { readonly path: string; readonly editing: boolean } | null;
  }) {
    const location: PresenceLocation =
      input.touched !== null
        ? {
            view: "file",
            activity: input.touched.editing ? "editing" : "reading",
            path: input.touched.path,
          }
        : (lastLiveLocation.get(input.threadId) ?? { view: "chat", activity: "viewing" });
    lastLiveLocation.set(input.threadId, location);
    const owner =
      input.caller.kind === "member"
        ? { id: memberSubject(input.caller.userId), name: input.who }
        : { id: HOST_ACTOR_ID, name: yield* hostDisplayName };
    yield* livePresence.write({
      key: `helper:${input.threadId}`,
      clientId: input.threadId,
      connectionId: null,
      projectId: input.projectId,
      threadId: input.threadId as ThreadId,
      actor: agentActorFor(owner, `${owner.id}:${input.threadId}`, SOURCE_LABEL[input.source]),
      source: "helper",
      location,
      ttlMs: LIVE_PRESENCE_TTL_MS,
    });
  });

  const isoAt = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));

  const presence = Effect.fn("ExternalSessions.presence")(function* (projectId: string) {
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const threads = presenceByProject.get(projectId);
    if (!threads) return [];
    const entries: Array<PresenceEntry> = [];
    for (const [threadId, entry] of threads) {
      if (now - entry.lastActiveAt > PRESENCE_IDLE_MS) {
        threads.delete(threadId);
        continue;
      }
      entries.push({
        threadId,
        who: entry.who,
        source: entry.source,
        title: entry.title,
        lastActiveAt: isoAt(entry.lastActiveAt),
        files: Array.from(entry.files.entries())
          .filter(([, file]) => now - file.at <= PRESENCE_IDLE_MS)
          .sort((left, right) => right[1].at - left[1].at)
          .map(([path, file]) => ({
            path,
            action: file.action,
            at: isoAt(file.at),
          })),
      });
    }
    return entries.sort((left, right) => right.lastActiveAt.localeCompare(left.lastActiveAt));
  });

  const nextEventId = (threadId: string, key: string, kind: string, at: DateTime.Utc) => {
    eventCounter += 1;
    return EventId.make(`${threadId}:${key}:${kind}:${DateTime.toEpochMillis(at)}:${eventCounter}`);
  };

  const ingestBatch = Effect.fn("ExternalSessions.ingestBatch")(function* (
    caller: HelperCaller,
    batch: ExternalSessionBatch,
  ) {
    if (!isValidSessionId(batch.sessionId)) {
      return yield* new ExternalSessionError({
        reason: "invalid_session",
        message: "Session ids use letters, digits, dots, dashes and underscores.",
      });
    }
    if (batch.events.length > MAX_EVENTS_PER_BATCH) {
      return yield* new ExternalSessionError({
        reason: "too_many_events",
        message: `Send at most ${MAX_EVENTS_PER_BATCH} events per batch.`,
      });
    }
    const threadId = externalThreadId(batch.source, batch.sessionId);
    const ownerKey = ownerKeyOf(caller);
    const now = yield* DateTime.now;
    const existing = yield* readSession(threadId);

    if (existing !== null && existing.owner_key !== ownerKey) {
      return {
        linked: false,
        reason: "not_owner",
        message: "This session is streamed by someone else.",
      } satisfies IngestResult;
    }
    if (
      existing !== null &&
      caller.kind === "member" &&
      access.roleOf(caller.userId, existing.project_id) === null
    ) {
      return {
        linked: false,
        reason: "not_shared",
        message: "The project this session streams into is no longer shared with you.",
      } satisfies IngestResult;
    }
    const project =
      existing === null
        ? yield* resolveProject(caller, batch)
        : yield* projects.getShell(existing.project_id as ProjectId).pipe(
            Effect.map((shell) => ({
              id: existing.project_id as ProjectId,
              workspaceRoot: Option.match(shell, {
                onNone: () => "",
                onSome: (found) => found.workspaceRoot,
              }),
            })),
            Effect.mapError(storage("reading a project")),
          );
    if (project === null) {
      return {
        linked: false,
        reason: "no_project",
        message:
          "No LogicPacks project matches this folder or its git remote. Add the folder in LogicPacks, or Sync it and open it there.",
      } satisfies IngestResult;
    }
    if (existing !== null) {
      const thread = yield* readThreadPayload(threadId);
      if (thread?.deleted_at) {
        return {
          linked: false,
          reason: "thread_deleted",
          message: "This session's thread was deleted in LogicPacks, so it is no longer streamed.",
        } satisfies IngestResult;
      }
    }

    const sourceLabel = sessionLabel(batch.source, batch.harness);
    const device = batch.device?.trim() ? clip(batch.device.trim(), 80) : null;
    const who = existing?.owner_label ?? (yield* ownerLabelOf(caller, device));
    const placeholderTitle = `${sourceLabel}${PLACEHOLDER_TITLE_SUFFIX}`;
    const firstPrompt = batch.events.find(
      (event) => event.type === "user" && (event.text ?? "").trim().length > 0,
    );
    const promptTitle = firstPrompt === undefined ? null : deriveTitle(firstPrompt.text ?? "");
    let title = existing?.title ?? promptTitle ?? placeholderTitle;
    const retitle =
      existing !== null && existing.title === placeholderTitle && promptTitle !== null;
    if (retitle) title = promptTitle;

    let nextOrdinal = existing?.next_ordinal ?? 1;
    const domainEvents: Array<OrchestrationV2DomainEvent> = [];
    const itemWrites: Array<{ key: string; ordinal: number; status: string }> = [];
    let accepted = 0;
    let duplicates = 0;
    let liveTouched: { path: string; editing: boolean } | null = null;
    let lastAt = existing === null ? now : parseEventTime(existing.last_event_at, now);
    // Paths relative to the project folder when the session runs inside it, else to the repository.
    const roots = [
      project.workspaceRoot !== "" && pathIsInside(project.workspaceRoot, batch.cwd)
        ? project.workspaceRoot
        : null,
      batch.gitRoot ?? null,
      batch.cwd,
    ];

    if (existing === null) {
      if (batch.events.length === 0) {
        return {
          linked: true,
          projectId: project.id,
          threadId,
          accepted: 0,
          duplicates: 0,
        } satisfies IngestResult;
      }
      const createdAt = parseEventTime(batch.events[0]!.at, now);
      const instanceId = ProviderInstanceId.make(SOURCE_PROVIDER_INSTANCE[batch.source]);
      const driver = ProviderDriverKind.make(batch.source === "claude" ? "claudeAgent" : "codex");
      const model = batch.model?.trim() || DEFAULT_MODEL_BY_PROVIDER[driver] || DEFAULT_MODEL;
      // Runless history like an imported v1 thread: continuing it in LogicPacks hands its
      // transcript to a fresh provider session.
      const appThread: OrchestrationV2AppThread = {
        createdBy: "user",
        creationSource: "server",
        id: threadId,
        projectId: project.id,
        title,
        providerInstanceId: instanceId,
        modelSelection: { instanceId, model },
        runtimeMode: DEFAULT_RUNTIME_MODE,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        branch: batch.branch?.trim() || null,
        worktreePath: null,
        linkedPullRequest: null,
        branchPullRequest: null,
        activeProviderThreadId: null,
        historyOrigin: "v1_import",
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdAt,
        updatedAt: createdAt,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        unsettledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        pinnedAt: null,
        pinOrderKey: null,
        activeOrderKey: null,
        lastVisitedAt: null,
        deletedAt: null,
      };
      domainEvents.push({
        id: nextEventId(threadId, "thread", "created", createdAt),
        type: "thread.created",
        threadId,
        providerInstanceId: instanceId,
        occurredAt: createdAt,
        payload: appThread,
      });
      const noticeKey = "lp-helper-notice";
      domainEvents.push({
        id: nextEventId(threadId, noticeKey, "item", createdAt),
        type: "turn-item.updated",
        threadId,
        occurredAt: createdAt,
        payload: {
          id: TurnItemId.make(`${threadId}:item:${noticeKey}`),
          threadId,
          runId: null,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 0,
          status: "completed",
          title: null,
          startedAt: createdAt,
          completedAt: createdAt,
          updatedAt: createdAt,
          type: "system_notice",
          message: `${who}'s ${sourceLabel} session${device ? ` on ${device}` : ""}, streamed live by the LogicPacks helper.`,
        },
      });
      itemWrites.push({ key: noticeKey, ordinal: 0, status: "completed" });
    }

    for (const event of batch.events) {
      const at = parseEventTime(event.at, now);
      if (DateTime.toEpochMillis(at) > DateTime.toEpochMillis(lastAt)) lastAt = at;
      for (const item of mapExternalEvent({ threadId, event, at, roots })) {
        const turnItemPreview = item.turnItem(0);
        const known = yield* sql<ItemRow>`
          SELECT ordinal, status FROM logicpacks_external_items
          WHERE thread_id = ${threadId} AND item_key = ${item.key}
        `.pipe(
          Effect.map((rows) => rows[0] ?? null),
          Effect.mapError(storage("reading an item")),
        );
        const pending = itemWrites.find((write) => write.key === item.key);
        const previousStatus = pending?.status ?? known?.status;
        if (previousStatus === turnItemPreview.status) {
          duplicates += 1;
          continue;
        }
        const ordinal = pending?.ordinal ?? known?.ordinal ?? nextOrdinal++;
        if (item.message !== null) {
          domainEvents.push({
            id: nextEventId(threadId, item.key, "message", at),
            type: "message.updated",
            threadId,
            occurredAt: at,
            payload: item.message,
          });
        }
        domainEvents.push({
          id: nextEventId(threadId, item.key, "item", at),
          type: "turn-item.updated",
          threadId,
          occurredAt: at,
          payload: item.turnItem(ordinal),
        });
        if (pending) {
          pending.status = turnItemPreview.status;
        } else {
          itemWrites.push({ key: item.key, ordinal, status: turnItemPreview.status });
        }
        accepted += 1;
        if (item.files.length > 0) {
          const path = normalizePresencePath(item.files[0]!);
          if (path !== null) {
            liveTouched = { path, editing: turnItemPreview.type === "file_change" };
          }
          touchPresence({
            projectId: project.id,
            threadId,
            who,
            source: batch.source,
            title,
            at: Math.min(DateTime.toEpochMillis(at), DateTime.toEpochMillis(now)),
            files: item.files,
            action: turnItemPreview.type === "file_change" ? "editing" : "viewing",
          });
        }
      }
    }
    if (accepted > 0) {
      touchPresence({
        projectId: project.id,
        threadId,
        who,
        source: batch.source,
        title,
        at: Math.min(DateTime.toEpochMillis(lastAt), DateTime.toEpochMillis(now)),
        files: [],
        action: "viewing",
      });
      yield* publishLivePresence({
        caller,
        who,
        projectId: project.id,
        threadId,
        source: batch.source,
        touched: liveTouched,
      });
    }

    if (retitle) {
      const current = yield* readThreadPayload(threadId);
      const decoded = current === null ? Option.none() : decodeAppThread(current.payload_json);
      if (Option.isSome(decoded)) {
        domainEvents.push({
          id: nextEventId(threadId, "thread", "retitle", now),
          type: "thread.metadata-updated",
          threadId,
          occurredAt: now,
          payload: { ...decoded.value, title, updatedAt: now },
        });
      }
    }

    if (domainEvents.length > 0) {
      yield* eventSink
        .write({ events: domainEvents })
        .pipe(Effect.mapError(storage("writing thread events")));
    }
    const lastEventAt = DateTime.formatIso(lastAt);
    if (existing === null) {
      yield* sql`
        INSERT INTO logicpacks_external_sessions (
          thread_id, project_id, source, session_id, owner_key, owner_label, device, title,
          next_ordinal, created_at, last_event_at
        ) VALUES (
          ${threadId}, ${project.id}, ${batch.source}, ${batch.sessionId}, ${ownerKey}, ${who},
          ${device}, ${title}, ${nextOrdinal}, ${DateTime.formatIso(now)}, ${lastEventAt}
        )
      `.pipe(Effect.mapError(storage("recording a session")));
      if (usage._tag === "Some") {
        // Counts toward the helper badges; a failure here never drops the session.
        yield* usage.value
          .recordActivity({
            participantId: caller.kind === "member" ? caller.userId : LP_HOST_PARTICIPANT_ID,
            kind: "helper.session_linked",
            subject: threadId,
            projectId: project.id,
          })
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning("Could not record a linked helper session", { error }),
            ),
          );
      }
    } else {
      yield* sql`
        UPDATE logicpacks_external_sessions
        SET next_ordinal = ${nextOrdinal}, last_event_at = ${lastEventAt}, title = ${title}
        WHERE thread_id = ${threadId}
      `.pipe(Effect.mapError(storage("updating a session")));
    }
    for (const write of itemWrites) {
      yield* sql`
        INSERT INTO logicpacks_external_items (thread_id, item_key, ordinal, status)
        VALUES (${threadId}, ${write.key}, ${write.ordinal}, ${write.status})
        ON CONFLICT (thread_id, item_key) DO UPDATE SET status = excluded.status
      `.pipe(Effect.mapError(storage("recording an item")));
    }
    return {
      linked: true,
      projectId: project.id,
      threadId,
      accepted,
      duplicates,
    } satisfies IngestResult;
  });

  const nativeActivity = Effect.fn("ExternalSessions.nativeActivity")(function* (
    projectId: string,
    now: DateTime.Utc,
  ) {
    const since = DateTime.formatIso(
      DateTime.makeUnsafe(DateTime.toEpochMillis(now) - NATIVE_ACTIVITY_WINDOW_MS),
    );
    const rows = yield* sql<{
      readonly thread_id: string;
      readonly title: string;
      readonly last_at: string;
      readonly files: string | null;
    }>`
      SELECT t.thread_id AS thread_id, t.title AS title, MAX(i.updated_at) AS last_at,
        group_concat(DISTINCT CASE WHEN i.type = 'file_change'
          THEN json_extract(i.payload_json, '$.fileName') END) AS files
      FROM orchestration_v2_projection_turn_items i
      JOIN orchestration_v2_projection_threads t ON t.thread_id = i.thread_id
      WHERE t.project_id = ${projectId}
        AND t.deleted_at IS NULL
        AND t.thread_id NOT LIKE 'external:%'
        AND i.updated_at >= ${since}
      GROUP BY t.thread_id
      ORDER BY last_at DESC
      LIMIT 12
    `.pipe(Effect.mapError(storage("reading recent threads")));
    return rows.map((row): ActivityEntry => ({
      who: "LogicPacks thread",
      what: `"${row.title}"`,
      threadId: row.thread_id,
      lastActiveAt: row.last_at,
      files: (row.files ?? "").split(",").filter((file) => file.length > 0),
    }));
  });

  const context = Effect.fn("ExternalSessions.context")(function* (
    caller: HelperCaller,
    input: ExternalSessionLocation & {
      readonly source?: ExternalSessionSource | undefined;
      readonly sessionId?: string | undefined;
    },
  ) {
    const ownThreadId =
      input.source !== undefined &&
      input.sessionId !== undefined &&
      isValidSessionId(input.sessionId)
        ? externalThreadId(input.source, input.sessionId)
        : null;
    const ownSession = ownThreadId === null ? null : yield* readSession(ownThreadId);
    const project =
      ownSession !== null && ownSession.owner_key === ownerKeyOf(caller)
        ? yield* projects
            .getShell(ownSession.project_id as ProjectId)
            .pipe(Effect.map(Option.getOrNull), Effect.mapError(storage("reading a project")))
        : yield* resolveProject(caller, input);
    if (
      project === null ||
      (caller.kind === "member" && access.roleOf(caller.userId, project.id) === null)
    ) {
      return {
        linked: false,
        message:
          "This folder is not part of a LogicPacks project yet, so this session is private. Add it in LogicPacks to share it with your team.",
      } as const;
    }
    const now = yield* DateTime.now;
    const live = yield* presence(project.id);
    const others: Array<ActivityEntry> = live
      .filter((entry) => entry.threadId !== ownThreadId)
      .map((entry) => ({
        who: `${entry.who}'s ${SOURCE_LABEL[entry.source]}`,
        what: `"${entry.title}"`,
        threadId: entry.threadId,
        lastActiveAt: entry.lastActiveAt,
        files: entry.files.filter((file) => file.action === "editing").map((file) => file.path),
      }));
    others.push(...(yield* nativeActivity(project.id, now)));
    const ownFiles =
      live
        .find((entry) => entry.threadId === ownThreadId)
        ?.files.filter((file) => file.action === "editing")
        .map((file) => file.path) ?? [];
    const members = (yield* access
      .listMembers(project.id)
      .pipe(Effect.orElseSucceed(() => []))).map((member) => member.user.displayName);
    const synced = access.isSynced(project.id);
    // Outside sessions are already listed above; this adds people and the host's own agents.
    const nowMs = DateTime.toEpochMillis(now);
    const liveLines = (yield* livePresence.list(
      (entry) => entry.projectId === project.id && entry.source !== "helper",
    )).map((entry) => describePresence(entry, nowMs));
    const { text, conflicts } = projectContextText({
      projectTitle: project.title,
      synced,
      members,
      others,
      ownFiles,
      live: liveLines,
      now,
    });
    return {
      linked: true,
      projectId: project.id,
      projectTitle: project.title,
      synced,
      text,
      conflicts,
    } as const;
  });

  const list = Effect.fn("ExternalSessions.list")(function* (projectId: string) {
    const rows = yield* sql<SessionRow>`
      SELECT * FROM logicpacks_external_sessions
      WHERE project_id = ${projectId}
      ORDER BY last_event_at DESC
      LIMIT 200
    `.pipe(Effect.mapError(storage("listing sessions")));
    return rows.map((row): ExternalSessionSummary => ({
      threadId: row.thread_id,
      projectId: row.project_id,
      source: row.source,
      who: row.owner_label,
      device: row.device,
      title: row.title,
      lastEventAt: row.last_event_at,
    }));
  });

  return ExternalSessions.of({
    resolveProject,
    ingest: Effect.fn("ExternalSessions.ingest")(function* (caller, batch) {
      return yield* ingestLane.withPermits(1)(ingestBatch(caller, batch));
    }),
    context,
    presence,
    list,
  });
});

export const layer = Layer.effect(ExternalSessions, make);
