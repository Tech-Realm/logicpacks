// @effect-diagnostics nodeBuiltinImport:off -- wraps the Claude CLI launch of a member's run in the OS sandbox.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { memberSandboxEnabled } from "./memberSandbox.ts";
import { isWithin, realpathLenient } from "./memberJail.ts";
import {
  memberSandboxSupported,
  SandboxUnavailableError,
  sandboxedMemberLaunch,
} from "./folderSandbox.ts";
import type { RunConfinement } from "./runLimits.ts";

/**
 * A member's Claude run, confined by the OS (macOS Seatbelt) to the shared folders. What the
 * member's agent can read and write is decided by the kernel for the CLI and every process it
 * starts, not by the prompt or by Claude's own tool rules.
 *
 * Credentials the host's Claude needs reach the CLI through its environment (never a file in a
 * readable place): the host's `~/.claude`, `~/.codex`, `~/.ssh` and the keychain are refused by
 * the profile, the CLI gets its own config folder inside the member's space, and
 * CLAUDE_CODE_SUBPROCESS_ENV_SCRUB keeps the token out of the environment of the commands the
 * agent runs.
 *
 * FAIL CLOSED: a required sandbox that cannot be applied throws; the run does not start.
 */

/** Test hook: forces the sandbox to fail so the refusal path can be proven end to end. */
export const FORCE_SANDBOX_FAILURE_ENV = "LOGICPACKS_TEST_FORCE_SANDBOX_FAILURE";

const AUTH_ENV = /^(ANTHROPIC_|CLAUDE_CODE_(OAUTH_TOKEN|USE_|SKIP_|API_)|CLAUDE_CODE_ENTRYPOINT$)/;
const PASS_ENV = new Set(["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TZ", "USER", "LOGNAME", "SHELL"]);

export interface ClaudeSpawnLike {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string | undefined;
  readonly env: Record<string, string | undefined>;
  readonly signal?: AbortSignal | undefined;
}

/** Whether a run needing the sandbox can get one here: macOS, or the cloud user sandbox. */
export const confinementAvailable = (platform: NodeJS.Platform = process.platform) =>
  memberSandboxSupported(platform);

/** Throws SandboxUnavailableError before anything starts when the sandbox cannot be applied. */
export function preflightConfinement(confinement: RunConfinement, env: NodeJS.ProcessEnv = process.env): void {
  if (env[FORCE_SANDBOX_FAILURE_ENV] === "1") {
    throw new SandboxUnavailableError("The sandbox was forced to fail (test), so the run was not started.");
  }
  if (memberSandboxEnabled(env)) return;
  if (!confinementAvailable()) {
    throw new SandboxUnavailableError(
      "This host cannot sandbox a member's agent (macOS only), so the run was not started.",
    );
  }
  if (confinement.folders.length === 0) {
    throw new SandboxUnavailableError("No folder is shared for this run, so it was not started.");
  }
}

/** The host's Claude login for a CLI that may not read the host's files: from the environment or the keychain. */
export function hostClaudeAuthEnv(
  env: Record<string, string | undefined>,
  readKeychain: () => string | null = readClaudeKeychainToken,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && AUTH_ENV.test(key)) out[key] = value;
  }
  const hasLogin = out.ANTHROPIC_API_KEY !== undefined || out.CLAUDE_CODE_OAUTH_TOKEN !== undefined || out.ANTHROPIC_AUTH_TOKEN !== undefined;
  if (!hasLogin) {
    const token = readKeychain();
    if (token !== null) out.CLAUDE_CODE_OAUTH_TOKEN = token;
  }
  return out;
}

/** The host's Claude Code login from the macOS keychain (read by the server, outside the sandbox). */
export function readClaudeKeychainToken(): string | null {
  if (process.platform !== "darwin") return null;
  try {
    const raw = NodeChildProcess.execFileSync(
      "/usr/bin/security",
      ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
      { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    const parsed = JSON.parse(raw) as { claudeAiOauth?: { accessToken?: string } };
    return parsed.claudeAiOauth?.accessToken ?? null;
  } catch {
    return null;
  }
}

const exists = (path: string) => {
  try {
    return NodeFS.existsSync(path);
  } catch {
    return false;
  }
};

/**
 * Read-only locations the CLI needs: its executable, and the script it runs when the command is a
 * node-style launcher (the first argument that is a script file). NOT every absolute path in the
 * arguments: an `--add-dir` or attachment path the member names must not become readable by being
 * on the command line.
 */
const toolLocations = (command: string, args: ReadonlyArray<string>) => {
  const out = new Set<string>();
  const add = (candidate: string) => {
    if (!NodePath.isAbsolute(candidate) || !exists(candidate)) return;
    const real = realpathLenient(candidate);
    out.add(real);
    if (/\.(m?js|cjs)$/.test(real)) out.add(NodePath.dirname(real));
  };
  add(command);
  const entry = args.find((arg) => /\.(m?js|cjs)$/.test(arg) && NodePath.isAbsolute(arg));
  if (entry !== undefined) add(entry);
  return [...out];
};

/**
 * The launch of a member's Claude CLI inside the sandbox: a new command, args and a scrubbed
 * environment that carries the host's login but none of the host's other secrets.
 */
export function confineClaudeSpawn<T extends ClaudeSpawnLike>(
  spawn: T,
  confinement: RunConfinement,
  deps: { readonly readKeychain?: () => string | null; readonly processEnv?: NodeJS.ProcessEnv } = {},
): T & { readonly secretToken?: string | undefined } {
  preflightConfinement(confinement, deps.processEnv);
  if (memberSandboxEnabled(deps.processEnv)) return spawn;
  const cwd = spawn.cwd;
  // A worktree of the whole project is inside the share too.
  const folders = [...confinement.folders];
  if (confinement.wholeProject && cwd !== undefined) {
    const real = realpathLenient(cwd);
    const root = realpathLenient(confinement.worktreesDir);
    const rel = NodePath.relative(root, real);
    if (!rel.startsWith("..") && !NodePath.isAbsolute(rel) && rel !== "") folders.push(real);
  }
  // Claude cannot start in a folder it may not read: with only subfolders shared, it starts in the first one.
  const startCwd =
    cwd !== undefined && folders.some((folder) => isWithin(folder, realpathLenient(cwd)))
      ? cwd
      : (folders[0] ?? cwd);
  const launch = sandboxedMemberLaunch(spawn.command, spawn.args, {
    folders,
    readOnly: toolLocations(spawn.command, spawn.args),
    tmpDir: NodePath.join(confinement.memberHome, "tmp"),
    memberHome: confinement.memberHome,
    stateDir: confinement.stateDir,
    name: "agent",
  });
  const baseEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(spawn.env)) {
    if (value !== undefined && PASS_ENV.has(key)) baseEnv[key] = value;
  }
  // The thread marker port discovery uses, and nothing else of the host's.
  for (const [key, value] of Object.entries(spawn.env)) {
    if (value !== undefined && /^LOGICPACKS_THREAD_ID$/.test(key)) baseEnv[key] = value;
  }
  const configured = spawn.env.CLAUDE_CONFIG_DIR;
  const ownConfig =
    configured !== undefined &&
    NodePath.relative(confinement.memberHome, realpathLenient(configured)).startsWith("..") === false
      ? configured
      : NodePath.join(confinement.memberHome, ".claude-config");
  NodeFS.mkdirSync(ownConfig, { recursive: true, mode: 0o700 });
  // The OAuth login goes over a pipe on file descriptor 4, not the environment: a process of the
  // same user can read another process's environment on macOS (sysctl procargs2), and the
  // sandbox cannot stop that. A pipe is read once by the CLI and is empty afterwards.
  const auth = hostClaudeAuthEnv(spawn.env, deps.readKeychain);
  const secretToken = auth.CLAUDE_CODE_OAUTH_TOKEN;
  if (secretToken !== undefined) {
    delete auth.CLAUDE_CODE_OAUTH_TOKEN;
    auth.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR = "4";
  }
  return {
    ...spawn,
    cwd: startCwd,
    command: launch.command,
    args: [...launch.args],
    secretToken,
    env: {
      ...baseEnv,
      ...auth,
      HOME: confinement.memberHome,
      CLAUDE_CONFIG_DIR: ownConfig,
      CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1",
      // Claude keeps its task output under /tmp/claude-<uid>, which is the host's and refused.
      CLAUDE_CODE_TMPDIR: NodePath.join(confinement.memberHome, "tmp"),
      ...launch.env,
    },
  };
}
