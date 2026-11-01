/** What the helper sends the LogicPacks host; mirrors apps/server/src/logicpacks/externalSessionMapping.ts. */
export type SessionSource = "claude" | "codex";

export type ToolKind = "command" | "file_change" | "search" | "web" | "other";

export interface ToolCall {
  readonly name: string;
  readonly kind: ToolKind;
  readonly input: string;
  readonly output?: string;
  readonly status: "running" | "completed" | "failed";
  readonly files?: ReadonlyArray<string>;
  readonly exitCode?: number;
}

export interface SessionEvent {
  readonly uid: string;
  readonly at: string;
  readonly type: "user" | "assistant" | "tool";
  readonly text?: string;
  readonly tool?: ToolCall;
}

export interface SessionMeta {
  sessionId: string | null;
  cwd: string | null;
  model: string | null;
  branch: string | null;
}

export interface SessionBatch {
  readonly source: SessionSource;
  readonly sessionId: string;
  readonly cwd: string;
  readonly gitRoot: string | null;
  readonly gitRemote: string | null;
  readonly branch: string | null;
  readonly model: string | null;
  readonly device: string | null;
  readonly events: ReadonlyArray<SessionEvent>;
}

/** A pending tool call, remembered until its result arrives in a later chunk of the transcript. */
export interface PendingTool {
  readonly name: string;
  readonly kind: ToolKind;
  readonly input: string;
  readonly files: ReadonlyArray<string>;
}

export interface ParserState {
  meta: SessionMeta;
  pendingTools: Record<string, PendingTool>;
  /** Codex: the file uses item_completed records, so legacy event_msg copies are skipped. */
  modernCodex: boolean;
}

export const emptyParserState = (): ParserState => ({
  meta: { sessionId: null, cwd: null, model: null, branch: null },
  pendingTools: {},
  modernCodex: false,
});

export interface TranscriptLine {
  /** Byte offset of the line in its file; a stable id for records that carry none. */
  readonly offset: number;
  readonly text: string;
}

const MAX_PENDING_TOOLS = 200;

export const rememberTool = (state: ParserState, id: string, tool: PendingTool) => {
  state.pendingTools[id] = tool;
  const ids = Object.keys(state.pendingTools);
  for (const stale of ids.slice(0, Math.max(0, ids.length - MAX_PENDING_TOOLS))) {
    delete state.pendingTools[stale];
  }
};

/** Keeps the start and end of long output, which is where commands report what happened. */
export const summarize = (text: string, max = 1500): string => {
  const trimmed = text.replace(/\r\n/g, "\n").trim();
  if (trimmed.length <= max) return trimmed;
  const lines = trimmed.split("\n").length;
  const head = trimmed.slice(0, Math.floor(max * 0.65));
  const tail = trimmed.slice(-Math.floor(max * 0.3));
  return `${head}\n… (${lines} lines, trimmed) …\n${tail}`;
};

export const oneLine = (text: string, max = 300) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
};

export const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

export const asString = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

export const parseJsonLine = (text: string): Record<string, unknown> | null => {
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return null;
  }
};
