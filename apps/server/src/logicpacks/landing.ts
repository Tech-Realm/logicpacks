import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

/**
 * Whether a signed-out visitor lands on the LogicPacks sign-in page instead of the
 * pairing screen: on a cloud host, or wherever `LOGICPACKS_MEMBERS_LANDING=true`.
 * Desktop and local environments keep pairing.
 */
export const membersLanding = Effect.gen(function* () {
  const cloud = yield* Config.Boolean("LOGICPACKS_CLOUD_HOST").pipe(
    Config.withDefault(false),
    Effect.orElseSucceed(() => false),
  );
  const forced = yield* Config.Boolean("LOGICPACKS_MEMBERS_LANDING").pipe(
    Config.withDefault(false),
    Effect.orElseSucceed(() => false),
  );
  return cloud || forced;
});

/** The app shell paths a signed-out visitor is sent from; pairing and /lp pages are left alone. */
export const isSignedOutLandingPath = (pathname: string) =>
  pathname === "/" || pathname === "/index.html";
