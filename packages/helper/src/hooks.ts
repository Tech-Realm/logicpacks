import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { asRecord, asString } from "./events.ts";
import { commitFile, readPlanned } from "./fileOps.ts";
import { claudeHome, helperHome, loadConfig, writeJson } from "./store.ts";
import { fetchContext } from "./sync.ts";

export const HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

/** Marks the hooks the helper owns, so reinstalling replaces them and uninstalling finds them. */
const MARKER = "# logicpacks-helper";

export const hookCommand = (lpPath: string, event: HookEvent) =>
  `"${lpPath}" hook ${event} ${MARKER}`;

type HookGroup = {
  matcher?: string;
  hooks: Array<{ type: string; command: string; timeout?: number }>;
};

const isOurs = (group: unknown) =>
  (asRecord(group)?.hooks as Array<unknown> | undefined)?.some((hook) =>
    asString(asRecord(hook)?.command)?.includes(MARKER),
  ) ?? false;

/** Adds the helper's hooks to a Claude Code settings object, keeping everything else as it was. */
export const withHelperHooks = (settings: Record<string, unknown>, lpPath: string | null) => {
  const hooks = { ...asRecord(settings.hooks) };
  for (const event of HOOK_EVENTS) {
    const groups = (Array.isArray(hooks[event]) ? (hooks[event] as Array<unknown>) : []).filter(
      (group) => !isOurs(group),
    );
    if (lpPath !== null) {
      const group: HookGroup = {
        hooks: [{ type: "command", command: hookCommand(lpPath, event), timeout: 10 }],
      };
      if (event === "PostToolUse") group.matcher = "*";
      groups.push(group);
    }
    if (groups.length > 0) hooks[event] = groups;
    else delete hooks[event];
  }
  const next = { ...settings };
  if (Object.keys(hooks).length > 0) next.hooks = hooks;
  else delete next.hooks;
  return next;
};

const settingsFile = () => NodePath.join(claudeHome(), "settings.json");

/** `lpPath: null` removes the hooks. Refuses to touch a settings file it cannot parse. */
export const writeClaudeHooks = (lpPath: string | null) => {
  const file = settingsFile();
  let settings: Record<string, unknown> = {};
  const before = readPlanned(file);
  if (before !== null) {
    const parsed = asRecord(JSON.parse(before));
    if (parsed === null) throw new Error(`${file} is not a JSON object; left it unchanged.`);
    settings = parsed;
  }
  if (before === null && lpPath === null) return file;
  commitFile(file, `${JSON.stringify(withHelperHooks(settings, lpPath), null, 2)}\n`, 0o644);
  return file;
};

export const claudeHooksInstalled = () => {
  try {
    const settings = asRecord(JSON.parse(NodeFS.readFileSync(settingsFile(), "utf8")));
    const hooks = asRecord(settings?.hooks) ?? {};
    return HOOK_EVENTS.every(
      (event) => Array.isArray(hooks[event]) && (hooks[event] as Array<unknown>).some(isOurs),
    );
  } catch {
    return false;
  }
};

const readStdin = async (timeoutMs: number) =>
  new Promise<string>((resolve) => {
    let data = "";
    const timer = setTimeout(() => resolve(data), timeoutMs);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => {
      clearTimeout(timer);
      resolve(data);
    });
  });

/** Syncs in a detached process so a hook never holds up the agent. */
const syncInBackground = (transcript: string) => {
  const script = process.argv[1];
  if (!script) return;
  NodeChildProcess.spawn(
    process.execPath,
    [script, "sync", "--source", "claude", "--file", transcript],
    {
      detached: true,
      stdio: "ignore",
      env: process.env,
    },
  ).unref();
};

const CONTEXT_CACHE_MS = 60_000;

const cachedContext = async (
  sessionId: string,
  load: () => Promise<string | null>,
  fresh: boolean,
) => {
  const file = NodePath.join(helperHome(), "context", `${sessionId.replace(/[^\w.-]/g, "_")}.json`);
  if (!fresh) {
    try {
      const cached = JSON.parse(NodeFS.readFileSync(file, "utf8")) as {
        at: number;
        text: string | null;
      };
      if (Date.now() - cached.at < CONTEXT_CACHE_MS) return cached.text;
    } catch {}
  }
  const text = await load();
  writeJson(file, { at: Date.now(), text });
  return text;
};

/**
 * `lp hook <Event>`, run by Claude Code. It must stay fast and never fail the
 * agent: it starts a background sync and, at session start and on each prompt,
 * hands the agent the project's live context.
 */
export const runHook = async (event: string) => {
  const input = asRecord(JSON.parse((await readStdin(2000)) || "{}")) ?? {};
  const transcript = asString(input.transcript_path);
  const sessionId = asString(input.session_id);
  const cwd = asString(input.cwd);
  const config = loadConfig();
  if (!config.token || config.paused) return;
  if (transcript) syncInBackground(transcript);
  if ((event !== "SessionStart" && event !== "UserPromptSubmit") || !cwd || !sessionId) return;
  const text = await cachedContext(
    sessionId,
    async () => {
      try {
        const context = await fetchContext(config, { cwd, source: "claude", sessionId }, 1800);
        if (context.linked) return context.text ?? null;
        return event === "SessionStart" ? (context.message ?? null) : null;
      } catch {
        return null;
      }
    },
    event === "SessionStart",
  );
  if (text) {
    process.stdout.write(
      `${JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } })}\n`,
    );
  }
};
