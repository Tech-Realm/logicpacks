import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  emptyParserState,
  type ParserState,
  type SessionBatch,
  type SessionSource,
} from "./events.ts";

/** Everything the helper keeps lives here; LP_HELPER_HOME moves it (tests, several accounts). */
export const helperHome = () =>
  process.env.LP_HELPER_HOME || NodePath.join(NodeOS.homedir(), ".logicpacks", "helper");

export const claudeHome = () =>
  process.env.CLAUDE_CONFIG_DIR || NodePath.join(NodeOS.homedir(), ".claude");
export const codexHome = () => process.env.CODEX_HOME || NodePath.join(NodeOS.homedir(), ".codex");

export interface HelperConfig {
  server: string | null;
  token: string | null;
  who: string | null;
  paused: boolean;
  /** Folders whose sessions stay private even when they match a project. */
  unlinked: Array<string>;
  /** Folders whose MCP tool calls stream with their inputs and results (default: names only). */
  mcpDetails?: Array<string>;
  /** Transcripts last written before this moment are history and are never streamed. */
  since: string;
  device: string | null;
  /** A device login started with `lp login --start`, finished by `lp login --finish`. */
  pending?: {
    readonly server: string;
    readonly code: string;
    readonly pollToken: string;
    readonly url: string;
  } | null;
  /** The harness `lp setup --agent` last set up, used to label this computer's agent threads. */
  harness?: string | null;
}

const defaultDevice = () => NodeOS.hostname().replace(/\.local$/, "") || null;

const readJson = <A>(file: string): A | null => {
  try {
    return JSON.parse(NodeFS.readFileSync(file, "utf8")) as A;
  } catch {
    return null;
  }
};

/** Write-then-rename, so a hook killed mid-write never leaves half a file behind. */
export const writeJson = (file: string, value: unknown, mode = 0o600) => {
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${NodeCrypto.randomBytes(4).toString("hex")}.tmp`;
  NodeFS.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode });
  NodeFS.renameSync(temp, file);
};

const configFile = () => NodePath.join(helperHome(), "config.json");

export const loadConfig = (): HelperConfig => {
  const stored = readJson<Partial<HelperConfig>>(configFile()) ?? {};
  return {
    server: stored.server ?? null,
    token: stored.token ?? null,
    who: stored.who ?? null,
    paused: stored.paused ?? false,
    unlinked: stored.unlinked ?? [],
    since: stored.since ?? new Date().toISOString(),
    device: stored.device ?? defaultDevice(),
    pending: stored.pending ?? null,
    harness: stored.harness ?? null,
  };
};

export const saveConfig = (config: HelperConfig) => writeJson(configFile(), config);

export const isUnlinked = (config: HelperConfig, folder: string | null) =>
  folder !== null &&
  config.unlinked.some(
    (root) => folder === root || folder.startsWith(`${root.replace(/\/+$/, "")}/`),
  );

export type LinkStatus =
  | { readonly status: "linked"; readonly projectId: string; readonly threadId: string }
  | { readonly status: "unmatched"; readonly checkedAt: number }
  | { readonly status: "stopped"; readonly reason: string };

export interface TranscriptState {
  source: SessionSource;
  file: string;
  offset: number;
  parser: ParserState;
  link: LinkStatus | null;
}

const fileKey = (file: string) =>
  NodeCrypto.createHash("sha1").update(file).digest("hex").slice(0, 20);

const stateFile = (file: string) => NodePath.join(helperHome(), "state", `${fileKey(file)}.json`);

export const loadTranscriptState = (file: string, source: SessionSource): TranscriptState =>
  readJson<TranscriptState>(stateFile(file)) ?? {
    source,
    file,
    offset: 0,
    parser: emptyParserState(),
    link: null,
  };

export const saveTranscriptState = (state: TranscriptState) =>
  writeJson(stateFile(state.file), state);

const LOCK_STALE_MS = 60_000;

/**
 * One sync per transcript at a time. A caller that finds the lock taken leaves a
 * rerun mark instead, and the holder makes one more pass before it lets go.
 */
export const withTranscriptLock = async (file: string, run: () => Promise<void>) => {
  const dir = NodePath.join(helperHome(), "locks");
  NodeFS.mkdirSync(dir, { recursive: true });
  const lock = NodePath.join(dir, `${fileKey(file)}.lock`);
  const rerun = `${lock}.rerun`;
  try {
    NodeFS.writeFileSync(lock, String(process.pid), { flag: "wx" });
  } catch {
    const age = Date.now() - (NodeFS.statSync(lock, { throwIfNoEntry: false })?.mtimeMs ?? 0);
    if (age < LOCK_STALE_MS) {
      NodeFS.writeFileSync(rerun, "");
      return;
    }
    NodeFS.writeFileSync(lock, String(process.pid));
  }
  try {
    for (let pass = 0; pass < 5; pass += 1) {
      NodeFS.rmSync(rerun, { force: true });
      await run();
      if (!NodeFS.existsSync(rerun)) break;
    }
  } finally {
    NodeFS.rmSync(lock, { force: true });
  }
};

const queueDir = () => NodePath.join(helperHome(), "queue");
const MAX_QUEUE_FILES = 5000;

/** Batches the host could not take yet, sent in order once it answers again. */
export const enqueue = (batch: SessionBatch) => {
  NodeFS.mkdirSync(queueDir(), { recursive: true });
  const name = `${String(Date.now()).padStart(15, "0")}-${process.pid}-${NodeCrypto.randomBytes(3).toString("hex")}.json`;
  writeJson(NodePath.join(queueDir(), name), batch);
  const files = queuedFiles();
  for (const stale of files.slice(0, Math.max(0, files.length - MAX_QUEUE_FILES))) {
    NodeFS.rmSync(stale, { force: true });
  }
};

export const queuedFiles = () => {
  try {
    return NodeFS.readdirSync(queueDir())
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) => NodePath.join(queueDir(), name));
  } catch {
    return [];
  }
};

export const readQueued = (file: string) => readJson<SessionBatch>(file);
