import { AuthOrchestrationReadScope, PresenceUpdateInput, ProjectId } from "@logicpacks/contracts";
import * as ByteSize from "effect/ByteSize";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { LogicPacksAccess } from "./LogicPacksAccess.ts";
import { describePresence } from "./presence.ts";
import { makePresenceConnection } from "./presenceConnection.ts";
import { memberUserIdFromSubject } from "./projectAccess.ts";

const NO_STORE = { "cache-control": "no-store" };
const MAX_BODY_BYTES = 8 * 1024;

const json = (body: unknown, status = 200) =>
  HttpServerResponse.jsonUnsafe(body, { status, headers: NO_STORE });

/**
 * The helper and outside agents have no socket; they post the same
 * `presence.update` payload here with their LogicPacks token. Their spots
 * expire on the normal idle timeout since there is no disconnect to watch.
 */
const httpPresenceConnection = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const session = yield* serverAuth.authenticateHttpRequest(request).pipe(Effect.option);
  if (Option.isNone(session) || !session.value.scopes.includes(AuthOrchestrationReadScope)) {
    return null;
  }
  const access = yield* LogicPacksAccess;
  const userId = memberUserIdFromSubject(session.value.subject);
  return yield* makePresenceConnection({
    subject: session.value.subject,
    connectionId: null,
    keyPrefix: `http:${session.value.sessionId}`,
    canSeeProject: (projectId) => userId === null || access.roleOf(userId, projectId) !== null,
  });
});

const reportRoute = HttpRouter.add(
  "POST",
  "/api/lp/presence",
  Effect.gen(function* () {
    const connection = yield* httpPresenceConnection;
    if (connection === null) return json({ error: "unauthenticated" }, 401);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const body = yield* request.json.pipe(
      Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(MAX_BODY_BYTES)),
      Effect.flatMap(Schema.decodeUnknownEffect(PresenceUpdateInput)),
      Effect.option,
    );
    if (Option.isNone(body)) return json({ error: "bad_request" }, 400);
    yield* connection.report(body.value);
    return json({ ok: true });
  }),
);

/** Who is where, as entries plus one readable line each, for agents applying the no-overlap rule. */
const listRoute = HttpRouter.add(
  "GET",
  "/api/lp/presence",
  Effect.gen(function* () {
    const connection = yield* httpPresenceConnection;
    if (connection === null) return json({ error: "unauthenticated" }, 401);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    const projectId = Option.isSome(url) ? url.value.searchParams.get("projectId") : null;
    const entries = yield* connection.list(
      projectId ? { projectId: ProjectId.make(projectId) } : {},
    );
    const nowMs = yield* Clock.currentTimeMillis;
    return json({
      entries,
      summary: entries.map((entry) => describePresence(entry, nowMs)),
    });
  }),
);

export const layer = Layer.mergeAll(reportRoute, listRoute);
