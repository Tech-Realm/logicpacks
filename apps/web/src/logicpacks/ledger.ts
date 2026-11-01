import { useEffect } from "react";
import { create } from "zustand";

import { lpApi, type LpProjectLedger, type LpThreadLedger } from "./api";

interface LedgerStoreState {
  readonly byThread: Readonly<Record<string, LpThreadLedger | null>>;
  readonly byProject: Readonly<Record<string, LpProjectLedger>>;
}

const useLedgerStore = create<LedgerStoreState>(() => ({ byThread: {}, byProject: {} }));

const THREAD_MS = 2_500;
const PROJECT_MS = 4_000;

export async function refreshThreadLedger(threadId: string): Promise<void> {
  const view = await lpApi.threadLedger(threadId).catch(() => undefined);
  if (view === undefined) return;
  useLedgerStore.setState((state) => ({ byThread: { ...state.byThread, [threadId]: view } }));
}

export async function refreshProjectLedger(projectId: string): Promise<void> {
  const view = await lpApi.projectLedger(projectId).catch(() => undefined);
  if (view === undefined) return;
  useLedgerStore.setState((state) => ({ byProject: { ...state.byProject, [projectId]: view } }));
}

/** Polls one small JSON read while `key` is set and the tab is visible. */
function usePolling(
  key: string | null,
  intervalMs: number,
  refresh: (key: string) => Promise<void>,
) {
  // oxlint-disable-next-line logicpacks/no-unreasoned-state-sync -- polls the server's ledger while a thread or popover is open
  useEffect(() => {
    if (key === null) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const loop = async () => {
      if (stopped) return;
      if (typeof document === "undefined" || document.visibilityState !== "hidden") {
        await refresh(key);
      }
      if (!stopped) timer = setTimeout(() => void loop(), intervalMs);
    };
    void loop();
    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [key, intervalMs, refresh]);
}

/** The open thread's notices, conflicts and negotiations. */
export function useThreadLedger(threadId: string | null): LpThreadLedger | null {
  usePolling(threadId, THREAD_MS, refreshThreadLedger);
  return useLedgerStore((state) => (threadId === null ? null : (state.byThread[threadId] ?? null)));
}

/** Who is working on what in a project; polled only while someone looks. */
export function useProjectLedger(projectId: string | null): LpProjectLedger | null {
  usePolling(projectId, PROJECT_MS, refreshProjectLedger);
  return useLedgerStore((state) =>
    projectId === null ? null : (state.byProject[projectId] ?? null),
  );
}

/** Drops notices locally at once; the server forgets them on the next read. */
export function hideNotices(threadId: string, messageIds: ReadonlyArray<string>) {
  const hidden = new Set(messageIds);
  useLedgerStore.setState((state) => {
    const view = state.byThread[threadId];
    if (!view) return state;
    return {
      byThread: {
        ...state.byThread,
        [threadId]: { ...view, notices: view.notices.filter((notice) => !hidden.has(notice.id)) },
      },
    };
  });
}

export const ledgerAgo = (atMs: number, nowMs: number) => {
  const minutes = Math.max(0, Math.floor((nowMs - atMs) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
};
