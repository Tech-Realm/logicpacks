import { XIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { Button } from "../components/ui/button";
import { PRODUCT_TOUR_STEPS } from "./productTour";
import {
  type AnchorRect,
  placeCallout,
  readAnchorRect,
  resolveTourStep,
  visibleTourSteps,
} from "./productTour.logic";
import { endProductTour, goToTourStep, useProductTourStore } from "./productTourStore";

/** How long a step waits for its anchor to render before it is skipped. */
const ANCHOR_WAIT_MS = 800;
const ANCHOR_POLL_MS = 100;
const SPOTLIGHT_PADDING = 6;
const CALLOUT_WIDTH = 320;

const isEditable = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));

/**
 * The tour engine, ported from v1 `ProductTourOverlay.tsx`: a spotlight on the step's anchor,
 * a callout with Back, Next and Skip, and the keyboard (arrows, Enter, Escape). A step whose
 * anchor never shows up is skipped in the direction of travel. Mounted once in the app shell.
 */
export function ProductTourOverlay() {
  const active = useProductTourStore((state) => state.active);
  const index = useProductTourStore((state) => state.index);
  const direction = useProductTourStore((state) => state.direction);
  const step = PRODUCT_TOUR_STEPS[index];
  // Keyed by step, so a rect measured for the previous step is never shown on the next one.
  const [measured, setMeasured] = useState<{ index: number; rect: AnchorRect | null }>({
    index: -1,
    rect: null,
  });
  const rect = measured.index === index ? measured.rect : null;
  const hasRect = rect !== null;
  const [calloutHeight, setCalloutHeight] = useState(160);
  const calloutRef = useRef<HTMLDivElement | null>(null);
  const nextRef = useRef<HTMLButtonElement | null>(null);

  // oxlint-disable-next-line logicpacks/no-unreasoned-state-sync -- polls the DOM for the step's anchor and skips the step when it never renders
  useEffect(() => {
    if (!active || !step) return;
    let cancelled = false;
    let waited = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      if (cancelled) return;
      const found = readAnchorRect(step.selector);
      if (found) {
        setMeasured({ index, rect: found });
        return;
      }
      if (waited < ANCHOR_WAIT_MS) {
        waited += ANCHOR_POLL_MS;
        timer = setTimeout(tick, ANCHOR_POLL_MS);
        return;
      }
      const next = resolveTourStep(
        PRODUCT_TOUR_STEPS,
        index + direction,
        direction,
        readAnchorRect,
      );
      if (next) goToTourStep(next.index, direction);
      else if (direction === 1) endProductTour("done");
      else {
        const forward = resolveTourStep(PRODUCT_TOUR_STEPS, index + 1, 1, readAnchorRect);
        if (forward) goToTourStep(forward.index, 1);
        else endProductTour("done");
      }
    };
    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [active, step, index, direction]);

  // oxlint-disable-next-line logicpacks/no-unreasoned-state-sync -- keeps the spotlight on its anchor across window scroll and resize
  useEffect(() => {
    if (!active || !step || !hasRect) return;
    const reposition = () => setMeasured({ index, rect: readAnchorRect(step.selector) });
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    return () => {
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
    };
  }, [active, step, index, hasRect]);

  // oxlint-disable-next-line logicpacks/no-unreasoned-state-sync -- measures the rendered callout so it can be placed inside the viewport
  useLayoutEffect(() => {
    if (!hasRect) return;
    const height = calloutRef.current?.offsetHeight;
    if (height) setCalloutHeight(height);
    nextRef.current?.focus({ preventScroll: true });
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- each new step re-measures the callout and moves focus to it
  }, [index, hasRect]);

  const visible = active && rect ? visibleTourSteps(PRODUCT_TOUR_STEPS, readAnchorRect) : [];
  const position = visible.indexOf(index);
  const previous = position > 0 ? visible[position - 1] : undefined;
  const following = position >= 0 ? visible[position + 1] : undefined;

  const next = () =>
    following === undefined ? endProductTour("done") : goToTourStep(following, 1);
  const back = () => {
    if (previous !== undefined) goToTourStep(previous, -1);
  };

  // oxlint-disable-next-line logicpacks/no-unreasoned-state-sync -- window keydown listener for the tour's keyboard controls
  useEffect(() => {
    if (!active || !rect) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        endProductTour("skipped");
        return;
      }
      if (isEditable(event.target) && !calloutRef.current?.contains(event.target as Node)) return;
      if (event.key === "ArrowRight") {
        event.preventDefault();
        next();
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        back();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  });

  if (!active || !step || !rect) return null;
  const isLast = following === undefined;
  const place = placeCallout({
    rect,
    placement: step.placement,
    width: CALLOUT_WIDTH,
    height: calloutHeight,
    viewport: { width: window.innerWidth, height: window.innerHeight },
  });

  return (
    <div className="pointer-events-none fixed inset-0 z-[100]" data-testid="lp-tour">
      <div
        aria-hidden
        data-testid="lp-tour-spotlight"
        className="absolute rounded-lg ring-2 ring-foreground motion-safe:transition-[top,left,width,height] motion-safe:duration-150"
        style={{
          top: rect.top - SPOTLIGHT_PADDING,
          left: rect.left - SPOTLIGHT_PADDING,
          width: rect.width + SPOTLIGHT_PADDING * 2,
          height: rect.height + SPOTLIGHT_PADDING * 2,
          boxShadow: "0 0 0 9999px rgb(0 0 0 / 0.45)",
        }}
      />
      <div
        ref={calloutRef}
        role="dialog"
        aria-modal="false"
        aria-labelledby="lp-tour-title"
        aria-describedby="lp-tour-body"
        data-testid="lp-tour-callout"
        data-tour-step={step.id}
        className="pointer-events-auto absolute rounded-panel border border-hairline bg-popover text-popover-foreground"
        style={{ top: place.top, left: place.left, width: CALLOUT_WIDTH }}
      >
        <div className="flex items-start justify-between gap-2 px-4 pt-4 pb-1.5">
          <h3 id="lp-tour-title" className="text-sm font-semibold leading-tight">
            {step.title}
          </h3>
          <button
            type="button"
            onClick={() => endProductTour("skipped")}
            aria-label="Skip tour"
            data-testid="lp-tour-close"
            className="-m-1 shrink-0 rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <XIcon className="size-3.5" />
          </button>
        </div>
        <p id="lp-tour-body" className="px-4 pb-3 text-xs leading-relaxed text-muted-foreground">
          {step.body}
        </p>
        <div className="flex items-center justify-between gap-2 border-t border-hairline px-4 py-2.5">
          <span className="text-2xs tabular-nums text-muted-foreground" data-testid="lp-tour-count">
            {position + 1} of {visible.length}
          </span>
          <div className="flex items-center gap-1.5">
            <Button
              size="xs"
              variant="ghost"
              onClick={() => endProductTour("skipped")}
              data-testid="lp-tour-skip"
            >
              Skip
            </Button>
            {previous !== undefined ? (
              <Button size="xs" variant="outline" onClick={back} data-testid="lp-tour-back">
                Back
              </Button>
            ) : null}
            <Button ref={nextRef} size="xs" onClick={next} data-testid="lp-tour-next">
              {isLast ? "Done" : "Next"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
