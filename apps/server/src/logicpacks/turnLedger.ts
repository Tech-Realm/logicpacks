import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

/**
 * What the orchestration ingestor knows when a provider turn ends. Plain data,
 * so the ingestor does not depend on LogicPacks code beyond this reference.
 */
export interface CompletedTurn {
  readonly providerInstanceId: string;
  readonly providerTurnId: string;
  readonly threadId: string;
  readonly driver: string;
  readonly model: string | null;
  readonly status: string;
  readonly startedAtMs: number | null;
  readonly completedAtMs: number | null;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheCreationTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  /** True when a delegated, scheduled or agent-sent message started the turn. */
  readonly autonomous: boolean;
}

/**
 * Records each finished provider turn into the LogicPacks usage ledger. The
 * default does nothing, so upstream wiring and tests run unchanged.
 */
export class ProviderTurnLedger extends Context.Reference<{
  readonly record: (turn: CompletedTurn) => Effect.Effect<void>;
}>("logicpacks/logicpacks/ProviderTurnLedger", {
  defaultValue: () => ({ record: () => Effect.void }),
}) {}

interface TurnUsageLike {
  readonly inputTokens?: number | undefined;
  readonly cachedInputTokens?: number | undefined;
  readonly cacheCreationTokens?: number | undefined;
  readonly outputTokens?: number | undefined;
  readonly reasoningTokens?: number | undefined;
}

interface OriginLike {
  readonly createdBy?: string | undefined;
  readonly scheduled?: boolean | undefined;
  readonly subagent?: boolean | undefined;
}

const count = (value: number | undefined) =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;

/** Builds the ledger record from the ingestor's turn and analytics context. */
export const completedTurnFrom = (input: {
  readonly providerInstanceId: string;
  readonly threadId: string;
  readonly driver: string;
  readonly providerTurn: {
    readonly id: string;
    readonly status: string;
    readonly startedAtMs: number | null;
    readonly completedAtMs: number | null;
    readonly turnTokenUsage?: TurnUsageLike | undefined;
  };
  readonly model: string | null;
  readonly origin?: OriginLike | undefined;
}): CompletedTurn => {
  const usage = input.providerTurn.turnTokenUsage;
  const origin = input.origin;
  return {
    providerInstanceId: input.providerInstanceId,
    providerTurnId: input.providerTurn.id,
    threadId: input.threadId,
    driver: input.driver,
    model: input.model,
    status: input.providerTurn.status,
    startedAtMs: input.providerTurn.startedAtMs,
    completedAtMs: input.providerTurn.completedAtMs,
    inputTokens: count(usage?.inputTokens),
    cachedInputTokens: count(usage?.cachedInputTokens),
    cacheCreationTokens: count(usage?.cacheCreationTokens),
    outputTokens: count(usage?.outputTokens),
    reasoningTokens: count(usage?.reasoningTokens),
    autonomous:
      origin !== undefined &&
      (origin.createdBy !== "user" || origin.scheduled === true || origin.subagent === true),
  };
};
