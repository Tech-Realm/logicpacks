import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { HttpClient } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { LogicPacksAccess, type LogicPacksUser } from "./LogicPacksAccess.ts";
import { memberDirSegment } from "./memberLogin.ts";
import { ProjectShares } from "./ProjectShares.ts";
import { parseSignupMode, type SignupMode } from "./signup.ts";
import {
  cloudflareClient,
  githubClient,
  googleClient,
  HANDOFF_TTL_SECONDS,
  MockOAuthClient,
  type OAuthClient,
  type OAuthIdentity,
  type OAuthProviderId,
  identity as makeIdentity,
  pkceChallenge,
  providerLabel,
  randomToken,
  signHandoff,
  verifyHandoff,
} from "./oauthProviders.ts";

// ── Settings ──────────────────────────────────────────────────────────────

export type ProviderMode = "real" | "mock" | "relay" | "disabled";

export interface ProviderSettings {
  readonly mode: ProviderMode;
  readonly client: OAuthClient | null;
  readonly redirectUri: string;
  /** Why it is off, for the operator's log. */
  readonly note: string | null;
}

export interface MemberOAuthSettings {
  readonly publicBaseUrl: string;
  readonly providers: Readonly<Record<OAuthProviderId, ProviderSettings>>;
  /** Google sign-in runs on another host whose callback Google knows, then hands off here. */
  readonly googleHandoffFrom: string | null;
  readonly handoffSecret: string | null;
  /** Origins this host relays Google sign-ins for (the other half of the handoff). */
  readonly relayReturnOrigins: ReadonlyArray<string>;
  /** LOGICPACKS_SIGNUP: who a provider sign-in may create an account for. */
  readonly signup: SignupMode;
}

const DEFAULT_CLOUD_URL = "https://app.logicpacks.io";
const CALLBACK_PATH: Record<OAuthProviderId, string> = {
  google: "/lp/auth/google/callback",
  // v1's paths, so an OAuth app registered for v1 only needs its host changed.
  github: "/api/oauth/github/callback",
  cloudflare: "/api/oauth/cloudflare/callback",
};
export const mockAuthorizePath = (provider: OAuthProviderId) =>
  `/lp/auth/${provider}/mock/authorize` as const;
export const RELAY_PATH = "/lp/auth/google/relay" as const;
export const HANDOFF_PATH = "/lp/auth/google/handoff" as const;

const isLoopbackUrl = (raw: string) => {
  try {
    const host = new URL(raw).hostname.replace(/^\[|\]$/g, "");
    return host === "localhost" || host === "::1" || /^127\./.test(host);
  } catch {
    return false;
  }
};

const originOf = (raw: string) => {
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
};

/**
 * `<P>_PROVIDER=auto|<real>|mock|disabled`, as on 70mm: auto is the real provider when its
 * client id and secret are set, the mock on a loopback host, and off anywhere else. The
 * mock signs anyone in as any address, so it is refused on a public URL whatever was asked.
 */
export const settingsFromEnv = (
  env: Readonly<Record<string, string | undefined>>,
): MemberOAuthSettings => {
  const read = (...names: ReadonlyArray<string>) => {
    for (const name of names) {
      const value = env[name]?.trim();
      if (value) return value;
    }
    return null;
  };
  const publicBaseUrl = (read("LOGICPACKS_CLOUD_URL") ?? DEFAULT_CLOUD_URL).replace(/\/+$/, "");
  const handoffFrom = read("LOGICPACKS_GOOGLE_HANDOFF_FROM");
  const handoffSecret = read("LOGICPACKS_GOOGLE_HANDOFF_SECRET");

  const provider = (id: OAuthProviderId): ProviderSettings => {
    const upper = id.toUpperCase();
    const redirectUri =
      read(`LOGICPACKS_${upper}_REDIRECT_URI`) ?? `${publicBaseUrl}${CALLBACK_PATH[id]}`;
    const clientId = read(`LOGICPACKS_${upper}_CLIENT_ID`, `LOGICPACKS_${upper}_CLIENT_ID`);
    const clientSecret = read(
      `LOGICPACKS_${upper}_CLIENT_SECRET`,
      `LOGICPACKS_${upper}_CLIENT_SECRET`,
    );
    const asked = (read(`LOGICPACKS_${upper}_PROVIDER`) ?? "auto").toLowerCase();
    const off = (note: string): ProviderSettings => ({
      mode: "disabled",
      client: null,
      redirectUri,
      note,
    });
    const real = (): ProviderSettings => {
      if (clientId === null || clientSecret === null) {
        return off(`LOGICPACKS_${upper}_CLIENT_ID and _CLIENT_SECRET are not set.`);
      }
      const client =
        id === "google"
          ? googleClient(clientId, clientSecret)
          : id === "github"
            ? githubClient(clientId, clientSecret)
            : cloudflareClient(clientId, clientSecret);
      return { mode: "real", client, redirectUri, note: null };
    };
    const mock = (): ProviderSettings =>
      isLoopbackUrl(redirectUri)
        ? {
            mode: "mock",
            client: new MockOAuthClient(id, mockAuthorizePath(id)),
            redirectUri,
            note: null,
          }
        : off(`The mock ${providerLabel(id)} sign-in is refused on a public URL (${redirectUri}).`);

    if (asked === "disabled") return off(`LOGICPACKS_${upper}_PROVIDER=disabled.`);
    if (asked === "mock") return mock();
    if (id === "google" && handoffFrom !== null && asked !== id) {
      return handoffSecret === null
        ? off("LOGICPACKS_GOOGLE_HANDOFF_FROM needs LOGICPACKS_GOOGLE_HANDOFF_SECRET.")
        : { mode: "relay", client: null, redirectUri, note: null };
    }
    if (asked === id) return real();
    if (asked !== "auto") return off(`Unknown LOGICPACKS_${upper}_PROVIDER=${asked}.`);
    if (clientId !== null && clientSecret !== null) return real();
    return isLoopbackUrl(redirectUri)
      ? mock()
      : off(`No ${providerLabel(id)} OAuth client is configured.`);
  };

  return {
    publicBaseUrl,
    providers: {
      google: provider("google"),
      github: provider("github"),
      cloudflare: provider("cloudflare"),
    },
    googleHandoffFrom: handoffFrom,
    handoffSecret,
    relayReturnOrigins: (read("LOGICPACKS_GOOGLE_RELAY_RETURN_TO") ?? "")
      .split(",")
      .map((entry) => originOf(entry.trim()))
      .filter((entry): entry is string => entry !== null),
    signup: parseSignupMode(env["LOGICPACKS_SIGNUP"]),
  };
};

// ── Member connections (GitHub and Cloudflare tokens) ─────────────────────

export type ConnectionProvider = "github" | "cloudflare";
export const isConnectionProvider = (value: unknown): value is ConnectionProvider =>
  value === "github" || value === "cloudflare";

export const StoredConnection = Schema.Struct({
  accessToken: Schema.String,
  refreshToken: Schema.NullOr(Schema.String),
  /** Epoch milliseconds. */
  expiresAt: Schema.NullOr(Schema.Number),
  accountId: Schema.NullOr(Schema.String),
  accountLabel: Schema.NullOr(Schema.String),
  scope: Schema.NullOr(Schema.String),
  connectedAt: Schema.Number,
});
export type StoredConnection = typeof StoredConnection.Type;
const StoredConnectionJson = Schema.fromJsonString(StoredConnection);
const decodeStoredConnection = Schema.decodeUnknownEffect(StoredConnectionJson);
const encodeStoredConnection = Schema.encodeEffect(StoredConnectionJson);

/** One secret per member per provider, in the host's secret store (0600 files). */
export const connectionSecretName = (userId: string, provider: ConnectionProvider) =>
  `lp-member-${provider}-${memberDirSegment(userId)}`;

/** A member's own connection. Only ever looked up by that member's id. */
export const readMemberConnection = (
  secrets: ServerSecretStore.ServerSecretStore["Service"],
  userId: string,
  provider: ConnectionProvider,
) =>
  secrets.get(connectionSecretName(userId, provider)).pipe(
    Effect.flatMap((value) =>
      Option.isNone(value)
        ? Effect.succeed(null)
        : decodeStoredConnection(new TextDecoder().decode(value.value)),
    ),
    Effect.map((stored) => (stored !== null && stored.accessToken.length > 0 ? stored : null)),
    Effect.orElseSucceed((): StoredConnection | null => null),
  );

export interface ConnectionSummary {
  /** The host can connect it at all. */
  readonly available: boolean;
  readonly connected: boolean;
  readonly account: string | null;
}

// ── The service ───────────────────────────────────────────────────────────

export class MemberOAuthError extends Schema.TaggedError<MemberOAuthError>()("MemberOAuthError", {
  reason: Schema.Literals([
    "disabled",
    "state_mismatch",
    "provider_failed",
    "email_unverified",
    "signup_closed",
    "handoff_invalid",
    "not_signed_in",
    "relay_refused",
    "storage",
  ]),
  message: Schema.String,
}) {}

const fail = (reason: MemberOAuthError["reason"], message: string) =>
  Effect.fail(new MemberOAuthError({ reason, message }));

type Intent = "signin" | "connect" | "relay";

interface Pending {
  readonly provider: OAuthProviderId;
  readonly intent: Intent;
  readonly nonce: string;
  readonly codeVerifier: string;
  readonly invite: string | null;
  /** A project invite or share-link token (ProjectShares) the sign-in came from. */
  readonly projectInvite: string | null;
  readonly next: string | null;
  /** connect: whose account the token is for. */
  readonly userId: string | null;
  /** relay: where the handoff goes and the receiving host's state. */
  readonly relay: { readonly returnUrl: string; readonly outerState: string } | null;
  readonly createdAt: number;
}

const STATE_TTL_MS = 10 * 60 * 1000;

export type CompleteResult =
  | {
      readonly kind: "signed_in";
      readonly user: LogicPacksUser;
      readonly created: boolean;
      readonly next: string | null;
    }
  | {
      readonly kind: "connected";
      readonly provider: ConnectionProvider;
      readonly next: string | null;
    }
  | { readonly kind: "redirect"; readonly location: string };

/** Same-site paths only, so `next` can never send someone off the host. */
export const safeNextPath = (raw: string | null | undefined) =>
  typeof raw === "string" && raw.startsWith("/") && !raw.startsWith("//") && !raw.includes("\\")
    ? raw
    : null;

export class MemberOAuth extends Context.Service<
  MemberOAuth,
  {
    readonly settings: MemberOAuthSettings;
    readonly enabled: (provider: OAuthProviderId) => boolean;
    /** The mock client when that provider runs on the mock, for the dev consent page. */
    readonly mockClient: (provider: OAuthProviderId) => MockOAuthClient | null;
    /** Starts a sign-in or a connection; the caller sets `state` as a cookie and redirects. */
    readonly begin: (input: {
      readonly provider: OAuthProviderId;
      readonly intent: "signin" | "connect";
      readonly invite?: string | null | undefined;
      readonly project?: string | null | undefined;
      readonly next?: string | null | undefined;
      readonly userId?: string | null | undefined;
    }) => Effect.Effect<{ readonly state: string; readonly url: string }, MemberOAuthError>;
    /** This host as the relay: run Google here, then hand the identity to `returnUrl`. */
    readonly beginRelay: (input: {
      readonly outerState: string;
      readonly returnUrl: string;
    }) => Effect.Effect<{ readonly state: string; readonly url: string }, MemberOAuthError>;
    readonly complete: (input: {
      readonly provider: OAuthProviderId;
      readonly code: string;
      readonly state: string;
      readonly cookieState: string | null;
    }) => Effect.Effect<CompleteResult, MemberOAuthError, HttpClient.HttpClient>;
    readonly redeemHandoff: (input: {
      readonly token: string;
      readonly cookieState: string | null;
    }) => Effect.Effect<CompleteResult, MemberOAuthError>;
    readonly connections: (
      userId: string,
    ) => Effect.Effect<Readonly<Record<ConnectionProvider, ConnectionSummary>>>;
    /** The member's own token for `provider`, or null. Never another member's. */
    readonly connectionToken: (
      userId: string,
      provider: ConnectionProvider,
    ) => Effect.Effect<string | null>;
    readonly disconnect: (
      userId: string,
      provider: ConnectionProvider,
    ) => Effect.Effect<void, MemberOAuthError>;
  }
>()("logicpacks/logicpacks/MemberOAuth") {}

export const make = Effect.fn("MemberOAuth.make")(function* (settings: MemberOAuthSettings) {
  const access = yield* LogicPacksAccess;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const pending = new Map<string, Pending>();
  const usedHandoffs = new Map<string, number>();

  for (const [id, provider] of Object.entries(settings.providers)) {
    if (provider.mode === "disabled") {
      yield* Effect.logInfo("LogicPacks OAuth provider off", { provider: id, why: provider.note });
    } else if (provider.mode === "mock") {
      yield* Effect.logWarning("LogicPacks OAuth provider is the development mock", {
        provider: id,
      });
    }
  }

  const enabled = (provider: OAuthProviderId) => settings.providers[provider].mode !== "disabled";

  const remember = Effect.fn("MemberOAuth.remember")(function* (
    entry: Omit<Pending, "createdAt" | "nonce" | "codeVerifier">,
  ) {
    const at = yield* Clock.currentTimeMillis;
    for (const [key, value] of pending) {
      if (at - value.createdAt > STATE_TTL_MS) pending.delete(key);
    }
    const state = randomToken(24);
    const record: Pending = {
      ...entry,
      nonce: randomToken(16),
      codeVerifier: randomToken(32),
      createdAt: at,
    };
    pending.set(state, record);
    return { state, record };
  });

  const authorizeUrl = (provider: OAuthProviderId, state: string, record: Pending) => {
    const config = settings.providers[provider];
    return config.client!.authorizationUrl({
      state,
      nonce: record.nonce,
      codeChallenge: pkceChallenge(record.codeVerifier),
      redirectUri: config.redirectUri,
    });
  };

  const begin = Effect.fn("MemberOAuth.begin")(function* (input: {
    readonly provider: OAuthProviderId;
    readonly intent: "signin" | "connect";
    readonly invite?: string | null | undefined;
    readonly project?: string | null | undefined;
    readonly next?: string | null | undefined;
    readonly userId?: string | null | undefined;
  }) {
    const config = settings.providers[input.provider];
    if (config.mode === "disabled") {
      return yield* fail(
        "disabled",
        `${providerLabel(input.provider)} is not available on this host.`,
      );
    }
    if (input.intent === "signin" && input.provider === "cloudflare") {
      return yield* fail("disabled", "Cloudflare is a connection, not a way to sign in.");
    }
    if (input.intent === "connect" && (input.provider === "google" || !input.userId)) {
      return yield* fail("not_signed_in", "Sign in first, then connect it.");
    }
    const { state, record } = yield* remember({
      provider: input.provider,
      intent: input.intent,
      invite: input.invite?.trim() || null,
      projectInvite: input.project?.trim() || null,
      // Back to the project invite, where a signed-in member joins on the spot.
      next: input.project?.trim()
        ? `/lp/join/project?invite=${encodeURIComponent(input.project.trim())}`
        : safeNextPath(input.next),
      userId: input.intent === "connect" ? (input.userId ?? null) : null,
      relay: null,
    });
    if (config.mode === "relay") {
      const relay = new URL(settings.googleHandoffFrom!);
      if (relay.pathname === "/" || relay.pathname === "") relay.pathname = RELAY_PATH;
      relay.searchParams.set("state", state);
      relay.searchParams.set("return", `${settings.publicBaseUrl}${HANDOFF_PATH}`);
      return { state, url: relay.toString() };
    }
    return { state, url: authorizeUrl(input.provider, state, record) };
  });

  const beginRelay = Effect.fn("MemberOAuth.beginRelay")(function* (input: {
    readonly outerState: string;
    readonly returnUrl: string;
  }) {
    const config = settings.providers.google;
    const origin = originOf(input.returnUrl);
    if (
      settings.handoffSecret === null ||
      config.client === null ||
      origin === null ||
      !settings.relayReturnOrigins.includes(origin) ||
      input.outerState.length === 0
    ) {
      return yield* fail("relay_refused", "This host does not relay sign-ins for that address.");
    }
    const { state, record } = yield* remember({
      provider: "google",
      intent: "relay",
      invite: null,
      projectInvite: null,
      next: null,
      userId: null,
      relay: { returnUrl: input.returnUrl, outerState: input.outerState },
    });
    return { state, url: authorizeUrl("google", state, record) };
  });

  const saveConnection = Effect.fn("MemberOAuth.saveConnection")(function* (
    userId: string,
    provider: ConnectionProvider,
    who: OAuthIdentity,
  ) {
    if (who.accessToken === null) return;
    const at = yield* Clock.currentTimeMillis;
    const stored: StoredConnection = {
      accessToken: who.accessToken,
      refreshToken: who.refreshToken,
      expiresAt: who.expiresIn === null ? null : at + who.expiresIn * 1000,
      accountId: who.accountId,
      accountLabel: who.accountLabel,
      scope: who.scope,
      connectedAt: at,
    };
    yield* encodeStoredConnection(stored).pipe(
      Effect.flatMap((text) =>
        secrets.set(connectionSecretName(userId, provider), new TextEncoder().encode(text)),
      ),
      Effect.mapError(
        () =>
          new MemberOAuthError({
            reason: "storage",
            message: `Could not save the ${providerLabel(provider)} connection.`,
          }),
      ),
    );
  });

  /**
   * LOGICPACKS_SIGNUP for a provider sign-in, the same rule as the password form: `invite`
   * creates an account only through a live workspace invite or project invite/share link
   * (whose domain rule the email must meet); `closed` never does. Existing members always link.
   */
  const mayCreateAccount = Effect.fn("MemberOAuth.mayCreateAccount")(function* (
    record: Pending,
    email: string | null,
  ) {
    if (settings.signup === "open") return true;
    if (settings.signup === "closed") return false;
    if (record.invite !== null && access.workspaceForInvite(record.invite) !== null) return true;
    if (record.projectInvite === null || email === null) return false;
    const shares = yield* Effect.serviceOption(ProjectShares);
    if (shares._tag === "None") return false;
    const target = yield* shares.value
      .resolveToken(record.projectInvite)
      .pipe(Effect.orElseSucceed(() => ({ kind: "closed" }) as const));
    if (target.kind === "closed") return false;
    return yield* shares.value.checkEmailForToken(record.projectInvite, email).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
  });

  const signIn = Effect.fn("MemberOAuth.signIn")(function* (
    provider: OAuthProviderId,
    who: OAuthIdentity,
    record: Pending,
  ) {
    const result = yield* access
      .signInWithIdentity({
        provider,
        subject: who.subject,
        email: who.email,
        emailVerified: who.emailVerified,
        displayName: who.name,
        allowSignup: yield* mayCreateAccount(record, who.email),
      })
      .pipe(
        Effect.mapError(
          (error) =>
            new MemberOAuthError({
              reason:
                error.reason === "email_unverified" || error.reason === "signup_closed"
                  ? error.reason
                  : "storage",
              message:
                error.reason !== "signup_closed"
                  ? error.message
                  : settings.signup === "closed"
                    ? "This host is not taking new accounts."
                    : "This host is invite only. Open the invite link you were sent to create an account.",
            }),
        ),
      );
    // Signing in with GitHub is also connecting it: one consent, the member's own token.
    if (provider === "github") yield* saveConnection(result.user.userId, "github", who);
    if (record.invite !== null && access.workspaceForInvite(record.invite) !== null) {
      yield* access
        .joinWithInvite({ token: record.invite, userId: result.user.userId })
        .pipe(
          Effect.mapError(
            () =>
              new MemberOAuthError({ reason: "storage", message: "Could not join the workspace." }),
          ),
        );
    }
    return {
      kind: "signed_in",
      user: result.user,
      created: result.created,
      next: record.next,
    } satisfies CompleteResult;
  });

  const take = (state: string, cookieState: string | null) => {
    const record = pending.get(state);
    // The cookie ties the callback to the browser that started it (login CSRF).
    if (record === undefined || cookieState === null || cookieState !== state) return null;
    pending.delete(state);
    return record;
  };

  const stateMismatch = () =>
    fail(
      "state_mismatch",
      "This sign-in link does not match this browser, or it expired. Start again.",
    );

  const complete = Effect.fn("MemberOAuth.complete")(function* (input: {
    readonly provider: OAuthProviderId;
    readonly code: string;
    readonly state: string;
    readonly cookieState: string | null;
  }) {
    const config = settings.providers[input.provider];
    if (config.client === null) {
      return yield* fail(
        "disabled",
        `${providerLabel(input.provider)} is not available on this host.`,
      );
    }
    const record = take(input.state, input.cookieState);
    if (record === null || record.provider !== input.provider) return yield* stateMismatch();
    if ((yield* Clock.currentTimeMillis) - record.createdAt > STATE_TTL_MS) {
      return yield* stateMismatch();
    }
    const who = yield* config.client
      .exchange({
        code: input.code,
        codeVerifier: record.codeVerifier,
        nonce: record.nonce,
        redirectUri: config.redirectUri,
      })
      .pipe(
        Effect.mapError(
          (error) => new MemberOAuthError({ reason: "provider_failed", message: error.message }),
        ),
      );

    if (record.intent === "relay") {
      if (who.email === null || !who.emailVerified) {
        return yield* fail(
          "email_unverified",
          "That Google account has no verified email address.",
        );
      }
      const nowSeconds = Math.floor((yield* Clock.currentTimeMillis) / 1000);
      const token = signHandoff(settings.handoffSecret!, {
        v: 1,
        sub: who.subject,
        email: who.email,
        emailVerified: true,
        name: who.name,
        state: record.relay!.outerState,
        jti: randomToken(16),
        exp: nowSeconds + HANDOFF_TTL_SECONDS,
      });
      const location = new URL(record.relay!.returnUrl);
      location.searchParams.set("t", token);
      return { kind: "redirect", location: location.toString() } satisfies CompleteResult;
    }
    if (record.intent === "connect") {
      const provider = input.provider as ConnectionProvider;
      yield* saveConnection(record.userId!, provider, who);
      return { kind: "connected", provider, next: record.next } satisfies CompleteResult;
    }
    return yield* signIn(input.provider, who, record);
  });

  const redeemHandoff = Effect.fn("MemberOAuth.redeemHandoff")(function* (input: {
    readonly token: string;
    readonly cookieState: string | null;
  }) {
    if (settings.providers.google.mode !== "relay" || settings.handoffSecret === null) {
      return yield* fail("disabled", "Google is not available on this host.");
    }
    const nowMillis = yield* Clock.currentTimeMillis;
    const checked = verifyHandoff(
      settings.handoffSecret,
      input.token,
      Math.floor(nowMillis / 1000),
    );
    if (!checked.ok) {
      return yield* fail(
        "handoff_invalid",
        checked.reason === "expired"
          ? "That sign-in link expired. Sign in again."
          : "That sign-in link is not valid. Sign in again.",
      );
    }
    for (const [jti, at] of usedHandoffs) {
      if (nowMillis - at > HANDOFF_TTL_SECONDS * 2000) usedHandoffs.delete(jti);
    }
    if (usedHandoffs.has(checked.claims.jti)) {
      return yield* fail("handoff_invalid", "That sign-in link was already used. Sign in again.");
    }
    usedHandoffs.set(checked.claims.jti, nowMillis);
    const record = take(checked.claims.state, input.cookieState);
    if (record === null || record.provider !== "google" || record.intent !== "signin") {
      return yield* stateMismatch();
    }
    return yield* signIn(
      "google",
      makeIdentity({
        subject: checked.claims.sub,
        email: checked.claims.email,
        emailVerified: checked.claims.emailVerified,
        name: checked.claims.name,
      }),
      record,
    );
  });

  const summary = Effect.fn("MemberOAuth.summary")(function* (
    userId: string,
    provider: ConnectionProvider,
  ) {
    const stored = yield* readMemberConnection(secrets, userId, provider);
    return {
      available: enabled(provider),
      connected: stored !== null,
      account: stored?.accountLabel ?? null,
    } satisfies ConnectionSummary;
  });

  return MemberOAuth.of({
    settings,
    enabled,
    mockClient: (provider) => {
      const client = settings.providers[provider].client;
      return client instanceof MockOAuthClient ? client : null;
    },
    begin,
    beginRelay,
    complete,
    redeemHandoff,
    connections: Effect.fn("MemberOAuth.connections")(function* (userId) {
      return {
        github: yield* summary(userId, "github"),
        cloudflare: yield* summary(userId, "cloudflare"),
      };
    }),
    connectionToken: Effect.fn("MemberOAuth.connectionToken")(function* (userId, provider) {
      const stored = yield* readMemberConnection(secrets, userId, provider);
      return stored?.accessToken ?? null;
    }),
    disconnect: Effect.fn("MemberOAuth.disconnect")(function* (userId, provider) {
      yield* secrets.remove(connectionSecretName(userId, provider)).pipe(
        Effect.mapError(
          () =>
            new MemberOAuthError({
              reason: "storage",
              message: `Could not remove the ${providerLabel(provider)} connection.`,
            }),
        ),
      );
    }),
  });
});

const ENV_NAMES = [
  "LOGICPACKS_CLOUD_URL",
  "LOGICPACKS_SIGNUP",
  "LOGICPACKS_GOOGLE_HANDOFF_FROM",
  "LOGICPACKS_GOOGLE_HANDOFF_SECRET",
  "LOGICPACKS_GOOGLE_RELAY_RETURN_TO",
  ...(["GOOGLE", "GITHUB", "CLOUDFLARE"] as const).flatMap((upper) => [
    `LOGICPACKS_${upper}_PROVIDER`,
    `LOGICPACKS_${upper}_CLIENT_ID`,
    `LOGICPACKS_${upper}_CLIENT_SECRET`,
    `LOGICPACKS_${upper}_REDIRECT_URI`,
    `LOGICPACKS_${upper}_CLIENT_ID`,
    `LOGICPACKS_${upper}_CLIENT_SECRET`,
  ]),
];

const settingsFromConfig = Effect.gen(function* () {
  const env: Record<string, string | undefined> = {};
  for (const name of ENV_NAMES) {
    env[name] = yield* Config.String(name).pipe(
      Config.withDefault(""),
      Effect.orElseSucceed(() => ""),
    );
  }
  return settingsFromEnv(env);
});

export const layer = Layer.effect(MemberOAuth, settingsFromConfig.pipe(Effect.flatMap(make))).pipe(
  Layer.provide(ServerSecretStore.layer),
);
