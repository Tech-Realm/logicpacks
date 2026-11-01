import * as Effect from "effect/Effect";

import type { LogicPacksUser } from "./LogicPacksAccess.ts";
import { ProjectShares } from "./ProjectShares.ts";

/**
 * Turns invites sent to this account's email into project access. Optional so hosts and
 * tests without the share service still sign people in, and a failure here never blocks one.
 */
export const claimShareInvites = (user: LogicPacksUser) =>
  Effect.serviceOption(ProjectShares).pipe(
    Effect.flatMap((shares) =>
      shares._tag === "None" ? Effect.void : shares.value.claimInvites(user).pipe(Effect.asVoid),
    ),
    Effect.catch((error) =>
      Effect.logWarning("LogicPacks could not open shared projects for a sign-in", {
        userId: user.userId,
        error: String(error.message),
      }),
    ),
  );
