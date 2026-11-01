import type { LpRecipeViewItem } from "./api";

export interface OutlineRow {
  readonly item: LpRecipeViewItem;
  readonly depth: number;
}

/** The app's outline in tree order: children under their parent, names sorted, orphans at the root. */
export function outlineRows(items: ReadonlyArray<LpRecipeViewItem>): OutlineRow[] {
  const ids = new Set(items.flatMap((item) => (item.id === null ? [] : [item.id])));
  const children = new Map<string | null, LpRecipeViewItem[]>();
  for (const item of items) {
    const parent = item.parent !== null && ids.has(item.parent) ? item.parent : null;
    children.set(parent, [...(children.get(parent) ?? []), item]);
  }
  const rows: OutlineRow[] = [];
  const seen = new Set<LpRecipeViewItem>();
  const visit = (parent: string | null, depth: number) => {
    const level = [...(children.get(parent) ?? [])].toSorted((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const item of level) {
      if (seen.has(item)) continue;
      seen.add(item);
      rows.push({ item, depth });
      if (item.id !== null) visit(item.id, depth + 1);
    }
  };
  visit(null, 0);
  return rows;
}

type ViewActor = NonNullable<LpRecipeViewItem["last"]>["actor"];

/** Who made an edit, as people read it: the bridge's local operator is "You". */
export function actorLabel(actor: ViewActor): string {
  if (actor.name) return actor.name;
  if (actor.kind === "agent") return actor.id === "agent" ? "Agent" : actor.id;
  return actor.id === "local" ? "You" : actor.id;
}

/** "now", "40s", "3m", "2h", "5d": short enough for an outline row. */
export function shortAge(at: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(at)) / 1000));
  if (!Number.isFinite(seconds) || seconds < 5) return "now";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/** Items someone changed recently, newest first: the "who is on what" strip. */
export function recentEdits(
  items: ReadonlyArray<LpRecipeViewItem>,
  limit: number,
): Array<LpRecipeViewItem & { readonly last: NonNullable<LpRecipeViewItem["last"]> }> {
  return items
    .filter(
      (item): item is LpRecipeViewItem & { last: NonNullable<LpRecipeViewItem["last"]> } =>
        item.last !== null,
    )
    .toSorted((a, b) => b.last.at.localeCompare(a.last.at))
    .slice(0, limit);
}

/** Bounded render width for the app's frame: the panel's width, in device pixels. */
export function viewWidth(panelWidth: number, pixelRatio: number): number {
  return Math.max(320, Math.min(1280, Math.round(panelWidth * Math.min(pixelRatio, 2))));
}
