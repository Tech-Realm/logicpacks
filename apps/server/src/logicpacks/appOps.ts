// @effect-diagnostics nodeBuiltinImport:off globalDate:off - runs app scripting tools (osascript, Blender's bridge, Resolve's Python API) from plain async code.
/**
 * Semantic ops agents use on a shared app, through `lp app run <op> ...` or
 * `POST /api/lp/apps/run`. The order of preference is the app's own API
 * (Blender's bridge add-on, Resolve's scripting API), then the macOS menu bar
 * and AppleScript, and pixel clicks only as a last resort.
 *
 * Arguments are positional strings, the way a CLI passes them:
 * `blender.move Vase z 1.24`, `app.menu Blender File Save`.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { connectBridge, readBridgeInfo } from "../recipes/bridgeClient.ts";
import {
  defaultRecipeSession,
  launchRecipe,
  recipeBridgeRunning,
} from "../recipes/recipeRunner.ts";

export interface AppOpSpec {
  readonly name: string;
  readonly usage: string;
  readonly summary: string;
  /** Changes the app's document or drives its UI: needs the host, or a live control grant. */
  readonly mutates: boolean;
  readonly app: "blender" | "resolve" | "any";
}

export const APP_OPS: ReadonlyArray<AppOpSpec> = [
  // Blender, through the bundled bridge add-on.
  {
    name: "blender.open",
    usage: "blender.open",
    summary: "Open the project's scene in Blender with the LogicPacks bridge loaded.",
    mutates: true,
    app: "blender",
  },
  {
    name: "blender.status",
    usage: "blender.status",
    summary: "Is the bridge up, which file, how many ops logged.",
    mutates: false,
    app: "blender",
  },
  {
    name: "blender.objects",
    usage: "blender.objects",
    summary: "Every object with id, type, location, rotation and scale.",
    mutates: false,
    app: "blender",
  },
  {
    name: "blender.add",
    usage: "blender.add <primitive> [name] [x y z]",
    summary: "Add cube, uv_sphere, cylinder, cone, torus, monkey, plane, empty, camera or a light.",
    mutates: true,
    app: "blender",
  },
  {
    name: "blender.move",
    usage: "blender.move <object> <x|y|z> <value> | blender.move <object> <x> <y> <z>",
    summary: "Set an object's location (one axis or all three).",
    mutates: true,
    app: "blender",
  },
  {
    name: "blender.rotate",
    usage: "blender.rotate <object> <x|y|z> <degrees>",
    summary: "Set an object's rotation on one axis, in degrees.",
    mutates: true,
    app: "blender",
  },
  {
    name: "blender.scale",
    usage: "blender.scale <object> <x|y|z|all> <value>",
    summary: "Set an object's scale.",
    mutates: true,
    app: "blender",
  },
  {
    name: "blender.set",
    usage: "blender.set <object> <property> <json value>",
    summary: "Set a tracked property: name, hide_viewport, light.energy, camera.lens, ...",
    mutates: true,
    app: "blender",
  },
  {
    name: "blender.delete",
    usage: "blender.delete <object>",
    summary: "Remove an object.",
    mutates: true,
    app: "blender",
  },
  {
    name: "blender.python",
    usage: "blender.python <code>",
    summary:
      "Run Blender Python in the open scene; set result to return a value. Edits are logged.",
    mutates: true,
    app: "blender",
  },
  {
    name: "blender.render",
    usage: "blender.render [width]",
    summary: "Render one frame from the scene camera to a PNG.",
    mutates: false,
    app: "blender",
  },
  {
    name: "blender.snapshot",
    usage: "blender.snapshot [name]",
    summary: "Save a copy of the .blend and the op log position.",
    mutates: false,
    app: "blender",
  },
  {
    name: "blender.snapshots",
    usage: "blender.snapshots",
    summary: "List snapshots.",
    mutates: false,
    app: "blender",
  },
  {
    name: "blender.restore",
    usage: "blender.restore <snapshot>",
    summary: "Put every object back as the snapshot had it (logged, undoable).",
    mutates: true,
    app: "blender",
  },
  {
    name: "blender.save",
    usage: "blender.save",
    summary: "Save the scene to its file.",
    mutates: true,
    app: "blender",
  },
  // DaVinci Resolve, through its scripting API (Resolve Studio allows external scripts).
  {
    name: "resolve.status",
    usage: "resolve.status",
    summary: "Is Resolve reachable through its scripting API, which project and timeline.",
    mutates: false,
    app: "resolve",
  },
  {
    name: "resolve.timelines",
    usage: "resolve.timelines",
    summary: "Timelines in the open project, with track and clip counts.",
    mutates: false,
    app: "resolve",
  },
  {
    name: "resolve.marker",
    usage: "resolve.marker <frame> <note>",
    summary: "Add a marker on the current timeline.",
    mutates: true,
    app: "resolve",
  },
  {
    name: "resolve.page",
    usage: "resolve.page <media|cut|edit|fusion|color|fairlight|deliver>",
    summary: "Switch Resolve's page.",
    mutates: true,
    app: "resolve",
  },
  // Any macOS app.
  {
    name: "app.list",
    usage: "app.list",
    summary: "Open apps and their windows.",
    mutates: false,
    app: "any",
  },
  {
    name: "app.activate",
    usage: "app.activate <app>",
    summary: "Bring an app to the front.",
    mutates: true,
    app: "any",
  },
  {
    name: "app.menu",
    usage: "app.menu <app> <menu> <item> [submenu item]",
    summary: "Click a menu bar item through Accessibility (File > Save).",
    mutates: true,
    app: "any",
  },
  {
    name: "app.keys",
    usage: "app.keys <app> <combo>",
    summary: "Press a shortcut in the app, e.g. cmd+s, space, shift+tab.",
    mutates: true,
    app: "any",
  },
  {
    name: "app.type",
    usage: "app.type <app> <text>",
    summary: "Type text into the app's focused field.",
    mutates: true,
    app: "any",
  },
  {
    name: "app.script",
    usage: "app.script <app> <applescript>",
    summary: "Run AppleScript inside tell application <app>.",
    mutates: true,
    app: "any",
  },
  {
    name: "app.screenshot",
    usage: "app.screenshot <app>",
    summary: "Capture the app's front window to a PNG.",
    mutates: false,
    app: "any",
  },
  {
    name: "app.click",
    usage: "app.click <app> <x> <y>",
    summary: "Last resort: click at a point of the window (0..1 each).",
    mutates: true,
    app: "any",
  },
  {
    name: "app.snapshot",
    usage: "app.snapshot <file>",
    summary: "Copy a document into the project's snapshots before editing it.",
    mutates: false,
    app: "any",
  },
  {
    name: "app.snapshots",
    usage: "app.snapshots",
    summary: "List document snapshots.",
    mutates: false,
    app: "any",
  },
  {
    name: "app.restore",
    usage: "app.restore <snapshot>",
    summary: "Copy a snapshot back over its document (the current file is snapshotted first).",
    mutates: true,
    app: "any",
  },
];

export class AppOpError extends Error {
  override readonly name = "AppOpError";
}

export interface AppOpContext {
  readonly root: string;
  readonly actor: { readonly kind: "human" | "agent"; readonly id: string; readonly name: string };
}

export interface AppOpResult {
  readonly result: unknown;
  /** One line for the action log: "Vase z 1.24". */
  readonly detail: string;
  readonly snapshot?: string;
}

const execFile = (
  command: string,
  args: ReadonlyArray<string>,
  options: {
    readonly timeoutMs?: number;
    readonly input?: string;
    readonly env?: NodeJS.ProcessEnv;
  } = {},
) =>
  new Promise<string>((resolve, reject) => {
    const child = NodeChildProcess.execFile(
      command,
      [...args],
      { timeout: options.timeoutMs ?? 20_000, maxBuffer: 16 * 1024 * 1024, env: options.env },
      (error, stdout, stderr) => {
        if (error) {
          reject(new AppOpError((stderr || error.message).toString().trim().slice(0, 600)));
        } else {
          resolve(stdout.toString());
        }
      },
    );
    if (options.input !== undefined) child.stdin?.end(options.input);
  });

const osascript = (script: string, language: "AppleScript" | "JavaScript" = "AppleScript") =>
  execFile("/usr/bin/osascript", ["-l", language, "-e", script]);

const asString = (value: string) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

const need = (args: ReadonlyArray<string>, count: number, usage: string) => {
  if (args.length < count) throw new AppOpError(`Usage: ${usage}`);
};

const num = (value: string | undefined, what: string) => {
  const parsed = Number(value);
  if (value === undefined || !Number.isFinite(parsed))
    throw new AppOpError(`${what} must be a number.`);
  return parsed;
};

const AXES = { x: 0, y: 1, z: 2 } as const;
const axisOf = (value: string | undefined) => {
  const axis = (value ?? "").toLowerCase();
  if (!(axis in AXES)) throw new AppOpError("Axis must be x, y or z.");
  return AXES[axis as keyof typeof AXES];
};

// ── Blender ────────────────────────────────────────────────────────────────

const blenderSession = (root: string) => defaultRecipeSession(root, "blender");

async function blenderCall(
  root: string,
  cmd: string,
  args: Record<string, unknown>,
  actor: AppOpContext["actor"],
) {
  const info = await readBridgeInfo(blenderSession(root));
  if (info === null) {
    throw new AppOpError(
      "Blender is not open with the LogicPacks bridge. Run: lp app run blender.open",
    );
  }
  const bridge = await connectBridge(info, { timeoutMs: 120_000 }).catch(() => {
    throw new AppOpError("Blender's bridge is not answering. Run: lp app run blender.open");
  });
  try {
    return (await bridge.call(cmd, args, {
      kind: actor.kind,
      id: actor.id,
      name: actor.name,
    })) as Record<string, unknown>;
  } finally {
    bridge.close();
  }
}

async function blenderObject(root: string, ref: string, actor: AppOpContext["actor"]) {
  const scene = await blenderCall(root, "list_scene", {}, actor);
  const objects = (scene["objects"] ?? []) as Array<Record<string, unknown>>;
  const found =
    objects.find((object) => object["id"] === ref) ??
    objects.find((object) => object["name"] === ref) ??
    objects.find((object) => String(object["name"]).toLowerCase() === ref.toLowerCase());
  if (!found) {
    throw new AppOpError(
      `No object called ${ref}. In the scene: ${objects.map((o) => o["name"]).join(", ") || "nothing"}.`,
    );
  }
  return found;
}

const round = (value: number) => Math.round(value * 1000) / 1000;

async function runBlender(
  op: string,
  args: ReadonlyArray<string>,
  ctx: AppOpContext,
): Promise<AppOpResult> {
  const { root, actor } = ctx;
  const modify = async (ref: string, props: Record<string, unknown>, detail: string) => {
    const object = await blenderObject(root, ref, actor);
    const result = await blenderCall(root, "modify_object", { id: object["id"], props }, actor);
    return { result, detail: `${object["name"]} ${detail}` };
  };
  switch (op) {
    case "blender.open": {
      const session = blenderSession(root);
      if (await recipeBridgeRunning(session))
        return { result: { alreadyOpen: true }, detail: "already open" };
      const scene = NodePath.join(root, "scene.blend");
      const hasScene = NodeFS.existsSync(scene);
      const outcome = await launchRecipe({
        recipeId: "blender",
        project: root,
        ...(hasScene ? { file: scene } : {}),
        writeMcpConfig: false,
      });
      if (!hasScene) await blenderCall(root, "save", { path: scene }, actor).catch(() => undefined);
      return {
        result: { pid: outcome.pid ?? null, session },
        detail: hasScene ? "scene.blend" : "new scene.blend",
      };
    }
    case "blender.status":
      return { result: await blenderCall(root, "status", {}, actor), detail: "" };
    case "blender.objects": {
      const scene = await blenderCall(root, "list_scene", {}, actor);
      return { result: scene, detail: `${((scene["objects"] ?? []) as unknown[]).length} objects` };
    }
    case "blender.add": {
      need(args, 1, "blender.add <primitive> [name] [x y z]");
      const [primitive, name, x, y, z] = args;
      const location =
        x === undefined ? undefined : [num(x, "x"), num(y ?? "0", "y"), num(z ?? "0", "z")];
      const result = await blenderCall(
        root,
        "add_object",
        { primitive, ...(name ? { name } : {}), ...(location ? { location } : {}) },
        actor,
      );
      return {
        result,
        detail: `${primitive}${name ? ` ${name}` : ""}${location ? ` at ${location.join(" ")}` : ""}`,
      };
    }
    case "blender.move": {
      need(args, 3, "blender.move <object> <x|y|z> <value>");
      const [ref, a, b, c] = args;
      if (/^[xyz]$/i.test(a!)) {
        const object = await blenderObject(root, ref!, actor);
        const location = [...((object["location"] as number[]) ?? [0, 0, 0])];
        location[axisOf(a)] = num(b, "value");
        return modify(ref!, { location }, `${a!.toLowerCase()} ${round(num(b, "value"))}`);
      }
      const location = [num(a, "x"), num(b, "y"), num(c, "z")];
      return modify(ref!, { location }, location.map(round).join(" "));
    }
    case "blender.rotate": {
      need(args, 3, "blender.rotate <object> <x|y|z> <degrees>");
      const [ref, axis, degrees] = args;
      const object = await blenderObject(root, ref!, actor);
      const rotation = [...((object["rotation_euler"] as number[]) ?? [0, 0, 0])];
      rotation[axisOf(axis)] = (num(degrees, "degrees") * Math.PI) / 180;
      return modify(
        ref!,
        { rotation_euler: rotation },
        `${axis!.toLowerCase()} ${round(num(degrees, "degrees"))}°`,
      );
    }
    case "blender.scale": {
      need(args, 3, "blender.scale <object> <x|y|z|all> <value>");
      const [ref, axis, value] = args;
      const object = await blenderObject(root, ref!, actor);
      const scale = [...((object["scale"] as number[]) ?? [1, 1, 1])];
      const amount = num(value, "value");
      if (axis === "all") scale.fill(amount);
      else scale[axisOf(axis)] = amount;
      return modify(ref!, { scale }, `${axis} ${round(amount)}`);
    }
    case "blender.set": {
      need(args, 3, "blender.set <object> <property> <json value>");
      const [ref, property, raw] = args;
      let value: unknown;
      try {
        value = JSON.parse(raw!);
      } catch {
        value = raw;
      }
      return modify(ref!, { [property!]: value }, `${property} ${raw}`);
    }
    case "blender.delete": {
      need(args, 1, "blender.delete <object>");
      const object = await blenderObject(root, args[0]!, actor);
      const result = await blenderCall(root, "delete_object", { id: object["id"] }, actor);
      return { result, detail: String(object["name"]) };
    }
    case "blender.python": {
      need(args, 1, "blender.python <code>");
      const code = args.join(" ");
      const result = await blenderCall(root, "exec", { code }, actor);
      return { result, detail: code.length > 60 ? `${code.slice(0, 57)}...` : code };
    }
    case "blender.render": {
      const width = args[0] === undefined ? 960 : num(args[0], "width");
      const result = await blenderCall(
        root,
        "render",
        { width, name: `render-${Date.now()}` },
        actor,
      );
      return { result, detail: `${width}px to ${NodePath.basename(String(result["path"]))}` };
    }
    case "blender.snapshot": {
      const name = args[0] ?? snapshotName("snap");
      const result = await blenderCall(root, "snapshot", { name }, actor);
      return { result, detail: name, snapshot: name };
    }
    case "blender.snapshots":
      return { result: await blenderCall(root, "list_snapshots", {}, actor), detail: "" };
    case "blender.restore": {
      need(args, 1, "blender.restore <snapshot>");
      // Restoring is an edit too: keep what is there now first.
      const before = snapshotName("before-restore");
      await blenderCall(root, "snapshot", { name: before }, actor);
      const result = await blenderCall(root, "restore", { name: args[0] }, actor);
      return {
        result: { ...result, savedFirst: before },
        detail: `${args[0]} (current state kept as ${before})`,
        snapshot: before,
      };
    }
    case "blender.save":
      return { result: await blenderCall(root, "save", {}, actor), detail: "scene.blend" };
    default:
      throw new AppOpError(`Unknown op ${op}. Run lp app ops.`);
  }
}

export const snapshotName = (prefix: string) =>
  `${prefix}-${new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-")}`;

/** Before an agent's first edit in a while, a Blender snapshot: the way back if it goes wrong. */
const lastAutoSnapshot = new Map<string, number>();
const AUTO_SNAPSHOT_EVERY_MS = 10 * 60_000;

export async function autoSnapshotBeforeAgentEdit(
  op: AppOpSpec,
  ctx: AppOpContext,
): Promise<string | null> {
  if (
    ctx.actor.kind !== "agent" ||
    !op.mutates ||
    op.app !== "blender" ||
    op.name === "blender.open"
  ) {
    return null;
  }
  const key = `${ctx.root}:${ctx.actor.id}`;
  const last = lastAutoSnapshot.get(key) ?? 0;
  if (Date.now() - last < AUTO_SNAPSHOT_EVERY_MS) return null;
  const name = snapshotName("auto");
  await blenderCall(ctx.root, "snapshot", { name }, ctx.actor);
  lastAutoSnapshot.set(key, Date.now());
  return name;
}

// ── DaVinci Resolve ────────────────────────────────────────────────────────

const RESOLVE_API =
  "/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting/Modules";
const RESOLVE_LIB =
  "/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Libraries/Fusion/fusionscript.so";

async function resolvePython(body: string): Promise<unknown> {
  const script = [
    "import json, sys",
    `sys.path.append(${JSON.stringify(RESOLVE_API)})`,
    "import DaVinciResolveScript as d",
    "r = d.scriptapp('Resolve')",
    "if r is None:",
    "    print(json.dumps({'error': 'Resolve did not answer. Open it, set Preferences > System > General > External scripting using to Local. External scripting needs DaVinci Resolve Studio.'}))",
    "    sys.exit(0)",
    "pm = r.GetProjectManager(); p = pm.GetCurrentProject(); tl = p.GetCurrentTimeline() if p else None",
    body,
  ].join("\n");
  const out = await execFile("/usr/bin/python3", ["-c", script], {
    env: {
      ...process.env,
      RESOLVE_SCRIPT_API:
        "/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting",
      RESOLVE_SCRIPT_LIB: RESOLVE_LIB,
      PYTHONPATH: RESOLVE_API,
    },
  });
  const parsed = JSON.parse(out.trim().split("\n").pop() ?? "{}") as Record<string, unknown>;
  if (typeof parsed["error"] === "string") throw new AppOpError(parsed["error"]);
  return parsed;
}

async function runResolve(op: string, args: ReadonlyArray<string>): Promise<AppOpResult> {
  if (!NodeFS.existsSync(NodePath.join(RESOLVE_API, "DaVinciResolveScript.py"))) {
    throw new AppOpError("DaVinci Resolve's scripting modules are not installed on this machine.");
  }
  switch (op) {
    case "resolve.status":
      return {
        result: await resolvePython(
          "print(json.dumps({'version': r.GetVersionString(), 'project': p.GetName() if p else None, 'timeline': tl.GetName() if tl else None, 'page': r.GetCurrentPage()}))",
        ),
        detail: "",
      };
    case "resolve.timelines":
      return {
        result: await resolvePython(
          "out=[]\nfor i in range(1, (p.GetTimelineCount() if p else 0)+1):\n    t=p.GetTimelineByIndex(i)\n    out.append({'name': t.GetName(), 'videoTracks': t.GetTrackCount('video'), 'audioTracks': t.GetTrackCount('audio'), 'start': t.GetStartFrame(), 'end': t.GetEndFrame()})\nprint(json.dumps({'timelines': out}))",
        ),
        detail: "",
      };
    case "resolve.marker": {
      need(args, 2, "resolve.marker <frame> <note>");
      const frame = num(args[0], "frame");
      const note = args.slice(1).join(" ");
      return {
        result: await resolvePython(
          `ok = tl.AddMarker(${Math.round(frame)}, 'Blue', ${JSON.stringify(note.slice(0, 60))}, ${JSON.stringify(note)}, 1) if tl else False\nprint(json.dumps({'ok': bool(ok)}))`,
        ),
        detail: `frame ${frame}: ${note}`,
      };
    }
    case "resolve.page": {
      need(args, 1, "resolve.page <page>");
      return {
        result: await resolvePython(
          `print(json.dumps({'ok': bool(r.OpenPage(${JSON.stringify(args[0])}))}))`,
        ),
        detail: String(args[0]),
      };
    }
    default:
      throw new AppOpError(`Unknown op ${op}. Run lp app ops.`);
  }
}

// ── Any macOS app ──────────────────────────────────────────────────────────

const JXA_WINDOWS = `
ObjC.import('CoreGraphics'); ObjC.import('AppKit');
const raw = ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, 0));
const list = ObjC.deepUnwrap(raw) || [];
const apps = ObjC.deepUnwrap($.NSWorkspace.sharedWorkspace.runningApplications.js.filter(a => a.activationPolicy == 0).map(a => ({ name: a.localizedName.js, pid: a.processIdentifier, bundle: a.bundleIdentifier.js || null, active: a.active })));
JSON.stringify({
  apps,
  windows: list.filter(w => w.kCGWindowLayer === 0).map(w => ({
    id: w.kCGWindowNumber, pid: w.kCGWindowOwnerPID, app: w.kCGWindowOwnerName, title: w.kCGWindowName || null,
    x: w.kCGWindowBounds.X, y: w.kCGWindowBounds.Y, width: w.kCGWindowBounds.Width, height: w.kCGWindowBounds.Height,
  })),
});`;

export interface MacWindow {
  readonly id: number;
  readonly pid: number;
  readonly app: string;
  readonly title: string | null;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export async function listMacWindows(): Promise<{ apps: unknown[]; windows: MacWindow[] }> {
  if (NodeOS.platform() !== "darwin")
    throw new AppOpError("Generic app ops run on macOS hosts for now.");
  return JSON.parse(await osascript(JXA_WINDOWS, "JavaScript")) as {
    apps: unknown[];
    windows: MacWindow[];
  };
}

async function frontWindowOf(app: string): Promise<MacWindow> {
  const { windows } = await listMacWindows();
  const window =
    windows.find((w) => w.app === app && w.width > 50) ??
    windows.find((w) => w.app.toLowerCase() === app.toLowerCase() && w.width > 50);
  if (!window) throw new AppOpError(`No open window of ${app}.`);
  return window;
}

const KEY_CODES: Record<string, number> = {
  return: 36,
  enter: 36,
  tab: 48,
  space: 49,
  delete: 51,
  escape: 53,
  esc: 53,
  left: 123,
  right: 124,
  down: 125,
  up: 126,
  home: 115,
  end: 119,
  pageup: 116,
  pagedown: 121,
  f1: 122,
  f2: 120,
  f3: 99,
  f4: 118,
  f5: 96,
  f6: 97,
  f7: 98,
  f8: 100,
  f9: 101,
  f10: 109,
  f11: 103,
  f12: 111,
};

function keystrokeScript(app: string, combo: string) {
  const parts = combo
    .toLowerCase()
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  const key = parts.pop() ?? "";
  const modifiers = parts
    .map((part) =>
      part === "cmd" || part === "command"
        ? "command down"
        : part === "shift"
          ? "shift down"
          : part === "alt" || part === "option" || part === "opt"
            ? "option down"
            : part === "ctrl" || part === "control"
              ? "control down"
              : null,
    )
    .filter((value) => value !== null);
  const using = modifiers.length > 0 ? ` using {${modifiers.join(", ")}}` : "";
  const press =
    KEY_CODES[key] !== undefined
      ? `key code ${KEY_CODES[key]}${using}`
      : `keystroke ${asString(key)}${using}`;
  return `tell application ${asString(app)} to activate\ndelay 0.15\ntell application "System Events" to ${press}`;
}

function snapshotsRoot(root: string) {
  const dir = NodePath.join(root, ".logicpacks", "apps", "snapshots");
  NodeFS.mkdirSync(dir, { recursive: true });
  return dir;
}

function insideProject(root: string, file: string) {
  const resolved = NodePath.resolve(root, file);
  const relative = NodePath.relative(NodePath.resolve(root), resolved);
  if (relative.startsWith("..") || NodePath.isAbsolute(relative)) {
    throw new AppOpError("Snapshots cover files inside the project folder.");
  }
  if (!NodeFS.existsSync(resolved) || !NodeFS.statSync(resolved).isFile()) {
    throw new AppOpError(`No file ${relative}.`);
  }
  return { resolved, relative };
}

function snapshotFile(root: string, file: string, prefix = "snap") {
  const { resolved, relative } = insideProject(root, file);
  const id = snapshotName(prefix);
  const dir = NodePath.join(snapshotsRoot(root), id);
  NodeFS.mkdirSync(dir, { recursive: true });
  NodeFS.copyFileSync(resolved, NodePath.join(dir, NodePath.basename(resolved)));
  NodeFS.writeFileSync(
    NodePath.join(dir, "snapshot.json"),
    JSON.stringify({ file: relative, at: new Date().toISOString() }),
  );
  return { id, file: relative };
}

async function runAny(
  op: string,
  args: ReadonlyArray<string>,
  ctx: AppOpContext,
): Promise<AppOpResult> {
  const { root } = ctx;
  switch (op) {
    case "app.list": {
      const listing = await listMacWindows();
      return { result: listing, detail: `${listing.windows.length} windows` };
    }
    case "app.activate":
      need(args, 1, "app.activate <app>");
      await execFile("/usr/bin/open", ["-a", args[0]!]);
      return { result: { ok: true }, detail: args[0]! };
    case "app.menu": {
      need(args, 3, "app.menu <app> <menu> <item> [submenu item]");
      const [app, menu, item, sub] = args;
      const target = sub
        ? `menu item ${asString(sub)} of menu 1 of menu item ${asString(item!)} of menu ${asString(menu!)} of menu bar 1`
        : `menu item ${asString(item!)} of menu ${asString(menu!)} of menu bar 1`;
      await osascript(
        `tell application ${asString(app!)} to activate\ndelay 0.15\ntell application "System Events" to tell process ${asString(app!)} to click ${target}`,
      );
      return {
        result: { ok: true },
        detail: `${app}: ${[menu, item, sub].filter(Boolean).join(" > ")}`,
      };
    }
    case "app.keys":
      need(args, 2, "app.keys <app> <combo>");
      await osascript(keystrokeScript(args[0]!, args[1]!));
      return { result: { ok: true }, detail: `${args[0]}: ${args[1]}` };
    case "app.type": {
      need(args, 2, "app.type <app> <text>");
      const text = args.slice(1).join(" ");
      await osascript(
        `tell application ${asString(args[0]!)} to activate\ndelay 0.15\ntell application "System Events" to keystroke ${asString(text)}`,
      );
      return {
        result: { ok: true },
        detail: `${args[0]}: ${text.length > 40 ? `${text.slice(0, 37)}...` : text}`,
      };
    }
    case "app.script": {
      need(args, 2, "app.script <app> <applescript>");
      const body = args.slice(1).join(" ");
      const out = await osascript(`tell application ${asString(args[0]!)}\n${body}\nend tell`);
      return {
        result: { output: out.trim() },
        detail: `${args[0]}: ${body.length > 50 ? `${body.slice(0, 47)}...` : body}`,
      };
    }
    case "app.screenshot": {
      need(args, 1, "app.screenshot <app>");
      const window = await frontWindowOf(args[0]!);
      const dir = NodePath.join(root, ".logicpacks", "apps", "screens");
      NodeFS.mkdirSync(dir, { recursive: true });
      const path = NodePath.join(
        dir,
        `${window.app.replace(/[^A-Za-z0-9-]+/g, "-")}-${Date.now()}.png`,
      );
      await execFile("/usr/sbin/screencapture", ["-x", "-o", `-l${window.id}`, path]);
      return { result: { path, window }, detail: `${window.app} to ${NodePath.basename(path)}` };
    }
    case "app.click": {
      need(args, 3, "app.click <app> <x> <y>");
      const window = await frontWindowOf(args[0]!);
      const x = window.x + Math.min(1, Math.max(0, num(args[1], "x"))) * window.width;
      const y = window.y + Math.min(1, Math.max(0, num(args[2], "y"))) * window.height;
      await execFile("/usr/bin/open", ["-a", window.app]);
      await osascript(
        `ObjC.import('CoreGraphics'); delay(0.15);
const p = $.CGPointMake(${x}, ${y});
for (const t of [$.kCGEventMouseMoved, $.kCGEventLeftMouseDown, $.kCGEventLeftMouseUp]) {
  $.CGEventPost($.kCGHIDEventTap, $.CGEventCreateMouseEvent(null, t, p, $.kCGMouseButtonLeft)); delay(0.03);
}`,
        "JavaScript",
      );
      return {
        result: { ok: true, x, y },
        detail: `${window.app} at ${num(args[1], "x")}, ${num(args[2], "y")}`,
      };
    }
    case "app.snapshot": {
      need(args, 1, "app.snapshot <file>");
      const snap = snapshotFile(root, args[0]!);
      return { result: snap, detail: snap.file, snapshot: snap.id };
    }
    case "app.snapshots": {
      const dir = snapshotsRoot(root);
      const snapshots = NodeFS.readdirSync(dir)
        .filter((name) => NodeFS.existsSync(NodePath.join(dir, name, "snapshot.json")))
        .map((name) => ({
          id: name,
          ...JSON.parse(NodeFS.readFileSync(NodePath.join(dir, name, "snapshot.json"), "utf8")),
        }));
      return { result: { snapshots }, detail: `${snapshots.length} snapshots` };
    }
    case "app.restore": {
      need(args, 1, "app.restore <snapshot>");
      const id = args[0]!.replace(/[^A-Za-z0-9-_]/g, "");
      const dir = NodePath.join(snapshotsRoot(root), id);
      const metaPath = NodePath.join(dir, "snapshot.json");
      if (!NodeFS.existsSync(metaPath)) throw new AppOpError(`No snapshot ${id}.`);
      const meta = JSON.parse(NodeFS.readFileSync(metaPath, "utf8")) as { file: string };
      const kept = snapshotFile(root, meta.file, "before-restore");
      NodeFS.copyFileSync(
        NodePath.join(dir, NodePath.basename(meta.file)),
        NodePath.join(root, meta.file),
      );
      return {
        result: { restored: id, file: meta.file, savedFirst: kept.id },
        detail: `${meta.file} from ${id}`,
        snapshot: kept.id,
      };
    }
    default:
      throw new AppOpError(`Unknown op ${op}. Run lp app ops.`);
  }
}

export function findAppOp(name: string): AppOpSpec | undefined {
  return APP_OPS.find((op) => op.name === name);
}

export async function runAppOp(
  name: string,
  args: ReadonlyArray<string>,
  ctx: AppOpContext,
): Promise<AppOpResult> {
  const spec = findAppOp(name);
  if (!spec) throw new AppOpError(`Unknown op ${name}. Run lp app ops.`);
  if (spec.app === "blender") return runBlender(name, args, ctx);
  if (spec.app === "resolve") return runResolve(name, args);
  return runAny(name, args, ctx);
}
