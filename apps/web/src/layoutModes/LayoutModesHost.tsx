import { useLocation } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import { useSidebar } from "../components/ui/sidebar";
import { toastManager } from "../components/ui/toast";
import { useLogicPacksSession } from "../logicpacks/store";
import { ProductTourOverlay } from "../productTour/ProductTourOverlay";
import { startProductTour, useProductTourStore } from "../productTour/productTourStore";
import { registerCommands } from "../shortcuts/dispatcher";
import { IntroDialog } from "./IntroDialog";
import { allLayoutModes } from "./layoutModes";
import {
  readActiveLayoutMode,
  setActiveLayoutMode,
  startUserPrefsSync,
  useActiveLayoutMode,
  useUserPrefsStore,
} from "./userPrefsStore";

const TOUR_START_DELAY_MS = 350;

/** Moves to the next layout mode, built-ins first, and says which one is on. */
export function cycleLayoutMode() {
  const { layout } = useUserPrefsStore.getState().prefs;
  const modes = allLayoutModes(layout.customModes);
  const current = readActiveLayoutMode();
  const next = modes[(modes.findIndex((mode) => mode.id === current.id) + 1) % modes.length]!;
  setActiveLayoutMode(next.id);
  toastManager.add({ id: "layout-cycle", title: `Layout: ${next.label}`, timeout: 1500 });
}

// Automated browsers (other agents' E2E suites) never asked for an intro; a test opts in.
function introAllowedHere(): boolean {
  if (typeof navigator === "undefined" || !navigator.webdriver) return true;
  try {
    return window.localStorage.getItem("lp:intro") === "on";
  } catch {
    return false;
  }
}

function isRoomPath(pathname: string) {
  return !/^\/(settings|usage|welcome|pair|connect|connect-agent|guest|demo)(\/|$)/.test(pathname);
}

/**
 * Lives in the app shell: loads the account's prefs, applies the mode's sidebar, owns the
 * layout shortcut, and shows the intro and the tour when the account is marked for them.
 */
export function LayoutModesHost({
  onSidebarWidth,
}: {
  readonly onSidebarWidth: (width: number) => void;
}) {
  const { session } = useLogicPacksSession();
  const owner = session === null ? null : (session.user?.userId ?? "operator");
  const status = useUserPrefsStore((state) => state.status);
  const syncedOwner = useUserPrefsStore((state) => state.owner);
  const intro = useUserPrefsStore((state) => state.prefs.intro);
  const tourActive = useProductTourStore((state) => state.active);
  const mode = useActiveLayoutMode();
  const { setOpen, isMobile } = useSidebar();
  const pathname = useLocation({ select: (location) => location.pathname });
  const appliedModeId = useRef<string | null>(null);

  // oxlint-disable-next-line logicpacks/no-unreasoned-state-sync -- starts the account prefs fetch once the LogicPacks session names the account
  useEffect(() => {
    if (owner !== null) void startUserPrefsSync(owner);
  }, [owner]);

  // oxlint-disable-next-line logicpacks/no-unreasoned-state-sync -- applies a newly picked mode to the sidebar, which owns its own open state
  useEffect(() => {
    const previous = appliedModeId.current;
    appliedModeId.current = mode.id;
    if (previous === null || previous === mode.id || isMobile) return;
    setOpen(mode.open.projects);
    onSidebarWidth(mode.widths.projects);
  }, [mode, isMobile, setOpen, onSidebarWidth]);

  // oxlint-disable-next-line logicpacks/no-unreasoned-state-sync -- registers the global layout shortcut with the keybinding dispatcher
  useEffect(
    () =>
      registerCommands({
        "layout.cycle": (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (!event.repeat) cycleLayoutMode();
        },
      }),
    [],
  );

  const prefsKnown =
    owner !== null && syncedOwner === owner && (status === "ready" || status === "offline");
  const roomOpen = isRoomPath(pathname);
  const showIntro = prefsKnown && roomOpen && intro.completedAt === null && introAllowedHere();
  const tourDue = prefsKnown && roomOpen && !showIntro && intro.tour === "pending" && !tourActive;

  // oxlint-disable-next-line logicpacks/no-unreasoned-state-sync -- starts the tour after the intro dialog has left the screen, so the first anchor is measurable
  useEffect(() => {
    if (!tourDue) return;
    const timer = setTimeout(startProductTour, TOUR_START_DELAY_MS);
    return () => clearTimeout(timer);
  }, [tourDue]);

  return (
    <>
      {showIntro ? <IntroDialog open /> : null}
      <ProductTourOverlay />
    </>
  );
}
