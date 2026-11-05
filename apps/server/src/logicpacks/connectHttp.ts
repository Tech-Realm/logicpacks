import type { ProjectId } from "@logicpacks/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { HttpRouter, HttpServerResponse } from "effect/http";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { SETUP_GUIDE_MARKDOWN } from "./connectSetup.generated.ts";
import { ExternalSessions, type HelperCaller } from "./ExternalSessions.ts";
import {
  ExternalSessionLocation,
  externalThreadId,
  isValidSessionId,
  sessionLabel,
} from "./externalSessionMapping.ts";
import { resolveHelperCaller } from "./helperHttp.ts";
import { json, queryParam, readBody } from "./http.ts";
import type { LedgerMessage, LedgerThread } from "./ledger.ts";
import { LogicPacksAccess } from "./LogicPacksAccess.ts";
import { isActive } from "./negotiation.ts";
import { scopeText, type Goal } from "./goals.ts";
import { ProjectGoals } from "./ProjectGoals.ts";
import { refuseIfReadOnly } from "./readOnly.ts";
import { LedgerError, ProjectLedger } from "./ProjectLedger.ts";

/**
 * "Connect your agent" without the app: the routes the `lp` CLI uses so an agent in any
 * harness (Claude Code, Codex, Cursor, Hermes...) can be reached, list who is working,
 * ask and answer other agents, and read its inbox. Messages travel through the project
 * ledger, so app threads and harness agents talk to each other the same way.
 */

const unauthenticated = json(
  { error: "unauthenticated", message: "Run lp login to connect this computer." },
  401,
);
const notFound = (message = "Not found.") => json({ error: "not_found", message }, 404);

const ledgerErrorResponse = (error: LedgerError) =>
  Effect.succeed(
    json(
      { error: error.reason, message: error.message },
      error.reason === "not_found" ? 404 : error.reason === "forbidden" ? 403 : 409,
    ),
  );

const participantOf = (caller: HelperCaller) => (caller.kind === "member" ? caller.userId : "host");

const canSee = Effect.fn("logicpacks.connect.canSee")(function* (
  caller: HelperCaller,
  projectId: string,
) {
  if (caller.kind === "operator") return true;
  const access = yield* LogicPacksAccess;
  return access.roleOf(caller.userId, projectId) !== null;
});

/** Every project the caller can open. */
const visibleProjects = Effect.fn("logicpacks.connect.visibleProjects")(function* (
  caller: HelperCaller,
) {
  const access = yield* LogicPacksAccess;
  if (caller.kind === "member") return Array.from(access.visibleProjectIds(caller.userId));
  const store = yield* ProjectStore.ProjectStoreV2;
  return (yield* store.listShells().pipe(Effect.orElseSucceed(() => []))).map(
    (shell) => shell.id as string,
  );
});

const projectTitle = Effect.fn("logicpacks.connect.projectTitle")(function* (projectId: string) {
  const store = yield* ProjectStore.ProjectStoreV2;
  const shell = yield* store
    .getShell(projectId as ProjectId)
    .pipe(Effect.orElseSucceed(() => Option.none()));
  return Option.isSome(shell) ? shell.value.title : "Project";
});

// ── Harness labels for agent sessions ──

const ensureHarnessTable = (sql: SqlClient.SqlClient) =>
  sql`
    CREATE TABLE IF NOT EXISTS logicpacks_connect_sessions (
      thread_id TEXT PRIMARY KEY,
      harness TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `;

const harnessLabels = Effect.fn("logicpacks.connect.harnessLabels")(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* ensureHarnessTable(sql).pipe(Effect.ignore);
  const rows = yield* sql<{ readonly thread_id: string; readonly harness: string }>`
    SELECT thread_id, harness FROM logicpacks_connect_sessions
  `.pipe(Effect.orElseSucceed(() => []));
  const external = yield* sql<{ readonly thread_id: string; readonly source: string }>`
    SELECT thread_id, source FROM logicpacks_external_sessions
  `.pipe(Effect.orElseSucceed(() => []));
  const labels = new Map<string, string>();
  for (const row of external) {
    if (row.source === "claude") labels.set(row.thread_id, "Claude Code");
    else if (row.source === "codex") labels.set(row.thread_id, "Codex");
    else labels.set(row.thread_id, "Agent");
  }
  for (const row of rows) labels.set(row.thread_id, row.harness);
  return labels;
});

/** Whose thread this is, by the ledger: the creator first. */
const ownerOf = (thread: LedgerThread) => thread.members[0] ?? null;

const isMine = (thread: LedgerThread, participant: string) =>
  thread.members.some((member) => member.id === participant);

// ── Routes ──

const setupGuideRoute = HttpRouter.add(
  "GET",
  "/setup.md",
  Effect.succeed(
    HttpServerResponse.text(SETUP_GUIDE_MARKDOWN, {
      contentType: "text/markdown; charset=utf-8",
      headers: { "cache-control": "public, max-age=300" },
    }),
  ),
);

const RegisterRequest = Schema.Struct({
  ...ExternalSessionLocation.fields,
  /** Stable per harness and folder, chosen by the CLI. */
  sessionId: Schema.String,
  harness: Schema.String,
  device: Schema.optionalKey(Schema.NullOr(Schema.String)),
  branch: Schema.optionalKey(Schema.NullOr(Schema.String)),
  task: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

/**
 * Gives an outside agent its own thread in the project of its folder, so other agents and
 * people can reach it. Calling it again keeps the same thread and may update the task.
 */
const registerRoute = HttpRouter.add(
  "POST",
  "/api/lp/connect/register",
  Effect.gen(function* () {
    const caller = yield* resolveHelperCaller;
    if (caller === null) return unauthenticated;
    const body = yield* readBody(RegisterRequest);
    if (body === null || !isValidSessionId(body.sessionId)) {
      return json({ error: "bad_request", message: "Pass cwd, sessionId and harness." }, 400);
    }
    const harness = sessionLabel("agent", body.harness);
    const sessions = yield* ExternalSessions;
    const threadId = externalThreadId("agent", body.sessionId);
    const ledger = yield* ProjectLedger;
    const known = (yield* ledger.projectOfThread(threadId)) !== null;
    const nowIso = DateTime.formatIso(yield* DateTime.now);
    const task = body.task?.trim() ?? "";
    const events =
      task.length > 0
        ? [{ uid: `task-${nowIso}`, at: nowIso, type: "user" as const, text: task }]
        : known
          ? []
          : [
              {
                uid: "connected",
                at: nowIso,
                type: "assistant" as const,
                text: `${harness} connected through the lp CLI. Messages to this thread reach it through lp inbox.`,
              },
            ];
    const result = yield* sessions.ingest(caller, {
      cwd: body.cwd,
      gitRoot: body.gitRoot ?? null,
      gitRemote: body.gitRemote ?? null,
      source: "agent",
      sessionId: body.sessionId,
      harness,
      device: body.device ?? null,
      branch: body.branch ?? null,
      events,
    });
    if (!result.linked) {
      return json(
        { error: result.reason, message: result.message },
        result.reason === "read_only" ? 403 : 404,
      );
    }
    const sql = yield* SqlClient.SqlClient;
    yield* ensureHarnessTable(sql).pipe(Effect.ignore);
    yield* sql`
      INSERT INTO logicpacks_connect_sessions (thread_id, harness, updated_at)
      VALUES (${result.threadId}, ${harness}, ${yield* Clock.currentTimeMillis})
      ON CONFLICT (thread_id) DO UPDATE SET harness = excluded.harness, updated_at = excluded.updated_at
    `.pipe(Effect.ignore);
    yield* ledger.refreshProject(result.projectId);
    const access = yield* LogicPacksAccess;
    return json({
      projectId: result.projectId,
      projectTitle: yield* projectTitle(result.projectId),
      workspaceId: access.projectWorkspaceId(result.projectId),
      threadId: result.threadId,
      harness,
    });
  }).pipe(
    Effect.catchTags({
      ExternalSessionError: (error) =>
        Effect.succeed(json({ error: error.reason, message: error.message }, 400)),
    }),
  ),
);

/** The project's workspace and the caller's role, for `lp invite` and `lp share`. */
const projectRoute = HttpRouter.add(
  "GET",
  "/api/lp/connect/project",
  Effect.gen(function* () {
    const caller = yield* resolveHelperCaller;
    if (caller === null) return unauthenticated;
    const projectId = yield* queryParam("projectId");
    if (projectId.length === 0 || !(yield* canSee(caller, projectId))) return notFound();
    const access = yield* LogicPacksAccess;
    const workspaceId = access.projectWorkspaceId(projectId);
    const workspace =
      workspaceId === null
        ? null
        : (access
            .listWorkspaces(caller.kind === "member" ? caller.userId : null)
            .find((entry) => entry.workspaceId === workspaceId) ?? null);
    return json({
      projectId,
      title: yield* projectTitle(projectId),
      role: caller.kind === "member" ? access.roleOf(caller.userId, projectId) : "operator",
      synced: access.isSynced(projectId),
      workspaceId,
      workspaceName: workspace?.name ?? null,
    });
  }),
);

export interface AgentEntry {
  readonly projectId: string;
  readonly projectTitle: string;
  readonly threadId: string;
  readonly title: string;
  readonly person: string | null;
  readonly personId: string | null;
  /** "LogicPacks app", "Claude Code", "Cursor"... */
  readonly harness: string;
  readonly model: string | null;
  readonly task: string | null;
  readonly status: string;
  readonly files: ReadonlyArray<string>;
  readonly lastActiveAtMs: number;
}

/** The projects `workspace` scope covers: every project of the project's workspace the caller can open. */
const scopeProjects = Effect.fn("logicpacks.connect.scopeProjects")(function* (
  caller: HelperCaller,
  projectId: string,
  workspace: boolean,
) {
  if (!workspace) return [projectId];
  const access = yield* LogicPacksAccess;
  const workspaceId = access.projectWorkspaceId(projectId);
  const visible = new Set(yield* visibleProjects(caller));
  const inWorkspace =
    workspaceId === null
      ? []
      : (access
          .listWorkspaces(caller.kind === "member" ? caller.userId : null)
          .find((entry) => entry.workspaceId === workspaceId)?.projectIds ?? []);
  return Array.from(new Set([projectId, ...inWorkspace])).filter((id) => visible.has(id));
});

const ACTIVE_WINDOW_MS = 24 * 60 * 60_000;

const agentsRoute = HttpRouter.add(
  "GET",
  "/api/lp/connect/agents",
  Effect.gen(function* () {
    const caller = yield* resolveHelperCaller;
    if (caller === null) return unauthenticated;
    const projectId = yield* queryParam("projectId");
    const workspace = (yield* queryParam("workspace")) === "1";
    const all = (yield* queryParam("all")) === "1";
    if (projectId.length === 0 || !(yield* canSee(caller, projectId))) return notFound();
    const ledger = yield* ProjectLedger;
    const labels = yield* harnessLabels();
    const nowMs = yield* Clock.currentTimeMillis;
    const agents: Array<AgentEntry> = [];
    for (const id of yield* scopeProjects(caller, projectId, workspace)) {
      yield* ledger.refreshProject(id);
      const view = yield* ledger.view(id);
      const title = yield* projectTitle(id);
      for (const thread of view.threads) {
        if (!all && nowMs - thread.lastActiveAtMs > ACTIVE_WINDOW_MS) continue;
        const owner = ownerOf(thread);
        agents.push({
          projectId: id,
          projectTitle: title,
          threadId: thread.threadId,
          title: thread.title,
          person: owner?.name ?? null,
          personId: owner?.id ?? null,
          harness: labels.get(thread.threadId) ?? "LogicPacks app",
          model: thread.agent?.model ?? null,
          task: thread.goal,
          status: thread.status,
          files: thread.files.slice(0, 4).map((file) => file.path),
          lastActiveAtMs: thread.lastActiveAtMs,
        });
      }
    }
    agents.sort((a, b) => b.lastActiveAtMs - a.lastActiveAtMs);
    return json({ agents, workspace });
  }),
);

export type InboxItem =
  | {
      readonly kind: "ask" | "reply" | "notice";
      readonly id: string;
      readonly projectId: string;
      readonly projectTitle: string;
      readonly from: string;
      readonly fromThreadId: string | null;
      readonly toThreadId: string;
      readonly replyTo: string | null;
      readonly text: string;
      readonly atMs: number;
    }
  | {
      readonly kind: "conflict";
      readonly id: string;
      readonly projectId: string;
      readonly projectTitle: string;
      readonly files: ReadonlyArray<string>;
      readonly people: ReadonlyArray<string>;
      readonly reason: string;
      readonly threadId: string;
      readonly atMs: number;
    }
  | {
      readonly kind: "negotiation";
      readonly id: string;
      readonly projectId: string;
      readonly projectTitle: string;
      readonly state: string;
      readonly files: ReadonlyArray<string>;
      readonly people: ReadonlyArray<string>;
      /** What the caller's person is asked, when a human decision is needed. */
      readonly question: string | null;
      readonly needsPosition: boolean;
      readonly threadId: string;
      readonly atMs: number;
    }
  | {
      /** Goals: drift and review requests the caller decides, milestones for them, drafts to confirm. */
      readonly kind: "drift" | "review" | "milestone" | "goal";
      readonly id: string;
      readonly goalId: string;
      readonly projectId: string;
      readonly projectTitle: string;
      readonly person: string;
      readonly text: string;
      /** The decision's actions (drift, review); empty otherwise. */
      readonly actions: ReadonlyArray<string>;
      readonly atMs: number;
    };

const OPEN_MILESTONE = new Set(["pending", "sent", "in_progress", "blocked", "changes_requested"]);

/** The Goals items waiting for the caller in one project. */
const goalItems = Effect.fn("logicpacks.connect.goalItems")(function* (
  participant: string,
  projectId: string,
  title: string,
) {
  const goals = yield* ProjectGoals;
  const actor = yield* goals.actorFor(participant, projectId);
  const items: Array<InboxItem> = [];
  const base = (goal: Goal) => ({ goalId: goal.id, projectId, projectTitle: title });
  for (const goal of yield* goals.list(projectId)) {
    if (goal.state === "draft" && goal.ownerId === participant) {
      items.push({
        ...base(goal),
        kind: "goal",
        id: goal.id,
        person: goal.ownerName,
        text: `Draft goal "${goal.title}" with ${goal.milestones.length} milestone(s) waits for your user to confirm it. Nothing is sent until then.`,
        actions: [],
        atMs: goal.updatedAtMs,
      });
    }
    if (goal.state !== "active") continue;
    for (const milestone of goal.milestones) {
      if (milestone.assignee.userId !== participant || !OPEN_MILESTONE.has(milestone.status)) {
        continue;
      }
      items.push({
        ...base(goal),
        kind: "milestone",
        id: milestone.id,
        person: goal.ownerName,
        text: [
          `${milestone.title} (goal "${goal.title}", status ${milestone.status.replaceAll("_", " ")}).`,
          `Done when: ${milestone.criteria.join("; ") || "the task is done"}.`,
          `Scope: ${scopeText(milestone.scope)}.`,
          milestone.dueAtMs === null
            ? ""
            : `Due ${DateTime.formatIso(DateTime.makeUnsafe(milestone.dueAtMs)).slice(0, 10)}.`,
          milestone.review?.verdict === "changes" ? `Sent back: ${milestone.review.note}` : "",
        ]
          .filter(Boolean)
          .join(" "),
        actions: [],
        atMs: milestone.updatedAtMs,
      });
    }
    for (const request of goal.decisions) {
      if (request.status !== "open") continue;
      if (!actor.isHost && !request.approvers.includes(participant)) continue;
      items.push({
        ...base(goal),
        kind: request.kind === "goal.drift" ? "drift" : "review",
        id: request.id,
        person: request.subject.who.name,
        text: [request.title, request.summary, ...request.detail].filter(Boolean).join(" "),
        actions: request.actions.filter((action) => !action.inApp).map((action) => action.id),
        atMs: request.updatedAtMs,
      });
    }
  }
  return items;
});

const messageItem = (message: LedgerMessage, title: string): InboxItem => ({
  kind: message.kind,
  id: message.id,
  projectId: message.projectId,
  projectTitle: title,
  from: message.fromName,
  fromThreadId: message.fromThreadId,
  toThreadId: message.toThreadId,
  replyTo: message.replyTo,
  text: message.text,
  atMs: message.createdAtMs,
});

/**
 * Everything waiting for the caller across their projects: messages to any of their
 * threads (app or harness), conflicts and negotiations their threads are part of.
 */
const inboxRoute = HttpRouter.add(
  "GET",
  "/api/lp/connect/inbox",
  Effect.gen(function* () {
    const caller = yield* resolveHelperCaller;
    if (caller === null) return unauthenticated;
    const all = (yield* queryParam("all")) === "1";
    const only = yield* queryParam("projectId");
    const participant = participantOf(caller);
    const ledger = yield* ProjectLedger;
    const items: Array<InboxItem> = [];
    const projects = (yield* visibleProjects(caller)).filter(
      (id) => only.length === 0 || id === only,
    );
    for (const projectId of projects) {
      yield* ledger.refreshProject(projectId);
      const view = yield* ledger.view(projectId);
      const mine = view.threads.filter((thread) => isMine(thread, participant));
      const title = yield* projectTitle(projectId);
      items.push(...(yield* goalItems(participant, projectId, title)));
      if (mine.length === 0) continue;
      for (const thread of mine) {
        const threadView = yield* ledger.threadView(thread.threadId);
        if (threadView === null) continue;
        for (const message of threadView.notices) items.push(messageItem(message, title));
        for (const conflict of threadView.conflicts) {
          items.push({
            kind: "conflict",
            id: conflict.id,
            projectId,
            projectTitle: title,
            files: conflict.files,
            people: conflict.people,
            reason: conflict.reason,
            threadId: thread.threadId,
            atMs: conflict.createdAtMs,
          });
        }
        for (const negotiation of threadView.negotiations) {
          if (!all && !isActive(negotiation)) continue;
          const party = negotiation.parties.find((entry) => entry.threadId === thread.threadId);
          items.push({
            kind: "negotiation",
            id: negotiation.id,
            projectId,
            projectTitle: title,
            state: negotiation.state,
            files: negotiation.files,
            people: negotiation.parties.map((entry) => entry.name),
            question: party?.question ?? null,
            needsPosition:
              negotiation.state === "collecting" &&
              party !== undefined &&
              (party.position === null || party.positionRound < negotiation.round),
            threadId: thread.threadId,
            atMs: negotiation.updatedAtMs,
          });
        }
      }
    }
    items.sort((a, b) => a.atMs - b.atMs);
    return json({ items });
  }),
);

/** Marks messages to any of the caller's threads seen; returns how many. */
const dismiss = Effect.fn("logicpacks.connect.dismiss")(function* (
  caller: HelperCaller,
  ids: ReadonlyArray<string>,
) {
  const ledger = yield* ProjectLedger;
  const participant = participantOf(caller);
  let dismissed = 0;
  for (const projectId of yield* visibleProjects(caller)) {
    const view = yield* ledger.view(projectId);
    for (const thread of view.threads.filter((entry) => isMine(entry, participant))) {
      const threadView = yield* ledger.threadView(thread.threadId);
      const found = (threadView?.notices ?? [])
        .filter((message) => ids.includes(message.id))
        .map((message) => message.id);
      if (found.length === 0) continue;
      yield* ledger.markSeen(thread.threadId, found);
      dismissed += found.length;
    }
  }
  return dismissed;
});

const SendRequest = Schema.Struct({
  /** The caller's own thread (an agent session or an app thread); replies come back here. */
  fromThreadId: Schema.String,
  to: Schema.optionalKey(Schema.String),
  text: Schema.String,
  replyTo: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /** Another project of the same workspace; the caller must have access to it. */
  projectId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  kind: Schema.optionalKey(Schema.Literals(["ask", "send"])),
});

/**
 * `lp send`, `lp ask`, `lp reply`. Within the caller's project, or into another project of
 * the same workspace where the caller has access; anything else is refused.
 */
const sendRoute = HttpRouter.add(
  "POST",
  "/api/lp/connect/send",
  Effect.gen(function* () {
    const caller = yield* resolveHelperCaller;
    if (caller === null) return unauthenticated;
    const body = yield* readBody(SendRequest);
    if (body === null) return json({ error: "bad_request" }, 400);
    const ledger = yield* ProjectLedger;
    const access = yield* LogicPacksAccess;
    const fromProject = yield* ledger.projectOfThread(body.fromThreadId);
    if (fromProject === null || !(yield* canSee(caller, fromProject))) {
      return notFound("Your thread was not found. Run lp agents to register this folder again.");
    }
    const readOnly = yield* refuseIfReadOnly(caller, fromProject);
    if (readOnly !== null) return readOnly;
    const fromThread = (yield* ledger.view(fromProject)).threads.find(
      (thread) => thread.threadId === body.fromThreadId,
    );
    if (fromThread === undefined || !isMine(fromThread, participantOf(caller))) {
      return json({ error: "forbidden", message: "You can only write from your own thread." }, 403);
    }
    let projectId = fromProject;
    if (body.projectId && body.projectId !== fromProject) {
      // Workspace scope: same workspace, and the caller must be able to open the other project.
      const sameWorkspace =
        access.projectWorkspaceId(body.projectId) !== null &&
        access.projectWorkspaceId(body.projectId) === access.projectWorkspaceId(fromProject);
      if (!sameWorkspace || !(yield* canSee(caller, body.projectId))) {
        return json(
          {
            error: "forbidden",
            message:
              "You have no access to that project. Ask its owner to add you, or ask someone in your own project.",
          },
          403,
        );
      }
      projectId = body.projectId;
      const targetReadOnly = yield* refuseIfReadOnly(caller, projectId);
      if (targetReadOnly !== null) return targetReadOnly;
    }
    const fromName = yield* ledger.personName(participantOf(caller));
    const crossProject = projectId !== fromProject;
    const message = yield* ledger.send({
      projectId,
      fromThreadId: body.fromThreadId,
      fromName: crossProject ? `${fromName} (from ${yield* projectTitle(fromProject)})` : fromName,
      to: body.to ?? "",
      text: body.text,
      replyTo: body.replyTo ?? null,
    });
    if (body.replyTo) yield* dismiss(caller, [body.replyTo]);
    const target = (yield* ledger.view(message.projectId)).threads.find(
      (thread) => thread.threadId === message.toThreadId,
    );
    return json({
      message,
      to: target === undefined ? null : (ownerOf(target)?.name ?? null),
      projectTitle: yield* projectTitle(message.projectId),
    });
  }).pipe(Effect.catchTags({ LedgerError: ledgerErrorResponse })),
);

const SeenRequest = Schema.Struct({ ids: Schema.Array(Schema.String) });

/** `lp done <id>`: dismisses messages to any of the caller's threads. */
const seenRoute = HttpRouter.add(
  "POST",
  "/api/lp/connect/seen",
  Effect.gen(function* () {
    const caller = yield* resolveHelperCaller;
    if (caller === null) return unauthenticated;
    const body = yield* readBody(SeenRequest);
    if (body === null) return json({ error: "bad_request" }, 400);
    const dismissed = yield* dismiss(caller, body.ids);
    return json({ dismissed });
  }),
);

const GoalsRequest = Schema.Struct({
  op: Schema.Literals(["list", "confirm", "cancel", "decide"]),
  projectId: Schema.optionalKey(Schema.String),
  goalId: Schema.optionalKey(Schema.String),
  decisionId: Schema.optionalKey(Schema.String),
  action: Schema.optionalKey(Schema.String),
  note: Schema.optionalKey(Schema.String),
});

/**
 * Goals for a person without the app: list, confirm or cancel a draft, decide a drift or
 * review request. The agent plans and reports through the ledger tools (goal_plan,
 * goal_update); these are the person's own decisions, so they act as the person.
 */
const goalsRoute = HttpRouter.add(
  "POST",
  "/api/lp/connect/goals",
  Effect.gen(function* () {
    const caller = yield* resolveHelperCaller;
    if (caller === null) return unauthenticated;
    const body = yield* readBody(GoalsRequest);
    if (body === null) return json({ error: "bad_request" }, 400);
    const goals = yield* ProjectGoals;
    const participant = participantOf(caller);
    if (body.op === "list") {
      if (!body.projectId || !(yield* canSee(caller, body.projectId))) return notFound();
      return json({ goals: yield* goals.list(body.projectId) });
    }
    let goal = body.goalId ? goals.get(body.goalId) : undefined;
    if (goal === undefined && body.decisionId) {
      for (const projectId of yield* visibleProjects(caller)) {
        goal = (yield* goals.list(projectId)).find((candidate) =>
          candidate.decisions.some((request) => request.id === body.decisionId),
        );
        if (goal !== undefined) break;
      }
    }
    if (goal === undefined || !(yield* canSee(caller, goal.projectId))) {
      return notFound("No such goal. Run lp goals list.");
    }
    const readOnly = yield* refuseIfReadOnly(caller, goal.projectId);
    if (readOnly !== null) return readOnly;
    const actor = yield* goals.actorFor(participant, goal.projectId);
    const next =
      body.op === "confirm"
        ? yield* goals.confirm({ goalId: goal.id, actor })
        : body.op === "cancel"
          ? yield* goals.cancel({ goalId: goal.id, actor })
          : yield* goals.decide({
              goalId: goal.id,
              decisionId: body.decisionId ?? "",
              actor,
              action: body.action ?? "",
              note: body.note,
            });
    return json({ goal: next });
  }).pipe(Effect.catchTags({ LedgerError: ledgerErrorResponse })),
);

export const layer = Layer.mergeAll(
  goalsRoute,
  setupGuideRoute,
  registerRoute,
  projectRoute,
  agentsRoute,
  inboxRoute,
  sendRoute,
  seenRoute,
);
