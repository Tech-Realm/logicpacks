import { type LayoutMode, type WorkStyle, parseLayoutModesJson } from "./layoutModes";

/**
 * Per-account prefs, stored at `/api/lp/prefs` and cached per account. Each slice has its own
 * `updatedAt` so devices that changed different slices both keep theirs. `workStyle` is the
 * key the sign-in "How do you work?" screen writes: "developer" or "beginner".
 */
export type TourState = "pending" | "done" | "skipped";

export interface LayoutPrefs {
  readonly activeModeId: string | null;
  readonly customModes: readonly LayoutMode[];
  readonly updatedAt: string | null;
}

export interface IntroPrefs {
  readonly completedAt: string | null;
  readonly tour: TourState | null;
  readonly updatedAt: string | null;
}

export interface UserPrefs {
  readonly layout: LayoutPrefs;
  readonly workStyle: WorkStyle | null;
  readonly intro: IntroPrefs;
}

export type UserPrefsKey = keyof UserPrefs;

export const EMPTY_USER_PREFS: UserPrefs = {
  layout: { activeModeId: null, customModes: [], updatedAt: null },
  workStyle: null,
  intro: { completedAt: null, tour: null, updatedAt: null },
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const stringOrNull = (value: unknown) => (typeof value === "string" ? value : null);

function decodeLayout(value: unknown): LayoutPrefs | null {
  if (!isRecord(value)) return null;
  const rawModes = Array.isArray(value.customModes) ? value.customModes : [];
  // Modes that no longer validate are dropped rather than breaking the whole slice.
  const customModes = rawModes.flatMap((mode) => {
    const parsed = parseLayoutModesJson(JSON.stringify(mode));
    return parsed.ok ? parsed.modes : [];
  });
  return {
    activeModeId: stringOrNull(value.activeModeId),
    customModes,
    updatedAt: stringOrNull(value.updatedAt),
  };
}

function decodeIntro(value: unknown): IntroPrefs | null {
  if (!isRecord(value)) return null;
  const tour =
    value.tour === "pending" || value.tour === "done" || value.tour === "skipped"
      ? value.tour
      : null;
  return {
    completedAt: stringOrNull(value.completedAt),
    tour,
    updatedAt: stringOrNull(value.updatedAt),
  };
}

export function decodeWorkStyle(value: unknown): WorkStyle | null {
  return value === "developer" || value === "beginner" ? value : null;
}

/** Whatever the server or a cache holds, read leniently: unknown or broken slices are absent. */
export function decodeUserPrefs(value: unknown): Partial<UserPrefs> {
  if (!isRecord(value)) return {};
  const layout = decodeLayout(value.layout);
  const intro = decodeIntro(value.intro);
  const workStyle = decodeWorkStyle(value.workStyle);
  return {
    ...(layout ? { layout } : {}),
    ...(intro ? { intro } : {}),
    ...(workStyle ? { workStyle } : {}),
  };
}

const newer = (left: string | null, right: string | null) => (left ?? "") > (right ?? "");

/**
 * Merges the server's copy into the local one. The newer slice wins; the slices where the local
 * copy is newer (or the server has none) come back in `push` so the caller can send them up.
 * The onboarding writes `workStyle` on the server, so the server's answer always wins.
 */
export function mergeUserPrefs(
  local: UserPrefs,
  server: Partial<UserPrefs>,
): { readonly prefs: UserPrefs; readonly push: Partial<UserPrefs> } {
  const push: { -readonly [K in UserPrefsKey]?: UserPrefs[K] } = {};
  let layout = local.layout;
  if (server.layout && !newer(local.layout.updatedAt, server.layout.updatedAt))
    layout = server.layout;
  else if (local.layout.updatedAt !== null) push.layout = local.layout;
  let intro = local.intro;
  if (server.intro && !newer(local.intro.updatedAt, server.intro.updatedAt)) intro = server.intro;
  else if (local.intro.updatedAt !== null) push.intro = local.intro;
  const workStyle = server.workStyle ?? local.workStyle;
  if (!server.workStyle && local.workStyle) push.workStyle = local.workStyle;
  return { prefs: { layout, intro, workStyle }, push };
}
