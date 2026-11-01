import { describe, expect, it } from "vite-plus/test";

import { PRODUCT_TOUR_STEPS, type ProductTourStep } from "./productTour";
import {
  type AnchorLookup,
  placeCallout,
  resolveTourStep,
  visibleTourSteps,
} from "./productTour.logic";

const step = (id: string): ProductTourStep => ({
  id,
  title: id,
  body: id,
  selector: `[data-tour="${id}"]`,
  placement: "bottom",
});
const steps = ["a", "b", "c", "d"].map(step);
const rect = { top: 10, left: 10, width: 20, height: 20 };
const present =
  (...ids: string[]): AnchorLookup =>
  (selector) =>
    ids.some((id) => selector === `[data-tour="${id}"]`) ? rect : null;

describe("tour step resolver", () => {
  it("skips steps whose anchor is missing, in the direction of travel", () => {
    const lookup = present("a", "d");
    expect(resolveTourStep(steps, 1, 1, lookup)?.index).toBe(3);
    expect(resolveTourStep(steps, 2, -1, lookup)?.index).toBe(0);
  });

  it("returns null when no anchor is left that way", () => {
    expect(resolveTourStep(steps, 1, 1, present("a"))).toBeNull();
    expect(resolveTourStep(steps, 0, 1, present())).toBeNull();
  });

  it("counts only the steps on screen", () => {
    expect(visibleTourSteps(steps, present("b", "c"))).toEqual([1, 2]);
  });

  it("has unique step ids and no sidebar Beta anchors", () => {
    const ids = PRODUCT_TOUR_STEPS.map((tourStep) => tourStep.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(PRODUCT_TOUR_STEPS.some((tourStep) => tourStep.selector.includes("lp-beta"))).toBe(
      false,
    );
  });
});

describe("callout placement", () => {
  const viewport = { width: 1000, height: 800 };
  it("flips a bottom callout above when it would run off the viewport", () => {
    const low = { top: 760, left: 400, width: 100, height: 30 };
    const placed = placeCallout({
      rect: low,
      placement: "bottom",
      width: 320,
      height: 150,
      viewport,
    });
    expect(placed.top).toBe(760 - 12 - 150);
  });

  it("keeps a callout inside the left and right edges", () => {
    const edge = { top: 100, left: 0, width: 10, height: 10 };
    expect(
      placeCallout({ rect: edge, placement: "bottom", width: 320, height: 150, viewport }).left,
    ).toBe(12);
  });
});
