import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { refuseIfProjectsOff } from "./zoneHttp.ts";
import { LogicPacksAccess, isOnboardingChoice } from "./LogicPacksAccess.ts";
import {
  issueMemberSession,
  json,
  queryParam,
  readBody,
  resolveCaller,
  withSessionCookie,
} from "./http.ts";
import { mockConsentPageHtml, oauthErrorPageHtml } from "./loginPage.ts";
import {
  type CompleteResult,
  HANDOFF_PATH,
  isConnectionProvider,
  MemberOAuth,
  type MemberOAuthError,
  mockAuthorizePath,
  RELAY_PATH,
} from "./MemberOAuth.ts";
import { createProject } from "./newProject.ts";
import { mockIdentity, type OAuthProviderId, providerLabel } from "./oauthProviders.ts";

const NO_STORE = { "cache-control": "no-store" };
/** Ties a provider callback to the browser that started it. */
const STATE_COOKIE = "lp_oauth_state";

const redirect = (location: string) =>
  HttpServerResponse.empty({ status: 302, headers: { ...NO_STORE, location } });

const errorPage = (message: string, status = 400) =>
  HttpServerResponse.html(oauthErrorPageHtml(message)).pipe(
    HttpServerResponse.setStatus(status),
    HttpServerResponse.setHeaders(NO_STORE),
  );

const oauthErrorPage = (error: MemberOAuthError) =>
  Effect.succeed(errorPage(error.message, error.reason === "storage" ? 500 : 400));

const withStateCookie = (state: string, secure: boolean) =>
  HttpServerResponse.setCookieUnsafe(STATE_COOKIE, state, {
    httpOnly: true,
    // Lax: the provider's redirect back is a top-level GET, which still carries it.
    sameSite: "lax",
    secure,
    path: "/",
    maxAge: "10 minutes",
  });

const cookieState = Effect.map(
  HttpServerRequest.HttpServerRequest,
  (request) => request.cookies[STATE_COOKIE] ?? null,
);

const secureCookies = (oauth: MemberOAuth["Service"]) =>
  oauth.settings.publicBaseUrl.startsWith("https://");

/** Signed in: the member's session cookie, the state cookie gone, then where they were going. */
const finish = Effect.fn("logicpacks.oauth.finish")(function* (result: CompleteResult) {
  switch (result.kind) {
    case "redirect":
      return redirect(result.location).pipe(
        HttpServerResponse.expireCookieUnsafe(STATE_COOKIE, { path: "/" }),
      );
    case "connected":
      return redirect(result.next ?? "/lp/account").pipe(
        HttpServerResponse.expireCookieUnsafe(STATE_COOKIE, { path: "/" }),
      );
    case "signed_in": {
      const session = yield* issueMemberSession(result.user);
      return yield* withSessionCookie(session)(
        redirect(result.next ?? "/").pipe(
          HttpServerResponse.expireCookieUnsafe(STATE_COOKIE, { path: "/" }),
        ),
      );
    }
  }
});

/**
 * `/lp/auth/<provider>/start?invite=…|project=…&next=…`: Continue with Google or GitHub, from
 * the login page, a workspace invite, or a project invite or share link.
 */
const startRoute = (provider: OAuthProviderId) =>
  HttpRouter.add(
    "GET",
    `/lp/auth/${provider}/start`,
    Effect.gen(function* () {
      const oauth = yield* MemberOAuth;
      const invite = yield* queryParam("invite");
      const project = yield* queryParam("project");
      const next = yield* queryParam("next");
      const started = yield* oauth.begin({ provider, intent: "signin", invite, project, next });
      return redirect(started.url).pipe(withStateCookie(started.state, secureCookies(oauth)));
    }).pipe(Effect.catchTags({ MemberOAuthError: oauthErrorPage })),
  );

/** `/lp/auth/<provider>/connect?next=…`: a signed-in member links GitHub or Cloudflare. */
const connectRoute = (provider: OAuthProviderId) =>
  HttpRouter.add(
    "GET",
    `/lp/auth/${provider}/connect`,
    Effect.gen(function* () {
      const caller = yield* resolveCaller;
      if (caller.kind !== "member") return redirect("/lp/login");
      const oauth = yield* MemberOAuth;
      const next = yield* queryParam("next");
      const started = yield* oauth.begin({
        provider,
        intent: "connect",
        next,
        userId: caller.userId,
      });
      return redirect(started.url).pipe(withStateCookie(started.state, secureCookies(oauth)));
    }).pipe(Effect.catchTags({ MemberOAuthError: oauthErrorPage })),
  );

const callbackHandler = Effect.fn("logicpacks.oauth.callback")(
  function* (provider: OAuthProviderId) {
    const providerError = yield* queryParam("error");
    if (providerError.length > 0) {
      return errorPage(
        providerError === "access_denied"
          ? `${providerLabel(provider)} sign-in was cancelled.`
          : `${providerLabel(provider)} said: ${providerError}.`,
      );
    }
    const oauth = yield* MemberOAuth;
    const result = yield* oauth.complete({
      provider,
      code: yield* queryParam("code"),
      state: yield* queryParam("state"),
      cookieState: yield* cookieState,
    });
    return yield* finish(result);
  },
  Effect.catchTags({ MemberOAuthError: oauthErrorPage }),
);

/** v2's own callback paths, plus v1's `/api/oauth/<provider>/callback` for apps registered then. */
const callbackRoutes = (provider: OAuthProviderId) => [
  HttpRouter.add("GET", `/lp/auth/${provider}/callback`, callbackHandler(provider)),
  ...(provider === "google"
    ? []
    : [HttpRouter.add("GET", `/api/oauth/${provider}/callback`, callbackHandler(provider))]),
];

/** The relay half of a cross-host Google sign-in (this host's callback is the registered one). */
const relayRoute = HttpRouter.add(
  "GET",
  RELAY_PATH,
  Effect.gen(function* () {
    const oauth = yield* MemberOAuth;
    const started = yield* oauth.beginRelay({
      outerState: yield* queryParam("state"),
      returnUrl: yield* queryParam("return"),
    });
    return redirect(started.url).pipe(withStateCookie(started.state, secureCookies(oauth)));
  }).pipe(Effect.catchTags({ MemberOAuthError: oauthErrorPage })),
);

/** The receiving half: a one-time, 60 s token names who signed in; the session starts here. */
const handoffRoute = HttpRouter.add(
  "GET",
  HANDOFF_PATH,
  Effect.gen(function* () {
    const oauth = yield* MemberOAuth;
    const result = yield* oauth.redeemHandoff({
      token: yield* queryParam("t"),
      cookieState: yield* cookieState,
    });
    return yield* finish(result);
  }).pipe(Effect.catchTags({ MemberOAuthError: oauthErrorPage })),
);

/** Development only: the mock provider's consent screen. 404 unless that provider is the mock. */
const mockAuthorizeRoute = (provider: OAuthProviderId) =>
  HttpRouter.add(
    "GET",
    mockAuthorizePath(provider),
    Effect.gen(function* () {
      const oauth = yield* MemberOAuth;
      const mock = oauth.mockClient(provider);
      if (mock === null) return HttpServerResponse.text("Not Found", { status: 404 });
      const state = yield* queryParam("state");
      const nonce = yield* queryParam("nonce");
      const redirectUri = yield* queryParam("redirect_uri");
      if (redirectUri !== oauth.settings.providers[provider].redirectUri) {
        return errorPage("redirect_uri does not match this host's callback.");
      }
      const email = yield* queryParam("email");
      if (email.length === 0) {
        return HttpServerResponse.html(
          mockConsentPageHtml({
            providerLabel: providerLabel(provider),
            hidden: { state, nonce, redirect_uri: redirectUri },
            askEmail: provider !== "cloudflare",
          }),
        ).pipe(HttpServerResponse.setHeaders(NO_STORE));
      }
      const code = mock.issueCode(
        mockIdentity(provider, {
          email,
          name: yield* queryParam("name"),
          verified: (yield* queryParam("verified")) === "1",
        }),
        provider === "google" ? nonce : null,
      );
      const back = new URL(redirectUri);
      back.searchParams.set("code", code);
      back.searchParams.set("state", state);
      // Same host on the mock, so a relative redirect keeps whichever origin the browser used.
      return redirect(`${back.pathname}${back.search}`);
    }),
  );

const connectionsRoute = HttpRouter.add(
  "GET",
  "/api/lp/connections",
  Effect.gen(function* () {
    const caller = yield* resolveCaller;
    if (caller.kind !== "member") return json({ error: "unauthenticated" }, 401);
    const oauth = yield* MemberOAuth;
    const access = yield* LogicPacksAccess;
    return json({
      connections: yield* oauth.connections(caller.userId),
      onboarding: access.onboardingChoice(caller.userId),
    });
  }),
);

const DisconnectRequest = Schema.Struct({ provider: Schema.String });

const disconnectRoute = HttpRouter.add(
  "POST",
  "/api/lp/connections/disconnect",
  Effect.gen(function* () {
    const caller = yield* resolveCaller;
    if (caller.kind !== "member") return json({ error: "unauthenticated" }, 401);
    const body = yield* readBody(DisconnectRequest);
    if (body === null || !isConnectionProvider(body.provider)) {
      return json({ error: "bad_request" }, 400);
    }
    const oauth = yield* MemberOAuth;
    yield* oauth.disconnect(caller.userId, body.provider);
    return json({ disconnected: true });
  }).pipe(
    Effect.catchTags({
      MemberOAuthError: (error) =>
        Effect.succeed(json({ error: error.reason, message: error.message }, 500)),
    }),
  ),
);

const OnboardingRequest = Schema.Struct({
  choice: Schema.String,
  /** From settings: change the answer without creating anything. */
  setupOnly: Schema.optionalKey(Schema.Boolean),
});

const STARTER_PROJECT = {
  kind: "template",
  name: "My first project",
  template: "website",
} as const;

/**
 * "How do you work?" on first run. A beginner gets a ready project on this host (no GitHub
 * needed), so the home page can open the first thread straight away.
 */
const onboardingRoute = HttpRouter.add(
  "POST",
  "/api/lp/onboarding",
  Effect.gen(function* () {
    const caller = yield* resolveCaller;
    if (caller.kind !== "member") return json({ error: "unauthenticated" }, 401);
    const body = yield* readBody(OnboardingRequest);
    if (body === null || !isOnboardingChoice(body.choice)) {
      return json({ error: "bad_request" }, 400);
    }
    const access = yield* LogicPacksAccess;
    yield* access.setOnboardingChoice(caller.userId, body.choice);
    if (
      body.choice !== "beginner" ||
      body.setupOnly === true ||
      access.visibleProjectIds(caller.userId).size > 0
    ) {
      return json({ choice: body.choice, projectId: null });
    }
    const projectsOff = yield* refuseIfProjectsOff(caller);
    if (projectsOff !== null) return projectsOff;
    const created = yield* createProject(STARTER_PROJECT, caller.userId);
    return created.kind === "created"
      ? json({ choice: body.choice, projectId: created.projectId }, 201)
      : json({ error: "invalid", message: created.message }, 400);
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed(
        json({ error: "onboarding_failed", message: String(error.message ?? error) }, 500),
      ),
    ),
  ),
);

/**
 * Deploys and custom domains on the member's Cloudflare. v1 had these calls but never ran
 * them against a live account, so v2 keeps the connection and answers here until they are.
 */
const cloudflareStub = (path: `/api/lp/${string}`) =>
  HttpRouter.add(
    "POST",
    path,
    Effect.gen(function* () {
      const caller = yield* resolveCaller;
      if (caller.kind !== "member") return json({ error: "unauthenticated" }, 401);
      return json(
        {
          error: "not_available",
          message:
            "Deploying to Cloudflare is not built yet. Your Cloudflare connection is saved for when it is.",
        },
        501,
      );
    }),
  );

const PROVIDERS: ReadonlyArray<OAuthProviderId> = ["google", "github", "cloudflare"];

export const layer = Layer.mergeAll(
  startRoute("google"),
  startRoute("github"),
  connectRoute("github"),
  connectRoute("cloudflare"),
  ...PROVIDERS.flatMap(callbackRoutes),
  ...PROVIDERS.map(mockAuthorizeRoute),
  relayRoute,
  handoffRoute,
  connectionsRoute,
  disconnectRoute,
  onboardingRoute,
  cloudflareStub("/api/lp/cloudflare/deploy"),
  cloudflareStub("/api/lp/cloudflare/domain"),
);
