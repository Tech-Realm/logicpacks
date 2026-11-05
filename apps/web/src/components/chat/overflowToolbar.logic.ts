export interface OverflowCandidate {
  readonly id: string;
  /** Lower number = more important: it is the last to move into the overflow tray. */
  readonly priority: number;
  readonly width: number;
}

/**
 * Which items stay in the bar. Takes the most important items that fit in `budget` together
 * with the "more" button (only needed when something moves out). With no budget everything
 * stays. Items that never fit still leave the "more" button, so nothing becomes unreachable.
 */
export function chooseVisibleIds(
  items: readonly OverflowCandidate[],
  budget: number | null,
  gap: number,
  moreWidth: number,
): ReadonlySet<string> {
  const all = new Set(items.map((item) => item.id));
  if (budget === null || items.length === 0) return all;
  const byPriority = items.toSorted((a, b) => a.priority - b.priority);
  const widthOf = (count: number, withMore: boolean) => {
    const kept = byPriority.slice(0, count);
    const slots = kept.length + (withMore ? 1 : 0);
    const total = kept.reduce((sum, item) => sum + item.width, 0) + (withMore ? moreWidth : 0);
    return total + Math.max(0, slots - 1) * gap;
  };
  if (widthOf(items.length, false) <= budget) return all;
  for (let count = items.length - 1; count > 0; count--) {
    if (widthOf(count, true) <= budget) {
      return new Set(byPriority.slice(0, count).map((item) => item.id));
    }
  }
  return new Set();
}
