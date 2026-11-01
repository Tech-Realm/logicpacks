import { createLogicPacksUsageEnvironmentAtoms } from "@logicpacks/client-runtime/state/logicpacksUsage";

import { connectionAtomRuntime } from "../connection/runtime";

/** The LogicPacks leaderboard and achievements, read from an environment (the host). */
export const logicPacksUsageEnvironment =
  createLogicPacksUsageEnvironmentAtoms(connectionAtomRuntime);
