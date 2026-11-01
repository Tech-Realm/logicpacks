import {
  asRecord,
  asString,
  oneLine,
  type ParserState,
  parseJsonLine,
  type SessionEvent,
  summarize,
  type TranscriptLine,
} from "./events.ts";

const contentText = (content: unknown, blockTypes: ReadonlyArray<string>) =>
  Array.isArray(content)
    ? content
        .map((block) => {
          const record = asRecord(block);
          return record && blockTypes.includes(String(record.type))
            ? (asString(record.text) ?? "")
            : "";
        })
        .filter((part) => part.trim().length > 0)
        .join("\n")
    : "";

/** `["/bin/zsh", "-lc", "npm test"]` reads as `npm test`. */
const commandText = (command: unknown): string => {
  if (typeof command === "string") return command;
  if (!Array.isArray(command)) return "";
  const parts = command.map(String);
  const shellFlag = parts.findIndex((part) => part === "-lc" || part === "-c");
  return shellFlag >= 0 && parts[shellFlag + 1] !== undefined
    ? parts.slice(shellFlag + 1).join(" ")
    : parts.join(" ");
};

const filePath = (value: string) => value.replace(/^file:\/\//, "");

/** Codex's `item_completed` records: one finished item each, already free of setup preambles. */
const modernItem = (item: Record<string, unknown>, at: string): SessionEvent | null => {
  const uid = asString(item.id);
  if (!uid) return null;
  switch (item.type) {
    case "UserMessage": {
      const text = contentText(item.content, ["text", "Text", "input_text"]);
      return text ? { uid, at, type: "user", text } : null;
    }
    case "AgentMessage": {
      const text = contentText(item.content, ["Text", "text", "output_text"]);
      return text ? { uid, at, type: "assistant", text } : null;
    }
    case "CommandExecution": {
      const exitCode = typeof item.exit_code === "number" ? item.exit_code : undefined;
      const output = summarize(asString(item.aggregated_output) ?? "");
      return {
        uid,
        at,
        type: "tool",
        tool: {
          name: "shell",
          kind: "command",
          input: commandText(item.command),
          status:
            item.status === "failed" || (exitCode !== undefined && exitCode !== 0)
              ? "failed"
              : "completed",
          ...(output ? { output } : {}),
          ...(exitCode === undefined ? {} : { exitCode }),
        },
      };
    }
    case "FileChange": {
      const files = Object.keys(asRecord(item.changes) ?? {}).map(filePath);
      return {
        uid,
        at,
        type: "tool",
        tool: {
          name: "apply_patch",
          kind: "file_change",
          input: files.length === 1 ? files[0]! : `${files.length} files`,
          status: item.status === "failed" ? "failed" : "completed",
          files,
        },
      };
    }
    case "McpToolCall": {
      // Named as Claude Code names MCP tools, so privacy.ts treats both alike.
      const name = `mcp__${asString(item.server) ?? "mcp"}__${asString(item.tool) ?? "tool"}`;
      const result = asRecord(item.result);
      const output = summarize(contentText(result?.content, ["text"]));
      return {
        uid,
        at,
        type: "tool",
        tool: {
          name,
          kind: "other",
          input: oneLine(JSON.stringify(item.arguments ?? {})),
          status: item.status === "failed" ? "failed" : "completed",
          ...(output ? { output } : {}),
        },
      };
    }
    case "Extension": {
      const query = asString(item.query) ?? "";
      return item.kind === "web.search"
        ? {
            uid,
            at,
            type: "tool",
            tool: { name: "web_search", kind: "web", input: query, status: "completed" },
          }
        : null;
    }
    default:
      return null;
  }
};

/**
 * Turns new lines of a Codex rollout (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`)
 * into helper events. Current Codex writes `item_completed` records; older versions
 * wrote `event_msg` user and agent messages plus exec and patch end events.
 */
export const parseCodexLines = (
  lines: ReadonlyArray<TranscriptLine>,
  state: ParserState,
): Array<SessionEvent> => {
  const events: Array<SessionEvent> = [];
  for (const line of lines) {
    const record = parseJsonLine(line.text);
    if (record === null) continue;
    const payload = asRecord(record.payload) ?? {};
    const at = asString(record.timestamp) ?? new Date().toISOString();

    if (record.type === "session_meta") {
      const id = asString(payload.id) ?? asString(payload.session_id);
      if (id) state.meta.sessionId = id;
      const cwd = asString(payload.cwd);
      if (cwd) state.meta.cwd = cwd;
      const branch = asString(asRecord(payload.git)?.branch);
      if (branch) state.meta.branch = branch;
      continue;
    }
    if (record.type === "turn_context") {
      const model = asString(payload.model);
      if (model) state.meta.model = model;
      const cwd = asString(payload.cwd);
      if (cwd) state.meta.cwd = cwd;
      continue;
    }
    if (record.type !== "event_msg") continue;

    if (payload.type === "item_completed") {
      state.modernCodex = true;
      const item = asRecord(payload.item);
      const event = item ? modernItem(item, at) : null;
      if (event) events.push(event);
      continue;
    }
    if (state.modernCodex) continue;

    const uid = `line:${line.offset}`;
    if (payload.type === "user_message") {
      const text = asString(payload.message) ?? "";
      if (text.trim()) events.push({ uid, at, type: "user", text });
    } else if (payload.type === "agent_message") {
      const text = asString(payload.message) ?? "";
      if (text.trim()) events.push({ uid, at, type: "assistant", text });
    } else if (payload.type === "exec_command_end") {
      const exitCode = typeof payload.exit_code === "number" ? payload.exit_code : undefined;
      const output = summarize(
        asString(payload.aggregated_output) ??
          [asString(payload.stdout), asString(payload.stderr)].filter(Boolean).join("\n"),
      );
      events.push({
        uid: asString(payload.call_id) ?? uid,
        at,
        type: "tool",
        tool: {
          name: "shell",
          kind: "command",
          input: commandText(payload.command),
          status: exitCode !== undefined && exitCode !== 0 ? "failed" : "completed",
          ...(output ? { output } : {}),
          ...(exitCode === undefined ? {} : { exitCode }),
        },
      });
    } else if (payload.type === "patch_apply_end") {
      const files = Object.keys(asRecord(payload.changes) ?? {}).map(filePath);
      events.push({
        uid: asString(payload.call_id) ?? uid,
        at,
        type: "tool",
        tool: {
          name: "apply_patch",
          kind: "file_change",
          input: files.length === 1 ? files[0]! : `${files.length} files`,
          status: payload.success === false ? "failed" : "completed",
          files,
        },
      });
    }
  }
  return events;
};
