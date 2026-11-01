// @effect-diagnostics nodeBuiltinImport:off -- Unix users, groups and file modes on the host, synchronously.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  configureLoginVault,
  sealAllIdleMemberLogins,
  sealIdleProviderHome,
  VAULT_FUNCTION_KEYS,
  VAULT_RUNNER_FUNCTIONS,
  vaultCredentialFiles,
  vaultShred,
} from "./loginVault.ts";
import { isMemberInstanceId, userDigest } from "./memberProviders.ts";

/**
 * Member sandbox on a shared host. With `LOGICPACKS_MEMBER_SANDBOX=user` every member agent
 * process runs as that member's own unprivileged Unix user, `lpm-<digest>`, whose HOME is
 * their member root. The server (root) reaches it through a per-member wrapper binary: the
 * wrapper runs the member runner as root, which prepares the user, drops to it
 * (initgroups/setgid/setuid), scrubs the environment and starts the real CLI.
 *
 * Projects a member can open are shared through one group per project (`lp-p-<digest>`):
 * setgid directories, group read/write, and the members of the project in the group.
 */

export const memberSandboxEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env.LOGICPACKS_MEMBER_SANDBOX === "user";

/** The digest that names a member everywhere in the sandbox (and in their instance ids). */
export const sandboxDigest = (userId: string) => userDigest(userId);
export const sandboxUserName = (digest: string) => `lpm-${digest}`;
/** `<baseDir>/members/<digest>`: the member's `~` and their Unix user's HOME. */
export const sandboxHome = (baseDir: string, digest: string) =>
  NodePath.join(baseDir, "members", digest);
/** Where a member's provider logins live inside their home. */
export const sandboxProviderHome = (baseDir: string, digest: string, provider: string) =>
  NodePath.join(sandboxHome(baseDir, digest), ".lp", provider);
export const projectGroupName = (projectId: string) =>
  `lp-p-${NodeCrypto.createHash("sha256").update(projectId).digest("hex").slice(0, 12)}`;

const sandboxDir = (baseDir: string) => NodePath.join(baseDir, "sandbox");
export const runnerPath = (baseDir: string) =>
  NodePath.join(sandboxDir(baseDir), "lp-member-run.mjs");
export const wrapperPath = (baseDir: string, digest: string, kind: string) =>
  NodePath.join(sandboxDir(baseDir), "bin", digest, kind);

// ---------------------------------------------------------------------------------------------
// The runner. These functions are serialised into the runner file with Function#toString, so
// they must not reference anything outside their own bodies.

/**
 * The environment a member's agent gets: only what a provider needs, never the service's own
 * (no root HOME, no GH_TOKEN, no SSH agent). HOME, USER, PATH and TMPDIR are the member's.
 */
export function scrubMemberEnv(
  env: Record<string, string | undefined>,
  member: { readonly user: string; readonly home: string; readonly path: string },
): Record<string, string> {
  const allowedNames = new Set([
    "LANG",
    "LANGUAGE",
    "TERM",
    "COLORTERM",
    "TZ",
    "NO_COLOR",
    "FORCE_COLOR",
    "CI",
    "IS_SANDBOX",
    "NODE_ENV",
    "XDG_DATA_HOME",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "XDG_STATE_HOME",
  ]);
  const allowedPrefixes = [
    "LC_",
    "CLAUDE_",
    "CLAUDECODE",
    "ANTHROPIC_",
    "CODEX_",
    "OPENAI_",
    "OPENCODE",
    "OPENROUTER_",
    "GEMINI_",
    "GOOGLE_GENAI_",
    "MCP_",
    "OTEL_",
    "LOGICPACKS_",
    "LOGICPACKS_",
  ];
  const deniedPrefixes = ["GH_", "GITHUB_", "SSH_", "GIT_", "SUDO_", "AWS_", "CLOUDFLARE"];
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (deniedPrefixes.some((prefix) => name.startsWith(prefix))) continue;
    if (allowedNames.has(name) || allowedPrefixes.some((prefix) => name.startsWith(prefix))) {
      out[name] = value;
    }
  }
  out.HOME = member.home;
  out.USER = member.user;
  out.LOGNAME = member.user;
  out.SHELL = "/bin/sh";
  out.PATH = member.path;
  out.TMPDIR = `${member.home}/.tmp`;
  // Projects belong to root or other members; the member works in them through a group.
  out.GIT_CONFIG_COUNT = "2";
  out.GIT_CONFIG_KEY_0 = "safe.directory";
  out.GIT_CONFIG_VALUE_0 = "*";
  out.GIT_CONFIG_KEY_1 = "credential.helper";
  out.GIT_CONFIG_VALUE_1 = "";
  out.GIT_TERMINAL_PROMPT = "0";
  return out;
}

/** The vault functions the runner calls, by stable names. */
export interface RunnerVault {
  readonly vaultCredentialFiles: typeof vaultCredentialFiles;
  readonly vaultReadMasterKey: (candidates: ReadonlyArray<string>) => Buffer | null;
  readonly vaultMemberKey: (master: Uint8Array, digest: string) => Buffer;
  readonly vaultAcquire: (leaseDir: string, pid: number) => void;
  readonly vaultRelease: (leaseDir: string, pid: number) => boolean;
  readonly vaultUnsealHome: (
    key: Uint8Array,
    digest: string,
    kind: string,
    home: string,
    owner: { readonly uid: number; readonly gid: number } | null,
  ) => number;
  readonly vaultSealHome: (key: Uint8Array, digest: string, kind: string, home: string) => number;
  readonly vaultShred: (path: string) => void;
}

/** How the runner starts the real CLI: as whom, with what. Pure, for tests. */
export function planMemberSpawn(input: {
  readonly baseDir: string;
  readonly digest: string;
  readonly kind: string;
  readonly binary: string;
  readonly args: ReadonlyArray<string>;
  readonly env: Record<string, string | undefined>;
  readonly toolsPath: string;
}) {
  if (!/^[0-9a-f]{16}$/.test(input.digest)) throw new Error("bad member digest");
  if (!/^(claude|codex|opencode|gemini)$/.test(input.kind)) throw new Error("bad provider kind");
  const user = `lpm-${input.digest}`;
  const home = `${input.baseDir}/members/${input.digest}`;
  return {
    user,
    home,
    providerHome: `${home}/.lp/${input.kind}`,
    leaseDir: `${input.baseDir}/sandbox/leases/${input.digest}/${input.kind}`,
    // The runner stays root (it seals the member's login again when the CLI exits); setpriv
    // starts the CLI as the member with their groups (project access) and nothing else.
    command: "setpriv",
    args: ["--reuid", user, "--regid", user, "--init-groups", "--", input.binary, ...input.args],
    umask: 0o007,
    env: scrubMemberEnv(input.env, { user, home, path: input.toolsPath }),
  };
}

/**
 * The runner's main, as root: prepares the member's user and home, unseals the CLI's login,
 * runs the CLI as the member, and when the last of the member's processes for that CLI exits
 * seals the login again (keeping a refreshed token) and shreds the plaintext.
 */
export function memberRunnerMain(
  argv: ReadonlyArray<string>,
  toolsPath: string,
  keyCandidates: ReadonlyArray<string>,
  vault: RunnerVault,
) {
  const childProcess = process.getBuiltinModule("node:child_process");
  const fs = process.getBuiltinModule("node:fs");
  const [baseDir, digest, kind, binary, ...args] = argv;
  if (!baseDir || !digest || !kind || !binary) {
    process.stderr.write("lp-member-run: usage: <baseDir> <digest> <kind> <binary> [args]\n");
    process.exit(2);
  }
  if (process.getuid?.() !== 0) {
    process.stderr.write("lp-member-run: must start as root\n");
    process.exit(126);
  }
  // eslint-disable-next-line no-undef -- serialised next to planMemberSpawn.
  const plan = planMemberSpawn({
    baseDir,
    digest,
    kind,
    binary,
    args,
    env: process.env,
    toolsPath,
  });
  const run = (command: string, commandArgs: Array<string>) =>
    childProcess.spawnSync(command, commandArgs, { stdio: ["ignore", "ignore", "pipe"] });
  if (run("id", ["-u", plan.user]).status !== 0) {
    run("useradd", [
      "--system",
      "--user-group",
      "--no-create-home",
      "--home-dir",
      plan.home,
      "--shell",
      "/usr/sbin/nologin",
      plan.user,
    ]);
  }
  const uid = Number(String(childProcess.execFileSync("id", ["-u", plan.user])).trim());
  const gid = Number(String(childProcess.execFileSync("id", ["-g", plan.user])).trim());
  for (const dir of [plan.home, `${plan.home}/.lp`, `${plan.home}/.tmp`, plan.providerHome]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  fs.chownSync(plan.home, uid, gid);
  // 0711: others may pass through to a project shared from this home, never list it.
  fs.chmodSync(plan.home, 0o711);
  // Logins and settings the server (root) wrote for this member become theirs.
  run("chown", ["-R", `${uid}:${gid}`, `${plan.home}/.lp`, `${plan.home}/.tmp`]);
  fs.chmodSync(`${plan.home}/.tmp`, 0o700);

  // The login, unsealed only while a CLI that needs it runs.
  const master = vault.vaultReadMasterKey(keyCandidates);
  const key = master === null ? null : vault.vaultMemberKey(master, digest);
  const revoked = `${plan.leaseDir}.revoked`;
  if (key !== null) {
    vault.vaultAcquire(plan.leaseDir, process.pid);
    try {
      vault.vaultUnsealHome(key, digest, kind, plan.providerHome, { uid, gid });
    } catch (error) {
      process.stderr.write(`lp-member-run: could not open the stored login: ${String(error)}\n`);
    }
  }
  const finish = () => {
    if (key === null) return;
    if (!vault.vaultRelease(plan.leaseDir, process.pid)) return;
    if (fs.existsSync(revoked)) {
      // Disconnected while running: the login must not come back.
      for (const relative of vault.vaultCredentialFiles(kind)) {
        vault.vaultShred(`${plan.providerHome}/${relative}`);
      }
      return;
    }
    vault.vaultSealHome(key, digest, kind, plan.providerHome);
  };

  process.umask(plan.umask);
  const child = childProcess.spawn(plan.command, plan.args, { stdio: "inherit", env: plan.env });
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP", "SIGQUIT"] as const) {
    process.on(signal, () => child.kill(signal));
  }
  child.on("error", (error) => {
    process.stderr.write(`lp-member-run: ${String(error)}\n`);
    finish();
    process.exit(127);
  });
  child.on("exit", (code, signal) => {
    try {
      finish();
    } catch (error) {
      process.stderr.write(`lp-member-run: could not seal the login: ${String(error)}\n`);
    }
    if (signal !== null) {
      process.removeAllListeners(signal);
      process.kill(process.pid, signal);
    }
    process.exit(code ?? 1);
  });
}

/** The runner file: the vault, the functions above and a call. */
export const runnerSource = (toolsPath: string, keyCandidates: ReadonlyArray<string> = []) =>
  [
    "// Generated by the LogicPacks server (memberSandbox.ts). Runs member agents as their own user.",
    // Bundlers may wrap inner functions in __name(...) to keep their names.
    "var __name = (fn) => fn;",
    ...VAULT_RUNNER_FUNCTIONS.map((fn) => fn.toString()),
    scrubMemberEnv.toString(),
    planMemberSpawn.toString(),
    memberRunnerMain.toString(),
    // The vault goes in as an object: property names survive any renaming by the bundler.
    `${memberRunnerMain.name}(process.argv.slice(2), ${JSON.stringify(toolsPath)}, ${JSON.stringify(keyCandidates)}, { ${VAULT_RUNNER_FUNCTIONS.map((fn, index) => `${VAULT_FUNCTION_KEYS[index]}: ${fn.name}`).join(", ")} });`,
    "",
  ].join("\n");

export const wrapperSource = (input: {
  readonly nodePath: string;
  readonly baseDir: string;
  readonly digest: string;
  readonly kind: string;
  readonly binary: string;
}) => {
  const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
  return `#!/bin/sh\nexec ${quote(input.nodePath)} ${quote(runnerPath(input.baseDir))} ${quote(input.baseDir)} ${quote(input.digest)} ${quote(input.kind)} ${quote(input.binary)} "$@"\n`;
};

// ---------------------------------------------------------------------------------------------
// Server side.

export interface SandboxRuntime {
  readonly baseDir: string;
  readonly nodePath: string;
  readonly toolsPath: string;
  /** The real CLIs: LOGICPACKS_MEMBER_*_BINARY, or the name on PATH. */
  readonly binaries: Readonly<Record<"claude" | "codex" | "opencode" | "gemini", string>>;
}

let runtime: SandboxRuntime | null = null;

/** The sandbox the server runs with, or null when members are not sandboxed. */
export const sandboxRuntime = () => runtime;

const DEFAULT_TOOLS_PATH = "/opt/lp-v2-tools/bin:/usr/local/bin:/usr/bin:/bin";

/**
 * Turns the sandbox on for this server process (idempotent): writes the runner, and closes the
 * host's shared directories to other users. Needs root; a server that is not root keeps the
 * sandbox off.
 */
export const configureMemberSandbox = (
  baseDir: string,
  env: NodeJS.ProcessEnv = process.env,
): SandboxRuntime | null => {
  if (!memberSandboxEnabled(env)) return (runtime = null);
  if (runtime !== null && runtime.baseDir === baseDir) return runtime;
  if (process.getuid?.() !== 0) return (runtime = null);
  const nodeDir = NodePath.dirname(process.execPath);
  const toolsPath = `/opt/lp-v2-tools/bin:${nodeDir}:${DEFAULT_TOOLS_PATH.split(":").slice(1).join(":")}`;
  const pick = (name: string, fallback: string) => (env[name] ?? "").trim() || fallback;
  const next: SandboxRuntime = {
    baseDir,
    nodePath: process.execPath,
    toolsPath,
    binaries: {
      claude: pick("LOGICPACKS_MEMBER_CLAUDE_BINARY", "claude"),
      codex: pick("LOGICPACKS_MEMBER_CODEX_BINARY", "codex"),
      opencode: pick("LOGICPACKS_MEMBER_OPENCODE_BINARY", "opencode"),
      gemini: pick("LOGICPACKS_MEMBER_GEMINI_BINARY", "gemini"),
    },
  };
  NodeFS.mkdirSync(NodePath.join(sandboxDir(baseDir), "bin"), { recursive: true, mode: 0o711 });
  NodeFS.chmodSync(sandboxDir(baseDir), 0o711);
  NodeFS.chmodSync(NodePath.join(sandboxDir(baseDir), "bin"), 0o711);
  // Member logins are encrypted at rest; the key is made on first start if none is configured.
  const vault = configureLoginVault(baseDir, { env, generate: true });
  NodeFS.writeFileSync(runnerPath(baseDir), runnerSource(toolsPath, vault?.keyCandidates ?? []), {
    mode: 0o755,
  });
  NodeFS.chmodSync(runnerPath(baseDir), 0o755);
  hardenHostLayout(baseDir);
  // Migration: logins still in plaintext (from before encryption, or left by a killed runner).
  sealAllIdleMemberLogins(baseDir);
  runtime = next;
  return next;
};

const chmodIfExists = (path: string, mode: number) => {
  try {
    NodeFS.chmodSync(path, mode);
  } catch {
    // absent
  }
};

/** Shared host directories: traversable at most, never listable, state and caches root-only. */
export const hardenHostLayout = (baseDir: string) => {
  chmodIfExists(NodePath.join(baseDir, "userdata"), 0o700);
  chmodIfExists(NodePath.join(baseDir, "caches"), 0o700);
  for (const name of ["members", "projects", "worktrees"]) {
    const dir = NodePath.join(baseDir, name);
    NodeFS.mkdirSync(dir, { recursive: true, mode: 0o711 });
    NodeFS.chmodSync(dir, 0o711);
  }
  // Projects and worktrees not shared through a group are nobody else's business.
  const closeOthers = (dir: string) => {
    try {
      const stat = NodeFS.statSync(dir);
      NodeFS.chmodSync(dir, stat.mode & 0o7770);
    } catch {
      // gone
    }
  };
  for (const entry of safeReaddir(NodePath.join(baseDir, "projects"))) {
    closeOthers(NodePath.join(baseDir, "projects", entry));
  }
  for (const repo of safeReaddir(NodePath.join(baseDir, "worktrees"))) {
    const repoDir = NodePath.join(baseDir, "worktrees", repo);
    chmodIfExists(repoDir, 0o711);
    for (const branch of safeReaddir(repoDir)) closeOthers(NodePath.join(repoDir, branch));
  }
};

const safeReaddir = (dir: string) => {
  try {
    return NodeFS.readdirSync(dir);
  } catch {
    return [];
  }
};

const run = (command: string, args: ReadonlyArray<string>) =>
  NodeChildProcess.spawnSync(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });

/** Writes the member's wrapper for one CLI. The server's instance points at it. */
export const ensureMemberWrapper = (
  sandbox: SandboxRuntime,
  digest: string,
  kind: keyof SandboxRuntime["binaries"],
) => {
  const target = wrapperPath(sandbox.baseDir, digest, kind);
  const source = wrapperSource({
    nodePath: sandbox.nodePath,
    baseDir: sandbox.baseDir,
    digest,
    kind,
    binary: resolveOnPath(sandbox.binaries[kind], sandbox.toolsPath),
  });
  let current: string | null = null;
  try {
    current = NodeFS.readFileSync(target, "utf8");
  } catch {
    // new
  }
  if (current !== source) {
    NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true, mode: 0o711 });
    NodeFS.writeFileSync(target, source, { mode: 0o755 });
  }
  return target;
};

const resolveOnPath = (binary: string, searchPath: string) => {
  if (binary.includes("/")) return binary;
  for (const dir of searchPath.split(":")) {
    const candidate = NodePath.join(dir, binary);
    try {
      NodeFS.accessSync(candidate, NodeFS.constants.X_OK);
      return candidate;
    } catch {
      // next
    }
  }
  return binary;
};

const openCodePasswords = new Map<string, string>();
/** One random password per member and server process for their OpenCode server. */
const openCodeServerPassword = (digest: string) => {
  let password = openCodePasswords.get(digest);
  if (password === undefined) {
    password = NodeCrypto.randomBytes(24).toString("base64url");
    openCodePasswords.set(digest, password);
  }
  return password;
};

const KIND_OF_INSTANCE = /^(claude|codex|opencode|gemini)-lp-([0-9a-f]{16})$/;

/**
 * A member instance as it runs under the sandbox: its CLI is the member's wrapper and its
 * provider home sits in the member's own HOME. Other instances pass through unchanged.
 */
export const sandboxInstanceConfig = <I extends { readonly driver: unknown }>(
  instanceId: string,
  instance: I,
  sandbox: SandboxRuntime | null = runtime,
): I => {
  if (sandbox === null || !isMemberInstanceId(instanceId)) return instance;
  const match = KIND_OF_INSTANCE.exec(instanceId);
  if (match === null) return instance;
  const kind = match[1] as keyof SandboxRuntime["binaries"];
  const digest = match[2]!;
  const wrapper = ensureMemberWrapper(sandbox, digest, kind);
  const home = sandboxProviderHome(sandbox.baseDir, digest, kind);
  const fields = instance as { readonly config?: unknown; readonly environment?: unknown };
  const config = { ...((fields.config as Record<string, unknown> | undefined) ?? {}) };
  const environment = [
    ...((fields.environment as
      | ReadonlyArray<{
          readonly name: string;
          readonly value?: unknown;
          readonly sensitive?: boolean;
        }>
      | undefined) ?? []),
  ].filter((entry) => entry.name !== "XDG_DATA_HOME" && entry.name !== "GEMINI_CLI_HOME");
  switch (kind) {
    case "claude":
    case "codex":
      config.binaryPath = wrapper;
      config.homePath = home;
      break;
    case "opencode":
      config.binaryPath = wrapper;
      environment.push({ name: "XDG_DATA_HOME", value: home, sensitive: false });
      // `opencode serve` listens on 127.0.0.1, which every member's user can reach: without a
      // password any member could drive another member's agent (and so act as them).
      if (!environment.some((entry) => entry.name === "OPENCODE_SERVER_PASSWORD")) {
        environment.push({
          name: "OPENCODE_SERVER_PASSWORD",
          value: openCodeServerPassword(digest),
          sensitive: true,
        });
      }
      break;
    case "gemini":
      config.commandPath = wrapper;
      environment.push({ name: "GEMINI_CLI_HOME", value: home, sensitive: false });
      break;
  }
  return { ...instance, config, environment };
};

/**
 * Where a member's login for `provider` lives: in their own HOME under the sandbox (moved there
 * from the state dir on first use), in the state dir otherwise.
 */
export const sandboxedProviderHome = (
  legacyHome: string,
  userId: string,
  provider: string,
): string => {
  if (runtime === null) return legacyHome;
  const home = sandboxProviderHome(runtime.baseDir, sandboxDigest(userId), provider);
  if (!NodeFS.existsSync(home) && NodeFS.existsSync(legacyHome)) {
    NodeFS.mkdirSync(NodePath.dirname(home), { recursive: true, mode: 0o700 });
    NodeFS.cpSync(legacyHome, home, { recursive: true });
    // The old copy must not stay behind in plaintext: shred its credentials, drop the rest,
    // and seal the moved one.
    for (const relative of vaultCredentialFiles(provider)) {
      vaultShred(NodePath.join(legacyHome, relative));
    }
    NodeFS.rmSync(legacyHome, { recursive: true, force: true });
    sealIdleProviderHome(home);
  }
  return home;
};

// ---------------------------------------------------------------------------------------------
// Project groups.

const preparedProjects = new Map<string, string>();
const memberGroups = new Map<string, string>();

const knownUsers = new Set<string>();

const ensureUser = (user: string, home: string) => {
  if (knownUsers.has(user)) return true;
  const ready =
    run("id", ["-u", user]).status === 0 ||
    run("useradd", [
      "--system",
      "--user-group",
      "--no-create-home",
      "--home-dir",
      home,
      "--shell",
      "/usr/sbin/nologin",
      user,
    ]).status === 0;
  if (!ready) return false;
  NodeFS.mkdirSync(home, { recursive: true, mode: 0o711 });
  run("chown", [`${user}:${user}`, home]);
  NodeFS.chmodSync(home, 0o711);
  knownUsers.add(user);
  return true;
};

const ensureGroup = (group: string) =>
  run("getent", ["group", group]).status === 0 || run("groupadd", ["--system", group]).status === 0;

/**
 * A project shared through its group: group-owned, setgid directories, group read/write, git
 * keeping new objects group-writable. Done once per project and server process.
 */
export const prepareProjectGroup = (
  sandbox: SandboxRuntime,
  project: { readonly id: string; readonly root: string },
  worktreesDir: string,
) => {
  const group = projectGroupName(project.id);
  if (preparedProjects.get(project.id) === project.root) return group;
  if (!ensureGroup(group) || !NodeFS.existsSync(project.root)) return null;
  const dirs = [project.root, ...projectWorktrees(project.root, worktreesDir)];
  for (const dir of dirs) {
    run("chgrp", ["-R", group, dir]);
    run("chmod", ["-R", "g+rwX,o-rwx", dir]);
    run("find", [dir, "-type", "d", "-exec", "chmod", "g+s", "{}", "+"]);
  }
  if (NodeFS.existsSync(NodePath.join(project.root, ".git"))) {
    run("git", ["-C", project.root, "config", "core.sharedRepository", "group"]);
  }
  void sandbox;
  preparedProjects.set(project.id, project.root);
  return group;
};

const projectWorktrees = (projectRoot: string, worktreesDir: string) => {
  const found: Array<string> = [];
  const marker = NodePath.join(projectRoot, ".git", "worktrees") + NodePath.sep;
  for (const repo of safeReaddir(worktreesDir)) {
    for (const branch of safeReaddir(NodePath.join(worktreesDir, repo))) {
      const dir = NodePath.join(worktreesDir, repo, branch);
      try {
        const dotGit = NodeFS.readFileSync(NodePath.join(dir, ".git"), "utf8");
        if (dotGit.includes(marker)) found.push(dir);
      } catch {
        // not a worktree
      }
    }
  }
  return found;
};

/**
 * Makes the member's Unix user exist and belong to exactly the groups of the projects they can
 * open. Revoked access drops the group (running processes keep theirs until they exit).
 */
export const syncMemberSandbox = (
  userId: string,
  projects: ReadonlyArray<{ readonly id: string; readonly root: string }>,
  worktreesDir: string,
  sandbox: SandboxRuntime | null = runtime,
) => {
  if (sandbox === null) return;
  const digest = sandboxDigest(userId);
  const user = sandboxUserName(digest);
  const home = sandboxHome(sandbox.baseDir, digest);
  if (!ensureUser(user, home)) return;
  const groups = projects
    .map((project) => prepareProjectGroup(sandbox, project, worktreesDir))
    .filter((group): group is string => group !== null)
    .toSorted();
  const wanted = groups.join(",");
  if (memberGroups.get(user) === wanted) return;
  if (run("usermod", ["-G", wanted, user]).status === 0) memberGroups.set(user, wanted);
};

// ---------------------------------------------------------------------------------------------
// Account deletion (deleteMember.ts): the member's Unix user and project groups go too.

export interface SandboxOsResult {
  /** Done, or nothing to do (already gone). */
  readonly ok: boolean;
  readonly detail: string;
}

/** The Unix side of the sandbox, injectable so tests never touch real users. */
export interface MemberSandboxOs {
  readonly isRoot: () => boolean;
  readonly userExists: (user: string) => boolean;
  readonly groupExists: (group: string) => boolean;
  /** Ends the user's processes, then removes the user and its own group. */
  readonly deleteUser: (user: string) => SandboxOsResult;
  readonly deleteGroup: (group: string) => SandboxOsResult;
}

const SANDBOX_NAME = /^(lpm-[0-9a-f]{16}|lp-p-[0-9a-f]{12})$/;

const outcome = (
  result: NodeChildProcess.SpawnSyncReturns<string>,
  goneCodes: ReadonlyArray<number>,
  what: string,
): SandboxOsResult => {
  if (result.error !== undefined) return { ok: false, detail: `${what}: ${result.error.message}` };
  if (result.status === 0) return { ok: true, detail: `${what}: removed` };
  if (goneCodes.includes(result.status ?? -1)) return { ok: true, detail: `${what}: already gone` };
  return { ok: false, detail: `${what}: exit ${result.status} ${String(result.stderr).trim()}` };
};

export const systemSandboxOs: MemberSandboxOs = {
  isRoot: () => process.getuid?.() === 0,
  userExists: (user) => run("id", ["-u", user]).status === 0,
  groupExists: (group) => run("getent", ["group", group]).status === 0,
  deleteUser: (user) => {
    if (!SANDBOX_NAME.test(user)) return { ok: false, detail: `${user}: not a sandbox user` };
    // userdel refuses while the user has processes; an agent left running must not survive.
    run("pkill", ["-KILL", "-u", user]);
    // 6: no such user.
    const removed = outcome(run("userdel", [user]), [6], `user ${user}`);
    knownUsers.delete(user);
    memberGroups.delete(user);
    if (!removed.ok) return removed;
    // USERGROUPS_ENAB usually takes the user's own group with it; make sure.
    if (run("getent", ["group", user]).status === 0) {
      const group = outcome(run("groupdel", [user]), [6], `group ${user}`);
      if (!group.ok) return group;
    }
    return removed;
  },
  deleteGroup: (group) => {
    if (!SANDBOX_NAME.test(group)) return { ok: false, detail: `${group}: not a sandbox group` };
    // 6: no such group.
    return outcome(run("groupdel", [group]), [6], `group ${group}`);
  },
};

/** Unix users and groups are only touched when the sandbox is on and we are root. */
export const canManageSandboxUsers = (
  env: NodeJS.ProcessEnv = process.env,
  os: MemberSandboxOs = systemSandboxOs,
) => memberSandboxEnabled(env) && os.isRoot();

/** Forgets the in-process group bookkeeping for a deleted project. */
export const forgetPreparedProject = (projectId: string) => {
  preparedProjects.delete(projectId);
};
