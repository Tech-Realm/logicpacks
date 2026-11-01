import * as Effect from "effect/Effect";
import { HttpServerResponse } from "effect/http";

import { FeatureAccess } from "./FeatureAccess.ts";
import { memberHasCloud } from "./featureHttp.ts";
import { type MemberProviderKind } from "./memberProviders.ts";

/**
 * Storing a member's AI login on this host is part of cloud sync (the `cloud` access feature,
 * which absorbed `cloud_agents`) and only exists on the LogicPacks cloud host. Everyone else
 * runs agents on their own computer with their own installed Claude Code or Codex, so no login
 * of theirs sits on a server. The cloud host's owner and staff always have it.
 */
export const cloudAgentsAllowed = Effect.fn("logicpacks.providers.cloudAgentsAllowed")(
  function* (user: { readonly userId: string; readonly email: string }) {
    const features = yield* FeatureAccess;
    if (!features.isCloudHost) return false;
    return yield* memberHasCloud(user);
  },
);

export const cloudLoginGate = Effect.fn("logicpacks.providers.cloudLoginGate")(function* (
  user: { readonly userId: string; readonly email: string },
  _kind: MemberProviderKind,
) {
  if (yield* cloudAgentsAllowed(user)) return null;
  return HttpServerResponse.jsonUnsafe(
    {
      error: "feature_locked",
      feature: "cloud",
      message:
        "Cloud agents are coming soon. Run agents on your computer with your own Claude Code or Codex.",
    },
    { status: 403, headers: { "cache-control": "no-store" } },
  );
});
