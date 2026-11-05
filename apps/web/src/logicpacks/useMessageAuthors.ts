import { useEffect, useSyncExternalStore } from "react";

import { lpRequest } from "./api";
import {
  AUTHOR_RETRY_DELAYS_MS,
  selectNametag,
  type LpMessageAuthors,
  type LpNametag,
} from "./messageAuthors.logic";
import { useLogicPacksSession } from "./store";

const EMPTY: LpMessageAuthors = {};
const cache = new Map<string, LpMessageAuthors>();
const inflight = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();

const emit = () => listeners.forEach((listener) => listener());

/** One shared fetch per thread, however many rows ask. */
function fetchAuthors(threadId: string): Promise<void> {
  const pending = inflight.get(threadId);
  if (pending !== undefined) return pending;
  const run = lpRequest<{ authors: LpMessageAuthors }>(
    `/api/lp/messages/authors?threadId=${encodeURIComponent(threadId)}`,
  )
    .then((result) => {
      cache.set(threadId, result.authors);
      emit();
    })
    .catch(() => undefined)
    .finally(() => inflight.delete(threadId));
  inflight.set(threadId, run);
  return run;
}

if (typeof window !== "undefined") {
  window.addEventListener("focus", () => {
    for (const threadId of cache.keys()) void fetchAuthors(threadId);
  });
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/**
 * The name tag for one user message, or null (solo thread, unknown author, or not loaded).
 * Fetches the thread's authors, and retries with backoff while this message is unknown.
 */
export function useMessageNametag(
  threadId: string | null,
  messageId: string,
): LpNametag | null {
  const { session, status } = useLogicPacksSession(false);
  const authors = useSyncExternalStore(
    subscribe,
    () => (threadId === null ? EMPTY : (cache.get(threadId) ?? EMPTY)),
    () => EMPTY,
  );
  const known = authors[messageId] !== undefined;
  // oxlint-disable-next-line logicpacks/no-unreasoned-state-sync -- fetches message authors from the LogicPacks API and retries while this message is unattributed
  useEffect(() => {
    if (threadId === null || known) return;
    let live = true;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      void fetchAuthors(threadId).then(() => {
        if (!live || (cache.get(threadId) ?? EMPTY)[messageId] !== undefined) return;
        const delay = AUTHOR_RETRY_DELAYS_MS[attempt++];
        if (delay !== undefined) timer = setTimeout(tick, delay);
      });
    };
    tick();
    return () => {
      live = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [threadId, messageId, known]);
  const viewerUserId = status === "ready" ? (session?.user?.userId ?? null) : undefined;
  return selectNametag({ authors, messageId, viewerUserId });
}
