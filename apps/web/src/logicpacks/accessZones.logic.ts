import {
  AGENT_LABELS,
  agentForDriver,
  canCompute,
  canMutate,
  canUseAgent,
  normalizeZones,
  type AccessAgent,
  type ZoneValues,
} from "@logicpacks/contracts";

import type { LpSeat, LpSession } from "./api";

/** The member's seat in a project; null for the host (everything allowed) or before the session loads. */
export function seatIn(session: LpSession | null, projectId: string | null): LpSeat | null {
  if (session === null || session.user == null || projectId === null) return null;
  return session.access?.[projectId] ?? null;
}

export const seatZones = (seat: LpSeat): ZoneValues => normalizeZones(seat.zones);

/** A login the member made themselves, not the host's: `claude-lp-<16 hex>`. */
export const isOwnLoginInstance = (instanceId: string): boolean =>
  /^(claude|codex|opencode|gemini)-lp-[0-9a-f]{16}$/.test(instanceId);

export type ComposerAccess =
  | { readonly kind: "none" }
  /** "Using host's Claude": plain words about whose subscription this turn spends. */
  | { readonly kind: "host"; readonly text: string }
  | { readonly kind: "own"; readonly text: string }
  /** The AI zone does not lend this agent: offer the request. */
  | { readonly kind: "request"; readonly text: string; readonly agent: AccessAgent | null };

/**
 * What the composer says for the selected model: whose agent it is, or that the host has not
 * lent it. The server refuses a turn the zone does not allow; this only explains it first.
 */
export function composerAccess(
  session: LpSession | null,
  projectId: string | null,
  selected: { readonly instanceId: string; readonly driver: string } | null,
): ComposerAccess {
  const seat = seatIn(session, projectId);
  if (seat === null || selected === null) return { kind: "none" };
  if (isOwnLoginInstance(selected.instanceId)) {
    const agent = agentForDriver(selected.driver);
    return { kind: "own", text: `Using your ${agent === null ? "own" : AGENT_LABELS[agent]} login` };
  }
  const agent = agentForDriver(selected.driver);
  const zones = seatZones(seat);
  const allowed = agent === null ? zones["ai.agents"].length > 0 : canUseAgent(zones, agent);
  const label = agent === null ? "agent" : AGENT_LABELS[agent];
  return allowed
    ? { kind: "host", text: `Using host's ${label}` }
    : {
        kind: "request",
        agent,
        text: `The host has not lent you their ${label}. Request it, or switch to your own login.`,
      };
}

export const seatCanMutate = (seat: LpSeat) => canMutate(seatZones(seat));
export const seatHasCompute = (seat: LpSeat) => canCompute(seatZones(seat));

/** A terminal is allowed for this seat (Compute on). */
export const projectHasHostTerminal = (seat: LpSeat) => canCompute(seatZones(seat));
