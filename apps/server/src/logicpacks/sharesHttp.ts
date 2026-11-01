import type { ProjectId } from "@logicpacks/contracts";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import {
  accessErrorResponse,
  actorOf,
  issueMemberSession,
  json,
  JoinRequest,
  queryParam,
  quickLoginEnabled,
  readBody,
  resolveCaller,
  withSessionCookie,
} from "./http.ts";
import {
  LogicPacksAccess,
  type LogicPacksAccessError,
  type LogicPacksUser,
} from "./LogicPacksAccess.ts";
import { joinPageHtml } from "./loginPage.ts";
import { MemberOAuth } from "./MemberOAuth.ts";
import {
  LINK_EXPIRY,
  ProjectShares,
  projectJoinPath,
  ShareError,
  type MailContext,
  type PendingInvite,
  type ShareLink,
} from "./ProjectShares.ts";
import { normalizeQuickLoginName, quickLoginEmail } from "./projectAccess.ts";
import { ShareMailer } from "./shareMail.ts";

const NO_STORE = { "cache-control": "no-store" };

const ShareRequest = Schema.Struct({ projectId: Schema.String, user: Schema.String });
const InviteRequest = Schema.Struct({ projectId: Schema.String, inviteId: Schema.String });
const ProjectRequest = Schema.Struct({ projectId: Schema.String });
const LinkRequest = Schema.Struct({
  projectId: Schema.String,
  enabled: Schema.optionalKey(Schema.Boolean),
  expiry: Schema.optionalKey(Schema.Literals(LINK_EXPIRY)),
  domain: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

const shareErrorStatus: Record<ShareError["reason"], number> = {
  invalid_email: 400,
  invalid_domain: 400,
  not_owner: 403,
  not_found: 404,
  invite_used: 410,
  invite_expired: 410,
  link_off: 410,
  link_expired: 410,
  wrong_domain: 403,
  storage: 500,
};

const shareErrorResponse = (error: ShareError) =>
  Effect.succeed(
    json({ error: error.reason, message: error.message }, shareErrorStatus[error.reason]),
  );

const projectTitle = Effect.fn("logicpacks.shares.projectTitle")(function* (projectId: string) {
  const store = yield* ProjectStore.ProjectStoreV2;
  const shells = yield* store
    .listShells({ projectIds: [projectId as ProjectId] })
    .pipe(Effect.orElseSucceed(() => []));
  return shells[0]?.title ?? "a project";
});

/**
 * Absolute links for emails: LOGICPACKS_PUBLIC_URL when set (a host behind a proxy), else the
 * origin the owner's browser is on, else this request's host.
 */
const publicBase = Effect.gen(function* () {
  const configured = (yield* Config.String("LOGICPACKS_PUBLIC_URL").pipe(
    Config.withDefault(""),
    Effect.orElseSucceed(() => ""),
  )).trim();
  if (configured.length > 0) return configured.replace(/\/+$/, "");
  const request = yield* HttpServerRequest.HttpServerRequest;
  const origin = request.headers["origin"];
  if (origin && /^https?:\/\//.test(origin)) return origin.replace(/\/+$/, "");
  const host = request.headers["x-forwarded-host"] ?? request.headers["host"] ?? "localhost";
  const proto = request.headers["x-forwarded-proto"] ?? "http";
  return `${proto}://${host}`;
});

export const mailContext = Effect.fn("logicpacks.shares.mailContext")(function* (
  projectId: string,
) {
  const base = yield* publicBase;
  return {
    projectTitle: yield* projectTitle(projectId),
    absoluteUrl: (path: string) => `${base}${path}`,
  } satisfies MailContext;
});

const inviteView = (invite: PendingInvite) => ({
  inviteId: invite.inviteId,
  email: invite.email,
  role: invite.role,
  createdAt: invite.createdAt,
  expiresAt: invite.expiresAt,
  lastSentAt: invite.lastSentAt,
  path: projectJoinPath(invite.token),
});

const linkView = (link: ShareLink | null) =>
  link === null
    ? null
    : {
        enabled: link.enabled,
        role: link.role,
        expiry: link.expiry,
        expiresAt: link.expiresAt,
        domain: link.domain,
        path: projectJoinPath(link.token),
      };

const catchAll = <A, R>(effect: Effect.Effect<A, ShareError | LogicPacksAccessError, R>) =>
  effect.pipe(
    Effect.catchTags({
      ShareError: shareErrorResponse,
      LogicPacksAccessError: accessErrorResponse,
    }),
  );

/** Everything the Share dialog shows. Pending invites and the link are for owners only. */
const overviewRoute = HttpRouter.add(
  "GET",
  "/api/lp/shares",
  catchAll(
    Effect.gen(function* () {
      const caller = yield* resolveCaller;
      if (caller.kind === "anonymous") return json({ error: "unauthenticated" }, 401);
      const projectId = yield* queryParam("projectId");
      const access = yield* LogicPacksAccess;
      const shares = yield* ProjectShares;
      const mailer = yield* ShareMailer;
      const actor = actorOf(caller);
      const role = actor === null ? "owner" : access.roleOf(actor, projectId);
      if (role === null) return json({ error: "not_found" }, 404);
      const members = yield* access.listMembers(projectId);
      if (role !== "owner") {
        return json({ canManage: false, members, invites: [], link: null, joins: [] });
      }
      return json({
        canManage: true,
        members,
        invites: (yield* shares.listInvites(projectId)).map(inviteView),
        link: linkView(yield* shares.getLink(projectId)),
        joins: yield* shares.linkJoins(projectId),
        emailMode: mailer.mode,
      });
    }),
  ),
);

/** A POST for a signed-in caller; the body names the project. */
const postRoute = <A extends { readonly projectId: string }, R>(
  path: `/api/lp/${string}`,
  schema: Schema.Decoder<A>,
  handle: (
    body: A,
    actor: string | null,
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse, ShareError | LogicPacksAccessError, R>,
) =>
  HttpRouter.add(
    "POST",
    path,
    catchAll(
      Effect.gen(function* () {
        const caller = yield* resolveCaller;
        if (caller.kind === "anonymous") return json({ error: "unauthenticated" }, 401);
        const body = yield* readBody(schema);
        if (body === null) return json({ error: "bad_request" }, 400);
        return yield* handle(body, actorOf(caller));
      }),
    ),
  );

const shareRoute = postRoute("/api/lp/shares", ShareRequest, (body, actor) =>
  Effect.gen(function* () {
    const shares = yield* ProjectShares;
    const outcome = yield* shares.share({
      projectId: body.projectId,
      actorUserId: actor,
      user: body.user,
      mail: yield* mailContext(body.projectId),
    });
    return outcome.kind === "member"
      ? json({ kind: "member", member: outcome.member })
      : json({
          kind: "invited",
          invite: inviteView(outcome.invite),
          emailSent: outcome.mail.delivered,
        });
  }),
);

const resendRoute = postRoute("/api/lp/shares/invites/resend", InviteRequest, (body, actor) =>
  Effect.gen(function* () {
    const shares = yield* ProjectShares;
    const result = yield* shares.resendInvite({
      projectId: body.projectId,
      actorUserId: actor,
      inviteId: body.inviteId,
      mail: yield* mailContext(body.projectId),
    });
    return json({ invite: inviteView(result.invite), emailSent: result.mail.delivered });
  }),
);

const revokeRoute = postRoute("/api/lp/shares/invites/revoke", InviteRequest, (body, actor) =>
  ProjectShares.use((shares) =>
    shares.revokeInvite({ projectId: body.projectId, actorUserId: actor, inviteId: body.inviteId }),
  ).pipe(Effect.as(json({ revoked: true }))),
);

const linkRoute = postRoute("/api/lp/shares/link", LinkRequest, (body, actor) =>
  ProjectShares.use((shares) =>
    shares.updateLink({
      projectId: body.projectId,
      actorUserId: actor,
      enabled: body.enabled,
      expiry: body.expiry,
      domain: body.domain,
    }),
  ).pipe(Effect.map((link) => json({ link: linkView(link) }))),
);

const resetLinkRoute = postRoute("/api/lp/shares/link/reset", ProjectRequest, (body, actor) =>
  ProjectShares.use((shares) =>
    shares.resetLink({ projectId: body.projectId, actorUserId: actor }),
  ).pipe(Effect.map((link) => json({ link: linkView(link) }))),
);

/**
 * A project invite or share link. Someone signed in joins on the spot and lands in the app
 * with the project open in their sidebar; anyone else signs up or in on the join page first.
 */
const joinProjectPageRoute = HttpRouter.add(
  "GET",
  "/lp/join/project",
  catchAll(
    Effect.gen(function* () {
      const token = yield* queryParam("invite");
      const shares = yield* ProjectShares;
      const target = yield* shares.resolveToken(token);
      const quick = yield* quickLoginEnabled.pipe(Effect.orElseSucceed(() => false));
      if (target.kind === "closed") {
        return HttpServerResponse.html(
          joinPageHtml({
            workspaceName: null,
            quickLogin: false,
            project: { title: null, closedMessage: target.message },
          }),
        ).pipe(HttpServerResponse.setHeaders(NO_STORE));
      }
      const caller = yield* resolveCaller;
      if (caller.kind === "member") {
        const access = yield* LogicPacksAccess;
        const user = yield* access.getUser(caller.userId);
        if (user !== null) {
          const joined = yield* shares.joinWithToken({ token, user }).pipe(Effect.option);
          if (joined._tag === "Some") {
            return HttpServerResponse.empty({
              status: 302,
              headers: { ...NO_STORE, location: "/" },
            });
          }
        }
      }
      const oauth = yield* Effect.serviceOption(MemberOAuth);
      return HttpServerResponse.html(
        joinPageHtml({
          workspaceName: null,
          quickLogin: quick && target.kind === "link" && target.domain === null,
          invite: token,
          providers: {
            google: oauth._tag === "Some" && oauth.value.enabled("google"),
            github: oauth._tag === "Some" && oauth.value.enabled("github"),
          },
          project: {
            title: yield* projectTitle(target.projectId),
            email: target.kind === "invite" ? target.email : undefined,
            domain: target.kind === "link" ? target.domain : null,
          },
        }),
      ).pipe(HttpServerResponse.setHeaders(NO_STORE));
    }),
  ),
);

const joinProjectRoute = HttpRouter.add(
  "POST",
  "/api/lp/join/project",
  Effect.gen(function* () {
    const body = yield* readBody(JoinRequest);
    if (body === null) return json({ error: "bad_request" }, 400);
    const access = yield* LogicPacksAccess;
    const shares = yield* ProjectShares;
    let user: LogicPacksUser;
    let issueCookie = true;
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
        const name = normalizeQuickLoginName(body.name ?? "");
        if (name !== null) yield* shares.checkEmailForToken(body.invite, quickLoginEmail(name));
        user = yield* access.quickLogin(body.name ?? "");
        break;
      }
      case "signup":
        // Refuse a closed link or the wrong domain before an account is made for it.
        yield* shares.checkEmailForToken(body.invite, body.email ?? "");
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
    const joined = yield* shares.joinWithToken({ token: body.invite, user });
    const response = json({ user, projectId: joined.projectId });
    return issueCookie
      ? yield* withSessionCookie(yield* issueMemberSession(user))(response)
      : response;
  }).pipe(
    Effect.catchTags({
      ShareError: shareErrorResponse,
      LogicPacksAccessError: accessErrorResponse,
    }),
  ),
);

export const layer = Layer.mergeAll(
  overviewRoute,
  shareRoute,
  resendRoute,
  revokeRoute,
  linkRoute,
  resetLinkRoute,
  joinProjectPageRoute,
  joinProjectRoute,
);
