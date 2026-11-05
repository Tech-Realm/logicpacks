// @effect-diagnostics nodeBuiltinImport:off -- names the shell's read-only tool folder with plain paths.
import * as NodePath from "node:path";

import { redactDeep } from "./externalTeam.ts";
import { SandboxUnavailableError, sandboxedMemberLaunch } from "./folderSandbox.ts";

/**
 * Who owns each terminal session. A terminal is shared by everyone in its thread and runs as the
 * host's user, so a member may only touch the sessions they opened themselves, and only while
 * their Compute zone is on. The host's own sessions are registered too (owner null), so a member
 * can never attach to one by choosing the same id.
 */
export interface TerminalOwner {
  /** null = the host operator. */
  readonly userId: string | null;
  readonly projectId: string | null;
  readonly threadId: string;
  readonly terminalId: string;
  /** The folders this terminal may read and write when sandboxed: the shared folders (absolute). */
  readonly folders: ReadonlyArray<string>;
  /** Sandboxed (macOS Seatbelt, fail closed) or Unrestricted (a shell as the host's user). */
  readonly mode: "sandboxed" | "unrestricted";
  /** The member's own home and where profiles are kept. */
  readonly memberHome: string | null;
  readonly stateDir: string | null;
  /** Keystrokes of the first line typed, until Enter; null once logged. */
  firstLine: string | null;
}

const owners = new Map<string, TerminalOwner>();

export const terminalKey = (threadId: string, terminalId: string) => `${threadId}\u0000${terminalId}`;

/** The terminal a terminal RPC names, or null when it names none (a thread-wide close). */
export const terminalRef = (
  payload: unknown,
): { readonly threadId: string; readonly terminalId: string | null } | null => {
  if (payload === null || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const threadId = record["threadId"];
  const terminalId = record["terminalId"];
  if (typeof threadId !== "string" || threadId.length === 0) return null;
  return { threadId, terminalId: typeof terminalId === "string" ? terminalId : null };
};

export const ownerOfTerminal = (threadId: string, terminalId: string): TerminalOwner | undefined =>
  owners.get(terminalKey(threadId, terminalId));

export const registerTerminal = (
  owner: Omit<TerminalOwner, "firstLine" | "folders" | "mode" | "memberHome" | "stateDir"> &
    Partial<Pick<TerminalOwner, "folders" | "mode" | "memberHome" | "stateDir">>,
): TerminalOwner => {
  const key = terminalKey(owner.threadId, owner.terminalId);
  const existing = owners.get(key);
  if (existing !== undefined) return existing;
  const created: TerminalOwner = {
    ...owner,
    folders: owner.folders ?? [],
    mode: owner.mode ?? "sandboxed",
    memberHome: owner.memberHome ?? null,
    stateDir: owner.stateDir ?? null,
    firstLine: owner.userId === null ? null : "",
  };
  owners.set(key, created);
  return created;
};

export const forgetTerminal = (threadId: string, terminalId: string | null) => {
  if (terminalId !== null) owners.delete(terminalKey(threadId, terminalId));
  else for (const [key, owner] of owners) if (owner.threadId === threadId) owners.delete(key);
};

export const terminalsOf = (userId: string): ReadonlyArray<TerminalOwner> =>
  Array.from(owners.values()).filter((owner) => owner.userId === userId);

export const allMemberTerminals = (): ReadonlyArray<TerminalOwner> =>
  Array.from(owners.values()).filter((owner) => owner.userId !== null);

/** Test helper. */
export const clearTerminalOwners = () => owners.clear();

/**
 * Feeds typed data to the terminal's first-line capture. Returns the first command line once the
 * person presses Enter, secrets redacted; null before that and after it was returned.
 */
export const captureFirstCommand = (owner: TerminalOwner, data: string): string | null => {
  if (owner.firstLine === null) return null;
  const enter = data.search(/[\r\n]/);
  const next = owner.firstLine + (enter === -1 ? data : data.slice(0, enter));
  // Backspace and escape sequences are not part of a readable line.
  const cleaned = next.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "").replace(/[^\n\r -~]/g, "");
  if (enter === -1) {
    owner.firstLine = cleaned.slice(0, 400);
    return null;
  }
  owner.firstLine = null;
  const line = cleaned.trim();
  return line.length === 0 ? null : (redactDeep(line) as string);
};

/** The environment a member terminal gets: no host tokens, the member's HOME. */
export const memberTerminalEnv = (
  env: NodeJS.ProcessEnv,
  home: string | null,
  platform: NodeJS.Platform,
): NodeJS.ProcessEnv => {
  const keep =
    platform === "win32"
      ? new Set(["SYSTEMROOT", "WINDIR", "COMSPEC", "PATH", "PATHEXT", "TEMP", "TMP", "USERNAME", "TERM"])
      : new Set(["PATH", "LANG", "LANGUAGE", "TERM", "COLORTERM", "TZ", "SHELL", "USER", "LOGNAME", "TMPDIR"]);
  const next: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (keep.has(platform === "win32" ? name.toUpperCase() : name) || name.startsWith("LC_")) {
      next[name] = value;
    }
  }
  if (home !== null) {
    next[platform === "win32" ? "USERPROFILE" : "HOME"] = home;
  }
  return next;
};

/**
 * How a member's terminal is launched: a scrubbed environment and, unless Compute is Unrestricted,
 * the folder sandbox (macOS Seatbelt). FAIL CLOSED: when a sandbox is required and cannot be
 * applied (not macOS, no sandbox-exec, profile refused) the result carries an error and the
 * terminal does not start. Null for the host's own terminals. Unrestricted is a shell as the
 * host's user (the access log says so).
 */
export const memberTerminalLaunch = (input: {
  readonly threadId: string;
  readonly terminalId: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  readonly exists: (path: string) => boolean;
}):
  | {
      readonly command: string;
      readonly args: ReadonlyArray<string>;
      readonly env: NodeJS.ProcessEnv;
      readonly sandboxed: boolean;
    }
  | { readonly error: string }
  | null => {
  const owner = ownerOfTerminal(input.threadId, input.terminalId);
  if (owner === undefined || owner.userId === null) return null;
  const env = memberTerminalEnv(input.env, owner.memberHome, input.platform);
  if (owner.mode === "unrestricted") {
    return { command: input.command, args: input.args, env, sandboxed: false };
  }
  try {
    if (owner.memberHome === null || owner.stateDir === null) {
      throw new SandboxUnavailableError("The sandbox has no member folder to run in.");
    }
    const launch = sandboxedMemberLaunch(
      input.command,
      input.args,
      {
        folders: owner.folders,
        readOnly: [NodePath.dirname(input.command)].filter((dir) => NodePath.isAbsolute(dir)),
        tmpDir: NodePath.join(owner.memberHome, "tmp"),
        memberHome: owner.memberHome,
        stateDir: owner.stateDir,
        name: `terminal-${owner.userId.slice(0, 8)}`,
      },
      { platform: input.platform, exists: input.exists },
    );
    return {
      command: launch.command,
      args: launch.args,
      env: { ...env, ...launch.env },
      sandboxed: true,
    };
  } catch (cause) {
    return {
      error:
        cause instanceof SandboxUnavailableError
          ? cause.message
          : "The sandbox could not be applied, so the terminal was not started.",
    };
  }
};

