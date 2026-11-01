import type { EnvironmentId } from "@logicpacks/contracts";
import { BadgeCheckIcon, UserRoundPlusIcon, UsersIcon } from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { create } from "zustand";

import { type ComposerBannerStackItem } from "../components/chat/ComposerBannerStack";
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
import { Switch } from "../components/ui/switch";
import { Textarea } from "../components/ui/textarea";
import { toastManager } from "../components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { usePrimaryEnvironmentId } from "../state/environments";
import {
  externalApi,
  formatMoney,
  formatTokens,
  roleLevel,
  STATUS_TEXT,
  type LpDraft,
  type LpOffer,
  type LpTalent,
  type LpVettingCheck,
} from "./externalApi";
import { useFeature } from "./features";
import { useLogicPacksSession } from "./store";

/**
 * Vetted freelancers (Beta). One screen: say what you need, see the price in your currency,
 * accept. LogicPacks staff match a vetted freelancer, who joins the project with scoped
 * access, works on their own AI tools, and leaves when the work is done.
 */

export const BYO_AI_COPY = "Brings their own AI tools. Uses none of your tokens.";
export const PRICE_COPY = "You pay for the person's hours. Their AI is included.";

const VETTING_FALLBACK: ReadonlyArray<LpVettingCheck> = [
  { id: "identity", label: "Identity verified", detail: "" },
  { id: "skills", label: "Skills test passed", detail: "" },
  { id: "nda", label: "NDA signed", detail: "" },
  { id: "keys", label: "Keys-never-shared policy", detail: "" },
];

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "Something went wrong.";
const fail = (title: string) => (error: unknown) =>
  toastManager.add({ type: "error", title, description: errorText(error) });

// ── Profiles ──

export function VettedBadge({
  talent,
  checks = VETTING_FALLBACK,
}: {
  talent: LpTalent;
  checks?: ReadonlyArray<LpVettingCheck>;
}) {
  if (!talent.vetted) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Badge size="sm" variant="outline" data-testid="lp-vetted-badge" className="gap-1">
            <BadgeCheckIcon aria-hidden className="size-3" />
            Vetted by LogicPacks
          </Badge>
        }
      />
      <TooltipPopup side="bottom">
        <ul className="flex flex-col gap-0.5 text-xs" data-testid="lp-vetted-checks">
          {checks.map((check) => (
            <li key={check.id}>
              {talent.checks[check.id] ? "✓" : "·"} {check.label}
              {talent.checks[check.id] ? ` (${talent.checks[check.id]})` : ""}
            </li>
          ))}
        </ul>
      </TooltipPopup>
    </Tooltip>
  );
}

function Initials({ name }: { name: string }) {
  const letters = name
    .split(/\s+/)
    .map((part) => part[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase();
  return (
    <span
      aria-hidden
      className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border bg-muted text-sm font-medium text-muted-foreground"
    >
      {letters}
    </span>
  );
}

export function TalentCard({
  talent,
  checks,
  children,
}: {
  talent: LpTalent;
  checks?: ReadonlyArray<LpVettingCheck>;
  children?: ReactNode;
}) {
  return (
    <li
      className="flex flex-col gap-2 border-b border-border/60 py-3 last:border-b-0"
      data-testid="lp-talent-card"
      data-talent-id={talent.id}
    >
      <div className="flex items-start gap-3">
        {talent.avatar ? (
          <img
            src={talent.avatar}
            alt=""
            className="size-10 shrink-0 rounded-lg border border-border object-cover"
          />
        ) : (
          <Initials name={talent.name} />
        )}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
            {talent.name}
            <VettedBadge talent={talent} {...(checks ? { checks } : {})} />
            {talent.sample ? (
              <Badge size="sm" variant="outline" data-testid="lp-talent-sample">
                Sample profile
              </Badge>
            ) : null}
          </span>
          <span className="text-xs text-muted-foreground">
            Vetted freelancer · {roleLevel(talent.role, talent.level)} · {talent.region} ·{" "}
            {talent.timezone}
          </span>
          <span className="text-xs text-foreground/80">{talent.headline}</span>
        </div>
        {children ? <div className="flex shrink-0 items-center gap-1.5">{children}</div> : null}
      </div>
      <p className="text-xs text-muted-foreground">{talent.skills.join(" · ")}</p>
      <p className="text-xs text-muted-foreground" data-testid="lp-talent-tools">
        AI tools: {talent.tools.join(", ")}. {BYO_AI_COPY}
      </p>
      {talent.reasons && talent.reasons.length > 0 ? (
        <p className="text-xs text-muted-foreground">Why: {talent.reasons.join(", ")}</p>
      ) : null}
    </li>
  );
}

// ── Offers for a project (shared by the dialog and the thread banner) ──

const useOffersStore = create<{ byProject: Record<string, ReadonlyArray<LpOffer>> }>(() => ({
  byProject: {},
}));

async function refreshOffers(projectId: string) {
  try {
    const { offers } = await externalApi.offers(projectId);
    useOffersStore.setState((state) => ({
      byProject: { ...state.byProject, [projectId]: offers },
    }));
  } catch {
    // Offline or not a member: keep what we had.
  }
}

const POLL_MS = 8000;
/** One empty list, so the store selector returns a stable value. */
const NO_OFFERS: ReadonlyArray<LpOffer> = [];

function useProjectOffers(projectId: string | null) {
  // oxlint-disable-next-line logicpacks/no-unreasoned-state-sync -- polls the project's freelancer offers, like goals
  useEffect(() => {
    if (projectId === null) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const loop = async () => {
      if (stopped) return;
      if (typeof document === "undefined" || document.visibilityState !== "hidden")
        await refreshOffers(projectId);
      if (!stopped) timer = setTimeout(() => void loop(), POLL_MS);
    };
    void loop();
    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [projectId]);
  return useOffersStore((state) =>
    projectId === null ? NO_OFFERS : (state.byProject[projectId] ?? NO_OFFERS),
  );
}

function OfferRow({ offer, onChanged }: { offer: LpOffer; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const run = (title: string, action: () => Promise<unknown>) => async () => {
    setBusy(true);
    try {
      await action();
      onChanged();
    } catch (error) {
      fail(title)(error);
    }
    setBusy(false);
  };
  const live =
    offer.status === "accepted" || offer.status === "assigned" || offer.status === "active";
  return (
    <li
      className="flex flex-col gap-1.5 border-b border-border/60 py-3 last:border-b-0"
      data-testid="lp-external-offer"
      data-offer-id={offer.id}
      data-status={offer.status}
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{offer.brief.title}</span>
        <Badge size="sm" variant={offer.status === "active" ? "default" : "outline"}>
          {STATUS_TEXT[offer.status]}
        </Badge>
      </div>
      <span className="text-xs text-muted-foreground">
        {formatMoney(offer.quote.price, offer.quote.currency)} for {offer.quote.hours} hours ·{" "}
        {offer.hoursUsed} of {offer.quote.hours} hours used · Payment: {offer.payment}
      </span>
      {offer.joinedLine ? <span className="text-xs">{offer.joinedLine}</span> : null}
      {live ? (
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <Switch
              checked={offer.allowSharedLogin}
              data-testid="lp-external-shared-login"
              disabled={busy}
              onCheckedChange={(checked) =>
                void run("Not saved", () => externalApi.setSharedLogin(offer.id, checked))()
              }
            />
            Let them use my shared AI login (off: they use their own)
          </label>
          <Button
            size="xs"
            variant="ghost"
            className="ml-auto"
            disabled={busy}
            data-testid="lp-external-cancel"
            onClick={() => void run("Not cancelled", () => externalApi.cancel(offer.id))()}
          >
            {offer.status === "active" ? "End access" : "Cancel"}
          </Button>
          {offer.status === "active" ? (
            <Button
              size="xs"
              variant="outline"
              disabled={busy}
              data-testid="lp-external-complete"
              onClick={() => void run("Not completed", () => externalApi.complete(offer.id))()}
            >
              Mark complete
            </Button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

// ── The one-screen request ──

function RequestPanel({ projectId, threadId }: { projectId: string; threadId: string }) {
  const offers = useProjectOffers(projectId);
  const [need, setNeed] = useState("");
  const [draft, setDraft] = useState<LpDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<LpOffer | null>(null);

  const seePrice = async (event?: FormEvent) => {
    event?.preventDefault();
    if (busy || need.trim().length < 10) return;
    setBusy(true);
    try {
      setDraft(await externalApi.draft({ projectId, need: need.trim() }));
    } catch (error) {
      fail("No price yet")(error);
    }
    setBusy(false);
  };

  const accept = async () => {
    if (draft === null || busy) return;
    setBusy(true);
    try {
      const { offer } = await externalApi.createOffer({
        projectId,
        threadId,
        need: need.trim(),
        brief: draft.brief,
        accept: true,
      });
      setDone(offer);
      setDraft(null);
      setNeed("");
      void refreshOffers(projectId);
    } catch (error) {
      fail("Not accepted")(error);
    }
    setBusy(false);
  };

  const quote = draft?.quote;
  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          Get help from a vetted freelancer
          <Badge size="sm" variant="outline">
            Beta
          </Badge>
        </DialogTitle>
        <DialogDescription>
          Freelancers vetted by LogicPacks: designers, developers and DevOps. {BYO_AI_COPY}
        </DialogDescription>
      </DialogHeader>
      <DialogPanel className="flex flex-col gap-4">
        {done ? (
          <p
            className="rounded-lg border border-border p-3 text-sm"
            data-testid="lp-external-accepted"
          >
            Accepted. We are matching a vetted freelancer now; they join this project when assigned
            and you see them in this thread.
          </p>
        ) : null}
        <form className="flex flex-col gap-2" onSubmit={(event) => void seePrice(event)}>
          <Textarea
            value={need}
            rows={3}
            placeholder="What do you need? For example: set up CI deploys to our server with SSL."
            data-testid="lp-external-need"
            onChange={(event) => {
              setNeed(event.target.value);
              setDraft(null);
            }}
          />
          {draft === null ? (
            <Button
              type="submit"
              size="sm"
              disabled={busy || need.trim().length < 10}
              data-testid="lp-external-see-price"
            >
              {busy ? "Working out a price…" : "See price"}
            </Button>
          ) : null}
        </form>
        {draft !== null && quote !== undefined ? (
          <section
            className="flex flex-col gap-2 rounded-lg border border-border p-3"
            data-testid="lp-external-quote"
          >
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-sm font-medium">{draft.brief.title}</span>
              <span
                className="shrink-0 text-lg font-semibold whitespace-nowrap"
                data-testid="lp-external-price"
                data-currency={quote.currency}
              >
                {formatMoney(quote.price, quote.currency)}
              </span>
            </div>
            <span className="text-xs text-muted-foreground">
              {roleLevel(quote.role, quote.level)} · {quote.hours} hours included
              {quote.packageName ? ` · ${quote.packageName}` : ""}
              {quote.discountPct > 0 ? ` · ${quote.discountPct}% off` : ""} ·{" "}
              {formatMoney(quote.hourly, quote.currency)} an hour ({draft.region.label})
            </span>
            <p className="text-xs">{PRICE_COPY}</p>
            <p className="text-xs text-muted-foreground" data-testid="lp-external-tokens">
              Saves roughly {formatTokens(quote.tokensSavedEstimate)} agent tokens (an estimate).
            </p>
            <ol
              className="list-decimal pl-4 text-xs text-muted-foreground"
              data-testid="lp-external-milestones"
            >
              {draft.brief.milestones.map((milestone) => (
                <li key={milestone.title}>
                  {milestone.title} ({milestone.hours} h)
                </li>
              ))}
            </ol>
            <p className="text-2xs text-muted-foreground" data-testid="lp-external-draft-note">
              {draft.note} More hours later need a new offer. Payment: {draft.payment}. The offer
              stays open for 7 days.
            </p>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                disabled={busy}
                data-testid="lp-external-accept"
                onClick={() => void accept()}
              >
                Accept {formatMoney(quote.price, quote.currency)}
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setDraft(null)}>
                Change
              </Button>
            </div>
          </section>
        ) : null}
        {offers.length > 0 ? (
          <section className="flex flex-col">
            <h3 className="text-xs font-medium text-muted-foreground">This project</h3>
            <ul>
              {offers.map((offer) => (
                <OfferRow
                  key={offer.id}
                  offer={offer}
                  onChanged={() => void refreshOffers(projectId)}
                />
              ))}
            </ul>
          </section>
        ) : null}
        <a
          href="/pricing"
          target="_blank"
          rel="noreferrer"
          className="text-xs text-muted-foreground underline underline-offset-2"
        >
          Prices and how we vet
        </a>
      </DialogPanel>
    </>
  );
}

export function LpVettedHelpButton({
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
  const unlocked = useFeature("talent");
  const [open, setOpen] = useState(false);
  if (
    !unlocked ||
    session === null ||
    environmentId === null ||
    environmentId !== primaryEnvironmentId
  )
    return null;
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="xs"
              variant="ghost"
              data-testid="lp-external-open"
              aria-label="Get help from a vetted freelancer"
              onClick={() => setOpen(true)}
            />
          }
        >
          <UserRoundPlusIcon aria-hidden />
        </TooltipTrigger>
        <TooltipPopup side="bottom">Get help from a vetted freelancer</TooltipPopup>
      </Tooltip>
      <DialogPopup className="max-w-xl" data-testid="lp-external-dialog">
        {open ? <RequestPanel projectId={projectId} threadId={threadId} /> : null}
      </DialogPopup>
    </Dialog>
  );
}

// ── Thread banner: "Omar K. (vetted devops freelancer) joined: 6 of 10 hours used" ──

export function useLpExternalCards(input: {
  projectId: string | null;
  threadId: string | null;
  environmentId: EnvironmentId | null;
}): ReadonlyArray<ComposerBannerStackItem> {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { session } = useLogicPacksSession(false);
  const enabled =
    session !== null &&
    input.environmentId !== null &&
    input.environmentId === primaryEnvironmentId;
  const offers = useProjectOffers(enabled ? input.projectId : null);
  if (!enabled || input.threadId === null) return [];
  const me = session?.user?.userId ?? null;
  return offers
    .filter((offer) => offer.status === "assigned" || offer.status === "active")
    .filter(
      (offer) =>
        offer.threadId === input.threadId || (me !== null && offer.assignment?.userId === me),
    )
    .map((offer) => ({
      id: `lp-external:${offer.id}`,
      variant: "info" as const,
      icon: <UsersIcon />,
      title: (
        <span
          data-testid="lp-external-joined"
          data-offer-id={offer.id}
          data-hours-used={offer.hoursUsed}
        >
          {offer.joinedLine}
        </span>
      ),
      description: `${offer.brief.title}. Vetted by LogicPacks; works on their own AI tools; secret files stay hidden from them.`,
    }));
}
