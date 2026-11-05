// @effect-diagnostics nodeBuiltinImport:off -- path checks must see the real filesystem (realpath, .git files) synchronously.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { sandboxDigest, sandboxHome } from "./memberSandbox.ts";

/**
 * The filesystem jail for members of a shared host. A member's RPCs may only name paths inside
 * their own member root (where `~` resolves for them) and the projects shared with them, plus
 * the git worktrees of those projects. The operator is never jailed.
 */

/** `<baseDir>/members/<digest>`: the member's `~` on a shared host (their Unix user's HOME). */
export const memberRootDir = (baseDir: string, userId: string) =>
  sandboxHome(baseDir, sandboxDigest(userId));

/** Creates the member root (0700) on first use and returns it. */
export const ensureMemberRoot = (baseDir: string, userId: string) => {
  const root = memberRootDir(baseDir, userId);
  NodeFS.mkdirSync(NodePath.dirname(root), { recursive: true, mode: 0o711 });
  if (!NodeFS.existsSync(root)) NodeFS.mkdirSync(root, { recursive: true, mode: 0o700 });
  return root;
};

/**
 * RPCs a member never gets on a shared host: they act on the host itself (editors, processes,
 * host agent transcripts, diagnostics that list host processes and paths).
 */
export const MEMBER_DENIED_METHODS: ReadonlySet<string> = new Set([
  "shell.openInEditor",
  "agentSessions.scan",
  "agentSessions.import",
  "server.listAcpRegistrySessions",
  "server.importAcpRegistrySession",
  "server.deleteAcpRegistrySession",
  "server.getStorageCleanupReport",
  "server.getDatabaseStorage",
  "server.getTraceDiagnostics",
  "server.getProcessDiagnostics",
  "server.getProcessResourceHistory",
  "server.getResourceTelemetryHistory",
  "server.retryResourceTelemetry",
  "subscribeResourceTelemetry",
  "preview.stopLocalServer",
  "subscribeDiscoveredLocalServers",
  "device.open",
  "device.close",
  "device.shutdown",
  "device.action",
]);

/** Terminal RPCs: a host shell. Members get them only when their terminals run sandboxed. */
export const MEMBER_TERMINAL_METHODS: ReadonlySet<string> = new Set([
  "terminal.open",
  "terminal.attach",
  "terminal.observe",
  "terminal.write",
  "terminal.resize",
  "terminal.clear",
  "terminal.close",
  "subscribeTerminalMetadata",
]);

/** Payload keys that name a host path (absolute, `~/`, or relative to a sibling `cwd`). */
const PATH_KEYS = new Set([
  "cwd",
  "path",
  "paths",
  "partialPath",
  "workspaceRoot",
  "worktreePath",
  "destinationPath",
  "filePath",
  "filePaths",
  "rootPath",
  "projectPath",
  "sourcePath",
  "oldPath",
  "newPath",
  "scriptPath",
  "homePath",
  "binaryPath",
  "executablePath",
  "faviconPath",
  "relativePath",
]);
/** Keys whose value anchors relative paths beside it. */
const BASE_KEYS = ["cwd", "workspaceRoot", "worktreePath"] as const;
/** Free text never names a path we act on; skip it so a chat message is never mistaken for one. */
const SKIPPED_KEYS = new Set(["text", "initialMessage", "prompt", "contents", "content", "query"]);

export interface PayloadPath {
  readonly key: string;
  readonly value: string;
  /** The `cwd`/`workspaceRoot` beside it, for relative values. */
  readonly base: string | null;
}

/** Every path-like string in an RPC payload, a few levels deep. */
export const collectPayloadPaths = (payload: unknown): ReadonlyArray<PayloadPath> => {
  const found: Array<PayloadPath> = [];
  const walk = (value: unknown, depth: number, inheritedBase: string | null) => {
    if (depth > 6 || value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1, inheritedBase);
      return;
    }
    const record = value as Record<string, unknown>;
    let base = inheritedBase;
    for (const key of BASE_KEYS) {
      const candidate = record[key];
      if (typeof candidate === "string" && candidate.length > 0) {
        base = candidate;
        break;
      }
    }
    for (const [key, child] of Object.entries(record)) {
      if (SKIPPED_KEYS.has(key)) continue;
      if (PATH_KEYS.has(key)) {
        const ownBase = BASE_KEYS.includes(key as (typeof BASE_KEYS)[number])
          ? inheritedBase
          : base;
        if (typeof child === "string" && child.length > 0) {
          found.push({ key, value: child, base: ownBase });
          continue;
        }
        if (Array.isArray(child)) {
          for (const item of child) {
            if (typeof item === "string" && item.length > 0) {
              found.push({ key, value: item, base: ownBase });
            }
          }
          continue;
        }
      }
      walk(child, depth + 1, base);
    }
  };
  walk(payload, 0, null);
  return found;
};

const hasDotDotSegment = (value: string) => value.split(/[\\/]+/).some((part) => part === "..");

/** The path flavour of the host running the server: `NodePath` (posix or win32). Tests pass `win32`. */
export type PathApi = NodePath.PlatformPath;

const isWindowsApi = (api: PathApi) => api.sep === "\\";

/** `\\?\C:\x` is the same place as `C:\x`; `\\?\UNC\` and `\\host\share` stay network paths. */
const stripExtendedPrefix = (value: string) => value.replace(/^\\\\[?.]\\(?=[A-Za-z]:[\\/])/, "");

/**
 * The absolute path a member's value names, with `~` as their member root. Null when it is
 * refused outright: `..` segments, `~otheruser`, network paths, and drive paths on a host that
 * has no drives. A Windows host names its projects `C:\...`, so there they are the normal case.
 * `"unanchored"` is a relative value with nothing to anchor it to; the handler anchors it to a
 * checked root.
 */
export const resolveMemberPath = (
  value: string,
  base: string | null,
  memberRoot: string,
  api: PathApi = NodePath,
): string | null | "unanchored" => {
  const windows = isWindowsApi(api);
  const trimmed = windows ? stripExtendedPrefix(value.trim()) : value.trim();
  if (trimmed.length === 0) return "unanchored";
  if (hasDotDotSegment(trimmed)) return null;
  if (trimmed.includes("\0") || trimmed.startsWith("\\\\")) return null;
  if (!windows && /^[A-Za-z]:([\\/]|$)/.test(trimmed)) return null;
  if (trimmed === "~") return memberRoot;
  if (trimmed.startsWith("~/") || (windows && trimmed.startsWith("~\\"))) {
    return api.join(memberRoot, trimmed.slice(2));
  }
  if (trimmed.startsWith("~")) return null;
  // `C:foo` and `\foo` are relative to a drive or the current drive on Windows: never a name we accept.
  if (windows && (/^[A-Za-z]:(?![\\/])/.test(trimmed) || /^[\\/](?![\\/])/.test(trimmed))) {
    return null;
  }
  if (api.isAbsolute(trimmed)) return api.resolve(trimmed);
  if (base === null) return "unanchored";
  const anchored = resolveMemberPath(base, null, memberRoot, api);
  if (anchored === null || anchored === "unanchored")
    return anchored === null ? null : "unanchored";
  return api.resolve(anchored, trimmed);
};

/** realpath of the deepest existing ancestor, with the rest appended: symlinks cannot escape. */
export const realpathLenient = (absolute: string, api: PathApi = NodePath): string => {
  const windows = isWindowsApi(api);
  // The native call expands 8.3 short names (`RUNNER~1`) that the JS one keeps, on Windows.
  const realpath = windows && api === NodePath ? NodeFS.realpathSync.native : NodeFS.realpathSync;
  let current = api.resolve(absolute);
  const rest: Array<string> = [];
  for (;;) {
    try {
      const real = windows ? stripExtendedPrefix(realpath(current)) : realpath(current);
      return rest.length === 0 ? real : api.join(real, ...rest.reverse());
    } catch {
      const parent = api.dirname(current);
      if (parent === current) return api.resolve(absolute);
      rest.push(api.basename(current));
      current = parent;
    }
  }
};

/**
 * Whether `candidate` is `root` or below it. Windows paths compare case-insensitively and
 * accept either separator (`C:\Users\Me` is `c:/users/me`); a relative side is never inside.
 */
export const isWithin = (root: string, candidate: string, api: PathApi = NodePath) => {
  if (!api.isAbsolute(root) || !api.isAbsolute(candidate)) return false;
  const rel = api.relative(root, candidate);
  if (rel === "") return true;
  return rel !== ".." && !rel.startsWith(`..${api.sep}`) && !api.isAbsolute(rel);
};

/**
 * The project a git worktree under `worktreesDir` belongs to: `<worktreesDir>/<repo>/<branch>`
 * has a `.git` file pointing at `<project>/.git/worktrees/<name>`.
 */
export const worktreeProjectRoot = (
  candidate: string,
  worktreesDir: string,
  api: PathApi = NodePath,
): string | null => {
  const relative = api.relative(worktreesDir, candidate);
  if (relative.startsWith("..") || api.isAbsolute(relative)) return null;
  const [repo, branch] = relative.split(api.sep);
  if (!repo || !branch) return null;
  try {
    const dotGit = NodeFS.readFileSync(api.join(worktreesDir, repo, branch, ".git"), "utf8");
    const match = /^gitdir:\s*(.+)$/m.exec(dotGit);
    if (match === null) return null;
    // Git writes `C:/x/.git/worktrees/b` on Windows: resolve normalizes it to the native form.
    const gitDir = api.resolve(api.join(worktreesDir, repo, branch), match[1]!.trim());
    const marker = `${api.sep}.git${api.sep}worktrees${api.sep}`;
    const at = (isWindowsApi(api) ? gitDir.toLowerCase() : gitDir).lastIndexOf(
      isWindowsApi(api) ? marker.toLowerCase() : marker,
    );
    return at <= 0 ? null : realpathLenient(gitDir.slice(0, at), api);
  } catch {
    return null;
  }
};

export interface MemberJail {
  readonly memberRoot: string;
  /** Real paths the member may touch: their root and their projects' roots. */
  readonly roots: ReadonlyArray<string>;
  readonly worktreesDir: string;
  readonly api: PathApi;
}

export const makeMemberJail = (input: {
  readonly memberRoot: string;
  readonly projectRoots: ReadonlyArray<string>;
  readonly worktreesDir: string;
  readonly api?: PathApi;
}): MemberJail => {
  const api = input.api ?? NodePath;
  return {
    memberRoot: input.memberRoot,
    roots: [input.memberRoot, ...input.projectRoots].map((root) => realpathLenient(root, api)),
    worktreesDir: realpathLenient(input.worktreesDir, api),
    api,
  };
};

/** Whether a member may name this absolute path. */
export const jailAllows = (jail: MemberJail, absolute: string): boolean => {
  const { api } = jail;
  const real = realpathLenient(absolute, api);
  if (jail.roots.some((root) => isWithin(root, real, api))) return true;
  if (!isWithin(jail.worktreesDir, real, api)) return false;
  const owner = worktreeProjectRoot(real, jail.worktreesDir, api);
  return owner !== null && jail.roots.slice(1).some((root) => isWithin(root, owner, api));
};

/** The first path in a payload the member may not reach, or null when all are inside. */
export const firstJailViolation = (jail: MemberJail, payload: unknown): PayloadPath | null => {
  for (const entry of collectPayloadPaths(payload)) {
    const resolved = resolveMemberPath(entry.value, entry.base, jail.memberRoot, jail.api);
    if (resolved === "unanchored") continue;
    if (resolved === null || !jailAllows(jail, resolved)) return entry;
  }
  return null;
};

/** Methods whose handlers read `~` from the request's HostProcess.HomeDirectory. */
export const MEMBER_HOME_METHODS: ReadonlySet<string> = new Set([
  "filesystem.browse",
  "filesystem.getMetadata",
]);

/**
 * A `~` path in any other method is resolved on another fiber (a queue) with the host's home,
 * so members must send absolute paths there.
 */
export const usesTildeOutsideHomeMethods = (method: string, payload: unknown): boolean =>
  !MEMBER_HOME_METHODS.has(method) &&
  collectPayloadPaths(payload).some((entry) => entry.value.trim().startsWith("~"));

/**
 * The folders a Files zone shares, as REAL paths. Empty entries share the whole project. A
 * relative entry is inside the project: a `..`, an absolute-looking value or a symlink that leads
 * out of the project's real root is rejected. An absolute entry is another folder the host chose
 * on purpose (its real path is used). Windows: case-insensitive, either separator.
 */
export const resolveSharedFolders = (
  projectRoot: string,
  entries: ReadonlyArray<string>,
  api: PathApi = NodePath,
): { readonly folders: ReadonlyArray<string>; readonly rejected: ReadonlyArray<string> } => {
  const root = realpathLenient(projectRoot, api);
  if (entries.length === 0) return { folders: [root], rejected: [] };
  const folders: Array<string> = [];
  const rejected: Array<string> = [];
  for (const entry of entries) {
    const value = entry.trim();
    if (value.length === 0 || value.includes("\0")) continue;
    const windows = isWindowsApi(api);
    const normalized = windows ? stripExtendedPrefix(value) : value;
    if (windows && normalized.startsWith("\\\\")) {
      rejected.push(entry);
      continue;
    }
    if (api.isAbsolute(normalized) || (windows && /^[A-Za-z]:[\\/]/.test(normalized))) {
      folders.push(realpathLenient(normalized, api));
      continue;
    }
    if (
      hasDotDotSegment(normalized) ||
      normalized.startsWith("~") ||
      normalized.startsWith("\\\\")
    ) {
      rejected.push(entry);
      continue;
    }
    const real = realpathLenient(api.join(root, normalized), api);
    if (isWithin(root, real, api)) folders.push(real);
    else rejected.push(entry);
  }
  return { folders: [...new Set(folders)], rejected };
};

/** Whether the real path of `absolute` sits in one of the shared folders (symlinks and `..` cannot lead out). */
export const folderAllows = (
  folders: ReadonlyArray<string>,
  absolute: string,
  api: PathApi = NodePath,
): boolean => {
  const real = realpathLenient(absolute, api);
  return folders.some((folder) => isWithin(folder, real, api));
};
