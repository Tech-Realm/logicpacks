// @effect-diagnostics preferSchemaOverJson:off -- zone rows hold the plain JSON of the accessZones.ts value set.
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no scrypt or timingSafeEqual.
import * as NodeCrypto from "node:crypto";

import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { closeMemberSockets } from "./memberSockets.ts";
import { memberSandboxSupported } from "./folderSandbox.ts";
import { memberSandboxEnabled } from "./memberSandbox.ts";

import {
  ACCESS_AGENTS,
  agentLimitsFor,
  canCompute,
  canManageProjects,
  canMutate,
  normalizeZones,
  resolveZones,
  resolvedFromValues,
  zonesForPreset,
  type ResolvedZones,
  type ZoneValues,
} from "@logicpacks/contracts";

import { installHostWriteGuard, installRunLimiter } from "./runLimits.ts";
import {
  MIN_PASSWORD_LENGTH,
  normalizeEmail,
  normalizeQuickLoginName,
  normalizeUserReference,
  quickLoginEmail,
  type ProjectRole,
} from "./projectAccess.ts";

export interface LogicPacksUser {
  readonly userId: string;
  readonly email: string;
  readonly displayName: string;
  readonly createdAt: string;
}

export interface LogicPacksProjectMember {
  readonly user: LogicPacksUser;
  readonly role: ProjectRole;
}

/** `viewer` is "Read only": it sees everything and changes nothing. Stored beside the CHECKed role. */
export type WorkspaceRole = "owner" | "member" | "viewer";

/** What roleOf answers: a project role, or `viewer` through a read-only workspace seat. */
export type EffectiveRole = ProjectRole | "viewer";

/** One row of the project's access trail: who did what with the host's agent, files or terminal. */
export interface AccessLogEntry {
  readonly id: string;
  readonly atMs: number;
  readonly projectId: string | null;
  /** The member the entry is about; null for the host. */
  readonly userId: string | null;
  readonly kind: string;
  readonly detail: string;
}

/** A member asking the host for the AI or Compute zone; the host decides. */
export interface AccessRequest {
  readonly id: string;
  readonly projectId: string;
  readonly userId: string;
  readonly zone: "ai" | "compute";
  readonly status: "open" | "allowed" | "denied";
  readonly createdAtMs: number;
  readonly decidedAtMs: number | null;
}

export type OnboardingChoice = "pro" | "beginner" | "skipped";
export const isOnboardingChoice = (value: unknown): value is OnboardingChoice =>
  value === "pro" || value === "beginner" || value === "skipped";

export interface LogicPacksWorkspace {
  readonly workspaceId: string;
  readonly name: string;
  /** The caller's role; the host operator manages every workspace. */
  readonly role: WorkspaceRole | "operator";
  readonly memberCount: number;
  readonly projectIds: ReadonlyArray<string>;
}

export interface LogicPacksWorkspaceMember {
  readonly user: LogicPacksUser;
  readonly role: WorkspaceRole;
}

export class LogicPacksAccessError extends Schema.TaggedError<LogicPacksAccessError>()(
  "LogicPacksAccessError",
  {
    reason: Schema.Literals([
      "invalid_email",
      "invalid_name",
      "weak_password",
      "email_taken",
      "invalid_credentials",
      "unknown_user",
      "not_owner",
      "read_only",
      "last_owner",
      "unknown_workspace",
      "invalid_workspace_name",
      "invalid_invite",
      "email_unverified",
      "signup_closed",
      "storage",
    ]),
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const fail = (reason: LogicPacksAccessError["reason"], message: string) =>
  Effect.fail(new LogicPacksAccessError({ reason, message }));

const storage = (operation: string) => (cause: unknown) =>
  new LogicPacksAccessError({
    reason: "storage",
    message: `LogicPacks access storage failed during ${operation}.`,
    cause,
  });

/** The operator's row in logicpacks_current_workspace; members are keyed by user id. */
const OPERATOR_VIEWER = "operator";

const SCRYPT_COST = 16384;
const SCRYPT_KEY_LENGTH = 32;

const scrypt = (password: string, salt: Buffer, cost: number) =>
  Effect.callback<Buffer, LogicPacksAccessError>((resume) => {
    NodeCrypto.scrypt(
      password,
      salt,
      SCRYPT_KEY_LENGTH,
      { N: cost, maxmem: 64 * 1024 * 1024 },
      (error, key) => {
        resume(error ? Effect.fail(storage("password hashing")(error)) : Effect.succeed(key));
      },
    );
  });

export const hashPassword = Effect.fn("LogicPacksAccess.hashPassword")(function* (
  password: string,
) {
  const salt = NodeCrypto.randomBytes(16);
  const key = yield* scrypt(password, salt, SCRYPT_COST);
  return `scrypt$${SCRYPT_COST}$${salt.toString("base64")}$${key.toString("base64")}`;
});

export const verifyPassword = Effect.fn("LogicPacksAccess.verifyPassword")(function* (
  password: string,
  stored: string,
) {
  const [scheme, costText, saltText, keyText] = stored.split("$");
  const cost = Number(costText);
  if (scheme !== "scrypt" || !Number.isInteger(cost) || !saltText || !keyText) return false;
  const expected = Buffer.from(keyText, "base64");
  const actual = yield* scrypt(password, Buffer.from(saltText, "base64"), cost);
  return expected.length === actual.length && NodeCrypto.timingSafeEqual(expected, actual);
});

interface UserRow {
  readonly user_id: string;
  readonly email: string;
  readonly display_name: string;
  readonly password_hash: string | null;
  readonly created_at: string;
}

interface AccessRow {
  readonly project_id: string;
  readonly user_id: string;
  readonly role: ProjectRole;
}

const toUser = (row: UserRow): LogicPacksUser => ({
  userId: row.user_id,
  email: row.email,
  displayName: row.display_name,
  createdAt: row.created_at,
});

const displayNameFromEmail = (email: string) => {
  const local = email.split("@")[0] ?? email;
  return local.length === 0 ? email : local[0]!.toUpperCase() + local.slice(1);
};

export class LogicPacksAccess extends Context.Service<
  LogicPacksAccess,
  {
    readonly signUp: (input: {
      readonly email: string;
      readonly password: string;
      readonly displayName?: string | undefined;
    }) => Effect.Effect<LogicPacksUser, LogicPacksAccessError>;
    readonly logIn: (input: {
      readonly email: string;
      readonly password: string;
    }) => Effect.Effect<LogicPacksUser, LogicPacksAccessError>;
    /**
     * Sign in with Google or GitHub. A known (provider, subject) signs in; otherwise a
     * provider-verified email links to the member who owns it, or creates one when
     * `allowSignup` (the host's LOGICPACKS_SIGNUP rule) lets it. Unverified emails never
     * link or create.
     */
    readonly signInWithIdentity: (input: {
      readonly provider: string;
      readonly subject: string;
      readonly email: string | null;
      readonly emailVerified: boolean;
      readonly displayName?: string | null | undefined;
      readonly allowSignup: boolean;
    }) => Effect.Effect<
      { readonly user: LogicPacksUser; readonly created: boolean; readonly linked: boolean },
      LogicPacksAccessError
    >;
    /** How the member said they work on first run; null until they answer or skip. */
    readonly onboardingChoice: (userId: string) => OnboardingChoice | null;
    readonly setOnboardingChoice: (
      userId: string,
      choice: OnboardingChoice,
    ) => Effect.Effect<void, LogicPacksAccessError>;
    /** Finds or creates `<name>@logicpacks.internal`. Only reachable when the host enables it. */
    readonly quickLogin: (name: string) => Effect.Effect<LogicPacksUser, LogicPacksAccessError>;
    readonly getUser: (
      userId: string,
    ) => Effect.Effect<LogicPacksUser | null, LogicPacksAccessError>;
    readonly listUsers: () => Effect.Effect<ReadonlyArray<LogicPacksUser>, LogicPacksAccessError>;
    /** Synchronous so stream filters can call it per item. */
    readonly roleOf: (userId: string, projectId: string) => EffectiveRole | null;
    /**
     * True when the user may only read where this command lands: the project's workspace, or
     * their current workspace when no project is named. Owners of the project are never read only.
     */
    readonly isReadOnly: (userId: string, projectId: string | null) => boolean;
    /**
     * What this person may do in the project: the one permission model (access zones).
     * Owner > Read only workspace seat > their override > the project's default (the share
     * link's setting) > Can edit. Synchronous: the RPC fence and every route ask per call.
     * With no project, the current workspace's seat decides (Read only) or Can edit.
     */
    readonly zonesOf: (userId: string, projectId: string | null) => ResolvedZones;
    /**
     * May this person create projects (and workspaces) on this host? True on a cloud host (every
     * account has its own space there), for everyone who held access before the Projects zone
     * existed (grandfathered), and for anyone whose zones in a project they can see turn Projects on.
     */
    readonly canCreateProjects: (userId: string) => boolean;
    /**
     * The workspace a project this person creates joins. On a host that is someone's own computer
     * it is the workspace they were shared into (the host's), so the host can see and remove it;
     * on a cloud host, or with nothing shared, their current workspace.
     */
    readonly creationWorkspaceId: (userId: string | null) => string | null;
    /** The project's default for everyone without an override; null clears it (back to Can edit). */
    readonly setProjectZones: (input: {
      readonly projectId: string;
      readonly actorUserId: string | null;
      readonly zones: ZoneValues | null;
    }) => Effect.Effect<void, LogicPacksAccessError>;
    /** One person's override on one project; null clears it (they follow the default again). */
    readonly setMemberZones: (input: {
      readonly projectId: string;
      readonly actorUserId: string | null;
      readonly userId: string;
      readonly zones: ZoneValues | null;
    }) => Effect.Effect<void, LogicPacksAccessError>;
    /** The project's default and every override, raw, for the Share dialog. */
    readonly zoneSettings: (projectId: string) => {
      readonly projectDefault: ZoneValues | null;
      readonly overrides: ReadonlyMap<string, ZoneValues>;
    };
    /**
     * Called after any zone change (project default, override, seat, removal) with the project
     * and, when one person's access changed, who. Live streams and terminals re-check on it.
     */
    readonly onZonesChanged: (
      listener: (change: { readonly projectId: string; readonly userId: string | null }) => void,
    ) => () => void;
    /**
     * The access trail (terminal sessions, requests, zone changes). Shown to the project's owner
     * and kept per project; best effort, never fails the call it records.
     */
    readonly logAccess: (entry: {
      readonly projectId: string | null;
      readonly userId: string | null;
      readonly kind: string;
      readonly detail: string;
    }) => Effect.Effect<void>;
    readonly accessLog: (projectId: string, limit?: number) => ReadonlyArray<AccessLogEntry>;
    /** A member asks for the AI or Compute zone. A second ask while one is open returns it. */
    readonly requestAccess: (input: {
      readonly projectId: string;
      readonly userId: string;
      readonly zone: "ai" | "compute";
    }) => Effect.Effect<AccessRequest, LogicPacksAccessError>;
    readonly accessRequests: (projectId: string) => ReadonlyArray<AccessRequest>;
    /** The owner allows or denies. Allow turns that zone on for the person (an override). */
    readonly decideAccess: (input: {
      readonly projectId: string;
      readonly actorUserId: string | null;
      readonly requestId: string;
      readonly decision: "allow" | "deny";
    }) => Effect.Effect<AccessRequest, LogicPacksAccessError>;
    readonly visibleProjectIds: (userId: string) => ReadonlySet<string>;
    readonly recordOwner: (
      projectId: string,
      userId: string,
    ) => Effect.Effect<void, LogicPacksAccessError>;
    readonly listMembers: (
      projectId: string,
    ) => Effect.Effect<ReadonlyArray<LogicPacksProjectMember>, LogicPacksAccessError>;
    /** `actorUserId: null` is the host operator, who may share any project. */
    readonly addMember: (input: {
      readonly projectId: string;
      readonly actorUserId: string | null;
      readonly user: string;
      readonly role?: ProjectRole | undefined;
    }) => Effect.Effect<LogicPacksProjectMember, LogicPacksAccessError>;
    /** Projects Sync imported onto this host; the host keeps their checkouts following GitHub. */
    readonly markSynced: (
      projectId: string,
      remoteUrl: string,
    ) => Effect.Effect<void, LogicPacksAccessError>;
    readonly isSynced: (projectId: string) => boolean;
    /**
     * The member whose own GitHub connection a synced project pushes with; null means the
     * host's account. Set by whoever synced or cloned it with their GitHub connected.
     */
    readonly syncPusher: (projectId: string) => string | null;
    readonly setSyncPusher: (
      projectId: string,
      userId: string | null,
    ) => Effect.Effect<void, LogicPacksAccessError>;
    readonly syncedProjectIds: () => ReadonlySet<string>;
    readonly removeMember: (input: {
      readonly projectId: string;
      readonly actorUserId: string | null;
      readonly userId: string;
    }) => Effect.Effect<void, LogicPacksAccessError>;

    // Workspaces. Every account starts with its own; projects belong to at most one, and
    // everyone in a workspace works in all of its projects. `actorUserId: null` is the operator.
    readonly createWorkspace: (input: {
      readonly actorUserId: string | null;
      readonly name: string;
    }) => Effect.Effect<LogicPacksWorkspace, LogicPacksAccessError>;
    readonly renameWorkspace: (input: {
      readonly actorUserId: string | null;
      readonly workspaceId: string;
      readonly name: string;
    }) => Effect.Effect<void, LogicPacksAccessError>;
    /** Projects stay on the host; only the workspace, its members and its invite go. */
    readonly deleteWorkspace: (input: {
      readonly actorUserId: string | null;
      readonly workspaceId: string;
    }) => Effect.Effect<void, LogicPacksAccessError>;
    readonly listWorkspaces: (actorUserId: string | null) => ReadonlyArray<LogicPacksWorkspace>;
    /** The workspace the caller is looking at, or null for the operator's whole-host view. */
    readonly currentWorkspaceId: (actorUserId: string | null) => string | null;
    readonly setCurrentWorkspace: (input: {
      readonly actorUserId: string | null;
      readonly workspaceId: string | null;
    }) => Effect.Effect<void, LogicPacksAccessError>;
    readonly listWorkspaceMembers: (input: {
      readonly actorUserId: string | null;
      readonly workspaceId: string;
    }) => Effect.Effect<ReadonlyArray<LogicPacksWorkspaceMember>, LogicPacksAccessError>;
    /** Adds someone who already has an account, by email or LogicPacks name. */
    readonly addWorkspaceMember: (input: {
      readonly actorUserId: string | null;
      readonly workspaceId: string;
      readonly user: string;
      readonly role?: WorkspaceRole | undefined;
    }) => Effect.Effect<LogicPacksWorkspaceMember, LogicPacksAccessError>;
    readonly setWorkspaceRole: (input: {
      readonly actorUserId: string | null;
      readonly workspaceId: string;
      readonly userId: string;
      readonly role: WorkspaceRole;
    }) => Effect.Effect<void, LogicPacksAccessError>;
    /** Revoke (owner) or leave (self). Also drops their direct access to the workspace's projects. */
    readonly removeWorkspaceMember: (input: {
      readonly actorUserId: string | null;
      readonly workspaceId: string;
      readonly userId: string;
    }) => Effect.Effect<void, LogicPacksAccessError>;
    /** The workspace's one invite link token, created on first ask. Any member may share it. */
    readonly inviteToken: (input: {
      readonly actorUserId: string | null;
      readonly workspaceId: string;
    }) => Effect.Effect<string, LogicPacksAccessError>;
    readonly resetInvite: (input: {
      readonly actorUserId: string | null;
      readonly workspaceId: string;
    }) => Effect.Effect<string, LogicPacksAccessError>;
    readonly workspaceForInvite: (
      token: string,
    ) => { readonly workspaceId: string; readonly name: string } | null;
    /** Joins with the invite's default role and makes the workspace current. */
    readonly joinWithInvite: (input: {
      readonly token: string;
      readonly userId: string;
    }) => Effect.Effect<LogicPacksWorkspace, LogicPacksAccessError>;
    readonly attachProject: (
      projectId: string,
      workspaceId: string,
    ) => Effect.Effect<void, LogicPacksAccessError>;
    readonly projectWorkspaceId: (projectId: string) => string | null;
    /**
     * Whether a project shows in the caller's current view: the current workspace's
     * projects plus anything shared with them directly from outside their workspaces.
     * The operator with no current workspace sees the whole host.
     */
    readonly inView: (actorUserId: string | null, projectId: string) => boolean;

    // Account deletion (the `admin delete-user` CLI). No ownership checks: the caller decides
    // what happens to shared workspaces and projects first (deleteMember.ts).
    /** Who created a workspace: a user id, null for the operator, undefined when it is gone. */
    readonly workspaceCreator: (workspaceId: string) => Effect.Effect<string | null | undefined>;
    /** Every row that names this user, the account row last. Counts what went. */
    readonly forgetUser: (
      userId: string,
    ) => Effect.Effect<Readonly<Record<string, number>>, LogicPacksAccessError>;
    /** Every row that names this project (shares, its workspace slot, sync state). */
    readonly forgetProject: (
      projectId: string,
    ) => Effect.Effect<Readonly<Record<string, number>>, LogicPacksAccessError>;
  }
>()("logicpacks/logicpacks/LogicPacksAccess") {}

/** Kept outside upstream's numbered migrations so upstream merges never collide with these tables. */
const ensureSchema = (sql: SqlClient.SqlClient) =>
  Effect.all(
    [
      sql`
        CREATE TABLE IF NOT EXISTS logicpacks_users (
          user_id TEXT PRIMARY KEY,
          email TEXT NOT NULL UNIQUE,
          display_name TEXT NOT NULL,
          password_hash TEXT,
          created_at TEXT NOT NULL
        )
      `,
      sql`
        CREATE TABLE IF NOT EXISTS logicpacks_project_access (
          project_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
          added_by TEXT,
          created_at TEXT NOT NULL,
          PRIMARY KEY (project_id, user_id)
        )
      `,
      sql`
        CREATE TABLE IF NOT EXISTS logicpacks_synced_projects (
          project_id TEXT PRIMARY KEY,
          remote_url TEXT NOT NULL,
          synced_at TEXT NOT NULL
        )
      `,
      sql`
        CREATE TABLE IF NOT EXISTS logicpacks_workspaces (
          workspace_id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          created_by TEXT,
          created_at TEXT NOT NULL
        )
      `,
      sql`
        CREATE TABLE IF NOT EXISTS logicpacks_workspace_members (
          workspace_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
          added_by TEXT,
          created_at TEXT NOT NULL,
          PRIMARY KEY (workspace_id, user_id)
        )
      `,
      // Read-only seats. The members table's CHECK cannot be widened in place, so a viewer is a
      // 'member' row there plus a row here.
      sql`
        CREATE TABLE IF NOT EXISTS logicpacks_workspace_readonly (
          workspace_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          PRIMARY KEY (workspace_id, user_id)
        )
      `,
      sql`
        CREATE TABLE IF NOT EXISTS logicpacks_workspace_projects (
          project_id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          added_at TEXT NOT NULL
        )
      `,
      sql`
        CREATE TABLE IF NOT EXISTS logicpacks_workspace_invites (
          workspace_id TEXT PRIMARY KEY,
          token TEXT NOT NULL UNIQUE,
          role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
          created_by TEXT,
          created_at TEXT NOT NULL
        )
      `,
      sql`
        CREATE TABLE IF NOT EXISTS logicpacks_sync_pushers (
          project_id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          set_at TEXT NOT NULL
        )
      `,
      sql`
        CREATE TABLE IF NOT EXISTS logicpacks_user_identities (
          provider TEXT NOT NULL,
          subject TEXT NOT NULL,
          user_id TEXT NOT NULL,
          email TEXT,
          created_at TEXT NOT NULL,
          PRIMARY KEY (provider, subject)
        )
      `,
      sql`
        CREATE TABLE IF NOT EXISTS logicpacks_member_onboarding (
          user_id TEXT PRIMARY KEY,
          choice TEXT NOT NULL CHECK (choice IN ('pro', 'beginner', 'skipped')),
          decided_at TEXT NOT NULL
        )
      `,
      // Access zones. user_id '*' is the project's default (the share link's setting).
      sql`
        CREATE TABLE IF NOT EXISTS logicpacks_project_zones (
          project_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          zones TEXT NOT NULL,
          updated_by TEXT,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (project_id, user_id)
        )
      `,
      // Accounts that existed when the Projects zone arrived keep what they could do.
      sql`CREATE TABLE IF NOT EXISTS logicpacks_zone_migrations (name TEXT PRIMARY KEY)`,
      sql`CREATE TABLE IF NOT EXISTS logicpacks_projects_grandfathered (user_id TEXT PRIMARY KEY)`,
      sql`
        CREATE TABLE IF NOT EXISTS logicpacks_access_log (
          id TEXT PRIMARY KEY,
          at_ms INTEGER NOT NULL,
          project_id TEXT,
          user_id TEXT,
          kind TEXT NOT NULL,
          detail TEXT NOT NULL
        )
      `,
      sql`
        CREATE TABLE IF NOT EXISTS logicpacks_access_requests (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          zone TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at_ms INTEGER NOT NULL,
          decided_at_ms INTEGER
        )
      `,
      sql`
        CREATE TABLE IF NOT EXISTS logicpacks_current_workspace (
          viewer TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL
        )
      `,
    ],
    { discard: true },
  );

/**
 * A stored row from before the Projects zone has no `projects.create` key: those people could
 * create projects, so the missing value reads as On (never Off). New rows always carry it.
 */
const parseZoneRow = (raw: string): ZoneValues | null => {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const legacy =
      parsed !== null && typeof parsed === "object"
        ? {
            ...parsed,
            // A seat saved before the Projects zone kept creating projects.
            ...("projects.create" in parsed ? {} : { "projects.create": "on" }),
            // A seat saved before the Compute mode ran terminals as the host's user: it stays that
            // way (Unrestricted) until the host changes it. New seats default to Sandboxed.
            ...("compute.mode" in parsed || parsed["compute.terminal"] !== "on"
              ? {}
              : { "compute.mode": "unrestricted" }),
          }
        : parsed;
    return normalizeZones(legacy);
  } catch {
    return null;
  }
};

/** The OS can confine a member here: macOS Seatbelt, or the cloud host's per-member Unix users. */
const sandboxPossible = () => memberSandboxSupported() || memberSandboxEnabled();

const PROJECTS_ZONE_MIGRATION = "projects-zone-v1";

/**
 * Once, when the Projects zone first runs: every account that exists now is grandfathered (treated
 * as granted), so nothing a member could do before stops working. Accounts made later start with
 * the zone off. Exported so a test can replay it against a database that already has members.
 */
export const migrateProjectsZone = Effect.fn("LogicPacksAccess.migrateProjectsZone")(function* (
  sql: SqlClient.SqlClient,
) {
  return yield* Effect.gen(function* () {
    const done = yield* sql<{ readonly name: string }>`
      SELECT name FROM logicpacks_zone_migrations WHERE name = ${PROJECTS_ZONE_MIGRATION}
    `;
    if (done.length > 0) return false;
    yield* sql`
      INSERT OR IGNORE INTO logicpacks_projects_grandfathered (user_id)
      SELECT user_id FROM logicpacks_users
    `;
    yield* sql`INSERT INTO logicpacks_zone_migrations (name) VALUES (${PROJECTS_ZONE_MIGRATION})`;
    return true;
  }).pipe(Effect.mapError(storage("migrating the Projects zone")));
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* ensureSchema(sql).pipe(Effect.mapError(storage("schema setup")));
  yield* migrateProjectsZone(sql);
  const grandfathered = new Set(
    (yield* sql<{ readonly user_id: string }>`
      SELECT user_id FROM logicpacks_projects_grandfathered
    `.pipe(Effect.mapError(storage("loading grandfathered accounts")))).map((row) => row.user_id),
  );

  // project -> user -> role. One server process owns the database, so the cache is authoritative.
  const access = new Map<string, Map<string, ProjectRole>>();
  const rows = yield* sql<AccessRow>`
    SELECT project_id, user_id, role FROM logicpacks_project_access
  `.pipe(Effect.mapError(storage("loading project access")));
  for (const row of rows) {
    const members = access.get(row.project_id) ?? new Map<string, ProjectRole>();
    members.set(row.user_id, row.role);
    access.set(row.project_id, members);
  }

  // project -> user (or "*" for the project default) -> zone values.
  const ZONE_DEFAULT_KEY = "*";
  const zoneRows = new Map<string, Map<string, ZoneValues>>();
  for (const row of yield* sql<{
    readonly project_id: string;
    readonly user_id: string;
    readonly zones: string;
  }>`SELECT project_id, user_id, zones FROM logicpacks_project_zones`.pipe(
    Effect.mapError(storage("loading access zones")),
  )) {
    // A row that does not parse is skipped: the person falls to the default, never to more.
    const parsed = parseZoneRow(row.zones);
    if (parsed === null) continue;
    const rows = zoneRows.get(row.project_id) ?? new Map<string, ZoneValues>();
    rows.set(row.user_id, parsed);
    zoneRows.set(row.project_id, rows);
  }
  const zoneListeners = new Set<
    (change: { readonly projectId: string; readonly userId: string | null }) => void
  >();
  const emitZones = (projectId: string, userId: string | null) => {
    for (const listener of zoneListeners) {
      try {
        listener({ projectId, userId });
      } catch {
        // A listener must never break a settings change.
      }
    }
  };

  const requestRows = new Map<string, AccessRequest>();
  for (const row of yield* sql<{
    readonly id: string;
    readonly project_id: string;
    readonly user_id: string;
    readonly zone: "ai" | "compute";
    readonly status: "open" | "allowed" | "denied";
    readonly created_at_ms: number;
    readonly decided_at_ms: number | null;
  }>`SELECT * FROM logicpacks_access_requests`.pipe(
    Effect.mapError(storage("loading access requests")),
  )) {
    requestRows.set(row.id, {
      id: row.id,
      projectId: row.project_id,
      userId: row.user_id,
      zone: row.zone,
      status: row.status,
      createdAtMs: Number(row.created_at_ms),
      decidedAtMs: row.decided_at_ms === null ? null : Number(row.decided_at_ms),
    });
  }
  const recentLog: Array<AccessLogEntry> = (yield* sql<{
    readonly id: string;
    readonly at_ms: number;
    readonly project_id: string | null;
    readonly user_id: string | null;
    readonly kind: string;
    readonly detail: string;
  }>`SELECT * FROM logicpacks_access_log ORDER BY at_ms DESC LIMIT 500`.pipe(
    Effect.mapError(storage("loading the access log")),
  )).map((row) => ({
    id: row.id,
    atMs: Number(row.at_ms),
    projectId: row.project_id,
    userId: row.user_id,
    kind: row.kind,
    detail: row.detail,
  }));

  const synced = new Set(
    (yield* sql<{ readonly project_id: string }>`
      SELECT project_id FROM logicpacks_synced_projects
    `.pipe(Effect.mapError(storage("loading synced projects")))).map((row) => row.project_id),
  );

  // Workspaces, cached the same way: one process owns the database.
  const workspaces = new Map<
    string,
    { name: string; createdAt: string; createdBy: string | null }
  >();
  const workspaceMembers = new Map<string, Map<string, WorkspaceRole>>();
  const projectWorkspace = new Map<string, string>();
  const inviteByWorkspace = new Map<string, string>();
  const workspaceByInvite = new Map<string, string>();
  const currentByViewer = new Map<string, string>();
  for (const row of yield* sql<{
    readonly workspace_id: string;
    readonly name: string;
    readonly created_at: string;
    readonly created_by: string | null;
  }>`
      SELECT workspace_id, name, created_at, created_by FROM logicpacks_workspaces
    `.pipe(Effect.mapError(storage("loading workspaces")))) {
    workspaces.set(row.workspace_id, {
      name: row.name,
      createdAt: row.created_at,
      createdBy: row.created_by,
    });
  }
  for (const row of yield* sql<{
    readonly workspace_id: string;
    readonly user_id: string;
    readonly role: WorkspaceRole;
  }>`
      SELECT workspace_id, user_id, role FROM logicpacks_workspace_members
    `.pipe(Effect.mapError(storage("loading workspace members")))) {
    const members = workspaceMembers.get(row.workspace_id) ?? new Map<string, WorkspaceRole>();
    members.set(row.user_id, row.role);
    workspaceMembers.set(row.workspace_id, members);
  }
  for (const row of yield* sql<{ readonly workspace_id: string; readonly user_id: string }>`
      SELECT workspace_id, user_id FROM logicpacks_workspace_readonly
    `.pipe(Effect.mapError(storage("loading read-only seats")))) {
    const members = workspaceMembers.get(row.workspace_id);
    if (members?.get(row.user_id) === "member") members.set(row.user_id, "viewer");
  }
  for (const row of yield* sql<{ readonly project_id: string; readonly workspace_id: string }>`
      SELECT project_id, workspace_id FROM logicpacks_workspace_projects
    `.pipe(Effect.mapError(storage("loading workspace projects")))) {
    projectWorkspace.set(row.project_id, row.workspace_id);
  }
  for (const row of yield* sql<{ readonly workspace_id: string; readonly token: string }>`
      SELECT workspace_id, token FROM logicpacks_workspace_invites
    `.pipe(Effect.mapError(storage("loading invites")))) {
    inviteByWorkspace.set(row.workspace_id, row.token);
    workspaceByInvite.set(row.token, row.workspace_id);
  }
  for (const row of yield* sql<{ readonly viewer: string; readonly workspace_id: string }>`
      SELECT viewer, workspace_id FROM logicpacks_current_workspace
    `.pipe(Effect.mapError(storage("loading current workspaces")))) {
    currentByViewer.set(row.viewer, row.workspace_id);
  }

  const pushers = new Map<string, string>();
  for (const row of yield* sql<{ readonly project_id: string; readonly user_id: string }>`
      SELECT project_id, user_id FROM logicpacks_sync_pushers
    `.pipe(Effect.mapError(storage("loading sync pushers")))) {
    pushers.set(row.project_id, row.user_id);
  }

  const onboarding = new Map<string, OnboardingChoice>();
  for (const row of yield* sql<{ readonly user_id: string; readonly choice: OnboardingChoice }>`
      SELECT user_id, choice FROM logicpacks_member_onboarding
    `.pipe(Effect.mapError(storage("loading onboarding")))) {
    onboarding.set(row.user_id, row.choice);
  }

  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const viewerKey = (actorUserId: string | null) => actorUserId ?? OPERATOR_VIEWER;
  const workspaceRoleOf = (userId: string, workspaceId: string) =>
    workspaceMembers.get(workspaceId)?.get(userId) ?? null;
  const projectsOf = (workspaceId: string) =>
    Array.from(projectWorkspace.entries()).flatMap(([projectId, owner]) =>
      owner === workspaceId ? [projectId] : [],
    );

  const summarize = (workspaceId: string, role: LogicPacksWorkspace["role"]) => ({
    workspaceId,
    name: workspaces.get(workspaceId)?.name ?? "",
    role,
    memberCount: workspaceMembers.get(workspaceId)?.size ?? 0,
    projectIds: projectsOf(workspaceId),
  });

  const listWorkspaces = (actorUserId: string | null): ReadonlyArray<LogicPacksWorkspace> =>
    Array.from(workspaces.entries())
      .flatMap(([workspaceId]) => {
        if (actorUserId === null) return [summarize(workspaceId, "operator")];
        const role = workspaceRoleOf(actorUserId, workspaceId);
        return role === null ? [] : [summarize(workspaceId, role)];
      })
      .sort((left, right) => left.name.localeCompare(right.name));

  const currentWorkspaceId = (actorUserId: string | null) => {
    const stored = currentByViewer.get(viewerKey(actorUserId)) ?? null;
    if (stored !== null && workspaces.has(stored)) {
      if (actorUserId === null || workspaceRoleOf(actorUserId, stored) !== null) return stored;
    }
    // The operator's default is the whole host; a member's is their first owned workspace.
    if (actorUserId === null) return null;
    const mine = listWorkspaces(actorUserId);
    return (mine.find((workspace) => workspace.role === "owner") ?? mine[0])?.workspaceId ?? null;
  };

  const writeCurrent = Effect.fn("LogicPacksAccess.writeCurrent")(
    function* (actorUserId: string | null, workspaceId: string | null) {
      const viewer = viewerKey(actorUserId);
      if (workspaceId === null) {
        yield* sql`DELETE FROM logicpacks_current_workspace WHERE viewer = ${viewer}`;
        currentByViewer.delete(viewer);
        return;
      }
      yield* sql`
      INSERT INTO logicpacks_current_workspace (viewer, workspace_id)
      VALUES (${viewer}, ${workspaceId})
      ON CONFLICT (viewer) DO UPDATE SET workspace_id = excluded.workspace_id
    `;
      currentByViewer.set(viewer, workspaceId);
    },
    Effect.mapError(storage("switching workspace")),
  );

  const writeWorkspaceRole = Effect.fn("LogicPacksAccess.writeWorkspaceRole")(function* (
    workspaceId: string,
    userId: string,
    role: WorkspaceRole,
    addedBy: string | null,
  ) {
    const createdAt = yield* now;
    const stored = role === "viewer" ? "member" : role;
    yield* sql`
      INSERT INTO logicpacks_workspace_members (workspace_id, user_id, role, added_by, created_at)
      VALUES (${workspaceId}, ${userId}, ${stored}, ${addedBy}, ${createdAt})
      ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = excluded.role
    `.pipe(Effect.mapError(storage("adding a workspace member")));
    yield* (
      role === "viewer"
        ? sql`
            INSERT OR IGNORE INTO logicpacks_workspace_readonly (workspace_id, user_id)
            VALUES (${workspaceId}, ${userId})
          `
        : sql`
            DELETE FROM logicpacks_workspace_readonly
            WHERE workspace_id = ${workspaceId} AND user_id = ${userId}
          `
    ).pipe(Effect.mapError(storage("setting a read-only seat")));
    const members = workspaceMembers.get(workspaceId) ?? new Map<string, WorkspaceRole>();
    members.set(userId, role);
    workspaceMembers.set(workspaceId, members);
  });

  const insertWorkspace = Effect.fn("LogicPacksAccess.insertWorkspace")(function* (
    name: string,
    ownerUserId: string | null,
  ) {
    const workspaceId = NodeCrypto.randomUUID();
    const createdAt = yield* now;
    yield* sql`
      INSERT INTO logicpacks_workspaces (workspace_id, name, created_by, created_at)
      VALUES (${workspaceId}, ${name}, ${ownerUserId}, ${createdAt})
    `.pipe(Effect.mapError(storage("creating a workspace")));
    workspaces.set(workspaceId, { name, createdAt, createdBy: ownerUserId });
    if (ownerUserId !== null) yield* writeWorkspaceRole(workspaceId, ownerUserId, "owner", null);
    return workspaceId;
  });

  const requireWorkspace = (workspaceId: string) =>
    workspaces.has(workspaceId)
      ? Effect.void
      : fail("unknown_workspace", "That workspace does not exist.");

  /** Owners manage; the operator manages every workspace. */
  const requireWorkspaceOwner = (workspaceId: string, actorUserId: string | null) =>
    requireWorkspace(workspaceId).pipe(
      Effect.andThen(
        actorUserId === null || workspaceRoleOf(actorUserId, workspaceId) === "owner"
          ? Effect.void
          : fail("not_owner", "Only a workspace owner can do that."),
      ),
    );

  const requireWorkspaceMember = (workspaceId: string, actorUserId: string | null) =>
    requireWorkspace(workspaceId).pipe(
      Effect.andThen(
        actorUserId === null || workspaceRoleOf(actorUserId, workspaceId) !== null
          ? Effect.void
          : fail("unknown_workspace", "That workspace does not exist."),
      ),
    );

  const workspaceName = (raw: string) => {
    const name = raw.trim().replace(/\s+/g, " ");
    return name.length === 0 || name.length > 80
      ? fail("invalid_workspace_name", "Name the workspace in 1 to 80 characters.")
      : Effect.succeed(name);
  };

  const writeInvite = Effect.fn("LogicPacksAccess.writeInvite")(function* (
    workspaceId: string,
    createdBy: string | null,
  ) {
    const token = NodeCrypto.randomBytes(18).toString("base64url");
    const createdAt = yield* now;
    yield* sql`
      INSERT INTO logicpacks_workspace_invites (workspace_id, token, role, created_by, created_at)
      VALUES (${workspaceId}, ${token}, 'member', ${createdBy}, ${createdAt})
      ON CONFLICT (workspace_id) DO UPDATE SET token = excluded.token, created_at = excluded.created_at
    `.pipe(Effect.mapError(storage("creating an invite link")));
    const previous = inviteByWorkspace.get(workspaceId);
    if (previous !== undefined) workspaceByInvite.delete(previous);
    inviteByWorkspace.set(workspaceId, token);
    workspaceByInvite.set(token, workspaceId);
    return token;
  });

  const findByEmail = (email: string) =>
    sql<UserRow>`SELECT * FROM logicpacks_users WHERE email = ${email}`.pipe(
      Effect.map((found) => found[0] ?? null),
      Effect.mapError(storage("reading a user")),
    );

  const getUser = (userId: string) =>
    sql<UserRow>`SELECT * FROM logicpacks_users WHERE user_id = ${userId}`.pipe(
      Effect.map((found) => (found[0] ? toUser(found[0]) : null)),
      Effect.mapError(storage("reading a user")),
    );

  const insertUser = Effect.fn("LogicPacksAccess.insertUser")(function* (input: {
    readonly email: string;
    readonly displayName: string;
    readonly passwordHash: string | null;
  }) {
    const row: UserRow = {
      user_id: NodeCrypto.randomUUID(),
      email: input.email,
      display_name: input.displayName,
      password_hash: input.passwordHash,
      created_at: DateTime.formatIso(yield* DateTime.now),
    };
    yield* sql`
      INSERT INTO logicpacks_users (user_id, email, display_name, password_hash, created_at)
      VALUES (${row.user_id}, ${row.email}, ${row.display_name}, ${row.password_hash}, ${row.created_at})
    `.pipe(Effect.mapError(storage("creating a user")));
    // Every account starts in a workspace of its own, so there is always somewhere to work.
    const workspaceId = yield* insertWorkspace(`${row.display_name}'s workspace`, row.user_id);
    yield* writeCurrent(row.user_id, workspaceId);
    return toUser(row);
  });

  const writeRole = Effect.fn("LogicPacksAccess.writeRole")(function* (
    projectId: string,
    userId: string,
    role: ProjectRole,
    addedBy: string | null,
  ) {
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    yield* sql`
      INSERT INTO logicpacks_project_access (project_id, user_id, role, added_by, created_at)
      VALUES (${projectId}, ${userId}, ${role}, ${addedBy}, ${createdAt})
      ON CONFLICT (project_id, user_id) DO UPDATE SET role = excluded.role
    `.pipe(Effect.mapError(storage("sharing a project")));
    const members = access.get(projectId) ?? new Map<string, ProjectRole>();
    members.set(userId, role);
    access.set(projectId, members);
  });

  /** A direct share, or the role the project's workspace gives; owner wins. */
  const roleOf = (userId: string, projectId: string): EffectiveRole | null => {
    const direct = access.get(projectId)?.get(userId) ?? null;
    const workspaceId = projectWorkspace.get(projectId);
    const viaWorkspace = workspaceId === undefined ? null : workspaceRoleOf(userId, workspaceId);
    if (direct === "owner" || viaWorkspace === "owner") return "owner";
    // A read-only seat holds in all of the workspace's projects, even over a share link member.
    if (viaWorkspace === "viewer") return "viewer";
    return direct ?? viaWorkspace;
  };

  const visibleProjectIdsOf = (userId: string): ReadonlySet<string> =>
    new Set([
      ...Array.from(access.entries()).flatMap(([projectId, members]) =>
        members.has(userId) ? [projectId] : [],
      ),
      ...Array.from(projectWorkspace.entries()).flatMap(([projectId, workspaceId]) =>
        workspaceRoleOf(userId, workspaceId) === null ? [] : [projectId],
      ),
    ]);

  const zonesOf = (userId: string, projectId: string | null): ResolvedZones => {
    if (projectId === null) {
      const current = currentWorkspaceId(userId);
      return resolveZones({
        isOwner: false,
        viewerSeat: current !== null && workspaceRoleOf(userId, current) === "viewer",
      });
    }
    const role = roleOf(userId, projectId);
    const rows = zoneRows.get(projectId);
    const resolved = resolveZones({
      isOwner: role === "owner",
      viewerSeat: role === "viewer",
      override: rows?.get(userId),
      projectDefault: rows?.get(ZONE_DEFAULT_KEY),
    });
    // An account that predates the Projects zone keeps it (a Read only seat never had it).
    if (
      resolved.source !== "owner" &&
      resolved.source !== "seat" &&
      (grandfathered.has(userId) || projectsDefaultOn)
    ) {
      return resolvedFromValues({ ...resolved.zones, "projects.create": "on" }, resolved.source);
    }
    return resolved;
  };

  const onCloudHost = /^(1|true|yes|on)$/i.test((process.env.LOGICPACKS_CLOUD_HOST ?? "").trim());
  // A team server whose operator wants every member to create projects sets this once, instead of
  // granting it in each share (LOGICPACKS_PROJECTS_ZONE_DEFAULT=on). Off when unset: new shares start off.
  const projectsDefaultOn = /^(1|true|yes|on)$/i.test(
    (process.env.LOGICPACKS_PROJECTS_ZONE_DEFAULT ?? "").trim(),
  );
  const canCreateProjects = (userId: string): boolean => {
    if (onCloudHost || projectsDefaultOn || grandfathered.has(userId)) return true;
    for (const projectId of visibleProjectIdsOf(userId)) {
      if (canManageProjects(zonesOf(userId, projectId).zones)) return true;
    }
    return false;
  };

  /**
   * Read only is derived from zones: the `viewer` seat is the readonly preset, and any other
   * seat whose zones allow no change (no AI, no file writes, no compute) is read only too.
   * Someone with no access at all to a project is not "read only"; the fence refuses them.
   */
  const isReadOnly = (userId: string, projectId: string | null): boolean => {
    if (projectId !== null) {
      return roleOf(userId, projectId) !== null && !canMutate(zonesOf(userId, projectId).zones);
    }
    const current = currentWorkspaceId(userId);
    return current !== null && workspaceRoleOf(userId, current) === "viewer";
  };

  // Agent runs for a member read this person's live zones when they start.
  installRunLimiter((sender) =>
    roleOf(sender.userId, sender.projectId ?? "") === null && sender.projectId !== null
      ? agentLimitsFor(zonesForPreset("readonly"))
      : agentLimitsFor(zonesOf(sender.userId, sender.projectId).zones),
  );

  installHostWriteGuard(
    (sender) =>
      canCreateProjects(sender.userId) ||
      (sender.projectId !== null && canCompute(zonesOf(sender.userId, sender.projectId).zones)),
  );

  const writeZones = Effect.fn("LogicPacksAccess.writeZones")(function* (
    projectId: string,
    key: string,
    zones: ZoneValues | null,
    actorUserId: string | null,
  ) {
    if (zones === null) {
      yield* sql`
        DELETE FROM logicpacks_project_zones WHERE project_id = ${projectId} AND user_id = ${key}
      `.pipe(Effect.mapError(storage("clearing access zones")));
      zoneRows.get(projectId)?.delete(key);
    } else {
      const at = DateTime.formatIso(yield* DateTime.now);
      const normalized = normalizeZones(zones);
      yield* sql`
        INSERT INTO logicpacks_project_zones (project_id, user_id, zones, updated_by, updated_at)
        VALUES (${projectId}, ${key}, ${JSON.stringify(normalized)}, ${actorUserId}, ${at})
        ON CONFLICT (project_id, user_id) DO UPDATE SET
          zones = excluded.zones, updated_by = excluded.updated_by, updated_at = excluded.updated_at
      `.pipe(Effect.mapError(storage("saving access zones")));
      const rows = zoneRows.get(projectId) ?? new Map<string, ZoneValues>();
      rows.set(key, normalized);
      zoneRows.set(projectId, rows);
    }
    emitZones(projectId, key === ZONE_DEFAULT_KEY ? null : key);
  });

  const inView = (actorUserId: string | null, projectId: string) => {
    const current = currentWorkspaceId(actorUserId);
    const workspaceId = projectWorkspace.get(projectId) ?? null;
    if (actorUserId === null) return current === null || workspaceId === current;
    if (roleOf(actorUserId, projectId) === null) return false;
    if (workspaceId === current) return true;
    // Shared straight with them from a workspace they are not in: always in view.
    return workspaceId === null || workspaceRoleOf(actorUserId, workspaceId) === null;
  };

  const requireOwner = (projectId: string, actorUserId: string | null) =>
    actorUserId === null || roleOf(actorUserId, projectId) === "owner"
      ? Effect.void
      : fail("not_owner", "Only the project owner can change who it is shared with.");

  /** Counts and deletes the rows where `column = value`, in one transaction. Table names are ours. */
  const purgeAll = Effect.fn("LogicPacksAccess.purgeAll")(function* (
    tables: ReadonlyArray<readonly [string, string]>,
    value: string,
  ) {
    const counts: Record<string, number> = {};
    yield* sql.withTransaction(
      Effect.forEach(
        tables,
        ([table, column]) =>
          sql
            .unsafe<{ readonly n: number }>(
              `SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`,
              [value],
            )
            .pipe(
              Effect.tap((found) =>
                Effect.sync(() => {
                  counts[table] = Number(found[0]?.n ?? 0);
                }),
              ),
              Effect.andThen(sql.unsafe(`DELETE FROM ${table} WHERE ${column} = ?`, [value])),
            ),
        { discard: true },
      ),
    );
    return counts as Readonly<Record<string, number>>;
  });

  return LogicPacksAccess.of({
    signUp: Effect.fn("LogicPacksAccess.signUp")(function* (input) {
      const email = normalizeEmail(input.email);
      if (email === null) return yield* fail("invalid_email", "Enter a valid email address.");
      if (input.password.length < MIN_PASSWORD_LENGTH) {
        return yield* fail(
          "weak_password",
          `Use a password of at least ${MIN_PASSWORD_LENGTH} characters.`,
        );
      }
      if ((yield* findByEmail(email)) !== null) {
        return yield* fail("email_taken", "An account with this email already exists.");
      }
      return yield* insertUser({
        email,
        displayName: input.displayName?.trim() || displayNameFromEmail(email),
        passwordHash: yield* hashPassword(input.password),
      });
    }),
    logIn: Effect.fn("LogicPacksAccess.logIn")(function* (input) {
      const email = normalizeEmail(input.email);
      const row = email === null ? null : yield* findByEmail(email);
      const valid =
        row?.password_hash != null && (yield* verifyPassword(input.password, row.password_hash));
      if (!row || !valid) {
        return yield* fail("invalid_credentials", "That email and password do not match.");
      }
      return toUser(row);
    }),
    signInWithIdentity: Effect.fn("LogicPacksAccess.signInWithIdentity")(function* (input) {
      const linkedRow = yield* sql<UserRow>`
        SELECT u.* FROM logicpacks_user_identities i
        JOIN logicpacks_users u ON u.user_id = i.user_id
        WHERE i.provider = ${input.provider} AND i.subject = ${input.subject}
      `.pipe(
        Effect.map((found) => found[0] ?? null),
        Effect.mapError(storage("reading a linked account")),
      );
      if (linkedRow !== null) return { user: toUser(linkedRow), created: false, linked: false };
      const email = input.email === null ? null : normalizeEmail(input.email);
      if (email === null || !input.emailVerified) {
        return yield* fail(
          "email_unverified",
          "That account has no verified email address. Verify it with the provider, or use email and password.",
        );
      }
      const existing = yield* findByEmail(email);
      if (existing === null && !input.allowSignup) {
        return yield* fail("signup_closed", "This host is not taking new accounts this way.");
      }
      const user =
        existing !== null
          ? toUser(existing)
          : yield* insertUser({
              email,
              displayName: input.displayName?.trim() || displayNameFromEmail(email),
              passwordHash: null,
            });
      const createdAt = yield* now;
      yield* sql`
        INSERT INTO logicpacks_user_identities (provider, subject, user_id, email, created_at)
        VALUES (${input.provider}, ${input.subject}, ${user.userId}, ${email}, ${createdAt})
      `.pipe(Effect.mapError(storage("linking an account")));
      return { user, created: existing === null, linked: existing !== null };
    }),
    syncPusher: (projectId) => pushers.get(projectId) ?? null,
    setSyncPusher: Effect.fn("LogicPacksAccess.setSyncPusher")(function* (projectId, userId) {
      if (userId === null) {
        yield* sql`DELETE FROM logicpacks_sync_pushers WHERE project_id = ${projectId}`.pipe(
          Effect.mapError(storage("clearing a sync pusher")),
        );
        pushers.delete(projectId);
        return;
      }
      const setAt = yield* now;
      yield* sql`
        INSERT INTO logicpacks_sync_pushers (project_id, user_id, set_at)
        VALUES (${projectId}, ${userId}, ${setAt})
        ON CONFLICT (project_id) DO UPDATE SET user_id = excluded.user_id, set_at = excluded.set_at
      `.pipe(Effect.mapError(storage("saving a sync pusher")));
      pushers.set(projectId, userId);
    }),
    onboardingChoice: (userId) => onboarding.get(userId) ?? null,
    setOnboardingChoice: Effect.fn("LogicPacksAccess.setOnboardingChoice")(
      function* (userId, choice) {
        const decidedAt = yield* now;
        yield* sql`
          INSERT INTO logicpacks_member_onboarding (user_id, choice, decided_at)
          VALUES (${userId}, ${choice}, ${decidedAt})
          ON CONFLICT (user_id) DO UPDATE SET choice = excluded.choice, decided_at = excluded.decided_at
        `.pipe(Effect.mapError(storage("saving onboarding")));
        onboarding.set(userId, choice);
      },
    ),
    quickLogin: Effect.fn("LogicPacksAccess.quickLogin")(function* (rawName) {
      const name = normalizeQuickLoginName(rawName);
      if (name === null) {
        return yield* fail("invalid_name", "Use lowercase letters, digits and dashes.");
      }
      const email = quickLoginEmail(name);
      const existing = yield* findByEmail(email);
      if (existing !== null) return toUser(existing);
      return yield* insertUser({
        email,
        displayName: displayNameFromEmail(name),
        passwordHash: null,
      });
    }),
    getUser,
    listUsers: Effect.fn("LogicPacksAccess.listUsers")(function* () {
      const found = yield* sql<UserRow>`SELECT * FROM logicpacks_users ORDER BY display_name`.pipe(
        Effect.mapError(storage("listing users")),
      );
      return found.map(toUser);
    }),
    roleOf,
    isReadOnly,
    zonesOf,
    canCreateProjects,
    creationWorkspaceId: (userId) => {
      if (userId === null) return currentWorkspaceId(null);
      if (!onCloudHost) {
        for (const projectId of visibleProjectIdsOf(userId)) {
          const shared = projectWorkspace.get(projectId);
          if (shared !== undefined && roleOf(userId, projectId) !== "owner") return shared;
        }
      }
      return currentWorkspaceId(userId);
    },
    setProjectZones: Effect.fn("LogicPacksAccess.setProjectZones")(function* (input) {
      yield* requireOwner(input.projectId, input.actorUserId);
      yield* writeZones(input.projectId, ZONE_DEFAULT_KEY, input.zones, input.actorUserId);
    }),
    setMemberZones: Effect.fn("LogicPacksAccess.setMemberZones")(function* (input) {
      yield* requireOwner(input.projectId, input.actorUserId);
      if (input.userId === ZONE_DEFAULT_KEY) return yield* fail("unknown_user", "No such person.");
      if (roleOf(input.userId, input.projectId) === null) {
        return yield* fail("unknown_user", "They do not have access to this project.");
      }
      if (roleOf(input.userId, input.projectId) === "owner") {
        return yield* fail("last_owner", "An owner always has full access.");
      }
      yield* writeZones(input.projectId, input.userId, input.zones, input.actorUserId);
    }),
    zoneSettings: (projectId) => {
      const rows = zoneRows.get(projectId);
      const overrides = new Map<string, ZoneValues>();
      for (const [key, value] of rows ?? []) if (key !== ZONE_DEFAULT_KEY) overrides.set(key, value);
      return { projectDefault: rows?.get(ZONE_DEFAULT_KEY) ?? null, overrides };
    },
    onZonesChanged: (listener) => {
      zoneListeners.add(listener);
      return () => {
        zoneListeners.delete(listener);
      };
    },
    logAccess: Effect.fn("LogicPacksAccess.logAccess")(function* (entry) {
      const atMs = DateTime.toEpochMillis(yield* DateTime.now);
      const id = NodeCrypto.randomUUID();
      const detail = entry.detail.slice(0, 500);
      yield* sql`
        INSERT INTO logicpacks_access_log (id, at_ms, project_id, user_id, kind, detail)
        VALUES (${id}, ${atMs}, ${entry.projectId}, ${entry.userId}, ${entry.kind}, ${detail})
      `.pipe(Effect.ignoreCause);
      recentLog.unshift({ id, atMs, ...entry, detail });
      if (recentLog.length > 500) recentLog.length = 500;
    }),
    accessLog: (projectId, limit = 100) =>
      recentLog.filter((entry) => entry.projectId === projectId).slice(0, limit),
    requestAccess: Effect.fn("LogicPacksAccess.requestAccess")(function* (input) {
      if (roleOf(input.userId, input.projectId) === null) {
        return yield* fail("unknown_user", "This project is not shared with you.");
      }
      for (const open of requestRows.values()) {
        if (
          open.status === "open" &&
          open.projectId === input.projectId &&
          open.userId === input.userId &&
          open.zone === input.zone
        ) {
          return open;
        }
      }
      const request: AccessRequest = {
        id: NodeCrypto.randomUUID(),
        projectId: input.projectId,
        userId: input.userId,
        zone: input.zone,
        status: "open",
        createdAtMs: DateTime.toEpochMillis(yield* DateTime.now),
        decidedAtMs: null,
      };
      yield* sql`
        INSERT INTO logicpacks_access_requests (id, project_id, user_id, zone, status, created_at_ms)
        VALUES (${request.id}, ${request.projectId}, ${request.userId}, ${request.zone}, 'open', ${request.createdAtMs})
      `.pipe(Effect.mapError(storage("saving an access request")));
      requestRows.set(request.id, request);
      return request;
    }),
    accessRequests: (projectId) =>
      Array.from(requestRows.values())
        .filter((request) => request.projectId === projectId)
        .toSorted((a, b) => b.createdAtMs - a.createdAtMs),
    decideAccess: Effect.fn("LogicPacksAccess.decideAccess")(function* (input) {
      yield* requireOwner(input.projectId, input.actorUserId);
      const request = requestRows.get(input.requestId);
      if (request === undefined || request.projectId !== input.projectId) {
        return yield* fail("unknown_user", "That request is gone.");
      }
      if (request.status !== "open") return request;
      const decided: AccessRequest = {
        ...request,
        status: input.decision === "allow" ? "allowed" : "denied",
        decidedAtMs: DateTime.toEpochMillis(yield* DateTime.now),
      };
      yield* sql`
        UPDATE logicpacks_access_requests
        SET status = ${decided.status}, decided_at_ms = ${decided.decidedAtMs}
        WHERE id = ${decided.id}
      `.pipe(Effect.mapError(storage("deciding an access request")));
      requestRows.set(decided.id, decided);
      if (input.decision === "allow" && roleOf(request.userId, request.projectId) !== null) {
        const current = zonesOf(request.userId, request.projectId).zones;
        const next = normalizeZones(
          request.zone === "ai"
            ? { ...current, "ai.agents": ACCESS_AGENTS.join(",") }
            : {
                ...current,
                "compute.terminal": "on",
                // Sandboxed where this computer can sandbox; where it cannot, the host's Allow (behind the
                // blunt warning) is a shell as their user, because a sandboxed terminal would not start.
                "compute.mode": sandboxPossible() ? "sandboxed" : "unrestricted",
              },
        );
        yield* writeZones(request.projectId, request.userId, next, input.actorUserId);
      }
      return decided;
    }),
    visibleProjectIds: visibleProjectIdsOf,
    recordOwner: Effect.fn("LogicPacksAccess.recordOwner")(function* (projectId, userId) {
      yield* writeRole(projectId, userId, "owner", userId);
    }),
    listMembers: Effect.fn("LogicPacksAccess.listMembers")(function* (projectId) {
      const members = access.get(projectId);
      if (!members) return [];
      const result: Array<LogicPacksProjectMember> = [];
      for (const [userId, role] of members) {
        const user = yield* getUser(userId);
        if (user) result.push({ user, role });
      }
      return result.sort((left, right) =>
        left.role === right.role
          ? left.user.displayName.localeCompare(right.user.displayName)
          : left.role === "owner"
            ? -1
            : 1,
      );
    }),
    addMember: Effect.fn("LogicPacksAccess.addMember")(function* (input) {
      yield* requireOwner(input.projectId, input.actorUserId);
      const email = normalizeUserReference(input.user);
      if (email === null) {
        return yield* fail("invalid_email", "Name a teammate by email or LogicPacks name.");
      }
      const row = yield* findByEmail(email);
      if (row === null) {
        return yield* fail("unknown_user", `No LogicPacks account is called ${input.user}.`);
      }
      const role = input.role ?? "member";
      yield* writeRole(input.projectId, row.user_id, role, input.actorUserId);
      return { user: toUser(row), role };
    }),
    markSynced: Effect.fn("LogicPacksAccess.markSynced")(function* (projectId, remoteUrl) {
      const syncedAt = DateTime.formatIso(yield* DateTime.now);
      yield* sql`
        INSERT INTO logicpacks_synced_projects (project_id, remote_url, synced_at)
        VALUES (${projectId}, ${remoteUrl}, ${syncedAt})
        ON CONFLICT (project_id) DO UPDATE SET remote_url = excluded.remote_url
      `.pipe(Effect.mapError(storage("recording a synced project")));
      synced.add(projectId);
    }),
    isSynced: (projectId) => synced.has(projectId),
    syncedProjectIds: () => new Set(synced),
    removeMember: Effect.fn("LogicPacksAccess.removeMember")(function* (input) {
      yield* requireOwner(input.projectId, input.actorUserId);
      const members = access.get(input.projectId);
      if (!members?.has(input.userId)) return;
      const owners = Array.from(members.values()).filter((role) => role === "owner").length;
      if (members.get(input.userId) === "owner" && owners === 1) {
        return yield* fail("last_owner", "A shared project keeps at least one owner.");
      }
      yield* sql`
        DELETE FROM logicpacks_project_access
        WHERE project_id = ${input.projectId} AND user_id = ${input.userId}
      `.pipe(Effect.mapError(storage("unsharing a project")));
      members.delete(input.userId);
      yield* writeZones(input.projectId, input.userId, null, input.actorUserId);
      // Their open sockets stop streaming now; they reconnect with their current access.
      closeMemberSockets(input.userId);
    }),
    createWorkspace: Effect.fn("LogicPacksAccess.createWorkspace")(function* (input) {
      const name = yield* workspaceName(input.name);
      const workspaceId = yield* insertWorkspace(name, input.actorUserId);
      yield* writeCurrent(input.actorUserId, workspaceId);
      return summarize(workspaceId, input.actorUserId === null ? "operator" : "owner");
    }),
    renameWorkspace: Effect.fn("LogicPacksAccess.renameWorkspace")(function* (input) {
      yield* requireWorkspaceOwner(input.workspaceId, input.actorUserId);
      const name = yield* workspaceName(input.name);
      yield* sql`
        UPDATE logicpacks_workspaces SET name = ${name} WHERE workspace_id = ${input.workspaceId}
      `.pipe(Effect.mapError(storage("renaming a workspace")));
      const workspace = workspaces.get(input.workspaceId);
      if (workspace) workspace.name = name;
    }),
    deleteWorkspace: Effect.fn("LogicPacksAccess.deleteWorkspace")(function* (input) {
      yield* requireWorkspaceOwner(input.workspaceId, input.actorUserId);
      const workspaceId = input.workspaceId;
      yield* sql
        .withTransaction(
          Effect.all(
            [
              sql`DELETE FROM logicpacks_workspace_members WHERE workspace_id = ${workspaceId}`,
              sql`DELETE FROM logicpacks_workspace_projects WHERE workspace_id = ${workspaceId}`,
              sql`DELETE FROM logicpacks_workspace_invites WHERE workspace_id = ${workspaceId}`,
              sql`DELETE FROM logicpacks_current_workspace WHERE workspace_id = ${workspaceId}`,
              sql`DELETE FROM logicpacks_workspaces WHERE workspace_id = ${workspaceId}`,
            ],
            { discard: true },
          ),
        )
        .pipe(Effect.mapError(storage("deleting a workspace")));
      workspaces.delete(workspaceId);
      workspaceMembers.delete(workspaceId);
      for (const projectId of projectsOf(workspaceId)) projectWorkspace.delete(projectId);
      const token = inviteByWorkspace.get(workspaceId);
      if (token !== undefined) workspaceByInvite.delete(token);
      inviteByWorkspace.delete(workspaceId);
      for (const [viewer, current] of currentByViewer) {
        if (current === workspaceId) currentByViewer.delete(viewer);
      }
    }),
    listWorkspaces,
    currentWorkspaceId,
    setCurrentWorkspace: Effect.fn("LogicPacksAccess.setCurrentWorkspace")(function* (input) {
      if (input.workspaceId === null) {
        if (input.actorUserId !== null) {
          return yield* fail("unknown_workspace", "Pick one of your workspaces.");
        }
        return yield* writeCurrent(null, null);
      }
      yield* requireWorkspaceMember(input.workspaceId, input.actorUserId);
      yield* writeCurrent(input.actorUserId, input.workspaceId);
    }),
    listWorkspaceMembers: Effect.fn("LogicPacksAccess.listWorkspaceMembers")(function* (input) {
      yield* requireWorkspaceMember(input.workspaceId, input.actorUserId);
      const result: Array<LogicPacksWorkspaceMember> = [];
      for (const [userId, role] of workspaceMembers.get(input.workspaceId) ?? []) {
        const user = yield* getUser(userId);
        if (user) result.push({ user, role });
      }
      return result.sort((left, right) =>
        left.role === right.role
          ? left.user.displayName.localeCompare(right.user.displayName)
          : left.role === "owner"
            ? -1
            : 1,
      );
    }),
    addWorkspaceMember: Effect.fn("LogicPacksAccess.addWorkspaceMember")(function* (input) {
      yield* requireWorkspaceOwner(input.workspaceId, input.actorUserId);
      const email = normalizeUserReference(input.user);
      if (email === null) {
        return yield* fail("invalid_email", "Name a teammate by email or LogicPacks name.");
      }
      const row = yield* findByEmail(email);
      if (row === null) {
        return yield* fail(
          "unknown_user",
          `No LogicPacks account is called ${input.user}. Send them the invite link instead.`,
        );
      }
      // Re-adding someone keeps an owner an owner unless a role is named.
      const role = input.role ?? workspaceRoleOf(row.user_id, input.workspaceId) ?? "member";
      yield* writeWorkspaceRole(input.workspaceId, row.user_id, role, input.actorUserId);
      return { user: toUser(row), role };
    }),
    setWorkspaceRole: Effect.fn("LogicPacksAccess.setWorkspaceRole")(function* (input) {
      yield* requireWorkspaceOwner(input.workspaceId, input.actorUserId);
      const members = workspaceMembers.get(input.workspaceId);
      const current = members?.get(input.userId);
      if (current === undefined)
        return yield* fail("unknown_user", "They are not in this workspace.");
      const owners = Array.from(members?.values() ?? []).filter((role) => role === "owner").length;
      if (current === "owner" && input.role !== "owner" && owners === 1) {
        return yield* fail("last_owner", "A workspace keeps at least one owner.");
      }
      yield* writeWorkspaceRole(input.workspaceId, input.userId, input.role, input.actorUserId);
      // A seat change (Read only on or off) is a zone change for every project in it.
      for (const projectId of projectsOf(input.workspaceId)) emitZones(projectId, input.userId);
    }),
    removeWorkspaceMember: Effect.fn("LogicPacksAccess.removeWorkspaceMember")(function* (input) {
      if (input.actorUserId !== input.userId) {
        yield* requireWorkspaceOwner(input.workspaceId, input.actorUserId);
      }
      const members = workspaceMembers.get(input.workspaceId);
      const role = members?.get(input.userId);
      if (members === undefined || role === undefined) return;
      const owners = Array.from(members.values()).filter((value) => value === "owner").length;
      if (role === "owner" && owners === 1) {
        return yield* fail("last_owner", "A workspace keeps at least one owner.");
      }
      const projectIds = projectsOf(input.workspaceId);
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`
              DELETE FROM logicpacks_workspace_members
              WHERE workspace_id = ${input.workspaceId} AND user_id = ${input.userId}
            `;
            // Revoking takes away everything in the workspace, including projects they added.
            if (projectIds.length > 0) {
              yield* sql`
                DELETE FROM logicpacks_project_access
                WHERE user_id = ${input.userId} AND ${sql.in("project_id", projectIds)}
              `;
            }
            yield* sql`
              DELETE FROM logicpacks_current_workspace
              WHERE viewer = ${input.userId} AND workspace_id = ${input.workspaceId}
            `;
          }),
        )
        .pipe(Effect.mapError(storage("removing a workspace member")));
      members.delete(input.userId);
      for (const projectId of projectIds) access.get(projectId)?.delete(input.userId);
      for (const projectId of projectIds) emitZones(projectId, input.userId);
      if (currentByViewer.get(input.userId) === input.workspaceId) {
        currentByViewer.delete(input.userId);
      }
      closeMemberSockets(input.userId);
    }),
    inviteToken: Effect.fn("LogicPacksAccess.inviteToken")(function* (input) {
      yield* requireWorkspaceMember(input.workspaceId, input.actorUserId);
      if (
        input.actorUserId !== null &&
        workspaceRoleOf(input.actorUserId, input.workspaceId) === "viewer"
      ) {
        return yield* fail(
          "read_only",
          "You have read-only access to this workspace. Ask an owner to change it.",
        );
      }
      return (
        inviteByWorkspace.get(input.workspaceId) ??
        (yield* writeInvite(input.workspaceId, input.actorUserId))
      );
    }),
    resetInvite: Effect.fn("LogicPacksAccess.resetInvite")(function* (input) {
      yield* requireWorkspaceOwner(input.workspaceId, input.actorUserId);
      return yield* writeInvite(input.workspaceId, input.actorUserId);
    }),
    workspaceForInvite: (token) => {
      const workspaceId = workspaceByInvite.get(token);
      const workspace = workspaceId === undefined ? undefined : workspaces.get(workspaceId);
      return workspaceId === undefined || workspace === undefined
        ? null
        : { workspaceId, name: workspace.name };
    },
    joinWithInvite: Effect.fn("LogicPacksAccess.joinWithInvite")(function* (input) {
      const workspaceId = workspaceByInvite.get(input.token);
      if (workspaceId === undefined || !workspaces.has(workspaceId)) {
        return yield* fail("invalid_invite", "This invite link has expired. Ask for a new one.");
      }
      const existing = workspaceRoleOf(input.userId, workspaceId);
      if (existing === null) yield* writeWorkspaceRole(workspaceId, input.userId, "member", null);
      yield* writeCurrent(input.userId, workspaceId);
      return summarize(workspaceId, existing ?? "member");
    }),
    attachProject: Effect.fn("LogicPacksAccess.attachProject")(function* (projectId, workspaceId) {
      yield* requireWorkspace(workspaceId);
      const addedAt = yield* now;
      yield* sql`
        INSERT INTO logicpacks_workspace_projects (project_id, workspace_id, added_at)
        VALUES (${projectId}, ${workspaceId}, ${addedAt})
        ON CONFLICT (project_id) DO UPDATE SET workspace_id = excluded.workspace_id
      `.pipe(Effect.mapError(storage("adding a project to a workspace")));
      projectWorkspace.set(projectId, workspaceId);
    }),
    projectWorkspaceId: (projectId) => projectWorkspace.get(projectId) ?? null,
    inView,
    workspaceCreator: Effect.fn("LogicPacksAccess.workspaceCreator")(function* (workspaceId) {
      return workspaces.get(workspaceId)?.createdBy;
    }),
    forgetUser: Effect.fn("LogicPacksAccess.forgetUser")(function* (userId) {
      const counts = yield* purgeAll(
        [
          ["logicpacks_project_access", "user_id"],
          ["logicpacks_project_zones", "user_id"],
          ["logicpacks_access_requests", "user_id"],
          ["logicpacks_projects_grandfathered", "user_id"],
          ["logicpacks_workspace_members", "user_id"],
          ["logicpacks_current_workspace", "viewer"],
          ["logicpacks_sync_pushers", "user_id"],
          ["logicpacks_user_identities", "user_id"],
          ["logicpacks_member_onboarding", "user_id"],
          // Last, so a run that stopped half way still finds the account by email.
          ["logicpacks_users", "user_id"],
        ],
        userId,
      ).pipe(Effect.mapError(storage("deleting a user")));
      for (const members of access.values()) members.delete(userId);
      for (const rows of zoneRows.values()) rows.delete(userId);
      for (const members of workspaceMembers.values()) members.delete(userId);
      for (const [projectId, pusher] of pushers) {
        if (pusher === userId) pushers.delete(projectId);
      }
      currentByViewer.delete(userId);
      onboarding.delete(userId);
      return counts;
    }),
    forgetProject: Effect.fn("LogicPacksAccess.forgetProject")(function* (projectId) {
      const counts = yield* purgeAll(
        [
          ["logicpacks_project_access", "project_id"],
          ["logicpacks_project_zones", "project_id"],
          ["logicpacks_access_requests", "project_id"],
          ["logicpacks_access_log", "project_id"],
          ["logicpacks_workspace_projects", "project_id"],
          ["logicpacks_synced_projects", "project_id"],
          ["logicpacks_sync_pushers", "project_id"],
        ],
        projectId,
      ).pipe(Effect.mapError(storage("forgetting a project")));
      access.delete(projectId);
      zoneRows.delete(projectId);
      projectWorkspace.delete(projectId);
      synced.delete(projectId);
      pushers.delete(projectId);
      return counts;
    }),
  });
});

export const layer = Layer.effect(LogicPacksAccess, make);
