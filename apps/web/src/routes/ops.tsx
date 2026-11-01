import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";

import { APP_BASE_NAME } from "../branding";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { toastManager } from "../components/ui/toast";
import {
  type LpCloudLogin,
  externalApi,
  formatMoney,
  roleLevel,
  ROLE_LABEL,
  STATUS_TEXT,
  type LpAccessCode,
  type LpOffer,
  type LpTalent,
  type LpVettingCheck,
} from "../logicpacks/externalApi";
import { TalentCard } from "../logicpacks/ExternalControls";

/**
 * LogicPacks staff (host owner and the staff list): the request inbox, the vetted talent
 * directory with matching and one-click assign, the jobs board, and access codes.
 */

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "Something went wrong.";
const fail = (title: string) => (error: unknown) =>
  toastManager.add({ type: "error", title, description: errorText(error) });

type Tab = "inbox" | "talent" | "codes";

function OfferCard({ offer, onChanged }: { offer: LpOffer; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [matches, setMatches] = useState<ReadonlyArray<LpTalent> | null>(null);
  const [hours, setHours] = useState("");
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
  const suggest = async () => {
    setBusy(true);
    try {
      const result = await externalApi.matches(offer.id);
      setMatches(result.matches.map((match) => ({ ...match.talent, reasons: match.reasons })));
    } catch (error) {
      fail("No matches")(error);
    }
    setBusy(false);
  };
  const working = offer.status === "assigned" || offer.status === "active";
  const applicants = offer.applications.filter((a) => a.status === "applied");
  return (
    <li
      className="flex flex-col gap-2 rounded-lg border border-border p-4"
      data-testid="lp-ops-offer"
      data-offer-id={offer.id}
      data-status={offer.status}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium" data-testid="lp-ops-brief-title">
          {offer.brief.title}
        </span>
        <Badge size="sm" variant={offer.status === "active" ? "default" : "outline"}>
          {STATUS_TEXT[offer.status]}
        </Badge>
        {offer.published ? (
          <Badge size="sm" variant="outline">
            On the jobs board
          </Badge>
        ) : null}
        <span className="ml-auto text-sm tabular-nums">
          {formatMoney(offer.quote.price, offer.quote.currency)}
        </span>
      </div>
      <span className="text-xs text-muted-foreground">
        {offer.customerName} · {offer.projectTitle} ·{" "}
        {roleLevel(offer.brief.role, offer.brief.level)} · {offer.hoursUsed} of {offer.quote.hours}{" "}
        hours used · region {offer.quote.region} ({offer.regionSource}) · brief by{" "}
        {offer.brief.draftedBy}
        {offer.charge
          ? ` · charge ${offer.charge.status}${offer.charge.reference ? ` ${offer.charge.reference}` : ""}`
          : ""}
      </span>
      <p className="text-xs whitespace-pre-wrap" data-testid="lp-ops-brief-scope">
        {offer.brief.scope}
      </p>
      <ol className="list-decimal pl-4 text-xs text-muted-foreground">
        {offer.brief.milestones.map((milestone) => (
          <li key={milestone.title}>
            {milestone.title} ({milestone.hours} h)
          </li>
        ))}
      </ol>
      {offer.assignment ? (
        <span className="text-xs" data-testid="lp-ops-assignment">
          {offer.joinedLine}
          {offer.assignment.invitePath && offer.status === "assigned" ? (
            <>
              {" · "}
              <a
                className="underline"
                href={offer.assignment.invitePath}
                data-testid="lp-ops-invite-link"
              >
                join link
              </a>
            </>
          ) : null}
        </span>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {offer.status === "accepted" ? (
          <>
            <Button
              size="xs"
              variant="outline"
              disabled={busy}
              data-testid="lp-ops-suggest"
              onClick={() => void suggest()}
            >
              Suggest matches
            </Button>
            {!offer.published ? (
              <Button
                size="xs"
                variant="ghost"
                disabled={busy}
                data-testid="lp-ops-publish"
                onClick={() => void run("Not published", () => externalApi.publish(offer.id))()}
              >
                Publish to jobs board
              </Button>
            ) : null}
          </>
        ) : null}
        {working ? (
          <form
            className="flex items-center gap-1.5"
            onSubmit={(event: FormEvent) => {
              event.preventDefault();
              const value = Number(hours);
              if (!(value > 0)) return;
              void run("Hours not logged", async () => {
                await externalApi.logHours(offer.id, value, "Logged by staff");
                setHours("");
              })();
            }}
          >
            <Input
              size="sm"
              className="w-20"
              value={hours}
              placeholder="Hours"
              data-testid="lp-ops-hours"
              onChange={(event) => setHours(event.target.value)}
            />
            <Button
              size="xs"
              variant="outline"
              type="submit"
              disabled={busy}
              data-testid="lp-ops-log-hours"
            >
              Log hours
            </Button>
          </form>
        ) : null}
        {offer.status === "active" ? (
          <Button
            size="xs"
            variant="outline"
            disabled={busy}
            data-testid="lp-ops-complete"
            onClick={() => void run("Not completed", () => externalApi.complete(offer.id))()}
          >
            Complete
          </Button>
        ) : null}
        {offer.status === "offered" || offer.status === "accepted" || working ? (
          <Button
            size="xs"
            variant="ghost"
            disabled={busy}
            onClick={() => void run("Not cancelled", () => externalApi.cancel(offer.id))()}
          >
            Cancel
          </Button>
        ) : null}
      </div>
      {applicants.length > 0 ? (
        <section className="flex flex-col gap-1.5">
          <h4 className="text-xs font-medium text-muted-foreground">Applicants</h4>
          <ul className="flex flex-col gap-1.5">
            {applicants.map((application) => (
              <li
                key={application.id}
                className="flex items-start gap-2 text-xs"
                data-testid="lp-ops-applicant"
                data-application-id={application.id}
              >
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{application.name}</span> ({application.email})
                  {application.hours ? `, estimates ${application.hours} h` : ""}:{" "}
                  {application.note}
                </span>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy}
                  data-testid="lp-ops-accept-applicant"
                  onClick={() =>
                    void run("Not accepted", () =>
                      externalApi.acceptApplicant(offer.id, application.id),
                    )()
                  }
                >
                  Accept
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {matches !== null && offer.status === "accepted" ? (
        <ul data-testid="lp-ops-matches">
          {matches.map((talent) => (
            <TalentCard key={talent.id} talent={talent}>
              <Button
                size="xs"
                disabled={busy}
                data-testid="lp-ops-assign"
                onClick={() =>
                  void run("Not assigned", async () => {
                    await externalApi.assign(offer.id, talent.id);
                    setMatches(null);
                    toastManager.add({
                      type: "success",
                      title: `${talent.name} assigned`,
                      description: "They join through the project invite.",
                    });
                  })()
                }
              >
                Assign
              </Button>
            </TalentCard>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function Inbox() {
  const [offers, setOffers] = useState<ReadonlyArray<LpOffer> | null>(null);
  const [filter, setFilter] = useState<"open" | "all">("open");
  const load = () =>
    externalApi
      .inbox()
      .then((result) => setOffers(result.offers))
      .catch(fail("Inbox not loaded"));
  // oxlint-disable-next-line logicpacks/no-unreasoned-state-sync -- loads the staff inbox once; actions reload it
  useEffect(() => {
    void load();
  }, []);
  const shown = (offers ?? [])
    .filter(
      (offer) =>
        filter === "all" || ["offered", "accepted", "assigned", "active"].includes(offer.status),
    )
    .toSorted((a, b) => b.createdAtMs - a.createdAtMs);
  return (
    <section className="flex flex-col gap-3" data-testid="lp-ops-inbox">
      <div className="flex items-center gap-2">
        <Button
          size="xs"
          variant={filter === "open" ? "default" : "ghost"}
          onClick={() => setFilter("open")}
        >
          Open
        </Button>
        <Button
          size="xs"
          variant={filter === "all" ? "default" : "ghost"}
          onClick={() => setFilter("all")}
        >
          All
        </Button>
        <Button size="xs" variant="ghost" className="ml-auto" onClick={() => void load()}>
          Refresh
        </Button>
      </div>
      {offers === null ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
      {offers !== null && shown.length === 0 ? (
        <p className="text-sm text-muted-foreground">No requests yet.</p>
      ) : null}
      <ul className="flex flex-col gap-3">
        {shown.map((offer) => (
          <OfferCard key={offer.id} offer={offer} onChanged={() => void load()} />
        ))}
      </ul>
    </section>
  );
}

function Directory() {
  const [q, setQ] = useState("");
  const [role, setRole] = useState("");
  const [availability, setAvailability] = useState("");
  const [talent, setTalent] = useState<ReadonlyArray<LpTalent>>([]);
  const [checks, setChecks] = useState<ReadonlyArray<LpVettingCheck> | undefined>(undefined);
  // oxlint-disable-next-line logicpacks/no-unreasoned-state-sync -- searches the directory as the filters change
  useEffect(() => {
    let live = true;
    externalApi
      .talent({ q, role, availability })
      .then((result) => {
        if (!live) return;
        setTalent(result.talent);
        setChecks(result.vetting);
      })
      .catch(fail("Directory not loaded"));
    return () => {
      live = false;
    };
  }, [q, role, availability]);
  const select = "rounded-md border border-border bg-background px-2 py-1 text-sm";
  return (
    <section className="flex flex-col gap-3" data-testid="lp-ops-directory">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          size="sm"
          className="max-w-xs"
          value={q}
          placeholder="Search name, skill or tool"
          data-testid="lp-ops-talent-search"
          onChange={(event) => setQ(event.target.value)}
        />
        <select
          className={select}
          value={role}
          onChange={(event) => setRole(event.target.value)}
          data-testid="lp-ops-talent-role"
        >
          <option value="">Any role</option>
          {Object.entries(ROLE_LABEL).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <select
          className={select}
          value={availability}
          onChange={(event) => setAvailability(event.target.value)}
        >
          <option value="">Any availability</option>
          <option value="available">Available</option>
          <option value="busy">Busy</option>
          <option value="away">Away</option>
        </select>
      </div>
      <p className="text-xs text-muted-foreground">
        Profiles marked Sample are seed data until the real team is added.
      </p>
      <ul>
        {talent.map((profile) => (
          <TalentCard key={profile.id} talent={profile} {...(checks ? { checks } : {})}>
            <span className="text-xs text-muted-foreground">
              {profile.availability} · {profile.hoursFreePerWeek} h free · USD {profile.rateUsd}/h
            </span>
          </TalentCard>
        ))}
      </ul>
    </section>
  );
}

const STATUS_LABEL: Record<LpAccessCode["status"], string> = {
  active: "Active",
  expired: "Expired",
  revoked: "Revoked",
  used_up: "Used up",
};

function Codes() {
  const [codes, setCodes] = useState<ReadonlyArray<LpAccessCode>>([]);
  const [features, setFeatures] = useState<ReadonlyArray<{ feature: string; label: string }>>([]);
  const [staff, setStaff] = useState<ReadonlyArray<{ email: string; addedBy: string }>>([]);
  const [picked, setPicked] = useState<ReadonlyArray<string>>([]);
  const [maxUses, setMaxUses] = useState("10");
  const [days, setDays] = useState("30");
  const [note, setNote] = useState("");
  const [created, setCreated] = useState<string | null>(null);
  const [staffEmail, setStaffEmail] = useState("");
  const [cloudLogins, setCloudLogins] = useState<ReadonlyArray<LpCloudLogin>>([]);
  const load = () =>
    externalApi
      .codes()
      .then((result) => {
        setCodes(result.codes);
        setFeatures(result.features);
        setStaff(result.staff);
        setCloudLogins(result.cloudLogins ?? []);
      })
      .catch(fail("Codes not loaded"));
  // oxlint-disable-next-line logicpacks/no-unreasoned-state-sync -- loads the access codes once; actions reload them
  useEffect(() => {
    void load();
  }, []);
  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (picked.length === 0) return;
    try {
      const result = await externalApi.createCode({
        features: picked,
        maxUses: maxUses.trim() === "" ? null : Number(maxUses),
        expiresInDays: days.trim() === "" ? null : Number(days),
        note: note.trim(),
      });
      setCreated(result.code);
      setCodes(result.codes);
      setNote("");
    } catch (error) {
      fail("No code made")(error);
    }
  };
  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text);
    toastManager.add({ type: "success", title: "Copied" });
  };
  return (
    <section className="flex flex-col gap-6" data-testid="lp-ops-codes">
      <form
        className="flex flex-col gap-3 rounded-lg border border-border p-4"
        onSubmit={(event) => void create(event)}
      >
        <h3 className="text-sm font-medium">New access code</h3>
        <div className="flex flex-wrap gap-3">
          {features.map((feature) => (
            <label key={feature.feature} className="flex items-center gap-1.5 text-sm">
              <input
                type="checkbox"
                data-testid={`lp-ops-code-feature-${feature.feature}`}
                checked={picked.includes(feature.feature)}
                onChange={(event) =>
                  setPicked((current) =>
                    event.target.checked
                      ? [...current, feature.feature]
                      : current.filter((f) => f !== feature.feature),
                  )
                }
              />
              {feature.label}
            </label>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <label className="flex items-center gap-1.5">
            Max uses
            <Input
              size="sm"
              className="w-20"
              value={maxUses}
              data-testid="lp-ops-code-max"
              onChange={(event) => setMaxUses(event.target.value)}
            />
          </label>
          <label className="flex items-center gap-1.5">
            Expires in days
            <Input
              size="sm"
              className="w-20"
              value={days}
              onChange={(event) => setDays(event.target.value)}
            />
          </label>
          <Input
            size="sm"
            className="min-w-40 flex-1"
            value={note}
            placeholder="Note (who it is for)"
            onChange={(event) => setNote(event.target.value)}
          />
          <Button
            size="sm"
            type="submit"
            disabled={picked.length === 0}
            data-testid="lp-ops-code-create"
          >
            Make code
          </Button>
        </div>
        {created ? (
          <p className="flex items-center gap-2 text-sm">
            <code className="rounded bg-muted px-2 py-1 font-mono" data-testid="lp-ops-code-value">
              {created}
            </code>
            <Button size="xs" variant="outline" onClick={() => copy(created)}>
              Copy
            </Button>
            <span className="text-xs text-muted-foreground">Shown once. Only a hash is kept.</span>
          </p>
        ) : null}
      </form>
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs text-muted-foreground">
            <th className="py-2 font-medium">Code</th>
            <th className="py-2 font-medium">Features</th>
            <th className="py-2 font-medium">Uses</th>
            <th className="py-2 font-medium">Expires</th>
            <th className="py-2 font-medium">Status</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {codes.map((code) => (
            <tr
              key={code.id}
              className="border-b border-border/60"
              data-testid="lp-ops-code-row"
              data-code-id={code.id}
            >
              <td className="py-2 font-mono text-xs">
                LP-····-{code.hint}
                {code.note ? (
                  <span className="ml-2 font-sans text-muted-foreground">{code.note}</span>
                ) : null}
              </td>
              <td className="py-2 text-xs">{code.features.join(", ")}</td>
              <td className="py-2 text-xs tabular-nums">
                {code.uses}
                {code.maxUses === null ? "" : ` / ${code.maxUses}`}
              </td>
              <td className="py-2 text-xs">
                {code.expiresAtMs === null
                  ? "Never"
                  : new Date(code.expiresAtMs).toLocaleDateString()}
              </td>
              <td className="py-2 text-xs">{STATUS_LABEL[code.status]}</td>
              <td className="py-2 text-right">
                {code.status === "active" ? (
                  <Button
                    size="xs"
                    variant="ghost"
                    data-testid="lp-ops-code-revoke"
                    onClick={() =>
                      void externalApi
                        .revokeCode(code.id)
                        .then((result) => setCodes(result.codes))
                        .catch(fail("Not revoked"))
                    }
                  >
                    Revoke
                  </Button>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">Staff</h3>
        <p className="text-xs text-muted-foreground">
          Staff have every feature and can open this page. The host owner always can.
        </p>
        <ul className="flex flex-col gap-1 text-sm">
          {staff.map((entry) => (
            <li key={entry.email} className="flex items-center gap-2">
              {entry.email}
              <span className="text-xs text-muted-foreground">added by {entry.addedBy}</span>
              <Button
                size="xs"
                variant="ghost"
                className="ml-auto"
                onClick={() =>
                  void externalApi
                    .setStaff(entry.email, true)
                    .then((result) => setStaff(result.staff))
                    .catch(fail("Not removed"))
                }
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (staffEmail.trim() === "") return;
            void externalApi
              .setStaff(staffEmail.trim())
              .then((result) => {
                setStaff(result.staff);
                setStaffEmail("");
              })
              .catch(fail("Not added"));
          }}
        >
          <Input
            size="sm"
            className="max-w-xs"
            value={staffEmail}
            placeholder="name@example.com"
            onChange={(event) => setStaffEmail(event.target.value)}
          />
          <Button size="xs" variant="outline" type="submit">
            Add staff
          </Button>
        </form>
      </section>
      <section className="flex flex-col gap-2" data-testid="lp-ops-cloud-logins">
        <h3 className="text-sm font-medium">AI logins stored on the cloud</h3>
        <p className="text-xs text-muted-foreground">
          By default agents run on each person's own computer. These accounts connected an AI login
          here, which needs Cloud sync.
        </p>
        {cloudLogins.length === 0 ? (
          <p className="text-sm text-muted-foreground">None.</p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm">
            {cloudLogins.map((entry) => (
              <li key={entry.email} className="flex items-center gap-2">
                <span>{entry.name}</span>
                <span className="text-muted-foreground">{entry.email}</span>
                <span className="text-muted-foreground">{entry.agents.join(", ")}</span>
                <span className="ml-auto text-xs text-muted-foreground">
                  {entry.status === "unlocked" ? "Unlocked" : "Locked"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}

function OpsPage() {
  const [me, setMe] = useState<{ signedIn: boolean; staff: boolean } | null>(null);
  const [tab, setTab] = useState<Tab>("inbox");
  // oxlint-disable-next-line logicpacks/no-unreasoned-state-sync -- one read of who is signed in
  useEffect(() => {
    externalApi
      .opsMe()
      .then(setMe)
      .catch(() => setMe({ signedIn: false, staff: false }));
  }, []);
  return (
    <div className="h-full overflow-y-auto bg-background px-4 py-8 text-foreground sm:px-6">
      <main className="mx-auto flex w-full max-w-4xl flex-col gap-6" data-testid="lp-ops">
        <header className="flex items-baseline gap-3">
          <span className="text-lg font-medium tracking-tight">{APP_BASE_NAME}</span>
          <span className="text-sm text-muted-foreground">Ops</span>
        </header>
        {me === null ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
        {me !== null && !me.signedIn ? (
          <p className="text-sm">
            <a className="underline" href="/lp/login?next=/ops">
              Sign in
            </a>{" "}
            to open Ops.
          </p>
        ) : null}
        {me !== null && me.signedIn && !me.staff ? (
          <p className="text-sm text-muted-foreground" data-testid="lp-ops-forbidden">
            Only LogicPacks staff can open this.
          </p>
        ) : null}
        {me?.staff ? (
          <>
            <nav className="flex gap-2">
              {(
                [
                  ["inbox", "Requests"],
                  ["talent", "Talent"],
                  ["codes", "Access codes"],
                ] as const
              ).map(([id, label]) => (
                <Button
                  key={id}
                  size="sm"
                  variant={tab === id ? "default" : "ghost"}
                  data-testid={`lp-ops-tab-${id}`}
                  onClick={() => setTab(id)}
                >
                  {label}
                </Button>
              ))}
            </nav>
            {tab === "inbox" ? <Inbox /> : tab === "talent" ? <Directory /> : <Codes />}
          </>
        ) : null}
      </main>
    </div>
  );
}

export const Route = createFileRoute("/ops")({
  component: OpsPage,
});
