// @effect-diagnostics nodeBuiltinImport:off
import { AuthAccessWriteScope, AuthOrchestrationReadScope } from "@logicpacks/contracts";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as ByteSize from "effect/ByteSize";
import * as Config from "effect/Config";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import { deriveAuthClientMetadata } from "../auth/utils.ts";
import { ExternalSessions, type HelperCaller } from "./ExternalSessions.ts";
import {
  ExternalSessionBatch,
  ExternalSessionLocation,
  ExternalSessionSource,
} from "./externalSessionMapping.ts";
import { HelperPairing } from "./helperPairing.ts";
import { helperApprovePageHtml } from "./loginPage.ts";
import { LogicPacksAccess } from "./LogicPacksAccess.ts";
import {
  HELPER_LOCAL_OPERATOR_SUBJECT,
  memberSubject,
  memberUserIdFromSubject,
} from "./projectAccess.ts";

const NO_STORE = { "cache-control": "no-store" };
const HELPER_TOKEN_TTL = Duration.days(365);
/** The subject of helper tokens the host operator approves; members' tokens carry their own subject. */
export const HELPER_OPERATOR_SUBJECT = "lp-helper:operator";
const SMALL_BODY = ByteSize.bytes(16 * 1024);
const INGEST_BODY = ByteSize.mebibytes(4);

const json = (body: unknown, status = 200) =>
  HttpServerResponse.jsonUnsafe(body, { status, headers: NO_STORE });

const readBody = Effect.fn("logicpacks.helper.readBody")(function* <A>(
  schema: Schema.Decoder<A>,
  maxBytes: ByteSize.ByteSize = SMALL_BODY,
) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const body = yield* request.json.pipe(
    Effect.provideService(HttpIncomingMessage.MaxBodySize, maxBytes),
    Effect.flatMap(Schema.decodeUnknownEffect(schema)),
    Effect.option,
  );
  return body._tag === "Some" ? body.value : null;
});

const queryParam = (name: string) =>
  Effect.map(HttpServerRequest.HttpServerRequest, (request) => {
    const url = HttpServerRequest.toURL(request);
    return url._tag === "Some" ? (url.value.searchParams.get(name) ?? "") : "";
  });

/** A member (their own subject), an approved helper of the operator, or an operator session. */
export const resolveHelperCaller = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const session = yield* auth.authenticateHttpRequest(request).pipe(Effect.option);
  if (session._tag === "None") return null;
  const userId = memberUserIdFromSubject(session.value.subject);
  if (userId !== null) return { kind: "member", userId } as HelperCaller;
  if (
    session.value.subject === HELPER_OPERATOR_SUBJECT ||
    session.value.subject === HELPER_LOCAL_OPERATOR_SUBJECT ||
    session.value.scopes.includes(AuthAccessWriteScope)
  ) {
    return { kind: "operator" } as HelperCaller;
  }
  return null;
});

const unauthenticated = json(
  { error: "unauthenticated", message: "Run lp login to connect this computer." },
  401,
);

const callerLabel = Effect.fn("logicpacks.helper.callerLabel")(function* (caller: HelperCaller) {
  if (caller.kind === "operator") return "the host owner";
  const access = yield* LogicPacksAccess;
  const user = yield* access.getUser(caller.userId).pipe(Effect.orElseSucceed(() => null));
  return user?.displayName ?? "a member";
});

/** Helper tokens can read and stream only; members' tokens stay inside their member fence. */
const issueHelperToken = Effect.fn("logicpacks.helper.issueToken")(function* (
  caller: HelperCaller,
  device: string | null,
  operatorSubject: string = HELPER_OPERATOR_SUBJECT,
) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const sessions = yield* SessionStore.SessionStore;
  const issued = yield* sessions.issue({
    ttl: HELPER_TOKEN_TTL,
    subject: caller.kind === "member" ? memberSubject(caller.userId) : operatorSubject,
    method: "bearer-access-token",
    scopes: [AuthOrchestrationReadScope],
    client: {
      ...deriveAuthClientMetadata({ request }),
      label: `LogicPacks helper${device ? ` (${device.slice(0, 60)})` : ""}`,
    },
  });
  return { token: issued.token, who: yield* callerLabel(caller) };
});

const storageFailure = (error: { readonly message: string }) =>
  Effect.succeed(json({ error: "storage", message: error.message }, 500));

const LocalPairRequest = Schema.Struct({
  key: Schema.String,
  device: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

/** File next to server-runtime.json that only a process able to read the app's data folder can open. */
export const LOCAL_HELPER_KEY_FILE = "helper-local.key";

const localKeyPath = (config: ServerConfig.ServerConfig["Service"]) =>
  NodePath.join(NodePath.dirname(config.serverRuntimeStatePath), LOCAL_HELPER_KEY_FILE);

/** Creates the key on first use (0600). Returns null when the data folder cannot hold one. */
export const readOrCreateLocalHelperKey = (file: string): string | null => {
  try {
    const existing = NodeFS.readFileSync(file, "utf8").trim();
    if (existing.length >= 32) return existing;
  } catch {}
  try {
    NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
    const key = NodeCrypto.randomBytes(32).toString("base64url");
    NodeFS.writeFileSync(file, `${key}\n`, { mode: 0o600 });
    return key;
  } catch {
    return null;
  }
};

export const localKeyMatches = (expected: string, given: string) => {
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && NodeCrypto.timingSafeEqual(a, b);
};

/**
 * `lp login` on the machine that runs the LogicPacks app: the helper proves it can read the
 * app's data folder (the key file), so the owner needs no browser step. Never on the cloud host.
 */
const pairLocalRoute = HttpRouter.add(
  "POST",
  "/api/lp/helper/pair/local",
  Effect.gen(function* () {
    const cloud = yield* Config.Boolean("LOGICPACKS_CLOUD_HOST").pipe(
      Config.withDefault(false),
      Effect.orElseSucceed(() => false),
    );
    if (cloud) return json({ error: "not_found" }, 404);
    const body = yield* readBody(LocalPairRequest);
    if (body === null) return json({ error: "bad_request" }, 400);
    const config = yield* ServerConfig.ServerConfig;
    const expected = readOrCreateLocalHelperKey(localKeyPath(config));
    if (expected === null || !localKeyMatches(expected, body.key)) {
      return json({ error: "forbidden", message: "This computer is not the app's owner." }, 403);
    }
    return json(
      yield* issueHelperToken(
        { kind: "operator" },
        body.device?.trim() || null,
        HELPER_LOCAL_OPERATOR_SUBJECT,
      ),
    );
  }).pipe(Effect.catch(storageFailure)),
);

/** Lets a helper learn the app is local and makes sure the key file exists before it reads it. */
const localProbeRoute = HttpRouter.add(
  "GET",
  "/api/lp/helper/pair/local",
  Effect.gen(function* () {
    const cloud = yield* Config.Boolean("LOGICPACKS_CLOUD_HOST").pipe(
      Config.withDefault(false),
      Effect.orElseSucceed(() => false),
    );
    if (cloud) return json({ error: "not_found" }, 404);
    const config = yield* ServerConfig.ServerConfig;
    return json({ local: readOrCreateLocalHelperKey(localKeyPath(config)) !== null });
  }),
);

const StartRequest = Schema.Struct({ device: Schema.optionalKey(Schema.NullOr(Schema.String)) });
const CodeRequest = Schema.Struct({ code: Schema.String });
const PollRequest = Schema.Struct({ pollToken: Schema.String });
const ContextRequest = Schema.Struct({
  ...ExternalSessionLocation.fields,
  source: Schema.optionalKey(ExternalSessionSource),
  sessionId: Schema.optionalKey(Schema.String),
});

const pairStartRoute = HttpRouter.add(
  "POST",
  "/api/lp/helper/pair/start",
  Effect.gen(function* () {
    const body = yield* readBody(StartRequest);
    const pairing = yield* HelperPairing;
    const started = pairing.start(body?.device?.trim().slice(0, 80) || null);
    return json({ ...started, approvePath: `/lp/helper?code=${started.code}` });
  }),
);

const approvePageRoute = HttpRouter.add(
  "GET",
  "/lp/helper",
  Effect.succeed(
    HttpServerResponse.html(helperApprovePageHtml()).pipe(HttpServerResponse.setHeaders(NO_STORE)),
  ),
);

const pairDescribeRoute = HttpRouter.add(
  "GET",
  "/api/lp/helper/pair",
  Effect.gen(function* () {
    const pairing = yield* HelperPairing;
    const found = pairing.describe(yield* queryParam("code"));
    return found === null ? json({ error: "expired" }, 404) : json(found);
  }),
);

const pairApproveRoute = HttpRouter.add(
  "POST",
  "/api/lp/helper/pair/approve",
  Effect.gen(function* () {
    const caller = yield* resolveHelperCaller;
    if (caller === null) return json({ error: "unauthenticated", message: "Sign in first." }, 401);
    const body = yield* readBody(CodeRequest);
    if (body === null) return json({ error: "bad_request" }, 400);
    const pairing = yield* HelperPairing;
    const reserved = pairing.reserve(body.code);
    if (reserved === null) {
      return json(
        {
          error: "expired",
          message: "This code was already used or has expired. Run lp login again for a new one.",
        },
        404,
      );
    }
    const minted = yield* issueHelperToken(caller, reserved.device).pipe(
      Effect.tapError(() => Effect.sync(() => pairing.complete(reserved.code, null))),
    );
    pairing.complete(reserved.code, minted);
    return json({ approved: true, who: minted.who });
  }).pipe(Effect.catch(storageFailure)),
);

const pairPollRoute = HttpRouter.add(
  "POST",
  "/api/lp/helper/pair/poll",
  Effect.gen(function* () {
    const body = yield* readBody(PollRequest);
    if (body === null) return json({ error: "bad_request" }, 400);
    const pairing = yield* HelperPairing;
    return json(pairing.poll(body.pollToken));
  }),
);

/** For the account page's "Connect a terminal" and scripted setups: a token for the signed-in caller. */
const tokenRoute = HttpRouter.add(
  "POST",
  "/api/lp/helper/token",
  Effect.gen(function* () {
    const caller = yield* resolveHelperCaller;
    if (caller === null) return unauthenticated;
    const body = yield* readBody(StartRequest);
    return json(yield* issueHelperToken(caller, body?.device?.trim() || null));
  }).pipe(Effect.catch(storageFailure)),
);

const whoamiRoute = HttpRouter.add(
  "GET",
  "/api/lp/helper/whoami",
  Effect.gen(function* () {
    const caller = yield* resolveHelperCaller;
    if (caller === null) return unauthenticated;
    return json({ kind: caller.kind, who: yield* callerLabel(caller) });
  }),
);

const logoutRoute = HttpRouter.add(
  "POST",
  "/api/lp/helper/logout",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const session = yield* auth.authenticateHttpRequest(request).pipe(Effect.option);
    if (session._tag === "None") return json({ revoked: false });
    const isHelperToken =
      session.value.method === "bearer-access-token" &&
      (session.value.subject === HELPER_OPERATOR_SUBJECT ||
        session.value.subject === HELPER_LOCAL_OPERATOR_SUBJECT ||
        memberUserIdFromSubject(session.value.subject) !== null);
    if (!isHelperToken) return json({ error: "not_a_helper_token" }, 400);
    const sessions = yield* SessionStore.SessionStore;
    return json({ revoked: yield* sessions.revoke(session.value.sessionId) });
  }).pipe(Effect.catch(storageFailure)),
);

const ingestRoute = HttpRouter.add(
  "POST",
  "/api/lp/helper/ingest",
  Effect.gen(function* () {
    const caller = yield* resolveHelperCaller;
    if (caller === null) return unauthenticated;
    const batch = yield* readBody(ExternalSessionBatch, INGEST_BODY);
    if (batch === null) return json({ error: "bad_request" }, 400);
    const sessions = yield* ExternalSessions;
    return json(yield* sessions.ingest(caller, batch));
  }).pipe(
    Effect.catchTags({
      ExternalSessionError: (error) =>
        Effect.succeed(
          json(
            { error: error.reason, message: error.message },
            error.reason === "storage" ? 500 : 400,
          ),
        ),
    }),
  ),
);

const contextRoute = HttpRouter.add(
  "POST",
  "/api/lp/helper/context",
  Effect.gen(function* () {
    const caller = yield* resolveHelperCaller;
    if (caller === null) return unauthenticated;
    const body = yield* readBody(ContextRequest);
    if (body === null) return json({ error: "bad_request" }, 400);
    const sessions = yield* ExternalSessions;
    return json(yield* sessions.context(caller, body));
  }).pipe(Effect.catchTags({ ExternalSessionError: storageFailure })),
);

const projectScoped = Effect.fn("logicpacks.helper.projectScoped")(function* <A>(
  read: (projectId: string) => Effect.Effect<A, { readonly message: string }, ExternalSessions>,
) {
  const caller = yield* resolveHelperCaller;
  if (caller === null) return unauthenticated;
  const projectId = yield* queryParam("projectId");
  const access = yield* LogicPacksAccess;
  if (caller.kind === "member" && access.roleOf(caller.userId, projectId) === null) {
    return json({ error: "not_found" }, 404);
  }
  return json(yield* read(projectId));
}, Effect.catch(storageFailure));

const externalSessionsRoute = HttpRouter.add(
  "GET",
  "/api/lp/external-sessions",
  projectScoped((projectId) =>
    Effect.flatMap(ExternalSessions, (sessions) =>
      Effect.map(sessions.list(projectId), (sessionsList) => ({ sessions: sessionsList })),
    ),
  ),
);

export const layer = Layer.mergeAll(
  pairStartRoute,
  approvePageRoute,
  pairDescribeRoute,
  pairApproveRoute,
  pairPollRoute,
  pairLocalRoute,
  localProbeRoute,
  tokenRoute,
  whoamiRoute,
  logoutRoute,
  ingestRoute,
  contextRoute,
  externalSessionsRoute,
);
