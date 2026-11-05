import {
  AuthDiagnosticsReadScope,
  AuthFilesystemReadScope,
  AuthFilesystemWriteScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthPreviewOperateScope,
  AuthSourceControlWriteScope,
  AuthTerminalOperateScope,
  AuthTerminalReadScope,
  type AuthEnvironmentScope,
  type OrchestrationV2ShellStreamItem,
} from "@logicpacks/contracts";
import { isWithin } from "./memberJail.ts";

/**
 * A LogicPacks member's session subject. Any other subject (desktop owner, paired
 * device, dev token, MCP client) is the host operator and sees everything.
 */
export const MEMBER_SUBJECT_PREFIX = "lp-user:";

/**
 * Helper tokens minted by `lp login` on the machine that runs the app (proved by the key file in
 * the app's data folder). The token's holder is the app's owner, so owner-level `/api/lp/*`
 * routes accept it; it still carries read-only scopes for the RPC and websocket surface.
 */
export const HELPER_LOCAL_OPERATOR_SUBJECT = "lp-helper:local-operator";

export const memberSubject = (userId: string) => `${MEMBER_SUBJECT_PREFIX}${userId}`;

export const memberUserIdFromSubject = (subject: string): string | null =>
  subject.startsWith(MEMBER_SUBJECT_PREFIX) && subject.length > MEMBER_SUBJECT_PREFIX.length
    ? subject.slice(MEMBER_SUBJECT_PREFIX.length)
    : null;

/**
 * What a member may do on a shared host: work in the projects they can see.
 * Host settings, provider instances, access management and relay links stay
 * with the operator.
 */
export const MEMBER_SCOPES: ReadonlyArray<AuthEnvironmentScope> = [
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  AuthTerminalReadScope,
  AuthTerminalOperateScope,
  AuthFilesystemReadScope,
  AuthFilesystemWriteScope,
  AuthSourceControlWriteScope,
  AuthPreviewOperateScope,
  AuthDiagnosticsReadScope,
];

export type ProjectRole = "owner" | "member";

export interface ProjectAccessRow {
  readonly projectId: string;
  readonly userId: string;
  readonly role: ProjectRole;
}

/** Quick-login names become `<name>@logicpacks.internal` accounts. */
const QUICK_LOGIN_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const QUICK_LOGIN_EMAIL_DOMAIN = "logicpacks.internal";

export const normalizeQuickLoginName = (raw: string): string | null => {
  const name = raw.trim().toLowerCase();
  return QUICK_LOGIN_NAME.test(name) ? name : null;
};

export const quickLoginEmail = (name: string) => `${name}@${QUICK_LOGIN_EMAIL_DOMAIN}`;

export const normalizeEmail = (raw: string): string | null => {
  const email = raw.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+$/.test(email) && email.length <= 254 ? email : null;
};

/** Accepts an email or a quick-login name, which is how people name each other on a host. */
export const normalizeUserReference = (raw: string): string | null =>
  raw.includes("@")
    ? normalizeEmail(raw)
    : (() => {
        const name = normalizeQuickLoginName(raw);
        return name === null ? null : quickLoginEmail(name);
      })();

export const MIN_PASSWORD_LENGTH = 8;

/**
 * The project and thread ids an RPC payload names. Only top-level fields are
 * read: every orchestration command and project RPC names its target there.
 */
export interface RpcTargets {
  readonly projectIds: ReadonlyArray<string>;
  readonly threadIds: ReadonlyArray<string>;
  readonly cwds: ReadonlyArray<string>;
}

const THREAD_ID_FIELDS = ["threadId", "parentThreadId", "sourceThreadId", "targetThreadId"];

export const rpcTargets = (payload: unknown): RpcTargets => {
  if (payload === null || typeof payload !== "object") {
    return { projectIds: [], threadIds: [], cwds: [] };
  }
  const record = payload as Record<string, unknown>;
  const strings = (keys: ReadonlyArray<string>) =>
    keys.flatMap((key) => {
      const value = record[key];
      return typeof value === "string" && value.length > 0 ? [value] : [];
    });
  return {
    projectIds: strings(["projectId"]),
    threadIds: strings(THREAD_ID_FIELDS),
    // A clone destination or a re-rooted project must stay inside what the member can reach.
    cwds: strings(["cwd", "destinationPath", "workspaceRoot"]),
  };
};

/** A project the member just created through these RPCs becomes theirs. */
export const createdProjectId = (
  method: string,
  payload: unknown,
  result: unknown,
): string | null => {
  const fromResult = () => {
    if (result === null || typeof result !== "object") return null;
    const record = result as Record<string, unknown>;
    const id = record["projectId"] ?? record["id"];
    return typeof id === "string" ? id : null;
  };
  if (method === "projects.mutate") {
    const type =
      payload !== null && typeof payload === "object"
        ? (payload as Record<string, unknown>)["type"]
        : undefined;
    return type === "project.create" ? fromResult() : null;
  }
  if (method === "projects.createNew" || method === "projects.createFromThread") {
    return fromResult();
  }
  return null;
};

/** Deleting a project is the owner's call; everything else is open to members. */
export const requiresOwner = (method: string, payload: unknown): boolean =>
  method === "projects.mutate" &&
  payload !== null &&
  typeof payload === "object" &&
  (payload as Record<string, unknown>)["type"] === "project.delete";

/** `path` is `root` or below it, for the host's own paths (Windows hosts: `C:\\...`, either separator, any case). */
export const pathIsWithin = (root: string, path: string) => isWithin(root, path);

/** A working directory is reachable when it sits inside a visible project or a LogicPacks worktree. */
export const cwdIsReachable = (
  cwd: string,
  visibleRoots: ReadonlyArray<string>,
  worktreesDir: string,
): boolean =>
  pathIsWithin(worktreesDir, cwd) || visibleRoots.some((root) => pathIsWithin(root, cwd));

/**
 * Drops what a member may not see from the shell stream. Removals pass
 * through: they carry no content and keep the client from holding stale rows.
 */
export const filterShellItemForMember = (
  item: OrchestrationV2ShellStreamItem,
  canSee: (projectId: string) => boolean,
): OrchestrationV2ShellStreamItem | null => {
  switch (item.kind) {
    case "snapshot":
      return {
        ...item,
        snapshot: {
          ...item.snapshot,
          projects: item.snapshot.projects.filter((project) => canSee(project.id)),
          threads: item.snapshot.threads.filter((thread) => canSee(thread.projectId)),
          archivedThreads: item.snapshot.archivedThreads.filter((thread) =>
            canSee(thread.projectId),
          ),
        },
      };
    case "project.updated":
      return canSee(item.project.id) ? item : null;
    case "thread.updated":
      return canSee(item.thread.projectId) ? item : null;
    default:
      return item;
  }
};

/** RPCs whose results list threads or projects across the host; members get only theirs. */
export const MEMBER_FILTERED_LIST_METHODS = new Set([
  "orchestration.searchThreads",
  "orchestration.getArchivedShellSnapshot",
  "orchestration.getOlderSettledThreads",
  "orchestration.getThreadFamily",
  "orchestration.getWorktreeThreadIds",
]);

const PROJECT_KEYED_LISTS = ["threads", "archivedThreads", "matches", "counts"] as const;

/** Drops rows of other projects from a list result, one level deep. */
export const filterListResultForMember = (
  result: unknown,
  canSee: (projectId: string) => boolean,
): unknown => {
  if (result === null || typeof result !== "object" || Array.isArray(result)) return result;
  const record = { ...(result as Record<string, unknown>) };
  const projects = record["projects"];
  if (Array.isArray(projects)) {
    record["projects"] = projects.filter((row) => canSee(String(row?.id)));
  }
  for (const key of PROJECT_KEYED_LISTS) {
    const rows = record[key];
    if (Array.isArray(rows)) {
      record[key] = rows.filter((row) =>
        row !== null && typeof row === "object" && "projectId" in row
          ? canSee(String((row as { projectId: unknown }).projectId))
          : true,
      );
    }
  }
  return record;
};
