import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpRouter } from "effect/http";

import { json, readBody, resolveCaller, type Caller } from "./http.ts";
import {
  OPERATOR_PREFS_OWNER,
  readUserPrefs,
  writeUserPrefs,
  type UserPrefsError,
} from "./userPrefs.ts";

const PrefsPatchRequest = Schema.Struct({
  prefs: Schema.Record(Schema.String, Schema.Unknown),
});

const ownerOf = (caller: Caller) =>
  caller.kind === "member"
    ? caller.userId
    : caller.kind === "operator"
      ? OPERATOR_PREFS_OWNER
      : null;

const prefsErrorResponse = (error: UserPrefsError) =>
  Effect.succeed(
    json({ error: error.reason, message: error.message }, error.reason === "invalid" ? 400 : 500),
  );

const readRoute = HttpRouter.add(
  "GET",
  "/api/lp/prefs",
  Effect.gen(function* () {
    const owner = ownerOf(yield* resolveCaller);
    if (owner === null) return json({ error: "unauthenticated" }, 401);
    return json({ prefs: yield* readUserPrefs(owner) });
  }).pipe(Effect.catchTags({ UserPrefsError: prefsErrorResponse })),
);

const writeRoute = HttpRouter.add(
  "POST",
  "/api/lp/prefs",
  Effect.gen(function* () {
    const owner = ownerOf(yield* resolveCaller);
    if (owner === null) return json({ error: "unauthenticated" }, 401);
    const body = yield* readBody(PrefsPatchRequest);
    if (body === null) return json({ error: "bad_request" }, 400);
    yield* writeUserPrefs(owner, body.prefs);
    return json({ prefs: yield* readUserPrefs(owner) });
  }).pipe(Effect.catchTags({ UserPrefsError: prefsErrorResponse })),
);

export const layer = Layer.mergeAll(readRoute, writeRoute);
