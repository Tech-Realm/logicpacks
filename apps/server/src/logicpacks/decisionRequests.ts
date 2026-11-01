/**
 * Decision requests: one record for anything a person must decide on someone
 * else's work (goal drift and milestone reviews now; merges, spend, outside access
 * later). The UI renders the record and its actions; each kind's handler applies them.
 */

/** Extensible: a new kind adds a handler on the server and nothing in the dialog. */
export type DecisionKind = "goal.drift" | "goal.review";

export interface DecisionAction {
  readonly id: string;
  readonly label: string;
  /** The action needs a note (a message, a reason to send back). */
  readonly needsNote: boolean;
  readonly tone: "primary" | "default" | "quiet";
  /** Done in the app only (open the thread), never sent to the server. */
  readonly inApp?: "watch" | undefined;
}

export interface DecisionSubject {
  readonly type: "milestone";
  readonly goalId: string;
  readonly milestoneId: string;
  readonly threadId: string | null;
  readonly title: string;
  /** Whose work it is (the assignee). */
  readonly who: { readonly id: string | null; readonly name: string };
}

export interface DecisionRequest {
  readonly id: string;
  readonly projectId: string;
  readonly kind: DecisionKind;
  /** The record in the kind's own model this decides (a drift id, a milestone id). */
  readonly sourceId: string;
  readonly subject: DecisionSubject;
  /** How the app shows it: a dialog that interrupts, or a card above the composer. */
  readonly presentation: "dialog" | "card";
  readonly title: string;
  readonly summary: string;
  readonly detail: ReadonlyArray<string>;
  /** The kind's own reason code ("outside_scope", "wrong_branch"); null when none. */
  readonly reason: string | null;
  /** Raised by a deterministic check, a model's judgment, or a person. */
  readonly source: "check" | "judgment" | "person";
  /** Who or what raised it: the assignee, or LogicPacks' checks. */
  readonly requester: { readonly id: string | null; readonly name: string };
  /** Participant ids who may decide; the host may always decide. */
  readonly approvers: ReadonlyArray<string>;
  readonly actions: ReadonlyArray<DecisionAction>;
  readonly status: "open" | "resolved";
  readonly resolution: {
    readonly action: string;
    readonly by: string;
    readonly note: string;
    readonly atMs: number;
  } | null;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

/** People decide, never an agent; approvers or the host. */
export const canDecide = (
  request: DecisionRequest,
  actor: { readonly id: string; readonly isHost: boolean; readonly threadId: string | null },
) => actor.threadId === null && (actor.isHost || request.approvers.includes(actor.id));

export const isOpen = (request: DecisionRequest) => request.status === "open";

export const resolveRequest = (
  request: DecisionRequest,
  input: {
    readonly action: string;
    readonly by: string;
    readonly note: string;
    readonly atMs: number;
  },
): DecisionRequest => ({
  ...request,
  status: "resolved",
  resolution: input,
  updatedAtMs: input.atMs,
});

export const DRIFT_ACTIONS: ReadonlyArray<DecisionAction> = [
  { id: "message", label: "Message", needsNote: true, tone: "primary" },
  { id: "watch", label: "Watch", needsNote: false, tone: "default", inApp: "watch" },
  { id: "accept", label: "Accept", needsNote: false, tone: "quiet" },
  { id: "ignore", label: "Ignore", needsNote: false, tone: "quiet" },
];

export const REVIEW_ACTIONS: ReadonlyArray<DecisionAction> = [
  { id: "approve", label: "Approve", needsNote: false, tone: "primary" },
  { id: "changes", label: "Send back", needsNote: true, tone: "default" },
];
