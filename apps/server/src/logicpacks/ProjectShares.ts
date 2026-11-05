// @effect-diagnostics preferSchemaOverJson:off -- invite zones are the plain JSON of the accessZones.ts value set.
// @effect-diagnostics-next-line nodeBuiltinImport:off -- invite tokens need randomBytes.
import * as NodeCrypto from "node:crypto";

import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { normalizeZones, type ZoneValues } from "@logicpacks/contracts";

import {
  LogicPacksAccess,
  type LogicPacksAccessError,
  type LogicPacksProjectMember,
  type LogicPacksUser,
} from "./LogicPacksAccess.ts";
import { normalizeEmail, normalizeUserReference } from "./projectAccess.ts";
import { ShareMailer, shareInviteMail, type MailResult } from "./shareMail.ts";

/**
 * Pending email invites (become access on any sign-in with that email) and one share link
 * per project. Roles are owner and member only, so invites and links always give member.
 */

export const INVITE_DAYS = 14;
export const LINK_EXPIRY = ["1d", "7d", "never"] as const;
export type LinkExpiry = (typeof LINK_EXPIRY)[number];
const LINK_EXPIRY_DAYS: Record<LinkExpiry, number | null> = { "1d": 1, "7d": 7, never: null };

export class ShareError extends Schema.TaggedError<ShareError>()("ShareError", {
  reason: Schema.Literals([
    "invalid_email",
    "invalid_domain",
    "not_owner",
    "not_found",
    "invite_used",
    "invite_expired",
    "link_off",
    "link_expired",
    "wrong_domain",
    "storage",
  ]),
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

const fail = (reason: ShareError["reason"], message: string) =>
  Effect.fail(new ShareError({ reason, message }));

const storage = (operation: string) => (cause: unknown) =>
  new ShareError({ reason: "storage", message: `Sharing failed during ${operation}.`, cause });

export interface PendingInvite {
  readonly inviteId: string;
  readonly projectId: string;
  readonly email: string;
  readonly role: "member";
  readonly invitedBy: string | null;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly lastSentAt: string;
  readonly token: string;
  /** What the invitee gets on accepting (their override); null follows the project's default. */
  readonly zones: ZoneValues | null;
}

export interface ShareLink {
  readonly enabled: boolean;
  readonly role: "member";
  readonly expiry: LinkExpiry;
  readonly expiresAt: string | null;
  readonly domain: string | null;
  readonly token: string;
}

export interface LinkJoin {
  readonly user: LogicPacksUser;
  readonly joinedAt: string;
}

/** What a token opens, for the join page. */
export type TokenTarget =
  | {
      readonly kind: "invite";
      readonly projectId: string;
      readonly email: string;
      readonly acceptedBy: string | null;
    }
  | { readonly kind: "link"; readonly projectId: string; readonly domain: string | null }
  | { readonly kind: "closed"; readonly reason: ShareError["reason"]; readonly message: string };

export type ShareOutcome =
  | { readonly kind: "member"; readonly member: LogicPacksProjectMember }
  | { readonly kind: "invited"; readonly invite: PendingInvite; readonly mail: MailResult };

/** Context the invite email needs; the HTTP layer knows the project title and the public URL. */
export interface MailContext {
  readonly projectTitle: string;
  /** The absolute URL for a path like /lp/join/project?invite=... */
  readonly absoluteUrl: (path: string) => string;
}

export const projectJoinPath = (token: string) =>
  `/lp/join/project?invite=${encodeURIComponent(token)}`;

export const CLOSED_MESSAGES = {
  not_found: "This invite link is no longer valid. Ask whoever sent it for a new one.",
  invite_used: "This invite has already been used. Ask whoever sent it for a new one.",
  invite_expired: "This invite link has expired. Ask whoever sent it for a new one.",
  link_off: "This link has been turned off. Ask the project owner for a new one.",
  link_expired: "This link has expired. Ask the project owner for a new one.",
} as const;

/** `@acme.com`, `Acme.com` and `acme.com` all mean acme.com. Null when it is not a domain. */
export const normalizeDomain = (raw: string): string | null => {
  const domain = raw.trim().toLowerCase().replace(/^@/, "");
  return /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)
    ? domain
    : null;
};

export const emailDomain = (email: string) => email.split("@")[1]?.toLowerCase() ?? "";

interface InviteRow {
  readonly invite_id: string;
  readonly project_id: string;
  readonly email: string;
  readonly role: "member";
  readonly token: string;
  readonly invited_by: string | null;
  readonly created_at: string;
  readonly expires_at: string;
  readonly last_sent_at: string;
  readonly accepted_by: string | null;
  readonly accepted_at: string | null;
  readonly zones: string | null;
}

interface LinkRow {
  readonly project_id: string;
  readonly token: string;
  readonly enabled: number;
  readonly role: "member";
  readonly expiry: LinkExpiry;
  readonly expires_at: string | null;
  readonly domain: string | null;
}

const parseZones = (raw: string | null | undefined): ZoneValues | null => {
  if (raw === null || raw === undefined || raw.length === 0) return null;
  try {
    return normalizeZones(JSON.parse(raw));
  } catch {
    return null;
  }
};

const toInvite = (row: InviteRow): PendingInvite => ({
  inviteId: row.invite_id,
  projectId: row.project_id,
  email: row.email,
  role: row.role,
  invitedBy: row.invited_by,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
  lastSentAt: row.last_sent_at,
  token: row.token,
  zones: parseZones(row.zones),
});

const toLink = (row: LinkRow): ShareLink => ({
  enabled: row.enabled === 1,
  role: row.role,
  expiry: row.expiry,
  expiresAt: row.expires_at,
  domain: row.domain,
  token: row.token,
});

const newToken = () => NodeCrypto.randomBytes(18).toString("base64url");

export class ProjectShares extends Context.Service<
  ProjectShares,
  {
    /**
     * Shares with an existing account (today's behaviour) or, for an email with no account,
     * creates or refreshes a pending invite and emails it. `actorUserId: null` is the operator.
     */
    readonly share: (input: {
      readonly projectId: string;
      readonly actorUserId: string | null;
      readonly user: string;
      readonly mail: MailContext;
      /** Zones for this person (an override). Omitted: they follow the project's default. */
      readonly zones?: ZoneValues | undefined;
    }) => Effect.Effect<ShareOutcome, ShareError | LogicPacksAccessError>;
    readonly listInvites: (
      projectId: string,
    ) => Effect.Effect<ReadonlyArray<PendingInvite>, ShareError>;
    /** Sends the email again and restarts the invite's expiry. The link stays the same. */
    readonly resendInvite: (input: {
      readonly projectId: string;
      readonly actorUserId: string | null;
      readonly inviteId: string;
      readonly mail: MailContext;
    }) => Effect.Effect<{ invite: PendingInvite; mail: MailResult }, ShareError>;
    readonly revokeInvite: (input: {
      readonly projectId: string;
      readonly actorUserId: string | null;
      readonly inviteId: string;
    }) => Effect.Effect<void, ShareError>;
    /** Turns every open invite for this account's email into access. Called on each sign-in. */
    readonly claimInvites: (
      user: LogicPacksUser,
    ) => Effect.Effect<ReadonlyArray<string>, ShareError | LogicPacksAccessError>;

    /** The project's link, or null before an owner first turns it on. */
    readonly getLink: (projectId: string) => Effect.Effect<ShareLink | null, ShareError>;
    readonly updateLink: (input: {
      readonly projectId: string;
      readonly actorUserId: string | null;
      readonly enabled?: boolean | undefined;
      readonly expiry?: LinkExpiry | undefined;
      /** A domain, or null/"" for anyone. Omitted keeps the current one. */
      readonly domain?: string | null | undefined;
    }) => Effect.Effect<ShareLink, ShareError>;
    /** A new token; the old link stops working. The expiry starts again from now. */
    readonly resetLink: (input: {
      readonly projectId: string;
      readonly actorUserId: string | null;
    }) => Effect.Effect<ShareLink, ShareError>;
    readonly linkJoins: (projectId: string) => Effect.Effect<ReadonlyArray<LinkJoin>, ShareError>;

    /** What a token opens right now. */
    readonly resolveToken: (token: string) => Effect.Effect<TokenTarget, ShareError>;
    /** Checks a link's domain rule against an email before an account is made for it. */
    readonly checkEmailForToken: (token: string, email: string) => Effect.Effect<void, ShareError>;
    /** Accepts an invite or joins through a link. Never lowers an existing role. */
    readonly joinWithToken: (input: {
      readonly token: string;
      readonly user: LogicPacksUser;
    }) => Effect.Effect<{ projectId: string }, ShareError | LogicPacksAccessError>;
  }
>()("logicpacks/logicpacks/ProjectShares") {}

/** Older databases lack the invites' zones column; add it once. */
const ensureInviteZones = (sql: SqlClient.SqlClient) =>
  sql
    .unsafe<{ readonly name: string }>("PRAGMA table_info(logicpacks_project_invites)")
    .pipe(
      Effect.flatMap((columns) =>
        columns.some((column) => column.name === "zones")
          ? Effect.void
          : sql.unsafe("ALTER TABLE logicpacks_project_invites ADD COLUMN zones TEXT").pipe(Effect.asVoid),
      ),
    );

const ensureSchema = (sql: SqlClient.SqlClient) =>
  Effect.all(
    [
      sql`
        CREATE TABLE IF NOT EXISTS logicpacks_project_invites (
          invite_id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          email TEXT NOT NULL,
          role TEXT NOT NULL CHECK (role IN ('member')),
          token TEXT NOT NULL UNIQUE,
          invited_by TEXT,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          last_sent_at TEXT NOT NULL,
          accepted_by TEXT,
          accepted_at TEXT
        )
      `,
      sql`
        CREATE INDEX IF NOT EXISTS logicpacks_project_invites_email
        ON logicpacks_project_invites (email)
      `,
      sql`
        CREATE TABLE IF NOT EXISTS logicpacks_project_links (
          project_id TEXT PRIMARY KEY,
          token TEXT NOT NULL UNIQUE,
          enabled INTEGER NOT NULL,
          role TEXT NOT NULL CHECK (role IN ('member')),
          expiry TEXT NOT NULL CHECK (expiry IN ('1d', '7d', 'never')),
          expires_at TEXT,
          domain TEXT,
          updated_by TEXT,
          updated_at TEXT NOT NULL
        )
      `,
      sql`
        CREATE TABLE IF NOT EXISTS logicpacks_project_link_joins (
          project_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          joined_at TEXT NOT NULL,
          PRIMARY KEY (project_id, user_id)
        )
      `,
    ],
    { discard: true },
  ).pipe(Effect.andThen(ensureInviteZones(sql)));

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const access = yield* LogicPacksAccess;
  const mailer = yield* ShareMailer;
  yield* ensureSchema(sql).pipe(Effect.mapError(storage("schema setup")));

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const nowMs = DateTime.now.pipe(Effect.map(DateTime.toEpochMillis));
  const plusDays = (days: number) =>
    DateTime.now.pipe(Effect.map((now) => DateTime.formatIso(DateTime.add(now, { days }))));
  const isPast = (iso: string | null) =>
    nowMs.pipe(Effect.map((now) => iso !== null && Date.parse(iso) <= now));

  const requireOwner = (projectId: string, actorUserId: string | null) =>
    actorUserId === null || access.roleOf(actorUserId, projectId) === "owner"
      ? Effect.void
      : fail("not_owner", "Only the project owner can change who it is shared with.");

  const inviteRows = (projectId: string) =>
    sql<InviteRow>`
      SELECT * FROM logicpacks_project_invites
      WHERE project_id = ${projectId} AND accepted_by IS NULL
      ORDER BY created_at
    `.pipe(Effect.mapError(storage("listing invites")));

  const inviteById = (projectId: string, inviteId: string) =>
    sql<InviteRow>`
      SELECT * FROM logicpacks_project_invites
      WHERE invite_id = ${inviteId} AND project_id = ${projectId} AND accepted_by IS NULL
    `.pipe(
      Effect.mapError(storage("reading an invite")),
      Effect.flatMap((rows) =>
        rows[0] ? Effect.succeed(rows[0]) : fail("not_found", "That invite is gone."),
      ),
    );

  const linkRow = (projectId: string) =>
    sql<LinkRow>`SELECT * FROM logicpacks_project_links WHERE project_id = ${projectId}`.pipe(
      Effect.map((rows) => rows[0] ?? null),
      Effect.mapError(storage("reading the share link")),
    );

  const inviterName = (actorUserId: string | null) =>
    actorUserId === null
      ? Effect.succeed("Your team")
      : access.getUser(actorUserId).pipe(
          Effect.map((user) => user?.displayName ?? "Someone"),
          Effect.orElseSucceed(() => "Someone"),
        );

  const sendInvite = Effect.fn("ProjectShares.sendInvite")(function* (
    row: InviteRow,
    actorUserId: string | null,
    mail: MailContext,
  ) {
    const name = yield* inviterName(actorUserId ?? row.invited_by);
    return yield* mailer.send(
      shareInviteMail({
        to: row.email,
        inviterName: name,
        projectTitle: mail.projectTitle,
        link: mail.absoluteUrl(projectJoinPath(row.token)),
      }),
    );
  });

  /** Grants member unless they already have a role here (an owner stays an owner). */
  const grant = (projectId: string, user: LogicPacksUser) =>
    access.roleOf(user.userId, projectId) !== null
      ? Effect.void
      : access
          .addMember({ projectId, actorUserId: null, user: user.email, role: "member" })
          .pipe(Effect.asVoid);

  const acceptRow = Effect.fn("ProjectShares.acceptRow")(function* (
    row: InviteRow,
    user: LogicPacksUser,
  ) {
    const had = access.roleOf(user.userId, row.project_id) !== null;
    yield* grant(row.project_id, user);
    // An invite that named zones gives the invitee that override (never to someone who already had a seat).
    const zones = parseZones(row.zones);
    if (!had && zones !== null) {
      yield* access.setMemberZones({
        projectId: row.project_id,
        actorUserId: null,
        userId: user.userId,
        zones,
      });
    }
    const at = yield* nowIso;
    yield* sql`
      UPDATE logicpacks_project_invites
      SET accepted_by = ${user.userId}, accepted_at = ${at}
      WHERE invite_id = ${row.invite_id}
    `.pipe(Effect.mapError(storage("accepting an invite")));
  });

  const resolveToken = Effect.fn("ProjectShares.resolveToken")(function* (token: string) {
    if (token.length === 0) {
      return { kind: "closed", reason: "not_found", message: CLOSED_MESSAGES.not_found } as const;
    }
    const invites = yield* sql<InviteRow>`
      SELECT * FROM logicpacks_project_invites WHERE token = ${token}
    `.pipe(Effect.mapError(storage("reading an invite")));
    const invite = invites[0];
    if (invite) {
      if (invite.accepted_by === null && (yield* isPast(invite.expires_at))) {
        return {
          kind: "closed",
          reason: "invite_expired",
          message: CLOSED_MESSAGES.invite_expired,
        } as const;
      }
      return {
        kind: "invite",
        projectId: invite.project_id,
        email: invite.email,
        acceptedBy: invite.accepted_by,
      } as const;
    }
    const links = yield* sql<LinkRow>`
      SELECT * FROM logicpacks_project_links WHERE token = ${token}
    `.pipe(Effect.mapError(storage("reading the share link")));
    const link = links[0];
    if (!link) {
      return { kind: "closed", reason: "not_found", message: CLOSED_MESSAGES.not_found } as const;
    }
    if (link.enabled !== 1) {
      return { kind: "closed", reason: "link_off", message: CLOSED_MESSAGES.link_off } as const;
    }
    if (yield* isPast(link.expires_at)) {
      return {
        kind: "closed",
        reason: "link_expired",
        message: CLOSED_MESSAGES.link_expired,
      } as const;
    }
    return { kind: "link", projectId: link.project_id, domain: link.domain } as const;
  });

  const domainCheck = (domain: string | null, email: string) =>
    domain === null || emailDomain(email) === domain
      ? Effect.void
      : fail("wrong_domain", `This link only works for emails at ${domain}.`);

  const writeLink = Effect.fn("ProjectShares.writeLink")(function* (
    projectId: string,
    actorUserId: string | null,
    next: Omit<LinkRow, "project_id">,
  ) {
    const at = yield* nowIso;
    yield* sql`
      INSERT INTO logicpacks_project_links
        (project_id, token, enabled, role, expiry, expires_at, domain, updated_by, updated_at)
      VALUES (${projectId}, ${next.token}, ${next.enabled}, ${next.role}, ${next.expiry},
        ${next.expires_at}, ${next.domain}, ${actorUserId}, ${at})
      ON CONFLICT (project_id) DO UPDATE SET
        token = excluded.token, enabled = excluded.enabled, role = excluded.role,
        expiry = excluded.expiry, expires_at = excluded.expires_at, domain = excluded.domain,
        updated_by = excluded.updated_by, updated_at = excluded.updated_at
    `.pipe(Effect.mapError(storage("saving the share link")));
    return toLink({ project_id: projectId, ...next });
  });

  const expiresFor = (expiry: LinkExpiry) => {
    const days = LINK_EXPIRY_DAYS[expiry];
    return days === null ? Effect.succeed(null) : plusDays(days);
  };

  return ProjectShares.of({
    share: Effect.fn("ProjectShares.share")(function* (input) {
      yield* requireOwner(input.projectId, input.actorUserId);
      const reference = normalizeUserReference(input.user);
      if (reference === null) {
        return yield* fail(
          "invalid_email",
          input.user.includes("@")
            ? "That email looks incomplete. Check it and try again."
            : "Use their email address, or a LogicPacks name.",
        );
      }
      // An existing account: today's behaviour.
      const existing = yield* access
        .addMember({
          projectId: input.projectId,
          actorUserId: input.actorUserId,
          user: input.user,
        })
        .pipe(
          Effect.map((member) => member as LogicPacksProjectMember | null),
          Effect.catchIf(
            (error) => error.reason === "unknown_user",
            () => Effect.succeed(null),
          ),
        );
      if (existing !== null) {
        if (input.zones !== undefined && existing.role !== "owner") {
          yield* access.setMemberZones({
            projectId: input.projectId,
            actorUserId: input.actorUserId,
            userId: existing.user.userId,
            zones: input.zones,
          });
        }
        return { kind: "member", member: existing } as const;
      }
      const email = input.user.includes("@") ? normalizeEmail(input.user) : null;
      if (email === null) {
        return yield* fail(
          "invalid_email",
          `No one is called ${input.user.trim()} yet. Use their email to invite them.`,
        );
      }
      const at = yield* nowIso;
      const expiresAt = yield* plusDays(INVITE_DAYS);
      const current = yield* sql<InviteRow>`
        SELECT * FROM logicpacks_project_invites
        WHERE project_id = ${input.projectId} AND email = ${email} AND accepted_by IS NULL
      `.pipe(Effect.mapError(storage("reading an invite")));
      let row: InviteRow;
      if (current[0]) {
        const zonesJson =
          input.zones === undefined ? current[0].zones : JSON.stringify(normalizeZones(input.zones));
        row = { ...current[0], expires_at: expiresAt, last_sent_at: at, zones: zonesJson };
        yield* sql`
          UPDATE logicpacks_project_invites
          SET expires_at = ${expiresAt}, last_sent_at = ${at}, zones = ${zonesJson}
          WHERE invite_id = ${row.invite_id}
        `.pipe(Effect.mapError(storage("refreshing an invite")));
      } else {
        row = {
          invite_id: NodeCrypto.randomUUID(),
          project_id: input.projectId,
          email,
          role: "member",
          token: newToken(),
          invited_by: input.actorUserId,
          created_at: at,
          expires_at: expiresAt,
          last_sent_at: at,
          accepted_by: null,
          accepted_at: null,
          zones: input.zones === undefined ? null : JSON.stringify(normalizeZones(input.zones)),
        };
        yield* sql`
          INSERT INTO logicpacks_project_invites
            (invite_id, project_id, email, role, token, invited_by, created_at, expires_at, last_sent_at, zones)
          VALUES (${row.invite_id}, ${row.project_id}, ${row.email}, ${row.role}, ${row.token},
            ${row.invited_by}, ${row.created_at}, ${row.expires_at}, ${row.last_sent_at}, ${row.zones})
        `.pipe(Effect.mapError(storage("creating an invite")));
      }
      const mail = yield* sendInvite(row, input.actorUserId, input.mail);
      return { kind: "invited", invite: toInvite(row), mail } as const;
    }),
    listInvites: Effect.fn("ProjectShares.listInvites")(function* (projectId) {
      return (yield* inviteRows(projectId)).map(toInvite);
    }),
    resendInvite: Effect.fn("ProjectShares.resendInvite")(function* (input) {
      yield* requireOwner(input.projectId, input.actorUserId);
      const current = yield* inviteById(input.projectId, input.inviteId);
      const at = yield* nowIso;
      const row = { ...current, expires_at: yield* plusDays(INVITE_DAYS), last_sent_at: at };
      yield* sql`
        UPDATE logicpacks_project_invites
        SET expires_at = ${row.expires_at}, last_sent_at = ${at}
        WHERE invite_id = ${row.invite_id}
      `.pipe(Effect.mapError(storage("resending an invite")));
      const mail = yield* sendInvite(row, input.actorUserId, input.mail);
      return { invite: toInvite(row), mail };
    }),
    revokeInvite: Effect.fn("ProjectShares.revokeInvite")(function* (input) {
      yield* requireOwner(input.projectId, input.actorUserId);
      yield* sql`
        DELETE FROM logicpacks_project_invites
        WHERE invite_id = ${input.inviteId} AND project_id = ${input.projectId}
          AND accepted_by IS NULL
      `.pipe(Effect.mapError(storage("revoking an invite")));
    }),
    claimInvites: Effect.fn("ProjectShares.claimInvites")(function* (user) {
      const email = user.email.toLowerCase();
      const at = yield* nowIso;
      const rows = yield* sql<InviteRow>`
        SELECT * FROM logicpacks_project_invites
        WHERE email = ${email} AND accepted_by IS NULL AND expires_at > ${at}
      `.pipe(Effect.mapError(storage("reading invites")));
      for (const row of rows) yield* acceptRow(row, user);
      return rows.map((row) => row.project_id);
    }),
    getLink: Effect.fn("ProjectShares.getLink")(function* (projectId) {
      const row = yield* linkRow(projectId);
      return row === null ? null : toLink(row);
    }),
    updateLink: Effect.fn("ProjectShares.updateLink")(function* (input) {
      yield* requireOwner(input.projectId, input.actorUserId);
      const current = yield* linkRow(input.projectId);
      let domain = current?.domain ?? null;
      if (input.domain !== undefined) {
        if (input.domain === null || input.domain.trim().length === 0) domain = null;
        else {
          const normalized = normalizeDomain(input.domain);
          if (normalized === null) {
            return yield* fail("invalid_domain", "Enter a domain like acme.com.");
          }
          domain = normalized;
        }
      }
      const expiry = input.expiry ?? current?.expiry ?? "7d";
      const enabled = input.enabled ?? current?.enabled === 1;
      // The clock restarts when the link is turned on or its expiry changes.
      const restart =
        current === null ||
        (input.expiry !== undefined && input.expiry !== current.expiry) ||
        (enabled && current.enabled !== 1);
      return yield* writeLink(input.projectId, input.actorUserId, {
        token: current?.token ?? newToken(),
        enabled: enabled ? 1 : 0,
        role: "member",
        expiry,
        expires_at: restart ? yield* expiresFor(expiry) : (current?.expires_at ?? null),
        domain,
      });
    }),
    resetLink: Effect.fn("ProjectShares.resetLink")(function* (input) {
      yield* requireOwner(input.projectId, input.actorUserId);
      const current = yield* linkRow(input.projectId);
      const expiry = current?.expiry ?? "7d";
      return yield* writeLink(input.projectId, input.actorUserId, {
        token: newToken(),
        enabled: current?.enabled ?? 1,
        role: "member",
        expiry,
        expires_at: yield* expiresFor(expiry),
        domain: current?.domain ?? null,
      });
    }),
    linkJoins: Effect.fn("ProjectShares.linkJoins")(function* (projectId) {
      const rows = yield* sql<{ readonly user_id: string; readonly joined_at: string }>`
        SELECT user_id, joined_at FROM logicpacks_project_link_joins
        WHERE project_id = ${projectId} ORDER BY joined_at DESC
      `.pipe(Effect.mapError(storage("listing link joins")));
      const result: Array<LinkJoin> = [];
      for (const row of rows) {
        const user = yield* access.getUser(row.user_id).pipe(Effect.orElseSucceed(() => null));
        if (user) result.push({ user, joinedAt: row.joined_at });
      }
      return result;
    }),
    resolveToken,
    checkEmailForToken: Effect.fn("ProjectShares.checkEmailForToken")(function* (token, email) {
      const target = yield* resolveToken(token);
      if (target.kind === "closed") return yield* fail(target.reason, target.message);
      if (target.kind === "link") yield* domainCheck(target.domain, email);
    }),
    joinWithToken: Effect.fn("ProjectShares.joinWithToken")(function* (input) {
      const target = yield* resolveToken(input.token);
      if (target.kind === "closed") return yield* fail(target.reason, target.message);
      if (target.kind === "invite") {
        if (target.acceptedBy !== null) {
          // Opening an accepted invite again is fine for the person who accepted it.
          if (access.roleOf(input.user.userId, target.projectId) !== null) {
            return { projectId: target.projectId };
          }
          return yield* fail("invite_used", CLOSED_MESSAGES.invite_used);
        }
        const rows = yield* sql<InviteRow>`
          SELECT * FROM logicpacks_project_invites WHERE token = ${input.token}
        `.pipe(Effect.mapError(storage("reading an invite")));
        // The link belongs to whoever opens it first, even under another email.
        if (rows[0]) yield* acceptRow(rows[0], input.user);
        return { projectId: target.projectId };
      }
      yield* domainCheck(target.domain, input.user.email);
      const already = access.roleOf(input.user.userId, target.projectId) !== null;
      yield* grant(target.projectId, input.user);
      if (!already) {
        const at = yield* nowIso;
        yield* sql`
          INSERT INTO logicpacks_project_link_joins (project_id, user_id, joined_at)
          VALUES (${target.projectId}, ${input.user.userId}, ${at})
          ON CONFLICT (project_id, user_id) DO NOTHING
        `.pipe(Effect.mapError(storage("recording a link join")));
      }
      return { projectId: target.projectId };
    }),
  });
});

export const layer = Layer.effect(ProjectShares, make);

/**
 * Account deletion: invites this user sent, invites to their email or accepted by them, and
 * their link joins. Links they last edited stay (the edit stamp is cleared). ProjectShares
 * keeps nothing in memory, so this works on the tables directly. With `dryRun` only counts.
 */
export const forgetShareUser = Effect.fn("ProjectShares.forgetShareUser")(function* (
  user: { readonly userId: string; readonly email: string | null },
  options: { readonly dryRun?: boolean } = {},
) {
  const sql = yield* SqlClient.SqlClient;
  yield* ensureSchema(sql).pipe(Effect.mapError(storage("schema setup")));
  const email = user.email ?? "";
  const invites = yield* sql<{ readonly n: number }>`
    SELECT COUNT(*) AS n FROM logicpacks_project_invites
    WHERE invited_by = ${user.userId} OR accepted_by = ${user.userId} OR email = ${email}
  `.pipe(Effect.mapError(storage("counting invites")));
  const joins = yield* sql<{ readonly n: number }>`
    SELECT COUNT(*) AS n FROM logicpacks_project_link_joins WHERE user_id = ${user.userId}
  `.pipe(Effect.mapError(storage("counting link joins")));
  if (options.dryRun !== true) {
    yield* sql
      .withTransaction(
        Effect.all(
          [
            sql`
              DELETE FROM logicpacks_project_invites
              WHERE invited_by = ${user.userId} OR accepted_by = ${user.userId} OR email = ${email}
            `,
            sql`DELETE FROM logicpacks_project_link_joins WHERE user_id = ${user.userId}`,
            sql`UPDATE logicpacks_project_links SET updated_by = NULL WHERE updated_by = ${user.userId}`,
          ],
          { discard: true },
        ),
      )
      .pipe(Effect.mapError(storage("forgetting a user's shares")));
  }
  return { invites: Number(invites[0]?.n ?? 0), linkJoins: Number(joins[0]?.n ?? 0) };
});

/** A deleted project's invites, share link and link joins. With `dryRun` only counts. */
export const forgetShareProject = Effect.fn("ProjectShares.forgetShareProject")(function* (
  projectId: string,
  options: { readonly dryRun?: boolean } = {},
) {
  const sql = yield* SqlClient.SqlClient;
  yield* ensureSchema(sql).pipe(Effect.mapError(storage("schema setup")));
  const counts: Record<string, number> = {};
  for (const table of [
    "logicpacks_project_invites",
    "logicpacks_project_links",
    "logicpacks_project_link_joins",
  ]) {
    const found = yield* sql
      .unsafe<{ readonly n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ?`, [
        projectId,
      ])
      .pipe(Effect.mapError(storage("counting project shares")));
    counts[table] = Number(found[0]?.n ?? 0);
    if (options.dryRun !== true) {
      yield* sql
        .unsafe(`DELETE FROM ${table} WHERE project_id = ?`, [projectId])
        .pipe(Effect.mapError(storage("forgetting project shares")));
    }
  }
  return counts;
});
