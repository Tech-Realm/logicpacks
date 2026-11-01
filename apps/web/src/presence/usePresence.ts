import { useAtomValue } from "@effect/atom-react";
import {
  type EnvironmentId,
  PRESENCE_HEARTBEAT_MS,
  PRESENCE_THROTTLE_MS,
  type PresenceEntry,
  type PresenceLocation,
  type ProjectId,
  type ThreadId,
} from "@logicpacks/contracts";
import { Atom } from "effect/reactivity";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { useEffect, useRef } from "react";

import { isElectron } from "~/env";
import { useStableCallback } from "~/hooks/useStableCallback";
import { randomUUID } from "~/lib/utils";
import { presenceEnvironment } from "~/state/presence";
import { useAtomCommand } from "~/state/use-atom-command";

import { othersOnly } from "./presenceLogic";

/** One id per browser tab; each surface in the tab reports as `<tab>:<surface>`. */
export const PRESENCE_TAB_ID = `tab-${randomUUID()}`;
/** No input for this long and the user counts as away. */
const PRESENCE_IDLE_MS = 3 * 60_000;

const NO_PRESENCE_ATOM = Atom.make(
  AsyncResult.success<ReadonlyMap<string, PresenceEntry>>(new Map()),
);

/** Everyone else's live spot in a project, updated as they move. */
export function useProjectPresence(
  environmentId: EnvironmentId | null,
  projectId: ProjectId | null | undefined,
): ReadonlyArray<PresenceEntry> {
  const result = useAtomValue(
    environmentId && projectId
      ? presenceEnvironment.entries({ environmentId, input: { projectId } })
      : NO_PRESENCE_ATOM,
  );
  const entries = AsyncResult.getOrElse(result, () => null);
  return entries === null ? [] : othersOnly(entries.values(), PRESENCE_TAB_ID);
}

export interface PresenceReportTarget {
  readonly environmentId: EnvironmentId | null;
  readonly threadId?: ThreadId | null | undefined;
  readonly projectId?: ProjectId | null | undefined;
  /** Which part of this tab is reporting, e.g. "file" or "diff". */
  readonly surface: string;
  /** Null while this surface shows nothing worth sharing. */
  readonly location: PresenceLocation | null;
}

/**
 * Shares where this surface is. Moves are throttled, an unchanged spot is
 * refreshed while the user is active, and the spot is withdrawn when the tab
 * is hidden, the user goes idle, or the surface unmounts.
 */
interface ReporterState {
  location: PresenceLocation | null;
  lastSentAt: number;
  lastSentKey: string | null;
  timer: ReturnType<typeof setTimeout> | null;
  away: boolean;
  /** Set while mounted against a placement; pushes the latest location. */
  schedule: (() => void) | null;
}

export function usePresenceReporter(target: PresenceReportTarget): void {
  const send = useAtomCommand(presenceEnvironment.update, {
    reportFailure: false,
    reportDefect: false,
  });
  const sendLatest = useStableCallback(send);
  const environmentId = target.environmentId;
  const threadId = target.threadId ?? null;
  const projectId = target.projectId ?? null;
  const placed = environmentId !== null && (threadId !== null || projectId !== null);
  const locationKey = target.location === null ? null : JSON.stringify(target.location);
  const stateRef = useRef<ReporterState>({
    location: target.location,
    lastSentAt: 0,
    lastSentKey: null,
    timer: null,
    away: false,
    schedule: null,
  });
  const clientId = `${PRESENCE_TAB_ID}:${target.surface}`;
  const location = target.location;

  // Runs before the placement effect below, so a new placement sends the new location.
  // oxlint-disable-next-line logicpacks/no-unreasoned-state-sync -- a moved cursor is pushed to the server through the throttled sender
  useEffect(() => {
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- locationKey changes exactly when location does
    stateRef.current.location = location;
    stateRef.current.schedule?.();
  }, [locationKey]);

  // oxlint-disable-next-line logicpacks/no-unreasoned-state-sync -- presence is shared with the server over the socket; this owns the timers, idle listeners and the leave on unmount
  useEffect(() => {
    if (!placed || environmentId === null) return;
    const state = stateRef.current;
    const source = isElectron ? ("desktop" as const) : ("web" as const);
    const report = (location: PresenceLocation | null) =>
      void sendLatest({
        environmentId,
        input: {
          clientId,
          source,
          location,
          ...(threadId === null ? {} : { threadId }),
          ...(projectId === null ? {} : { projectId }),
        },
      });
    const flush = (force = false) => {
      state.timer = null;
      const location = state.away ? null : state.location;
      const key = location === null ? null : JSON.stringify(location);
      if (!force && key === state.lastSentKey) return;
      state.lastSentKey = key;
      state.lastSentAt = Date.now();
      report(location);
    };
    const schedule = () => {
      if (state.timer !== null) return;
      const wait = PRESENCE_THROTTLE_MS - (Date.now() - state.lastSentAt);
      if (wait <= 0) flush();
      else state.timer = setTimeout(() => flush(), wait);
    };
    let lastInputAt = Date.now();
    const onInput = () => {
      lastInputAt = Date.now();
      if (state.away && !document.hidden) {
        state.away = false;
        schedule();
      }
    };
    const onVisibility = () => {
      state.away = document.hidden;
      if (!document.hidden) lastInputAt = Date.now();
      schedule();
    };
    const heartbeat = setInterval(() => {
      if (!state.away && Date.now() - lastInputAt > PRESENCE_IDLE_MS) {
        state.away = true;
        schedule();
      } else if (!state.away && state.lastSentKey !== null) {
        flush(true);
      }
    }, PRESENCE_HEARTBEAT_MS);
    const inputEvents = ["pointerdown", "keydown", "wheel"] as const;
    for (const event of inputEvents) window.addEventListener(event, onInput, { passive: true });
    document.addEventListener("visibilitychange", onVisibility);
    state.away = document.hidden;
    state.schedule = schedule;
    schedule();
    return () => {
      clearInterval(heartbeat);
      if (state.timer !== null) clearTimeout(state.timer);
      state.timer = null;
      state.schedule = null;
      for (const event of inputEvents) window.removeEventListener(event, onInput);
      document.removeEventListener("visibilitychange", onVisibility);
      if (state.lastSentKey !== null) {
        state.lastSentKey = null;
        report(null);
      }
    };
  }, [placed, environmentId, threadId, projectId, clientId, sendLatest]);
}
