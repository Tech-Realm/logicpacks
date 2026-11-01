import { create } from "zustand";

import { setTourState } from "../layoutModes/userPrefsStore";

interface ProductTourState {
  readonly active: boolean;
  readonly index: number;
  /** Which way a missing anchor is skipped. */
  readonly direction: 1 | -1;
}

/** A global singleton, like the command palette's: menus anywhere start it, one overlay reads it. */
export const useProductTourStore = create<ProductTourState>(() => ({
  active: false,
  index: 0,
  direction: 1,
}));

export function startProductTour() {
  useProductTourStore.setState({ active: true, index: 0, direction: 1 });
}

export function goToTourStep(index: number, direction: 1 | -1) {
  useProductTourStore.setState({ index, direction });
}

export function endProductTour(outcome: "done" | "skipped") {
  useProductTourStore.setState({ active: false, index: 0, direction: 1 });
  setTourState(outcome);
}

/** Marks the account for the tour again; the shell starts it once a room is on screen. */
export function requestTourReplay() {
  setTourState("pending");
}
