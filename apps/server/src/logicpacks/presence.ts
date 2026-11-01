import {
  PRESENCE_COLOR_COUNT,
  type PresenceActor,
  type PresenceEntry,
  type PresenceLocation,
  type PresencePosition,
  type PresenceSource,
  type ProjectId,
  type ThreadId,
} from "@logicpacks/contracts";
import * as DateTime from "effect/DateTime";

/** Stable palette slot for an actor, so a person keeps their colour across tabs and reloads. */
export const presenceColorIndex = (actorId: string): number => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < actorId.length; index++) {
    hash ^= actorId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % PRESENCE_COLOR_COUNT;
};

/** A project-relative path with forward slashes, or null when it escapes the project. */
export const normalizePresencePath = (path: string): string | null => {
  const segments = path.replaceAll("\\", "/").split("/");
  const kept: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") return null;
    kept.push(segment);
  }
  if (path.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(path)) return null;
  return kept.length === 0 ? null : kept.join("/");
};

/** An agent tool's file path relative to the first root that contains it. */
export const relativeToRoots = (filePath: string, roots: ReadonlyArray<string>): string | null => {
  const normalized = filePath.replaceAll("\\", "/");
  if (!normalized.startsWith("/") && !/^[a-zA-Z]:\//.test(normalized)) {
    return normalizePresencePath(normalized);
  }
  for (const root of roots) {
    const base = root.replaceAll("\\", "/").replace(/\/+$/, "");
    if (normalized.startsWith(`${base}/`)) {
      return normalizePresencePath(normalized.slice(base.length + 1));
    }
  }
  return null;
};

/** Where `needle` starts in `contents`, as a one-based line and zero-based column. */
export const positionOfText = (contents: string, needle: string): PresencePosition | null => {
  if (needle.length === 0) return null;
  const offset = contents.indexOf(needle);
  if (offset < 0) return null;
  let line = 1;
  let lineStart = 0;
  for (let index = 0; index < offset; index++) {
    if (contents.charCodeAt(index) === 10) {
      line += 1;
      lineStart = index + 1;
    }
  }
  return { line, column: offset - lineStart };
};

const samePosition = (a?: PresencePosition, b?: PresencePosition) =>
  a?.line === b?.line && a?.column === b?.column;

export const sameLocation = (a: PresenceLocation, b: PresenceLocation): boolean =>
  a.view === b.view &&
  a.activity === b.activity &&
  a.path === b.path &&
  samePosition(a.cursor, b.cursor) &&
  samePosition(a.anchor, b.anchor) &&
  a.appItem?.recipeId === b.appItem?.recipeId &&
  a.appItem?.itemId === b.appItem?.itemId &&
  a.appItem?.label === b.appItem?.label &&
  a.pointer?.x === b.pointer?.x &&
  a.pointer?.y === b.pointer?.y;

/** One cursor per thread: the host agent working in it. */
export const agentPresenceKey = (threadId: string) => `agent:thread:${threadId}`;

/** A tool call an agent made that places it in a file. */
export interface AgentToolTouch {
  readonly filePath: string;
  readonly activity: "reading" | "editing";
  /** Text the tool wrote, used to find where in the file the agent is. */
  readonly writtenText?: string | undefined;
}

const stringField = (input: unknown, keys: ReadonlyArray<string>): string | null => {
  if (input === null || typeof input !== "object") return null;
  const record = input as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
};

const READ_TOOL_NAMES = new Set(["read", "view", "readfile", "notebookread"]);

/**
 * Turn items carry file paths in two shapes: `file_change` (Edit, Write,
 * MultiEdit, apply_patch) and `dynamic_tool` reads such as Claude's Read.
 */
export const agentTouchFromTurnItem = (item: {
  readonly type: string;
  readonly fileName?: string | undefined;
  readonly newStr?: string | undefined;
  readonly changes?: ReadonlyArray<{ readonly path: string }> | undefined;
  readonly toolName?: string | null | undefined;
  readonly input?: unknown;
}): AgentToolTouch | null => {
  if (item.type === "file_change") {
    const filePath = item.changes?.[0]?.path ?? item.fileName;
    if (filePath === undefined) return null;
    return { filePath, activity: "editing", writtenText: item.newStr };
  }
  if (item.type === "dynamic_tool" && item.toolName) {
    const name = item.toolName.toLowerCase().replaceAll(/[\s_-]/g, "");
    if (!READ_TOOL_NAMES.has(name)) return null;
    const filePath = stringField(item.input, ["file_path", "filePath", "path", "notebook_path"]);
    return filePath === null ? null : { filePath, activity: "reading" };
  }
  return null;
};

/** An agent's tool call on an item inside an app recipe, e.g. a Blender object. */
export interface AgentAppTouch {
  readonly recipeId: string;
  readonly itemId: string;
  readonly label?: string | undefined;
  readonly activity: "reading" | "editing";
}

/**
 * Blender MCP tools (`logicpacks recipe mcp blender`) as the agent calls them; providers prefix
 * MCP tool names (`mcp__blender__blender_modify_object`, `blender/blender_modify_object`).
 */
const BLENDER_ITEM_TOOL = /(?:^|[_/.:-])blender_(add|modify|delete)_object$/;

/** Which app item an agent's tool call is on, for presence in the app's outline. */
export const agentAppTouchFromTurnItem = (item: {
  readonly type: string;
  readonly toolName?: string | null | undefined;
  readonly input?: unknown;
}): AgentAppTouch | null => {
  if (item.type !== "dynamic_tool" || !item.toolName) return null;
  const match = BLENDER_ITEM_TOOL.exec(item.toolName.toLowerCase());
  if (match === null) return null;
  const id = stringField(item.input, ["id", "lp_id"]);
  const name = stringField(item.input, ["name"]);
  // An added object has no id until Blender answers; its requested name places it.
  const renamed =
    item.input !== null && typeof item.input === "object"
      ? stringField((item.input as { props?: unknown }).props, ["name"])
      : null;
  const itemId = id ?? name ?? renamed;
  if (itemId === null) return null;
  const label = name ?? renamed ?? undefined;
  return {
    recipeId: "blender",
    itemId,
    ...(label === undefined ? {} : { label }),
    activity: "editing",
  };
};

export interface PresenceRecord {
  readonly entry: PresenceEntry;
  /** The connection that reported it; closing the socket drops its entries. */
  readonly connectionId: string | null;
  readonly expiresAtMs: number;
}

export type PresenceChange =
  | { readonly type: "upsert"; readonly entry: PresenceEntry }
  | { readonly type: "remove"; readonly key: string };

export interface PresenceWrite {
  readonly key: string;
  readonly clientId: string;
  readonly connectionId: string | null;
  readonly projectId: ProjectId;
  readonly threadId?: ThreadId | undefined;
  readonly actor: PresenceActor;
  readonly source: PresenceSource;
  readonly location: PresenceLocation | null;
  readonly nowMs: number;
  readonly ttlMs: number;
}

/**
 * The one state transition every report goes through. Returns the change to
 * broadcast, or null when nothing a viewer could see changed (a heartbeat).
 */
export const applyPresenceWrite = (
  records: Map<string, PresenceRecord>,
  write: PresenceWrite,
): PresenceChange | null => {
  const existing = records.get(write.key);
  if (write.location === null) {
    if (existing === undefined) return null;
    records.delete(write.key);
    return { type: "remove", key: write.key };
  }
  const now = DateTime.formatIso(DateTime.makeUnsafe(write.nowMs));
  const unchanged =
    existing !== undefined &&
    existing.entry.projectId === write.projectId &&
    existing.entry.threadId === write.threadId &&
    existing.entry.actor.name === write.actor.name &&
    sameLocation(existing.entry.location, write.location);
  const movedFile =
    existing === undefined ||
    existing.entry.location.path !== write.location.path ||
    existing.entry.projectId !== write.projectId;
  const entry: PresenceEntry = unchanged
    ? existing.entry
    : {
        key: write.key,
        clientId: write.clientId,
        projectId: write.projectId,
        ...(write.threadId === undefined ? {} : { threadId: write.threadId }),
        actor: write.actor,
        source: write.source,
        location: write.location,
        since: movedFile ? now : existing.entry.since,
        updatedAt: now,
      };
  records.set(write.key, {
    entry,
    connectionId: write.connectionId,
    expiresAtMs: write.nowMs + write.ttlMs,
  });
  return unchanged ? null : { type: "upsert", entry };
};

export const expirePresence = (
  records: Map<string, PresenceRecord>,
  nowMs: number,
): ReadonlyArray<PresenceChange> => {
  const removed: PresenceChange[] = [];
  for (const [key, record] of records) {
    if (record.expiresAtMs > nowMs) continue;
    records.delete(key);
    removed.push({ type: "remove", key });
  }
  return removed;
};

export const dropPresenceWhere = (
  records: Map<string, PresenceRecord>,
  predicate: (record: PresenceRecord) => boolean,
): ReadonlyArray<PresenceChange> => {
  const removed: PresenceChange[] = [];
  for (const [key, record] of records) {
    if (!predicate(record)) continue;
    records.delete(key);
    removed.push({ type: "remove", key });
  }
  return removed;
};

const ACTIVITY_VERB: Record<PresenceLocation["activity"], string> = {
  viewing: "viewing",
  reading: "reading",
  editing: "editing",
  reviewing: "reviewing",
};

/** "Ali's agent editing src/checkout.tsx:42, 2m": the line agents and hover cards read. */
export const describePresence = (entry: PresenceEntry, nowMs: number): string => {
  const where =
    entry.location.appItem?.label ??
    entry.location.appItem?.itemId ??
    entry.location.path ??
    `the ${entry.location.view}`;
  const line = entry.location.cursor ? `:${entry.location.cursor.line}` : "";
  const minutes = Math.max(0, Math.floor((nowMs - Date.parse(entry.since)) / 60_000));
  const age = minutes < 1 ? "just now" : `${minutes}m`;
  return `${entry.actor.name} ${ACTIVITY_VERB[entry.location.activity]} ${where}${line}, ${age}`;
};
