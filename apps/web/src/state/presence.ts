import { createPresenceEnvironmentAtoms } from "@logicpacks/client-runtime/state/presence";

import { connectionAtomRuntime } from "../connection/runtime";

export const presenceEnvironment = createPresenceEnvironmentAtoms(connectionAtomRuntime);
