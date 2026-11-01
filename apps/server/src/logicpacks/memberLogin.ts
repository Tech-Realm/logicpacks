// @effect-diagnostics nodeBuiltinImport:off -- drives CLI logins in a pty or a pipe, as v1 did.
// @effect-diagnostics globalTimers:off -- the login flow paces keystrokes against a live terminal.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

import { readVaultedFile, sealIdleProviderHome } from "./loginVault.ts";
import { sandboxedProviderHome } from "./memberSandbox.ts";

/**
 * Drives each CLI's own login on the host (in a pty or a pipe) and hands the browser only
 * the link and the code. Every login runs in that member's own home under
 * `<stateDir>/logicpacks/members/<user>/`, never the host's account. Ported from v1.
 */

export type MemberLoginProvider = "claude" | "codex" | "gemini" | "opencode";

export const isMemberLoginProvider = (value: unknown): value is MemberLoginProvider =>
  value === "claude" || value === "codex" || value === "gemini" || value === "opencode";

/** Which account an OpenCode device login signs in to. */
export type OpenCodeLoginVia = "copilot" | "chatgpt";

/** Logins that end with a code the person pastes back (the others are device codes). */
export const loginWantsCode = (provider: MemberLoginProvider) =>
  provider === "claude" || provider === "gemini";

/** A user id as a directory name: kept when it is a plain segment, hashed otherwise. */
export const memberDirSegment = (userId: string): string =>
  /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(userId)
    ? userId
    : `u-${NodeCrypto.createHash("sha256").update(userId).digest("hex").slice(0, 32)}`;

/**
 * Where one member's login for one provider lives. Nobody else's is ever handed out. Under the
 * member sandbox it is in the member's own HOME, so their agent (their Unix user) can read it.
 */
export const memberProviderHome = (stateDir: string, userId: string, provider: string) =>
  sandboxedProviderHome(
    NodePath.join(stateDir, "logicpacks", "members", memberDirSegment(userId), provider),
    userId,
    provider,
  );

/** 0700, every time: the home holds a credential that is the account. */
export const ensureMemberProviderHome = (stateDir: string, userId: string, provider: string) => {
  const home = memberProviderHome(stateDir, userId, provider);
  NodeFS.mkdirSync(home, { recursive: true, mode: 0o700 });
  NodeFS.chmodSync(home, 0o700);
  return home;
};

/**
 * What decides "connected" for Codex: the auth.json its login wrote in this member's
 * CODEX_HOME. Asked of the filesystem, not of the CLI.
 */
export const isCodexHomeConnected = (home: string) => {
  try {
    const parsed = JSON.parse(String(readVaultedFile(home, "auth.json") ?? "")) as {
      readonly tokens?: unknown;
      readonly OPENAI_API_KEY?: unknown;
    };
    return (
      (parsed.tokens !== null && typeof parsed.tokens === "object") ||
      (typeof parsed.OPENAI_API_KEY === "string" && parsed.OPENAI_API_KEY.length > 0)
    );
  } catch {
    return false;
  }
};

const readJson = (path: string): unknown => {
  try {
    return JSON.parse(NodeFS.readFileSync(path, "utf8"));
  } catch {
    return null;
  }
};

/** Gemini CLI's Google login: the OAuth credentials it caches under GEMINI_CLI_HOME. */
export const geminiCredsPath = (home: string) => NodePath.join(home, ".gemini", "oauth_creds.json");

/** A credential file's JSON, sealed or not. */
const readVaultedJson = (home: string, relative: string): unknown => {
  try {
    return JSON.parse(String(readVaultedFile(home, relative) ?? ""));
  } catch {
    return null;
  }
};

export const isGeminiHomeConnected = (home: string) => {
  const parsed = readVaultedJson(home, NodePath.join(".gemini", "oauth_creds.json")) as {
    readonly refresh_token?: unknown;
    readonly access_token?: unknown;
  } | null;
  return (
    parsed !== null &&
    (typeof parsed.refresh_token === "string" || typeof parsed.access_token === "string")
  );
};

/**
 * Sets Gemini CLI's auth type to Google login before it starts, so the interactive CLI goes
 * straight to the sign-in link instead of its auth picker. Other settings are kept.
 */
export const preferGeminiGoogleLogin = (home: string) => {
  const dir = NodePath.join(home, ".gemini");
  NodeFS.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = NodePath.join(dir, "settings.json");
  const current = (readJson(path) ?? {}) as Record<string, unknown>;
  const security = (current.security ?? {}) as Record<string, unknown>;
  const auth = (security.auth ?? {}) as Record<string, unknown>;
  NodeFS.writeFileSync(
    path,
    `${JSON.stringify({ ...current, security: { ...security, auth: { ...auth, selectedType: "oauth-personal" } } }, null, 2)}\n`,
    { mode: 0o600 },
  );
};

/** OpenCode keeps credentials in `$XDG_DATA_HOME/opencode/auth.json`; the member's home is that. */
export const openCodeAuthPath = (home: string) => NodePath.join(home, "opencode", "auth.json");

export const isOpenCodeHomeConnected = (home: string) => {
  const parsed = readVaultedJson(home, NodePath.join("opencode", "auth.json"));
  return (
    parsed !== null &&
    typeof parsed === "object" &&
    Object.values(parsed as Record<string, unknown>).some(
      (entry) => entry !== null && typeof entry === "object",
    )
  );
};

/** Whether the login for `provider` left a usable credential in the member's home. */
export const isLoginHomeConnected = (provider: MemberLoginProvider, home: string) =>
  provider === "codex"
    ? isCodexHomeConnected(home)
    : provider === "gemini"
      ? isGeminiHomeConnected(home)
      : provider === "opencode"
        ? isOpenCodeHomeConnected(home)
        : false;

// ── Reading a terminal ─────────────────────────────────────────────────────

/** Terminal colour and cursor noise, so the page can show plain words. */
export const stripAnsi = (value: string): string =>
  value.replace(/\u001b\[[0-9;?]*[A-Za-z]|\u001b\][^\u0007]*\u0007/g, "");

const URL_PATTERN = /https:\/\/[^\s"'<>]+/g;
/** Codex prints `U8X6-IJJIR`; the shape is stable enough to find it. */
const CODE_PATTERN = /\b[A-Z0-9]{4}-[A-Z0-9]{4,6}\b/;

/**
 * Rejoins a link the terminal broke across lines. A full-screen interface wraps at the
 * terminal width, so a long URL arrives split, and each piece alone is a broken link.
 */
export const unwrapUrls = (text: string): string =>
  text.replace(/(https:\/\/[^\s"'<>]*)\r?\n(?=[^\s"'<>]+)/g, "$1");

/** The sign-in link and device code in what a login printed so far. */
export const parseLoginOutput = (
  raw: string,
  /** Only a full-screen terminal wraps links; a pipe's line breaks are real. */
  unwrap = true,
): { readonly url: string | null; readonly code: string | null } => {
  const clean = unwrap ? unwrapUrls(stripAnsi(raw)) : stripAnsi(raw);
  const found = clean.match(URL_PATTERN);
  // Longest wins rather than last: if a fragment slips through, the whole link is longer.
  const url =
    found && found.length > 0
      ? (found.toSorted((left, right) => right.length - left.length)[0] ?? null)
      : null;
  return { url, code: CODE_PATTERN.exec(clean)?.[0] ?? null };
};

/**
 * Anything that looks like a credential, hidden before it can be shown. `claude
 * setup-token` prints a year-long token; echoing the terminal verbatim once published
 * one onto a page. Nothing that comes back from a command is shown raw again.
 */
const SECRET_PATTERNS = [/sk-ant-[A-Za-z0-9_-]+/g, /sk-[A-Za-z0-9_-]{20,}/g];
export const redactSecrets = (text: string): string =>
  SECRET_PATTERNS.reduce((carried, pattern) => carried.replace(pattern, "«token hidden»"), text);

const CLAUDE_TOKEN_PATTERN = /sk-ant-[A-Za-z0-9_-]+/;

/**
 * The token out of the terminal. Read with whitespace left in: squeezing it out first
 * glued the next sentence onto the token ("…Storethistokensecurely"), and the provider
 * rejected it. The terminal is wide enough that the token is never wrapped.
 */
export const findClaudeToken = (raw: string): string | null =>
  CLAUDE_TOKEN_PATTERN.exec(stripAnsi(raw))?.[0] ?? null;

/** Collapses a redrawn terminal into something a person can read, secrets hidden. */
export const readableOutput = (raw: string): string =>
  redactSecrets(stripAnsi(raw))
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .filter((line) => line.trim().length > 0)
    .join("\n");

const FAILURE_PATTERN = /(error|invalid|failed|expired|try again|retry)/i;
const SUCCESS_PATTERN =
  /(success|succeeded|logged in|signed in|token (created|saved)|you can now)/i;

export const classifyAnswer = (fresh: string): "accepted" | "failed" | "unknown" =>
  SUCCESS_PATTERN.test(fresh) ? "accepted" : FAILURE_PATTERN.test(fresh) ? "failed" : "unknown";

// ── Runs ───────────────────────────────────────────────────────────────────

export interface LoginRun {
  readonly provider: MemberLoginProvider;
  readonly userId: string;
  /** Unique per start, so a code typed against a replaced login is refused. */
  readonly loginId: string;
  readonly home: string;
  output: string;
  url: string | null;
  code: string | null;
  done: boolean;
  exitCode: number | null;
  write: (text: string) => void;
  stop: () => void;
}

export interface LoginSpawner {
  /** Claude's prompt only renders on a real terminal, so it runs in a pty. */
  readonly pty: (
    command: string,
    args: ReadonlyArray<string>,
    env: Record<string, string>,
    on: { data: (chunk: string) => void; exit: (code: number | null) => void },
    cwd?: string,
  ) => { write: (text: string) => void; kill: () => void };
  readonly pipe: (
    command: string,
    args: ReadonlyArray<string>,
    env: Record<string, string>,
    on: { data: (chunk: string) => void; exit: (code: number | null) => void },
  ) => { write: (text: string) => void; kill: () => void };
}

const requireForPty = NodeModule.createRequire(import.meta.url);

export const nodeSpawner: LoginSpawner = {
  pty: (command, args, env, on, cwd) => {
    const pty = requireForPty("node-pty") as typeof import("node-pty");
    const session = pty.spawn(command, [...args], {
      ...(cwd === undefined ? {} : { cwd }),
      name: "xterm-256color",
      // Wide on purpose: the interface hard-wraps at the terminal width, and a wrapped
      // link is a broken link (v1 once handed out a URL cut off before redirect_uri).
      cols: 1000,
      rows: 50,
      env: { ...process.env, ...env, TERM: "xterm-256color" } as Record<string, string>,
    });
    session.onData(on.data);
    session.onExit(({ exitCode }) => on.exit(exitCode));
    return { write: (text) => session.write(text), kill: () => session.kill() };
  },
  pipe: (command, args, env, on) => {
    const child = NodeChildProcess.spawn(command, [...args], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    child.stdout.on("data", (chunk) => on.data(String(chunk)));
    child.stderr.on("data", (chunk) => on.data(String(chunk)));
    child.once("close", (code) => on.exit(code));
    child.once("error", (error) => {
      on.data(`\n${String(error)}`);
      on.exit(-1);
    });
    return {
      write: (text) => {
        child.stdin.write(text);
      },
      kill: () => {
        child.kill("SIGTERM");
      },
    };
  },
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One login at a time per person per provider. Keyed by user as well as provider:
 * keyed by provider alone, a second person starting a login would kill the first
 * person's and then be handed their result.
 */
export interface LoginBinaries {
  readonly claude: string;
  readonly codex: string;
  readonly gemini: string;
  readonly opencode: string;
}

const DEFAULT_LOGIN_BINARIES: LoginBinaries = {
  claude: "claude",
  codex: "codex",
  gemini: "gemini",
  opencode: "opencode",
};

/** OpenCode's provider picker, answered for the person: GitHub.com, not Enterprise. */
const OPENCODE_DEPLOYMENT_PROMPT = /Select GitHub deployment type/;

export class MemberLogins {
  private readonly runs = new Map<string, LoginRun>();
  private readonly stateDir: string;
  private readonly spawner: LoginSpawner;
  private readonly binaries: LoginBinaries;
  private readonly timing: { readonly pollMs: number; readonly typeMs: number };

  constructor(
    stateDir: string,
    spawner: LoginSpawner = nodeSpawner,
    binaries: Partial<LoginBinaries> = {},
    timing: { readonly pollMs: number; readonly typeMs: number } = { pollMs: 400, typeMs: 60 },
  ) {
    this.stateDir = stateDir;
    this.spawner = spawner;
    this.binaries = { ...DEFAULT_LOGIN_BINARIES, ...binaries };
    this.timing = timing;
  }

  private key(userId: string, provider: MemberLoginProvider) {
    return `${userId} ${provider}`;
  }

  current(userId: string, provider: MemberLoginProvider): LoginRun | undefined {
    return this.runs.get(this.key(userId, provider));
  }

  /** Starts a login, abandoning this person's earlier one for the same provider. */
  start(
    userId: string,
    provider: MemberLoginProvider,
    options: { readonly via?: OpenCodeLoginVia } = {},
  ): LoginRun {
    const key = this.key(userId, provider);
    const existing = this.runs.get(key);
    if (existing && !existing.done) existing.stop();
    const home = ensureMemberProviderHome(this.stateDir, userId, provider);
    const run: LoginRun = {
      provider,
      userId,
      loginId: NodeCrypto.randomUUID(),
      home,
      output: "",
      url: null,
      code: null,
      done: false,
      exitCode: null,
      write: () => {},
      stop: () => {},
    };
    let answeredDeployment = false;
    const on = {
      data: (chunk: string) => {
        run.output = `${run.output}${chunk}`.slice(-20_000);
        // Only Claude's full-screen prompt wraps links; elsewhere a line break is real, and
        // rejoining would glue OpenCode's box-drawing border onto the link.
        const parsed = parseLoginOutput(run.output, provider === "claude");
        run.url ??= parsed.url;
        run.code ??= parsed.code;
        if (
          provider === "opencode" &&
          !answeredDeployment &&
          OPENCODE_DEPLOYMENT_PROMPT.test(stripAnsi(run.output))
        ) {
          answeredDeployment = true;
          // The picker is drawn, so it is already listening: Enter picks GitHub.com.
          run.write("\r");
        }
      },
      exit: (code: number | null) => {
        run.done = true;
        run.exitCode = code;
      },
    };
    // Claude's token never touches the filesystem here; it is captured from the output.
    // Its config dir is still the member's, so nothing it writes lands on the host's.
    const handle = this.spawn(provider, home, on, options.via ?? "copilot");
    run.write = handle.write;
    run.stop = handle.kill;
    this.runs.set(key, run);
    return run;
  }

  private spawn(
    provider: MemberLoginProvider,
    home: string,
    on: { data: (chunk: string) => void; exit: (code: number | null) => void },
    via: OpenCodeLoginVia,
  ) {
    switch (provider) {
      case "claude":
        return this.spawner.pty(
          this.binaries.claude,
          ["setup-token"],
          { CLAUDE_CONFIG_DIR: home },
          on,
        );
      case "codex":
        return this.spawner.pipe(
          this.binaries.codex,
          ["login", "--device-auth"],
          { CODEX_HOME: home },
          on,
        );
      case "gemini":
        // Gemini CLI has no login subcommand: its interactive mode signs in on first start.
        // NO_BROWSER makes it print the Google link and wait for the code instead of opening
        // a browser on the host. Interactive needs a terminal; `-p` refuses to sign in.
        preferGeminiGoogleLogin(home);
        return this.spawner.pty(
          this.binaries.gemini,
          [],
          { GEMINI_CLI_HOME: home, NO_BROWSER: "true" },
          on,
          home,
        );
      case "opencode":
        // A device login: the link and a code, approved in the browser, nothing typed back.
        return this.spawner.pty(
          this.binaries.opencode,
          via === "chatgpt"
            ? ["auth", "login", "-p", "openai", "-m", "ChatGPT Pro/Plus (headless)"]
            : ["auth", "login", "-p", "github-copilot"],
          { XDG_DATA_HOME: home },
          on,
          home,
        );
    }
  }

  /** Waits briefly for the command to print the link (and, for device logins, the code). */
  async waitForPrompt(run: LoginRun, attempts = 40): Promise<void> {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (run.done) return;
      if (run.url !== null && (loginWantsCode(run.provider) || run.code !== null)) return;
      await sleep(this.timing.pollMs);
    }
  }

  /**
   * Types the code in the way a keyboard would: the interface redraws on each key, so a
   * hundred characters and a return in one write outrun it and the return is swallowed.
   */
  async typeCode(run: LoginRun, text: string): Promise<void> {
    const size = 24;
    for (let at = 0; at < text.length; at += size) {
      run.write(text.slice(at, at + size));
      await sleep(this.timing.typeMs);
    }
    await sleep(this.timing.typeMs * 10);
    run.write("\r");
  }

  /** Waits for the interface to answer the code, rather than for a fixed delay. */
  async waitForAnswer(run: LoginRun, before: string, attempts = 50) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      await sleep(this.timing.pollMs);
      const answer = classifyAnswer(readableOutput(run.output.slice(before.length)));
      if (answer !== "unknown") return answer;
      if (run.done) return "unknown" as const;
    }
    return "unknown" as const;
  }

  /** Waits for the login to leave a credential in the member's home. */
  async waitForConnected(run: LoginRun, attempts = 50): Promise<boolean> {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (isLoginHomeConnected(run.provider, run.home)) return this.sealed(run);
      if (run.done) return isLoginHomeConnected(run.provider, run.home) && this.sealed(run);
      await sleep(this.timing.pollMs);
    }
    return false;
  }

  /** A finished login is encrypted at rest right away (when a login key is configured). */
  private sealed(run: LoginRun): true {
    // Anything the login CLI writes after this stays plaintext until the member's next agent
    // run (which seals on exit) or the next server start.
    sealIdleProviderHome(run.home);
    return true;
  }

  cancel(userId: string, provider: MemberLoginProvider): boolean {
    const run = this.runs.get(this.key(userId, provider));
    if (run === undefined) return false;
    if (!run.done) run.stop();
    this.runs.delete(this.key(userId, provider));
    return true;
  }
}

/** What the browser is shown about a run: never the raw terminal, never a token. */
export const publicRun = (run: LoginRun) => ({
  provider: run.provider,
  loginId: run.loginId,
  url: run.url,
  code: run.code,
  wantsCode: loginWantsCode(run.provider),
  done: run.done,
  exitCode: run.exitCode,
  output: readableOutput(run.output).slice(-2_000),
});
