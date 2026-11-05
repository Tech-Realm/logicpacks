import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { canCompute } from "@logicpacks/contracts";

import * as TerminalManager from "../terminal/Manager.ts";
import { LogicPacksAccess } from "./LogicPacksAccess.ts";
import { allMemberTerminals, forgetTerminal } from "./memberTerminalRegistry.ts";

/**
 * Live revocation: whenever a zone changes, every member terminal whose owner no longer has
 * Compute in its project is closed and logged. The terminal process dies with it, so the attach
 * and observe streams end. A reaper per server, not per connection: the member may be offline
 * and the host may be the one who changed the setting.
 */
export const layerTerminalReaper = Layer.effectDiscard(
  Effect.gen(function* () {
    const accessOption = yield* Effect.serviceOption(LogicPacksAccess);
    const managerOption = yield* Effect.serviceOption(TerminalManager.TerminalManager);
    if (accessOption._tag === "None" || managerOption._tag === "None") return;
    const access = accessOption.value;
    const manager = managerOption.value;
    const runFork = Effect.runForkWith(yield* Effect.context<never>());
    // Suspended: the registry changes, so the list is read at each sweep, not once at build.
    const sweep = Effect.suspend(() => Effect.forEach(
      allMemberTerminals(),
      (owner) => {
        if (owner.userId === null) return Effect.void;
        const zones = access.zonesOf(owner.userId, owner.projectId);
        if (access.roleOf(owner.userId, owner.projectId ?? "") !== null && canCompute(zones.zones)) {
          return Effect.void;
        }
        return manager.close({ threadId: owner.threadId, terminalId: owner.terminalId }).pipe(
          Effect.ignoreCause,
          // Forget only after the close, so the owner still sees the terminal's "remove" event.
          Effect.andThen(Effect.sync(() => forgetTerminal(owner.threadId, owner.terminalId))),
          Effect.andThen(
            access.logAccess({
              projectId: owner.projectId,
              userId: owner.userId,
              kind: "terminal.revoked",
              detail: `Terminal ${owner.terminalId} closed: terminal access was turned off.`,
            }),
          ),
        );
      },
      { discard: true },
    ));
    access.onZonesChanged(() => {
      runFork(sweep);
    });
  }),
);
