import { type RefObject, useEffect, useState } from "react";

/** Fired by the window-level titlebar controls whenever their size or presence changes. */
export const TITLEBAR_CONTROLS_CHANGED_EVENT = "lp-titlebar-controls-changed";

/** The least room the project chip and thread title keep before controls move into "more". */
const BREADCRUMB_MIN_WIDTH = 130;
const GAP_TO_CONTROLS = 12;

export interface ChatHeaderBudget {
  /** Right padding that keeps the header clear of the fixed titlebar controls on top of it. */
  readonly inset: number;
  /** Pixels the header's own right-hand controls may use. */
  readonly budget: number;
}

/**
 * Measures the chat header against the window-level titlebar controls (maximize, layout,
 * panel toggles). Those are fixed to the window corner, so on a narrow chat column they sit
 * on top of the header. The result tells the header how much to pad and how wide its own
 * controls may be.
 */
export function useChatHeaderBudget(rootRef: RefObject<HTMLElement | null>): ChatHeaderBudget | null {
  const [result, setResult] = useState<ChatHeaderBudget | null>(null);
  // oxlint-disable-next-line logicpacks/no-unreasoned-state-sync -- measures DOM geometry (header and the fixed titlebar controls) on resize
  useEffect(() => {
    const root = rootRef.current;
    const header = root?.closest<HTMLElement>("[data-chat-header]") ?? null;
    if (!root || !header) return;
    const measure = () => {
      const headerBox = header.getBoundingClientRect();
      let inset = 0;
      for (const cluster of document.querySelectorAll<HTMLElement>(
        "[data-workspace-titlebar-controls]",
      )) {
        const box = cluster.getBoundingClientRect();
        const overlaps =
          box.width > 0 &&
          box.bottom > headerBox.top &&
          box.top < headerBox.bottom &&
          box.right > headerBox.left &&
          box.left < headerBox.right;
        if (overlaps) {
          const padding = Number.parseFloat(getComputedStyle(header).paddingRight) || 0;
          inset = Math.max(inset, headerBox.right - box.left - padding + GAP_TO_CONTROLS);
        }
      }
      const rootBox = root.getBoundingClientRect();
      const next = {
        inset: Math.round(inset),
        budget: Math.max(0, Math.floor(rootBox.width - inset - BREADCRUMB_MIN_WIDTH - GAP_TO_CONTROLS)),
      };
      setResult((previous) =>
        previous?.inset === next.inset && previous.budget === next.budget ? previous : next,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(header);
    observer.observe(root);
    window.addEventListener("resize", measure);
    window.addEventListener(TITLEBAR_CONTROLS_CHANGED_EVENT, measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener(TITLEBAR_CONTROLS_CHANGED_EVENT, measure);
    };
  }, [rootRef]);
  return result;
}
