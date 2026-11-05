import {
  AI_OFF_MESSAGE,
  COMPUTE_OFF_MESSAGE,
  FILES_OFF_MESSAGE,
  FILES_READ_ONLY_MESSAGE,
  canCompute,
  canManageProjects,
  canReadFiles,
  PROJECTS_OFF_MESSAGE,
  canWriteFiles,
  type ZoneValues,
} from "@logicpacks/contracts";

/**
 * What an RPC needs from a member's access zones, in one place. Pure: the fence resolves the
 * project and the zones, this says what the call is. A call that matches nothing here is an
 * ordinary member call: it is refused only for a Read only seat (see readOnlyRpc.ts), so a new
 * mutating RPC is closed by default for Read only and open for everyone else, as before.
 */
export type ZoneNeed = "files.read" | "files.write" | "compute" | "projects.create" | "projects.manage";

/** A file's path is named by `cwd` plus a relative path: which project it sits in is decided by cwd. */
export const FILE_READ_METHODS: ReadonlySet<string> = new Set([
  "projects.listEntries",
  "projects.listIgnoredFiles",
  "projects.readFile",
  "projects.searchContents",
  "projects.searchEntries",
  "filesystem.browse",
  "filesystem.getMetadata",
  "review.getBranchCommits",
  "review.getDiffPreview",
  "review.getDiffFileContents",
]);

/**
 * Changes to files, branches and the checkout. Git hooks and repo scripts can run commands when
 * these run; that is the "writable files can become code" limit, stated in the Compute zone.
 */
export const FILE_WRITE_METHODS: ReadonlySet<string> = new Set([
  "projects.writeFile",
  "projects.ensureScratch",
  "vcs.pull",
  "vcs.createWorktree",
  "vcs.removeWorktree",
  "vcs.createRef",
  "vcs.switchRef",
  "vcs.init",
  "git.runStackedAction",
  "git.preparePullRequestThread",
]);

/** Commands, dev servers, other tools, and unattended agent runs: all run as the host. */
export const COMPUTE_METHODS: ReadonlySet<string> = new Set([
  "terminal.open",
  "terminal.attach",
  "terminal.observe",
  "terminal.write",
  "terminal.resize",
  "terminal.clear",
  "terminal.close",
  "subscribeTerminalMetadata",
  "preview.open",
  "preview.stopLocalServer",
  "mcpApps.callTool",
  // A scheduled task is an agent prompt nobody is sending: it would run with no sender's limits.
  "scheduledTasks.upsert",
  "scheduledTasks.setEnabled",
  "scheduledTasks.runNow",
  "scheduledTasks.rotateWebhookToken",
  "server.signalProcess",
]);

export const TERMINAL_METHODS: ReadonlySet<string> = new Set(
  [...COMPUTE_METHODS].filter((method) => method.startsWith("terminal.") || method === "subscribeTerminalMetadata"),
);

/** RPCs that make a project (or bring a folder in as one) on the host. */
export const PROJECT_CREATE_METHODS: ReadonlySet<string> = new Set([
  "projects.createNew",
  "projects.createFromThread",
  "projectClone.start",
  "sourceControl.cloneRepository",
  "sourceControl.publishRepository",
]);

/** Commands that approve what an agent asked to run. */
const APPROVAL_COMMAND_TYPES: ReadonlySet<string> = new Set(["runtime-request.respond"]);

/** `t3.json` holds project scripts that run on worktree setup: writing it is running code. */
export const PROJECT_FILE_BASENAMES: ReadonlySet<string> = new Set(["t3.json"]);

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;

const basename = (path: string) => path.replaceAll("\\", "/").split("/").filter(Boolean).at(-1) ?? "";

export const rpcNeeds = (method: string, payload: unknown): ReadonlyArray<ZoneNeed> => {
  const body = record(payload);
  if (COMPUTE_METHODS.has(method)) return ["compute"];
  if (method === "orchestration.dispatchCommand") {
    const type = body?.["type"];
    if (typeof type === "string" && APPROVAL_COMMAND_TYPES.has(type)) return ["compute"];
    // Adopting a folder registers it as a project: that is creating one.
    return type === "thread.project.adopt-folder" ? ["projects.create"] : [];
  }
  if (method === "projects.mutate") {
    const type = body?.["type"];
    // Project scripts run commands in terminals and on worktree setup.
    const scripts: ReadonlyArray<ZoneNeed> = body !== null && body["scripts"] !== undefined ? ["compute"] : [];
    if (type === "project.create") return ["projects.create", ...scripts];
    return ["projects.manage", ...scripts];
  }
  if (PROJECT_CREATE_METHODS.has(method)) return ["projects.create"];
  if (method === "projects.writeFile") {
    const path = body?.["relativePath"] ?? body?.["path"];
    return typeof path === "string" && PROJECT_FILE_BASENAMES.has(basename(path))
      ? ["files.write", "compute"]
      : ["files.write"];
  }
  if (FILE_WRITE_METHODS.has(method)) return ["files.write"];
  if (FILE_READ_METHODS.has(method)) return ["files.read"];
  if (method === "assets.createUrl") {
    const resource = record(body?.["resource"]);
    const tag = resource?.["_tag"];
    return tag === "workspace-file" || tag === "media-file" || tag === "draft-workspace-file"
      ? ["files.read"]
      : [];
  }
  return [];
};

export const hasNeed = (zones: ZoneValues, need: ZoneNeed): boolean =>
  need === "compute"
    ? canCompute(zones)
    : need === "files.write"
      ? canWriteFiles(zones)
      : need === "projects.create" || need === "projects.manage"
        ? canManageProjects(zones)
        : canReadFiles(zones);

/** The message a member sees for a refused need; null when allowed. */
export const refusalFor = (zones: ZoneValues, needs: ReadonlyArray<ZoneNeed>): string | null => {
  for (const need of needs) {
    if (hasNeed(zones, need)) continue;
    if (need === "compute") return COMPUTE_OFF_MESSAGE;
    if (need === "projects.create" || need === "projects.manage") return PROJECTS_OFF_MESSAGE;
    if (need === "files.write") {
      return canReadFiles(zones) ? FILES_READ_ONLY_MESSAGE : FILES_OFF_MESSAGE;
    }
    return FILES_OFF_MESSAGE;
  }
  return null;
};

export const aiOffMessage = (agentLabel: string | null) =>
  agentLabel === null
    ? AI_OFF_MESSAGE
    : `The host has not allowed you to use their ${agentLabel} here. Request it, or use your own login.`;
