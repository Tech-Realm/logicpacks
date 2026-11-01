// oxlint-disable logicpacks/no-global-process-runtime -- plain Node CLI shipped as one file; there is no Effect runtime to inject.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  agentsBlockBody,
  codexMcpInstalled,
  type McpLaunch,
  writeAgentsBlock,
  writeClaudeMcp,
  writeCodexMcp,
} from "./agents.ts";
import { appCommand } from "./app.ts";
import { callHost, gitInfo, OfflineError, RejectedError } from "./client.ts";
import { cloneProject, syncDelayText } from "./clone.ts";
import { installWatcher, uninstallWatcher, watcherRunning } from "./daemon.ts";
import type { SessionSource } from "./events.ts";
import { claudeHooksInstalled, runHook, writeClaudeHooks } from "./hooks.ts";
import {
  CONNECT_COMMANDS,
  defaultContext,
  emit,
  emitError,
  helpAgentsCommand,
  loginCommand,
  parseArgs,
} from "./connect.ts";
import { beginFileSession, describeBackups, describeSession, endFileSession } from "./fileOps.ts";
import { jobsApply, jobsMine, jobsSearch, jobsShow, talentSearch } from "./jobs.ts";
import { runMcpServer } from "./mcp.ts";
import { runUninstall } from "./setup.ts";
import { helperHome, isUnlinked, loadConfig, queuedFiles, saveConfig } from "./store.ts";
import { discoverTranscripts, fetchContext, flushQueue, syncTranscript } from "./sync.ts";

const HELP = `LogicPacks helper (lp): use LogicPacks from any agent harness, no app needed.

  lp login [--host <url>]                    connect to the LogicPacks app on this computer (--cloud or --host <url> for a hosted one)
  lp whoami | lp projects                    who you are, the projects you can open
  lp share | lp invite <email|name>          share this folder, add a teammate or print the invite link
  lp members | lp who [x] | lp agents        who is in the project, working on what, which agents are active
  lp send | lp ask | lp reply | lp inbox     talk to teammates and their agents
  lp assist | lp packs | lp goals            Request assistance, packs, goals (beta)
  lp clone <project> [folder]                clone a project onto this computer and link it
  lp app ops | run <op> [args] | log         work in the apps the host shares (Blender, Resolve, any app)
  lp setup --agent <id>                      add the LogicPacks block to an agent's global instructions
  lp setup-prompt                            the prompt to paste into any agent
  lp help agents                             every command, for agents

  lp status                                  connection, this folder's project, queue
  lp stream --status                         what this folder's sessions send to the project
  lp pause | lp resume                       stop or restart streaming sessions
  lp unlink [folder] | lp link [folder]      keep a folder's sessions private, or share them again
  lp watch | lp install                      stream Claude Code and Codex sessions (hooks, watcher, MCP)
  lp mcp                                     the optional MCP server (stdio)
  lp uninstall                               remove every block, rules file, hook and MCP registration
  lp logout                                  forget this computer's token

Vetted freelancers (invite-only beta):
  lp jobs search [--role <role>] [--skills <a,b>]   open jobs (briefs redacted until you are accepted)
  lp jobs show <id>                           one job's brief
  lp jobs apply <id> --note "..." [--hours N] apply for it
  lp jobs mine                                your applications and accepted jobs
  lp talent search [words] [--role <role>] [--need "..."]   vetted freelancers for your project

Add --json to any agent command for machine-readable output. Guide: https://logicpacks.io/setup.md
`;

const flag = (args: ReadonlyArray<string>, name: string) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? (args[index + 1] ?? null) : null;
};

const say = (line: string) => process.stdout.write(`${line}\n`);

const folderArg = (args: ReadonlyArray<string>) => {
  const given = args.find((arg) => !arg.startsWith("--"));
  const folder = NodePath.resolve(given ?? process.cwd());
  return gitInfo(folder).root ?? folder;
};

const scriptPath = () => NodeFS.realpathSync(process.argv[1] ?? "lp");

/**
 * The launcher hooks call: the installer's wrapper when present, else this script through node.
 * On Windows, Claude Code runs hooks through Git Bash, so the path uses forward slashes and
 * points at the installer's sh wrapper (bin/lp); lp.cmd next to it serves PowerShell and cmd.
 */
const lpCommandPath = () => {
  const wrapper = NodePath.join(helperHome(), "bin", "lp");
  const path = NodeFS.existsSync(wrapper) ? wrapper : scriptPath();
  return process.platform === "win32" ? path.replaceAll("\\", "/") : path;
};

/** How Codex and Claude Code start `lp mcp`. Windows cannot spawn the sh wrapper, so node runs the script. */
const mcpLaunch = (source: SessionSource): McpLaunch => {
  const wrapper = NodePath.join(helperHome(), "bin", "lp");
  return NodeFS.existsSync(wrapper) && process.platform !== "win32"
    ? { command: wrapper, args: ["mcp", "--source", source] }
    : { command: process.execPath, args: [scriptPath(), "mcp", "--source", source] };
};

/** Adds (or with `remove`, takes out) the logicpacks MCP server in Codex and Claude Code. */
const registerMcp = (remove = false) => {
  const lines: Array<string> = [];
  const attempt = (label: string, run: () => string | null) => {
    try {
      const file = run();
      lines.push(
        file === null
          ? `${label}: ${remove ? "nothing to remove" : "already set up"}`
          : `${label}: ${remove ? "removed from" : "registered in"} ${file}`,
      );
    } catch (error) {
      lines.push(`${label}: ${(error as Error).message}`);
    }
  };
  attempt("Codex MCP server", () => writeCodexMcp(remove ? null : mcpLaunch("codex")));
  attempt("Claude Code MCP server", () => writeClaudeMcp(remove ? null : mcpLaunch("claude")));
  return lines;
};

/** Keeps the LogicPacks rules in `folder`/AGENTS.md while the folder belongs to a project. */
const syncAgentsFile = async (folder: string, timeoutMs = 3000) => {
  const config = loadConfig();
  if (!config.server || !config.token || isUnlinked(config, folder)) return null;
  const context = await fetchContext(config, { cwd: folder }, timeoutMs).catch(() => null);
  if (!context?.linked) return null;
  return writeAgentsBlock(folder, agentsBlockBody(context.projectTitle ?? null));
};

const status = async () => {
  const config = loadConfig();
  say(
    `Host:      ${config.server ?? "not connected (open the LogicPacks Mac app, then run lp login)"}`,
  );
  if (config.server && config.token) {
    try {
      const me = await callHost<{ who: string }>(config, "/api/lp/helper/whoami", {
        timeoutMs: 3000,
      });
      say(`Signed in: ${me.who}`);
    } catch (error) {
      say(
        `Signed in: ${error instanceof OfflineError ? "host unreachable, sessions are queued" : (error as Error).message}`,
      );
    }
  }
  say(`Streaming: ${config.paused ? "paused (lp resume)" : "on"}`);
  say(`Queued:    ${queuedFiles().length} batch(es) waiting for the host`);
  say(
    `Hooks:     ${claudeHooksInstalled() ? "Claude Code hooks installed" : "not installed (lp install)"}`,
  );
  say(`Watcher:   ${watcherRunning() ? "running" : "not running (lp install)"}`);
  say(`Codex MCP: ${codexMcpInstalled() ? "registered" : "not registered (lp install)"}`);
  const folder = folderArg([]);
  if (config.unlinked.includes(folder)) {
    say(`This folder: private (lp link to share it)`);
  } else if (config.server && config.token) {
    try {
      const context = await fetchContext(config, { cwd: process.cwd() }, 3000);
      say(
        context.linked
          ? `This folder: streams into "${context.projectTitle}"${context.synced ? " (Synced)" : " (Not synced: teammates cannot work on it while this computer is off)"}`
          : `This folder: ${context.message ?? "not part of a LogicPacks project"}`,
      );
    } catch {}
  }
};

const syncCommand = async (args: ReadonlyArray<string>) => {
  const config = loadConfig();
  if (!config.token) return;
  const file = flag(args, "file");
  if (file) {
    const source = (flag(args, "source") ?? "claude") as SessionSource;
    const outcome = await syncTranscript(NodePath.resolve(file), source, config);
    if (args.includes("--verbose")) say(JSON.stringify(outcome));
    return;
  }
  await flushQueue(config);
  for (const transcript of discoverTranscripts(Date.parse(config.since))) {
    const outcome = await syncTranscript(transcript.file, transcript.source, config);
    if (args.includes("--verbose")) say(`${transcript.file}: ${JSON.stringify(outcome)}`);
  }
};

/** The background loop: tail every transcript that grew, and resend the queue. */
const watch = async (args: ReadonlyArray<string>) => {
  const interval = Number(flag(args, "interval") ?? 2000);
  const seen = new Map<string, number>();
  for (;;) {
    const config = loadConfig();
    if (config.token) {
      await flushQueue(config).catch(() => false);
      for (const transcript of discoverTranscripts(Date.parse(config.since))) {
        if (seen.get(transcript.file) === transcript.size) continue;
        const outcome = await syncTranscript(transcript.file, transcript.source, config).catch(
          (error: Error) => ({ kind: "error", message: error.message }) as const,
        );
        // Unmatched sessions are retried later from the same place, so keep them "unseen".
        if (outcome.kind !== "unmatched" && outcome.kind !== "signed-out") {
          seen.set(transcript.file, transcript.size);
        }
        if (outcome.kind !== "idle" && args.includes("--verbose")) {
          say(
            `${new Date().toISOString()} ${NodePath.basename(transcript.file)} ${JSON.stringify(outcome)}`,
          );
        }
      }
    }
    if (args.includes("--once")) return;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
};

const installSteps = (args: ReadonlyArray<string>, lines: Array<string>) => {
  if (!args.includes("--no-hooks")) {
    lines.push(`Claude Code hooks added to ${writeClaudeHooks(lpCommandPath())}`);
  }
  if (!args.includes("--no-watcher")) {
    try {
      lines.push(`Background watcher: ${installWatcher(scriptPath())}`);
    } catch (error) {
      lines.push((error as Error).message);
    }
  }
  if (!args.includes("--no-mcp")) lines.push(...registerMcp());
};

const uninstallSteps = (args: ReadonlyArray<string>, lines: Array<string>) => {
  lines.push(...runUninstall(flag(args, "agent")));
  if (flag(args, "agent") !== null) return;
  if (!args.includes("--no-hooks")) writeClaudeHooks(null);
  if (!args.includes("--no-watcher")) uninstallWatcher();
  if (!args.includes("--no-mcp")) lines.push(...registerMcp(true));
  lines.push(
    "Removed the LogicPacks blocks, the Claude Code hooks, the background watcher and the MCP server.",
  );
};

const main = async () => {
  const [command = "help", ...args] = process.argv.slice(2);
  switch (command) {
    case "login": {
      const ctx = defaultContext();
      const parsed = parseArgs(["login", ...args]);
      const result = await loginCommand(ctx, parsed).catch((error: unknown) => {
        emitError(ctx, parsed, error);
        return null;
      });
      if (result === null) return;
      // Signing in changes no agent config: hooks, watcher and MCP are `lp install`, shown first.
      emit(ctx, parsed, result);
      return;
    }
    case "logout": {
      const config = loadConfig();
      await callHost(config, "/api/lp/helper/logout", { body: {} }).catch(() => undefined);
      saveConfig({ ...config, token: null, who: null });
      return say("Signed out. Sessions are no longer streamed from this computer.");
    }
    case "status":
      return status();
    case "pause":
    case "resume": {
      saveConfig({ ...loadConfig(), paused: command === "pause" });
      return say(
        command === "pause"
          ? "Paused. New sessions stay on this computer until you run lp resume."
          : "Streaming again.",
      );
    }
    case "unlink":
    case "link": {
      const config = loadConfig();
      const folder = folderArg(args);
      const unlinked = config.unlinked.filter((root) => root !== folder);
      if (command === "unlink") unlinked.push(folder);
      saveConfig({ ...config, unlinked });
      say(
        command === "unlink"
          ? `Sessions in ${folder} stay private now.`
          : `Sessions in ${folder} stream to their LogicPacks project again.`,
      );
      // Only the marked LogicPacks block in AGENTS.md changes; the rest of the file is the team's.
      const agentsFile =
        command === "unlink" ? writeAgentsBlock(folder, null) : await syncAgentsFile(folder);
      if (agentsFile !== null) {
        say(
          `${command === "unlink" ? "Removed" : "Updated"} the LogicPacks block in ${agentsFile}`,
        );
      }
      return;
    }
    case "clone": {
      const [wanted, folderName] = args.filter((arg) => !arg.startsWith("--"));
      if (!wanted) {
        say("Name the project: lp clone <project name, id or owner/repo> [folder]");
        process.exitCode = 1;
        return;
      }
      const config = loadConfig();
      if (!config.server || !config.token) {
        say("Connect this computer first: open the LogicPacks Mac app, then run lp login.");
        process.exitCode = 1;
        return;
      }
      const cloned = await cloneProject({
        config,
        wanted,
        folder: folderName ?? null,
        cwd: process.cwd(),
        say,
      });
      if (cloned === null) {
        process.exitCode = 1;
        return;
      }
      // Linked like lp link: its sessions stream to the project and agents get its context.
      saveConfig({ ...config, unlinked: config.unlinked.filter((root) => root !== cloned.folder) });
      const agentsFile = await syncAgentsFile(cloned.folder).catch(() => null);
      if (agentsFile !== null) say(`Added the LogicPacks block to ${agentsFile}`);
      say(`Ready: cd ${cloned.folder}`);
      say(
        `Commit and git push as usual. The host pulls your pushes ${syncDelayText(cloned.syncSeconds)}, and git pull brings teammates' work here.`,
      );
      say("To show your agent sessions to the team, run lp install once (it starts lp watch).");
      return;
    }
    case "stream": {
      // What this folder's Claude Code and Codex sessions send to the project, and the switches.
      const config = loadConfig();
      const setting = flag(args, "mcp-details");
      const folder = folderArg(args.filter((arg) => arg !== setting));
      if (setting === "on" || setting === "off") {
        const others = (config.mcpDetails ?? []).filter((root) => root !== folder);
        saveConfig({ ...config, mcpDetails: setting === "on" ? [...others, folder] : others });
        return say(
          setting === "on"
            ? `MCP tool calls in ${folder} now stream with their inputs and results (secrets still redacted). lp stream --mcp-details off to go back to names only.`
            : `MCP tool calls in ${folder} stream as names only again.`,
        );
      }
      const fresh = loadConfig();
      const unlinked = isUnlinked(fresh, folder);
      let project = "not part of a LogicPacks project";
      if (fresh.server && fresh.token && !unlinked) {
        const context = await fetchContext(fresh, { cwd: folder }, 3000).catch(() => null);
        if (context?.linked)
          project = `"${context.projectTitle}" (everyone in that project sees it)`;
        else if (context === null) project = "unknown (host unreachable)";
      }
      const mcp = (fresh.mcpDetails ?? []).includes(folder);
      const live = !fresh.paused && !unlinked && project.startsWith('"');
      say(`Folder:    ${folder}`);
      say(`Project:   ${unlinked ? "private (lp link to share it again)" : project}`);
      say(
        `Streaming: ${fresh.paused ? "paused on this computer (lp resume)" : unlinked ? "off for this folder (lp unlink)" : live ? "on" : "nothing (no project)"}`,
      );
      if (live || args.includes("--status")) {
        say("When on, Claude Code and Codex sessions in this folder send:");
        say("  - your prompts and the agent's replies (secrets redacted)");
        say(
          "  - built-in tool calls (commands, edits, reads, searches): input up to 300 characters, result up to 1,500, secrets redacted",
        );
        say(
          mcp
            ? "  - MCP tool calls with inputs and results (opted in: lp stream --mcp-details off)"
            : '  - MCP tool calls as names only, such as "mcp: whatsapp.send" (lp stream --mcp-details on to include details)',
        );
        say("  - never: the content of .env*, *.pem, *.key, id_* or ~/.ssh files");
      }
      say("Stop: lp pause (everything on this computer), lp unlink (just this folder).");
      return;
    }
    case "context": {
      const config = loadConfig();
      const context = await fetchContext(config, {
        cwd: NodePath.resolve(flag(args, "cwd") ?? process.cwd()),
      });
      return say(context.linked ? (context.text ?? "") : (context.message ?? "Not linked."));
    }
    case "install":
    case "uninstall": {
      // Both show the exact diff with --dry-run. install writes only with --yes (or from a
      // terminal), and every changed file is backed up first.
      const dryRun =
        args.includes("--dry-run") ||
        (command === "install" && !args.includes("--yes") && !process.stdout.isTTY);
      const session = beginFileSession(dryRun);
      const lines: Array<string> = [];
      try {
        if (command === "install") installSteps(args, lines);
        else uninstallSteps(args, lines);
      } finally {
        endFileSession();
      }
      if (dryRun) {
        say(`Nothing written yet. This is exactly what lp ${command} would change:\n`);
        say(describeSession(session));
        if (command === "install") {
          say("\nShow this to your user. When they approve, run: lp install --yes");
        }
        return;
      }
      lines.forEach(say);
      const backups = describeBackups(session);
      if (backups) say(backups);
      return;
    }
    case "help":
      if (args[0] === "agents") return say(helpAgentsCommand().text);
      return say(HELP);
    case "mcp": {
      const cwd = NodePath.resolve(flag(args, "cwd") ?? process.cwd());
      const sourceArg = flag(args, "source");
      const source: SessionSource | null =
        sourceArg === "codex" || sourceArg === "claude" ? sourceArg : null;
      return runMcpServer({ cwd, source, sessionId: flag(args, "session") });
    }
    case "agents-md": {
      const folder = folderArg(args);
      const file = await syncAgentsFile(folder, 8000);
      return say(
        file === null
          ? "AGENTS.md is up to date (or this folder is not linked)."
          : `Updated ${file}`,
      );
    }
    case "jobs": {
      const config = loadConfig();
      const [sub = "search", ...rest] = args;
      const positional = rest.filter(
        (arg, index) => !arg.startsWith("--") && !rest[index - 1]?.startsWith("--"),
      );
      switch (sub) {
        case "search":
          return say(
            await jobsSearch(config, { role: flag(rest, "role"), skills: flag(rest, "skills") }),
          );
        case "show":
          if (!positional[0]) return say("Usage: lp jobs show <id>");
          return say(await jobsShow(config, positional[0]));
        case "apply": {
          const note = flag(rest, "note");
          if (!positional[0] || !note)
            return say('Usage: lp jobs apply <id> --note "how you would do it" [--hours N]');
          const hours = flag(rest, "hours");
          return say(
            await jobsApply(config, {
              id: positional[0],
              note,
              hours: hours === null ? null : Number(hours),
            }),
          );
        }
        case "mine":
          return say(await jobsMine(config));
        default:
          return say(HELP);
      }
    }
    case "talent": {
      const config = loadConfig();
      const [, ...rest] = args;
      const words = rest
        .filter((arg, index) => !arg.startsWith("--") && !rest[index - 1]?.startsWith("--"))
        .join(" ");
      return say(
        await talentSearch(config, {
          q: words,
          role: flag(rest, "role"),
          need: flag(rest, "need"),
        }),
      );
    }
    case "hook":
      return runHook(args[0] ?? "").catch(() => undefined);
    case "sync":
      return syncCommand(args);
    case "watch":
      return watch(args);
    case "app":
      return appCommand(args);
    default: {
      const run = CONNECT_COMMANDS[command];
      if (run === undefined) return say(HELP);
      const ctx = defaultContext();
      const parsed = parseArgs([command, ...args]);
      try {
        emit(ctx, parsed, await run(ctx, parsed));
      } catch (error) {
        emitError(ctx, parsed, error);
      }
      return;
    }
  }
};

main().catch((error: unknown) => {
  if (error instanceof RejectedError || error instanceof OfflineError) {
    say(error.message);
  } else {
    say(error instanceof Error ? (error.stack ?? error.message) : String(error));
  }
  process.exitCode = 1;
});
