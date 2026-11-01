import {
  AuthAccessWriteScope,
  type AuthEnvironmentScope,
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
} from "@logicpacks/contracts";
import * as Effect from "effect/Effect";

import { callerFromSubject, operatorCaller, type UsageCaller } from "./LogicPacksUsage.ts";
import { memberUserIdFromSubject } from "./projectAccess.ts";

interface SessionLike {
  readonly subject: string;
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
}

/**
 * The leaderboard participant a session acts as: a member, or the host operator
 * (a session that may manage access). Anyone else, such as a guest link, is not
 * on the leaderboard and cannot read it.
 */
export const usageCallerOf = (session: SessionLike): UsageCaller | null => {
  if (memberUserIdFromSubject(session.subject) !== null) return callerFromSubject(session.subject);
  return session.scopes.includes(AuthAccessWriteScope) ? operatorCaller : null;
};

export const usageCallerForSession = (session: SessionLike) => {
  const caller = usageCallerOf(session);
  return caller === null
    ? Effect.fail(
        new EnvironmentAuthorizationError({
          message: "Only host members can open the workspace leaderboard.",
          requiredScope: AuthOrchestrationReadScope,
        }),
      )
    : Effect.succeed(caller);
};
