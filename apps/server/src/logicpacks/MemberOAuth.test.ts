import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { FetchHttpClient } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as LogicPacksAccess from "./LogicPacksAccess.ts";
import { make, type MemberOAuth, settingsFromEnv } from "./MemberOAuth.ts";
import { ProjectShares, layer as sharesLayer } from "./ProjectShares.ts";
import { claimShareInvites } from "./shareClaim.ts";
import { layerRecording, type OutgoingMail } from "./shareMail.ts";
import {
  checkGoogleIdToken,
  githubTokenGitEnv,
  identity,
  MockOAuthClient,
  type OAuthIdentity,
  type OAuthProviderId,
  pickGitHubEmail,
  signHandoff,
  verifyHandoff,
} from "./oauthProviders.ts";

const sentMail: Array<OutgoingMail> = [];
const layerTest = sharesLayer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(LogicPacksAccess.layer, ServerSecretStore.layer, layerRecording(sentMail)),
  ),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "lp-lp-oauth-test-" })),
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(FetchHttpClient.layer),
);

const LOCAL = "http://127.0.0.1:3999";
const mockEnv = (extra: Record<string, string> = {}) =>
  settingsFromEnv({ LOGICPACKS_CLOUD_URL: LOCAL, ...extra });

type Service = MemberOAuth["Service"];

/** Plays the browser: start, consent on the mock as `who`, come back with the state cookie. */
const roundTrip = (
  oauth: Service,
  provider: OAuthProviderId,
  who: OAuthIdentity,
  options: {
    readonly intent?: "signin" | "connect";
    readonly invite?: string;
    readonly project?: string;
    readonly userId?: string;
    readonly cookie?: (state: string) => string | null;
  } = {},
) =>
  Effect.gen(function* () {
    const started = yield* oauth.begin({
      provider,
      intent: options.intent ?? "signin",
      invite: options.invite,
      project: options.project,
      userId: options.userId,
    });
    const url = new URL(started.url, LOCAL);
    const mock = oauth.mockClient(provider)!;
    const code = mock.issueCode(who, provider === "google" ? url.searchParams.get("nonce") : null);
    return yield* oauth.complete({
      provider,
      code,
      state: started.state,
      cookieState: options.cookie ? options.cookie(started.state) : started.state,
    });
  });

const google = (email: string, verified = true) =>
  identity({ subject: `g-${email}`, email, emailVerified: verified, name: "Ana Example" });

it.layer(layerTest)("MemberOAuth", (it) => {
  it.effect("refuses a callback whose state does not match the browser's", () =>
    Effect.gen(function* () {
      const oauth = yield* make(mockEnv());
      const wrongCookie = yield* roundTrip(oauth, "google", google("state@example.com"), {
        cookie: () => "someone-elses-state",
      }).pipe(Effect.flip);
      assert.strictEqual(wrongCookie.reason, "state_mismatch");
      const noCookie = yield* roundTrip(oauth, "google", google("state@example.com"), {
        cookie: () => null,
      }).pipe(Effect.flip);
      assert.strictEqual(noCookie.reason, "state_mismatch");
      const unknown = yield* oauth
        .complete({ provider: "google", code: "x", state: "made-up", cookieState: "made-up" })
        .pipe(Effect.flip);
      assert.strictEqual(unknown.reason, "state_mismatch");
    }),
  );

  it.effect("a state is good for one callback and expires after ten minutes", () =>
    Effect.gen(function* () {
      const oauth = yield* make(mockEnv());
      const started = yield* oauth.begin({ provider: "google", intent: "signin" });
      yield* TestClock.adjust("11 minutes");
      const expired = yield* oauth
        .complete({
          provider: "google",
          code: "unused",
          state: started.state,
          cookieState: started.state,
        })
        .pipe(Effect.flip);
      assert.strictEqual(expired.reason, "state_mismatch");
    }),
  );

  it.effect("never links or creates from an unverified email", () =>
    Effect.gen(function* () {
      const oauth = yield* make(mockEnv());
      const access = yield* LogicPacksAccess.LogicPacksAccess;
      yield* access.signUp({ email: "victim@example.com", password: "correct-horse" });
      const error = yield* roundTrip(oauth, "google", google("victim@example.com", false)).pipe(
        Effect.flip,
      );
      assert.strictEqual(error.reason, "email_unverified");
      const fresh = yield* roundTrip(oauth, "google", google("nobody@example.com", false)).pipe(
        Effect.flip,
      );
      assert.strictEqual(fresh.reason, "email_unverified");
      const users = yield* access.listUsers();
      assert.isFalse(users.some((user) => user.email === "nobody@example.com"));
    }),
  );

  it.effect("signs a verified email into the member who has it and links the subject", () =>
    Effect.gen(function* () {
      const oauth = yield* make(mockEnv());
      const access = yield* LogicPacksAccess.LogicPacksAccess;
      const member = yield* access.signUp({ email: "Linked@Example.com", password: "pass-word-1" });
      const first = yield* roundTrip(oauth, "google", google("linked@example.com"));
      assert.strictEqual(first.kind, "signed_in");
      if (first.kind !== "signed_in") return;
      assert.strictEqual(first.user.userId, member.userId);
      assert.isFalse(first.created);
      // Linked: the same Google account still lands here after its address changes.
      const moved = yield* roundTrip(
        oauth,
        "google",
        identity({
          subject: "g-linked@example.com",
          email: "new@elsewhere.com",
          emailVerified: true,
        }),
      );
      assert.strictEqual(moved.kind === "signed_in" && moved.user.userId, member.userId);
      // The password still works too.
      const password = yield* access.logIn({
        email: "linked@example.com",
        password: "pass-word-1",
      });
      assert.strictEqual(password.userId, member.userId);
    }),
  );

  it.effect("creates a member for a new verified email, with onboarding still to answer", () =>
    Effect.gen(function* () {
      const oauth = yield* make(mockEnv());
      const access = yield* LogicPacksAccess.LogicPacksAccess;
      const result = yield* roundTrip(oauth, "google", google("newcomer@example.com"));
      assert.strictEqual(result.kind, "signed_in");
      if (result.kind !== "signed_in") return;
      assert.isTrue(result.created);
      assert.strictEqual(result.user.email, "newcomer@example.com");
      assert.strictEqual(result.user.displayName, "Ana Example");
      assert.isNull(access.onboardingChoice(result.user.userId));
      assert.strictEqual(access.listWorkspaces(result.user.userId).length, 1);
      // No password: the email form cannot be used to get in.
      const refused = yield* access
        .logIn({ email: "newcomer@example.com", password: "anything-at-all" })
        .pipe(Effect.flip);
      assert.strictEqual(refused.reason, "invalid_credentials");
    }),
  );

  it.effect("a sign-in from an invite link joins that workspace", () =>
    Effect.gen(function* () {
      const oauth = yield* make(mockEnv());
      const access = yield* LogicPacksAccess.LogicPacksAccess;
      const owner = yield* access.signUp({ email: "owner@team.com", password: "owner-pass-1" });
      const workspace = yield* access.createWorkspace({ actorUserId: owner.userId, name: "Team" });
      const token = yield* access.inviteToken({
        actorUserId: owner.userId,
        workspaceId: workspace.workspaceId,
      });
      const result = yield* roundTrip(oauth, "github", githubWho("invitee@team.com"), {
        invite: token,
      });
      assert.strictEqual(result.kind, "signed_in");
      if (result.kind !== "signed_in") return;
      const joined = access
        .listWorkspaces(result.user.userId)
        .find((entry) => entry.workspaceId === workspace.workspaceId);
      assert.strictEqual(joined?.role, "member");
      assert.strictEqual(access.currentWorkspaceId(result.user.userId), workspace.workspaceId);
    }),
  );

  it.effect("an email invited to a project gets it when they sign in with Google", () =>
    Effect.gen(function* () {
      const oauth = yield* make(mockEnv());
      const access = yield* LogicPacksAccess.LogicPacksAccess;
      const shares = yield* ProjectShares;
      const owner = yield* access.signUp({
        email: "owner-share@example.com",
        password: "pw-123456",
      });
      yield* access.recordOwner("p-oauth-share", owner.userId);
      const shared = yield* shares.share({
        projectId: "p-oauth-share",
        actorUserId: owner.userId,
        user: "invited-share@example.com",
        mail: { projectTitle: "Site", absoluteUrl: (path) => `${LOCAL}${path}` },
      });
      assert.strictEqual(shared.kind, "invited");
      // Plain "Continue with Google" from the login page, not the emailed link.
      const result = yield* roundTrip(oauth, "google", google("Invited-Share@example.com"));
      assert.strictEqual(result.kind, "signed_in");
      if (result.kind !== "signed_in") return;
      assert.isTrue(result.created);
      assert.isNull(access.roleOf(result.user.userId, "p-oauth-share"));
      // The step issueMemberSession runs for every sign-in, the provider callback included.
      yield* claimShareInvites(result.user);
      assert.strictEqual(access.roleOf(result.user.userId, "p-oauth-share"), "member");
      assert.strictEqual((yield* shares.listInvites("p-oauth-share")).length, 0);
    }),
  );

  it.effect("LOGICPACKS_SIGNUP gates new accounts; existing members always get in", () =>
    Effect.gen(function* () {
      const access = yield* LogicPacksAccess.LogicPacksAccess;
      const shares = yield* ProjectShares;
      const inviteOnly = yield* make(mockEnv({ LOGICPACKS_SIGNUP: "invite" }));
      const refused = yield* roundTrip(inviteOnly, "google", google("stranger@example.com")).pipe(
        Effect.flip,
      );
      assert.strictEqual(refused.reason, "signup_closed");
      // The emailed project invite link carries its token through the sign-in.
      const owner = yield* access.signUp({
        email: "owner-gate@example.com",
        password: "pw-123456",
      });
      yield* access.recordOwner("p-oauth-gate", owner.userId);
      const shared = yield* shares.share({
        projectId: "p-oauth-gate",
        actorUserId: owner.userId,
        user: "guest-gate@example.com",
        mail: { projectTitle: "Site", absoluteUrl: (path) => `${LOCAL}${path}` },
      });
      if (shared.kind !== "invited") return assert.fail("expected an invite");
      const joined = yield* roundTrip(inviteOnly, "google", google("guest-gate@example.com"), {
        project: shared.invite.token,
      });
      assert.strictEqual(joined.kind, "signed_in");
      if (joined.kind !== "signed_in") return;
      assert.strictEqual(
        joined.next,
        `/lp/join/project?invite=${encodeURIComponent(shared.invite.token)}`,
      );
      const closed = yield* make(mockEnv({ LOGICPACKS_SIGNUP: "closed" }));
      const closedNew = yield* roundTrip(closed, "google", google("late@example.com"), {
        project: shared.invite.token,
      }).pipe(Effect.flip);
      assert.strictEqual(closedNew.reason, "signup_closed");
      const existing = yield* roundTrip(closed, "google", google("owner-gate@example.com"));
      assert.strictEqual(existing.kind, "signed_in");
    }),
  );

  it.effect("a disabled provider starts nothing, and the mock is refused on a public URL", () =>
    Effect.gen(function* () {
      const off = yield* make(mockEnv({ LOGICPACKS_GOOGLE_PROVIDER: "disabled" }));
      assert.isFalse(off.enabled("google"));
      const error = yield* off.begin({ provider: "google", intent: "signin" }).pipe(Effect.flip);
      assert.strictEqual(error.reason, "disabled");

      const publicMock = settingsFromEnv({
        LOGICPACKS_CLOUD_URL: "https://app.logicpacks.io",
        LOGICPACKS_GOOGLE_PROVIDER: "mock",
      });
      assert.strictEqual(publicMock.providers.google.mode, "disabled");
      // auto on a public host with no client: off, never the mock.
      assert.strictEqual(publicMock.providers.github.mode, "disabled");
    }),
  );

  it.effect("GitHub sign-in stores that member's token, and only theirs", () =>
    Effect.gen(function* () {
      const oauth = yield* make(mockEnv());
      const result = yield* roundTrip(oauth, "github", githubWho("dev@example.com"));
      assert.strictEqual(result.kind, "signed_in");
      if (result.kind !== "signed_in") return;
      const other = yield* roundTrip(oauth, "google", google("other@example.com"));
      if (other.kind !== "signed_in") return assert.fail("other did not sign in");

      assert.strictEqual(
        yield* oauth.connectionToken(result.user.userId, "github"),
        "gh-token-dev",
      );
      assert.isNull(yield* oauth.connectionToken(other.user.userId, "github"));
      const mine = yield* oauth.connections(result.user.userId);
      assert.deepStrictEqual(mine.github, { available: true, connected: true, account: "dev" });
      assert.isFalse((yield* oauth.connections(other.user.userId)).github.connected);

      yield* oauth.disconnect(result.user.userId, "github");
      assert.isNull(yield* oauth.connectionToken(result.user.userId, "github"));
    }),
  );

  it.effect("connecting Cloudflare needs a member, and stores the token for that member", () =>
    Effect.gen(function* () {
      const oauth = yield* make(mockEnv());
      const access = yield* LogicPacksAccess.LogicPacksAccess;
      const anonymous = yield* oauth
        .begin({ provider: "cloudflare", intent: "connect" })
        .pipe(Effect.flip);
      assert.strictEqual(anonymous.reason, "not_signed_in");
      const asSignIn = yield* oauth
        .begin({ provider: "cloudflare", intent: "signin" })
        .pipe(Effect.flip);
      assert.strictEqual(asSignIn.reason, "disabled");

      const member = yield* access.signUp({ email: "cf@example.com", password: "cf-pass-1234" });
      const result = yield* roundTrip(
        oauth,
        "cloudflare",
        identity({ subject: "acct-1", accessToken: "cf-token", accountLabel: "Acme" }),
        { intent: "connect", userId: member.userId },
      );
      assert.strictEqual(result.kind, "connected");
      assert.strictEqual(yield* oauth.connectionToken(member.userId, "cloudflare"), "cf-token");
      assert.strictEqual((yield* oauth.connections(member.userId)).cloudflare.account, "Acme");
    }),
  );

  it.effect("hands a Google sign-in from the relay host to this one, once", () =>
    Effect.gen(function* () {
      const secret = "shared-secret-for-tests-0123456789";
      const relay = yield* make(
        mockEnv({
          LOGICPACKS_GOOGLE_HANDOFF_SECRET: secret,
          LOGICPACKS_GOOGLE_RELAY_RETURN_TO: "http://127.0.0.1:4000",
        }),
      );
      const receiver = yield* make(
        settingsFromEnv({
          LOGICPACKS_CLOUD_URL: "http://127.0.0.1:4000",
          LOGICPACKS_GOOGLE_HANDOFF_FROM: `${LOCAL}/lp/auth/google/relay`,
          LOGICPACKS_GOOGLE_HANDOFF_SECRET: secret,
        }),
      );
      assert.strictEqual(receiver.settings.providers.google.mode, "relay");

      // 1. The receiver sends the browser to the relay with its own state.
      const started = yield* receiver.begin({ provider: "google", intent: "signin" });
      const relayUrl = new URL(started.url);
      assert.strictEqual(relayUrl.searchParams.get("state"), started.state);
      const returnUrl = relayUrl.searchParams.get("return")!;
      assert.strictEqual(returnUrl, "http://127.0.0.1:4000/lp/auth/google/handoff");

      // A return address outside the allow list is refused.
      const refused = yield* relay
        .beginRelay({ outerState: started.state, returnUrl: "https://evil.example/x" })
        .pipe(Effect.flip);
      assert.strictEqual(refused.reason, "relay_refused");

      // 2. The relay runs Google and redirects back with a handoff token.
      const relayed = yield* relay.beginRelay({ outerState: started.state, returnUrl });
      const nonce = new URL(relayed.url, LOCAL).searchParams.get("nonce");
      const code = relay.mockClient("google")!.issueCode(google("handoff@example.com"), nonce);
      const back = yield* relay.complete({
        provider: "google",
        code,
        state: relayed.state,
        cookieState: relayed.state,
      });
      assert.strictEqual(back.kind, "redirect");
      if (back.kind !== "redirect") return;
      const token = new URL(back.location).searchParams.get("t")!;

      // 3. Another browser (no matching state cookie) cannot use it.
      const stolen = yield* receiver
        .redeemHandoff({ token, cookieState: "not-the-state" })
        .pipe(Effect.flip);
      assert.strictEqual(stolen.reason, "state_mismatch");
    }),
  );

  it.effect("a handoff token signs in once, and not after it expires", () =>
    Effect.gen(function* () {
      const secret = "another-shared-secret-0123456789";
      const receiver = yield* make(
        settingsFromEnv({
          LOGICPACKS_CLOUD_URL: "http://127.0.0.1:4000",
          LOGICPACKS_GOOGLE_HANDOFF_FROM: "https://relay.example",
          LOGICPACKS_GOOGLE_HANDOFF_SECRET: secret,
        }),
      );
      const nowSeconds = Math.floor((yield* Clock.currentTimeMillis) / 1000);
      const claims = (state: string, jti: string) => ({
        v: 1 as const,
        sub: "g-once",
        email: "once@example.com",
        emailVerified: true,
        name: null,
        state,
        jti,
        exp: nowSeconds + 60,
      });
      const first = yield* receiver.begin({ provider: "google", intent: "signin" });
      const token = signHandoff(secret, claims(first.state, "jti-1"));
      const ok = yield* receiver.redeemHandoff({ token, cookieState: first.state });
      assert.strictEqual(ok.kind, "signed_in");
      const replay = yield* receiver
        .redeemHandoff({ token, cookieState: first.state })
        .pipe(Effect.flip);
      assert.strictEqual(replay.reason, "handoff_invalid");

      const second = yield* receiver.begin({ provider: "google", intent: "signin" });
      yield* TestClock.adjust("2 minutes");
      const late = yield* receiver
        .redeemHandoff({
          token: signHandoff(secret, claims(second.state, "jti-2")),
          cookieState: second.state,
        })
        .pipe(Effect.flip);
      assert.strictEqual(late.reason, "handoff_invalid");
      const forged = yield* receiver
        .redeemHandoff({
          token: signHandoff("wrong-secret", claims(second.state, "jti-3")),
          cookieState: second.state,
        })
        .pipe(Effect.flip);
      assert.strictEqual(forged.reason, "handoff_invalid");
    }),
  );
});

const githubWho = (email: string) =>
  identity({
    subject: `gh-${email}`,
    email,
    emailVerified: true,
    name: null,
    accessToken: `gh-token-${email.split("@")[0]}`,
    accountLabel: email.split("@")[0]!,
  });

it("settings: real client when credentials are set, v1 env names still accepted", () => {
  const settings = settingsFromEnv({
    LOGICPACKS_CLOUD_URL: "https://app.logicpacks.io",
    LOGICPACKS_GOOGLE_CLIENT_ID: "id",
    LOGICPACKS_GOOGLE_CLIENT_SECRET: "secret",
    LOGICPACKS_GITHUB_CLIENT_ID: "id",
    LOGICPACKS_GITHUB_CLIENT_SECRET: "secret",
  });
  assert.strictEqual(settings.providers.google.mode, "real");
  assert.strictEqual(
    settings.providers.google.redirectUri,
    "https://app.logicpacks.io/lp/auth/google/callback",
  );
  assert.strictEqual(settings.providers.github.mode, "real");
  assert.strictEqual(
    settings.providers.github.redirectUri,
    "https://app.logicpacks.io/api/oauth/github/callback",
  );
  assert.strictEqual(settings.providers.cloudflare.mode, "disabled");
  assert.instanceOf(mockEnv().providers.google.client, MockOAuthClient);
});

it("GitHub: the verified primary address wins, an unverified one never counts", () => {
  assert.deepStrictEqual(
    pickGitHubEmail([
      { email: "old@x.com", primary: false, verified: true },
      { email: "Main@X.com", primary: true, verified: true },
    ]),
    { email: "main@x.com", verified: true },
  );
  assert.deepStrictEqual(
    pickGitHubEmail([
      { email: "main@x.com", primary: true, verified: false },
      { email: "alt@x.com", primary: false, verified: true },
    ]),
    { email: "alt@x.com", verified: true },
  );
  assert.deepStrictEqual(pickGitHubEmail([{ email: "a@x.com", primary: true, verified: false }]), {
    email: "a@x.com",
    verified: false,
  });
});

it("Google ID token: issuer, audience, expiry and nonce are all checked", () => {
  const good = {
    iss: "https://accounts.google.com",
    aud: "client",
    exp: 200,
    nonce: "n1",
    sub: "123",
    email: "A@Gmail.com",
    email_verified: true,
  };
  const expected = { clientId: "client", nonce: "n1", nowSeconds: 100 };
  const ok = checkGoogleIdToken(good, expected);
  assert.isTrue(ok.ok && ok.identity.email === "a@gmail.com" && ok.identity.emailVerified);
  assert.isFalse(checkGoogleIdToken({ ...good, nonce: "n2" }, expected).ok);
  assert.isFalse(checkGoogleIdToken({ ...good, aud: "other" }, expected).ok);
  assert.isFalse(checkGoogleIdToken({ ...good, iss: "https://evil" }, expected).ok);
  assert.isFalse(checkGoogleIdToken({ ...good, exp: 50 }, expected).ok);
  const unverified = checkGoogleIdToken({ ...good, email_verified: false }, expected);
  assert.isTrue(unverified.ok && !unverified.identity.emailVerified);
});

it("handoff tokens: tampering and expiry are caught", () => {
  const token = signHandoff("s", {
    v: 1,
    sub: "1",
    email: "a@b.c",
    emailVerified: true,
    name: null,
    state: "st",
    jti: "j",
    exp: 100,
  });
  assert.isTrue(verifyHandoff("s", token, 50).ok);
  assert.deepStrictEqual(verifyHandoff("s", token, 101), { ok: false, reason: "expired" });
  const [body, signature] = token.split(".");
  const tampered = `${Buffer.from(JSON.stringify({ email: "x" })).toString("base64url")}.${signature}`;
  assert.deepStrictEqual(verifyHandoff("s", tampered, 50), { ok: false, reason: "signature" });
  assert.deepStrictEqual(verifyHandoff("t", `${body}.${signature}`, 50), {
    ok: false,
    reason: "signature",
  });
});

it("member git auth rides in GIT_CONFIG_* env and turns off the host's credential helper", () => {
  const env = githubTokenGitEnv("tok-123");
  assert.strictEqual(env.GIT_CONFIG_COUNT, "2");
  assert.strictEqual(env.GIT_CONFIG_KEY_0, "http.https://github.com/.extraheader");
  assert.strictEqual(
    env.GIT_CONFIG_VALUE_0,
    `AUTHORIZATION: basic ${Buffer.from("x-access-token:tok-123").toString("base64")}`,
  );
  assert.strictEqual(env.GIT_CONFIG_KEY_1, "credential.https://github.com.helper");
  assert.strictEqual(env.GIT_CONFIG_VALUE_1, "");
});
