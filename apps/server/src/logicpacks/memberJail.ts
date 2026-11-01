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

/**
 * The absolute path a member's value names, with `~` as their member root. Null when it is
 * refused outright: `..` segments, `~otheruser`, Windows or network paths. `"unanchored"` is a
 * relative value with nothing to anchor it to; the handler anchors it to a checked root.
 */
export const resolveMemberPath = (
  value: string,
  base: string | null,
  memberRoot: string,
): string | null | "unanchored" => {
  const trimmed = value.trim();
  if (trimmed.length === 0) return "unanchored";
  if (hasDotDotSegment(trimmed)) return null;
  if (trimmed.includes("\0") || trimmed.startsWith("\\\\") || /^[A-Za-z]:[\\/]/.test(trimmed)) {
    return null;
  }
  if (trimmed === "~") return memberRoot;
  if (trimmed.startsWith("~/")) return NodePath.join(memberRoot, trimmed.slice(2));
  if (trimmed.startsWith("~")) return null;
  if (NodePath.isAbsolute(trimmed)) return NodePath.resolve(trimmed);
  if (base === null) return "unanchored";
  const anchored = resolveMemberPath(base, null, memberRoot);
  if (anchored === null || anchored === "unanchored")
    return anchored === null ? null : "unanchored";
  return NodePath.resolve(anchored, trimmed);
};

/** realpath of the deepest existing ancestor, with the rest appended: symlinks cannot escape. */
export const realpathLenient = (absolute: string): string => {
  let current = NodePath.resolve(absolute);
  const rest: Array<string> = [];
  for (;;) {
    try {
      const real = NodeFS.realpathSync(current);
      return rest.length === 0 ? real : NodePath.join(real, ...rest.reverse());
    } catch {
      const parent = NodePath.dirname(current);
      if (parent === current) return NodePath.resolve(absolute);
      rest.push(NodePath.basename(current));
      current = parent;
    }
  }
};

export const isWithin = (root: string, candidate: string) => {
  const trimmed = root.length > 1 && root.endsWith("/") ? root.slice(0, -1) : root;
  return candidate === trimmed || candidate.startsWith(`${trimmed}/`);
};

/**
 * The project a git worktree under `worktreesDir` belongs to: `<worktreesDir>/<repo>/<branch>`
 * has a `.git` file pointing at `<project>/.git/worktrees/<name>`.
 */
export const worktreeProjectRoot = (candidate: string, worktreesDir: string): string | null => {
  const relative = NodePath.relative(worktreesDir, candidate);
  if (relative.startsWith("..") || NodePath.isAbsolute(relative)) return null;
  const [repo, branch] = relative.split(NodePath.sep);
  if (!repo || !branch) return null;
  try {
    const dotGit = NodeFS.readFileSync(NodePath.join(worktreesDir, repo, branch, ".git"), "utf8");
    const match = /^gitdir:\s*(.+)$/m.exec(dotGit);
    if (match === null) return null;
    const gitDir = NodePath.resolve(NodePath.join(worktreesDir, repo, branch), match[1]!.trim());
    const marker = `${NodePath.sep}.git${NodePath.sep}worktrees${NodePath.sep}`;
    const at = gitDir.lastIndexOf(marker);
    return at <= 0 ? null : realpathLenient(gitDir.slice(0, at));
  } catch {
    return null;
  }
};

export interface MemberJail {
  readonly memberRoot: string;
  /** Real paths the member may touch: their root and their projects' roots. */
  readonly roots: ReadonlyArray<string>;
  readonly worktreesDir: string;
}

export const makeMemberJail = (input: {
  readonly memberRoot: string;
  readonly projectRoots: ReadonlyArray<string>;
  readonly worktreesDir: string;
}): MemberJail => ({
  memberRoot: input.memberRoot,
  roots: [input.memberRoot, ...input.projectRoots].map(realpathLenient),
  worktreesDir: realpathLenient(input.worktreesDir),
});

/** Whether a member may name this absolute path. */
export const jailAllows = (jail: MemberJail, absolute: string): boolean => {
  const real = realpathLenient(absolute);
  if (jail.roots.some((root) => isWithin(root, real))) return true;
  if (!isWithin(jail.worktreesDir, real)) return false;
  const owner = worktreeProjectRoot(real, jail.worktreesDir);
  return owner !== null && jail.roots.slice(1).some((root) => isWithin(root, owner));
};

/** The first path in a payload the member may not reach, or null when all are inside. */
export const firstJailViolation = (jail: MemberJail, payload: unknown): PayloadPath | null => {
  for (const entry of collectPayloadPaths(payload)) {
    const resolved = resolveMemberPath(entry.value, entry.base, jail.memberRoot);
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
