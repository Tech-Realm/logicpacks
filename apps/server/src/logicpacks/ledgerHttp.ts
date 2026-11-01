import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpRouter } from "effect/http";

import { ExternalSessions } from "./ExternalSessions.ts";
import {
  externalThreadId,
  ExternalSessionLocation,
  ExternalSessionSource,
} from "./externalSessionMapping.ts";
import { resolveHelperCaller } from "./helperHttp.ts";
import { json, queryParam, readBody, resolveCaller } from "./http.ts";
import { describeGoal, GoalPlan, scopeText } from "./goals.ts";
import { describeThread } from "./ledger.ts";
import { packsReader, type PacksReader } from "./packsHttp.ts";
import { featureGate, participantHas } from "./featureHttp.ts";
import { LogicPacksAccess } from "./LogicPacksAccess.ts";
import { ProjectGoals } from "./ProjectGoals.ts";
import { describeConflicts, LedgerError, ProjectLedger } from "./ProjectLedger.ts";

const ledgerErrorStatus: Record<LedgerError["reason"], number> = {
  not_found: 404,
  invalid: 409,
  forbidden: 403,
};

const ledgerErrorResponse = (error: LedgerError) =>
  Effect.succeed(
    json({ error: error.reason, message: error.message }, ledgerErrorStatus[error.reason]),
  );

type Caller = { readonly kind: "member"; readonly userId: string } | { readonly kind: "operator" };

const callerName = Effect.fn("logicpacks.ledger.callerName")(function* (caller: Caller) {
  const ledger = yield* ProjectLedger;
  return yield* ledger.personName(caller.kind === "member" ? caller.userId : "host");
});

/** The project a caller may use: the operator any, a member only one shared with them. */
const allowedProject = Effect.fn("logicpacks.ledger.allowedProject")(function* (
  caller: Caller,
  projectId: string,
) {
  const access = yield* LogicPacksAccess;
  return caller.kind === "operator" || access.roleOf(caller.userId, projectId) !== null;
});

const signedIn = Effect.gen(function* () {
  const caller = yield* resolveCaller;
  return caller.kind === "anonymous" ? null : (caller as Caller);
});

const unauthenticated = json({ error: "unauthenticated" }, 401);
const notFound = json({ error: "not_found", message: "Not found." }, 404);

/** A thread the caller may act in, and its project. */
const allowedThread = Effect.fn("logicpacks.ledger.allowedThread")(function* (
  caller: Caller,
  threadId: string,
) {
  const ledger = yield* ProjectLedger;
  const projectId = yield* ledger.projectOfThread(threadId);
  if (projectId === null) return null;
  return (yield* allowedProject(caller, projectId)) ? projectId : null;
});

const projectRoute = HttpRouter.add(
  "GET",
  "/api/lp/ledger/project",
  Effect.gen(function* () {
    const caller = yield* signedIn;
    if (caller === null) return unauthenticated;
    const projectId = yield* queryParam("projectId");
    if (projectId.length === 0 || !(yield* allowedProject(caller, projectId))) return notFound;
    const ledger = yield* ProjectLedger;
    return json(yield* ledger.view(projectId));
  }),
);

const threadRoute = HttpRouter.add(
  "GET",
  "/api/lp/ledger/thread",
  Effect.gen(function* () {
    const caller = yield* signedIn;
    if (caller === null) return unauthenticated;
    const threadId = yield* queryParam("threadId");
    if (threadId.length === 0 || (yield* allowedThread(caller, threadId)) === null) {
      return notFound;
    }
    const ledger = yield* ProjectLedger;
    return json(yield* ledger.threadView(threadId));
  }),
);

const SendRequest = Schema.Struct({
  /** The thread the person writes from; replies come back here. */
  threadId: Schema.String,
  to: Schema.String,
  text: Schema.String,
  replyTo: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

const sendRoute = HttpRouter.add(
  "POST",
  "/api/lp/ledger/send",
  Effect.gen(function* () {
    const caller = yield* signedIn;
    if (caller === null) return unauthenticated;
    const body = yield* readBody(SendRequest);
    if (body === null) return json({ error: "bad_request" }, 400);
    const projectId = yield* allowedThread(caller, body.threadId);
    if (projectId === null) return notFound;
    const ledger = yield* ProjectLedger;
    const message = yield* ledger.send({
      projectId,
      fromThreadId: body.threadId,
      fromName: yield* callerName(caller),
      to: body.to,
      text: body.text,
      replyTo: body.replyTo ?? null,
    });
    return json({ message });
  }).pipe(Effect.catchTags({ LedgerError: ledgerErrorResponse })),
);

const SeenRequest = Schema.Struct({
  threadId: Schema.String,
  messageIds: Schema.Array(Schema.String),
});

const seenRoute = HttpRouter.add(
  "POST",
  "/api/lp/ledger/seen",
  Effect.gen(function* () {
    const caller = yield* signedIn;
    if (caller === null) return unauthenticated;
    const body = yield* readBody(SeenRequest);
    if (body === null) return json({ error: "bad_request" }, 400);
    if ((yield* allowedThread(caller, body.threadId)) === null) return notFound;
    const ledger = yield* ProjectLedger;
    yield* ledger.markSeen(body.threadId, body.messageIds);
    return json({ ok: true });
  }),
);

const MergeRequest = Schema.Struct({
  threadId: Schema.String,
  conflictId: Schema.optionalKey(Schema.String),
  threadIds: Schema.optionalKey(Schema.Array(Schema.String)),
  people: Schema.optionalKey(Schema.Array(Schema.String)),
});

/** A person presses Merge both on a conflict: the agents start negotiating. */
const mergeRoute = HttpRouter.add(
  "POST",
  "/api/lp/ledger/merge",
  Effect.gen(function* () {
    const caller = yield* signedIn;
    if (caller === null) return unauthenticated;
    const body = yield* readBody(MergeRequest);
    if (body === null) return json({ error: "bad_request" }, 400);
    const projectId = yield* allowedThread(caller, body.threadId);
    if (projectId === null) return notFound;
    const ledger = yield* ProjectLedger;
    const negotiation = yield* ledger.proposeMerge({
      projectId,
      callerThreadId: body.threadId,
      conflictId: body.conflictId,
      threadIds: body.threadIds,
      people: body.people,
    });
    return json({ negotiation });
  }).pipe(Effect.catchTags({ LedgerError: ledgerErrorResponse })),
);

const DecideRequest = Schema.Struct({
  negotiationId: Schema.String,
  threadId: Schema.String,
  choice: Schema.Literals(["accept", "mine", "theirs", "both"]),
  override: Schema.optionalKey(Schema.Boolean),
});

/** A person answers their negotiation card: Accept, Keep mine, Keep theirs, Merge both. */
const decideRoute = HttpRouter.add(
  "POST",
  "/api/lp/ledger/decide",
  Effect.gen(function* () {
    const caller = yield* signedIn;
    if (caller === null) return unauthenticated;
    const body = yield* readBody(DecideRequest);
    if (body === null) return json({ error: "bad_request" }, 400);
    if ((yield* allowedThread(caller, body.threadId)) === null) return notFound;
    const ledger = yield* ProjectLedger;
    const negotiation = yield* ledger.decide({
      negotiationId: body.negotiationId,
      threadId: body.threadId,
      choice: body.choice,
      by: yield* callerName(caller),
      override: body.override,
    });
    return json({ negotiation });
  }).pipe(Effect.catchTags({ LedgerError: ledgerErrorResponse })),
);

const BranchRequest = Schema.Struct({
  threadId: Schema.String,
  title: Schema.optionalKey(Schema.String),
});

/** Branch a thread into a new chat, carrying its context; anyone who can work in it may. */
const branchRoute = HttpRouter.add(
  "POST",
  "/api/lp/ledger/branch",
  Effect.gen(function* () {
    const caller = yield* signedIn;
    if (caller === null) return unauthenticated;
    const body = yield* readBody(BranchRequest);
    if (body === null) return json({ error: "bad_request" }, 400);
    if ((yield* allowedThread(caller, body.threadId)) === null) return notFound;
    const ledger = yield* ProjectLedger;
    return json(
      yield* ledger.branch({
        threadId: body.threadId,
        participantId: caller.kind === "member" ? caller.userId : "host",
        title: body.title,
      }),
    );
  }).pipe(Effect.catchTags({ LedgerError: ledgerErrorResponse })),
);

// ── The same tools for agents outside LogicPacks, through `lp mcp` ──

export const LedgerToolName = Schema.Literals([
  "threads",
  "who_is_working_on",
  "send_to_thread",
  "conflicts",
  "propose_merge",
  "note",
  "packs",
  "goals",
  "goal_plan",
  "goal_update",
]);

export const LedgerToolArgs = Schema.Struct({
  query: Schema.optionalKey(Schema.String),
  to: Schema.optionalKey(Schema.String),
  message: Schema.optionalKey(Schema.String),
  replyTo: Schema.optionalKey(Schema.NullOr(Schema.String)),
  action: Schema.optionalKey(Schema.Literals(["propose", "position", "merged", "failed"])),
  negotiationId: Schema.optionalKey(Schema.String),
  conflictId: Schema.optionalKey(Schema.String),
  threadIds: Schema.optionalKey(Schema.Array(Schema.String)),
  people: Schema.optionalKey(Schema.Array(Schema.String)),
  keep: Schema.optionalKey(Schema.Array(Schema.String)),
  change: Schema.optionalKey(Schema.Array(Schema.String)),
  drop: Schema.optionalKey(Schema.Array(Schema.String)),
  insist: Schema.optionalKey(Schema.Boolean),
  note: Schema.optionalKey(Schema.String),
  branch: Schema.optionalKey(Schema.NullOr(Schema.String)),
  summary: Schema.optionalKey(Schema.String),
  goal: Schema.optionalKey(Schema.String),
  decision: Schema.optionalKey(Schema.String),
  // Goals: goal_plan drafts (or, with goalId, revises a draft); goal_update moves a milestone.
  title: Schema.optionalKey(Schema.String),
  outcome: Schema.optionalKey(Schema.String),
  milestones: Schema.optionalKey(GoalPlan.fields.milestones),
  goalId: Schema.optionalKey(Schema.String),
  milestoneId: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(Schema.Literals(["in_progress", "blocked", "done"])),
  criteria: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        criterion: Schema.String,
        met: Schema.Boolean,
        evidence: Schema.optionalKey(Schema.String),
      }),
    ).check(Schema.isMaxLength(12)),
  ),
});
export type LedgerToolArgs = typeof LedgerToolArgs.Type;

/**
 * One ledger tool call for an agent in `projectId`, acting from `threadId`
 * (null for an agent with no thread here yet). Answers in plain text.
 */
export const runLedgerTool = Effect.fn("logicpacks.ledger.runTool")(function* (input: {
  readonly projectId: string;
  readonly threadId: string | null;
  readonly name: string;
  readonly tool: typeof LedgerToolName.Type;
  readonly args: LedgerToolArgs;
  /** Reads the project's packs; without it the `packs` tool says it is unavailable here. */
  readonly readPacks?: PacksReader;
}) {
  const ledger = yield* ProjectLedger;
  const { args } = input;
  switch (input.tool) {
    case "threads": {
      const view = yield* ledger.view(input.projectId);
      const nowMs = yield* Clock.currentTimeMillis;
      const threads = view.threads
        .filter((thread) => thread.threadId !== input.threadId)
        .map((thread) => describeThread(thread, nowMs));
      const decisions = view.decisions.slice(-5).map((decision) => `- ${decision.text}`);
      return [
        threads.length === 0 ? "No other threads in this project." : threads.join("\n"),
        ...(decisions.length === 0 ? [] : ["Recent decisions:", ...decisions]),
      ].join("\n");
    }
    case "who_is_working_on": {
      if (!args.query) return yield* new LedgerError({ reason: "invalid", message: "Pass query." });
      return (yield* ledger.whoIsWorkingOn(input.projectId, args.query, input.threadId)).answer;
    }
    case "conflicts": {
      const view = yield* ledger.view(input.projectId);
      return describeConflicts(view.conflicts.filter((conflict) => conflict.state !== "resolved"));
    }
    case "send_to_thread": {
      if (!args.message || (!args.to && !args.replyTo)) {
        return yield* new LedgerError({ reason: "invalid", message: "Pass to and message." });
      }
      const message = yield* ledger.send({
        projectId: input.projectId,
        fromThreadId: input.threadId,
        fromName: input.name,
        to: args.to ?? "",
        text: args.message,
        replyTo: args.replyTo ?? null,
      });
      const target = (yield* ledger.view(input.projectId)).threads.find(
        (thread) => thread.threadId === message.toThreadId,
      );
      return `Sent ${message.kind} ${message.id} to ${target?.members[0]?.name ?? "the thread"} [thread ${message.toThreadId}]. They see it now; their agent gets it on its next turn${input.threadId === null ? "" : ", and replies come back to this thread"}.`;
    }
    case "goals": {
      const goals = yield* ProjectGoals;
      const all = yield* goals.list(input.projectId);
      if (args.query || args.goalId) {
        const wanted = args.goalId ?? args.query!;
        const goal = all.find((candidate) => candidate.id === wanted);
        if (goal === undefined) {
          return yield* new LedgerError({ reason: "not_found", message: `No goal ${wanted}.` });
        }
        return describeGoal(goal);
      }
      const people = yield* goals.candidates(input.projectId);
      const open = all.filter((goal) => goal.state === "draft" || goal.state === "active");
      return [
        open.length === 0 ? "No open goals in this project." : open.map(describeGoal).join("\n"),
        `People you can assign: ${people
          .map(
            (person) =>
              `${person.name} (${person.kind}${person.userId === null ? ", not joined yet" : ""})`,
          )
          .join(", ")}.`,
      ].join("\n");
    }
    case "goal_plan": {
      if (input.threadId === null) {
        return yield* new LedgerError({ reason: "invalid", message: "Plan a goal from a thread." });
      }
      if (!args.title || !args.milestones || args.milestones.length === 0) {
        return yield* new LedgerError({
          reason: "invalid",
          message: "Pass title and milestones (title, assignee, criteria, scope, due).",
        });
      }
      const goals = yield* ProjectGoals;
      const goal = yield* goals.plan({
        threadId: input.threadId,
        goalId: args.goalId,
        plan: {
          title: args.title,
          ...(args.outcome === undefined ? {} : { outcome: args.outcome }),
          milestones: args.milestones,
        },
      });
      const unknown = goal.milestones.filter((milestone) => milestone.assignee.kind === "unknown");
      return [
        `Draft goal ${goal.id} "${goal.title}" with ${goal.milestones.length} milestone(s):`,
        ...goal.milestones.map(
          (milestone) =>
            `- ${milestone.id} ${milestone.title} -> ${milestone.assignee.name}${milestone.assignee.kind === "unknown" ? " (nobody here by that name)" : ` (${milestone.assignee.kind})`}; scope: ${scopeText(milestone.scope)}`,
        ),
        unknown.length > 0
          ? `Ask your user who should do: ${unknown.map((milestone) => milestone.title).join(", ")}.`
          : "",
        `Nothing is sent yet: ${goal.ownerName} reviews and confirms it in Goals (top bar). Tell them it is ready there.`,
      ]
        .filter(Boolean)
        .join("\n");
    }
    case "goal_update": {
      if (!args.milestoneId || !args.status) {
        return yield* new LedgerError({
          reason: "invalid",
          message: "Pass milestoneId and status.",
        });
      }
      if (input.threadId === null) {
        return yield* new LedgerError({
          reason: "invalid",
          message: "Only the milestone's thread updates it.",
        });
      }
      const goals = yield* ProjectGoals;
      const actor = yield* goals.agentActor(input.threadId);
      if (actor === null) {
        return yield* new LedgerError({
          reason: "not_found",
          message: "This thread is not in a project.",
        });
      }
      const goal = yield* goals.updateMilestone({
        milestoneId: args.milestoneId,
        actor,
        status: args.status,
        note: args.note,
        report: args.criteria?.map((entry) => ({
          criterion: entry.criterion,
          met: entry.met,
          evidence: entry.evidence ?? "",
        })),
      });
      const milestone = goal.milestones.find((candidate) => candidate.id === args.milestoneId);
      return args.status === "done"
        ? `Marked "${milestone?.title}" done. ${goal.ownerName} reviews it against the criteria.`
        : `"${milestone?.title}" is ${args.status.replace("_", " ")}.`;
    }
    case "packs":
      // `query` names a pack to read in full; without it, the project's packs are listed.
      if (input.readPacks === undefined) return "Packs are not available here.";
      {
        // Agents act for the person whose thread they run in; packs are a gated feature.
        const owner =
          input.threadId === null
            ? null
            : ((yield* ledger.view(input.projectId)).threads.find(
                (t) => t.threadId === input.threadId,
              )?.members[0]?.id ?? null);
        if (owner !== null && !(yield* participantHas(owner, "packs"))) {
          return yield* new LedgerError({
            reason: "forbidden",
            message: "feature_locked: Packs is not unlocked for this account.",
          });
        }
      }
      return yield* input.readPacks(input.projectId, args.query);
    case "note": {
      if (input.threadId === null) {
        return yield* new LedgerError({ reason: "invalid", message: "Only a thread can note." });
      }
      yield* ledger.note({
        threadId: input.threadId,
        goal: args.goal,
        decision: args.decision,
        by: input.name,
      });
      return "Noted in the project ledger.";
    }
    case "propose_merge": {
      const action = args.action ?? (args.negotiationId ? "position" : "propose");
      if (action === "propose") {
        const negotiation = yield* ledger.proposeMerge({
          projectId: input.projectId,
          callerThreadId: input.threadId,
          conflictId: args.conflictId,
          threadIds: args.threadIds,
          people: args.people,
        });
        return `Negotiation ${negotiation.id} (${negotiation.state}) with ${negotiation.parties
          .map((party) => party.name)
          .join(", ")}. Post your position with action "position".`;
      }
      if (!args.negotiationId || input.threadId === null) {
        return yield* new LedgerError({
          reason: "invalid",
          message: "Pass negotiationId, from a thread in the negotiation.",
        });
      }
      const negotiation =
        action === "position"
          ? yield* ledger.position({
              negotiationId: args.negotiationId,
              threadId: input.threadId,
              position: {
                keep: args.keep ?? [],
                change: args.change ?? [],
                drop: args.drop ?? [],
                insist: args.insist ?? false,
                note: args.note ?? "",
              },
            })
          : yield* ledger.recordMerge({
              negotiationId: args.negotiationId,
              threadId: input.threadId,
              ok: action === "merged",
              branch: args.branch ?? null,
              summary: args.summary ?? (action === "merged" ? "Merged." : "Merge failed."),
            });
      return `Negotiation ${negotiation.id} is ${negotiation.state}${negotiation.plan === null ? "" : `: ${negotiation.plan.summary}`}`;
    }
  }
});

const HelperToolRequest = Schema.Struct({
  ...ExternalSessionLocation.fields,
  source: Schema.optionalKey(ExternalSessionSource),
  sessionId: Schema.optionalKey(Schema.String),
  tool: LedgerToolName,
  args: Schema.optionalKey(LedgerToolArgs),
});

/** `lp mcp` calls the ledger tools for Codex and Claude Code sessions, scoped by their folder. */
const helperToolRoute = HttpRouter.add(
  "POST",
  "/api/lp/helper/ledger",
  Effect.gen(function* () {
    const caller = yield* resolveHelperCaller;
    if (caller === null) return unauthenticated;
    const body = yield* readBody(HelperToolRequest);
    if (body === null) return json({ error: "bad_request" }, 400);
    if (body.tool === "packs") {
      const locked = yield* featureGate("packs");
      if (locked !== null) return locked;
    }
    const sessions = yield* ExternalSessions;
    const context = yield* sessions.context(caller, body);
    if (!context.linked) return json({ error: "not_linked", message: context.message }, 404);
    const ledger = yield* ProjectLedger;
    const own =
      body.source !== undefined && body.sessionId !== undefined
        ? externalThreadId(body.source, body.sessionId)
        : null;
    const threadId =
      own !== null && (yield* ledger.projectOfThread(own)) === context.projectId ? own : null;
    const text = yield* runLedgerTool({
      projectId: context.projectId,
      threadId,
      name: yield* callerName(caller),
      tool: body.tool,
      args: body.args ?? {},
      readPacks: yield* packsReader,
    });
    return json({ text, projectId: context.projectId, threadId });
  }).pipe(
    Effect.catchTags({
      LedgerError: ledgerErrorResponse,
      ExternalSessionError: (error) =>
        Effect.succeed(json({ error: "storage", message: error.message }, 500)),
    }),
  ),
);

export const layer = Layer.mergeAll(
  projectRoute,
  threadRoute,
  sendRoute,
  seenRoute,
  mergeRoute,
  decideRoute,
  branchRoute,
  helperToolRoute,
);
