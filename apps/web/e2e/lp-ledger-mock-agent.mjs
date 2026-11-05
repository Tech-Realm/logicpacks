#!/usr/bin/env node
// A scripted ACP agent for the cross-thread E2E. It reads the <logicpacks_project> block LogicPacks adds
// to each turn, calls the LogicPacks ledger MCP tools through LogicPacks's own acp-mcp-call bridge, and
// runs git for an agreed merge. Commands in the user's text:
//   "what is <name> working on" / "who is working on <x>"  -> who_is_working_on
//   "tell <name> to <task>"                                 -> send_to_thread
//   "reply: <text>"                                         -> answers the newest message in the inbox
//   "edit <file> <text> [(hold <n>s)]"                      -> writes the file, as an Edit tool would
//   "run! <shell command>"                                  -> asks permission for an execute tool call; runs it only if the host allows
//   "edit! <file> <text>"                                   -> asks permission for an edit tool call; writes only if allowed
//   "ask <name> to <task> [in <dir>/] [and not touch <dir>/], and <name> to ..., by <day>"
//                                                           -> goal_plan (drafts a goal)
//   "goal done[: <note>]"                                   -> goal_update done for this thread's milestone
//   "branch <name> <file> <text> [(hold <n>s)]"             -> git: new branch <name>, write + commit <file> on it,
//                                                              hold, switch back and merge it (--no-ff) into where it started
// and on its own: posts a position when a negotiation waits for it, merges when it is the merger.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

const sessions = new Map();
// Permission requests the agent sent the client and is waiting on (ACP session/request_permission).
const pendingAsks = new Map();
let askCounter = 0;
const send = (message) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const log = (entry) => {
  if (process.env.LP_MOCK_LOG) {
    NodeFS.appendFileSync(
      process.env.LP_MOCK_LOG,
      `${JSON.stringify({ at: Date.now(), ...entry })}\n`,
    );
  }
};
const update = (sessionId, body) =>
  send({ method: "session/update", params: { sessionId, update: body } });
const say = (sessionId, text) =>
  update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });

/** Asks the client for permission the way a real agent does before a tool call; true when allowed. */
function askPermission(sessionId, toolCall) {
  return new Promise((resolve) => {
    const id = `ask-${(askCounter += 1)}`;
    pendingAsks.set(id, resolve);
    send({
      id,
      method: "session/request_permission",
      params: {
        sessionId,
        toolCall,
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "reject", name: "Reject", kind: "reject_once" },
        ],
      },
    });
  }).then(
    (result) =>
      result?.outcome?.outcome === "selected" && /allow/.test(String(result.outcome.optionId)),
  );
}

/** Calls one LogicPacks MCP tool the way a CLI agent's shell would: `logicpacks acp-mcp-call <tool> <json>`. */
function callTool(session, tool, args) {
  const server = session.mcpServers.find((candidate) => candidate.args?.includes("acp-mcp-bridge"));
  if (!server) return `no LogicPacks MCP server was offered`;
  const env = { ...process.env };
  for (const entry of server.env ?? []) env[entry.name] = entry.value;
  const commandArgs = server.args.map((arg) => (arg === "acp-mcp-bridge" ? "acp-mcp-call" : arg));
  const result = NodeChildProcess.spawnSync(
    server.command,
    [...commandArgs, tool, JSON.stringify(args)],
    { env, encoding: "utf8", timeout: 30_000 },
  );
  const out = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  log({ tool, args, out: out.slice(0, 2000) });
  try {
    const parsed = JSON.parse(result.stdout);
    const text = parsed?.content?.map?.((block) => block.text ?? "").join("\n");
    return parsed?.structuredContent?.answer ?? (text || out);
  } catch {
    return out;
  }
}

const git = (cwd, ...args) =>
  NodeChildProcess.spawnSync("git", args, { cwd, encoding: "utf8", timeout: 60_000 });

/** An agreed "merge both": merge the remote into this checkout keeping both sides, on a branch too. */
function mergeBoth(cwd, negotiationId, me) {
  const identity = ["-c", `user.name=${me}'s agent`, "-c", "user.email=agent@logicpacks.test"];
  const branch = git(cwd, "rev-parse", "--abbrev-ref", "HEAD").stdout.trim() || "main";
  git(cwd, "fetch", "--quiet", "origin");
  const merge = git(cwd, ...identity, "merge", "--no-ff", "--no-commit", `origin/${branch}`);
  const conflicted = git(cwd, "diff", "--name-only", "--diff-filter=U")
    .stdout.split("\n")
    .filter(Boolean);
  for (const file of conflicted) {
    const full = NodePath.join(cwd, file);
    const kept = NodeFS.readFileSync(full, "utf8")
      .split("\n")
      .filter((line) => !/^(<<<<<<<|=======|>>>>>>>)( |$)/.test(line))
      .join("\n");
    NodeFS.writeFileSync(full, kept);
  }
  git(cwd, "add", "-A");
  const commit = git(
    cwd,
    ...identity,
    "commit",
    "--quiet",
    "--no-edit",
    "-m",
    `Merge both versions (${negotiationId})`,
  );
  const mergeBranch = `lp/merge-${negotiationId}`;
  const pushed = git(cwd, "push", "--quiet", "origin", `HEAD:refs/heads/${mergeBranch}`);
  log({
    merge: merge.status,
    conflicted,
    commit: commit.status,
    pushed: pushed.status,
    stderr: pushed.stderr,
  });
  return {
    ok: commit.status === 0 && pushed.status === 0,
    branch: mergeBranch,
    files: conflicted,
    error: `${merge.stderr}${commit.stderr}${pushed.stderr}`.trim(),
  };
}

async function runTurn(sessionId, promptText) {
  const session = sessions.get(sessionId);
  const ledger = promptText.match(/<logicpacks_project>[\s\S]*?<\/logicpacks_project>/)?.[0] ?? "";
  // LogicPacks wraps the context it adds in <snake_case> blocks; what is left is what the user typed.
  const rawText =
    promptText.match(/<user_request>([\s\S]*?)<\/user_request>/)?.[1]?.trim() ??
    promptText
      .replace(/<([a-z][a-z0-9_]*)(\s[^>]*)?>[\s\S]*?<\/\1>/g, "")
      .replace(/^[\s\S]*?\bUser message:\n/, "")
      .trim();
  // Only what the person typed: the ledger block can carry other threads' goals ("edit x ...").
  const userText = rawText.split("User message:\n").pop().trim();
  log({ sessionId, cwd: session.cwd, ledger, userText: userText.slice(-600) });
  const replies = [];

  // Who am I: the person the other side of a negotiation is not.
  const negotiation = ledger.match(
    /Negotiation (\S+) \((\w+), round (\d+)\/(\d+)\) on (.+?) with (.+?)\. You speak for (.+?)\.\n/,
  );
  if (negotiation) {
    const [, id, , round, , files, others, me] = negotiation;
    if (/Your turn: post your position/.test(ledger)) {
      const answer = callTool(session, "lp_project_propose_merge", {
        action: "position",
        negotiationId: id,
        keep: [`${me}'s wording of ${files}`],
        drop: [`${others}'s wording of ${files}`],
        insist: true,
        note: `round ${round}: my user needs their wording in ${files}`,
      });
      replies.push(`Posted my position in negotiation ${id} with ${others}: ${answer}`);
    } else if (/You merge it: branch lp\/merge-/.test(ledger)) {
      const me = "LogicPacks merge";
      const merged = mergeBoth(session.cwd, id, me);
      const answer = callTool(session, "lp_project_propose_merge", {
        action: merged.ok ? "merged" : "failed",
        negotiationId: id,
        branch: merged.branch,
        summary: merged.ok
          ? `Kept both versions of ${merged.files.join(", ") || files}; pushed ${merged.branch}.`
          : `Merge failed: ${merged.error.slice(0, 200)}`,
      });
      replies.push(`Merged on ${merged.branch}: ${answer}`);
    }
  }

  const who =
    userText.match(/what is (\w+) working on/i)?.[1] ??
    userText.match(/who is working on ([^\n?]+)/i)?.[1]?.trim();
  if (who) {
    replies.push(
      `LEDGER ANSWER: ${callTool(session, "lp_project_who_is_working_on", { query: who })}`,
    );
  }
  const tell = userText.match(/tell (\w+) to ([^\n]+)/i);
  if (tell) {
    const answer = callTool(session, "lp_project_send_to_thread", {
      to: tell[1],
      message: `Please ${tell[2].trim()}`,
    });
    replies.push(`Sent to ${tell[1]}: ${answer}`);
  }
  const reply = userText.match(/reply:\s*([^\n]+)/i);
  if (reply) {
    const asks = [...ledger.matchAll(/Message (\S+) \(ask\) from .*?\[thread ([^\]]+)\]/g)];
    const last = asks.at(-1);
    if (last) {
      const answer = callTool(session, "lp_project_send_to_thread", {
        to: last[2],
        replyTo: last[1],
        message: reply[1].trim(),
      });
      replies.push(`Replied to ${last[1]}: ${answer}`);
    } else {
      replies.push("There is no message to reply to.");
    }
  }
  const ask = userText.match(/^ask (.+)$/is)?.[1];
  if (ask) {
    const due = ask.match(/,?\s*by (\w+)\s*$/i)?.[1] ?? null;
    const body = due ? ask.replace(/,?\s*by \w+\s*$/i, "") : ask;
    const milestones = body
      .split(/,\s*and\s+|;\s*/i)
      .map((clause) => clause.trim().match(/^(\w+) to (.+)$/i))
      .filter(Boolean)
      .map(([, assignee, task]) => {
        const paths = [...task.matchAll(/\bin (\S+\/)/g)].map((m) => m[1]);
        const avoid = [...task.matchAll(/not touch (\S+\/)/g)].map((m) => m[1]);
        const title = task
          .replace(/\s*and not touch \S+/g, "")
          .replace(/\s+in \S+\/$/, "")
          .trim();
        return {
          title: title.charAt(0).toUpperCase() + title.slice(1),
          assignee,
          criteria: [`${title} works`, "Tests pass"],
          scope: { paths, avoid },
          ...(due ? { due } : {}),
        };
      });
    const answer = callTool(session, "lp_project_goal_plan", {
      title: `Team goal: ${milestones.map((m) => m.title.toLowerCase()).join(" and ")}`.slice(
        0,
        120,
      ),
      outcome: "Everything the host asked for, inside the guardrails.",
      milestones,
    });
    replies.push(`GOAL DRAFT: ${answer}`);
  }
  const doneNote = userText.match(/^goal done(?::\s*(.+))?$/im);
  if (doneNote) {
    const mine = ledger.match(/Your milestone (\S+) of goal/);
    const criteria = ledger.match(/Done when: (.+?)\. Scope:/)?.[1]?.split("; ") ?? [];
    const answer = mine
      ? callTool(session, "lp_project_goal_update", {
          milestoneId: mine[1],
          status: "done",
          note: doneNote[1]?.trim() || "Done.",
          criteria: criteria.map((criterion) => ({ criterion, met: true, evidence: "checked" })),
        })
      : "No milestone is assigned to this thread.";
    replies.push(`GOAL UPDATE: ${answer}`);
  }
  const hold = Number(userText.match(/\(hold (\d+)s\)/)?.[1] ?? 0);
  const branchWork = userText.match(/^branch (\S+) (\S+) ([^\n(]+)/i);
  if (branchWork) {
    const [, name, file, text] = branchWork;
    const identity = ["-c", "user.name=Mock agent", "-c", "user.email=agent@logicpacks.test"];
    const base = git(session.cwd, "rev-parse", "--abbrev-ref", "HEAD").stdout.trim();
    const created = git(session.cwd, "checkout", "-b", name);
    const full = NodePath.join(session.cwd, file);
    const before = NodeFS.existsSync(full) ? NodeFS.readFileSync(full, "utf8") : "";
    const after = `${text.trim()}\n`;
    NodeFS.mkdirSync(NodePath.dirname(full), { recursive: true });
    NodeFS.writeFileSync(full, after);
    update(sessionId, {
      sessionUpdate: "tool_call",
      toolCallId: `edit-${NodeCrypto.randomUUID()}`,
      title: `Write ${file}`,
      kind: "edit",
      status: "completed",
      content: [{ type: "diff", path: full, oldText: before, newText: after }],
      locations: [{ path: full }],
      rawInput: { file_path: full, content: after },
    });
    git(session.cwd, "add", "--", file);
    const committed = git(session.cwd, ...identity, "commit", "--quiet", "-m", `${name}: ${file}`);
    log({ branch: name, base, created: created.status, committed: committed.status });
    if (hold > 0) await new Promise((resolve) => setTimeout(resolve, hold * 1000));
    const back = git(session.cwd, "checkout", base);
    const merged = git(
      session.cwd,
      ...identity,
      "merge",
      "--no-ff",
      "-m",
      `Merge ${name} into ${base}`,
      name,
    );
    log({ merge: merged.status, back: back.status, stderr: `${back.stderr}${merged.stderr}` });
    replies.push(
      merged.status === 0
        ? `Branch ${name} merged into ${base}. (cwd ${session.cwd})`
        : `Branch ${name} merge FAILED: ${`${back.stderr}${merged.stderr}`.trim().slice(0, 300)} (cwd ${session.cwd})`,
    );
  }
  const guardedRun = userText.match(/run! ([^\n]+)/i);
  if (guardedRun) {
    const command = guardedRun[1].trim();
    const allowed = await askPermission(sessionId, {
      toolCallId: `run-${NodeCrypto.randomUUID()}`,
      title: command,
      kind: "execute",
      status: "pending",
      rawInput: { command },
    });
    if (!allowed) replies.push(`REFUSED run: ${command}`);
    else {
      const ran = NodeChildProcess.spawnSync("sh", ["-c", command], {
        cwd: session.cwd,
        encoding: "utf8",
      });
      replies.push(`RAN ${command}: ${(ran.stdout ?? "").trim()} (cwd ${session.cwd})`);
    }
  }
  const guardedEdit = userText.match(/edit! (\S+) ([^\n(]+)/i);
  if (guardedEdit) {
    const full = NodePath.join(session.cwd, guardedEdit[1]);
    const allowed = await askPermission(sessionId, {
      toolCallId: `edit-${NodeCrypto.randomUUID()}`,
      title: `Write ${guardedEdit[1]}`,
      kind: "edit",
      status: "pending",
      locations: [{ path: full }],
      rawInput: { file_path: full },
    });
    if (!allowed) replies.push(`REFUSED edit: ${guardedEdit[1]}`);
    else {
      NodeFS.mkdirSync(NodePath.dirname(full), { recursive: true });
      NodeFS.writeFileSync(full, `${guardedEdit[2].trim()}\n`);
      replies.push(`WROTE ${guardedEdit[1]}. (cwd ${session.cwd})`);
    }
  }
  const edit = userText.match(/(?<![!\w])edit (\S+) ([^\n(]+)/i);
  if (edit) {
    const full = NodePath.join(session.cwd, edit[1]);
    const before = NodeFS.existsSync(full) ? NodeFS.readFileSync(full, "utf8") : "";
    NodeFS.mkdirSync(NodePath.dirname(full), { recursive: true });
    const after = `${edit[2].trim()}\n`;
    NodeFS.writeFileSync(full, after);
    update(sessionId, {
      sessionUpdate: "tool_call",
      toolCallId: `edit-${NodeCrypto.randomUUID()}`,
      title: `Write ${edit[1]}`,
      kind: "edit",
      status: "completed",
      content: [{ type: "diff", path: full, oldText: before, newText: after }],
      locations: [{ path: full }],
      rawInput: { file_path: full, content: after },
    });
    replies.push(`Edited ${edit[1]}. (cwd ${session.cwd})`);
    // Holding the turn open keeps LogicPacks sync from committing until the harness says go.
    if (hold > 0) await new Promise((resolve) => setTimeout(resolve, hold * 1000));
  }
  // "list files": what this agent sees in its checkout (uploads land here too).
  if (/list files/i.test(userText)) {
    const found = [];
    const walk = (relative) => {
      for (const entry of NodeFS.readdirSync(NodePath.join(session.cwd, relative), {
        withFileTypes: true,
      })) {
        if (entry.name === ".git") continue;
        const child = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(child);
        else found.push(child);
      }
    };
    walk("");
    replies.push(`FILES: ${found.sort().join(", ")}`);
  }
  if (replies.length === 0) {
    const others = (ledger.match(/^- /gm) ?? []).length;
    replies.push(ledger ? `Done. The ledger lists ${others} other thread(s).` : "Done.");
  }
  say(sessionId, replies.join("\n\n"));
}

async function handle(message) {
  const params = message.params ?? {};
  switch (message.method) {
    case "initialize":
      return {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: false, audio: false, embeddedContext: true },
        },
        authMethods: [],
        agentInfo: { name: "lp-ledger-mock", version: "1" },
      };
    case "session/new":
    case "session/load":
    case "session/fork": {
      const sessionId =
        message.method === "session/load" ? String(params.sessionId) : NodeCrypto.randomUUID();
      sessions.set(sessionId, {
        cwd: typeof params.cwd === "string" ? params.cwd : process.cwd(),
        mcpServers: Array.isArray(params.mcpServers) ? params.mcpServers : [],
        me: null,
      });
      return {
        ...(message.method === "session/load" ? {} : { sessionId }),
        models: {
          currentModelId: "ledger",
          availableModels: [{ modelId: "ledger", name: "Ledger mock" }],
        },
      };
    }
    case "session/prompt": {
      const sessionId = String(params.sessionId);
      if (!sessions.has(sessionId)) throw new Error(`Unknown session ${sessionId}`);
      const text = (params.prompt ?? [])
        .map((block) => block.text ?? block.resource?.text ?? "")
        .join("\n");
      try {
        await runTurn(sessionId, text);
      } catch (error) {
        log({ error: String(error?.stack ?? error) });
        say(sessionId, `Mock agent error: ${error?.message ?? error}`);
      }
      return { stopReason: "end_turn" };
    }
    case "session/close":
      sessions.delete(String(params.sessionId));
      return {};
    case "authenticate":
    case "session/set_mode":
    case "session/set_model":
      return {};
    default:
      throw Object.assign(new Error(`Method not found: ${message.method}`), { code: -32601 });
  }
}

const input = NodeReadline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.method === undefined && message.id !== undefined && pendingAsks.has(message.id)) {
    const resolve = pendingAsks.get(message.id);
    pendingAsks.delete(message.id);
    resolve(message.result ?? null);
    return;
  }
  if (message.method === undefined || message.id === undefined || message.id === null) return;
  handle(message).then(
    (result) => send({ id: message.id, result }),
    (error) =>
      send({ id: message.id, error: { code: error.code ?? -32603, message: error.message } }),
  );
});
