import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServerRequest } from "effect/http";

import { json, resolveCaller } from "../logicpacks/http.ts";
import { isRelayedHeaders } from "./relayTrust.ts";
import { ShareRelay } from "./ShareRelay.ts";

/**
 * The Share dialog on this computer reads and drives the relay here. The caller must be signed in
 * (the owner, or a member of this host) and must not have come through the relay itself: a visitor
 * on a public link can never start, stop or look at the tunnel.
 */
const localSignedIn = Effect.fn("shareRelay.localSignedIn")(function* <A, E, R>(run: Effect.Effect<A, E, R>) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  if (isRelayedHeaders(request.headers)) return json({ error: "not_found" }, 404);
  const caller = yield* resolveCaller;
  if (caller.kind === "anonymous") return json({ error: "unauthenticated" }, 401);
  return json(yield* run);
});

const statusRoute = HttpRouter.add("GET", "/api/lp/relay", localSignedIn(ShareRelay.use((relay) => relay.status())));
const enableRoute = HttpRouter.add("POST", "/api/lp/relay/enable", localSignedIn(ShareRelay.use((relay) => relay.enable())));
const disableRoute = HttpRouter.add("POST", "/api/lp/relay/disable", localSignedIn(ShareRelay.use((relay) => relay.disable())));

export const layer = Layer.mergeAll(statusRoute, enableRoute, disableRoute);
