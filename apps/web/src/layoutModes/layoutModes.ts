/**
 * Layout modes arrange what the v2 room already has: the sidebar, the chat column and the
 * workspace panel. Ported from v1 `desktopLayoutModes.ts`; imports are validated with
 * per-field errors instead of silent fallbacks.
 */

export const LAYOUT_PANELS = ["projects", "chat", "workspace"] as const;
export type LayoutPanel = (typeof LAYOUT_PANELS)[number];

export const WORKSPACE_SURFACES = ["none", "files", "diff"] as const;
export type WorkspaceSurface = (typeof WORKSPACE_SURFACES)[number];

export interface LayoutMode {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  /** Left to right. Projects is always first: the workspace sidebar sits on the left. */
  readonly order: readonly LayoutPanel[];
  /** What is open when you switch to this mode. */
  readonly open: {
    readonly projects: boolean;
    readonly workspace: boolean;
    readonly terminal: boolean;
  };
  /** What the workspace panel opens to by itself when you open a thread. */
  readonly autoOpen: WorkspaceSurface;
  /** Pixel widths of the projects sidebar and the workspace panel. */
  readonly widths: { readonly projects: number; readonly workspace: number };
}

export const LAYOUT_WIDTH_LIMITS = {
  projects: { min: 200, max: 480 },
  workspace: { min: 360, max: 1200 },
} as const;

export const DEV_LAYOUT_MODE: LayoutMode = {
  id: "dev",
  label: "Dev",
  description: "Files and editor first, chat at the side, terminal and diff a click away.",
  order: ["projects", "workspace", "chat"],
  open: { projects: true, workspace: true, terminal: false },
  autoOpen: "files",
  widths: { projects: 220, workspace: 600 },
};

export const VIBE_LAYOUT_MODE: LayoutMode = {
  id: "vibe",
  label: "Vibe",
  description: "Chat first and simple. Workspace and diff stay hidden until you ask.",
  order: ["projects", "chat", "workspace"],
  open: { projects: true, workspace: false, terminal: false },
  autoOpen: "none",
  widths: { projects: 280, workspace: 540 },
};

export const BUILT_IN_LAYOUT_MODES: readonly LayoutMode[] = [DEV_LAYOUT_MODE, VIBE_LAYOUT_MODE];
export const BUILT_IN_LAYOUT_MODE_IDS: ReadonlySet<string> = new Set(
  BUILT_IN_LAYOUT_MODES.map((mode) => mode.id),
);

export const LAYOUT_MODES_FILE_VERSION = 1;
export const MAX_CUSTOM_LAYOUT_MODES = 12;

export type WorkStyle = "developer" | "beginner";

/** The mode a person gets before they pick one: developers start in Dev, everyone else in Vibe. */
export function defaultLayoutModeId(workStyle: WorkStyle | null): string {
  return workStyle === "developer" ? DEV_LAYOUT_MODE.id : VIBE_LAYOUT_MODE.id;
}

export function allLayoutModes(customModes: readonly LayoutMode[]): readonly LayoutMode[] {
  return [...BUILT_IN_LAYOUT_MODES, ...customModes];
}

export function resolveLayoutMode(
  activeModeId: string | null,
  customModes: readonly LayoutMode[],
  workStyle: WorkStyle | null,
): LayoutMode {
  const modes = allLayoutModes(customModes);
  const wanted = activeModeId ?? defaultLayoutModeId(workStyle);
  return (
    modes.find((mode) => mode.id === wanted) ??
    modes.find((mode) => mode.id === defaultLayoutModeId(workStyle)) ??
    VIBE_LAYOUT_MODE
  );
}

/** True when the workspace panel sits left of the chat column. */
export function workspaceBeforeChat(mode: LayoutMode): boolean {
  return mode.order.indexOf("workspace") < mode.order.indexOf("chat");
}

export function isBuiltInLayoutMode(id: string): boolean {
  return BUILT_IN_LAYOUT_MODE_IDS.has(id);
}

function slugify(label: string): string {
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "layout"
  );
}

/** A copy of `source` with a fresh id and label that collide with nothing in `taken`. */
export function duplicateLayoutMode(
  source: LayoutMode,
  taken: readonly LayoutMode[],
  label = `${source.label} copy`,
): LayoutMode {
  const ids = new Set([...BUILT_IN_LAYOUT_MODE_IDS, ...taken.map((mode) => mode.id)]);
  const base = slugify(label);
  let id = base;
  for (let n = 2; ids.has(id); n++) id = `${base}-${n}`;
  return { ...source, id, label, open: { ...source.open }, widths: { ...source.widths } };
}

export type LayoutModesParseResult =
  | { readonly ok: true; readonly modes: readonly LayoutMode[] }
  | { readonly ok: false; readonly errors: readonly string[] };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function readMode(raw: unknown, at: string, errors: string[]): LayoutMode | null {
  if (!isRecord(raw)) {
    errors.push(`${at}: expected an object.`);
    return null;
  }
  const before = errors.length;
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (!id) errors.push(`${at}.id: give the layout an id, like "my-dev".`);
  else if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(id))
    errors.push(`${at}.id: use lowercase letters, digits and dashes (max 40), not "${id}".`);
  const label = typeof raw.label === "string" ? raw.label.trim() : "";
  if (!label) errors.push(`${at}.label: give the layout a name.`);
  else if (label.length > 40) errors.push(`${at}.label: keep the name under 40 characters.`);
  const description =
    raw.description === undefined
      ? ""
      : typeof raw.description === "string"
        ? raw.description.trim().slice(0, 140)
        : (errors.push(`${at}.description: expected text.`), "");

  let order: LayoutPanel[] = [];
  if (!Array.isArray(raw.order)) {
    errors.push(
      `${at}.order: list the panels left to right, like ["projects", "chat", "workspace"].`,
    );
  } else {
    for (const [index, panel] of raw.order.entries()) {
      if (typeof panel !== "string" || !(LAYOUT_PANELS as readonly string[]).includes(panel)) {
        errors.push(
          `${at}.order[${index}]: unknown panel ${JSON.stringify(panel)}. Use projects, chat or workspace.`,
        );
      } else {
        order.push(panel as LayoutPanel);
      }
    }
    if (order.length === raw.order.length) {
      const missing = LAYOUT_PANELS.filter((panel) => !order.includes(panel));
      if (missing.length > 0 || order.length !== LAYOUT_PANELS.length) {
        errors.push(
          `${at}.order: list each of projects, chat and workspace once${missing.length > 0 ? ` (missing ${missing.join(", ")})` : ""}.`,
        );
      } else if (order[0] !== "projects") {
        errors.push(`${at}.order: projects has to come first, the sidebar sits on the left.`);
      }
    }
  }

  const openRaw = raw.open;
  const open = { projects: true, workspace: false, terminal: false };
  if (!isRecord(openRaw)) {
    errors.push(
      `${at}.open: expected { "projects": true, "workspace": false, "terminal": false }.`,
    );
  } else {
    for (const key of Object.keys(openRaw)) {
      if (!(key in open))
        errors.push(`${at}.open.${key}: unknown panel. Use projects, workspace or terminal.`);
    }
    for (const key of ["projects", "workspace", "terminal"] as const) {
      const value = openRaw[key];
      if (value === undefined) continue;
      if (typeof value !== "boolean") errors.push(`${at}.open.${key}: expected true or false.`);
      else open[key] = value;
    }
  }

  const autoOpen = raw.autoOpen ?? "none";
  if (typeof autoOpen !== "string" || !(WORKSPACE_SURFACES as readonly string[]).includes(autoOpen))
    errors.push(`${at}.autoOpen: use "none", "files" or "diff", not ${JSON.stringify(autoOpen)}.`);

  const widths = { projects: VIBE_LAYOUT_MODE.widths.projects, workspace: 540 };
  if (raw.widths !== undefined) {
    if (!isRecord(raw.widths))
      errors.push(`${at}.widths: expected { "projects": 260, "workspace": 600 }.`);
    else {
      for (const key of ["projects", "workspace"] as const) {
        const value = raw.widths[key];
        if (value === undefined) continue;
        const limits = LAYOUT_WIDTH_LIMITS[key];
        if (typeof value !== "number" || !Number.isFinite(value))
          errors.push(`${at}.widths.${key}: expected a number of pixels.`);
        else if (value < limits.min || value > limits.max)
          errors.push(
            `${at}.widths.${key}: ${value} is out of range, use ${limits.min} to ${limits.max}.`,
          );
        else widths[key] = Math.round(value);
      }
    }
  }

  if (errors.length > before) return null;
  return {
    id,
    label,
    description,
    order,
    open,
    autoOpen: autoOpen as WorkspaceSurface,
    widths,
  };
}

function describeJsonError(text: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const position = /position (\d+)/.exec(message);
  if (position) {
    const offset = Number(position[1]);
    const line = text.slice(0, offset).split("\n").length;
    return `This is not valid JSON (line ${line}): ${message}`;
  }
  return `This is not valid JSON: ${message}`;
}

/**
 * Reads a layouts file: `{ "version": 1, "modes": [...] }`, a bare array, or one mode.
 * Built-in ids are refused so an import never shadows Dev or Vibe.
 */
export function parseLayoutModesJson(text: string): LayoutModesParseResult {
  if (!text.trim()) return { ok: false, errors: ["The file is empty."] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { ok: false, errors: [describeJsonError(text, error)] };
  }
  let rawModes: unknown[];
  let prefix: string;
  if (Array.isArray(parsed)) {
    rawModes = parsed;
    prefix = "";
  } else if (isRecord(parsed) && "modes" in parsed) {
    if (parsed.version !== undefined && parsed.version !== LAYOUT_MODES_FILE_VERSION)
      return {
        ok: false,
        errors: [`version: this app reads version ${LAYOUT_MODES_FILE_VERSION} layout files.`],
      };
    if (!Array.isArray(parsed.modes)) return { ok: false, errors: ["modes: expected a list."] };
    rawModes = parsed.modes;
    prefix = "modes";
  } else if (isRecord(parsed)) {
    rawModes = [parsed];
    prefix = "";
  } else {
    return { ok: false, errors: ['Expected a layout, a list of layouts, or { "modes": [...] }.'] };
  }
  if (rawModes.length === 0) return { ok: false, errors: ["There are no layouts in this file."] };
  if (rawModes.length > MAX_CUSTOM_LAYOUT_MODES)
    return { ok: false, errors: [`Keep it to ${MAX_CUSTOM_LAYOUT_MODES} layouts or fewer.`] };

  const errors: string[] = [];
  const modes: LayoutMode[] = [];
  const seen = new Set<string>();
  rawModes.forEach((raw, index) => {
    const at = prefix
      ? `${prefix}[${index}]`
      : rawModes.length === 1 && !Array.isArray(parsed)
        ? "layout"
        : `[${index}]`;
    const mode = readMode(raw, at, errors);
    if (!mode) return;
    if (isBuiltInLayoutMode(mode.id)) {
      errors.push(`${at}.id: "${mode.id}" is a built-in layout. Pick another id.`);
      return;
    }
    if (seen.has(mode.id)) {
      errors.push(`${at}.id: "${mode.id}" appears twice.`);
      return;
    }
    seen.add(mode.id);
    modes.push(mode);
  });
  return errors.length > 0 ? { ok: false, errors } : { ok: true, modes };
}

export function serializeLayoutModes(modes: readonly LayoutMode[]): string {
  return JSON.stringify({ version: LAYOUT_MODES_FILE_VERSION, modes }, null, 2);
}

/** Imported modes replace custom modes with the same id and are added after the rest. */
export function mergeImportedLayoutModes(
  current: readonly LayoutMode[],
  imported: readonly LayoutMode[],
): readonly LayoutMode[] {
  const importedIds = new Set(imported.map((mode) => mode.id));
  return [...current.filter((mode) => !importedIds.has(mode.id)), ...imported].slice(
    0,
    MAX_CUSTOM_LAYOUT_MODES,
  );
}
