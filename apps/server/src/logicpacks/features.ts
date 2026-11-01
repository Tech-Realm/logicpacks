/**
 * The apps gate for the app-sharing routes, on top of the shared feature store
 * (`FeatureAccess`, access codes): the host owner and staff always have every
 * feature, members only once they redeemed a code that unlocks it.
 */
import * as Effect from "effect/Effect";

import { FeatureAccess } from "./FeatureAccess.ts";
import { type GatedFeature } from "./featureCodes.ts";
import { lockedMessage } from "./featureHttp.ts";
import { LogicPacksAccess } from "./LogicPacksAccess.ts";

export type FeatureMember =
  | { readonly kind: "operator" }
  | { readonly kind: "member"; readonly userId: string };

/** Whether this caller has the feature. Never fails: unknown members are locked out. */
export const requireFeature = Effect.fn("logicpacks.features.require")(function* (
  member: FeatureMember,
  feature: GatedFeature,
) {
  const features = yield* FeatureAccess;
  if (member.kind === "operator") return features.has({ kind: "operator" }, feature);
  const access = yield* LogicPacksAccess;
  const user = yield* access.getUser(member.userId).pipe(Effect.orElseSucceed(() => null));
  return features.has(
    { kind: "member", userId: member.userId, email: user?.email ?? null },
    feature,
  );
});

/** The 403 body every gated app-sharing route answers with. */
export const FEATURE_LOCKED = {
  error: "feature_locked",
  feature: "apps",
  message: lockedMessage("apps"),
} as const;
