import { create } from "zustand";

import { lpRequest } from "../logicpacks/api";
import {
  type LayoutMode,
  type WorkStyle,
  MAX_CUSTOM_LAYOUT_MODES,
  mergeImportedLayoutModes,
  resolveLayoutMode,
} from "./layoutModes";
import {
  EMPTY_USER_PREFS,
  type TourState,
  type UserPrefs,
  type UserPrefsKey,
  decodeUserPrefs,
  mergeUserPrefs,
} from "./userPrefs.logic";

type SyncStatus = "idle" | "loading" | "ready" | "offline";

interface UserPrefsState {
  readonly owner: string | null;
  readonly status: SyncStatus;
  readonly prefs: UserPrefs;
}

const CACHE_PREFIX = "lp:prefs:";
const LAST_OWNER_KEY = "lp:prefs:last-owner";
const PUSH_DELAY_MS = 400;

function readCache(owner: string): UserPrefs {
  try {
    const raw = window.localStorage.getItem(CACHE_PREFIX + owner);
    if (!raw) return EMPTY_USER_PREFS;
    return { ...EMPTY_USER_PREFS, ...decodeUserPrefs(JSON.parse(raw)) };
  } catch {
    return EMPTY_USER_PREFS;
  }
}

function writeCache(owner: string, prefs: UserPrefs) {
  try {
    window.localStorage.setItem(CACHE_PREFIX + owner, JSON.stringify(prefs));
    window.localStorage.setItem(LAST_OWNER_KEY, owner);
  } catch {
    // Storage full or blocked: the server copy still holds the prefs.
  }
}

function initialState(): UserPrefsState {
  if (typeof window === "undefined")
    return { owner: null, status: "idle", prefs: EMPTY_USER_PREFS };
  // The last account's cache paints the right layout before the session answers.
  const owner = window.localStorage.getItem(LAST_OWNER_KEY);
  return { owner: null, status: "idle", prefs: owner ? readCache(owner) : EMPTY_USER_PREFS };
}

export const useUserPrefsStore = create<UserPrefsState>(initialState);

const dirty = new Set<UserPrefsKey>();
let pushTimer: ReturnType<typeof setTimeout> | null = null;
let syncGeneration = 0;

function pushSoon() {
  if (pushTimer !== null) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = null;
    void flushUserPrefs();
  }, PUSH_DELAY_MS);
}

export async function flushUserPrefs(): Promise<void> {
  const { owner, status, prefs } = useUserPrefsStore.getState();
  if (owner === null || status !== "ready" || dirty.size === 0) return;
  const patch: Record<string, unknown> = {};
  for (const key of dirty) patch[key] = prefs[key];
  dirty.clear();
  try {
    await lpRequest("/api/lp/prefs", { prefs: patch });
  } catch {
    for (const key of Object.keys(patch)) dirty.add(key as UserPrefsKey);
  }
}

function update(changes: Partial<UserPrefs>) {
  const state = useUserPrefsStore.getState();
  const prefs = { ...state.prefs, ...changes };
  useUserPrefsStore.setState({ prefs });
  for (const key of Object.keys(changes)) dirty.add(key as UserPrefsKey);
  if (state.owner !== null) {
    writeCache(state.owner, prefs);
    pushSoon();
  }
}

/** Loads the account's prefs once the session says who is signed in. */
export async function startUserPrefsSync(owner: string): Promise<void> {
  const state = useUserPrefsStore.getState();
  if (state.owner === owner && state.status !== "idle") return;
  const generation = ++syncGeneration;
  const local = state.owner === owner ? state.prefs : readCache(owner);
  useUserPrefsStore.setState({ owner, status: "loading", prefs: local });
  try {
    const response = await lpRequest<{ prefs?: unknown }>("/api/lp/prefs");
    if (generation !== syncGeneration) return;
    // Anything changed while loading is newer than both copies.
    const current = useUserPrefsStore.getState().prefs;
    const { prefs, push } = mergeUserPrefs(current, decodeUserPrefs(response.prefs));
    useUserPrefsStore.setState({ status: "ready", prefs });
    writeCache(owner, prefs);
    for (const key of Object.keys(push)) dirty.add(key as UserPrefsKey);
    if (dirty.size > 0) await flushUserPrefs();
  } catch {
    if (generation !== syncGeneration) return;
    // A server without the prefs route still gets a working, device-local layout.
    useUserPrefsStore.setState({ status: "offline" });
  }
}

const now = () => new Date().toISOString();

export function setActiveLayoutMode(activeModeId: string) {
  const { layout } = useUserPrefsStore.getState().prefs;
  if (layout.activeModeId === activeModeId) return;
  update({ layout: { ...layout, activeModeId, updatedAt: now() } });
}

export function saveCustomLayoutMode(mode: LayoutMode) {
  const { layout } = useUserPrefsStore.getState().prefs;
  const exists = layout.customModes.some((candidate) => candidate.id === mode.id);
  const customModes = exists
    ? layout.customModes.map((candidate) => (candidate.id === mode.id ? mode : candidate))
    : [...layout.customModes, mode].slice(0, MAX_CUSTOM_LAYOUT_MODES);
  update({ layout: { ...layout, customModes, updatedAt: now() } });
}

export function deleteCustomLayoutMode(id: string) {
  const { layout } = useUserPrefsStore.getState().prefs;
  update({
    layout: {
      activeModeId: layout.activeModeId === id ? null : layout.activeModeId,
      customModes: layout.customModes.filter((mode) => mode.id !== id),
      updatedAt: now(),
    },
  });
}

export function importCustomLayoutModes(modes: readonly LayoutMode[]) {
  const { layout } = useUserPrefsStore.getState().prefs;
  update({
    layout: {
      ...layout,
      customModes: mergeImportedLayoutModes(layout.customModes, modes),
      updatedAt: now(),
    },
  });
}

export function setWorkStyle(workStyle: WorkStyle) {
  update({ workStyle });
}

export function completeIntro(showTour: boolean) {
  update({
    intro: { completedAt: now(), tour: showTour ? "pending" : "skipped", updatedAt: now() },
  });
}

export function setTourState(tour: TourState) {
  const { intro } = useUserPrefsStore.getState().prefs;
  update({ intro: { ...intro, tour, updatedAt: now() } });
}

export function useActiveLayoutMode(): LayoutMode {
  const layout = useUserPrefsStore((state) => state.prefs.layout);
  const workStyle = useUserPrefsStore((state) => state.prefs.workStyle);
  return resolveLayoutMode(layout.activeModeId, layout.customModes, workStyle);
}

export function readActiveLayoutMode(): LayoutMode {
  const { layout, workStyle } = useUserPrefsStore.getState().prefs;
  return resolveLayoutMode(layout.activeModeId, layout.customModes, workStyle);
}
