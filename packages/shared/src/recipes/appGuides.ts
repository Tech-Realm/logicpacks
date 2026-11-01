/**
 * How agents use an app the host is sharing live ("Any app"). Each guide is the
 * recipe an agent loads when that app is shared in its project: it arrives in
 * the agent's turn context and in `lp app ops`. Blender and DaVinci Resolve have
 * semantic ops; every other app falls back to the "Any app" guide (menus,
 * AppleScript, keys, and screenshot plus click as the last resort).
 */

export interface AppGuide {
  readonly id: "blender" | "resolve" | "any";
  readonly name: string;
  /** Matches the shared window's app name. */
  readonly matches: (appName: string) => boolean;
  readonly summary: string;
  /** Plain steps for an agent, one per line. */
  readonly guide: ReadonlyArray<string>;
}

const COMMON = [
  "Run `lp app ops` first: it lists every op for the shared app with its usage.",
  "Every op lands in the project's action log under your name (for example \"Mira's Claude: blender.move Vase z 1.24\"), so keep ops small and named.",
  "Ops that change the app need the host's grant: on the host they always run; anywhere else the person you work for must hold control (Request control in the shared app). Read-only ops always run.",
  "Never drive the app with raw pixels while a semantic op exists for the job.",
];

export const BLENDER_GUIDE: AppGuide = {
  id: "blender",
  name: "Blender",
  matches: (appName) => /blender/i.test(appName),
  summary:
    "Edit the live Blender scene through the LogicPacks add-on: objects, transforms, renders and snapshots.",
  guide: [
    "Start with `lp app run blender.status`, then `lp app run blender.objects` to see names, types and transforms.",
    "Move, rotate and scale by object name: `lp app run blender.move Vase z 1.24`, `blender.rotate Vase z 45` (degrees), `blender.scale Vase all 1.5`.",
    "Add with `blender.add <cube|plane|uv_sphere|ico_sphere|cylinder|cone|torus|monkey|empty|camera|point_light|sun_light|spot_light|area_light> [name] [x y z]`; remove with `blender.delete <name>`.",
    "Set any simple property with `blender.set <object> <property> <json>`, for example `blender.set Light light.energy 800`.",
    "`blender.render [width]` renders the current camera to a PNG in the project and returns its path. Look at it before you say the scene looks right.",
    "Your first edit in a session takes a snapshot automatically. Take one yourself with `blender.snapshot <name>` before anything risky; `blender.snapshots` lists them and `blender.restore <name>` goes back (it snapshots the current state first).",
    "`blender.python <code>` runs Python inside Blender. Use it only when no op fits, and say what it does in your reply.",
    "Save with `blender.save` when the person asks to keep the work.",
  ],
};

export const RESOLVE_GUIDE: AppGuide = {
  id: "resolve",
  name: "DaVinci Resolve",
  matches: (appName) => /resolve/i.test(appName),
  summary: "Read and mark the timeline through Resolve's scripting API (DaVinci Resolve Studio).",
  guide: [
    "Start with `lp app run resolve.status`. If it says external scripting is unavailable, the host runs the free edition: Resolve only allows external scripts in DaVinci Resolve Studio, with Preferences, System, General, External scripting using set to Local.",
    "With scripting: `resolve.timelines` lists timelines and their tracks, `resolve.marker <frame> <note>` marks a frame, `resolve.page <edit|color|deliver|...>` switches pages.",
    'Without scripting (free edition): use the Any app ops. Menus with `app.menu "DaVinci Resolve" <menu> <item>`, shortcuts with `app.keys "DaVinci Resolve" <combo>`, and `app.screenshot "DaVinci Resolve"` to look. Ask the person before cutting or deleting clips this way.',
    "Snapshots: Resolve keeps project state in its database, not a file. Before a destructive change ask the host to export the project (File, Export Project) or use `app.snapshot` on any media file you are about to overwrite.",
  ],
};

export const ANY_APP_GUIDE: AppGuide = {
  id: "any",
  name: "Any app",
  matches: () => true,
  summary:
    "Work in any shared Mac app through menus, AppleScript and keys, with screenshots to check.",
  guide: [
    "Prefer, in this order: the app's own scripting (`app.script <app> <applescript>`), its menus (`app.menu <app> <menu> <item> [submenu item]`), keyboard shortcuts (`app.keys <app> cmd+s`), typing (`app.type <app> <text>`).",
    "Look before and after with `app.screenshot <app>`; it returns a PNG path you can read.",
    "`app.click <app> <x> <y>` (window coordinates in points) is the last resort, for controls with no menu or shortcut. Take a screenshot first and click the centre of the control.",
    "Before changing a file the app has open, snapshot it with `app.snapshot <file>`; `app.snapshots` and `app.restore <snapshot>` bring it back.",
    "`app.list` shows running apps and their windows; `app.activate <app>` brings one forward.",
  ],
};

export const APP_GUIDES: ReadonlyArray<AppGuide> = [BLENDER_GUIDE, RESOLVE_GUIDE, ANY_APP_GUIDE];

/** The guide for a shared app: its own when there is one, else "Any app". */
export function appGuideFor(appName: string): AppGuide {
  return APP_GUIDES.find((guide) => guide.id !== "any" && guide.matches(appName)) ?? ANY_APP_GUIDE;
}

/** The guide as plain text: what an agent reads in its turn context or `lp app ops`. */
export function renderAppGuide(guide: AppGuide): string {
  return [
    `${guide.name} recipe: ${guide.summary}`,
    ...[...guide.guide, ...COMMON].map((line) => `- ${line}`),
  ].join("\n");
}

/** The block added to an agent's turn while an app is shared in its project. */
export function sharedAppTurnContext(input: {
  readonly appName: string;
  readonly title: string;
  readonly hostName: string;
}): string {
  const guide = appGuideFor(input.appName);
  return [
    "<logicpacks_shared_app>",
    `${input.hostName} is sharing ${input.appName} ("${input.title.slice(0, 80)}") live in this project. People see it and may be working in it right now. Work in it with \`lp app run\` ops, not by editing its files directly.`,
    renderAppGuide(guide),
    "</logicpacks_shared_app>",
  ].join("\n");
}
