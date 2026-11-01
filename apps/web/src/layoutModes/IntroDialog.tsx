import { useState } from "react";

import { cn } from "../lib/utils";
import { Button } from "../components/ui/button";
import { Checkbox } from "../components/ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../components/ui/dialog";
import { LayoutModePreview } from "./LayoutModePreview";
import { BUILT_IN_LAYOUT_MODES, defaultLayoutModeId } from "./layoutModes";
import { completeIntro, setActiveLayoutMode, useUserPrefsStore } from "./userPrefsStore";

const SCREENS = [
  {
    title: "Build with your team and your agents",
    body: [
      "LogicPacks is one shared room for a project: the people, their agents and the code.",
      "Your agent works in your thread. Teammates work in theirs, in the same project, and everyone can see who is on what.",
    ],
  },
  {
    title: "Share and invite",
    body: [
      "Invite people to your workspace from the sidebar.",
      "Share a project from its top bar. Teammates open their own threads in it, and agents check what others are doing before they start.",
    ],
  },
  {
    title: "Delegate with guardrails",
    body: [
      "Give an agent a goal with milestones and limits. It reports back and flags drift before it costs you.",
      "Goals is in beta. Packs let you reuse what worked in another thread or project.",
    ],
  },
] as const;

/**
 * The short intro after sign-in: what LogicPacks is, then a layout pick. It starts on the
 * layout the onboarding answer suggests (developer: Dev, otherwise Vibe), and its last
 * screen marks the person for the in-app tour unless they untick it.
 */
export function IntroDialog({ open }: { readonly open: boolean }) {
  const workStyle = useUserPrefsStore((state) => state.prefs.workStyle);
  const [screen, setScreen] = useState(0);
  const [modeId, setModeId] = useState<string | null>(null);
  const [showTour, setShowTour] = useState(true);
  const pickedModeId = modeId ?? defaultLayoutModeId(workStyle);
  const last = screen === SCREENS.length;
  const total = SCREENS.length + 1;

  const finish = () => {
    setActiveLayoutMode(pickedModeId);
    completeIntro(showTour);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && completeIntro(false)}>
      <DialogPopup className="max-w-lg" data-testid="lp-intro" data-intro-screen={screen}>
        {last ? (
          <>
            <DialogHeader>
              <DialogTitle>Pick your layout</DialogTitle>
              <DialogDescription>
                You can switch any time from the top bar, or press Cmd+Alt+L.
              </DialogDescription>
            </DialogHeader>
            <DialogPanel>
              <div
                role="radiogroup"
                aria-label="Layout"
                className="grid grid-cols-2 divide-x divide-hairline overflow-hidden rounded-panel border border-hairline"
              >
                {BUILT_IN_LAYOUT_MODES.map((mode) => {
                  const checked = mode.id === pickedModeId;
                  return (
                    <button
                      key={mode.id}
                      type="button"
                      role="radio"
                      aria-checked={checked}
                      data-testid={`lp-intro-layout-${mode.id}`}
                      onClick={() => setModeId(mode.id)}
                      className={cn(
                        "flex flex-col gap-2 p-3 text-left transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                        checked ? "bg-accent" : "hover:bg-accent/50",
                      )}
                    >
                      <LayoutModePreview mode={mode} />
                      <span className="flex items-center gap-2 text-sm font-medium">
                        <span
                          aria-hidden
                          className={cn(
                            "size-3 rounded-full border border-foreground/50",
                            checked && "border-4 border-foreground",
                          )}
                        />
                        {mode.label}
                      </span>
                      <span className="text-xs text-muted-foreground">{mode.description}</span>
                    </button>
                  );
                })}
              </div>
              <label className="mt-4 flex cursor-pointer items-center gap-2 text-sm">
                <Checkbox
                  checked={showTour}
                  onCheckedChange={(checked) => setShowTour(checked === true)}
                  data-testid="lp-intro-show-tour"
                />
                Show me around
              </label>
            </DialogPanel>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>{SCREENS[screen]!.title}</DialogTitle>
              <DialogDescription render={<div className="flex flex-col gap-2" />}>
                {SCREENS[screen]!.body.map((line) => (
                  <p key={line}>{line}</p>
                ))}
              </DialogDescription>
            </DialogHeader>
          </>
        )}
        <DialogFooter variant="bare" className="items-center sm:justify-between">
          <div className="flex items-center gap-1.5" aria-label={`Step ${screen + 1} of ${total}`}>
            {Array.from({ length: total }, (_, index) => (
              <span
                key={index}
                aria-hidden
                className={cn(
                  "size-1.5 rounded-full",
                  index === screen ? "bg-foreground" : "bg-foreground/20",
                )}
              />
            ))}
          </div>
          <div className="flex items-center gap-2">
            {last ? null : (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => completeIntro(false)}
                data-testid="lp-intro-skip"
              >
                Skip
              </Button>
            )}
            {screen > 0 ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setScreen(screen - 1)}
                data-testid="lp-intro-back"
              >
                Back
              </Button>
            ) : null}
            {last ? (
              <Button size="sm" onClick={finish} data-testid="lp-intro-start">
                Start
              </Button>
            ) : (
              <Button size="sm" onClick={() => setScreen(screen + 1)} data-testid="lp-intro-next">
                Next
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
