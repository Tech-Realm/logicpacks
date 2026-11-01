import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

import { callHost, gitInfo, OfflineError, RejectedError } from "./client.ts";
import { asRecord, asString, type SessionSource } from "./events.ts";
import { formatInbox, type InboxItem } from "./inbox.ts";
import { callJobsTool, JOBS_TOOL_NAMES, JOBS_TOOLS } from "./jobs.ts";
import { NOT_CONNECTED } from "./localHost.ts";
import {
  helperHome,
  isUnlinked,
  loadConfig,
  type HelperConfig,
  type TranscriptState,
} from "./store.ts";

/**
 * `lp mcp`: a stdio MCP server that gives Codex and Claude Code sessions the
 * LogicPacks project ledger. It signs in with the helper's stored token and
 * finds the project from the session's folder and git remote.
 */

const list = (description: string) => ({
  type: "array",
  items: { type: "string" },
  maxItems: 30,
  description,
});

export const LEDGER_TOOLS = [
  {
    name: "threads",
    description:
      "The project ledger: every other thread in this project with its people, agent, goal, files and branch, plus recent decisions.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: "who_is_working_on",
    description:
      'Who is working on a person, file or topic in this project ("Ali", "src/checkout.tsx", "newsletter"). Call it before you start work and when asked about teammates.',
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "A person, file path or topic." } },
      required: ["query"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "conflicts",
    description: "Open conflicts in this project: files, whose work, why, and any negotiation.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: "send_to_thread",
    description:
      "Message a teammate's thread (\"tell Ali to work on X\"): `to` is a person's name or a thread id. They see it at once; their agent gets it next turn. Answer a message with `replyTo`.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string" },
        message: { type: "string", maxLength: 4000 },
        replyTo: { type: "string", description: "The id of the message you are answering." },
      },
      required: ["message"],
    },
  },
  {
    name: "propose_merge",
    description:
      "Negotiate a conflict with the other agents. action propose (default without negotiationId): start, for a conflictId or threadIds/people. action position: keep/change/drop lists, insist only for what your user needs. Agreed: the named agent merges on lp/merge-<id> and reports action merged (branch, summary) or failed.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["propose", "position", "merged", "failed"] },
        negotiationId: { type: "string" },
        conflictId: { type: "string" },
        threadIds: list("Threads to include."),
        people: list("People to include."),
        keep: list("What you keep as is."),
        change: list("What you accept changing."),
        drop: list("What you give up."),
        insist: { type: "boolean" },
        note: { type: "string" },
        branch: { type: "string" },
        summary: { type: "string" },
      },
    },
  },
  {
    name: "note",
    description:
      "Tell the project ledger your current goal, or record a decision teammates should know.",
    inputSchema: {
      type: "object",
      properties: { goal: { type: "string" }, decision: { type: "string" } },
    },
  },
  {
    name: "packs",
    description:
      "Packs saved in this project carry context between threads and apps: summary, decisions, file and app references, workflow steps. No query lists them; query = a pack id reads one in full.",
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
  },
  {
    name: "ask",
    description:
      "Ask a teammate's agent a question (`to`: a person's name). Their agent answers with reply; the answer shows in your inbox.",
    inputSchema: {
      type: "object",
      properties: { to: { type: "string" }, question: { type: "string", maxLength: 4000 } },
      required: ["to", "question"],
    },
  },
  {
    name: "reply",
    description: "Answer a question or message from your inbox by its id.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, text: { type: "string", maxLength: 4000 } },
      required: ["id", "text"],
    },
  },
  {
    name: "inbox",
    description:
      "Messages, questions from other agents, conflicts and negotiations waiting for you. Check it at the start of a session.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: "goals",
    description:
      "Goals (Beta) in this project: drafts and active goals with each milestone's assignee, criteria, scope, due date and status, plus the people you can assign. goalId reads one.",
    inputSchema: { type: "object", properties: { goalId: { type: "string" } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: "goal_plan",
    description:
      'Draft a goal when your user asks teammates or experts to do work ("ask Omar to do X, and Priya to do Y by Friday"). Nothing is sent: your user reviews and confirms it in LogicPacks Goals. Pass goalId to revise your draft.',
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        outcome: { type: "string" },
        goalId: { type: "string" },
        milestones: {
          type: "array",
          maxItems: 12,
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              assignee: { type: "string", description: "A person's or expert's name." },
              criteria: list("Acceptance criteria."),
              scope: {
                type: "object",
                properties: {
                  paths: list("Paths or globs the work may touch."),
                  avoid: list("Paths or globs it must not touch."),
                  branch: { type: "string" },
                  newDependencies: { type: "boolean" },
                  notes: list('Other boundaries, like "don\'t change the API".'),
                },
              },
              due: { type: "string", description: "YYYY-MM-DD or a weekday." },
            },
            required: ["title", "assignee"],
          },
        },
      },
      required: ["title", "milestones"],
    },
  },
  {
    name: "goal_update",
    description:
      "Report on the goal milestone assigned to this session: status in_progress, blocked or done. With done, add a note and each criterion with met and evidence.",
    inputSchema: {
      type: "object",
      properties: {
        milestoneId: { type: "string" },
        status: { type: "string", enum: ["in_progress", "blocked", "done"] },
        note: { type: "string" },
        criteria: {
          type: "array",
          maxItems: 12,
          items: {
            type: "object",
            properties: {
              criterion: { type: "string" },
              met: { type: "boolean" },
              evidence: { type: "string" },
            },
            required: ["criterion", "met"],
          },
        },
      },
      required: ["milestoneId", "status"],
    },
  },
] as const;

/** ask and reply are send_to_thread under friendlier names; inbox reads the connect route. */
const aliasTool = (name: string, args: Record<string, unknown>) => {
  if (name === "ask")
    return { tool: "send_to_thread", args: { to: args.to, message: args.question } };
  if (name === "reply")
    return { tool: "send_to_thread", args: { replyTo: args.id, message: args.text } };
  return { tool: name, args };
};

const TOOL_NAMES = new Set<string>(LEDGER_TOOLS.map((tool) => tool.name));

const SESSION_MAX_AGE_MS = 12 * 60 * 60_000;

/**
 * The session this server most likely belongs to: the newest linked transcript
 * of `source` in the same repository. MCP clients do not pass their session id.
 */
export const guessSession = (source: SessionSource, root: string) => {
  const dir = NodePath.join(helperHome(), "state");
  let best: { sessionId: string; at: number } | null = null;
  let names: Array<string> = [];
  try {
    names = NodeFS.readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {
    return null;
  }
  for (const name of names) {
    const file = NodePath.join(dir, name);
    try {
      const at = NodeFS.statSync(file).mtimeMs;
      if (Date.now() - at > SESSION_MAX_AGE_MS || (best !== null && at <= best.at)) continue;
      const state = JSON.parse(NodeFS.readFileSync(file, "utf8")) as TranscriptState;
      const cwd = state.parser?.meta?.cwd;
      const sessionId = state.parser?.meta?.sessionId;
      if (state.source !== source || state.link?.status !== "linked" || !cwd || !sessionId) {
        continue;
      }
      if (cwd !== root && !cwd.startsWith(`${root}/`)) continue;
      best = { sessionId, at };
    } catch {}
  }
  return best?.sessionId ?? null;
};

export interface McpOptions {
  readonly cwd: string;
  readonly source: SessionSource | null;
  readonly sessionId: string | null;
  readonly loadConfig?: () => HelperConfig;
}

/** One ledger call through the host. Errors come back as text the agent can read. */
export const callLedgerTool = async (
  options: McpOptions,
  tool: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError: boolean }> => {
  const config = (options.loadConfig ?? loadConfig)();
  if (!config.server || !config.token) {
    return { text: NOT_CONNECTED, isError: true };
  }
  const git = gitInfo(options.cwd);
  if (isUnlinked(config, git.root ?? options.cwd)) {
    return {
      text: "This folder is private (lp unlink); LogicPacks tools are off here.",
      isError: true,
    };
  }
  const sessionId =
    options.sessionId ??
    (options.source !== null && git.root !== null ? guessSession(options.source, git.root) : null);
  try {
    const reply = await callHost<{ text: string }>(config, "/api/lp/helper/ledger", {
      body: {
        cwd: options.cwd,
        gitRoot: git.root,
        gitRemote: git.remote,
        ...(options.source !== null && sessionId !== null
          ? { source: options.source, sessionId }
          : {}),
        tool,
        args,
      },
      timeoutMs: 15_000,
    });
    return { text: reply.text, isError: false };
  } catch (error) {
    if (error instanceof OfflineError) {
      return { text: `The LogicPacks host is unreachable: ${error.message}`, isError: true };
    }
    if (error instanceof RejectedError) return { text: error.message, isError: true };
    throw error;
  }
};

/** The inbox as the CLI prints it. */
const readInbox = async (options: McpOptions): Promise<{ text: string; isError: boolean }> => {
  const config = (options.loadConfig ?? loadConfig)();
  if (!config.server || !config.token) {
    return { text: NOT_CONNECTED, isError: true };
  }
  try {
    const { items } = await callHost<{ items: Array<InboxItem> }>(config, "/api/lp/connect/inbox");
    return { text: formatInbox(items, Date.now()), isError: false };
  } catch (error) {
    return { text: (error as Error).message, isError: true };
  }
};

type JsonRpcId = string | number | null;

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

/** Answers one JSON-RPC message; null for notifications. */
export const handleMcpMessage = async (
  options: McpOptions,
  message: Record<string, unknown>,
): Promise<Record<string, unknown> | null> => {
  const id = (message.id ?? null) as JsonRpcId;
  const method = asString(message.method);
  const params = asRecord(message.params) ?? {};
  const isRequest = "id" in message && method !== null;
  const ok = (result: unknown) => ({ jsonrpc: "2.0", id, result });
  const fail = (code: number, text: string) => ({
    jsonrpc: "2.0",
    id,
    error: { code, message: text },
  });
  if (!isRequest) return null;
  switch (method) {
    case "initialize": {
      const asked = asString(params.protocolVersion);
      return ok({
        protocolVersion:
          asked !== null && PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "logicpacks", version: "1.0.0" },
        instructions:
          "LogicPacks project ledger: who is working on what in this project, messages between threads, conflicts and merge negotiation. Call who_is_working_on before starting work and when asked about teammates.",
      });
    }
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: [...LEDGER_TOOLS, ...JOBS_TOOLS] });
    case "tools/call": {
      const name = asString(params.name);
      if (name !== null && JOBS_TOOL_NAMES.has(name)) {
        const config = (options.loadConfig ?? loadConfig)();
        const result = await callJobsTool(config, name, asRecord(params.arguments) ?? {});
        return ok({ content: [{ type: "text", text: result.text }], isError: result.isError });
      }
      if (name === null || !TOOL_NAMES.has(name)) return fail(-32602, `Unknown tool ${name}`);
      const toolArgs = asRecord(params.arguments) ?? {};
      if (name === "inbox") {
        const result = await readInbox(options);
        return ok({ content: [{ type: "text", text: result.text }], isError: result.isError });
      }
      const mapped = aliasTool(name, toolArgs);
      const result = await callLedgerTool(options, mapped.tool, mapped.args);
      return ok({ content: [{ type: "text", text: result.text }], isError: result.isError });
    }
    case "resources/list":
      return ok({ resources: [] });
    case "prompts/list":
      return ok({ prompts: [] });
    default:
      return fail(-32601, `Method not found: ${method}`);
  }
};

/** Newline-delimited JSON-RPC over stdin/stdout, as the MCP stdio transport defines. */
export const runMcpServer = async (options: McpOptions) => {
  const input = NodeReadline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  const write = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
  const pending = new Set<Promise<void>>();
  for await (const line of input) {
    if (line.trim() === "") continue;
    let message: Record<string, unknown> | null;
    try {
      message = asRecord(JSON.parse(line));
    } catch {
      write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      continue;
    }
    if (message === null) continue;
    const work = handleMcpMessage(options, message)
      .then((reply) => {
        if (reply !== null) write(reply);
      })
      .catch((error: unknown) => {
        write({
          jsonrpc: "2.0",
          id: (message?.id ?? null) as JsonRpcId,
          error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
        });
      })
      .finally(() => pending.delete(work));
    pending.add(work);
  }
  await Promise.all(pending);
};
