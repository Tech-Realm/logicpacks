// @effect-diagnostics nodeBuiltinImport:off - builds a macOS sandbox profile for a launched app from plain code.
/**
 * Moved over from appSandbox.ts (feat/v2-app-light), kept as is, plus the member profile below
 * (`memberSandboxProfile`, `sandboxedMemberLaunch`) that reuses its helpers for terminals and
 * member-run agents.
 *
 * "Hidden + file sandbox" app sharing on macOS: the shared app is started under a
 * Seatbelt profile (sandbox-exec, deprecated by Apple but still working on macOS 26),
 * so it can read and write only:
 *   - the project folder,
 *   - its own bundle (read only) and its own support, cache and saved-state folders,
 *   - a private temp folder (TMPDIR points there),
 *   - system locations every app reads (/System, /usr, /Library, /Applications, ...).
 * Everything else in the home folder (~/.ssh, ~/.claude, ~/.codex, ~/Documents, ~/Desktop,
 * other projects, keychains) and every other volume is refused by the kernel, for the app
 * and every process it starts. Network stays on (Blender's add-ons, the bridge on loopback).
 *
 * Not a VM: the app still runs as the host's user, can use the clipboard and other system
 * services, and sees the process list. It cannot send Apple Events (no scripting Finder or
 * Terminal into opening files for it) and cannot ask Launch Services to start other apps.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

export interface AppSandboxInput {
  /** The project folder: the only user folder the app can read and write. */
  readonly project: string;
  /** The app bundle (".../Blender.app"); readable. */
  readonly appBundle: string;
  /** CFBundleIdentifier, for the app's own cache and saved-state folders. */
  readonly bundleId: string;
  /** Extra read-write folders for the app's own settings (e.g. ~/Library/Application Support/Blender). */
  readonly appDataDirs?: ReadonlyArray<string>;
  /** A private temp folder (created); the app's TMPDIR. */
  readonly tmpDir: string;
  readonly home?: string;
}

/** SBPL string literal. */
const lit = (value: string) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

const real = (path: string) => {
  try {
    return NodeFS.realpathSync(path);
  } catch {
    return NodePath.resolve(path);
  }
};

/** Every parent of a path ("/a/b/c" -> "/", "/a", "/a/b"), for metadata-only reads. */
const ancestors = (path: string) => {
  const out: string[] = [];
  let current = NodePath.dirname(path);
  while (true) {
    out.push(current);
    const parent = NodePath.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return out;
};

const darwinDir = (name: string) => {
  try {
    return real(NodeChildProcess.execFileSync("/usr/bin/getconf", [name], { encoding: "utf8" }).trim());
  } catch {
    return null;
  }
};

/** The Seatbelt profile text. Pure apart from realpath and getconf lookups. */
export function appSandboxProfile(input: AppSandboxInput): string {
  const home = real(input.home ?? NodeOS.homedir());
  const project = real(input.project);
  const bundle = real(input.appBundle);
  const tmp = real(input.tmpDir);
  const cache = darwinDir("DARWIN_USER_CACHE_DIR");
  const userTemp = darwinDir("DARWIN_USER_TEMP_DIR");
  const lib = NodePath.join(home, "Library");
  const readWrite = [
    project,
    tmp,
    ...(input.appDataDirs ?? []).map(real),
    NodePath.join(lib, "Caches", input.bundleId),
    NodePath.join(lib, "Saved Application State", `${input.bundleId}.savedState`),
    NodePath.join(lib, "HTTPStorages", input.bundleId),
    NodePath.join(lib, "WebKit", input.bundleId),
    ...(cache ? [NodePath.join(cache, input.bundleId)] : []),
    ...(userTemp ? [NodePath.join(userTemp, input.bundleId)] : []),
  ];
  const metadata = new Set<string>();
  for (const path of [...readWrite, bundle]) for (const parent of ancestors(path)) metadata.add(parent);
  return [
    "(version 1)",
    "(allow default)",
    ";; Files: nothing of the person's, no other volume, nothing writable outside the allowed folders.",
    `(deny file-read* file-write* (subpath "/Users") (subpath "/Volumes") (subpath "/private/var/folders")${home.startsWith("/Users/") ? "" : ` (subpath ${lit(home)})`})`,
    '(deny file-write* (subpath "/"))',
    '(allow file-write* (literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper") (regex #"^/dev/tty") (regex #"^/dev/fd/"))',
    ";; Reading a folder's entry (not its contents) on the way to an allowed folder.",
    `(allow file-read-metadata ${[...metadata].map((path) => `(literal ${lit(path)})`).join(" ")})`,
    `(allow file-read* (subpath ${lit(bundle)}) (literal ${lit(NodePath.join(home, ".CFUserTextEncoding"))}))`,
    `(allow file-read* file-write* ${readWrite.map((path) => `(subpath ${lit(path)})`).join(" ")})`,
    ";; No scripting other apps (Finder, Terminal) and no starting apps outside the sandbox.",
    "(deny appleevent-send)",
    '(deny mach-lookup (global-name "com.apple.coreservices.launchservicesd.lsopen") (global-name "com.apple.coreservices.quarantine-resolver"))',
    "(deny lsopen)",
    "",
  ].join("\n");
}

export interface SandboxedLaunch {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: Record<string, string>;
  readonly profilePath: string;
}

/** Wraps an app's command line in sandbox-exec with a profile written under `stateDir`. */
export function sandboxLaunch(
  command: string,
  args: ReadonlyArray<string>,
  input: AppSandboxInput & { readonly stateDir: string },
): SandboxedLaunch {
  NodeFS.mkdirSync(input.stateDir, { recursive: true, mode: 0o700 });
  NodeFS.mkdirSync(input.tmpDir, { recursive: true, mode: 0o700 });
  for (const dir of input.appDataDirs ?? []) NodeFS.mkdirSync(dir, { recursive: true });
  const profilePath = NodePath.join(input.stateDir, `${input.bundleId}.sb`);
  NodeFS.writeFileSync(profilePath, appSandboxProfile(input), { mode: 0o600 });
  const tmp = real(input.tmpDir);
  return {
    command: SANDBOX_EXEC,
    args: ["-f", profilePath, command, ...args],
    env: { TMPDIR: `${tmp}/`, LOGICPACKS_SANDBOX: "file" },
    profilePath,
  };
}

/** The .app bundle around an executable path ("/Applications/Blender.app/Contents/MacOS/Blender"). */
export function bundleOf(executable: string): string | null {
  const match = /^(.*?\.app)(\/|$)/.exec(executable);
  return match?.[1] ?? null;
}

export function bundleIdOf(bundle: string): string | null {
  try {
    return (
      NodeChildProcess.execFileSync(
        "/usr/bin/defaults",
        ["read", NodePath.join(bundle, "Contents", "Info"), "CFBundleIdentifier"],
        { encoding: "utf8" },
      ).trim() || null
    );
  } catch {
    return null;
  }
}

/** Whether the app signs itself into Apple's App Sandbox; those refuse a second sandbox. */
export function hasAppSandboxEntitlement(bundle: string): boolean {
  try {
    const out = NodeChildProcess.execFileSync(
      "/usr/bin/codesign",
      ["-d", "--entitlements", "-", "--xml", bundle],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    return /com\.apple\.security\.app-sandbox<\/key>\s*<true\/>/.test(out);
  } catch {
    return false;
  }
}


// ── Members: terminals and agent runs under a folder sandbox ────────────────────────────────

/** Why a sandbox that was required could not be applied. The terminal or turn does not start. */
export class SandboxUnavailableError extends Error {
  override readonly name = "SandboxUnavailableError";
}

export interface MemberSandboxInput {
  /** Read-write folders: the shared folders (a project, or the subfolders the host picked). */
  readonly folders: ReadonlyArray<string>;
  /** Read-only locations the tools need (the agent binary and its runtime). */
  readonly readOnly?: ReadonlyArray<string>;
  /** A private temp folder (TMPDIR). Read-write. */
  readonly tmpDir: string;
  /** The member's own home under the host's members folder: read-write, holds their agent config. */
  readonly memberHome: string;
  readonly home?: string;
}

/** Folders in the person's home that hold credentials; refused even when a shared folder is above them. */
const SENSITIVE_HOME_DIRS = [
  ".ssh",
  ".gnupg",
  ".aws",
  ".config/gh",
  ".config/gcloud",
  ".docker",
  ".kube",
  ".npmrc",
  ".netrc",
  ".claude",
  ".codex",
  ".gemini",
  ".opencode",
  ".cursor",
  ".config/opencode",
  "Library/Keychains",
  "Library/Application Support/Claude",
  "Library/Application Support/Google/Chrome",
  "Library/Safari",
  "Library/Cookies",
  "Library/Messages",
  "Library/Mail",
];

/**
 * The Seatbelt profile for a member's terminal or agent run. Reads and writes are refused
 * everywhere under /Users and /Volumes and the host's temp folders except the shared folders,
 * the member's own home and temp, and the read-only tool locations; the credential folders of the
 * host's user stay refused even inside an allowed parent. Keychain access and scripting other apps
 * are refused. Not a VM: same user, network on, can see processes.
 */
export function memberSandboxProfile(input: MemberSandboxInput): string {
  const home = real(input.home ?? NodeOS.homedir());
  const folders = input.folders.map(real);
  const memberHome = real(input.memberHome);
  const tmp = real(input.tmpDir);
  const readOnly = (input.readOnly ?? []).map(real);
  const readWrite = [...folders, memberHome, tmp];
  const metadata = new Set<string>();
  for (const path of [...readWrite, ...readOnly]) for (const parent of ancestors(path)) metadata.add(parent);
  const sensitive = SENSITIVE_HOME_DIRS.map((dir) => NodePath.join(home, dir));
  return [
    "(version 1)",
    "(allow default)",
    ";; Files: only the shared folders, the member's home and temp, and the tools. No other volume.",
    `(deny file-read* file-write* (subpath "/Users") (subpath "/Volumes") (subpath "/private/var/folders") (subpath "/private/tmp") (subpath "/tmp")${home.startsWith("/Users/") ? "" : ` (subpath ${lit(home)})`})`,
    '(deny file-write* (subpath "/"))',
    '(allow file-write* (literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper") (literal "/dev/tty") (regex #"^/dev/ttys[0-9]+$") (regex #"^/dev/fd/"))',
    ";; Reading a folder's entry (not its contents) on the way to an allowed folder.",
    `(allow file-read-metadata ${[...metadata].map((path) => `(literal ${lit(path)})`).join(" ")})`,
    readOnly.length === 0 ? "" : `(allow file-read* ${readOnly.map((path) => `(subpath ${lit(path)})`).join(" ")})`,
    `(allow file-read* file-write* ${readWrite.map((path) => `(subpath ${lit(path)})`).join(" ")})`,
    ";; The host user's credentials stay refused even under an allowed parent (later rules win).",
    `(deny file-read* file-write* ${sensitive.map((path) => `(subpath ${lit(path)})`).join(" ")})`,
    ";; No keychain, no scripting other apps, no starting apps outside the sandbox.",
    '(deny mach-lookup (global-name "com.apple.SecurityServer") (global-name "com.apple.securityd") (global-name "com.apple.security.agent"))',
    "(deny appleevent-send)",
    ";; `open` reaches Launch Services over these services; without them it cannot start an app (and so",
    ";; cannot start Terminal or any app outside the sandbox). Found by testing: lsopen alone does not stop it.",
    '(deny mach-lookup (global-name-prefix "com.apple.coreservices.") (global-name-prefix "com.apple.lsd."))',
    "(deny lsopen)",
    "",
  ].join("\n");
}

/** Whether this machine can sandbox a member at all (macOS with sandbox-exec). */
export const memberSandboxSupported = (
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = NodeFS.existsSync,
): boolean => platform === "darwin" && exists(SANDBOX_EXEC);

const checkedProfiles = new Set<string>();

/**
 * Wraps a command in the member sandbox, FAIL CLOSED: if the profile cannot be written or the
 * kernel does not accept it (checked by running `true` under it once), this throws and the
 * terminal or turn must not start. There is no unsandboxed fallback here.
 */
export function sandboxedMemberLaunch(
  command: string,
  args: ReadonlyArray<string>,
  input: MemberSandboxInput & { readonly stateDir: string; readonly name: string },
  deps: {
    readonly platform?: NodeJS.Platform;
    readonly exists?: (path: string) => boolean;
    readonly check?: (profile: string) => boolean;
  } = {},
): SandboxedLaunch {
  const platform = deps.platform ?? process.platform;
  const exists = deps.exists ?? NodeFS.existsSync;
  // Test hook: proves, end to end, that a forced failure refuses instead of running unsandboxed.
  if (process.env.LOGICPACKS_TEST_FORCE_SANDBOX_FAILURE === "1") {
    throw new SandboxUnavailableError("The sandbox was forced to fail (test), so nothing was started.");
  }
  if (!memberSandboxSupported(platform, exists)) {
    throw new SandboxUnavailableError(
      "This computer cannot sandbox a member (macOS only), so sandboxed access is unavailable here.",
    );
  }
  let profile: string;
  let profilePath: string;
  try {
    NodeFS.mkdirSync(input.stateDir, { recursive: true, mode: 0o700 });
    NodeFS.mkdirSync(input.tmpDir, { recursive: true, mode: 0o700 });
    NodeFS.mkdirSync(input.memberHome, { recursive: true, mode: 0o700 });
    profile = memberSandboxProfile(input);
    profilePath = NodePath.join(input.stateDir, `${input.name.replace(/[^A-Za-z0-9._-]/g, "_")}.sb`);
    NodeFS.writeFileSync(profilePath, profile, { mode: 0o600 });
  } catch (cause) {
    throw new SandboxUnavailableError(`The sandbox profile could not be prepared: ${String(cause)}`);
  }
  if (!checkedProfiles.has(profile)) {
    const ok =
      deps.check?.(profile) ??
      NodeChildProcess.spawnSync(SANDBOX_EXEC, ["-f", profilePath, "/usr/bin/true"], { stdio: "ignore" })
        .status === 0;
    if (!ok) throw new SandboxUnavailableError("The sandbox did not accept its profile, so nothing was started.");
    checkedProfiles.add(profile);
  }
  const tmp = real(input.tmpDir);
  return {
    command: SANDBOX_EXEC,
    args: ["-f", profilePath, command, ...args],
    env: { TMPDIR: `${tmp}/`, LOGICPACKS_SANDBOX: "member" },
    profilePath,
  };
}

/** Test helper. */
export const clearCheckedSandboxProfiles = () => checkedProfiles.clear();
