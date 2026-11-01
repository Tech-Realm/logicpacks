import {
  applyPresenceStreamEvent,
  type PresenceEntry,
  type PresenceSubscribeInput,
  WS_METHODS,
} from "@logicpacks/contracts";
import * as Stream from "effect/Stream";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { subscribe } from "../rpc/client.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentSubscriptionAtomFamily,
} from "./runtime.ts";

const EMPTY_PRESENCE: ReadonlyMap<string, PresenceEntry> = new Map();

export function createPresenceEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    /** Everyone's live spot in the projects this session can see, keyed by entry key. */
    entries: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: "environment-data:presence",
      idleTtlMs: 30_000,
      subscribe: (input: PresenceSubscribeInput) =>
        subscribe(WS_METHODS.presenceSubscribe, input).pipe(
          Stream.scan(() => EMPTY_PRESENCE, applyPresenceStreamEvent),
          // The scan seed is not the server's snapshot.
          Stream.drop(1),
        ),
    }),
    // Only the newest spot per tab matters; a stale cursor in flight is dropped.
    update: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:presence:update",
      tag: WS_METHODS.presenceUpdate,
      scheduler: createAtomCommandScheduler(),
      concurrency: {
        mode: "latest",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.clientId]),
      },
    }),
  };
}
