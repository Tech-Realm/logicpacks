import {
  PRESENCE_COLOR_COUNT,
  type PresenceActor,
  type PresenceEntry,
  type PresencePosition,
} from "@logicpacks/contracts";

/** A theme token, so the palette follows the active theme. */
export const presenceColor = (colorIndex: number) =>
  `var(--presence-${colorIndex % PRESENCE_COLOR_COUNT})`;

export const presenceInitials = (actor: PresenceActor): string => {
  const owner = actor.kind === "agent" ? actor.name.replace(/'s .*$/, "") : actor.name;
  const words = owner.trim().split(/\s+/).filter(Boolean);
  const letters =
    words.length > 1 ? `${words[0]![0]}${words.at(-1)![0]}` : (words[0]?.slice(0, 2) ?? "?");
  return letters.toUpperCase();
};

const ageLabel = (since: string, nowMs: number) => {
  const minutes = Math.floor((nowMs - Date.parse(since)) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h`;
};

/** The hover line: "Ali's agent editing checkout.tsx:42, 2m". */
export const presenceLine = (
  entry: PresenceEntry,
  nowMs: number,
  options: { readonly withPath?: boolean } = {},
): string => {
  const { location } = entry;
  const where = location.appItem
    ? ` ${location.appItem.label ?? location.appItem.itemId}`
    : options.withPath !== false && location.path
      ? ` ${location.path}`
      : "";
  const line = location.cursor
    ? where === ""
      ? ` line ${location.cursor.line}`
      : `:${location.cursor.line}`
    : "";
  return `${entry.actor.name} ${location.activity}${where}${line}, ${ageLabel(entry.since, nowMs)}`;
};

export const othersOnly = (
  entries: Iterable<PresenceEntry>,
  ownTabId: string,
): ReadonlyArray<PresenceEntry> =>
  Array.from(entries).filter((entry) => !entry.clientId.startsWith(ownTabId));

const folderPrefix = (folder: string) => (folder.endsWith("/") ? folder : `${folder}/`);

export const entriesInFile = (entries: ReadonlyArray<PresenceEntry>, path: string) =>
  entries.filter((entry) => entry.location.path === path);

export const entriesUnderFolder = (entries: ReadonlyArray<PresenceEntry>, folder: string) => {
  const prefix = folderPrefix(folder);
  return entries.filter((entry) => entry.location.path?.startsWith(prefix) === true);
};

export const entriesOnAppItem = (
  entries: ReadonlyArray<PresenceEntry>,
  recipeId: string,
  itemId: string,
) =>
  entries.filter(
    (entry) =>
      entry.location.appItem?.recipeId === recipeId && entry.location.appItem.itemId === itemId,
  );

/**
 * Who is on one object in an app recipe. Agents name an object by its id or, before
 * Blender has given it one, by its name; people report the id.
 */
export const entriesOnAppObject = (
  entries: ReadonlyArray<PresenceEntry>,
  recipeId: string,
  item: { readonly id: string | null; readonly name: string },
) =>
  entries.filter((entry) => {
    const appItem = entry.location.appItem;
    if (appItem?.recipeId !== recipeId) return false;
    return (item.id !== null && appItem.itemId === item.id) || appItem.itemId === item.name;
  });

/** Everyone in the app view of a project: on an object of this recipe, or just looking. */
export const entriesInApp = (entries: ReadonlyArray<PresenceEntry>, recipeId: string) =>
  entries.filter(
    (entry) =>
      entry.location.view === "app" &&
      (entry.location.appItem === undefined || entry.location.appItem.recipeId === recipeId),
  );

/** A pointer at fractions of the frame, rounded so a still hand does not resend. */
export const appPointer = (
  offsetX: number,
  offsetY: number,
  width: number,
  height: number,
): { readonly x: number; readonly y: number } | null => {
  if (width <= 0 || height <= 0) return null;
  const clamp = (value: number) => Math.min(1, Math.max(0, Math.round(value * 1000) / 1000));
  return { x: clamp(offsetX / width), y: clamp(offsetY / height) };
};

/** One avatar per person or agent, however many tabs they have open; humans first. */
export const presenceAvatars = (
  entries: ReadonlyArray<PresenceEntry>,
): ReadonlyArray<{
  readonly actor: PresenceActor;
  readonly entries: ReadonlyArray<PresenceEntry>;
}> => {
  const byActor = new Map<string, PresenceEntry[]>();
  for (const entry of entries) {
    const list = byActor.get(entry.actor.id);
    if (list) list.push(entry);
    else byActor.set(entry.actor.id, [entry]);
  }
  return Array.from(byActor.values(), (list) => ({
    actor: list[0]!.actor,
    entries: list.toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
  })).toSorted(
    (a, b) =>
      (a.actor.kind === "agent" ? 1 : 0) - (b.actor.kind === "agent" ? 1 : 0) ||
      a.actor.name.localeCompare(b.actor.name),
  );
};

const TREE_MAX_DOTS = 4;

/**
 * The file tree only takes text decorations, so the avatar stack there is a
 * row of coloured marks (a dot per person, a diamond per agent) with the hover
 * lines in the title.
 */
export const presenceTreeDecoration = (
  entries: ReadonlyArray<PresenceEntry>,
  treePath: string,
  nowMs: number,
) => {
  const isFolder = treePath.endsWith("/");
  const path = treePath.replace(/\/$/, "");
  const here = isFolder ? entriesUnderFolder(entries, path) : entriesInFile(entries, path);
  if (here.length === 0) return null;
  const avatars = presenceAvatars(here);
  const shown = avatars.slice(0, TREE_MAX_DOTS);
  const parts = shown.map(({ actor }) => ({
    text: actor.kind === "agent" ? "◆" : "●",
    color: presenceColor(actor.colorIndex),
  }));
  const overflow = avatars.length - shown.length;
  if (overflow > 0) parts.push({ text: `+${overflow}`, color: "var(--muted-foreground)" });
  return {
    text: parts.map((part) => part.text).join(""),
    parts,
    title: avatars
      .map(({ entries: own }) => presenceLine(own[0]!, nowMs, { withPath: isFolder }))
      .join("\n"),
  };
};

/** What the code editor carries on each remote caret, besides its colour. */
export interface PresenceCaretMetadata {
  readonly name: string;
  readonly agent: boolean;
}

export interface RemoteCaret {
  readonly anchor: { readonly line: number; readonly character: number };
  readonly focus: { readonly line: number; readonly character: number };
  readonly metadata: PresenceCaretMetadata & { readonly color: string };
}

const toEditorPosition = (position: PresencePosition) => ({
  line: position.line - 1,
  character: position.column,
});

/** Editor carets (zero-based lines) for everyone else with a cursor in this file. */
export const remoteCaretsForFile = (
  entries: ReadonlyArray<PresenceEntry>,
  path: string,
): RemoteCaret[] =>
  entriesInFile(entries, path).flatMap((entry) => {
    const { cursor, anchor } = entry.location;
    if (cursor === undefined) return [];
    return [
      {
        anchor: toEditorPosition(anchor ?? cursor),
        focus: toEditorPosition(cursor),
        metadata: {
          color: presenceColor(entry.actor.colorIndex),
          name: entry.actor.name,
          agent: entry.actor.kind === "agent",
        },
      },
    ];
  });

/** An editor selection (zero-based, with direction) as a presence cursor and anchor. */
export const presencePositionsFromSelection = (selection: {
  readonly start: { readonly line: number; readonly character: number };
  readonly end: { readonly line: number; readonly character: number };
  /** The editor's -1 | 0 | 1, where -1 means the caret is at the start. */
  readonly direction: number;
}): { cursor: PresencePosition; anchor?: PresencePosition } => {
  const toPresence = (position: { readonly line: number; readonly character: number }) => ({
    line: position.line + 1,
    column: position.character,
  });
  const backward = selection.direction < 0;
  const cursor = toPresence(backward ? selection.start : selection.end);
  const collapsed =
    selection.start.line === selection.end.line &&
    selection.start.character === selection.end.character;
  return collapsed
    ? { cursor }
    : { cursor, anchor: toPresence(backward ? selection.end : selection.start) };
};
