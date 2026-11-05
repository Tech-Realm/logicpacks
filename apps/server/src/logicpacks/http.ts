import {
  AuthAccessWriteScope,
  LP_HOST_PARTICIPANT_ID,
  LpLeaderboardRange,
  LpReportActivityInput,
  type ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerSettingsError,
} from "@logicpacks/contracts";
import { refuseIfReadOnly } from "./readOnly.ts";
import { hostAgents } from "./hostAgents.ts";
import { refuseIfProjectsOff } from "./zoneHttp.ts";
import { builtInRecipeCatalog } from "@logicpacks/shared/recipes/builtin";
import * as ByteSize from "effect/ByteSize";
import * as Config from "effect/Config";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import { deriveAuthClientMetadata } from "../auth/utils.ts";
import * as ServerConfig from "../config.ts";
import { messageAuthorStore } from "./messageAuthors.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  LogicPacksAccess,
  LogicPacksAccessError,
  type LogicPacksUser,
} from "./LogicPacksAccess.ts";
import { membersLanding } from "./landing.ts";
import { accountPageHtml, joinPageHtml, loginPageHtml } from "./loginPage.ts";
import { LogicPacksUsage, type UsageCaller } from "./LogicPacksUsage.ts";
import { MemberOAuth } from "./MemberOAuth.ts";
import { signupMode, type SignupMode } from "./signup.ts";
import { requireFeature } from "./features.ts";
import { cloudCreateGate } from "./featureHttp.ts";
import { createProject } from "./newProject.ts";
import { PROJECT_TEMPLATES } from "./projectTemplates.ts";
import {
  MEMBER_PROVIDER_KINDS,
  memberClaudeInstanceId,
  memberInstanceId,
} from "./memberProviders.ts";
import { importSyncedProject } from "./syncImport.ts";
import { LogicPacksSync } from "./LogicPacksSync.ts";
import {
  HELPER_LOCAL_OPERATOR_SUBJECT,
  MEMBER_SCOPES,
  memberSubject,
  memberUserIdFromSubject,
} from "./projectAccess.ts";
import { claimShareInvites } from "./shareClaim.ts";
import { redeemSignInCode } from "./FeatureAccess.ts";
import { cloudLoginGate } from "./cloudAgents.ts";
import { forgetProviderLogin } from "./loginVault.ts";
import { memberProviderHome } from "./memberLogin.ts";

const NO_STORE = { "cache-control": "no-store" };
const SESSION_TTL = Duration.days(30);
const JSON_MAX_BODY_BYTES = 16 * 1024;

const PasswordRequest = Schema.Struct({
  mode: Schema.Literals(["signup", "login"]),
  email: Schema.String,
  password: Schema.String,
  displayName: Schema.optionalKey(Schema.String),
});
const AddMemberRequest = Schema.Struct({
  projectId: Schema.String,
  user: Schema.String,
  role: Schema.optionalKey(Schema.Literals(["owner", "member"])),
});
const RemoveMemberRequest = Schema.Struct({ projectId: Schema.String, userId: Schema.String });
const SyncImportRequest = Schema.Struct({
  remoteUrl: Schema.String,
  title: Schema.optionalKey(Schema.String),
  shareWith: Schema.optionalKey(Schema.Array(Schema.String)),
});
const WorkspaceRole = Schema.Literals(["owner", "member", "viewer"]);
const WorkspaceRequest = Schema.Struct({ workspaceId: Schema.String });
const CreateWorkspaceRequest = Schema.Struct({ name: Schema.String });
const CurrentWorkspaceRequest = Schema.Struct({ workspaceId: Schema.NullOr(Schema.String) });
const RenameWorkspaceRequest = Schema.Struct({ workspaceId: Schema.String, name: Schema.String });
const AddWorkspaceMemberRequest = Schema.Struct({
  workspaceId: Schema.String,
  user: Schema.String,
  role: Schema.optionalKey(WorkspaceRole),
});
const WorkspaceMemberRoleRequest = Schema.Struct({
  workspaceId: Schema.String,
  userId: Schema.String,
  role: WorkspaceRole,
});
const WorkspaceMemberRequest = Schema.Struct({ workspaceId: Schema.String, userId: Schema.String });
export const JoinRequest = Schema.Struct({
  invite: Schema.String,
  /** `session` joins as whoever is signed in; the others sign in or up first. */
  mode: Schema.Literals(["session", "signup", "login", "quick"]),
  email: Schema.optionalKey(Schema.String),
  password: Schema.optionalKey(Schema.String),
  displayName: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
});
const NewProjectRequest = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("empty"),
    name: Schema.String,
    recipe: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({ kind: Schema.Literal("template"), name: Schema.String, template: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("git"), remoteUrl: Schema.String }),
]);
const ConnectClaudeRequest = Schema.Struct({
  /** A long-lived token from `claude setup-token`. Empty keeps a login done in the instance's home. */
  token: Schema.optionalKey(Schema.String),
});

export const json = (body: unknown, status = 200) =>
  HttpServerResponse.jsonUnsafe(body, { status, headers: NO_STORE });

const accessErrorStatus: Record<LogicPacksAccessError["reason"], number> = {
  invalid_email: 400,
  invalid_name: 400,
  weak_password: 400,
  email_taken: 409,
  invalid_credentials: 401,
  unknown_user: 404,
  not_owner: 403,
  read_only: 403,
  last_owner: 409,
  unknown_workspace: 404,
  invalid_workspace_name: 400,
  invalid_invite: 404,
  email_unverified: 400,
  signup_closed: 403,
  storage: 500,
};

export const accessErrorResponse = (error: LogicPacksAccessError) =>
  Effect.succeed(
    json({ error: error.reason, message: error.message }, accessErrorStatus[error.reason]),
  );

export const readBody = Effect.fn("logicpacks.readBody")(function* <A>(schema: Schema.Decoder<A>) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const body = yield* request.json.pipe(
    Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(JSON_MAX_BODY_BYTES)),
    Effect.flatMap(Schema.decodeUnknownEffect(schema)),
    Effect.option,
  );
  return body._tag === "Some" ? body.value : null;
});

/** Who is calling: a member (by user id) or the host operator. Anyone else is turned away. */
export type Caller =
  | { readonly kind: "member"; readonly userId: string }
  | { readonly kind: "operator" }
  | { readonly kind: "anonymous" };

/** The access service's actor: a member's user id, or null for the operator. */
export const actorOf = (caller: Caller) => (caller.kind === "member" ? caller.userId : null);

export const resolveCaller = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const session = yield* serverAuth.authenticateHttpRequest(request).pipe(Effect.option);
  if (session._tag === "None") return { kind: "anonymous" } as Caller;
  const userId = memberUserIdFromSubject(session.value.subject);
  if (userId !== null) return { kind: "member", userId } as Caller;
  if (session.value.subject === HELPER_LOCAL_OPERATOR_SUBJECT)
    return { kind: "operator" } as Caller;
  return session.value.scopes.includes(AuthAccessWriteScope)
    ? ({ kind: "operator" } as Caller)
    : ({ kind: "anonymous" } as Caller);
});

export const issueMemberSession = Effect.fn("logicpacks.issueMemberSession")(function* (
  user: LogicPacksUser,
) {
  // Every way in (password, quick login, a join link, a provider sign-in) passes here, so
  // projects shared with this email before the account existed open up now.
  yield* claimShareInvites(user);
  // An access code typed on the sign-in page unlocks its features on whichever path signs in.
  yield* redeemSignInCode(user.userId);
  const request = yield* HttpServerRequest.HttpServerRequest;
  const sessions = yield* SessionStore.SessionStore;
  const issued = yield* sessions.issue({
    ttl: SESSION_TTL,
    subject: memberSubject(user.userId),
    method: "browser-session-cookie",
    scopes: MEMBER_SCOPES,
    client: { ...deriveAuthClientMetadata({ request }), label: user.displayName },
  });
  return {
    cookieName: sessions.cookieName,
    token: issued.token,
    maxAge: Duration.millis(
      Math.max(
        0,
        DateTime.toEpochMillis(issued.expiresAt) - DateTime.toEpochMillis(yield* DateTime.now),
      ),
    ),
  };
});

export const withSessionCookie =
  (session: {
    readonly cookieName: string;
    readonly token: string;
    readonly maxAge: Duration.Duration;
  }) =>
  (response: HttpServerResponse.HttpServerResponse) =>
    response.pipe(
      HttpServerResponse.setCookie(session.cookieName, session.token, {
        httpOnly: true,
        path: "/",
        sameSite: "lax",
        maxAge: session.maxAge,
      }),
    );

export const quickLoginEnabled = Config.Boolean("LOGICPACKS_QUICK_LOGIN").pipe(
  Config.withDefault(false),
);

export { parseSignupMode, signupMode, type SignupMode } from "./signup.ts";
const currentSignupMode = signupMode.pipe(Effect.orElseSucceed((): SignupMode => "invite"));
const SIGNUP_INVITE_ONLY = {
  error: "signup_invite_only",
  message: "This host is invite only. Open the invite link you were sent to create an account.",
};
const SIGNUP_CLOSED = {
  error: "signup_closed",
  message: "This host is not taking new accounts.",
};

// Lets a cloud host pin the Claude CLI that member instances run, so a shared
// box can ship a newer CLI next to an older system-wide one.
const memberClaudeBinary = Config.String("LOGICPACKS_MEMBER_CLAUDE_BINARY").pipe(
  Config.withDefault(""),
);

/** Which "Continue with ..." buttons to show: only providers this host turned on. */
const signInProviders = Effect.map(Effect.serviceOption(MemberOAuth), (oauth) => ({
  google: oauth._tag === "Some" && oauth.value.enabled("google"),
  github: oauth._tag === "Some" && oauth.value.enabled("github"),
}));

/** Public: what the signed-out client should show. No session needed, nothing private. */
const hostRoute = HttpRouter.add(
  "GET",
  "/api/lp/host",
  Effect.gen(function* () {
    const quick = yield* quickLoginEnabled.pipe(Effect.orElseSucceed(() => false));
    return json({ membersLanding: yield* membersLanding, quickLogin: quick });
  }),
);

const loginPageRoute = HttpRouter.add(
  "GET",
  "/lp/login",
  Effect.gen(function* () {
    const quick = yield* quickLoginEnabled.pipe(Effect.orElseSucceed(() => false));
    const error = yield* queryParam("error");
    return HttpServerResponse.html(
      loginPageHtml({
        quickLogin: quick,
        providers: yield* signInProviders,
        error: error.length > 0 ? error.slice(0, 300) : null,
      }),
    ).pipe(HttpServerResponse.setHeaders(NO_STORE));
  }),
);

const accountPageRoute = HttpRouter.add(
  "GET",
  "/lp/account",
  Effect.succeed(
    HttpServerResponse.html(accountPageHtml()).pipe(HttpServerResponse.setHeaders(NO_STORE)),
  ),
);

const passwordRoute = HttpRouter.add(
  "POST",
  "/api/lp/auth/password",
  Effect.gen(function* () {
    const body = yield* readBody(PasswordRequest);
    if (body === null) return json({ error: "bad_request" }, 400);
    if (body.mode === "signup") {
      const mode = yield* currentSignupMode;
      if (mode !== "open") return json(mode === "closed" ? SIGNUP_CLOSED : SIGNUP_INVITE_ONLY, 403);
    }
    const access = yield* LogicPacksAccess;
    const user =
      body.mode === "signup"
        ? yield* access.signUp(body)
        : yield* access.logIn({ email: body.email, password: body.password });
    const session = yield* issueMemberSession(user);
    return yield* withSessionCookie(session)(json({ user }));
  }).pipe(Effect.catchTags({ LogicPacksAccessError: accessErrorResponse })),
);

/** `/api/lp/auth/quick?name=bea` signs in as bea@logicpacks.internal on hosts that allow it. */
const quickLoginRoute = HttpRouter.add(
  "GET",
  "/api/lp/auth/quick",
  Effect.gen(function* () {
    const enabled = yield* quickLoginEnabled.pipe(Effect.orElseSucceed(() => false));
    if (!enabled) return json({ error: "quick_login_disabled" }, 404);
    // A quick login makes an account on first use, so it is a sign-up.
    if ((yield* currentSignupMode) !== "open") return json(SIGNUP_INVITE_ONLY, 403);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    const name = url._tag === "Some" ? (url.value.searchParams.get("name") ?? "") : "";
    const access = yield* LogicPacksAccess;
    const user = yield* access.quickLogin(name);
    const session = yield* issueMemberSession(user);
    return yield* withSessionCookie(session)(
      HttpServerResponse.empty({ status: 302, headers: { ...NO_STORE, location: "/" } }),
    );
  }).pipe(Effect.catchTags({ LogicPacksAccessError: accessErrorResponse })),
);

const meRoute = HttpRouter.add(
  "GET",
  "/api/lp/me",
  Effect.gen(function* () {
    const caller = yield* resolveCaller;
    if (caller.kind !== "member") return json({ user: null, operator: caller.kind === "operator" });
    const access = yield* LogicPacksAccess;
    return json({ user: yield* access.getUser(caller.userId), operator: false });
  }).pipe(Effect.catchTags({ LogicPacksAccessError: accessErrorResponse })),
);

/** The projects the caller can open, with their role, for the account page's share list. */
const projectsRoute = HttpRouter.add(
  "GET",
  "/api/lp/projects",
  Effect.gen(function* () {
    const caller = yield* resolveCaller;
    if (caller.kind === "anonymous") return json({ error: "unauthenticated" }, 401);
    const access = yield* LogicPacksAccess;
    const store = yield* ProjectStore.ProjectStoreV2;
    const ids =
      caller.kind === "member"
        ? (Array.from(access.visibleProjectIds(caller.userId)) as Array<ProjectId>)
        : null;
    const shells =
      ids !== null && ids.length === 0
        ? []
        : yield* store.listShells(ids === null ? undefined : { projectIds: ids });
    return json({
      projects: shells.map((shell) => ({
        id: shell.id,
        title: shell.title,
        role: caller.kind === "member" ? access.roleOf(caller.userId, shell.id) : "operator",
        synced: access.isSynced(shell.id),
      })),
    });
  }).pipe(
    Effect.catchTags({
      ProjectStoreV2Error: () => Effect.succeed(json({ error: "storage" }, 500)),
    }),
  ),
);

const usersRoute = HttpRouter.add(
  "GET",
  "/api/lp/users",
  Effect.gen(function* () {
    const caller = yield* resolveCaller;
    if (caller.kind === "anonymous") return json({ error: "unauthenticated" }, 401);
    const access = yield* LogicPacksAccess;
    return json({ users: yield* access.listUsers() });
  }).pipe(Effect.catchTags({ LogicPacksAccessError: accessErrorResponse })),
);

const listMembersRoute = HttpRouter.add(
  "GET",
  "/api/lp/members",
  Effect.gen(function* () {
    const caller = yield* resolveCaller;
    if (caller.kind === "anonymous") return json({ error: "unauthenticated" }, 401);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    const projectId = url._tag === "Some" ? (url.value.searchParams.get("projectId") ?? "") : "";
    const access = yield* LogicPacksAccess;
    if (caller.kind === "member" && access.roleOf(caller.userId, projectId) === null) {
      return json({ error: "not_found" }, 404);
    }
    return json({ members: yield* access.listMembers(projectId) });
  }).pipe(Effect.catchTags({ LogicPacksAccessError: accessErrorResponse })),
);

const addMemberRoute = HttpRouter.add(
  "POST",
  "/api/lp/members",
  Effect.gen(function* () {
    const caller = yield* resolveCaller;
    if (caller.kind === "anonymous") return json({ error: "unauthenticated" }, 401);
    const body = yield* readBody(AddMemberRequest);
    if (body === null) return json({ error: "bad_request" }, 400);
    const access = yield* LogicPacksAccess;
    const member = yield* access.addMember({
      projectId: body.projectId,
      actorUserId: caller.kind === "member" ? caller.userId : null,
      user: body.user,
      role: body.role,
    });
    return json({ member });
  }).pipe(Effect.catchTags({ LogicPacksAccessError: accessErrorResponse })),
);

const removeMemberRoute = HttpRouter.add(
  "POST",
  "/api/lp/members/remove",
  Effect.gen(function* () {
    const caller = yield* resolveCaller;
    if (caller.kind === "anonymous") return json({ error: "unauthenticated" }, 401);
    const body = yield* readBody(RemoveMemberRequest);
    if (body === null) return json({ error: "bad_request" }, 400);
    const access = yield* LogicPacksAccess;
    yield* access.removeMember({
      projectId: body.projectId,
      actorUserId: caller.kind === "member" ? caller.userId : null,
      userId: body.userId,
    });
    return json({ removed: true });
  }).pipe(Effect.catchTags({ LogicPacksAccessError: accessErrorResponse })),
);

const settingsErrorResponse = (error: ServerSettingsError) =>
  Effect.succeed(json({ error: "settings", message: error.message }, 500));

/** The caller's own Claude instance: whether it exists and its id, for the model picker. */
const providersRoute = HttpRouter.add(
  "GET",
  "/api/lp/providers",
  Effect.gen(function* () {
    const caller = yield* resolveCaller;
    if (caller.kind !== "member") return json({ error: "members_only" }, 403);
    const settings = yield* ServerSettings.ServerSettingsService;
    const current = yield* settings.getSettings;
    const instanceId = memberClaudeInstanceId(caller.userId);
    return json({
      claude: {
        instanceId,
        connected: Object.hasOwn(current.providerInstances ?? {}, instanceId),
      },
    });
  }).pipe(Effect.catchTags({ ServerSettingsError: settingsErrorResponse })),
);

const connectClaudeRoute = HttpRouter.add(
  "POST",
  "/api/lp/providers/claude",
  Effect.gen(function* () {
    const caller = yield* resolveCaller;
    if (caller.kind !== "member") return json({ error: "members_only" }, 403);
    const body = yield* readBody(ConnectClaudeRequest);
    if (body === null) return json({ error: "bad_request" }, 400);
    const access = yield* LogicPacksAccess;
    const user = yield* access.getUser(caller.userId);
    if (user === null) return json({ error: "unknown_user" }, 404);
    const locked = yield* cloudLoginGate(user, "claude");
    if (locked !== null) return locked;
    const config = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    const settings = yield* ServerSettings.ServerSettingsService;
    const instanceId = memberClaudeInstanceId(caller.userId);
    const token = body.token?.trim() ?? "";
    const binaryPath = (yield* memberClaudeBinary.pipe(Effect.orElseSucceed(() => ""))).trim();
    yield* settings.updateProviderInstance({
      operation: "upsert",
      instanceId: ProviderInstanceId.make(instanceId),
      instance: {
        driver: ProviderDriverKind.make("claudeAgent"),
        displayName: `Claude (${user.displayName})`,
        environment:
          token.length === 0
            ? []
            : [{ name: "CLAUDE_CODE_OAUTH_TOKEN", value: token, sensitive: true }],
        config: {
          homePath: path.join(config.stateDir, "logicpacks", "members", caller.userId, "claude"),
          ...(binaryPath.length === 0 ? {} : { binaryPath }),
        },
      },
    });
    return json({ claude: { instanceId, connected: true } });
  }).pipe(
    Effect.catchTags({
      LogicPacksAccessError: accessErrorResponse,
      ServerSettingsError: settingsErrorResponse,
    }),
  ),
);

const disconnectClaudeRoute = HttpRouter.add(
  "POST",
  "/api/lp/providers/claude/remove",
  Effect.gen(function* () {
    const caller = yield* resolveCaller;
    if (caller.kind !== "member") return json({ error: "members_only" }, 403);
    const settings = yield* ServerSettings.ServerSettingsService;
    const instanceId = memberClaudeInstanceId(caller.userId);
    yield* settings.updateProviderInstance({
      operation: "remove",
      instanceId: ProviderInstanceId.make(instanceId),
    });
    // The token's secret is shredded with the instance; a login kept in its home goes too.
    const config = yield* ServerConfig.ServerConfig;
    forgetProviderLogin(memberProviderHome(config.stateDir, caller.userId, "claude"));
    return json({ claude: { instanceId, connected: false } });
  }).pipe(Effect.catchTags({ ServerSettingsError: settingsErrorResponse })),
);

/** The recipe catalog. Code is the default; app recipes are listed as Beta. */
const recipesRoute = HttpRouter.add(
  "GET",
  "/api/lp/recipes",
  Effect.gen(function* () {
    const caller = yield* resolveCaller;
    if (caller.kind === "anonymous") return json({ error: "unauthenticated" }, 401);
    return json(builtInRecipeCatalog());
  }),
);

/** The cloud half of Sync. A laptop pushes to GitHub, then calls this on the host. */
const syncImportRoute = HttpRouter.add(
  "POST",
  "/api/lp/sync/import",
  Effect.gen(function* () {
    const caller = yield* resolveCaller;
    if (caller.kind === "anonymous") return json({ error: "unauthenticated" }, 401);
    const readOnly = yield* refuseIfReadOnly(caller, null);
    if (readOnly !== null) return readOnly;
    const locked = yield* cloudCreateGate;
    if (locked !== null) return locked;
    const projectsOff = yield* refuseIfProjectsOff(caller);
    if (projectsOff !== null) return projectsOff;
    const body = yield* readBody(SyncImportRequest);
    if (body === null) return json({ error: "bad_request" }, 400);
    const result = yield* importSyncedProject({
      remoteUrl: body.remoteUrl,
      title: body.title,
      callerUserId: caller.kind === "member" ? caller.userId : null,
      shareWith: body.shareWith ?? [],
    });
    if (result.kind === "imported" || result.kind === "existing") {
      const usage = yield* LogicPacksUsage;
      yield* usage
        .recordActivity({
          participantId: caller.kind === "member" ? caller.userId : LP_HOST_PARTICIPANT_ID,
          kind: "project.synced",
          subject: result.projectId,
          projectId: result.projectId,
        })
        .pipe(Effect.catch((error) => Effect.logWarning("Could not record a sync", { error })));
    }
    switch (result.kind) {
      case "invalid_remote":
        return json({ error: "invalid_remote", message: "Use a GitHub remote URL." }, 400);
      case "not_shared":
        return json(
          {
            error: "not_shared",
            message: "This repository is on the host but not shared with you.",
          },
          403,
        );
      default:
        return json(result, result.kind === "imported" ? 201 : 200);
    }
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed(json({ error: "sync_failed", message: String(error.message ?? error) }, 502)),
    ),
  ),
);

export const queryParam = (name: string) =>
  Effect.map(HttpServerRequest.HttpServerRequest, (request) => {
    const url = HttpServerRequest.toURL(request);
    return url._tag === "Some" ? (url.value.searchParams.get(name) ?? "") : "";
  });

/** Everything the app's workspace header, avatar menu and first run need, in one call. */
const sessionRoute = HttpRouter.add(
  "GET",
  "/api/lp/session",
  Effect.gen(function* () {
    const caller = yield* resolveCaller;
    if (caller.kind === "anonymous") return json({ error: "unauthenticated" }, 401);
    const access = yield* LogicPacksAccess;
    const actor = actorOf(caller);
    const user = actor === null ? null : yield* access.getUser(actor);
    let claude: { readonly instanceId: string; readonly connected: boolean } | null = null;
    let agentConnected = false;
    if (actor !== null) {
      const settings = yield* ServerSettings.ServerSettingsService;
      const current = yield* settings.getSettings;
      const instances = current.providerInstances ?? {};
      const instanceId = memberClaudeInstanceId(actor);
      claude = { instanceId, connected: Object.hasOwn(instances, instanceId) };
      // Claude, Codex, OpenCode or Gemini: any of the member's own agents counts.
      agentConnected = MEMBER_PROVIDER_KINDS.some((kind) =>
        Object.hasOwn(instances, memberInstanceId(kind, actor)),
      );
    }
    const oauth = yield* Effect.serviceOption(MemberOAuth);
    const connections =
      actor !== null && oauth._tag === "Some" ? yield* oauth.value.connections(actor) : null;
    const sync = yield* Effect.serviceOption(LogicPacksSync);
    const hostLabel = (yield* Config.String("LOGICPACKS_HOST_LABEL").pipe(
      Config.withDefault(""),
      Effect.orElseSucceed(() => ""),
    )).trim();
    return json({
      user,
      operator: caller.kind === "operator",
      /** This server is the team's cloud host, so its projects are on the cloud. */
      cloudHost: sync._tag === "Some" && sync.value.isCloudHost,
      /** What members see as this machine's name; null means "<workspace> cloud". */
      hostLabel: hostLabel.length > 0 ? hostLabel : null,
      workspaces: access.listWorkspaces(actor),
      currentWorkspaceId: access.currentWorkspaceId(actor),
      /**
       * A member's access zones per visible project (preset, values and where they came from).
       * The app's composer and panels render from these; the server enforces them on every call.
       */
      access:
        actor === null
          ? {}
          : Object.fromEntries(
              Array.from(access.visibleProjectIds(actor)).map((projectId) => {
                const resolved = access.zonesOf(actor, projectId);
                return [
                  projectId,
                  { preset: resolved.preset, zones: resolved.zones, source: resolved.source },
                ];
              }),
            ),
      /** Projects zone: whether this person may create projects and workspaces on this host. */
      canCreateProjects: actor === null ? true : access.canCreateProjects(actor),
      /** The agents this host has installed: the ones its members can be lent. */
      hostAgents: yield* hostAgents,
      claude,
      agentConnected,
      /** First-run answer to "How do you work?"; null until the member answers or skips. */
      onboarding: actor === null ? null : access.onboardingChoice(actor),
      connections,
      /** Access-gated features this caller has unlocked ("apps"). */
      features: (yield* requireFeature(caller, "apps")) ? ["apps"] : [],
      /** Desktop/laptop host: agents run on the installed Claude Code / Codex, no cloud logins. */
      localAgents: !(sync._tag === "Some" && sync.value.isCloudHost),
      templates: PROJECT_TEMPLATES.map(({ id, title, description }) => ({
        id,
        title,
        description,
      })),
    });
  }).pipe(
    Effect.catchTags({
      LogicPacksAccessError: accessErrorResponse,
      ServerSettingsError: (error: ServerSettingsError) => settingsErrorResponse(error),
    }),
  ),
);

/** A POST route for a signed-in caller whose body decodes with `schema`. */
const callerRoute = <A>(
  path: `/api/lp/${string}`,
  schema: Schema.Decoder<A>,
  handle: (
    body: A,
    actor: string | null,
  ) => Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    LogicPacksAccessError,
    LogicPacksAccess
  >,
) =>
  HttpRouter.add(
    "POST",
    path,
    Effect.gen(function* () {
      const caller = yield* resolveCaller;
      if (caller.kind === "anonymous") return json({ error: "unauthenticated" }, 401);
      const body = yield* readBody(schema);
      if (body === null) return json({ error: "bad_request" }, 400);
      return yield* handle(body, actorOf(caller));
    }).pipe(Effect.catchTags({ LogicPacksAccessError: accessErrorResponse })),
  );

const createWorkspaceRoute = HttpRouter.add(
  "POST",
  "/api/lp/workspaces",
  Effect.gen(function* () {
    const caller = yield* resolveCaller;
    if (caller.kind === "anonymous") return json({ error: "unauthenticated" }, 401);
    const locked = yield* cloudCreateGate;
    if (locked !== null) return locked;
    const projectsOff = yield* refuseIfProjectsOff(caller, "workspace");
    if (projectsOff !== null) return projectsOff;
    const body = yield* readBody(CreateWorkspaceRequest);
    if (body === null) return json({ error: "bad_request" }, 400);
    const access = yield* LogicPacksAccess;
    const workspace = yield* access.createWorkspace({
      actorUserId: actorOf(caller),
      name: body.name,
    });
    return json({ workspace }, 201);
  }).pipe(Effect.catchTags({ LogicPacksAccessError: accessErrorResponse })),
);

const currentWorkspaceRoute = callerRoute(
  "/api/lp/workspaces/current",
  CurrentWorkspaceRequest,
  (body, actor) =>
    LogicPacksAccess.use((access) =>
      access.setCurrentWorkspace({ actorUserId: actor, workspaceId: body.workspaceId }),
    ).pipe(Effect.as(json({ currentWorkspaceId: body.workspaceId }))),
);

const renameWorkspaceRoute = callerRoute(
  "/api/lp/workspaces/rename",
  RenameWorkspaceRequest,
  (body, actor) =>
    LogicPacksAccess.use((access) =>
      access.renameWorkspace({
        actorUserId: actor,
        workspaceId: body.workspaceId,
        name: body.name,
      }),
    ).pipe(Effect.as(json({ renamed: true }))),
);

const deleteWorkspaceRoute = callerRoute(
  "/api/lp/workspaces/delete",
  WorkspaceRequest,
  (body, actor) =>
    LogicPacksAccess.use((access) =>
      access.deleteWorkspace({ actorUserId: actor, workspaceId: body.workspaceId }),
    ).pipe(Effect.as(json({ deleted: true }))),
);

const workspaceMembersRoute = HttpRouter.add(
  "GET",
  "/api/lp/workspaces/members",
  Effect.gen(function* () {
    const caller = yield* resolveCaller;
    if (caller.kind === "anonymous") return json({ error: "unauthenticated" }, 401);
    const workspaceId = yield* queryParam("workspaceId");
    const access = yield* LogicPacksAccess;
    const actor = actorOf(caller);
    const members = yield* access.listWorkspaceMembers({ actorUserId: actor, workspaceId });
    const role =
      actor === null
        ? "operator"
        : access.listWorkspaces(actor).find((workspace) => workspace.workspaceId === workspaceId)
            ?.role;
    const authorStore = messageAuthorStore((yield* ServerConfig.ServerConfig).stateDir);
    const palette = (id: string) => authorStore.colorOf(id);
    return json({ members: members.map((m) => ({ ...m, color: palette(m.user.userId) })), canManage: role === "operator" || role === "owner" });
  }).pipe(Effect.catchTags({ LogicPacksAccessError: accessErrorResponse })),
);

const addWorkspaceMemberRoute = callerRoute(
  "/api/lp/workspaces/members",
  AddWorkspaceMemberRequest,
  (body, actor) =>
    LogicPacksAccess.use((access) =>
      access.addWorkspaceMember({
        actorUserId: actor,
        workspaceId: body.workspaceId,
        user: body.user,
        role: body.role,
      }),
    ).pipe(Effect.map((member) => json({ member }))),
);

const workspaceMemberRoleRoute = callerRoute(
  "/api/lp/workspaces/members/role",
  WorkspaceMemberRoleRequest,
  (body, actor) =>
    LogicPacksAccess.use((access) => access.setWorkspaceRole({ actorUserId: actor, ...body })).pipe(
      Effect.as(json({ role: body.role })),
    ),
);

const removeWorkspaceMemberRoute = callerRoute(
  "/api/lp/workspaces/members/remove",
  WorkspaceMemberRequest,
  (body, actor) =>
    LogicPacksAccess.use((access) =>
      access.removeWorkspaceMember({ actorUserId: actor, ...body }),
    ).pipe(Effect.as(json({ removed: true }))),
);

const invitePath = (token: string) => `/lp/join?invite=${encodeURIComponent(token)}`;

const inviteRoute = HttpRouter.add(
  "GET",
  "/api/lp/workspaces/invite",
  Effect.gen(function* () {
    const caller = yield* resolveCaller;
    if (caller.kind === "anonymous") return json({ error: "unauthenticated" }, 401);
    const workspaceId = yield* queryParam("workspaceId");
    const access = yield* LogicPacksAccess;
    const token = yield* access.inviteToken({ actorUserId: actorOf(caller), workspaceId });
    return json({ path: invitePath(token) });
  }).pipe(Effect.catchTags({ LogicPacksAccessError: accessErrorResponse })),
);

const resetInviteRoute = callerRoute(
  "/api/lp/workspaces/invite/reset",
  WorkspaceRequest,
  (body, actor) =>
    LogicPacksAccess.use((access) =>
      access.resetInvite({ actorUserId: actor, workspaceId: body.workspaceId }),
    ).pipe(Effect.map((token) => json({ path: invitePath(token) }))),
);

/**
 * The invite link. Someone already signed in joins on the spot and lands in the
 * workspace; anyone else gets one form that signs them up or in, then joins.
 */
const joinPageRoute = HttpRouter.add(
  "GET",
  "/lp/join",
  Effect.gen(function* () {
    const token = yield* queryParam("invite");
    const access = yield* LogicPacksAccess;
    const workspace = access.workspaceForInvite(token);
    const caller = yield* resolveCaller;
    if (workspace !== null && caller.kind === "member") {
      yield* access.joinWithInvite({ token, userId: caller.userId });
      return HttpServerResponse.empty({ status: 302, headers: { ...NO_STORE, location: "/" } });
    }
    const quick = yield* quickLoginEnabled.pipe(Effect.orElseSucceed(() => false));
    return HttpServerResponse.html(
      joinPageHtml({
        workspaceName: workspace?.name ?? null,
        quickLogin: quick,
        invite: token,
        providers: yield* signInProviders,
      }),
    ).pipe(HttpServerResponse.setHeaders(NO_STORE));
  }).pipe(Effect.catchTags({ LogicPacksAccessError: accessErrorResponse })),
);

const joinRoute = HttpRouter.add(
  "POST",
  "/api/lp/join",
  Effect.gen(function* () {
    const body = yield* readBody(JoinRequest);
    if (body === null) return json({ error: "bad_request" }, 400);
    const access = yield* LogicPacksAccess;
    if (access.workspaceForInvite(body.invite) === null) {
      return json(
        { error: "invalid_invite", message: "This invite link has expired. Ask for a new one." },
        404,
      );
    }
    let user: LogicPacksUser;
    let issueCookie = true;
    // A valid invite lets a new account in unless the host takes nobody new.
    if (
      (body.mode === "signup" || body.mode === "quick") &&
      (yield* currentSignupMode) === "closed"
    ) {
      return json(SIGNUP_CLOSED, 403);
    }
    switch (body.mode) {
      case "session": {
        const caller = yield* resolveCaller;
        if (caller.kind !== "member") return json({ error: "unauthenticated" }, 401);
        const found = yield* access.getUser(caller.userId);
        if (found === null) return json({ error: "unknown_user" }, 404);
        user = found;
        issueCookie = false;
        break;
      }
      case "quick": {
        const enabled = yield* quickLoginEnabled.pipe(Effect.orElseSucceed(() => false));
        if (!enabled) return json({ error: "quick_login_disabled" }, 404);
        user = yield* access.quickLogin(body.name ?? "");
        break;
      }
      case "signup":
        user = yield* access.signUp({
          email: body.email ?? "",
          password: body.password ?? "",
          displayName: body.displayName,
        });
        break;
      case "login":
        user = yield* access.logIn({ email: body.email ?? "", password: body.password ?? "" });
        break;
    }
    const workspace = yield* access.joinWithInvite({ token: body.invite, userId: user.userId });
    const response = json({ user, workspace });
    return issueCookie
      ? yield* withSessionCookie(yield* issueMemberSession(user))(response)
      : response;
  }).pipe(Effect.catchTags({ LogicPacksAccessError: accessErrorResponse })),
);

const logoutRoute = HttpRouter.add(
  "POST",
  "/api/lp/auth/logout",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const sessions = yield* SessionStore.SessionStore;
    const session = yield* serverAuth.authenticateHttpRequest(request).pipe(Effect.option);
    // Only member sessions sign out here; the operator's device pairing is managed in Settings.
    if (session._tag === "Some" && memberUserIdFromSubject(session.value.subject) !== null) {
      yield* sessions.revoke(session.value.sessionId).pipe(Effect.ignore);
    }
    return yield* json({ signedOut: true }).pipe(
      HttpServerResponse.expireCookie(sessions.cookieName, { path: "/" }),
    );
  }),
);

const newProjectRoute = HttpRouter.add(
  "POST",
  "/api/lp/projects/new",
  Effect.gen(function* () {
    const caller = yield* resolveCaller;
    if (caller.kind === "anonymous") return json({ error: "unauthenticated" }, 401);
    const readOnly = yield* refuseIfReadOnly(caller, null);
    if (readOnly !== null) return readOnly;
    const locked = yield* cloudCreateGate;
    if (locked !== null) return locked;
    const projectsOff = yield* refuseIfProjectsOff(caller);
    if (projectsOff !== null) return projectsOff;
    const body = yield* readBody(NewProjectRequest);
    if (body === null) return json({ error: "bad_request" }, 400);
    const result = yield* createProject(body, actorOf(caller));
    return result.kind === "created"
      ? json({ projectId: result.projectId }, 201)
      : json({ error: "invalid", message: result.message }, 400);
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed(
        json({ error: "create_failed", message: String(error.message ?? error) }, 500),
      ),
    ),
  ),
);

const isLeaderboardRange = Schema.is(LpLeaderboardRange);

export const usageCallerOf = (caller: Caller): UsageCaller | null =>
  caller.kind === "member"
    ? { participantId: caller.userId, isOperator: false }
    : caller.kind === "operator"
      ? { participantId: LP_HOST_PARTICIPANT_ID, isOperator: true }
      : null;

const usageErrorResponse = (error: { readonly reason: string; readonly message: string }) =>
  Effect.succeed(
    json({ error: error.reason, message: error.message }, error.reason === "not_found" ? 404 : 500),
  );

/** The workspace leaderboard, for the account page and the helper. Same privacy rules as the app. */
const leaderboardRoute = HttpRouter.add(
  "GET",
  "/api/lp/leaderboard",
  Effect.gen(function* () {
    const caller = usageCallerOf(yield* resolveCaller);
    if (caller === null) return json({ error: "unauthenticated" }, 401);
    const rangeParam = yield* queryParam("range");
    const range = isLeaderboardRange(rangeParam) ? rangeParam : "30d";
    const store = yield* ProjectStore.ProjectStoreV2;
    const shells = yield* store.listShells().pipe(Effect.orElseSucceed(() => []));
    const usage = yield* LogicPacksUsage;
    return json(
      yield* usage.leaderboard({
        caller,
        range,
        projectId: (yield* queryParam("projectId")) || null,
        projectTitles: new Map(shells.map((shell) => [shell.id as string, shell.title])),
      }),
    );
  }).pipe(Effect.catchTags({ LpUsageError: usageErrorResponse })),
);

const achievementsRoute = HttpRouter.add(
  "GET",
  "/api/lp/achievements",
  Effect.gen(function* () {
    const caller = usageCallerOf(yield* resolveCaller);
    if (caller === null) return json({ error: "unauthenticated" }, 401);
    const usage = yield* LogicPacksUsage;
    const participantId = (yield* queryParam("participantId")) || undefined;
    return json(yield* usage.achievements({ caller, participantId }));
  }).pipe(Effect.catchTags({ LpUsageError: usageErrorResponse })),
);

const UsageSharingRequest = Schema.Struct({ shareUsage: Schema.Boolean });

const usageSharingRoute = HttpRouter.add(
  "POST",
  "/api/lp/usage-sharing",
  Effect.gen(function* () {
    const caller = usageCallerOf(yield* resolveCaller);
    if (caller === null) return json({ error: "unauthenticated" }, 401);
    const body = yield* readBody(UsageSharingRequest);
    if (body === null) return json({ error: "bad_request" }, 400);
    const usage = yield* LogicPacksUsage;
    return json(yield* usage.setSharing(caller, body.shareUsage));
  }).pipe(Effect.catchTags({ LpUsageError: usageErrorResponse })),
);

/** The helper and agents report what the server cannot see: linked sessions, resolved conflicts. */
const activityRoute = HttpRouter.add(
  "POST",
  "/api/lp/activity",
  Effect.gen(function* () {
    const caller = usageCallerOf(yield* resolveCaller);
    if (caller === null) return json({ error: "unauthenticated" }, 401);
    const body = yield* readBody(LpReportActivityInput);
    if (body === null) return json({ error: "bad_request" }, 400);
    const usage = yield* LogicPacksUsage;
    const unlocked = yield* usage.recordActivity({
      participantId: caller.participantId,
      kind: body.kind,
      subject: body.subject,
      projectId: body.projectId,
    });
    return json({ recorded: true, unlocked });
  }).pipe(Effect.catchTags({ LpUsageError: usageErrorResponse })),
);

export const layer = Layer.mergeAll(
  hostRoute,
  sessionRoute,
  createWorkspaceRoute,
  currentWorkspaceRoute,
  renameWorkspaceRoute,
  deleteWorkspaceRoute,
  workspaceMembersRoute,
  addWorkspaceMemberRoute,
  workspaceMemberRoleRoute,
  removeWorkspaceMemberRoute,
  inviteRoute,
  resetInviteRoute,
  joinPageRoute,
  joinRoute,
  logoutRoute,
  newProjectRoute,
  leaderboardRoute,
  achievementsRoute,
  usageSharingRoute,
  activityRoute,
  syncImportRoute,
  recipesRoute,
  providersRoute,
  connectClaudeRoute,
  disconnectClaudeRoute,
  loginPageRoute,
  accountPageRoute,
  projectsRoute,
  passwordRoute,
  quickLoginRoute,
  meRoute,
  usersRoute,
  listMembersRoute,
  addMemberRoute,
  removeMemberRoute,
);
