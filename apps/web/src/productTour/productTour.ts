import { isMacPlatform } from "../lib/utils";

/**
 * Tour steps in order. Each selector lists a `data-tour` anchor, then the element's existing
 * test id, so steps survive markup moves. A step whose anchor is not on screen is skipped.
 */
export type TourPlacement = "top" | "bottom" | "left" | "right";

export interface ProductTourStep {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  /** CSS selector list for the element to spotlight; the first visible match wins. */
  readonly selector: string;
  readonly placement: TourPlacement;
}

export const PRODUCT_TOUR_STEPS: readonly ProductTourStep[] = [
  {
    id: "workspace-switcher",
    title: "Your workspace",
    body: "Everything here belongs to one workspace. Switch workspaces or add a project from this menu.",
    selector: '[data-tour="workspace-switcher"], [data-testid="lp-workspace-switcher"]',
    placement: "right",
  },
  {
    id: "people",
    title: "The people you build with",
    body: "Everyone in the workspace shows here. A filled dot means they are here right now.",
    selector: '[data-tour="people"], [data-testid="lp-workspace-people"]',
    placement: "right",
  },
  {
    id: "invite",
    title: "Invite someone",
    body: "Send a link. They join the workspace and see the projects you share with them.",
    selector: '[data-tour="invite"], [data-testid="lp-invite"]',
    placement: "right",
  },
  {
    id: "project-pill",
    title: "The project and its sync state",
    body: "The pill shows which project you are in and whether it is synced to the cloud. Click the state to sync.",
    selector: '[data-tour="project-pill"], [data-lp-project-chip]',
    placement: "bottom",
  },
  {
    id: "share",
    title: "Share the project",
    body: "Give a teammate access to this project. They work in their own threads, next to yours.",
    selector: '[data-tour="share"], [data-testid="lp-share-project-open"]',
    placement: "bottom",
  },
  {
    id: "whos-working",
    title: "Who is working on what",
    body: "See every thread in the project, what each agent is doing and which files it has claimed.",
    selector: '[data-tour="whos-working"], [data-testid="lp-ledger-open"]',
    placement: "bottom",
  },
  {
    id: "request-assistance",
    title: "Request assistance",
    body: "Stuck? Ask a human expert to look at the thread with you. Beta.",
    selector: '[data-tour="request-assistance"], [data-testid="lp-request-assistance"]',
    placement: "bottom",
  },
  {
    id: "goals",
    title: "Goals",
    body: "Hand the agent a goal with milestones and limits. It checks in when it drifts. Beta.",
    selector: '[data-tour="goals"], [data-testid="lp-goals-open"]',
    placement: "bottom",
  },
  {
    id: "composer",
    title: "Talk to your agent",
    body: "Type here to send a message. Drop files or images in to attach them.",
    selector: '[data-tour="composer"], [data-chat-composer-form="true"]',
    placement: "top",
  },
  {
    id: "model-picker",
    title: "Pick the model",
    body: "Choose which agent and model runs this thread.",
    selector: '[data-tour="model-picker"], [data-chat-provider-model-picker="true"]',
    placement: "top",
  },
  {
    id: "connect-agent",
    title: "Connect your agent",
    body: "Sign in with Claude or Codex so your turns run on your own account.",
    selector:
      '[data-tour="connect-agent"], [data-testid="lp-connect-claude-nudge"], [data-testid="lp-avatar"]',
    placement: "right",
  },
  {
    id: "layout-switcher",
    title: "Dev or Vibe",
    body: `Switch layouts here, or press ${typeof navigator !== "undefined" && !isMacPlatform(navigator.platform) ? "Ctrl" : "Cmd"}+Alt+L. Dev puts files first, Vibe puts chat first.`,
    selector: '[data-tour="layout-switcher"]',
    placement: "bottom",
  },
  {
    id: "right-panel",
    title: "The workspace panel",
    body: "Files, diffs, terminals and previews open here as tabs.",
    selector: '[data-tour="right-panel"], [data-right-panel-toggle]',
    placement: "bottom",
  },
];
