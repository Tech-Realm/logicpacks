import {
  ACCESS_PRESETS,
  AGENT_LABELS,
  ACCESS_ZONES,
  FULL_ACCESS_WARNING,
  needsGrantWarning,
  normalizeZones,
  presetDef,
  zonesForPreset,
  type PresetId,
  type ZoneFieldDef,
  type ZoneValues,
} from "@logicpacks/contracts";
import { ChevronDownIcon, TerminalIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../components/ui/select";
import { toastManager } from "../components/ui/toast";
import { accessApi, type LpAccessLogEntry, type LpAccessRequest } from "./accessApi";
import { composerAccess, projectHasHostTerminal, seatHasCompute, seatIn } from "./accessZones.logic";
import type { LpSeat } from "./api";
import { refreshLogicPacksSession, useLogicPacksSession } from "./store";

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "Something went wrong.";

const PRESET_LABEL = (preset: string) =>
  preset === "custom" ? "Custom" : presetDef(preset as PresetId).label;

/** The host's Claude subscription is what members spend; said once, plainly. */
export const AI_SUBSCRIPTION_NOTE =
  "People you share with use your Claude subscription for their messages (the AI zone). " +
  "They can switch to their own login at any time.";

/** The preset choices. Renders from the registry, so a new preset shows up here on its own. */
export function PresetPicker({
  value,
  onPick,
  testIdPrefix,
}: {
  value: string;
  onPick: (preset: PresetId) => void;
  testIdPrefix: string;
}) {
  return (
    <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Access level">
      {ACCESS_PRESETS.map((preset) => (
        <Button
          key={preset.id}
          size="xs"
          variant={value === preset.id ? "default" : "outline"}
          role="radio"
          aria-checked={value === preset.id}
          title={preset.summary}
          data-testid={`${testIdPrefix}-${preset.id}`}
          onClick={() => onPick(preset.id)}
        >
          {preset.label}
        </Button>
      ))}
    </div>
  );
}

function FieldControl({
  field,
  value,
  agents,
  disabled,
  unavailable,
  onChange,
}: {
  field: ZoneFieldDef;
  value: string;
  agents: ReadonlyArray<string>;
  disabled: boolean;
  /** Option values this host cannot offer (shown, but not selectable). */
  unavailable?: ReadonlyArray<string> | undefined;
  onChange: (next: string) => void;
}) {
  if (field.kind === "paths") {
    return (
      <textarea
        className="min-h-16 w-64 rounded-row border border-hairline bg-transparent p-1.5 font-mono text-xs"
        placeholder="Whole project. Or one folder per line, e.g. docs"
        disabled={disabled}
        defaultValue={value}
        data-testid={`lp-zone-${field.id}`}
        aria-label={field.label}
        onBlur={(event) => {
          if (event.target.value !== value) onChange(event.target.value);
        }}
      />
    );
  }
  if (field.kind === "multi") {
    const chosen = new Set(value.split(",").filter(Boolean));
    return (
      <div className="flex flex-wrap gap-3">
        {field.options.map((option) => {
          const hostHas = agents.includes(option.value);
          return (
            <label key={option.value} className="flex items-center gap-1.5 text-sm">
              <input
                type="checkbox"
                disabled={disabled}
                checked={chosen.has(option.value)}
                data-testid={`lp-zone-${field.id}-${option.value}`}
                onChange={(event) => {
                  const next = new Set(chosen);
                  if (event.target.checked) next.add(option.value);
                  else next.delete(option.value);
                  onChange([...next].join(","));
                }}
              />
              {option.label}
              {hostHas ? null : (
                <span className="text-xs text-muted-foreground">(not on this host)</span>
              )}
            </label>
          );
        })}
      </div>
    );
  }
  return (
    <Select value={value} onValueChange={(next) => next !== null && onChange(next)} disabled={disabled}>
      <SelectTrigger size="sm" className="w-48" data-testid={`lp-zone-${field.id}`} aria-label={field.label}>
        <SelectValue>{field.options.find((option) => option.value === value)?.label ?? value}</SelectValue>
      </SelectTrigger>
      <SelectPopup>
        {field.options.map((option) => (
          <SelectItem key={option.value} value={option.value} disabled={unavailable?.includes(option.value)}>
            {option.label}
            {unavailable?.includes(option.value) ? " (not available on this computer)" : ""}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

/** Every zone and field, straight from the registry, with what each really guarantees. */
export function AdvancedZones({
  zones,
  hostAgents,
  sandbox,
  onChange,
}: {
  zones: ZoneValues;
  hostAgents: ReadonlyArray<string>;
  sandbox?: { readonly available: boolean; readonly reason: string | null } | undefined;
  onChange: (next: ZoneValues) => void;
}) {
  const [open, setOpen] = useState(false);
  const computeOn = zones["compute.terminal"] === "on";
  return (
    <div className="flex flex-col gap-2">
      <Button
        size="xs"
        variant="ghost"
        className="self-start"
        aria-expanded={open}
        data-testid="lp-access-advanced-toggle"
        onClick={() => setOpen(!open)}
      >
        <ChevronDownIcon className={open ? "rotate-180" : ""} />
        Advanced
      </Button>
      {open ? (
        <div className="flex flex-col gap-3" data-testid="lp-access-advanced">
          {ACCESS_ZONES.map((zone) => (
            <section key={zone.id} className="flex flex-col gap-1.5 rounded-row border border-hairline p-2.5">
              <h4 className="text-sm font-medium">{zone.label}</h4>
              <p className="text-xs text-muted-foreground">{zone.summary}</p>
              {zone.fields.map((field) =>
                // How a terminal runs only matters once the terminal is on.
                field.id === "compute.mode" && !computeOn ? null : (
                <div key={field.id} className="flex items-center justify-between gap-3">
                  <span className="text-sm">{field.label}</span>
                  <FieldControl
                    field={field}
                    value={zones[field.id]}
                    agents={hostAgents}
                    // A shell reaches every file, so Compute On carries files with it.
                    disabled={computeOn && zone.id === "files" && field.id !== "files.folders"}
                    unavailable={
                      field.id === "compute.mode" && sandbox?.available === false ? ["sandboxed"] : undefined
                    }
                    onChange={(next) => onChange(normalizeZones({ ...zones, [field.id]: next }))}
                  />
                </div>
              ))}
              {zone.id === "compute" && computeOn && sandbox?.available === false ? (
                <p className="text-xs text-warning-foreground" data-testid="lp-sandbox-unavailable">
                  {sandbox.reason}
                </p>
              ) : null}
              <p className="text-xs text-muted-foreground" data-testid={`lp-zone-guarantee-${zone.id}`}>
                {zone.guarantee}
              </p>
            </section>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Asks for the blunt confirmation before a shell on the host is granted. */
export function FullAccessConfirm({
  onConfirm,
  onCancel,
}: {
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [understood, setUnderstood] = useState(false);
  return (
    <div
      role="alertdialog"
      aria-label="Confirm full access"
      className="flex flex-col gap-2 rounded-row border border-destructive/40 bg-destructive/5 p-3"
      data-testid="lp-access-confirm"
    >
      <p className="text-sm font-medium">Give a shell on this computer?</p>
      <p className="text-sm text-muted-foreground">{FULL_ACCESS_WARNING}</p>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={understood}
          data-testid="lp-access-confirm-checkbox"
          onChange={(event) => setUnderstood(event.target.checked)}
        />
        I understand this is my real computer
      </label>
      <div className="flex gap-2">
        <Button size="xs" variant="destructive" disabled={!understood} data-testid="lp-access-confirm-go" onClick={onConfirm}>
          Give full access
        </Button>
        <Button size="xs" variant="ghost" data-testid="lp-access-confirm-cancel" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/**
 * A change that needs the blunt warning waits here; everything else applies at once. Returns the
 * state to render and the function to call with a change.
 */
export function useGuardedAccessChange(apply: (zones: ZoneValues, confirmFull: boolean) => Promise<unknown>) {
  const [pending, setPending] = useState<ZoneValues | null>(null);
  const [error, setError] = useState<string | null>(null);
  const request = (zones: ZoneValues) => {
    setError(null);
    if (needsGrantWarning(zones)) {
      setPending(zones);
      return;
    }
    void apply(zones, false).catch((cause) => setError(errorText(cause)));
  };
  const confirm = () => {
    const zones = pending;
    setPending(null);
    if (zones !== null) void apply(zones, true).catch((cause) => setError(errorText(cause)));
  };
  return { pending, error, request, confirm, cancel: () => setPending(null) };
}

/** A member's seat badges: what stands out about their access. */
export function SeatBadges({ seat }: { seat: LpSeat | undefined }) {
  if (seat === undefined) return null;
  return (
    <span className="flex items-center gap-1">
      <Badge variant="outline" data-testid="lp-seat-preset">
        {PRESET_LABEL(seat.preset)}
      </Badge>
      {seatHasCompute(seat) ? (
        <Badge variant="warning" data-testid="lp-badge-terminal">
          <TerminalIcon className="size-3" />
          Terminal
        </Badge>
      ) : null}
    </span>
  );
}

/** One person's access in Manage people: a preset, or back to following the default. */
export function MemberAccessSelect({
  seat,
  onPick,
  onFollowDefault,
  testId,
}: {
  seat: LpSeat | undefined;
  onPick: (preset: PresetId) => void;
  onFollowDefault: () => void;
  testId: string;
}) {
  const value = seat?.source === "override" || seat?.source === "seat" ? seat.preset : "default";
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        if (next === "default") onFollowDefault();
        else if (next !== null && next !== "custom") onPick(next as PresetId);
      }}
      disabled={seat?.source === "seat"}
    >
      <SelectTrigger size="sm" className="w-36" aria-label="Access" data-testid={testId}>
        <SelectValue>
          {seat?.source === "seat"
            ? "Read only (seat)"
            : value === "default"
              ? `Default (${PRESET_LABEL(seat?.preset ?? "edit")})`
              : PRESET_LABEL(value)}
        </SelectValue>
      </SelectTrigger>
      <SelectPopup>
        <SelectItem value="default">Follow the default</SelectItem>
        {ACCESS_PRESETS.map((preset) => (
          <SelectItem key={preset.id} value={preset.id}>
            {preset.label}
          </SelectItem>
        ))}
        {value === "custom" ? <SelectItem value="custom">Custom</SelectItem> : null}
      </SelectPopup>
    </Select>
  );
}

const kindLabel: Record<string, string> = {
  "terminal.open": "Opened a terminal",
  "terminal.close": "Closed a terminal",
  "terminal.command": "Ran a command",
  "terminal.revoked": "Terminal closed",
  "zones.changed": "Access changed",
  "access.requested": "Asked for access",
  "access.allowed": "Allowed",
  "access.denied": "Denied",
};

export function AccessRequestsList({
  projectId,
  requests,
  onDone,
}: {
  projectId: string;
  requests: ReadonlyArray<LpAccessRequest>;
  onDone: () => void;
}) {
  const [confirming, setConfirming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (requests.length === 0) return null;
  const decide = (id: string, decision: "allow" | "deny", confirmFull = false) => {
    setError(null);
    accessApi
      .decide({ projectId, requestId: id, decision, confirmFull })
      .then(() => {
        setConfirming(null);
        onDone();
      })
      .catch((cause) => setError(errorText(cause)));
  };
  return (
    <section className="flex flex-col gap-1.5" aria-label="Requests" data-testid="lp-access-requests">
      <h3 className="text-sm font-medium">Requests</h3>
      {requests.map((request) => (
        <div key={request.id} className="flex flex-col gap-1.5 rounded-row border border-hairline p-2.5">
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 text-sm">
              {request.name} asks for{" "}
              {request.zone === "ai" ? "your Claude (the AI zone)" : "terminal access (Compute)"}
            </span>
            <Button
              size="xs"
              data-testid={`lp-access-allow-${request.zone}`}
              onClick={() =>
                request.zone === "compute" ? setConfirming(request.id) : decide(request.id, "allow")
              }
            >
              Allow
            </Button>
            <Button
              size="xs"
              variant="outline"
              data-testid={`lp-access-deny-${request.zone}`}
              onClick={() => decide(request.id, "deny")}
            >
              Deny
            </Button>
          </div>
          {confirming === request.id ? (
            <FullAccessConfirm
              onConfirm={() => decide(request.id, "allow", true)}
              onCancel={() => setConfirming(null)}
            />
          ) : null}
        </div>
      ))}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </section>
  );
}

export function AccessLogList({ log }: { log: ReadonlyArray<LpAccessLogEntry> }) {
  if (log.length === 0) return null;
  return (
    <section className="flex flex-col gap-1" aria-label="Access activity" data-testid="lp-access-log">
      <h3 className="text-sm font-medium">Access activity</h3>
      <ul className="flex flex-col gap-0.5 text-xs text-muted-foreground">
        {log.slice(0, 12).map((entry) => (
          <li key={entry.id} data-kind={entry.kind}>
            <span className="text-foreground">{entry.name}</span> {kindLabel[entry.kind] ?? entry.kind}:{" "}
            {entry.detail}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** A request button: asks the host, then says it is waiting. */
export function RequestAccessButton({
  projectId,
  zone,
  children,
  testId,
}: {
  projectId: string;
  zone: "ai" | "compute";
  children: ReactNode;
  testId: string;
}) {
  const [sent, setSent] = useState(false);
  return sent ? (
    <span className="text-xs text-muted-foreground" data-testid={`${testId}-sent`}>
      Request sent. The host will see it.
    </span>
  ) : (
    <Button
      size="xs"
      variant="outline"
      data-testid={testId}
      onClick={() =>
        void accessApi
          .request(projectId, zone)
          .then(() => setSent(true))
          .catch((cause) => toastManager.add({ type: "error", title: errorText(cause) }))
      }
    >
      {children}
    </Button>
  );
}

/**
 * Stands in for the terminal when a member's Compute zone is off: says why and offers the request
 * instead of an error line in an empty terminal. The server refuses terminal calls either way.
 */
export function LpTerminalGate({
  projectId,
  onReenabled,
  children,
}: {
  projectId: string | null;
  /** Compute came back after it was off: the terminals shown before are gone, start clean. */
  onReenabled?: () => void;
  children: ReactNode;
}) {
  const { session } = useLogicPacksSession(false);
  const seat = seatIn(session, projectId);
  const allowed = seat === null || projectHasHostTerminal(seat);
  const wasAllowed = useRef(allowed);
  useEffect(() => {
    // When the host turns Compute off, the server closes the member's terminals. When it comes
    // back, the remembered terminal ids would be refused ("That terminal is not yours"): forget them.
    if (allowed && !wasAllowed.current) onReenabled?.();
    wasAllowed.current = allowed;
  }, [allowed, onReenabled]);
  if (allowed) return <>{children}</>;
  return (
    <div
      className="flex flex-col items-start gap-2 border-t p-4 text-sm"
      role="status"
      data-testid="lp-terminal-off"
    >
      <p>
        The terminal is off for you in this project. A terminal runs commands on the host's computer,
        so the host decides who gets one.
      </p>
      {projectId === null ? null : (
        <RequestAccessButton projectId={projectId} zone="compute" testId="lp-request-terminal">
          Request terminal access
        </RequestAccessButton>
      )}
    </div>
  );
}

export { refreshLogicPacksSession, zonesForPreset };

/**
 * Above a member's composer: whose agent this message runs on, or that the host has not lent it
 * and a request is one click away. Not shown to the host. The server refuses an unlent turn.
 */
export function LpComposerAccessNote({
  projectId,
  selected,
}: {
  projectId: string | null;
  selected: { readonly instanceId: string; readonly driver: string } | null;
}) {
  const { session } = useLogicPacksSession(false);
  const note = composerAccess(session, projectId, selected);
  if (note.kind === "none") return null;
  return (
    <div
      className="flex items-center gap-2 px-1 pb-1.5 text-xs text-muted-foreground"
      role="status"
      data-testid="lp-composer-access-note"
      data-access={note.kind}
    >
      <span>{note.text}</span>
      {note.kind === "request" && projectId !== null ? (
        <RequestAccessButton projectId={projectId} zone="ai" testId="lp-request-ai">
          {note.agent === null ? "Request host's agent" : `Request host's ${AGENT_LABELS[note.agent]}`}
        </RequestAccessButton>
      ) : null}
    </div>
  );
}
