import { useEffect } from "react";
import { create } from "zustand";

import { lpApi, type LpCloudHost, type LpProjectSync } from "./api";

interface SyncStoreState {
  readonly cloud: LpCloudHost | null;
  readonly byProject: Readonly<Record<string, LpProjectSync>>;
}

const useSyncStore = create<SyncStoreState>(() => ({ cloud: null, byProject: {} }));

const FAST_MS = 1_500;
const SLOW_MS = 5_000;

let pending: Promise<void> | null = null;

/** One small JSON read for every visible project; the server keeps the state, git does the work. */
export function refreshSyncStatus(): Promise<void> {
  if (pending) return pending;
  pending = lpApi
    .syncStatus()
    .then((result) =>
      useSyncStore.setState({
        cloud: result.cloud,
        byProject: Object.fromEntries(result.projects.map((status) => [status.projectId, status])),
      }),
    )
    .catch(() => undefined)
    .finally(() => {
      pending = null;
    });
  return pending;
}

export function applySyncStatus(status: LpProjectSync) {
  useSyncStore.setState((state) => ({
    byProject: { ...state.byProject, [status.projectId]: status },
  }));
}

/** Polls while the app is open: quickly while something is syncing, gently otherwise. */
export function useLpSyncPolling(enabled: boolean) {
  // oxlint-disable-next-line logicpacks/no-unreasoned-state-sync -- polls the server's sync state while signed in
  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const loop = async () => {
      if (stopped) return;
      if (typeof document === "undefined" || document.visibilityState !== "hidden") {
        await refreshSyncStatus();
      }
      if (stopped) return;
      const syncing = Object.values(useSyncStore.getState().byProject).some(
        (status) => status.state === "syncing",
      );
      timer = setTimeout(() => void loop(), syncing ? FAST_MS : SLOW_MS);
    };
    void loop();
    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [enabled]);
}

export const useProjectSync = (projectId: string | null) =>
  useSyncStore((state) => (projectId === null ? null : (state.byProject[projectId] ?? null)));

export const useCloudHost = () => useSyncStore((state) => state.cloud);

export const readCloudHost = () => useSyncStore.getState().cloud;
