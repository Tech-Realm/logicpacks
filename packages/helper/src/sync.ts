import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { parseClaudeLines } from "./claude.ts";
import { callHost, gitInfo, OfflineError, RejectedError, sendBatch } from "./client.ts";
import { parseCodexLines } from "./codex.ts";
import type { SessionBatch, SessionEvent, SessionSource, TranscriptLine } from "./events.ts";
import { scrubEvent } from "./privacy.ts";
import {
  claudeHome,
  codexHome,
  enqueue,
  type HelperConfig,
  isUnlinked,
  loadTranscriptState,
  queuedFiles,
  readQueued,
  saveTranscriptState,
  withTranscriptLock,
} from "./store.ts";

const BATCH_SIZE = 200;
const MAX_READ_BYTES = 8 * 1024 * 1024;
/** How long a session with no matching project waits before the host is asked again. */
export const UNMATCHED_RETRY_MS = 2 * 60_000;

/** Complete lines from `offset`; a final line without its newline is left for the next pass. */
export const readNewLines = (file: string, offset: number) => {
  const size = NodeFS.statSync(file, { throwIfNoEntry: false })?.size ?? 0;
  const start = size < offset ? 0 : offset;
  const length = Math.min(size - start, MAX_READ_BYTES);
  if (length <= 0) return { lines: [] as Array<TranscriptLine>, nextOffset: start };
  const buffer = Buffer.alloc(length);
  const handle = NodeFS.openSync(file, "r");
  try {
    NodeFS.readSync(handle, buffer, 0, length, start);
  } finally {
    NodeFS.closeSync(handle);
  }
  const lines: Array<TranscriptLine> = [];
  let lineStart = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 0x0a) continue;
    const text = buffer.subarray(lineStart, index).toString("utf8");
    if (text.trim().length > 0) lines.push({ offset: start + lineStart, text });
    lineStart = index + 1;
  }
  return { lines, nextOffset: start + lineStart };
};

export type SyncOutcome =
  | { readonly kind: "sent"; readonly events: number; readonly threadId: string }
  | { readonly kind: "queued"; readonly events: number }
  | { readonly kind: "idle" }
  | { readonly kind: "private"; readonly reason: "paused" | "unlinked" }
  | { readonly kind: "unmatched"; readonly message: string }
  | { readonly kind: "stopped"; readonly reason: string }
  | { readonly kind: "signed-out"; readonly message: string };

/** Sends what the host missed while it was unreachable, oldest first. Stops at the first failure. */
export const flushQueue = async (config: HelperConfig) => {
  for (const file of queuedFiles()) {
    const batch = readQueued(file);
    if (batch === null) {
      NodeFS.rmSync(file, { force: true });
      continue;
    }
    try {
      await sendBatch(config, batch);
    } catch (error) {
      if (error instanceof OfflineError) return false;
      if (error instanceof RejectedError && error.status === 401) return false;
    }
    NodeFS.rmSync(file, { force: true });
  }
  return true;
};

const parse = (
  source: SessionSource,
  lines: ReadonlyArray<TranscriptLine>,
  parser: Parameters<typeof parseClaudeLines>[1],
) => (source === "claude" ? parseClaudeLines(lines, parser) : parseCodexLines(lines, parser));

/**
 * Streams what was added to one transcript since the last pass. Sessions in no
 * LogicPacks project stay private and are retried later from the same place, so a
 * folder added to LogicPacks afterwards still gets its whole session.
 */
export const syncTranscript = async (
  file: string,
  source: SessionSource,
  config: HelperConfig,
  now = Date.now(),
): Promise<SyncOutcome> => {
  let outcome: SyncOutcome = { kind: "idle" };
  await withTranscriptLock(file, async () => {
    const state = loadTranscriptState(file, source);
    if (state.link?.status === "stopped") {
      outcome = { kind: "stopped", reason: state.link.reason };
      return;
    }
    if (state.link?.status === "unmatched" && now - state.link.checkedAt < UNMATCHED_RETRY_MS) {
      outcome = { kind: "unmatched", message: "No LogicPacks project matches this folder yet." };
      return;
    }
    const { lines, nextOffset } = readNewLines(file, state.offset);
    if (lines.length === 0 && nextOffset === state.offset) return;
    const parser = structuredClone(state.parser);
    const events = parse(source, lines, parser);
    const commit = () => {
      state.offset = nextOffset;
      state.parser = parser;
      saveTranscriptState(state);
    };
    const cwd = parser.meta.cwd;
    const sessionId =
      parser.meta.sessionId ?? (source === "claude" ? NodePath.basename(file, ".jsonl") : null);
    if (events.length === 0 || cwd === null || sessionId === null) {
      commit();
      return;
    }
    const git = gitInfo(cwd);
    if (config.paused || isUnlinked(config, git.root ?? cwd)) {
      commit();
      outcome = { kind: "private", reason: config.paused ? "paused" : "unlinked" };
      return;
    }
    const batchOf = (chunk: ReadonlyArray<SessionEvent>): SessionBatch => ({
      source,
      sessionId,
      cwd,
      gitRoot: git.root,
      gitRemote: git.remote,
      branch: parser.meta.branch ?? git.branch,
      model: parser.meta.model,
      device: config.device,
      // Secrets redacted, MCP calls reduced to their names, secret files not shared.
      events: chunk.map((event) =>
        scrubEvent(event, {
          mcpDetails: (config.mcpDetails ?? []).includes(git.root ?? cwd),
        }),
      ),
    });
    const chunks: Array<ReadonlyArray<SessionEvent>> = [];
    for (let index = 0; index < events.length; index += BATCH_SIZE) {
      chunks.push(events.slice(index, index + BATCH_SIZE));
    }
    const online = await flushQueue(config);
    let sent = 0;
    let threadId = "";
    for (const [index, chunk] of chunks.entries()) {
      if (!online) {
        enqueue(batchOf(chunk));
        continue;
      }
      try {
        const response = await sendBatch(config, batchOf(chunk));
        if (response.linked) {
          state.link = {
            status: "linked",
            projectId: response.projectId,
            threadId: response.threadId,
          };
          threadId = response.threadId;
          sent += chunk.length;
          continue;
        }
        if (response.reason === "no_project") {
          state.link = { status: "unmatched", checkedAt: now };
          saveTranscriptState(state);
          outcome = { kind: "unmatched", message: response.message };
          return;
        }
        state.link = { status: "stopped", reason: response.message };
        commit();
        outcome = { kind: "stopped", reason: response.message };
        return;
      } catch (error) {
        if (error instanceof RejectedError && error.status === 401) {
          outcome = { kind: "signed-out", message: error.message };
          return;
        }
        if (error instanceof OfflineError) {
          for (const rest of chunks.slice(index)) enqueue(batchOf(rest));
          commit();
          outcome = { kind: "queued", events: chunks.slice(index).flat().length };
          return;
        }
        // The host refused this batch's contents; skip it rather than retry it forever.
      }
    }
    commit();
    outcome = { kind: "sent", events: sent, threadId };
  });
  return outcome;
};

export interface DiscoveredTranscript {
  readonly file: string;
  readonly source: SessionSource;
  readonly size: number;
}

const listFiles = (dir: string, accept: (name: string) => boolean) => {
  try {
    return NodeFS.readdirSync(dir)
      .filter(accept)
      .map((name) => NodePath.join(dir, name));
  } catch {
    return [];
  }
};

/** Top-level session transcripts written since `sinceMs`; subagent transcripts live in subfolders and are skipped. */
export const discoverTranscripts = (sinceMs: number): Array<DiscoveredTranscript> => {
  const found: Array<DiscoveredTranscript> = [];
  const consider = (file: string, source: SessionSource) => {
    const stat = NodeFS.statSync(file, { throwIfNoEntry: false });
    if (stat?.isFile() && stat.mtimeMs >= sinceMs) found.push({ file, source, size: stat.size });
  };
  for (const dir of listFiles(NodePath.join(claudeHome(), "projects"), () => true)) {
    for (const file of listFiles(dir, (name) => name.endsWith(".jsonl"))) consider(file, "claude");
  }
  // Codex files by day: YYYY/MM/DD. Only days on or after the cutoff are opened.
  const sessions = NodePath.join(codexHome(), "sessions");
  const cutoffDay = new Date(sinceMs - 24 * 60 * 60_000).toISOString().slice(0, 10);
  for (const year of listFiles(sessions, (name) => /^\d{4}$/.test(name))) {
    for (const month of listFiles(year, (name) => /^\d{2}$/.test(name))) {
      for (const day of listFiles(month, (name) => /^\d{2}$/.test(name))) {
        const date = `${NodePath.basename(year)}-${NodePath.basename(month)}-${NodePath.basename(day)}`;
        if (date < cutoffDay) continue;
        for (const file of listFiles(
          day,
          (name) => name.startsWith("rollout-") && name.endsWith(".jsonl"),
        )) {
          consider(file, "codex");
        }
      }
    }
  }
  return found;
};

export interface ProjectContext {
  readonly linked: boolean;
  readonly message?: string;
  readonly projectTitle?: string;
  readonly synced?: boolean;
  readonly text?: string;
}

/** What the host says about this folder's project, for the agent and for `lp status`. */
export const fetchContext = (
  config: HelperConfig,
  input: { readonly cwd: string; readonly source?: SessionSource; readonly sessionId?: string },
  timeoutMs = 2000,
) => {
  const git = gitInfo(input.cwd);
  return callHost<ProjectContext>(config, "/api/lp/helper/context", {
    body: { ...input, gitRoot: git.root, gitRemote: git.remote },
    timeoutMs,
  });
};
