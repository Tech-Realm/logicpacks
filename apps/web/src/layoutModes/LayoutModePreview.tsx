import { cn } from "../lib/utils";
import type { LayoutMode, LayoutPanel } from "./layoutModes";

const PREVIEW_CHAT_WIDTH = 520;

/**
 * A small wireframe of a mode: the canvas, the sidebar, and the sheet holding chat and the
 * workspace panel at their relative widths. Static markup, nothing animates.
 */
export function LayoutModePreview({
  mode,
  className,
}: {
  readonly mode: LayoutMode;
  readonly className?: string;
}) {
  const grow: Record<LayoutPanel, number> = {
    projects: mode.open.projects ? mode.widths.projects : 0,
    chat: PREVIEW_CHAT_WIDTH,
    workspace: mode.open.workspace ? mode.widths.workspace : 0,
  };
  return (
    <div
      aria-hidden
      data-testid="lp-layout-preview"
      data-layout-preview={mode.id}
      className={cn("flex aspect-[16/10] w-full gap-1 rounded-md bg-muted p-1", className)}
    >
      {grow.projects > 0 ? (
        <div className="flex flex-col gap-1 p-1" style={{ flexGrow: grow.projects, flexBasis: 0 }}>
          <span className="h-1 w-3/4 rounded-full bg-foreground/40" />
          <span className="h-1 w-1/2 rounded-full bg-foreground/20" />
          <span className="h-1 w-2/3 rounded-full bg-foreground/20" />
        </div>
      ) : null}
      <div
        className="flex min-w-0 overflow-hidden rounded-sm border border-hairline bg-background"
        style={{ flexGrow: grow.chat + grow.workspace, flexBasis: 0 }}
      >
        {mode.order
          .filter((panel) => panel !== "projects" && grow[panel] > 0)
          .map((panel, index) => (
            <div
              key={panel}
              data-preview-panel={panel}
              className={cn("flex min-w-0 flex-col", index > 0 && "border-l border-hairline")}
              style={{ flexGrow: grow[panel], flexBasis: 0 }}
            >
              {panel === "chat" ? (
                <div className="flex flex-1 flex-col justify-end gap-1 p-1.5">
                  <span className="ml-auto h-1.5 w-1/2 rounded-full bg-foreground/25" />
                  <span className="h-1 w-3/4 rounded-full bg-foreground/15" />
                  <span className="h-1 w-2/3 rounded-full bg-foreground/15" />
                  <span className="mt-1 h-2.5 rounded-sm border border-foreground/30" />
                </div>
              ) : (
                <div className="flex flex-1 gap-1 p-1.5">
                  <div className="flex w-1/4 flex-col gap-1">
                    <span className="h-1 rounded-full bg-foreground/30" />
                    <span className="h-1 rounded-full bg-foreground/15" />
                    <span className="h-1 rounded-full bg-foreground/15" />
                  </div>
                  <div className="flex flex-1 flex-col gap-1 border-l border-hairline pl-1">
                    <span className="h-1 w-2/3 rounded-full bg-foreground/20" />
                    <span className="h-1 w-1/2 rounded-full bg-foreground/20" />
                    <span className="h-1 w-3/4 rounded-full bg-foreground/20" />
                  </div>
                </div>
              )}
              {mode.open.terminal && panel === "chat" ? (
                <span className="h-3 border-t border-hairline bg-foreground/10" />
              ) : null}
            </div>
          ))}
      </div>
    </div>
  );
}
