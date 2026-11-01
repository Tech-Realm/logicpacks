import { WS_METHODS } from "@logicpacks/contracts";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

/** The LogicPacks workspace leaderboard and achievement shelves of one environment (host). */
export function createLogicPacksUsageEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const leaderboard = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:logicpacks:leaderboard",
    tag: WS_METHODS.logicpacksGetLeaderboard,
    staleTimeMs: 15_000,
  });
  const achievements = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:logicpacks:achievements",
    tag: WS_METHODS.logicpacksGetAchievements,
    staleTimeMs: 15_000,
  });
  return {
    leaderboard,
    achievements,
    // Callers refresh the leaderboard they show after this settles.
    setUsageSharing: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:logicpacks:set-usage-sharing",
      tag: WS_METHODS.logicpacksSetUsageSharing,
    }),
  };
}
