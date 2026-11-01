import type { ProductTourStep } from "./productTour";

export interface AnchorRect {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
}

/** Finds a step's anchor rect, or null when nothing matching is visible. */
export type AnchorLookup = (selector: string) => AnchorRect | null;

export function readAnchorRect(selector: string, root: ParentNode = document): AnchorRect | null {
  for (const element of root.querySelectorAll(selector)) {
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    return { top: rect.top, left: rect.left, width: rect.width, height: rect.height };
  }
  return null;
}

/**
 * The step to show when moving from `from` in `direction`: the first one whose anchor is on
 * screen. Steps without one are skipped. Null means the tour has run out of steps that way.
 */
export function resolveTourStep(
  steps: readonly ProductTourStep[],
  from: number,
  direction: 1 | -1,
  lookup: AnchorLookup,
): { readonly index: number; readonly rect: AnchorRect } | null {
  for (let index = from; index >= 0 && index < steps.length; index += direction) {
    const rect = lookup(steps[index]!.selector);
    if (rect) return { index, rect };
  }
  return null;
}

/** Steps the person will actually see, for the "2 of 9" counter. */
export function visibleTourSteps(
  steps: readonly ProductTourStep[],
  lookup: AnchorLookup,
): readonly number[] {
  return steps.flatMap((step, index) => (lookup(step.selector) ? [index] : []));
}

const CALLOUT_GAP = 12;
const VIEWPORT_MARGIN = 12;

/** Where the callout goes for a placement, kept inside the viewport. */
export function placeCallout(input: {
  readonly rect: AnchorRect;
  readonly placement: ProductTourStep["placement"];
  readonly width: number;
  readonly height: number;
  readonly viewport: { readonly width: number; readonly height: number };
}): { readonly top: number; readonly left: number } {
  const { rect, placement, width, height, viewport } = input;
  let top: number;
  let left: number;
  switch (placement) {
    case "top":
      top = rect.top - CALLOUT_GAP - height;
      left = rect.left + rect.width / 2 - width / 2;
      if (top < VIEWPORT_MARGIN) top = rect.top + rect.height + CALLOUT_GAP;
      break;
    case "left":
      top = rect.top + rect.height / 2 - height / 2;
      left = rect.left - CALLOUT_GAP - width;
      break;
    case "right":
      top = rect.top + rect.height / 2 - height / 2;
      left = rect.left + rect.width + CALLOUT_GAP;
      break;
    default:
      top = rect.top + rect.height + CALLOUT_GAP;
      left = rect.left + rect.width / 2 - width / 2;
      if (top + height > viewport.height - VIEWPORT_MARGIN) top = rect.top - CALLOUT_GAP - height;
  }
  return {
    top: Math.min(
      Math.max(top, VIEWPORT_MARGIN),
      Math.max(VIEWPORT_MARGIN, viewport.height - height - VIEWPORT_MARGIN),
    ),
    left: Math.min(
      Math.max(left, VIEWPORT_MARGIN),
      Math.max(VIEWPORT_MARGIN, viewport.width - width - VIEWPORT_MARGIN),
    ),
  };
}
