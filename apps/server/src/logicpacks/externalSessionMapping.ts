import {
  MessageId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2TurnItem,
  type ThreadId,
  TurnItemId,
} from "@logicpacks/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

/**
 * The LogicPacks helper streams sessions of agents that run outside LogicPacks
 * (Claude Code, Codex in a terminal or IDE). It normalizes their transcripts to
 * these events; the server only maps them to turn items.
 */
/**
 * `agent` is any other harness that talks to LogicPacks through the `lp` CLI (Cursor, OpenCode,
 * Gemini CLI, Hermes...): it has no transcript to stream, only a thread to be reached in.
 */
export const ExternalSessionSource = Schema.Literals(["claude", "codex", "agent"]);
export type ExternalSessionSource = typeof ExternalSessionSource.Type;

export const ExternalToolKind = Schema.Literals([
  "command",
  "file_change",
  "search",
  "web",
  "other",
]);
export type ExternalToolKind = typeof ExternalToolKind.Type;

const MAX_UID = 240;
export const MAX_EVENTS_PER_BATCH = 500;
const MAX_MESSAGE_TEXT = 64 * 1024;
const MAX_TOOL_TEXT = 4 * 1024;
const MAX_FILES_PER_TOOL = 20;

export const ExternalToolCall = Schema.Struct({
  name: Schema.String,
  kind: ExternalToolKind,
  input: Schema.String,
  output: Schema.optionalKey(Schema.String),
  status: Schema.Literals(["running", "completed", "failed"]),
  files: Schema.optionalKey(Schema.Array(Schema.String)),
  exitCode: Schema.optionalKey(Schema.Number),
});
export type ExternalToolCall = typeof ExternalToolCall.Type;

export const ExternalSessionEvent = Schema.Struct({
  /** Stable per session. A repeated uid updates the earlier item (a tool call finishing). */
  uid: Schema.String,
  at: Schema.String,
  type: Schema.Literals(["user", "assistant", "tool"]),
  text: Schema.optionalKey(Schema.String),
  tool: Schema.optionalKey(ExternalToolCall),
});
export type ExternalSessionEvent = typeof ExternalSessionEvent.Type;

export const ExternalSessionLocation = Schema.Struct({
  cwd: Schema.String,
  gitRoot: Schema.optionalKey(Schema.NullOr(Schema.String)),
  gitRemote: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export type ExternalSessionLocation = typeof ExternalSessionLocation.Type;

export const ExternalSessionBatch = Schema.Struct({
  ...ExternalSessionLocation.fields,
  source: ExternalSessionSource,
  sessionId: Schema.String,
  branch: Schema.optionalKey(Schema.NullOr(Schema.String)),
  model: Schema.optionalKey(Schema.NullOr(Schema.String)),
  device: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /** The harness's display name ("Cursor"), for `agent` sessions. */
  harness: Schema.optionalKey(Schema.NullOr(Schema.String)),
  events: Schema.Array(ExternalSessionEvent),
});
export type ExternalSessionBatch = typeof ExternalSessionBatch.Type;

export const SOURCE_LABEL: Record<ExternalSessionSource, string> = {
  claude: "Claude Code",
  codex: "Codex",
  agent: "agent",
};

export const SOURCE_PROVIDER_INSTANCE: Record<ExternalSessionSource, string> = {
  claude: "claudeAgent",
  codex: "codex",
  // Continuing an outside harness's thread in the app hands it to Codex, like a v1 import.
  agent: "codex",
};

/** Session ids become part of thread ids; anything outside this alphabet is refused. */
export const isValidSessionId = (sessionId: string) => /^[A-Za-z0-9._-]{1,128}$/.test(sessionId);

export const externalThreadId = (source: ExternalSessionSource, sessionId: string) =>
  `external:${source}:${sessionId}` as ThreadId;

/** "Cursor" for an `agent` session that named its harness, else the source's own label. */
export const sessionLabel = (source: ExternalSessionSource, harness?: string | null) => {
  const named = harness?.trim().slice(0, 40);
  return source === "agent" ? named || "Agent" : SOURCE_LABEL[source];
};

export const isExternalThreadId = (threadId: string) => threadId.startsWith("external:");

/**
 * `git@github.com:Acme/App.git`, `https://github.com/acme/app` and
 * `ssh://git@github.com/acme/app` all give `github.com/acme/app`.
 */
export const remoteKey = (remote: string | null | undefined): string | null => {
  if (!remote) return null;
  let value = remote
    .trim()
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "");
  value = value.replace(/^[a-z+]+:\/\//i, "").replace(/^[^@/]+@/, "");
  value = value.replace(/^([^/:]+):(?!\d+\/)/, "$1/").replace(/^([^/:]+):\d+\//, "$1/");
  const parts = value.split("/").filter((part) => part.length > 0);
  if (parts.length < 3) return null;
  return parts.join("/").toLowerCase();
};

export const pathIsInside = (root: string, path: string) => {
  const trimmed = root.length > 1 && root.endsWith("/") ? root.slice(0, -1) : root;
  return path === trimmed || path.startsWith(`${trimmed}/`);
};

export interface ProjectCandidate {
  readonly id: string;
  readonly workspaceRoot: string;
  readonly remoteKeys: ReadonlyArray<string>;
}

/**
 * The project a session belongs to: the deepest project folder holding its
 * working directory on this machine, else the project with the same git remote.
 */
export const matchProject = (
  location: ExternalSessionLocation,
  candidates: ReadonlyArray<ProjectCandidate>,
): ProjectCandidate | null => {
  const paths = [location.cwd, location.gitRoot ?? null].filter(
    (path): path is string => typeof path === "string" && path.length > 0,
  );
  const byFolder = candidates
    .filter((candidate) => paths.some((path) => pathIsInside(candidate.workspaceRoot, path)))
    .sort((left, right) => right.workspaceRoot.length - left.workspaceRoot.length)[0];
  if (byFolder) return byFolder;
  const key = remoteKey(location.gitRemote);
  if (key === null) return null;
  return candidates.find((candidate) => candidate.remoteKeys.includes(key)) ?? null;
};

/** A path relative to the repository when it sits inside it, so teammates on other machines match. */
export const projectRelativePath = (
  file: string,
  roots: ReadonlyArray<string | null | undefined>,
) => {
  for (const root of roots) {
    if (root && pathIsInside(root, file) && file !== root) {
      return file.slice(root.replace(/\/+$/, "").length + 1);
    }
  }
  return file;
};

export const clip = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

export const parseEventTime = (value: string, fallback: DateTime.Utc): DateTime.Utc => {
  const parsed = DateTime.make(value);
  return parsed._tag === "Some" ? DateTime.toUtc(parsed.value) : fallback;
};

export const deriveTitle = (text: string) => {
  const line =
    text
      .split("\n")
      .map((part) => part.trim())
      .find((part) => part.length > 0) ?? "";
  return clip(line, 80) || null;
};

export const sanitizeUid = (uid: string) => clip(uid.trim(), MAX_UID);

export interface MappedItem {
  /** The item's key within the session: the event uid, plus the file for multi-file changes. */
  readonly key: string;
  readonly message: OrchestrationV2ConversationMessage | null;
  readonly turnItem: (ordinal: number) => OrchestrationV2TurnItem;
  readonly files: ReadonlyArray<string>;
}

const turnItemIdFor = (threadId: ThreadId, key: string) =>
  TurnItemId.make(`${threadId}:item:${key}`);

/** One helper event becomes the conversation message and turn items the thread view renders. */
export const mapExternalEvent = (input: {
  readonly threadId: ThreadId;
  readonly event: ExternalSessionEvent;
  readonly at: DateTime.Utc;
  readonly roots: ReadonlyArray<string | null | undefined>;
}): ReadonlyArray<MappedItem> => {
  const { threadId, event, at } = input;
  const uid = sanitizeUid(event.uid);
  const base = (key: string, ordinal: number) => ({
    id: turnItemIdFor(threadId, key),
    threadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    title: null,
    startedAt: at,
    updatedAt: at,
  });

  if (event.type === "user" || event.type === "assistant") {
    const text = clip(event.text ?? "", MAX_MESSAGE_TEXT);
    if (text.trim().length === 0) return [];
    const messageId = MessageId.make(`${threadId}:msg:${uid}`);
    const message: OrchestrationV2ConversationMessage = {
      createdBy: event.type === "user" ? "user" : "agent",
      creationSource: "server",
      id: messageId,
      threadId,
      runId: null,
      nodeId: null,
      role: event.type,
      text,
      attachments: [],
      streaming: false,
      createdAt: at,
      updatedAt: at,
    };
    return [
      {
        key: uid,
        message,
        files: [],
        turnItem: (ordinal) =>
          event.type === "user"
            ? {
                ...base(uid, ordinal),
                status: "completed",
                completedAt: at,
                createdBy: "user",
                creationSource: "server",
                type: "user_message",
                messageId,
                inputIntent: "turn_start",
                text,
                attachments: [],
              }
            : {
                ...base(uid, ordinal),
                status: "completed",
                completedAt: at,
                type: "assistant_message",
                messageId,
                text,
                streaming: false,
              },
      },
    ];
  }

  const tool = event.tool;
  if (tool === undefined) return [];
  const status = tool.status;
  const done = status !== "running";
  const common = (key: string, ordinal: number) => ({
    ...base(key, ordinal),
    status,
    completedAt: done ? at : null,
  });
  const files = (tool.files ?? [])
    .filter((file) => file.trim().length > 0)
    .slice(0, MAX_FILES_PER_TOOL)
    .map((file) => projectRelativePath(file, input.roots));
  const toolInput = clip(tool.input, MAX_TOOL_TEXT);
  const output = tool.output === undefined ? undefined : clip(tool.output, MAX_TOOL_TEXT);

  switch (tool.kind) {
    case "command":
      return [
        {
          key: uid,
          message: null,
          files,
          turnItem: (ordinal) => ({
            ...common(uid, ordinal),
            type: "command_execution",
            input: toolInput || tool.name,
            ...(output === undefined ? {} : { output }),
            ...(tool.exitCode === undefined ? {} : { exitCode: Math.trunc(tool.exitCode) }),
            ...(status === "failed" ? { outputIndicatesFailure: true } : {}),
          }),
        },
      ];
    case "file_change": {
      const changed = files.length > 0 ? files : [tool.name];
      return changed.map((fileName, index) => {
        const key = index === 0 ? uid : `${uid}#${index}`;
        return {
          key,
          message: null,
          files: index === 0 ? files : [],
          turnItem: (ordinal: number) => ({
            ...common(key, ordinal),
            type: "file_change" as const,
            fileName,
          }),
        };
      });
    }
    case "search":
      return [
        {
          key: uid,
          message: null,
          files,
          turnItem: (ordinal) => ({
            ...common(uid, ordinal),
            type: "file_search",
            ...(toolInput.length > 0 ? { pattern: toolInput } : {}),
          }),
        },
      ];
    case "web":
      return [
        {
          key: uid,
          message: null,
          files,
          turnItem: (ordinal) => ({
            ...common(uid, ordinal),
            type: "web_search",
            ...(toolInput.length > 0 ? { patterns: [toolInput] } : {}),
          }),
        },
      ];
    case "other":
      return [
        {
          key: uid,
          message: null,
          files,
          turnItem: (ordinal) => ({
            ...common(uid, ordinal),
            type: "dynamic_tool",
            toolName: tool.name.trim() || null,
            input: toolInput,
            ...(output === undefined ? {} : { output }),
          }),
        },
      ];
  }
};

export interface ActivityEntry {
  readonly who: string;
  readonly what: string;
  readonly threadId: string;
  readonly lastActiveAt: string;
  readonly files: ReadonlyArray<string>;
}

const minutesAgo = (now: DateTime.Utc, iso: string) => {
  const at = DateTime.make(iso);
  if (at._tag === "None") return "recently";
  const minutes = Math.max(
    0,
    Math.round((DateTime.toEpochMillis(now) - DateTime.toEpochMillis(at.value)) / 60_000),
  );
  return minutes === 0 ? "just now" : `${minutes}m ago`;
};

/**
 * What the helper hands an external agent at session start and on each prompt,
 * so the no-overlap rules apply to agents outside LogicPacks too.
 */
export const projectContextText = (input: {
  readonly projectTitle: string;
  readonly synced: boolean;
  readonly members: ReadonlyArray<string>;
  readonly others: ReadonlyArray<ActivityEntry>;
  readonly ownFiles: ReadonlyArray<string>;
  /** People and host agents in the project's files right now, one readable line each. */
  readonly live?: ReadonlyArray<string> | undefined;
  readonly now: DateTime.Utc;
}): { readonly text: string; readonly conflicts: ReadonlyArray<string> } => {
  const lines = [
    `LogicPacks: this session streams into the project "${input.projectTitle}". Teammates see your prompts, replies and tool calls live.`,
  ];
  if (input.members.length > 0) lines.push(`Shared with: ${input.members.join(", ")}.`);
  if (!input.synced) {
    lines.push(
      "This project is not synced to the cloud host yet, so teammates cannot work on its files while this machine is off. Remind the user to press Sync in LogicPacks.",
    );
  }
  const ownFiles = new Set(input.ownFiles);
  const conflicts = new Set<string>();
  if (input.others.length === 0) {
    lines.push("No one else is working in this project right now.");
  } else {
    lines.push("Other work in this project right now:");
    for (const entry of input.others.slice(0, 12)) {
      const touched = entry.files.slice(0, 6);
      for (const file of entry.files) if (ownFiles.has(file)) conflicts.add(file);
      lines.push(
        `- ${entry.who}: ${entry.what} (${minutesAgo(input.now, entry.lastActiveAt)})${
          touched.length > 0 ? `, touching ${touched.join(", ")}` : ""
        }`,
      );
    }
    lines.push(
      'Before you start, compare your task with this list. If it overlaps a file or area someone is already on, tell the user who is on it (for example "Ali\'s agent is already working on the checkout page") and coordinate instead of duplicating the work.',
    );
  }
  const live = input.live ?? [];
  if (live.length > 0) {
    lines.push("In the project's files right now:");
    for (const line of live.slice(0, 12)) lines.push(`- ${line}`);
  }
  if (conflicts.size > 0) {
    lines.push(
      `Possible conflict: you and a teammate both touched ${Array.from(conflicts).slice(0, 8).join(", ")} recently. Fetch upstream before editing them again and tell the user.`,
    );
  }
  return { text: lines.join("\n"), conflicts: Array.from(conflicts) };
};
