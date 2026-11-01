// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no HMAC or timingSafeEqual.
import * as NodeCrypto from "node:crypto";

import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";

/**
 * Sign in with Google or GitHub, and connect GitHub or Cloudflare, for LogicPacks members.
 * The clients here only talk to the providers; MemberOAuth.ts owns state, linking and tokens.
 * Ported from 70mm (p300-comfybox platform/core/auth/providers.py) and LogicPacks v1
 * (integrations/Layers/ExternalIntegrations.ts).
 */

export type OAuthProviderId = "google" | "github" | "cloudflare";

export const isOAuthProvider = (value: unknown): value is OAuthProviderId =>
  value === "google" || value === "github" || value === "cloudflare";

export const providerLabel = (provider: OAuthProviderId) =>
  provider === "google" ? "Google" : provider === "github" ? "GitHub" : "Cloudflare";

export class OAuthError extends Schema.TaggedError<OAuthError>()("OAuthError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

/** Who the provider says signed in, plus the token when the provider is also a connection. */
export interface OAuthIdentity {
  readonly subject: string;
  readonly email: string | null;
  readonly emailVerified: boolean;
  readonly name: string | null;
  readonly accessToken: string | null;
  readonly refreshToken: string | null;
  /** Seconds, as the token endpoint said. */
  readonly expiresIn: number | null;
  readonly scope: string | null;
  /** The account the connection acts as: a GitHub login, a Cloudflare account name. */
  readonly accountLabel: string | null;
  readonly accountId: string | null;
}

export const identity = (
  input: Partial<OAuthIdentity> & { readonly subject: string },
): OAuthIdentity => ({
  email: null,
  emailVerified: false,
  name: null,
  accessToken: null,
  refreshToken: null,
  expiresIn: null,
  scope: null,
  accountLabel: null,
  accountId: null,
  ...input,
});

export interface AuthorizeInput {
  readonly state: string;
  readonly nonce: string;
  readonly codeChallenge: string;
  readonly redirectUri: string;
}

export interface ExchangeInput {
  readonly code: string;
  readonly codeVerifier: string;
  readonly nonce: string;
  readonly redirectUri: string;
}

export interface OAuthClient {
  readonly kind: "real" | "mock";
  readonly authorizationUrl: (input: AuthorizeInput) => string;
  readonly exchange: (
    input: ExchangeInput,
  ) => Effect.Effect<OAuthIdentity, OAuthError, HttpClient.HttpClient>;
}

// ── Small crypto helpers ──────────────────────────────────────────────────

export const randomToken = (bytes = 24) => NodeCrypto.randomBytes(bytes).toString("base64url");

/** PKCE S256 (RFC 7636). */
export const pkceChallenge = (verifier: string) =>
  NodeCrypto.createHash("sha256").update(verifier).digest("base64url");

export const safeEqual = (left: string, right: string) => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && NodeCrypto.timingSafeEqual(a, b);
};

// ── Cross-host handoff ────────────────────────────────────────────────────

/**
 * What a relay host (one whose callback Google knows) hands back after it verified a
 * Google sign-in: the verified identity and the receiving host's own state, valid 60 s and
 * once. It names the person; it never carries a session. Both hosts share the HMAC secret.
 */
export interface HandoffClaims {
  readonly v: 1;
  readonly sub: string;
  readonly email: string;
  readonly emailVerified: boolean;
  readonly name: string | null;
  /** The receiving host's state, so the token only completes the login that asked for it. */
  readonly state: string;
  readonly jti: string;
  /** Epoch seconds. */
  readonly exp: number;
}

export const HANDOFF_TTL_SECONDS = 60;

const hmac = (secret: string, body: string) =>
  NodeCrypto.createHmac("sha256", secret).update(body).digest("base64url");

export const signHandoff = (secret: string, claims: HandoffClaims) => {
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${body}.${hmac(secret, body)}`;
};

export type HandoffCheck =
  | { readonly ok: true; readonly claims: HandoffClaims }
  | { readonly ok: false; readonly reason: "malformed" | "signature" | "expired" };

export const verifyHandoff = (secret: string, token: string, nowSeconds: number): HandoffCheck => {
  const [body, signature, extra] = token.split(".");
  if (!body || !signature || extra !== undefined) return { ok: false, reason: "malformed" };
  if (!safeEqual(hmac(secret, body), signature)) return { ok: false, reason: "signature" };
  let claims: HandoffClaims;
  try {
    claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as HandoffClaims;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (
    claims.v !== 1 ||
    typeof claims.sub !== "string" ||
    typeof claims.email !== "string" ||
    typeof claims.state !== "string" ||
    typeof claims.jti !== "string" ||
    typeof claims.exp !== "number"
  ) {
    return { ok: false, reason: "malformed" };
  }
  if (claims.exp < nowSeconds) return { ok: false, reason: "expired" };
  return { ok: true, claims };
};

// ── Google (OpenID Connect) ───────────────────────────────────────────────

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);

export interface IdTokenClaims {
  readonly iss?: unknown;
  readonly aud?: unknown;
  readonly exp?: unknown;
  readonly nonce?: unknown;
  readonly sub?: unknown;
  readonly email?: unknown;
  readonly email_verified?: unknown;
  readonly name?: unknown;
}

export const decodeJwtPayload = (jwt: string): IdTokenClaims | null => {
  const part = jwt.split(".")[1];
  if (!part) return null;
  try {
    const parsed = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as unknown;
    return parsed !== null && typeof parsed === "object" ? (parsed as IdTokenClaims) : null;
  } catch {
    return null;
  }
};

/**
 * Checks an ID token that came straight from Google's token endpoint over TLS. OIDC Core
 * 3.1.3.7 lets a client that got it that way skip the signature; issuer, audience, expiry
 * and nonce are still checked here.
 */
export const checkGoogleIdToken = (
  claims: IdTokenClaims | null,
  expected: { readonly clientId: string; readonly nonce: string; readonly nowSeconds: number },
):
  | { readonly ok: true; readonly identity: OAuthIdentity }
  | { readonly ok: false; readonly message: string } => {
  if (claims === null) return { ok: false, message: "Google sent an unreadable ID token." };
  if (typeof claims.iss !== "string" || !GOOGLE_ISSUERS.has(claims.iss)) {
    return { ok: false, message: "The ID token was not issued by Google." };
  }
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audience.includes(expected.clientId)) {
    return { ok: false, message: "The ID token is for another application." };
  }
  if (typeof claims.exp !== "number" || claims.exp < expected.nowSeconds) {
    return { ok: false, message: "The ID token has expired." };
  }
  if (typeof claims.nonce !== "string" || !safeEqual(claims.nonce, expected.nonce)) {
    return { ok: false, message: "The ID token does not match this sign-in." };
  }
  if (typeof claims.sub !== "string" || claims.sub.length === 0) {
    return { ok: false, message: "The ID token names no account." };
  }
  return {
    ok: true,
    identity: identity({
      subject: claims.sub,
      email: typeof claims.email === "string" ? claims.email.toLowerCase() : null,
      // Google sends a boolean; some older tokens carry the string "true".
      emailVerified: claims.email_verified === true || claims.email_verified === "true",
      name: typeof claims.name === "string" ? claims.name : null,
    }),
  };
};

const readJson = <E>(response: { readonly json: Effect.Effect<unknown, E> }) =>
  response.json.pipe(
    Effect.map((value) =>
      value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {},
    ),
    Effect.orElseSucceed((): Record<string, unknown> => ({})),
  );

const stringOf = (value: unknown) => (typeof value === "string" && value.length > 0 ? value : null);

const transport = (what: string) => (cause: unknown) =>
  new OAuthError({ message: `${what} could not be reached.`, cause });

export const googleClient = (clientId: string, clientSecret: string): OAuthClient => ({
  kind: "real",
  authorizationUrl: ({ state, nonce, codeChallenge, redirectUri }) => {
    const url = new URL(GOOGLE_AUTH_URL);
    url.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "openid email profile",
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      access_type: "online",
      prompt: "select_account",
    }).toString();
    return url.toString();
  },
  exchange: Effect.fn("MemberOAuth.google.exchange")(function* ({
    code,
    codeVerifier,
    nonce,
    redirectUri,
  }) {
    const http = yield* HttpClient.HttpClient;
    const response = yield* HttpClientRequest.post(GOOGLE_TOKEN_URL).pipe(
      HttpClientRequest.bodyUrlParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
        code_verifier: codeVerifier,
      }),
      http.execute,
      Effect.mapError(transport("Google")),
    );
    const body = yield* readJson(response);
    const idToken = stringOf(body["id_token"]);
    if (response.status !== 200 || idToken === null) {
      return yield* new OAuthError({
        message: `Google did not accept the sign-in (${stringOf(body["error"]) ?? response.status}).`,
      });
    }
    const checked = checkGoogleIdToken(decodeJwtPayload(idToken), {
      clientId,
      nonce,
      nowSeconds: Math.floor((yield* Clock.currentTimeMillis) / 1000),
    });
    if (!checked.ok) return yield* new OAuthError({ message: checked.message });
    return checked.identity;
  }),
});

// ── GitHub (OAuth App) ────────────────────────────────────────────────────

const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_API = "https://api.github.com";
/** repo to create and push as the member; user:email to read a verified address. */
export const GITHUB_SCOPE = "repo read:user user:email";

export interface GitHubEmail {
  readonly email: string;
  readonly primary: boolean;
  readonly verified: boolean;
}

/** The primary address when GitHub verified it, else any verified one. */
export const pickGitHubEmail = (
  emails: ReadonlyArray<GitHubEmail>,
): { readonly email: string | null; readonly verified: boolean } => {
  const verified = emails.filter((entry) => entry.verified);
  const chosen = verified.find((entry) => entry.primary) ?? verified[0];
  if (chosen) return { email: chosen.email.toLowerCase(), verified: true };
  const primary = emails.find((entry) => entry.primary);
  return { email: primary ? primary.email.toLowerCase() : null, verified: false };
};

const githubHeaders = (token: string) => ({
  authorization: `Bearer ${token}`,
  accept: "application/vnd.github+json",
  "user-agent": "LogicPacks",
});

const githubGet = Effect.fn("MemberOAuth.githubGet")(function* (token: string, path: string) {
  const http = yield* HttpClient.HttpClient;
  return yield* HttpClientRequest.get(`${GITHUB_API}${path}`).pipe(
    HttpClientRequest.setHeaders(githubHeaders(token)),
    http.execute,
    Effect.mapError(transport("GitHub")),
  );
});

export const githubClient = (clientId: string, clientSecret: string): OAuthClient => ({
  kind: "real",
  authorizationUrl: ({ state, redirectUri }) => {
    const url = new URL(GITHUB_AUTHORIZE_URL);
    url.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: GITHUB_SCOPE,
      state,
      allow_signup: "true",
    }).toString();
    return url.toString();
  },
  exchange: Effect.fn("MemberOAuth.github.exchange")(function* ({ code, redirectUri }) {
    const http = yield* HttpClient.HttpClient;
    const response = yield* HttpClientRequest.post(GITHUB_TOKEN_URL).pipe(
      HttpClientRequest.setHeader("accept", "application/json"),
      HttpClientRequest.bodyUrlParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri,
      }),
      http.execute,
      Effect.mapError(transport("GitHub")),
    );
    const body = yield* readJson(response);
    const token = stringOf(body["access_token"]);
    if (response.status !== 200 || token === null) {
      const why = stringOf(body["error_description"]) ?? stringOf(body["error"]) ?? response.status;
      return yield* new OAuthError({ message: `GitHub did not accept the sign-in (${why}).` });
    }
    const user = yield* readJson(yield* githubGet(token, "/user"));
    const id = user["id"];
    if (typeof id !== "number" && typeof id !== "string") {
      return yield* new OAuthError({ message: "GitHub did not say who signed in." });
    }
    const emailsResponse = yield* githubGet(token, "/user/emails");
    const emails: unknown =
      emailsResponse.status === 200
        ? yield* emailsResponse.json.pipe(Effect.orElseSucceed(() => []))
        : [];
    const picked = pickGitHubEmail(Array.isArray(emails) ? (emails as Array<GitHubEmail>) : []);
    return identity({
      subject: String(id),
      email: picked.email,
      emailVerified: picked.verified,
      name: stringOf(user["name"]) ?? stringOf(user["login"]),
      accessToken: token,
      scope: stringOf(body["scope"]),
      accountLabel: stringOf(user["login"]),
      accountId: String(id),
    });
  }),
});

/** A private repository under the member's own account, made with their token. */
export const githubCreateRepository = Effect.fn("MemberOAuth.githubCreateRepository")(function* (
  token: string,
  name: string,
) {
  const http = yield* HttpClient.HttpClient;
  const response = yield* HttpClientRequest.post(`${GITHUB_API}/user/repos`).pipe(
    HttpClientRequest.setHeaders(githubHeaders(token)),
    HttpClientRequest.bodyJsonUnsafe({ name, private: true, auto_init: false }),
    http.execute,
    Effect.mapError(transport("GitHub")),
  );
  const body = yield* readJson(response);
  const cloneUrl = stringOf(body["clone_url"]);
  if (response.status === 201 && cloneUrl !== null) return { kind: "created", cloneUrl } as const;
  if (response.status === 422) return { kind: "exists" } as const;
  return yield* new OAuthError({
    message: `GitHub did not create the repository (${stringOf(body["message"]) ?? response.status}).`,
  });
});

/**
 * Git environment that authenticates HTTPS requests to github.com with a member's token,
 * passed through GIT_CONFIG_* so it never shows in argv or lands in .git/config.
 */
export const githubTokenGitEnv = (token: string): Record<string, string> => ({
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
  GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
  // The host's own credential helper must not answer for a member.
  GIT_CONFIG_KEY_1: "credential.https://github.com.helper",
  GIT_CONFIG_VALUE_1: "",
  GIT_TERMINAL_PROMPT: "0",
});

// ── Cloudflare (self-managed OAuth client) ────────────────────────────────

const CLOUDFLARE_AUTHORIZE_URL = "https://dash.cloudflare.com/oauth2/auth";
const CLOUDFLARE_TOKEN_URL = "https://dash.cloudflare.com/oauth2/token";
const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";

export const cloudflareClient = (clientId: string, clientSecret: string): OAuthClient => ({
  kind: "real",
  authorizationUrl: ({ state, codeChallenge, redirectUri }) => {
    const url = new URL(CLOUDFLARE_AUTHORIZE_URL);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    }).toString();
    return url.toString();
  },
  exchange: Effect.fn("MemberOAuth.cloudflare.exchange")(function* ({
    code,
    codeVerifier,
    redirectUri,
  }) {
    const http = yield* HttpClient.HttpClient;
    const response = yield* HttpClientRequest.post(CLOUDFLARE_TOKEN_URL).pipe(
      HttpClientRequest.setHeader(
        "authorization",
        `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      ),
      HttpClientRequest.bodyUrlParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
      }),
      http.execute,
      Effect.mapError(transport("Cloudflare")),
    );
    const body = yield* readJson(response);
    const token = stringOf(body["access_token"]);
    if (response.status !== 200 || token === null) {
      const why = stringOf(body["error_description"]) ?? stringOf(body["error"]) ?? response.status;
      return yield* new OAuthError({
        message: `Cloudflare did not accept the connection (${why}).`,
      });
    }
    const accounts = yield* HttpClientRequest.get(`${CLOUDFLARE_API}/accounts`).pipe(
      HttpClientRequest.setHeader("authorization", `Bearer ${token}`),
      http.execute,
      Effect.flatMap(readJson),
      Effect.orElseSucceed((): Record<string, unknown> => ({})),
    );
    const list = accounts["result"];
    const first = Array.isArray(list)
      ? (list[0] as { readonly id?: unknown; readonly name?: unknown } | undefined)
      : undefined;
    const accountId = stringOf(first?.id);
    return identity({
      subject: accountId ?? "cloudflare",
      accessToken: token,
      refreshToken: stringOf(body["refresh_token"]),
      expiresIn: typeof body["expires_in"] === "number" ? body["expires_in"] : null,
      scope: stringOf(body["scope"]),
      accountLabel: stringOf(first?.name),
      accountId,
    });
  }),
});

// ── Mock (tests and local development) ────────────────────────────────────

/**
 * A stand-in for the provider: the dev consent page (or a test) calls `issueCode` with the
 * identity it wants, and the callback exchanges that code. Never enabled on a public host.
 */
export class MockOAuthClient implements OAuthClient {
  readonly kind = "mock" as const;
  readonly provider: OAuthProviderId;
  private readonly authorizePath: string;
  private readonly codes = new Map<
    string,
    { readonly identity: OAuthIdentity; readonly nonce: string | null }
  >();

  constructor(provider: OAuthProviderId, authorizePath: string) {
    this.provider = provider;
    this.authorizePath = authorizePath;
  }

  authorizationUrl({ state, nonce, redirectUri }: AuthorizeInput) {
    return `${this.authorizePath}?${new URLSearchParams({ state, nonce, redirect_uri: redirectUri })}`;
  }

  /** A one-time code for `who`; with a nonce, the code only completes that sign-in. */
  issueCode(who: OAuthIdentity, nonce: string | null = null) {
    const code = `mock-${randomToken(12)}`;
    this.codes.set(code, { identity: who, nonce });
    return code;
  }

  exchange({ code, nonce }: ExchangeInput) {
    const entry = this.codes.get(code);
    this.codes.delete(code);
    if (entry === undefined) {
      return Effect.fail(new OAuthError({ message: "Unknown or already used code." }));
    }
    if (entry.nonce !== null && entry.nonce !== nonce) {
      return Effect.fail(new OAuthError({ message: "The ID token does not match this sign-in." }));
    }
    return Effect.succeed(entry.identity);
  }
}

/** A mock identity from what the dev consent page collected. */
export const mockIdentity = (
  provider: OAuthProviderId,
  input: { readonly email: string; readonly name?: string | undefined; readonly verified: boolean },
) => {
  const email = input.email.trim().toLowerCase();
  const login = email.split("@")[0] ?? email;
  return identity({
    subject: `mock-${provider}-${email}`,
    email: provider === "cloudflare" ? null : email,
    emailVerified: input.verified,
    name: input.name?.trim() || null,
    accessToken: provider === "google" ? null : `mock-${provider}-token-${randomToken(8)}`,
    scope: provider === "github" ? GITHUB_SCOPE : null,
    accountLabel:
      provider === "google" ? null : provider === "github" ? login : `${login}'s account`,
    accountId: provider === "google" ? null : `mock-${login}`,
  });
};
