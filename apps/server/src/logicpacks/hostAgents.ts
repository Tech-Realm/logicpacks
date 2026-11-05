import {
  ACCESS_AGENTS,
  agentForDriver,
  type AccessAgent,
  type ResolvedZones,
} from "@logicpacks/contracts";
import * as Effect from "effect/Effect";

import { ProviderRegistry } from "../provider/ProviderRegistry.ts";

/** Agents this host actually has installed and enabled: only those can be lent. */
export const hostAgents = Effect.gen(function* () {
  const registry = yield* Effect.serviceOption(ProviderRegistry);
  if (registry._tag === "None") return [] as ReadonlyArray<AccessAgent>;
  const providers = yield* registry.value.getProviders;
  const found = new Set<AccessAgent>();
  for (const provider of providers) {
    const agent = agentForDriver(provider.driver);
    if (agent !== null && provider.installed && provider.enabled) found.add(agent);
  }
  return ACCESS_AGENTS.filter((agent) => found.has(agent));
});

export const accessSeatView = (resolved: ResolvedZones) => ({
  preset: resolved.preset,
  zones: resolved.zones,
  source: resolved.source,
});

