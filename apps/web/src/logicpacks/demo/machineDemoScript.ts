// The scripted story behind /demo/machine, the coming-soon "any app" demo. Everything here is
// plain data plus pure functions of the playhead time, so a given time always renders the same
// frame: the demo can be recorded, scrubbed, and tested deterministically.

export type DemoAppId = "blender" | "resolve" | "browser" | "code";

export type DemoActorId = "mira" | "miraAgent" | "omar" | "omarAgent" | "ana" | "anaAgent";

export interface DemoActor {
  readonly id: DemoActorId;
  readonly name: string;
  readonly short: string;
  readonly kind: "human" | "agent";
  /** The human an agent works for; a human points at itself. */
  readonly person: "mira" | "omar" | "ana";
  readonly color: string;
}

const PERSON_COLOR = { mira: "#f0719b", omar: "#f5a524", ana: "#38bdf8" } as const;

export const DEMO_ACTORS: Record<DemoActorId, DemoActor> = {
  mira: {
    id: "mira",
    name: "Mira",
    short: "M",
    kind: "human",
    person: "mira",
    color: PERSON_COLOR.mira,
  },
  miraAgent: {
    id: "miraAgent",
    name: "Mira's agent",
    short: "M",
    kind: "agent",
    person: "mira",
    color: PERSON_COLOR.mira,
  },
  omar: {
    id: "omar",
    name: "Omar",
    short: "O",
    kind: "human",
    person: "omar",
    color: PERSON_COLOR.omar,
  },
  omarAgent: {
    id: "omarAgent",
    name: "Omar's agent",
    short: "O",
    kind: "agent",
    person: "omar",
    color: PERSON_COLOR.omar,
  },
  ana: {
    id: "ana",
    name: "Ana",
    short: "A",
    kind: "human",
    person: "ana",
    color: PERSON_COLOR.ana,
  },
  anaAgent: {
    id: "anaAgent",
    name: "Ana's agent",
    short: "A",
    kind: "agent",
    person: "ana",
    color: PERSON_COLOR.ana,
  },
};

export const DEMO_PEOPLE = ["mira", "omar", "ana"] as const;

export const DEMO_DURATION_MS = 72_000;

export interface DemoAppMeta {
  readonly id: DemoAppId;
  readonly app: string;
  readonly windowTitle: string;
  readonly recipe: string;
  readonly contextTitle: string;
}

export const DEMO_APPS: Record<DemoAppId, DemoAppMeta> = {
  blender: {
    id: "blender",
    app: "Blender",
    windowTitle: "studio.blend",
    recipe: "Blender",
    contextTitle: "Scene outliner",
  },
  resolve: {
    id: "resolve",
    app: "DaVinci Resolve",
    windowTitle: "Launch Film",
    recipe: "DaVinci Resolve",
    contextTitle: "Bins and timeline",
  },
  browser: {
    id: "browser",
    app: "Browser",
    windowTitle: "2 tabs",
    recipe: "Browser",
    contextTitle: "Tabs",
  },
  code: {
    id: "code",
    app: "LogicPacks IDE",
    windowTitle: "render-farm",
    recipe: "Code",
    contextTitle: "Files",
  },
};

export const DEMO_APP_ORDER: readonly DemoAppId[] = ["blender", "resolve", "browser", "code"];

/** Which live view a window shows. Images are real captures of the apps on a Mac. */
export type DemoView =
  | "blender"
  | "blenderMerged"
  | "resolveEdit"
  | "resolveCut"
  | "browserDocs"
  | "browserReference"
  | "code";

export interface DemoChapter {
  readonly t: number;
  readonly label: string;
}

export const DEMO_CHAPTERS: readonly DemoChapter[] = [
  { t: 0, label: "Live in Blender" },
  { t: 16_000, label: "Snapshot" },
  { t: 22_000, label: "Resolve" },
  { t: 34_000, label: "Browser" },
  { t: 41_000, label: "Merge back" },
  { t: 46_500, label: "Conflict" },
  { t: 58_000, label: "Code" },
  { t: 66_000, label: "Everyone" },
];

/** The app the shared workspace shows, by time. */
const FOCUS: readonly { readonly t: number; readonly app: DemoAppId }[] = [
  { t: 0, app: "blender" },
  { t: 22_000, app: "resolve" },
  { t: 34_000, app: "browser" },
  { t: 41_000, app: "blender" },
  { t: 58_000, app: "code" },
  { t: 66_000, app: "blender" },
];

export const MERGE_START_MS = 41_000;
export const CONFLICT_AT_MS = 46_500;
export const RESOLVE_START_MS = 48_000;
export const RESOLVED_AT_MS = 52_500;
export const MERGE_DONE_MS = 54_000;
export const SNAPSHOT_AT_MS = 16_000;

/** Which image each app window shows at a time; the Blender view picks up the merge. */
export function viewFor(app: DemoAppId, t: number): DemoView {
  switch (app) {
    case "blender":
      return t >= MERGE_DONE_MS ? "blenderMerged" : "blender";
    case "resolve":
      return t >= 28_000 ? "resolveCut" : "resolveEdit";
    case "browser":
      return t >= 38_500 ? "browserReference" : "browserDocs";
    case "code":
      return "code";
  }
}

const lastAtOrBefore = <T extends { readonly t: number }>(items: readonly T[], t: number) => {
  let found = items[0]!;
  for (const item of items) {
    if (item.t <= t) found = item;
    else break;
  }
  return found;
};

export const focusAppAt = (t: number): DemoAppId => lastAtOrBefore(FOCUS, t).app;

export const chapterAt = (t: number): DemoChapter => lastAtOrBefore(DEMO_CHAPTERS, t);

/** One point of a cursor's path, in percent of the live app view. */
export interface CursorKey {
  readonly t: number;
  readonly app: DemoAppId;
  readonly x: number;
  readonly y: number;
  /** The context item (object, clip, tab, file) the cursor is on, for presence avatars. */
  readonly item?: string;
  /** What they are doing, shown under the name label. */
  readonly doing?: string;
}

const k = (
  t: number,
  app: DemoAppId,
  x: number,
  y: number,
  item?: string,
  doing?: string,
): CursorKey => ({ t, app, x, y, ...(item ? { item } : {}), ...(doing ? { doing } : {}) });

export const CURSOR_TRACKS: Record<DemoActorId, readonly CursorKey[]> = {
  mira: [
    k(500, "blender", 30, 62),
    k(3_000, "blender", 41, 47, "Suzanne_Hero", "framing the hero"),
    k(7_000, "blender", 44, 52, "Table_Top"),
    k(12_000, "blender", 52, 40, "Camera_Main", "checking the camera"),
    k(21_500, "blender", 60, 35, "Camera_Main"),
    k(41_000, "blender", 55, 60, "Table_Top", "watching the merge"),
    k(50_000, "blender", 47, 55, "Ring_Brass", "reviewing the fix"),
    k(57_500, "blender", 38, 66, "Table_Top"),
    k(66_000, "blender", 33, 58, "Table_Top"),
    k(72_000, "blender", 36, 56, "Table_Top"),
  ],
  miraAgent: [
    k(4_500, "blender", 88, 13, "Camera_Main"),
    k(6_500, "blender", 88, 21, "Key_Light", "Key_Light energy 800 → 1200"),
    k(9_500, "blender", 93, 37, "Key_Light"),
    k(12_000, "blender", 43, 44, "Vase_Glass", "lifting Vase_Glass 0.15 m"),
    k(15_000, "blender", 39, 46, "Ring_Brass", "rotating Ring_Brass"),
    k(21_500, "blender", 38, 47, "Ring_Brass"),
    k(46_500, "blender", 38.5, 46, "Ring_Brass", "conflict on Ring_Brass"),
    k(48_000, "blender", 93, 37, "Ring_Brass", "resolving the conflict"),
    k(52_500, "blender", 39, 45, "Ring_Brass", "resolved"),
    k(57_500, "blender", 70, 30, "Key_Light"),
    k(66_000, "blender", 80, 22, "Key_Light"),
    k(72_000, "blender", 82, 20, "Key_Light"),
  ],
  omar: [
    k(13_000, "blender", 64, 75, "Chair_02"),
    k(16_000, "blender", 52, 60, "Table_Top", "taking snapshot #14"),
    k(22_000, "resolve", 45, 30, "Timeline 1"),
    k(25_000, "resolve", 47, 71, "studio_top", "reviewing the cut"),
    k(33_500, "resolve", 55, 71, "studio_close"),
    k(41_000, "blender", 64, 64, "Chair_02", "merging snapshot #14"),
    k(46_500, "blender", 47, 60, "Ring_Brass"),
    k(57_500, "blender", 62, 70, "Chair_02"),
    k(66_000, "blender", 70, 72, "Chair_02"),
    k(72_000, "blender", 72, 70, "Chair_02"),
  ],
  omarAgent: [
    k(22_500, "resolve", 12, 12, "studio_wide"),
    k(24_500, "resolve", 43.6, 71, "studio_close", "trimming clip 2 to 2s"),
    k(28_000, "resolve", 47.4, 71, "studio_top", "adding a cross dissolve"),
    k(31_000, "resolve", 80, 26, "Timeline 1", "checking the cut"),
    k(33_500, "resolve", 51, 71, "studio_wide"),
    k(41_000, "blender", 39, 45, "Ring_Brass", "replaying snapshot ops"),
    k(44_500, "blender", 64, 72, "Chair_02", "moving Chair_02"),
    k(46_500, "blender", 29, 38, "Ring_Brass"),
    k(54_000, "blender", 64, 72, "Chair_02"),
  ],
  ana: [
    k(34_000, "browser", 40, 20),
    k(36_000, "browser", 62, 30, "Principled BSDF", "reading the roughness docs"),
    k(38_500, "browser", 60, 40, "Mid-century modern"),
    k(40_800, "browser", 70, 46, "Mid-century modern", "saving the reference"),
    k(58_000, "code", 44, 40, "render_hero.py"),
    k(61_000, "code", 66, 36, "render_hero.py", "reviewing the agent's edit"),
    k(65_800, "code", 68, 40, "render_hero.py"),
    k(66_000, "blender", 20, 80),
    k(72_000, "blender", 24, 78),
  ],
  anaAgent: [
    k(34_500, "browser", 30, 6, "Principled BSDF"),
    k(36_500, "browser", 66, 28, "Principled BSDF", "Roughness 0.25 for brass"),
    k(38_500, "browser", 70, 44, "Mid-century modern", "collecting references"),
    k(40_800, "browser", 30, 12, "Mid-century modern"),
    k(58_500, "code", 30, 30, "render_hero.py"),
    k(60_000, "code", 40, 33, "render_hero.py", "writing render_hero.py"),
    k(63_000, "code", 52, 54, "render_hero.py", "queueing the hero render"),
    k(65_800, "code", 50, 58, "farm.toml"),
  ],
};

export interface CursorState {
  readonly actor: DemoActor;
  readonly x: number;
  readonly y: number;
  readonly item?: string;
  readonly doing?: string;
}

const ease = (p: number) => (p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2);
/** Seconds a cursor takes to glide to its next point; it rests there until that key's time. */
const GLIDE_MS = 1_400;

/** Where an actor's cursor is at `t` in `app`, or null when they are not in that app. */
export function cursorAt(actorId: DemoActorId, app: DemoAppId, t: number): CursorState | null {
  const track = CURSOR_TRACKS[actorId];
  const first = track[0];
  if (!first || t < first.t) return null;
  let index = 0;
  for (let i = 0; i < track.length; i++) if (track[i]!.t <= t) index = i;
  const current = track[index]!;
  const next = track[index + 1];
  // A cursor leaves the stage after its last key, and stays only in the app it is in.
  if (!next && t > current.t + 600) return null;
  if (current.app !== app) return null;
  const actor = DEMO_ACTORS[actorId];
  let x = current.x;
  let y = current.y;
  if (next && next.app === app) {
    const start = Math.max(current.t, next.t - GLIDE_MS);
    if (t > start) {
      const p = ease(Math.min(1, (t - start) / (next.t - start)));
      x = current.x + (next.x - current.x) * p;
      y = current.y + (next.y - current.y) * p;
    }
  }
  return {
    actor,
    x,
    y,
    ...(current.item ? { item: current.item } : {}),
    ...(current.doing ? { doing: current.doing } : {}),
  };
}

export const cursorsAt = (app: DemoAppId, t: number): CursorState[] =>
  (Object.keys(CURSOR_TRACKS) as DemoActorId[])
    .map((id) => cursorAt(id, app, t))
    .filter((cursor): cursor is CursorState => cursor !== null);

/** The app each actor is in at `t` (by their cursor path), for the window strip avatars. */
export function appOfActorAt(actorId: DemoActorId, t: number): DemoAppId | null {
  const track = CURSOR_TRACKS[actorId];
  const first = track[0];
  if (!first || t < first.t) return null;
  let current = first;
  for (const key of track) if (key.t <= t) current = key;
  if (current === track.at(-1) && t > current.t + 600) return null;
  return current.app;
}

export interface ContextItem {
  readonly id: string;
  readonly label: string;
  readonly kind: string;
  readonly depth?: number;
}

export const CONTEXT_ITEMS: Record<DemoAppId, readonly ContextItem[]> = {
  blender: [
    { id: "Camera_Main", label: "Camera_Main", kind: "camera" },
    { id: "Chair_01", label: "Chair_01", kind: "mesh" },
    { id: "Chair_02", label: "Chair_02", kind: "mesh" },
    { id: "Chair_03", label: "Chair_03", kind: "mesh" },
    { id: "Fill_Light", label: "Fill_Light", kind: "light" },
    { id: "Key_Light", label: "Key_Light", kind: "light" },
    { id: "Ring_Brass", label: "Ring_Brass", kind: "mesh" },
    { id: "Studio_Floor", label: "Studio_Floor", kind: "mesh" },
    { id: "Suzanne_Hero", label: "Suzanne_Hero", kind: "mesh" },
    { id: "Table_Leg", label: "Table_Leg", kind: "mesh" },
    { id: "Table_Top", label: "Table_Top", kind: "mesh" },
    { id: "Vase_Glass", label: "Vase_Glass", kind: "mesh" },
  ],
  resolve: [
    { id: "bin-master", label: "Master", kind: "bin" },
    { id: "studio_wide", label: "studio_wide.mp4", kind: "clip", depth: 1 },
    { id: "studio_close", label: "studio_close.mp4", kind: "clip", depth: 1 },
    { id: "studio_top", label: "studio_top.mp4", kind: "clip", depth: 1 },
    { id: "Timeline 1", label: "Timeline 1", kind: "timeline" },
    { id: "v1", label: "V1 · 6 clips", kind: "track", depth: 1 },
    { id: "a1", label: "A1 · music bed", kind: "track", depth: 1 },
  ],
  browser: [
    { id: "Principled BSDF", label: "Principled BSDF · Blender Manual", kind: "tab" },
    { id: "Mid-century modern", label: "Mid-century modern · Wikipedia", kind: "tab" },
    { id: "render-queue", label: "Render queue · localhost:7788", kind: "tab" },
  ],
  code: [
    { id: "render", label: "render", kind: "folder" },
    { id: "render_hero.py", label: "render_hero.py", kind: "file", depth: 1 },
    { id: "farm.toml", label: "farm.toml", kind: "file", depth: 1 },
    { id: "scenes", label: "scenes", kind: "folder" },
    { id: "studio.blend", label: "studio.blend", kind: "file", depth: 1 },
    { id: "README.md", label: "README.md", kind: "file" },
  ],
};

/** Who is on each context item of `app` right now. */
export function presenceOnItems(app: DemoAppId, t: number): Map<string, DemoActor[]> {
  const byItem = new Map<string, DemoActor[]>();
  for (const cursor of cursorsAt(app, t)) {
    if (!cursor.item) continue;
    const list = byItem.get(cursor.item) ?? [];
    list.push(cursor.actor);
    byItem.set(cursor.item, list);
  }
  return byItem;
}

export interface DemoTurnLine {
  readonly t: number;
  readonly actor: DemoActorId;
  readonly kind: "prompt" | "reply" | "tool";
  readonly text: string;
  /** How long the text takes to stream in. */
  readonly ms?: number;
}

export const TURN_LINES: readonly DemoTurnLine[] = [
  { t: 1_500, actor: "mira", kind: "prompt", text: "Light the table for the hero shot, warmer." },
  {
    t: 3_000,
    actor: "miraAgent",
    kind: "reply",
    text: "Raising the key light and lifting the vase so it catches the rim light.",
    ms: 2_400,
  },
  { t: 6_500, actor: "miraAgent", kind: "tool", text: "blender.set Key_Light.energy 800 → 1200" },
  { t: 12_000, actor: "miraAgent", kind: "tool", text: "blender.move Vase_Glass z +0.15 m" },
  { t: 15_000, actor: "miraAgent", kind: "tool", text: "blender.rotate Ring_Brass x 0° → 12°" },
  {
    t: 16_200,
    actor: "omar",
    kind: "prompt",
    text: "Snapshot the scene, I'm blocking chairs on the train.",
  },
  {
    t: 22_500,
    actor: "omar",
    kind: "prompt",
    text: "Tighten the cut: clip 2 to two seconds, dissolve into the top shot.",
  },
  {
    t: 23_500,
    actor: "omarAgent",
    kind: "reply",
    text: "Trimming studio_close and adding a 12 frame cross dissolve.",
    ms: 2_200,
  },
  { t: 24_500, actor: "omarAgent", kind: "tool", text: "resolve.trim V1 clip 2 → 00:02:00" },
  { t: 28_000, actor: "omarAgent", kind: "tool", text: "resolve.transition cross dissolve 12f" },
  {
    t: 34_200,
    actor: "ana",
    kind: "prompt",
    text: "What roughness should the brass use? Match the reference.",
  },
  {
    t: 35_500,
    actor: "anaAgent",
    kind: "reply",
    text: "The manual's Principled BSDF and the mid-century references point to 0.25.",
    ms: 2_600,
  },
  { t: 38_000, actor: "anaAgent", kind: "tool", text: "browser.read Principled BSDF › Roughness" },
  {
    t: 48_000,
    actor: "miraAgent",
    kind: "reply",
    text: "Keeping Omar's placement for Ring_Brass and re-applying my 12° tilt on top.",
    ms: 3_200,
  },
  {
    t: 52_000,
    actor: "miraAgent",
    kind: "tool",
    text: "merge.resolve Ring_Brass.location → snapshot #14",
  },
  {
    t: 58_200,
    actor: "ana",
    kind: "prompt",
    text: "Queue the hero render on the farm when the merge lands.",
  },
  {
    t: 59_200,
    actor: "anaAgent",
    kind: "reply",
    text: "Writing render_hero.py for Camera_Main, frames 1 to 72, and queueing it.",
    ms: 2_600,
  },
  { t: 63_000, actor: "anaAgent", kind: "tool", text: "farm.queue render_hero.py · 72 frames" },
];

export interface StreamedLine extends DemoTurnLine {
  readonly shown: string;
  readonly streaming: boolean;
}

const streamed = <T extends { t: number; text: string; ms?: number }>(line: T, t: number) => {
  const duration = line.ms ?? 700;
  const progress = Math.min(1, Math.max(0, (t - line.t) / duration));
  return {
    shown: line.text.slice(0, Math.round(line.text.length * progress)),
    streaming: progress < 1,
  };
};

/** Each person's turn lines up to `t` (their own prompts and their agent's work), newest last. */
export function turnsFor(person: "mira" | "omar" | "ana", t: number, limit = 4): StreamedLine[] {
  return TURN_LINES.filter((line) => line.t <= t && DEMO_ACTORS[line.actor].person === person)
    .slice(-limit)
    .map((line) => ({ ...line, ...streamed(line, t) }));
}

export interface AgentMessage {
  readonly t: number;
  readonly from: DemoActorId;
  readonly to: DemoActorId;
  readonly text: string;
  readonly ms?: number;
}

export const AGENT_MESSAGES: readonly AgentMessage[] = [
  {
    t: 26_000,
    from: "omarAgent",
    to: "miraAgent",
    text: "Need the final hero render for the cut by 6pm. Which camera?",
    ms: 1_800,
  },
  {
    t: 29_500,
    from: "miraAgent",
    to: "omarAgent",
    text: "Camera_Main, frames 1 to 72. I'll hand it over once Omar's snapshot is merged.",
    ms: 2_200,
  },
  {
    t: 39_000,
    from: "anaAgent",
    to: "miraAgent",
    text: "Brass roughness should be 0.25, references attached.",
    ms: 1_500,
  },
  {
    t: 53_000,
    from: "miraAgent",
    to: "anaAgent",
    text: "Merge landed and the conflict is resolved. Scene is ready to render.",
    ms: 1_800,
  },
  {
    t: 64_000,
    from: "anaAgent",
    to: "omarAgent",
    text: "Hero render queued, 72 frames. It will land in the Launch Film bin.",
    ms: 1_800,
  },
];

export const agentMessagesAt = (t: number, limit = 3) =>
  AGENT_MESSAGES.filter((message) => message.t <= t)
    .slice(-limit)
    .map((message) => ({ ...message, ...streamed(message, t) }));

export interface DemoAction {
  readonly t: number;
  readonly actor: DemoActorId;
  readonly app: DemoAppId;
  readonly op: string;
  readonly source: "live" | "snapshot";
}

export const LIVE_ACTIONS: readonly DemoAction[] = [
  {
    t: 6_500,
    actor: "miraAgent",
    app: "blender",
    op: "set Key_Light.energy 800 → 1200",
    source: "live",
  },
  {
    t: 12_000,
    actor: "miraAgent",
    app: "blender",
    op: "move Vase_Glass z 1.24 → 1.39",
    source: "live",
  },
  {
    t: 15_000,
    actor: "miraAgent",
    app: "blender",
    op: "rotate Ring_Brass x 0° → 12°",
    source: "live",
  },
  { t: 24_500, actor: "omarAgent", app: "resolve", op: "trim V1 clip 2 → 2s", source: "live" },
  { t: 28_000, actor: "omarAgent", app: "resolve", op: "add cross dissolve 12f", source: "live" },
  {
    t: 37_000,
    actor: "anaAgent",
    app: "browser",
    op: "bookmark Principled BSDF › Roughness",
    source: "live",
  },
  {
    t: 40_500,
    actor: "ana",
    app: "browser",
    op: "save reference image to Launch Film",
    source: "live",
  },
  {
    t: 61_000,
    actor: "anaAgent",
    app: "code",
    op: "edit render_hero.py +18 lines",
    source: "live",
  },
  {
    t: 63_000,
    actor: "anaAgent",
    app: "code",
    op: "queue render_hero.py on the farm",
    source: "live",
  },
];

/** What Omar did on his laptop in snapshot #14, replayed onto the shared scene during the merge. */
export const SNAPSHOT_ACTIONS: readonly Omit<DemoAction, "t" | "source">[] = [
  { actor: "omar", app: "blender", op: "move Chair_02 x 2.30 → 1.60" },
  { actor: "omar", app: "blender", op: "rotate Chair_02 z 23° → 40°" },
  { actor: "omar", app: "blender", op: "move Ring_Brass → (-0.55, -0.05, 1.02)" },
  { actor: "omar", app: "blender", op: "rotate Ring_Brass x → 70°" },
  { actor: "omar", app: "blender", op: "set Glass.base_color → blue" },
  { actor: "omar", app: "blender", op: "set Camera_Main.lens 50 → 35 mm" },
];

/** When each snapshot op lands on Omar's laptop while he works offline. */
const LOCAL_OP_TIMES = [18_000, 20_500, 24_000, 29_000, 33_000, 37_500];
/** When each snapshot op is replayed onto the shared scene. */
const REPLAY_TIMES = [42_000, 44_000, 46_500, 52_800, 53_200, 53_600];
/** The replayed op that collides with Mira's agent's live edit. */
export const CONFLICTING_OP_INDEX = 2;

export type SnapshotPhase =
  | "none"
  | "taking"
  | "local"
  | "merging"
  | "conflict"
  | "resolving"
  | "merged";

export interface SnapshotState {
  readonly phase: SnapshotPhase;
  readonly localOps: number;
  readonly replayed: number;
  readonly total: number;
  /** 0..1 progress of the replay animation for the op currently being applied. */
  readonly opProgress: number;
}

export function snapshotAt(t: number): SnapshotState {
  const total = SNAPSHOT_ACTIONS.length;
  const localOps = LOCAL_OP_TIMES.filter((time) => time <= t).length;
  const replayed = REPLAY_TIMES.filter((time) => time <= t).length;
  const nextReplay = REPLAY_TIMES[replayed];
  const opProgress = nextReplay === undefined ? 1 : Math.max(0, 1 - (nextReplay - t) / 1_200);
  let phase: SnapshotPhase = "none";
  if (t >= SNAPSHOT_AT_MS) phase = "taking";
  if (t >= SNAPSHOT_AT_MS + 1_800) phase = "local";
  if (t >= MERGE_START_MS) phase = "merging";
  if (t >= CONFLICT_AT_MS) phase = "conflict";
  if (t >= RESOLVE_START_MS) phase = "resolving";
  if (t >= RESOLVED_AT_MS) phase = "merging";
  if (t >= MERGE_DONE_MS) phase = "merged";
  return { phase, localOps, replayed, total, opProgress };
}

export interface LogEntry extends DemoAction {
  readonly key: string;
  readonly conflict?: boolean;
}

/** The action log: live ops plus replayed snapshot ops, newest first. */
export function actionLogAt(t: number, limit = 7): LogEntry[] {
  const live: LogEntry[] = LIVE_ACTIONS.filter((action) => action.t <= t).map((action) => ({
    ...action,
    key: `live-${action.t}`,
  }));
  const replayed: LogEntry[] = SNAPSHOT_ACTIONS.flatMap((action, index) => {
    const time = REPLAY_TIMES[index]!;
    if (time > t) return [];
    return [
      {
        ...action,
        t: time,
        source: "snapshot" as const,
        key: `snap-${index}`,
        ...(index === CONFLICTING_OP_INDEX ? { conflict: t < RESOLVED_AT_MS } : {}),
      },
    ];
  });
  return [...live, ...replayed].sort((a, b) => b.t - a.t).slice(0, limit);
}

export interface ConflictState {
  readonly status: "open" | "resolving" | "resolved";
  readonly resolution: string;
  readonly streaming: boolean;
}

const RESOLUTION_TEXT =
  "Kept Omar's placement from snapshot #14, re-applied Mira's agent's 12° tilt on top.";

export function conflictAt(t: number): ConflictState | null {
  if (t < CONFLICT_AT_MS || t >= MERGE_DONE_MS + 2_500) return null;
  if (t < RESOLVE_START_MS) return { status: "open", resolution: "", streaming: false };
  const { shown, streaming } = streamed(
    { t: RESOLVE_START_MS, text: RESOLUTION_TEXT, ms: 3_600 },
    t,
  );
  return { status: t >= RESOLVED_AT_MS ? "resolved" : "resolving", resolution: shown, streaming };
}

export const formatDemoTime = (t: number) => {
  const seconds = Math.floor(Math.max(0, t) / 1_000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

/** `?t=` in seconds, clamped to the demo, for deep links and recordings. */
export function parseDemoStart(value: unknown): number {
  const seconds = typeof value === "number" ? value : typeof value === "string" ? Number(value) : 0;
  if (!Number.isFinite(seconds)) return 0;
  return Math.min(DEMO_DURATION_MS, Math.max(0, seconds * 1_000));
}

/** The render script Ana's agent writes during the code chapter, revealed line by line. */
export const CODE_LINES: readonly string[] = [
  "import bpy",
  "from farm import queue",
  "",
  'SCENE = "scenes/studio.blend"',
  "",
  "def render_hero(frames=range(1, 73)):",
  '    scene = bpy.data.scenes["Scene"]',
  '    scene.camera = bpy.data.objects["Camera_Main"]',
  '    scene.render.engine = "BLENDER_EEVEE"',
  "    scene.render.resolution_x = 3840",
  "    scene.render.resolution_y = 2160",
  '    brass = bpy.data.materials["Brass"]',
  '    brass.node_tree.nodes["Principled BSDF"]',
  '        .inputs["Roughness"].default_value = 0.25',
  '    return queue(SCENE, frames, out="bins/Launch Film")',
  "",
  'if __name__ == "__main__":',
  "    render_hero()",
];

export const CODE_TYPE_START_MS = 60_000;
export const CODE_TYPE_END_MS = 63_000;

/** How many lines of render_hero.py exist at `t`; the first five were there before. */
export function codeLinesAt(t: number): number {
  const base = 5;
  if (t < CODE_TYPE_START_MS) return base;
  const progress = Math.min(1, (t - CODE_TYPE_START_MS) / (CODE_TYPE_END_MS - CODE_TYPE_START_MS));
  return base + Math.round((CODE_LINES.length - base) * progress);
}
