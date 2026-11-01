import {
  asRecord,
  asString,
  oneLine,
  type ParserState,
  parseJsonLine,
  type PendingTool,
  rememberTool,
  type SessionEvent,
  summarize,
  type TranscriptLine,
} from "./events.ts";

const FILE_EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

/** Claude Code's slash-command echoes and local command output are not conversation. */
const isCommandEcho = (text: string) =>
  /^\s*<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat)>/.test(
    text,
  );

export const classifyClaudeTool = (name: string, rawInput: unknown): PendingTool => {
  const input = asRecord(rawInput) ?? {};
  const field = (key: string) => asString(input[key]) ?? "";
  const filePath = field("file_path") || field("notebook_path");
  if (name === "Bash") {
    return { name, kind: "command", input: field("command"), files: [] };
  }
  if (FILE_EDIT_TOOLS.has(name)) {
    return { name, kind: "file_change", input: filePath, files: filePath ? [filePath] : [] };
  }
  if (name === "Read") {
    return { name, kind: "other", input: filePath, files: filePath ? [filePath] : [] };
  }
  if (name === "Grep" || name === "Glob") {
    const where = field("path");
    return {
      name,
      kind: "search",
      input: where ? `${field("pattern")} in ${where}` : field("pattern"),
      files: [],
    };
  }
  if (name === "WebSearch") return { name, kind: "web", input: field("query"), files: [] };
  if (name === "WebFetch") return { name, kind: "web", input: field("url"), files: [] };
  const described = field("description") || field("prompt") || field("query");
  return {
    name,
    kind: "other",
    input: described ? oneLine(described) : oneLine(JSON.stringify(input)),
    files: [],
  };
};

const textOf = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      const record = asRecord(block);
      return record?.type === "text" ? (asString(record.text) ?? "") : "";
    })
    .filter((part) => part.trim().length > 0)
    .join("\n");
};

/** Claude Code tool results: a string, or text blocks; images and other blocks are left out. */
const toolResultText = (content: unknown): string =>
  typeof content === "string" ? content : textOf(content);

/**
 * Turns new lines of a Claude Code transcript (`~/.claude/projects/<dir>/<session>.jsonl`)
 * into helper events. Subagent (sidechain), meta and compaction records are skipped.
 */
export const parseClaudeLines = (
  lines: ReadonlyArray<TranscriptLine>,
  state: ParserState,
): Array<SessionEvent> => {
  const events: Array<SessionEvent> = [];
  for (const line of lines) {
    const record = parseJsonLine(line.text);
    if (record === null) continue;
    const sessionId = asString(record.sessionId);
    if (sessionId) state.meta.sessionId = sessionId;
    const cwd = asString(record.cwd);
    if (cwd) state.meta.cwd = cwd;
    const branch = asString(record.gitBranch);
    if (branch) state.meta.branch = branch;
    if (record.isSidechain === true || record.isMeta === true || record.isCompactSummary === true) {
      continue;
    }
    const message = asRecord(record.message);
    const model = asString(message?.model);
    if (model && model !== "<synthetic>") state.meta.model = model;
    const at = asString(record.timestamp) ?? new Date().toISOString();
    const uid = asString(record.uuid) ?? `line:${line.offset}`;

    if (record.type === "user" && message) {
      const text = textOf(message.content);
      if (text.trim().length > 0 && !isCommandEcho(text)) {
        events.push({ uid, at, type: "user", text });
      }
      if (!Array.isArray(message.content)) continue;
      for (const block of message.content) {
        const result = asRecord(block);
        if (result?.type !== "tool_result") continue;
        const toolUseId = asString(result.tool_use_id);
        const pending = toolUseId ? state.pendingTools[toolUseId] : undefined;
        if (!toolUseId || !pending) continue;
        delete state.pendingTools[toolUseId];
        const output = summarize(toolResultText(result.content));
        events.push({
          uid: toolUseId,
          at,
          type: "tool",
          tool: {
            ...pending,
            status: result.is_error === true ? "failed" : "completed",
            ...(output ? { output } : {}),
          },
        });
      }
      continue;
    }

    if (record.type === "assistant" && message && Array.isArray(message.content)) {
      const text = textOf(message.content);
      if (text.trim().length > 0) events.push({ uid, at, type: "assistant", text });
      for (const block of message.content) {
        const toolUse = asRecord(block);
        if (toolUse?.type !== "tool_use") continue;
        const id = asString(toolUse.id);
        const name = asString(toolUse.name);
        if (!id || !name) continue;
        const tool = classifyClaudeTool(name, toolUse.input);
        rememberTool(state, id, tool);
        events.push({ uid: id, at, type: "tool", tool: { ...tool, status: "running" } });
      }
    }
  }
  return events;
};
