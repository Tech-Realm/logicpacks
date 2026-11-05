// oxlint-disable logicpacks/no-global-process-runtime -- plain Node CLI shipped as one file; there is no Effect runtime to inject.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { commitFile, isDryRun, runOrList } from "./fileOps.ts";
import type { SelfLaunch } from "./launcher.ts";
import { helperHome } from "./store.ts";

const LABEL = "io.logicpacks.helper";

const run = (command: string, args: ReadonlyArray<string>) =>
  NodeChildProcess.spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

const xml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const launchAgentFile = () =>
  NodePath.join(NodeOS.homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
/** Windows: a hidden launcher in the user's Startup folder (no admin rights needed). */
const startupFile = () =>
  NodePath.join(
    process.env.APPDATA || NodePath.join(NodeOS.homedir(), "AppData", "Roaming"),
    "Microsoft",
    "Windows",
    "Start Menu",
    "Programs",
    "Startup",
    "logicpacks-helper.vbs",
  );

const systemdUnitFile = () =>
  NodePath.join(NodeOS.homedir(), ".config", "systemd", "user", "logicpacks-helper.service");

/**
 * Keeps `lp watch` running in the background: it tails Codex sessions (Codex has no
 * hooks), catches Claude Code output the hooks missed, and resends queued batches.
 */
export const installWatcher = (launch: SelfLaunch): string => {
  const argv = [launch.command, ...launch.args, "watch"];
  const log = NodePath.join(helperHome(), "watch.log");
  const env = process.env.LP_HELPER_HOME ? { LP_HELPER_HOME: process.env.LP_HELPER_HOME } : {};
  if (process.platform === "darwin") {
    const file = launchAgentFile();
    const envXml = Object.entries(env)
      .map(([key, value]) => `<key>${xml(key)}</key><string>${xml(value)}</string>`)
      .join("");
    commitFile(
      file,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${LABEL}</string>
<key>ProgramArguments</key><array>${argv.map((arg) => `<string>${xml(arg)}</string>`).join("")}</array>
<key>EnvironmentVariables</key><dict>${envXml}</dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ProcessType</key><string>Background</string>
<key>StandardOutPath</key><string>${xml(log)}</string>
<key>StandardErrorPath</key><string>${xml(log)}</string>
</dict></plist>
`,
    );
    const domain = `gui/${process.getuid?.() ?? 501}`;
    const loaded = runOrList(
      `launchctl bootout ${domain}/${LABEL}; launchctl bootstrap ${domain} ${file}`,
      () => {
        run("launchctl", ["bootout", `${domain}/${LABEL}`]);
        return run("launchctl", ["bootstrap", domain, file]);
      },
      { status: 0, stderr: "" } as { status: number | null; stderr: string },
    );
    if (loaded.status !== 0) throw new Error(`launchctl: ${loaded.stderr.trim()}`);
    return `launchd agent ${LABEL}`;
  }
  if (process.platform === "linux" && run("systemctl", ["--user", "--version"]).status === 0) {
    const file = systemdUnitFile();
    const envLines = Object.entries(env)
      .map(([key, value]) => `Environment=${key}=${value}\n`)
      .join("");
    commitFile(
      file,
      `[Unit]\nDescription=LogicPacks helper\n\n[Service]\nExecStart=${argv.map((arg) => `"${arg}"`).join(" ")}\n${envLines}Restart=always\nRestartSec=5\n\n[Install]\nWantedBy=default.target\n`,
    );
    const enabled = runOrList(
      "systemctl --user daemon-reload; systemctl --user enable --now logicpacks-helper.service",
      () => {
        run("systemctl", ["--user", "daemon-reload"]);
        return run("systemctl", ["--user", "enable", "--now", "logicpacks-helper.service"]);
      },
      { status: 0, stderr: "" } as { status: number | null; stderr: string },
    );
    if (enabled.status !== 0) throw new Error(`systemctl: ${enabled.stderr.trim()}`);
    return "systemd user service logicpacks-helper";
  }
  if (process.platform === "win32") {
    const file = startupFile();
    const quote = (value: string) => `""${value}""`;
    const envSet = Object.entries(env)
      .map(([key, value]) => `env("${key}") = "${value}"\r\n`)
      .join("");
    // WScript runs lp with no window; 0 = hidden, False = do not wait.
    commitFile(
      file,
      `Set shell = CreateObject("WScript.Shell")\r\nSet env = shell.Environment("Process")\r\n${envSet}shell.Run "${argv.map(quote).join(" ")}", 0, False\r\n`,
    );
    const started = runOrList(`wscript.exe "${file}"`, () => run("wscript.exe", [file]), {
      status: 0,
      stderr: "",
    } as { status: number | null; stderr: string });
    if (started.status !== 0) throw new Error(`wscript: ${started.stderr.trim()}`);
    return `Startup launcher ${file}`;
  }
  throw new Error("No launchd or systemd here. Run `lp watch` in the background yourself.");
};

/** PowerShell that lists running watchers: lp.exe watch, or node running the older lp.mjs watch. */
const WINDOWS_WATCHERS =
  "Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'lp.exe' -and $_.CommandLine -like '* watch*') -or ($_.Name -eq 'node.exe' -and $_.CommandLine -like '*lp.mjs*watch*') }";

/** Whether a watcher launcher is in place (launchd agent, systemd unit or Startup file). */
export const watcherInstalled = () => {
  const file =
    process.platform === "darwin"
      ? launchAgentFile()
      : process.platform === "linux"
        ? systemdUnitFile()
        : process.platform === "win32"
          ? startupFile()
          : null;
  return file !== null && NodeFS.existsSync(file);
};

export const uninstallWatcher = () => {
  if (process.platform === "darwin") {
    const label = `gui/${process.getuid?.() ?? 501}/${LABEL}`;
    runOrList(`launchctl bootout ${label}`, () => run("launchctl", ["bootout", label]), null);
    commitFile(launchAgentFile(), null);
  } else if (process.platform === "linux") {
    runOrList(
      "systemctl --user disable --now logicpacks-helper.service",
      () => run("systemctl", ["--user", "disable", "--now", "logicpacks-helper.service"]),
      null,
    );
    commitFile(systemdUnitFile(), null);
  } else if (process.platform === "win32") {
    commitFile(startupFile(), null);
    if (isDryRun()) return;
    // Stop the running watcher: lp.exe (or node running the older lp.mjs) with `watch` on its command line.
    run("powershell.exe", [
      "-NoProfile",
      "-Command",
      `${WINDOWS_WATCHERS} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`,
    ]);
  }
};

export const watcherRunning = () => {
  if (process.platform === "darwin") {
    return run("launchctl", ["print", `gui/${process.getuid?.() ?? 501}/${LABEL}`]).status === 0;
  }
  if (process.platform === "linux") {
    return run("systemctl", ["--user", "is-active", "logicpacks-helper.service"]).status === 0;
  }
  if (process.platform === "win32") {
    const found = run("powershell.exe", ["-NoProfile", "-Command", `@(${WINDOWS_WATCHERS}).Count`]);
    return Number(found.stdout.trim()) > 0;
  }
  return false;
};
