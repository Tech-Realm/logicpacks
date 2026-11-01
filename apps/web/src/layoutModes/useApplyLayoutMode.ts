import { scopedThreadKey } from "@logicpacks/client-runtime/environment";
import type { ScopedThreadRef } from "@logicpacks/contracts";
import { useEffect, useEffectEvent, useRef } from "react";

import { selectThreadRightPanelState, useRightPanelStore } from "../rightPanelStore";
import { useTerminalUiStateStore } from "../terminalUiStateStore";
import type { LayoutMode } from "./layoutModes";

/**
 * Applies the active layout mode to the open thread's panels.
 * - Switching modes opens or closes the workspace panel and terminal as the mode says.
 * - Opening a thread whose panel was never touched opens the mode's auto-open surface.
 */
export function useApplyLayoutMode(input: {
  readonly mode: LayoutMode;
  readonly threadRef: ScopedThreadRef | null;
  readonly workspaceAvailable: boolean;
  readonly diffAvailable: boolean;
  readonly terminalAvailable: boolean;
}) {
  const { mode, threadRef, workspaceAvailable, diffAvailable, terminalAvailable } = input;
  const appliedModeId = useRef<string | null>(null);
  const threadKey = threadRef ? scopedThreadKey(threadRef) : null;

  const apply = useEffectEvent(() => {
    if (!threadRef || !workspaceAvailable) return;
    const panels = useRightPanelStore.getState();
    const surface = mode.autoOpen === "diff" && !diffAvailable ? "files" : mode.autoOpen;
    const modeChanged = appliedModeId.current !== null && appliedModeId.current !== mode.id;
    appliedModeId.current = mode.id;
    if (modeChanged) {
      if (mode.open.workspace) panels.open(threadRef, surface === "none" ? "files" : surface);
      else panels.close(threadRef);
      if (terminalAvailable)
        useTerminalUiStateStore.getState().setTerminalOpen(threadRef, mode.open.terminal);
      return;
    }
    const state = selectThreadRightPanelState(panels.byThreadKey, threadRef);
    if (surface !== "none" && state.surfaces.length === 0) panels.open(threadRef, surface);
  });

  // oxlint-disable-next-line logicpacks/no-unreasoned-state-sync -- pushes the layout mode (an external prefs store) into the panel stores
  useEffect(() => {
    apply();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- runs per thread and per mode only; availability flips must not reopen a panel the person closed
  }, [threadKey, mode.id, workspaceAvailable]);
}
