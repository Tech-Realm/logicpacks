import type { PresenceEntry } from "@logicpacks/contracts";

import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useNowMinute } from "~/hooks/useNowMinute";
import { cn } from "~/lib/utils";

import { presenceAvatars, presenceColor, presenceInitials, presenceLine } from "./presenceLogic";

const MAX_AVATARS = 4;

/**
 * Overlapping avatars for whoever is on a file, tab or app item right now.
 * People are circles, agents are rounded squares in their owner's colour.
 */
export function PresenceAvatarStack(props: {
  readonly entries: ReadonlyArray<PresenceEntry>;
  readonly className?: string;
  /** Hover lines name the file too, for stacks that cover several files. */
  readonly withPath?: boolean;
}) {
  // The tick is a UTC "YYYY-MM-DDTHH:MM" without a zone.
  const nowMs = Date.parse(`${useNowMinute()}Z`);
  const avatars = presenceAvatars(props.entries);
  if (avatars.length === 0) return null;
  const shown = avatars.slice(0, MAX_AVATARS);
  const overflow = avatars.length - shown.length;
  const lines = avatars.map(({ entries }) =>
    presenceLine(entries[0]!, nowMs, { withPath: props.withPath === true }),
  );
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={cn("inline-flex shrink-0 items-center -space-x-1", props.className)}
            data-presence-stack=""
            aria-label={lines.join(". ")}
          />
        }
      >
        {shown.map(({ actor }) => (
          <span
            key={actor.id}
            data-presence-actor={actor.id}
            className={cn(
              "inline-flex size-4 items-center justify-center text-5xs font-semibold leading-none text-primary-foreground ring-1 ring-background",
              actor.kind === "agent" ? "rounded-sm" : "rounded-full",
            )}
            style={{ backgroundColor: presenceColor(actor.colorIndex) }}
          >
            {presenceInitials(actor)}
          </span>
        ))}
        {overflow > 0 ? (
          <span className="inline-flex h-4 items-center rounded-full bg-muted px-1 text-5xs font-semibold text-muted-foreground ring-1 ring-background">
            +{overflow}
          </span>
        ) : null}
      </TooltipTrigger>
      <TooltipPopup>
        <div className="flex flex-col gap-0.5">
          {lines.map((line) => (
            <span key={line}>{line}</span>
          ))}
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}

/**
 * The remote caret the code editor draws inside its shadow root, so it is
 * styled inline: a coloured bar with a name flag above it.
 */
export function createPresenceCaretElement(caret: {
  readonly metadata: { readonly color: string; readonly name: string; readonly agent: boolean };
}): HTMLElement {
  const root = document.createElement("div");
  root.dataset.presenceCaret = caret.metadata.name;
  Object.assign(root.style, {
    position: "relative",
    width: "2px",
    height: "1.4em",
    background: caret.metadata.color,
    pointerEvents: "none",
  });
  const flag = document.createElement("div");
  flag.textContent = caret.metadata.name;
  Object.assign(flag.style, {
    position: "absolute",
    bottom: "100%",
    left: "0",
    padding: "1px 4px",
    borderRadius: caret.metadata.agent ? "2px" : "3px 3px 3px 0",
    background: caret.metadata.color,
    color: "var(--primary-foreground)",
    font: "600 10px/1.3 var(--font-sans, system-ui)",
    whiteSpace: "nowrap",
  });
  root.append(flag);
  return root;
}
