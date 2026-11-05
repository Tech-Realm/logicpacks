import { EllipsisIcon } from "lucide-react";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";

import { chooseVisibleIds } from "./overflowToolbar.logic";

export interface OverflowToolbarItem {
  readonly id: string;
  /** Lower number = more important: the last to move into the tray. */
  readonly priority: number;
  readonly node: ReactNode;
}

const DEFAULT_GAP = 8;
const MORE_WIDTH = 28;
const TRAY_PAD = 6;
const TRAY_GAP = 4;

/**
 * A row of header controls that never collides with its neighbours: when `budget` pixels run
 * out, the least important controls move into a tray under a "more" button. Every control
 * stays mounted in one place (state, dialogs and popovers survive the move); a control in the
 * tray is only positioned there, under the row, and shown while the tray is open.
 * `budget` null means "everything fits" (not measured yet).
 */
export function OverflowToolbar(props: {
  readonly items: readonly OverflowToolbarItem[];
  readonly budget: number | null;
  readonly label?: string;
  readonly className?: string;
  readonly testId?: string;
  readonly gap?: number;
}) {
  const { items, budget, label = "More", className, testId, gap = DEFAULT_GAP } = props;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef(new Map<string, HTMLElement>());
  const [sizes, setSizes] = useState<Record<string, { w: number; h: number }>>({});
  const [open, setOpen] = useState(false);

  const itemKey = items.map((item) => item.id).join("|");
  // oxlint-disable-next-line logicpacks/no-unreasoned-state-sync -- measures the real size of each control; they change with their own content (avatars, names)
  useLayoutEffect(() => {
    const measure = () => {
      setSizes((previous) => {
        let changed = false;
        const next: Record<string, { w: number; h: number }> = {};
        for (const [id, element] of itemRefs.current) {
          const size = { w: Math.ceil(element.offsetWidth), h: Math.ceil(element.offsetHeight) };
          next[id] = size;
          const before = previous[id];
          if (before?.w !== size.w || before.h !== size.h) changed = true;
        }
        return changed || Object.keys(previous).length !== Object.keys(next).length
          ? next
          : previous;
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    for (const element of itemRefs.current.values()) observer.observe(element);
    return () => observer.disconnect();
  }, [itemKey]);

  const measured = items.every((item) => sizes[item.id] !== undefined);
  // A control that renders nothing (a button the viewer's role does not get) takes no part.
  const present = items.filter((item) => (sizes[item.id]?.w ?? 0) > 0);
  const visible = chooseVisibleIds(
    present.map((item) => ({ id: item.id, priority: item.priority, width: sizes[item.id]!.w })),
    measured ? budget : null,
    gap,
    MORE_WIDTH,
  );
  const overflowed = present.filter((item) => !visible.has(item.id));
  const hasOverflow = overflowed.length > 0;

  // oxlint-disable-next-line logicpacks/no-unreasoned-state-sync -- closes the tray once nothing is left in it
  useEffect(() => {
    if (!hasOverflow) setOpen(false);
  }, [hasOverflow]);
  // oxlint-disable-next-line logicpacks/no-unreasoned-state-sync -- document listeners that close the tray on an outside press or Escape
  useEffect(() => {
    if (!open) return;
    const onPress = (event: PointerEvent) => {
      if (event.target instanceof Node && rootRef.current?.contains(event.target)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPress, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPress, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Tray geometry: each moved control sits in a column under the row, right-aligned.
  const rowHeight = Math.max(28, ...overflowed.map((item) => sizes[item.id]?.h ?? 0));
  const trayWidth = Math.max(...overflowed.map((item) => sizes[item.id]?.w ?? 0), 0) + TRAY_PAD * 2;
  const trayHeight = overflowed.length * rowHeight + (overflowed.length - 1) * TRAY_GAP + TRAY_PAD * 2;
  const overflowIndex = new Map(overflowed.map((item, index) => [item.id, index]));

  return (
    <div
      ref={rootRef}
      className={cn("relative flex shrink-0 items-center", className)}
      style={{ gap }}
      data-lp-overflow-toolbar=""
      {...(testId ? { "data-testid": testId } : {})}
    >
      {items.map((item) => {
        const moved = overflowIndex.get(item.id);
        const inTray = moved !== undefined;
        return (
          <div
            key={item.id}
            ref={(element) => {
              if (element) itemRefs.current.set(item.id, element);
              else itemRefs.current.delete(item.id);
            }}
            data-lp-overflow-item={item.id}
            data-overflowed={inTray ? "true" : "false"}
            className={cn(
              "flex shrink-0 items-center",
              inTray && "absolute z-[61] w-max",
              inTray && !open && "pointer-events-none invisible",
            )}
            style={
              inTray
                ? {
                    right: TRAY_PAD,
                    top: `calc(100% + ${TRAY_GAP + TRAY_PAD + moved * (rowHeight + TRAY_GAP)}px)`,
                    height: rowHeight,
                  }
                : undefined
            }
            inert={inTray && !open}
          >
            {item.node}
          </div>
        );
      })}
      {hasOverflow ? (
        <>
          <button
            type="button"
            aria-label={label}
            aria-haspopup="true"
            aria-expanded={open}
            data-lp-overflow-trigger=""
            onClick={() => setOpen((value) => !value)}
            className="inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring [-webkit-app-region:no-drag]"
          >
            <EllipsisIcon aria-hidden="true" className="size-4" />
          </button>
          <div
            aria-hidden
            data-lp-overflow-tray=""
            className={cn(
              "absolute right-0 z-[60] rounded-lg border bg-popover shadow-lg/5",
              !open && "pointer-events-none invisible",
            )}
            style={{ top: `calc(100% + ${TRAY_GAP}px)`, width: trayWidth, height: trayHeight }}
          />
        </>
      ) : null}
    </div>
  );
}
