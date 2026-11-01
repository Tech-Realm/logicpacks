import type { EnvironmentId, ThreadId } from "@logicpacks/contracts";
import { GitBranchIcon, MessageSquareIcon, TriangleAlertIcon, UsersIcon } from "lucide-react";
import { useState, type FormEvent } from "react";

import { type ComposerBannerStackItem } from "../components/chat/ComposerBannerStack";
import { PullRequestGlyph } from "../components/pullRequest/pullRequestIcons";
import { Button } from "../components/ui/button";
import { useNowMinute } from "../hooks/useNowMinute";
import { Input } from "../components/ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "../components/ui/popover";
import { toastManager } from "../components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { usePrimaryEnvironmentId } from "../state/environments";
import {
  lpApi,
  type LpLedgerConflict,
  type LpLedgerMessage,
  type LpLedgerThread,
  type LpNegotiation,
  type LpNegotiationChoice,
} from "./api";
import {
  hideNotices,
  ledgerAgo,
  refreshThreadLedger,
  useProjectLedger,
  useThreadLedger,
} from "./ledger";
import { isLiveRequest, STATUS_LABEL, useExpertRequests } from "./ExpertsControls";
import { useLogicPacksSession } from "./store";
import { milestoneOfThread, STATUS_LABEL as GOAL_STATUS_LABEL, useProjectGoals } from "./goals";
import { Badge } from "../components/ui/badge";
import type { LpExpertRequest } from "./api";

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "Something went wrong.";

/** The ledger lives on the server this app signed in to. */
function useLedgerEnabled(environmentId: EnvironmentId | null) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { session } = useLogicPacksSession(false);
  return session !== null && environmentId !== null && environmentId === primaryEnvironmentId;
}

const people = (thread: LpLedgerThread) =>
  thread.members.map((member) => member.name).join(", ") || "Someone";

function MessageBox({
  placeholder,
  onSend,
  testId,
}: {
  placeholder: string;
  onSend: (text: string) => Promise<void>;
  testId: string;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (text.trim().length === 0 || busy) return;
    setBusy(true);
    try {
      await onSend(text.trim());
      setText("");
    } catch (error) {
      toastManager.add({ type: "error", title: "Not sent", description: errorText(error) });
    }
    // The catch never rethrows, so this always runs (React Compiler cannot lower `finally`).
    setBusy(false);
  };
  return (
    <form className="flex items-center gap-1.5" onSubmit={(event) => void submit(event)}>
      <Input
        size="sm"
        value={text}
        placeholder={placeholder}
        data-testid={testId}
        onChange={(event) => setText(event.target.value)}
      />
      <Button size="xs" variant="outline" type="submit" disabled={busy || text.trim() === ""}>
        Send
      </Button>
    </form>
  );
}

function ThreadRow({
  thread,
  activeThreadId,
  nowMs,
  onOpenThread,
  expert,
  milestone,
}: {
  thread: LpLedgerThread;
  activeThreadId: string;
  nowMs: number;
  onOpenThread: (threadId: ThreadId) => void;
  /** The assistance request this thread is the expert's side of. */
  expert?: LpExpertRequest | undefined;
  /** The goal milestone this thread works on. */
  milestone?: { goalTitle: string; title: string; status: string; percent: number } | undefined;
}) {
  const [messaging, setMessaging] = useState(false);
  const own = thread.threadId === activeThreadId;
  return (
    <li
      className="flex flex-col gap-1 border-b border-border/60 py-2 last:border-b-0"
      data-testid="lp-ledger-thread"
      data-thread-id={thread.threadId}
    >
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className={
            thread.status === "working"
              ? "size-1.5 shrink-0 rounded-full bg-foreground"
              : "size-1.5 shrink-0 rounded-full bg-muted-foreground/40"
          }
        />
        <span className="min-w-0 truncate text-sm font-medium text-foreground">
          {people(thread)}
        </span>
        {expert ? (
          <Badge size="sm" variant="outline" data-testid="lp-ledger-expert">
            Expert · {STATUS_LABEL[expert.status]}
          </Badge>
        ) : null}
        <span className="min-w-0 truncate text-xs text-muted-foreground">
          {own ? "this thread" : thread.title}
        </span>
        <span className="ml-auto shrink-0 text-xs text-muted-foreground">
          {thread.status === "idle" ? ledgerAgo(thread.lastActiveAtMs, nowMs) : thread.status}
        </span>
      </div>
      {thread.goal ? (
        <p className="text-xs text-foreground/80" data-testid="lp-ledger-goal">
          {thread.goal}
        </p>
      ) : null}
      {milestone ? (
        <p className="truncate text-xs text-foreground/80" data-testid="lp-ledger-milestone">
          Goal {milestone.goalTitle}: {milestone.title} · {milestone.status} · {milestone.percent}%
          done
        </p>
      ) : null}
      <p className="truncate text-xs text-muted-foreground">
        {thread.agent?.name ?? "Agent"}
        {thread.branch ? ` · ${thread.branch}` : ""}
        {thread.files.length > 0
          ? ` · ${thread.files
              .slice(0, 3)
              .map((file) => file.path)
              .join(", ")}`
          : ""}
      </p>
      {own ? null : (
        <div className="flex items-center gap-1">
          <Button
            size="xs"
            variant="ghost"
            onClick={() => onOpenThread(thread.threadId as ThreadId)}
          >
            Open
          </Button>
          <Button
            size="xs"
            variant="ghost"
            data-testid="lp-ledger-message"
            onClick={() => setMessaging((value) => !value)}
          >
            <MessageSquareIcon aria-hidden />
            Message
          </Button>
        </div>
      )}
      {messaging ? (
        <MessageBox
          testId="lp-ledger-message-input"
          placeholder={`Message ${thread.members[0]?.name ?? "this thread"}`}
          onSend={async (text) => {
            await lpApi.sendToThread({ threadId: activeThreadId, to: thread.threadId, text });
            setMessaging(false);
            toastManager.add({ type: "success", title: `Sent to ${people(thread)}` });
          }}
        />
      ) : null}
    </li>
  );
}

/** "Who's working on what": every thread in the project, its people, goal, files and branch. */
export function LpWhoIsWorkingButton({
  projectId,
  environmentId,
  activeThreadId,
  onOpenThread,
}: {
  projectId: string;
  environmentId: EnvironmentId | null;
  activeThreadId: string;
  onOpenThread: (threadId: ThreadId) => void;
}) {
  const enabled = useLedgerEnabled(environmentId);
  const [open, setOpen] = useState(false);
  const ledger = useProjectLedger(enabled && open ? projectId : null);
  const { requests } = useExpertRequests(enabled && open ? projectId : null);
  const goals = useProjectGoals(enabled && open ? projectId : null);
  // The minute tick is a UTC "YYYY-MM-DDTHH:MM"; ages here are in minutes.
  const nowMs = Date.parse(`${useNowMinute()}Z`);
  if (!enabled) return null;
  const expertThreads = new Map(
    (requests ?? [])
      .filter((request) => isLiveRequest(request) && request.expertThreadId !== null)
      .map((request) => [request.expertThreadId!, request] as const),
  );
  const conflicts = ledger?.conflicts.filter((conflict) => conflict.state !== "resolved") ?? [];
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Button
                  size="xs"
                  variant="ghost"
                  data-testid="lp-ledger-open"
                  aria-label="Who's working on what"
                />
              }
            />
          }
        >
          <UsersIcon aria-hidden />
        </TooltipTrigger>
        <TooltipPopup side="bottom">Who's working on what</TooltipPopup>
      </Tooltip>
      <PopoverPopup side="bottom" align="start" className="w-96" data-testid="lp-ledger-popover">
        <div className="flex flex-col gap-1">
          <p className="text-xs font-medium text-muted-foreground">Who's working on what</p>
          {ledger === null ? (
            <p className="py-2 text-sm text-muted-foreground">Loading</p>
          ) : ledger.threads.length === 0 ? (
            <p className="py-2 text-sm text-muted-foreground">No threads yet.</p>
          ) : (
            <ul className="max-h-96 overflow-y-auto">
              {ledger.threads.map((thread) => (
                <ThreadRow
                  key={thread.threadId}
                  thread={thread}
                  activeThreadId={activeThreadId}
                  nowMs={nowMs}
                  expert={expertThreads.get(thread.threadId)}
                  milestone={(() => {
                    const found = milestoneOfThread(goals?.goals ?? [], thread.threadId);
                    return found === undefined
                      ? undefined
                      : {
                          goalTitle: found.goal.title,
                          title: found.milestone.title,
                          status: GOAL_STATUS_LABEL[found.milestone.status],
                          percent: found.goal.progress.percent,
                        };
                  })()}
                  onOpenThread={(threadId) => {
                    setOpen(false);
                    onOpenThread(threadId);
                  }}
                />
              ))}
            </ul>
          )}
          {conflicts.length > 0 ? (
            <div className="mt-1 flex flex-col gap-1 border-t border-border pt-2">
              {conflicts.map((conflict) => (
                <p key={conflict.id} className="flex items-start gap-1.5 text-xs text-foreground">
                  <TriangleAlertIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                  <span>
                    {conflict.files.join(", ")}: {conflict.people.join(" and ")}
                  </span>
                </p>
              ))}
            </div>
          ) : null}
          {ledger !== null && ledger.decisions.length > 0 ? (
            <div className="mt-1 flex flex-col gap-0.5 border-t border-border pt-2">
              <p className="text-xs font-medium text-muted-foreground">Recent decisions</p>
              {ledger.decisions.slice(-3).map((decision) => (
                <p key={decision.id} className="text-xs text-foreground/80">
                  {decision.text}
                </p>
              ))}
            </div>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

/** Branch this thread into a new chat that carries its context. */
export function LpBranchThreadButton({
  threadId,
  environmentId,
  onOpenThread,
}: {
  threadId: string;
  environmentId: EnvironmentId | null;
  onOpenThread: (threadId: ThreadId) => void;
}) {
  const enabled = useLedgerEnabled(environmentId);
  const [busy, setBusy] = useState(false);
  if (!enabled) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="xs"
            variant="ghost"
            data-testid="lp-branch-thread"
            aria-label="Branch into a new chat"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const branched = await lpApi.branchThread(threadId);
                toastManager.add({ type: "success", title: "Branched into a new chat" });
                // The new thread reaches this client over the shell stream; give it a moment.
                setTimeout(() => onOpenThread(branched.threadId as ThreadId), 600);
              } catch (error) {
                toastManager.add({
                  type: "error",
                  title: "Could not branch",
                  description: errorText(error),
                });
              }
              // The catch never rethrows, so this always runs (React Compiler cannot lower `finally`).
              setBusy(false);
            }}
          />
        }
      >
        <GitBranchIcon aria-hidden />
      </TooltipTrigger>
      <TooltipPopup side="bottom">Branch into a new chat, keeping this context</TooltipPopup>
    </Tooltip>
  );
}

const CHOICES: ReadonlyArray<{ choice: LpNegotiationChoice; label: string; testId: string }> = [
  { choice: "accept", label: "Accept", testId: "lp-neg-accept" },
  { choice: "mine", label: "Keep mine", testId: "lp-neg-mine" },
  { choice: "theirs", label: "Keep theirs", testId: "lp-neg-theirs" },
  { choice: "both", label: "Merge both", testId: "lp-neg-both" },
];

function negotiationText(negotiation: LpNegotiation, threadId: string) {
  const own = negotiation.parties.find((party) => party.threadId === threadId);
  const others = negotiation.parties
    .filter((party) => party.threadId !== threadId)
    .map((party) => party.name)
    .join(", ");
  switch (negotiation.state) {
    case "collecting":
      return `The agents are comparing your work with ${others}'s (round ${negotiation.round} of ${negotiation.maxRounds}). You can decide now.`;
    case "awaiting_humans":
      return own?.decision
        ? `You chose ${own.decision === "both" ? "to merge both" : own.decision === "mine" ? "to keep yours" : own.decision === "theirs" ? "to keep theirs" : "to accept"}. Waiting for ${others}.`
        : (own?.question ?? "What do you want: keep yours, keep theirs, or merge both?");
    case "agreed": {
      const merger = negotiation.parties.find(
        (party) => party.threadId === negotiation.mergerThreadId,
      );
      return `Agreed: ${negotiation.plan?.summary ?? ""} ${merger?.name ?? "One"}'s agent is merging it on a branch.`;
    }
    case "merged":
      return `Merged by ${negotiation.outcome?.by ?? "an"}'s agent${negotiation.outcome?.branch ? ` on ${negotiation.outcome.branch}` : ""}: ${negotiation.outcome?.summary ?? ""}`;
    case "failed":
      return `The merge failed: ${negotiation.outcome?.summary ?? ""}`;
    case "timed_out":
      return "Nobody decided in time; nothing was changed. Choose to continue.";
  }
}

const decide = async (
  negotiation: LpNegotiation,
  threadId: string,
  choice: LpNegotiationChoice,
) => {
  try {
    const override =
      negotiation.state === "awaiting_humans" && negotiation.round > negotiation.maxRounds;
    await lpApi.decideNegotiation({
      negotiationId: negotiation.id,
      threadId,
      choice,
      ...(override ? { override: true } : {}),
    });
    await refreshThreadLedger(threadId);
  } catch (error) {
    toastManager.add({ type: "error", title: "Not saved", description: errorText(error) });
  }
};

function negotiationCard(negotiation: LpNegotiation, threadId: string): ComposerBannerStackItem {
  const settled = negotiation.state === "merged" || negotiation.state === "failed";
  const choices = CHOICES.filter(
    (entry) =>
      (entry.choice !== "accept" || negotiation.state === "agreed") &&
      (entry.choice !== "theirs" || negotiation.parties.length === 2),
  );
  return {
    id: `lp-negotiation:${negotiation.id}`,
    variant:
      negotiation.state === "merged"
        ? "success"
        : negotiation.state === "failed"
          ? "error"
          : negotiation.state === "awaiting_humans"
            ? "warning"
            : "info",
    icon: <PullRequestGlyph.merged />,
    title: (
      <span data-testid="lp-negotiation-card" data-state={negotiation.state}>
        Merging {negotiation.files.join(", ") || "your work"}
      </span>
    ),
    description: (
      <span data-testid="lp-negotiation-text">{negotiationText(negotiation, threadId)}</span>
    ),
    ...(settled
      ? {}
      : {
          actions: (
            <>
              {choices.map((entry) => (
                <Button
                  key={entry.choice}
                  size="xs"
                  variant={entry.choice === "both" ? "outline" : "ghost"}
                  data-testid={entry.testId}
                  onClick={() => void decide(negotiation, threadId, entry.choice)}
                >
                  {entry.label}
                </Button>
              ))}
            </>
          ),
        }),
  };
}

function conflictCard(conflict: LpLedgerConflict, threadId: string): ComposerBannerStackItem {
  return {
    id: `lp-conflict:${conflict.id}`,
    variant: "warning",
    icon: <TriangleAlertIcon />,
    title: (
      <span data-testid="lp-conflict-card" data-source={conflict.source}>
        {conflict.source === "sync" ? "Conflict" : "Same file"} in {conflict.files.join(", ")}
      </span>
    ),
    description: `${conflict.people.join(" and ")}: ${conflict.reason}`,
    actions: (
      <Button
        size="xs"
        variant="outline"
        data-testid="lp-conflict-merge"
        onClick={async () => {
          try {
            await lpApi.proposeMerge({ threadId, conflictId: conflict.id });
            await refreshThreadLedger(threadId);
          } catch (error) {
            toastManager.add({
              type: "error",
              title: "Could not start the merge",
              description: errorText(error),
            });
          }
        }}
      >
        <PullRequestGlyph.merged />
        Merge both
      </Button>
    ),
  };
}

function noticeCard(message: LpLedgerMessage, threadId: string): ComposerBannerStackItem {
  const dismiss = () => {
    hideNotices(threadId, [message.id]);
    void lpApi.markNoticesSeen(threadId, [message.id]).catch(() => undefined);
  };
  const fromPerson = message.kind !== "notice";
  return {
    id: `lp-notice:${message.id}`,
    variant: message.kind === "notice" ? "default" : "info",
    icon: <MessageSquareIcon />,
    title: (
      <span data-testid="lp-notice" data-kind={message.kind}>
        {message.kind === "reply"
          ? `${message.fromName} replied`
          : message.kind === "ask"
            ? `${message.fromName} wrote`
            : "LogicPacks"}
      </span>
    ),
    description: <span data-testid="lp-notice-text">{message.text}</span>,
    ...(fromPerson && message.fromThreadId !== null
      ? {
          children: (
            <MessageBox
              testId="lp-notice-reply"
              placeholder={`Reply to ${message.fromName}`}
              onSend={async (text) => {
                await lpApi.sendToThread({ threadId, to: "", text, replyTo: message.id });
                dismiss();
              }}
            />
          ),
        }
      : {}),
    dismissLabel: "Dismiss",
    onDismiss: dismiss,
  };
}

const MAX_NOTICES = 3;

/** Notices from other threads, conflicts and negotiation cards above this thread's composer. */
export function useLpThreadNotices(input: {
  threadId: string | null;
  environmentId: EnvironmentId | null;
}): ReadonlyArray<ComposerBannerStackItem> {
  const enabled = useLedgerEnabled(input.environmentId);
  const ledger = useThreadLedger(enabled ? input.threadId : null);
  if (!enabled || ledger === null || input.threadId === null) return [];
  const threadId = input.threadId;
  const negotiating = new Set(
    ledger.negotiations.map((negotiation) => negotiation.conflictId).filter(Boolean),
  );
  return [
    ...ledger.negotiations.map((negotiation) => negotiationCard(negotiation, threadId)),
    ...ledger.conflicts
      .filter((conflict) => !negotiating.has(conflict.id))
      .map((conflict) => conflictCard(conflict, threadId)),
    // A goal's task shows as its task card (GoalsControls), not as a plain message.
    ...ledger.notices
      .filter((message) => message.goalTask === undefined)
      .slice(-MAX_NOTICES)
      .map((message) => noticeCard(message, threadId)),
  ];
}
