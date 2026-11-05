import { PanelBottomIcon, PanelRightIcon, SquareMenuIcon } from "lucide-react";
import { Maximize2, Minimize2 } from "lucide";
import { MorphIcon } from "~/components/MorphIcon";
import { memo, type ReactNode, useEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";

import { TITLEBAR_CONTROLS_CHANGED_EVENT } from "./useChatHeaderBudget";
import { LayoutModeSwitcher } from "./LayoutModeSwitcher";
import { OverflowToolbar, type OverflowToolbarItem } from "./OverflowToolbar";

import type { ThreadPanelPresentation } from "../../rightPanelLayout";
import { PopoverCreateHandle, PopoverTrigger } from "../ui/popover";
import { Toggle } from "../ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export interface PanelLayoutControlsProps {
  showThreadPanelControl?: boolean;
  showTerminalControl?: boolean;
  showRightPanelControl?: boolean;
  terminalAvailable: boolean;
  terminalOpen: boolean;
  terminalShortcutLabel: string | null;
  threadPanelOpen: boolean;
  threadPanelPresentation: ThreadPanelPresentation;
  threadPanelPopoverHandle?: ReturnType<typeof PopoverCreateHandle>;
  threadPanelShortcutLabel: string | null;
  rightPanelAvailable: boolean;
  rightPanelOpen: boolean;
  rightPanelShortcutLabel: string | null;
  rightPanelUnavailableLabel?: string;
  layoutShortcutLabel?: string | null;
  /** The maximize toggle (shown while the panel is open); it joins the row so it can overflow too. */
  maximizeControl?: ReactNode;
  /** Pixels the row may use; null = unlimited. Controls that do not fit move into "more". */
  budget?: number | null;
  onToggleTerminal: () => void;
  onToggleThreadPanel: () => void;
  onToggleRightPanel: () => void;
}

export const PanelLayoutControls = memo(function PanelLayoutControls({
  showThreadPanelControl = true,
  showTerminalControl = true,
  showRightPanelControl = true,
  terminalAvailable,
  terminalOpen,
  terminalShortcutLabel,
  threadPanelOpen,
  threadPanelPresentation,
  threadPanelPopoverHandle,
  threadPanelShortcutLabel,
  rightPanelAvailable,
  rightPanelOpen,
  rightPanelShortcutLabel,
  rightPanelUnavailableLabel = "Right panel is unavailable",
  layoutShortcutLabel = null,
  maximizeControl = null,
  budget = null,
  onToggleTerminal,
  onToggleThreadPanel,
  onToggleRightPanel,
}: PanelLayoutControlsProps) {
  const threadPanelToggle = (
    <Toggle
      className="relative shrink-0 [-webkit-app-region:no-drag]"
      pressed={threadPanelOpen}
      onPressedChange={threadPanelPresentation === "popover" ? undefined : onToggleThreadPanel}
      aria-label="Toggle thread details panel"
      variant="ghost"
      size="sm"
    >
      <SquareMenuIcon className="size-4" />
    </Toggle>
  );
  const threadPanelControl = (
    <Tooltip>
      <TooltipTrigger render={<span className="flex shrink-0" />}>
        {threadPanelPresentation === "popover" ? (
          <PopoverTrigger handle={threadPanelPopoverHandle} render={threadPanelToggle} />
        ) : (
          threadPanelToggle
        )}
      </TooltipTrigger>
      <TooltipPopup side="bottom">
        {threadPanelOpen ? "Hide" : "Show"} the details panel: machine, branch, changes, lineage
        {threadPanelShortcutLabel ? ` (${threadPanelShortcutLabel})` : ""}
      </TooltipPopup>
    </Tooltip>
  );

  const terminalControl = showTerminalControl ? (
    <Tooltip>
          <TooltipTrigger render={<span className="flex shrink-0" />}>
            <Toggle
              className="shrink-0 [-webkit-app-region:no-drag]"
              pressed={terminalOpen}
              onPressedChange={onToggleTerminal}
              aria-label="Toggle terminal drawer"
              variant="ghost"
              size="sm"
              disabled={!terminalAvailable}
            >
              <PanelBottomIcon className="size-4" />
            </Toggle>
          </TooltipTrigger>
          <TooltipPopup side="bottom">
            {terminalAvailable
              ? `Toggle terminal drawer${terminalShortcutLabel ? ` (${terminalShortcutLabel})` : ""}`
              : "Terminal drawer is unavailable"}
          </TooltipPopup>
        </Tooltip>
  ) : null;
  const rightPanelControl = showRightPanelControl ? (
    <Tooltip>
          <TooltipTrigger render={<span className="flex shrink-0" />}>
            <Toggle
              className="shrink-0 [-webkit-app-region:no-drag]"
              pressed={rightPanelOpen}
              onPressedChange={onToggleRightPanel}
              aria-label="Toggle right panel"
              data-right-panel-toggle
              data-tour="right-panel"
              variant="ghost"
              size="sm"
              disabled={!rightPanelAvailable}
            >
              <PanelRightIcon className="size-4" />
            </Toggle>
          </TooltipTrigger>
          <TooltipPopup side="bottom">
            {rightPanelAvailable
              ? `Toggle right panel${rightPanelShortcutLabel ? ` (${rightPanelShortcutLabel})` : ""}`
              : rightPanelUnavailableLabel}
          </TooltipPopup>
        </Tooltip>
  ) : null;
  const items: OverflowToolbarItem[] = [];
  if (maximizeControl) items.push({ id: "maximize", priority: 3, node: maximizeControl });
  if (showRightPanelControl) {
    items.push({
      id: "layout",
      priority: 2,
      node: <LayoutModeSwitcher shortcutLabel={layoutShortcutLabel} />,
    });
  }
  if (showThreadPanelControl) items.push({ id: "thread-panel", priority: 5, node: threadPanelControl });
  if (terminalControl) items.push({ id: "terminal", priority: 4, node: terminalControl });
  if (rightPanelControl) items.push({ id: "right-panel", priority: 1, node: rightPanelControl });

  return (
    <OverflowToolbar
      items={items}
      budget={budget}
      gap={4}
      label="More layout controls"
      className="h-full [-webkit-app-region:no-drag]"
      testId="lp-titlebar-controls"
    />
  );
});

export const RightPanelMaximizeControl = memo(function RightPanelMaximizeControl({
  maximized,
  onToggle,
}: {
  maximized: boolean;
  onToggle: () => void;
}) {
  const label = maximized ? "Restore panel size" : "Maximize panel";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Toggle
            className="shrink-0 [-webkit-app-region:no-drag]"
            pressed={maximized}
            onPressedChange={onToggle}
            aria-label={label}
            variant="ghost"
            size="sm"
          >
            <MorphIcon className="size-4" icon={maximized ? Minimize2 : Maximize2} />
          </Toggle>
        }
      />
      <TooltipPopup side="bottom">{label}</TooltipPopup>
    </Tooltip>
  );
});

/** The thread panel toggle on a header whose right side the inline right panel covers. */
export function ThreadPanelHeaderControl(props: PanelLayoutControlsProps) {
  return (
    <div
      className="absolute top-[var(--workspace-controls-top)] right-[calc(env(safe-area-inset-right)+0.75rem)] z-50 flex h-[var(--workspace-topbar-height)] items-center [-webkit-app-region:no-drag]"
      data-workspace-titlebar-controls
    >
      <PanelLayoutControls {...props} showTerminalControl={false} showRightPanelControl={false} />
    </div>
  );
}

/** What the window's top-right controls hand to their row. */
export interface TitlebarControlsSlot {
  readonly maximizeControl: ReactNode;
  readonly budget: number | null;
}

/**
 * The window's top-right panel controls, with the maximize toggle while the panel is open.
 * They are fixed to the window corner, which on a narrow chat column is the column's header:
 * the row may use at most half of that column, and what does not fit moves into "more".
 */
export function WorkspaceTitlebarControls(props: {
  readonly showMaximizeControl: boolean;
  readonly rightPanelOpen: boolean;
  readonly maximized: boolean;
  readonly onToggleMaximized: () => void;
  readonly children: (slot: TitlebarControlsSlot) => ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [budget, setBudget] = useState<number | null>(null);
  // oxlint-disable-next-line logicpacks/no-unreasoned-state-sync -- measures the chat column the fixed controls sit over, and tells the header when the controls change size
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => {
      const column = document.querySelector<HTMLElement>("[data-chat-column]");
      const right = element.getBoundingClientRect().right;
      const box = column?.getBoundingClientRect();
      const over = box !== undefined && right <= box.right + 2 && right > box.left;
      const next = over ? Math.max(0, Math.floor(box.width * 0.5)) : null;
      setBudget((previous) => (previous === next ? previous : next));
      window.dispatchEvent(new Event(TITLEBAR_CONTROLS_CHANGED_EVENT));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    const column = document.querySelector<HTMLElement>("[data-chat-column]");
    if (column) observer.observe(column);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
      window.dispatchEvent(new Event(TITLEBAR_CONTROLS_CHANGED_EVENT));
    };
  }, []);
  return (
    <div
      ref={ref}
      className="pointer-events-none fixed top-[var(--workspace-controls-top)] right-[var(--workspace-controls-right)] z-50 mr-px flex h-[var(--workspace-topbar-height)] items-center gap-1 [-webkit-app-region:no-drag]"
      data-workspace-titlebar-controls
    >
      <div className="pointer-events-auto flex h-full items-center">
        {props.children({
          budget,
          maximizeControl:
            props.showMaximizeControl && props.rightPanelOpen ? (
              <RightPanelMaximizeControl
                maximized={props.maximized}
                onToggle={props.onToggleMaximized}
              />
            ) : null,
        })}
      </div>
    </div>
  );
}
