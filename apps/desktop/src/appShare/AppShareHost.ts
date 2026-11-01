// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - drives the native lp-appctl helper and Electron's capturer from plain callbacks.
/**
 * The host side of "Share an app" in the desktop app: lists the windows the
 * person can share (Electron's desktopCapturer, which uses ScreenCaptureKit on
 * current macOS), and injects a granted viewer's input into the shared window
 * through the native lp-appctl helper. The renderer captures the chosen window
 * itself (getUserMedia with the source id) and streams it over WebRTC.
 *
 * The kill switch is a global hotkey (Cmd+Shift+Escape while sharing): it tells
 * every window to drop all control at once and lets go of any held button.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

import * as Electron from "electron";

import { APPCTL_SWIFT_SOURCE } from "./appctl.swift.ts";

export const APP_SHARE_KILL_ACCELERATOR = "CommandOrControl+Shift+Escape";

export interface ShareableWindow {
  readonly sourceId: string;
  readonly windowId: number | null;
  readonly app: string;
  readonly title: string;
  readonly pid: number | null;
  readonly width: number;
  readonly height: number;
  readonly thumbnail: string | null;
}

interface AppctlWindow {
  readonly id: number;
  readonly pid: number;
  readonly app: string;
  readonly title: string;
  readonly width: number;
  readonly height: number;
}

let helper: {
  readonly child: NodeChildProcess.ChildProcess;
  readonly pending: Map<number, (reply: Record<string, unknown>) => void>;
} | null = null;
let nextId = 1;

/** The compiled helper: shipped in Resources, or built from source in development. */
function appctlBinary(): string {
  for (const packaged of [
    NodePath.join(process.resourcesPath ?? "", "lp-appctl", "lp-appctl"),
    NodePath.join(process.resourcesPath ?? "", "lp-appctl"),
  ]) {
    if (
      process.resourcesPath &&
      NodeFS.existsSync(packaged) &&
      NodeFS.statSync(packaged).isFile()
    ) {
      return packaged;
    }
  }
  const hash = NodeCrypto.createHash("sha256")
    .update(APPCTL_SWIFT_SOURCE)
    .digest("hex")
    .slice(0, 12);
  const dir = NodePath.join(Electron.app.getPath("userData"), "lp-appctl", hash);
  const binary = NodePath.join(dir, "lp-appctl");
  if (NodeFS.existsSync(binary)) return binary;
  NodeFS.mkdirSync(dir, { recursive: true });
  const source = NodePath.join(dir, "appctl.swift");
  NodeFS.writeFileSync(source, APPCTL_SWIFT_SOURCE);
  NodeChildProcess.execFileSync("/usr/bin/xcrun", ["swiftc", "-O", source, "-o", binary], {
    stdio: "ignore",
    timeout: 180_000,
  });
  return binary;
}

function appctl(): NonNullable<typeof helper> {
  if (helper && helper.child.exitCode === null) return helper;
  const child = NodeChildProcess.spawn(appctlBinary(), [], { stdio: ["pipe", "pipe", "ignore"] });
  const pending = new Map<number, (reply: Record<string, unknown>) => void>();
  NodeReadline.createInterface({ input: child.stdout! }).on("line", (line) => {
    try {
      const reply = JSON.parse(line) as Record<string, unknown>;
      const id = Number(reply["id"]);
      pending.get(id)?.(reply);
      pending.delete(id);
    } catch {
      // Not ours.
    }
  });
  child.on("exit", () => {
    for (const waiter of pending.values()) waiter({ ok: false, reason: "helper_exited" });
    pending.clear();
  });
  helper = { child, pending };
  return helper;
}

function call(cmd: string, body: Record<string, unknown> = {}, timeoutMs = 5000) {
  if (process.platform !== "darwin") {
    return Promise.resolve({ ok: false, reason: "unsupported_platform" } as Record<
      string,
      unknown
    >);
  }
  const { child, pending } = appctl();
  const id = nextId++;
  return new Promise<Record<string, unknown>>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ ok: false, reason: "timeout" });
    }, timeoutMs);
    pending.set(id, (reply) => {
      clearTimeout(timer);
      resolve(reply);
    });
    child.stdin!.write(`${JSON.stringify({ id, cmd, ...body })}\n`);
  });
}

export async function listShareableWindows(): Promise<ShareableWindow[]> {
  const [sources, native] = await Promise.all([
    Electron.desktopCapturer.getSources({
      types: ["window"],
      thumbnailSize: { width: 320, height: 200 },
      fetchWindowIcons: false,
    }),
    call("windows").catch(() => ({ windows: [] }) as Record<string, unknown>),
  ]);
  const byId = new Map(
    ((native["windows"] ?? []) as AppctlWindow[]).map((window) => [window.id, window]),
  );
  const ownPids = new Set(Electron.app.getAppMetrics().map((metric) => metric.pid));
  return (
    sources
      .map((source) => {
        const windowId = Number(/^window:(\d+):/.exec(source.id)?.[1] ?? Number.NaN);
        const window = Number.isFinite(windowId) ? byId.get(windowId) : undefined;
        return {
          sourceId: source.id,
          windowId: Number.isFinite(windowId) ? windowId : null,
          app: window?.app ?? source.name,
          title: window?.title || source.name,
          pid: window?.pid ?? null,
          width: window?.width ?? source.thumbnail.getSize().width,
          height: window?.height ?? source.thumbnail.getSize().height,
          thumbnail: source.thumbnail.isEmpty() ? null : source.thumbnail.toDataURL(),
        } satisfies ShareableWindow;
      })
      // Only real app windows: the helper lists normal-layer windows of a usable size,
      // which drops system overlays. Without the helper, keep what the capturer gave.
      .filter(
        (window) => byId.size === 0 || (window.windowId !== null && byId.has(window.windowId)),
      )
      .filter((window) => window.pid === null || !ownPids.has(window.pid))
  );
}

export function injectInput(windowId: number, ev: unknown) {
  // Creating the hidden display waits for it to come up (up to a few seconds).
  const staging = (ev as { kind?: unknown } | null)?.kind === "stage";
  return call("input", { windowId, ev }, staging ? 12_000 : 5000);
}

export async function appSharePermissions() {
  const native = await call("trust").catch(() => ({}) as Record<string, unknown>);
  return {
    platform: process.platform,
    screen:
      process.platform === "darwin"
        ? Electron.systemPreferences.getMediaAccessStatus("screen")
        : "granted",
    accessibility:
      process.platform === "darwin"
        ? Electron.systemPreferences.isTrustedAccessibilityClient(false)
        : true,
    helperTrusted: native["trusted"] === true,
  };
}

export function requestAccessibility(): boolean {
  if (process.platform !== "darwin") return true;
  return Electron.systemPreferences.isTrustedAccessibilityClient(true);
}

/** While sharing, the kill hotkey is live in every app, not only when LogicPacks is focused. */
export function armKillSwitch(armed: boolean, onKill: () => void) {
  if (!armed) {
    Electron.globalShortcut.unregister(APP_SHARE_KILL_ACCELERATOR);
    return false;
  }
  if (Electron.globalShortcut.isRegistered(APP_SHARE_KILL_ACCELERATOR)) return true;
  return Electron.globalShortcut.register(APP_SHARE_KILL_ACCELERATOR, () => {
    void call("release");
    onKill();
  });
}

export function releaseHeldInput() {
  return call("release");
}
