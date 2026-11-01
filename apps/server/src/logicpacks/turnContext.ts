import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

/**
 * The project ledger's live summary for one thread's next turn: other threads,
 * messages waiting for it, conflicts and negotiations. Empty means nothing to
 * add. The default adds nothing, so upstream wiring and replays run unchanged.
 */
export class ProjectLedgerTurnContext extends Context.Reference<{
  readonly forTurn: (threadId: string) => Effect.Effect<string>;
}>("logicpacks/logicpacks/ProjectLedgerTurnContext", {
  defaultValue: () => ({ forTurn: () => Effect.succeed("") }),
}) {}
