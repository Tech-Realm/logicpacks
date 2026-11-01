import type { EnvironmentId, ThreadId } from "@logicpacks/contracts";
import { useFeature } from "./features";
import { useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon, LifeBuoyIcon, SendIcon, StarIcon } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";

import { requestConfirmDialog } from "../confirmDialog";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "../components/ui/sidebar";
import { Textarea } from "../components/ui/textarea";
import { toastManager } from "../components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { useStableCallback } from "../hooks/useStableCallback";
import { usePrimaryEnvironmentId } from "../state/environments";
import {
  lpApi,
  type LpExpert,
  type LpExpertAdmin,
  type LpExpertAvailability,
  type LpExpertRequest,
  type LpExpertRequestStatus,
} from "./api";
import { isMemberSession, useLogicPacksSession } from "./store";

/**
 * Request assistance (Beta). A requester picks a curated expert, sends a brief from the
 * thread, the expert accepts and joins the project as a member, and the requester can
 * share their agent login with them for this project only, delegate work into the
 * expert's thread, and end the session (which revokes the login and removes them).
 */

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "Something went wrong.";

const fail = (title: string) => (error: unknown) =>
  toastManager.add({ type: "error", title, description: errorText(error) });

export const STATUS_LABEL: Record<LpExpertRequestStatus, string> = {
  requested: "Requested",
  accepted: "Accepted",
  working: "Working",
  done: "Done",
  declined: "Declined",
  ended: "Ended",
};

const AVAILABILITY_LABEL: Record<LpExpertAvailability, string> = {
  available: "Available now",
  busy: "Busy, replies later",
  away: "Away",
};

const LIVE: ReadonlyArray<LpExpertRequestStatus> = ["requested", "accepted", "working", "done"];
export const isLiveRequest = (request: LpExpertRequest) => LIVE.includes(request.status);

function BetaBadge() {
  return (
    <Badge size="sm" variant="outline" data-testid="lp-beta">
      Beta
    </Badge>
  );
}

function AvailabilityDot({ availability }: { availability: LpExpertAvailability }) {
  return (
    <span
      aria-hidden
      className={
        availability === "available"
          ? "size-1.5 shrink-0 rounded-full bg-foreground"
          : availability === "busy"
            ? "size-1.5 shrink-0 rounded-full border border-foreground"
            : "size-1.5 shrink-0 rounded-full bg-muted-foreground/30"
      }
    />
  );
}

function ExpertAvatar({ expert, size = 48 }: { expert: LpExpert; size?: number }) {
  return (
    <img
      src={expert.avatar}
      alt=""
      width={size}
      height={size}
      className="shrink-0 rounded-lg border border-border bg-muted object-cover object-top grayscale"
      style={{ width: size, height: size }}
    />
  );
}

function ExpertCard({ expert, onPick }: { expert: LpExpert; onPick: () => void }) {
  return (
    <li
      className="flex flex-col gap-2 bg-popover p-4 transition-colors duration-(--lp-dur-1) ease-lp hover:bg-[color-mix(in_srgb,var(--foreground)_4%,var(--popover))]"
      data-testid="lp-expert-card"
      data-expert-id={expert.id}
    >
      <div className="flex items-start gap-3">
        <ExpertAvatar expert={expert} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-sm font-medium text-foreground">{expert.name}</span>
          <span className="truncate text-xs text-muted-foreground">{expert.specialty}</span>
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <StarIcon aria-hidden className="size-3 fill-current" />
            {expert.rating.toFixed(1)}
            <span className="text-muted-foreground/70">({expert.reviews})</span>
          </span>
        </div>
      </div>
      <p className="line-clamp-2 text-xs text-foreground/80">{expert.bio}</p>
      {expert.skills.length > 0 ? (
        <p className="truncate text-xs text-muted-foreground">{expert.skills.join(" · ")}</p>
      ) : null}
      <div className="mt-auto flex items-center gap-1.5">
        <AvailabilityDot availability={expert.availability} />
        <span className="text-xs text-muted-foreground">
          {AVAILABILITY_LABEL[expert.availability]}
        </span>
        <Button
          size="xs"
          variant="outline"
          className="ml-auto"
          data-testid="lp-expert-pick"
          onClick={onPick}
        >
          Request
        </Button>
      </div>
      {expert.sample ? (
        <p className="text-2xs text-muted-foreground/70">Sample profile, illustrative portrait</p>
      ) : null}
    </li>
  );
}

function StatusChip({ status }: { status: LpExpertRequestStatus }) {
  return (
    <Badge
      size="sm"
      variant={status === "working" ? "default" : "outline"}
      data-testid="lp-expert-status"
      data-status={status}
    >
      {STATUS_LABEL[status]}
    </Badge>
  );
}

function DelegateBox({ request, onDone }: { request: LpExpertRequest; onDone: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (text.trim() === "" || busy) return;
    setBusy(true);
    try {
      await lpApi.delegateToExpert(request.id, text.trim());
      setText("");
      toastManager.add({
        type: "success",
        title: `Sent to ${request.expert?.name ?? "the expert"}`,
        description: "It arrives in their thread; their agent reads it next turn.",
      });
      onDone();
    } catch (error) {
      fail("Not sent")(error);
    }
    // The catch never rethrows, so this always runs (React Compiler cannot lower `finally`).
    setBusy(false);
  };
  return (
    <form className="flex items-center gap-1.5" onSubmit={(event) => void submit(event)}>
      <Input
        size="sm"
        value={text}
        placeholder={`Hand ${request.expert?.name.split(" ")[0] ?? "them"} a task`}
        data-testid="lp-expert-delegate-input"
        onChange={(event) => setText(event.target.value)}
      />
      <Button
        size="xs"
        variant="outline"
        type="submit"
        disabled={busy || text.trim() === ""}
        data-testid="lp-expert-delegate"
      >
        <SendIcon aria-hidden />
        Delegate
      </Button>
    </form>
  );
}

/** One request, from the requester's side: status, login sharing, delegation, end. */
function RequestRow({ request, onChanged }: { request: LpExpertRequest; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const run = (title: string, action: () => Promise<unknown>) => async () => {
    setBusy(true);
    try {
      await action();
      onChanged();
    } catch (error) {
      fail(title)(error);
    }
    // The catch never rethrows, so this always runs (React Compiler cannot lower `finally`).
    setBusy(false);
  };
  const joined =
    request.status === "accepted" || request.status === "working" || request.status === "done";
  const name = request.expert?.name ?? "Expert";
  return (
    <li
      className="flex flex-col gap-2 border-b border-border/60 py-3 last:border-b-0"
      data-testid="lp-expert-request"
      data-request-id={request.id}
      data-status={request.status}
    >
      <div className="flex items-center gap-2">
        {request.expert ? <ExpertAvatar expert={request.expert} size={28} /> : null}
        <span className="min-w-0 truncate text-sm font-medium text-foreground">{name}</span>
        <span className="min-w-0 truncate text-xs text-muted-foreground">
          {request.expert?.specialty}
        </span>
        <span className="ml-auto">
          <StatusChip status={request.status} />
        </span>
      </div>
      <p className="line-clamp-2 whitespace-pre-line text-xs text-muted-foreground">
        {request.brief}
      </p>
      {request.status === "requested" ? (
        <p className="text-xs text-muted-foreground">Waiting for {name} to accept.</p>
      ) : null}
      {joined ? (
        <p className="text-xs text-muted-foreground" data-testid="lp-expert-grant-state">
          {request.grantActive
            ? `${name} can run turns on your agent login, in this project only.`
            : `${name} uses their own agent login.`}
        </p>
      ) : null}
      {joined ? <DelegateBox request={request} onDone={onChanged} /> : null}
      {isLiveRequest(request) ? (
        <div className="flex flex-wrap items-center gap-1">
          {joined && !request.grantActive ? (
            <Button
              size="xs"
              variant="outline"
              disabled={busy}
              data-testid="lp-expert-grant"
              onClick={run("Could not share", () => lpApi.grantExpert(request.id))}
            >
              Share my agent login
            </Button>
          ) : null}
          {request.grantActive ? (
            <Button
              size="xs"
              variant="ghost"
              disabled={busy}
              data-testid="lp-expert-revoke"
              onClick={run("Could not revoke", () => lpApi.revokeExpert(request.id))}
            >
              Revoke login
            </Button>
          ) : null}
          {joined && request.status !== "done" ? (
            <Button
              size="xs"
              variant="ghost"
              disabled={busy}
              data-testid="lp-expert-done"
              onClick={run("Could not update", () => lpApi.setExpertStatus(request.id, "done"))}
            >
              Mark done
            </Button>
          ) : null}
          <Button
            size="xs"
            variant="ghost"
            className="ml-auto"
            disabled={busy}
            data-testid="lp-expert-end"
            onClick={async () => {
              const confirmed = await (requestConfirmDialog(
                `End the session with ${name}? Their access to your login is revoked and they leave this project.`,
                { variant: "destructive" },
              ) ?? Promise.resolve(true));
              if (!confirmed) return;
              await run("Could not end", () => lpApi.endExpertRequest(request.id))();
            }}
          >
            {request.status === "requested" ? "Cancel request" : "End session"}
          </Button>
        </div>
      ) : null}
    </li>
  );
}

export function useExpertRequests(projectId: string | null) {
  const [requests, setRequests] = useState<ReadonlyArray<LpExpertRequest> | null>(null);
  const refresh = useStableCallback(() => {
    if (projectId === null) return;
    lpApi
      .expertRequests(projectId)
      .then((result) => setRequests(result.requests))
      .catch(() => setRequests([]));
  });
  // oxlint-disable-next-line logicpacks/no-unreasoned-state-sync -- polls the server for this project's assistance requests
  useEffect(() => {
    if (projectId === null) return;
    refresh();
    const timer = setInterval(refresh, 10_000);
    return () => clearInterval(timer);
  }, [projectId, refresh]);
  return { requests, refresh };
}

/** The panel: requests in this project, then the catalog, then the brief for a pick. */
function AssistancePanel({
  projectId,
  threadId,
  onClose,
}: {
  projectId: string;
  threadId: string;
  onClose: () => void;
}) {
  const [experts, setExperts] = useState<ReadonlyArray<LpExpert> | null>(null);
  const [picked, setPicked] = useState<LpExpert | null>(null);
  const [brief, setBrief] = useState("");
  const [sending, setSending] = useState(false);
  const { requests, refresh } = useExpertRequests(projectId);
  // oxlint-disable-next-line logicpacks/no-unreasoned-state-sync -- loads the expert catalog from the server once
  useEffect(() => {
    lpApi
      .experts()
      .then((result) => setExperts(result.experts))
      .catch(() => setExperts([]));
  }, []);
  const pick = (expert: LpExpert) => {
    setPicked(expert);
    setBrief("");
    lpApi
      .expertBrief(threadId)
      .then((result) => setBrief((current) => (current === "" ? result.brief : current)))
      .catch(() => undefined);
  };
  const send = async (event: FormEvent) => {
    event.preventDefault();
    if (picked === null || sending || brief.trim() === "") return;
    setSending(true);
    try {
      await lpApi.requestExpert({
        projectId,
        expertId: picked.id,
        brief: brief.trim(),
        fromThreadId: threadId,
      });
      toastManager.add({
        type: "success",
        title: `Asked ${picked.name}`,
        description: "They join this project when they accept.",
      });
      setPicked(null);
      refresh();
    } catch (error) {
      fail("Request not sent")(error);
    }
    // The catch never rethrows, so this always runs (React Compiler cannot lower `finally`).
    setSending(false);
  };
  const live = (requests ?? []).filter(isLiveRequest);
  const operator = useLogicPacksSession(false).session?.operator === true;
  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center">
          <span className="me-2">Request assistance</span>
          <BetaBadge />
        </DialogTitle>
        <DialogDescription>
          Bring in a curated expert. They join this project when they accept, you decide whether
          they can use your agent login, and you can end it at any time.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        {live.length > 0 && picked === null ? (
          <section className="flex flex-col gap-1" data-testid="lp-expert-requests">
            <p className="text-xs font-medium text-muted-foreground">In this project</p>
            <ul>
              {live.map((request) => (
                <RequestRow key={request.id} request={request} onChanged={refresh} />
              ))}
            </ul>
          </section>
        ) : null}
        {picked === null ? (
          <section className="flex flex-col gap-2" data-testid="lp-experts-panel">
            <p className="text-xs font-medium text-muted-foreground">Experts</p>
            {experts === null ? (
              <p className="text-sm text-muted-foreground">Loading</p>
            ) : experts.length === 0 ? (
              <p className="text-sm text-muted-foreground">No experts listed yet.</p>
            ) : (
              // One frame with hairline cells, as on logicpacks.io; not a grid of separate cards.
              <ul className="grid grid-cols-1 gap-px overflow-hidden rounded-frame border border-hairline bg-hairline sm:grid-cols-2">
                {experts.map((expert) => (
                  <ExpertCard key={expert.id} expert={expert} onPick={() => pick(expert)} />
                ))}
              </ul>
            )}
          </section>
        ) : (
          <form
            className="flex flex-col gap-3"
            data-testid="lp-expert-brief-form"
            onSubmit={(event) => void send(event)}
          >
            <div className="flex items-center gap-3">
              <ExpertAvatar expert={picked} size={40} />
              <div className="flex min-w-0 flex-col">
                <span className="text-sm font-medium">{picked.name}</span>
                <span className="text-xs text-muted-foreground">{picked.specialty}</span>
              </div>
              <Button
                size="xs"
                variant="ghost"
                className="ml-auto"
                type="button"
                onClick={() => setPicked(null)}
              >
                <ArrowLeftIcon aria-hidden />
                Back
              </Button>
            </div>
            <label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">
              Brief, started from this thread
              <Textarea
                value={brief}
                rows={7}
                data-testid="lp-expert-brief"
                onChange={(event) => setBrief(event.target.value)}
              />
            </label>
            <p className="text-xs text-muted-foreground">
              They see the brief and this project once they accept. Nothing of your agent login is
              shared until you choose to.
            </p>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={onClose}>
                Close
              </Button>
              <Button
                type="submit"
                size="sm"
                disabled={sending || brief.trim() === ""}
                data-testid="lp-expert-send"
              >
                Send request
              </Button>
            </div>
          </form>
        )}
        {operator && picked === null ? (
          <ExpertsAdmin onChanged={() => lpApi.experts().then((r) => setExperts(r.experts))} />
        ) : null}
      </DialogPanel>
    </>
  );
}

/** The host operator curates the catalog: add or update an expert, take one off the list. */
function ExpertsAdmin({ onChanged }: { onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [experts, setExperts] = useState<ReadonlyArray<LpExpertAdmin>>([]);
  const [form, setForm] = useState({ id: "", name: "", specialty: "", accountEmail: "", bio: "" });
  const refresh = useStableCallback(() => {
    lpApi
      .adminExperts()
      .then((result) => setExperts(result.experts))
      .catch(() => undefined);
  });
  // oxlint-disable-next-line logicpacks/no-unreasoned-state-sync -- loads the catalog from the server when the admin panel opens
  useEffect(() => {
    if (open) refresh();
  }, [open, refresh]);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await lpApi.adminPutExpert({ ...form, id: form.id.trim(), sample: false });
      setForm({ id: "", name: "", specialty: "", accountEmail: "", bio: "" });
      refresh();
      onChanged();
    } catch (error) {
      fail("Not saved")(error);
    }
  };
  return (
    <section
      className="flex flex-col gap-2 border-t border-border pt-3"
      data-testid="lp-experts-admin"
    >
      <Button
        size="xs"
        variant="ghost"
        className="self-start"
        onClick={() => setOpen((value) => !value)}
      >
        {open ? "Hide catalog admin" : "Manage the catalog"}
      </Button>
      {open ? (
        <>
          <ul className="flex flex-col">
            {experts.map((expert) => (
              <li key={expert.id} className="flex items-center gap-2 py-1 text-xs">
                <span className="font-medium">{expert.name}</span>
                <span className="text-muted-foreground">{expert.specialty}</span>
                <span className="truncate text-muted-foreground">{expert.accountEmail}</span>
                {expert.sample ? (
                  <Badge size="sm" variant="outline">
                    Sample
                  </Badge>
                ) : null}
                <Button
                  size="xs"
                  variant="ghost"
                  className="ml-auto"
                  onClick={async () => {
                    try {
                      await lpApi.adminRemoveExpert(expert.id);
                      refresh();
                      onChanged();
                    } catch (error) {
                      fail("Not removed")(error);
                    }
                  }}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
          <form className="grid grid-cols-2 gap-1.5" onSubmit={(event) => void save(event)}>
            {(
              [
                ["id", "id (lowercase-dashes)"],
                ["name", "Name"],
                ["specialty", "Specialty"],
                ["accountEmail", "Account email they sign in with"],
              ] as const
            ).map(([key, placeholder]) => (
              <Input
                key={key}
                size="sm"
                placeholder={placeholder}
                value={form[key]}
                onChange={(event) => setForm({ ...form, [key]: event.target.value })}
              />
            ))}
            <Input
              size="sm"
              className="col-span-2"
              placeholder="Short bio"
              value={form.bio}
              onChange={(event) => setForm({ ...form, bio: event.target.value })}
            />
            <Button size="xs" type="submit" className="col-span-2 justify-self-end">
              Add or update expert
            </Button>
          </form>
        </>
      ) : null}
    </section>
  );
}

/** "Request assistance" in the thread header. */
export function LpRequestAssistanceButton({
  projectId,
  environmentId,
  threadId,
}: {
  projectId: string;
  environmentId: EnvironmentId | null;
  threadId: string;
}) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { session } = useLogicPacksSession(false);
  const [open, setOpen] = useState(false);
  // Request assistance (expert cards) is part of Talent: absent without it.
  const talent = useFeature("talent");
  if (
    !talent ||
    session === null ||
    environmentId === null ||
    environmentId !== primaryEnvironmentId
  ) {
    return null;
  }
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="xs"
              variant="ghost"
              data-testid="lp-request-assistance"
              aria-label="Request assistance (Beta)"
              onClick={() => setOpen(true)}
            />
          }
        >
          <LifeBuoyIcon aria-hidden />
        </TooltipTrigger>
        <TooltipPopup side="bottom">Request assistance (Beta)</TooltipPopup>
      </Tooltip>
      <DialogPopup className="max-w-2xl" data-testid="lp-assistance-dialog">
        {open ? (
          <AssistancePanel
            projectId={projectId}
            threadId={threadId}
            onClose={() => setOpen(false)}
          />
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}

// ── The expert's side ──

function InboxRow({
  request,
  onChanged,
  onOpenThread,
}: {
  request: LpExpertRequest;
  onChanged: () => void;
  onOpenThread: (threadId: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const run = (title: string, action: () => Promise<{ request: LpExpertRequest }>) => async () => {
    setBusy(true);
    try {
      const result = await action();
      onChanged();
      if (result.request.status === "accepted" && result.request.expertThreadId) {
        toastManager.add({
          type: "success",
          title: `You joined ${result.request.projectTitle}`,
          description: "A thread with the brief is ready for you.",
        });
        onOpenThread(result.request.expertThreadId);
      }
    } catch (error) {
      fail(title)(error);
    }
    // The catch never rethrows, so this always runs (React Compiler cannot lower `finally`).
    setBusy(false);
  };
  return (
    <li
      className="flex flex-col gap-2 border-b border-border/60 py-3 last:border-b-0"
      data-testid="lp-inbox-request"
      data-request-id={request.id}
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 truncate text-sm font-medium">{request.requesterName}</span>
        <span className="min-w-0 truncate text-xs text-muted-foreground">
          {request.projectTitle}
        </span>
        <span className="ml-auto">
          <StatusChip status={request.status} />
        </span>
      </div>
      <p className="whitespace-pre-line text-xs text-foreground/80">{request.brief}</p>
      {request.grantActive ? (
        <p className="text-xs text-muted-foreground">
          {request.requesterName} shared their agent login with you for this project.
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-1">
        {request.status === "requested" ? (
          <>
            <Button
              size="xs"
              disabled={busy}
              data-testid="lp-inbox-accept"
              onClick={run("Could not accept", () => lpApi.acceptExpertRequest(request.id))}
            >
              Accept and join
            </Button>
            <Button
              size="xs"
              variant="ghost"
              disabled={busy}
              data-testid="lp-inbox-decline"
              onClick={run("Could not decline", () => lpApi.declineExpertRequest(request.id))}
            >
              Decline
            </Button>
          </>
        ) : null}
        {request.expertThreadId &&
        (request.status === "accepted" ||
          request.status === "working" ||
          request.status === "done") ? (
          <Button
            size="xs"
            variant="outline"
            data-testid="lp-inbox-open"
            onClick={() => onOpenThread(request.expertThreadId!)}
          >
            Open thread
          </Button>
        ) : null}
        {request.status === "accepted" || request.status === "working" ? (
          <Button
            size="xs"
            variant="ghost"
            disabled={busy}
            data-testid="lp-inbox-done"
            onClick={run("Could not update", () => lpApi.setExpertStatus(request.id, "done"))}
          >
            Mark done
          </Button>
        ) : null}
      </div>
    </li>
  );
}

/** Requests addressed to the signed-in expert. Shows in the sidebar only when there are any. */
export function LpExpertInboxEntry() {
  const { session } = useLogicPacksSession(false);
  const member = isMemberSession(session);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const [requests, setRequests] = useState<ReadonlyArray<LpExpertRequest>>([]);
  const [open, setOpen] = useState(false);
  const refresh = useStableCallback(() => {
    lpApi
      .expertInbox()
      .then((result) => setRequests(result.requests))
      .catch(() => undefined);
  });
  // oxlint-disable-next-line logicpacks/no-unreasoned-state-sync -- polls the server for requests sent to this expert
  useEffect(() => {
    if (!member) return;
    refresh();
    const timer = setInterval(refresh, 15_000);
    return () => clearInterval(timer);
  }, [member, refresh]);
  const live = requests.filter(isLiveRequest);
  if (!member || live.length === 0) return null;
  const waiting = live.filter((request) => request.status === "requested").length;
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <Dialog open={open} onOpenChange={setOpen}>
          <SidebarMenuButton data-testid="lp-inbox-entry" onClick={() => setOpen(true)}>
            <LifeBuoyIcon />
            <span className="truncate">Assistance requests</span>
            <Badge size="sm" variant={waiting > 0 ? "default" : "outline"} className="ml-auto">
              {waiting > 0 ? `${waiting} new` : live.length}
            </Badge>
          </SidebarMenuButton>
          <DialogPopup className="max-w-xl" data-testid="lp-inbox-dialog">
            <DialogHeader>
              <DialogTitle className="flex items-center">
                <span className="me-2">Assistance requests</span>
                <BetaBadge />
              </DialogTitle>
              <DialogDescription>
                People asking for your help. Accepting adds you to their project with a thread that
                carries their brief.
              </DialogDescription>
            </DialogHeader>
            <DialogPanel>
              <ul>
                {live.map((request) => (
                  <InboxRow
                    key={request.id}
                    request={request}
                    onChanged={refresh}
                    onOpenThread={(threadId) => {
                      setOpen(false);
                      if (isMobile) setOpenMobile(false);
                      if (primaryEnvironmentId === null) return;
                      // The project and thread reach this client over the shell stream.
                      setTimeout(() => {
                        void navigate({
                          to: "/$environmentId/$threadId",
                          params: {
                            environmentId: primaryEnvironmentId,
                            threadId: threadId as ThreadId,
                          },
                        });
                      }, 600);
                    }}
                  />
                ))}
              </ul>
            </DialogPanel>
          </DialogPopup>
        </Dialog>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
