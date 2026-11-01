// @effect-diagnostics nodeBuiltinImport:off -- removes member folders, worktrees and secret files synchronously.
// @effect-diagnostics preferSchemaOverJson:off -- access code rows hold the plain JSON of featureCodes.ts.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { STAFF_EMAILS } from "./accessConfig.ts";
import { ExpertsService } from "./ExpertsService.ts";
import { ExternalTeamService } from "./ExternalTeamService.ts";
import { LogicPacksAccess, type LogicPacksUser } from "./LogicPacksAccess.ts";
import { forgetProviderLogin, memberSecretDigest } from "./loginVault.ts";
import { memberDirSegment } from "./memberLogin.ts";
import { MEMBER_PROVIDER_KINDS, memberInstanceId, userDigest } from "./memberProviders.ts";
import {
  forgetPreparedProject,
  projectGroupName,
  sandboxHome,
  sandboxUserName,
  type MemberSandboxOs,
} from "./memberSandbox.ts";
import { forgetShareProject, forgetShareUser } from "./ProjectShares.ts";
import { memberSubject, normalizeEmail } from "./projectAccess.ts";

/**
 * Deleting a member account everywhere it exists on a host: the account and every per-user
 * row, the workspaces and projects only they had (project, threads, folder, worktrees), their
 * provider logins (settings instances, sealed and plaintext login files, stored secrets), OAuth
 * connections, and under the sandbox their Unix user and the groups of deleted projects.
 * Shared and host-owned projects stay; only the member's access goes.
 *
 * Meant for the `logicpacks admin delete-user` CLI, with the service stopped. Every step is
 * idempotent: a second run finds nothing left and changes nothing.
 */

export class MemberDeletionError extends Schema.TaggedError<MemberDeletionError>()(
  "MemberDeletionError",
  {
    reason: Schema.Literals(["protected", "invalid_target", "storage"]),
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

/** What deleteMember needs from the host besides the LogicPacks services. */
export interface MemberDeletionHost {
  /** The server's base dir (`--base-dir`, /srv/lp-v2 on the cloud host). */
  readonly baseDir: string;
  /** `<baseDir>/userdata`. */
  readonly stateDir: string;
  readonly secretsDir: string;
  readonly worktreesDir: string;
  /** A live (not deleted) project, or null. */
  readonly getProject: (
    projectId: string,
  ) => Effect.Effect<
    { readonly title: string; readonly workspaceRoot: string } | null,
    MemberDeletionError
  >;
  /** Deletes the project and its threads through the project store. */
  readonly deleteProject: (projectId: string) => Effect.Effect<void, MemberDeletionError>;
  readonly providerInstanceIds: Effect.Effect<ReadonlyArray<string>, MemberDeletionError>;
  readonly removeProviderInstance: (instanceId: string) => Effect.Effect<void, MemberDeletionError>;
  /** Removes (and for member logins shreds) one secret by name. */
  readonly removeSecret: (name: string) => Effect.Effect<void, MemberDeletionError>;
  readonly os: MemberSandboxOs;
  /** LOGICPACKS_MEMBER_SANDBOX=user and running as root: Unix users and groups are ours to remove. */
  readonly manageUnixUsers: boolean;
  /** Never deleted, on top of staff (accessConfig, LOGICPACKS_STAFF_EMAILS, /ops staff). */
  readonly protectedEmails?: ReadonlyArray<string>;
}

export type MemberDeletionTarget =
  | { readonly email: string }
  /** Also cleans up leftovers (files, Unix user, secrets) of an account row already gone. */
  | { readonly userId: string };

export interface MemberDeletionReport {
  readonly userId: string | null;
  readonly email: string | null;
  readonly digest: string | null;
  /** The account row existed. */
  readonly found: boolean;
  readonly dryRun: boolean;
  readonly deletedProjects: ReadonlyArray<string>;
  readonly keptProjects: ReadonlyArray<string>;
  readonly deletedWorkspaces: ReadonlyArray<string>;
  /** Done (or, in a dry run, what would be done). */
  readonly removed: ReadonlyArray<string>;
  readonly kept: ReadonlyArray<string>;
  readonly skipped: ReadonlyArray<string>;
  readonly failed: ReadonlyArray<string>;
}

const storage = (operation: string) => (cause: unknown) =>
  new MemberDeletionError({
    reason: "storage",
    message: `Deleting a member failed during ${operation}.`,
    cause,
  });

/** For MemberDeletionHost implementations: wraps a host failure. */
export const hostFailure = storage;

const envList = (name: string) =>
  (process.env[name] ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter((email) => email.length > 0);

const tableExists = (sql: SqlClient.SqlClient, table: string) =>
  sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${table}
  `.pipe(Effect.map((rows) => rows.length > 0));

/** Counts, then (unless dry) deletes, `table` rows where `where` holds. Missing tables count 0. */
const purge = Effect.fn("deleteMember.purge")(function* (
  sql: SqlClient.SqlClient,
  table: string,
  where: string,
  params: ReadonlyArray<string>,
  dryRun: boolean,
) {
  if (!(yield* tableExists(sql, table))) return 0;
  const found = yield* sql.unsafe<{ readonly n: number }>(
    `SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`,
    [...params],
  );
  const count = Number(found[0]?.n ?? 0);
  if (count > 0 && !dryRun) {
    yield* sql.unsafe(`DELETE FROM ${table} WHERE ${where}`, [...params]);
  }
  return count;
});

/** Staff, the configured protected emails and anything in the /ops staff list. */
export const protectedEmailsOf = Effect.fn("deleteMember.protectedEmails")(function* (
  host: Pick<MemberDeletionHost, "protectedEmails">,
) {
  const sql = yield* SqlClient.SqlClient;
  const fromTable = (yield* tableExists(sql, "logicpacks_staff"))
    ? (yield* sql<{ readonly id: string }>`SELECT id FROM logicpacks_staff`).map((row) => row.id)
    : [];
  return new Set(
    [
      ...STAFF_EMAILS,
      ...envList("LOGICPACKS_STAFF_EMAILS"),
      ...(host.protectedEmails ?? []),
      ...fromTable,
    ].map((email) => email.trim().toLowerCase()),
  );
});

const isInside = (child: string, parent: string) => {
  const relative = NodePath.relative(NodePath.resolve(parent), NodePath.resolve(child));
  return relative.length > 0 && !relative.startsWith("..") && !NodePath.isAbsolute(relative);
};

const safeReaddir = (dir: string) => {
  try {
    return NodeFS.readdirSync(dir);
  } catch {
    return [];
  }
};

/** Worktrees (`<worktreesDir>/<repo>/<branch>`) whose .git points into this project's repo. */
const projectWorktreeDirs = (projectRoot: string, worktreesDir: string) => {
  const marker = NodePath.join(projectRoot, ".git", "worktrees") + NodePath.sep;
  const found: Array<string> = [];
  for (const repo of safeReaddir(worktreesDir)) {
    for (const branch of safeReaddir(NodePath.join(worktreesDir, repo))) {
      const dir = NodePath.join(worktreesDir, repo, branch);
      try {
        if (NodeFS.readFileSync(NodePath.join(dir, ".git"), "utf8").includes(marker)) {
          found.push(dir);
        }
      } catch {
        // not a worktree
      }
    }
  }
  return found;
};

const removeDir = (dir: string) => {
  NodeFS.rmSync(dir, { recursive: true, force: true });
  // An emptied parent under worktrees/ is left tidy too.
  const parent = NodePath.dirname(dir);
  if (safeReaddir(parent).length === 0) {
    try {
      NodeFS.rmdirSync(parent);
    } catch {
      // not empty or gone
    }
  }
};

interface AccessCodeRow {
  readonly redeemedBy?: ReadonlyArray<{ readonly userId: string; readonly atMs: number }>;
}

const parseAccessCode = (data: string): AccessCodeRow | null => {
  try {
    const parsed: unknown = JSON.parse(data);
    return parsed !== null && typeof parsed === "object" ? (parsed as AccessCodeRow) : null;
  } catch {
    return null;
  }
};

/**
 * Deletes one member everywhere. `alsoLeaving` names other members being deleted in the same
 * run (`--all-members`): they do not count as someone a project or workspace is shared with.
 */
export const deleteMember = Effect.fn("deleteMember")(function* (
  host: MemberDeletionHost,
  target: MemberDeletionTarget,
  options: {
    readonly dryRun?: boolean;
    readonly alsoLeaving?: ReadonlySet<string>;
    /** Projects and workspaces an earlier report in the same run already deletes (dry runs). */
    readonly claimed?: ReadonlySet<string>;
  } = {},
) {
  const dryRun = options.dryRun === true;
  const sql = yield* SqlClient.SqlClient;
  const access = yield* LogicPacksAccess;
  const experts = yield* ExpertsService;
  const external = yield* ExternalTeamService;

  const removed: Array<string> = [];
  const kept: Array<string> = [];
  const skipped: Array<string> = [];
  const failed: Array<string> = [];
  const deletedProjects: Array<string> = [];
  const keptProjects: Array<string> = [];
  const deletedWorkspaces: Array<string> = [];

  // Best effort per step: one failure is reported and the rest still runs.
  const attempt = <A, E, R>(label: string, effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.map((value): A | undefined => value),
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          failed.push(`${label}: ${Cause.pretty(cause).split("\n")[0]}`);
          return undefined;
        }),
      ),
    );
  const fsStep = (label: string, run: () => void) =>
    attempt(label, Effect.try({ try: run, catch: storage(label) }));

  // --- Who -----------------------------------------------------------------------------------
  let user: LogicPacksUser | null = null;
  let userId: string;
  if ("email" in target) {
    const email = normalizeEmail(target.email);
    if (email === null) {
      return yield* new MemberDeletionError({
        reason: "invalid_target",
        message: `${target.email} is not an email address.`,
      });
    }
    const users = yield* access.listUsers().pipe(Effect.mapError(storage("finding the user")));
    user = users.find((candidate) => candidate.email === email) ?? null;
    if (user === null) {
      return {
        userId: null,
        email,
        digest: null,
        found: false,
        dryRun,
        deletedProjects,
        keptProjects,
        deletedWorkspaces,
        removed,
        kept,
        skipped: [
          `no member with email ${email} (nothing to do; pass the user id to clean leftovers)`,
        ],
        failed,
      } satisfies MemberDeletionReport;
    }
    userId = user.userId;
  } else {
    userId = target.userId.trim();
    if (userId.length === 0 || userId.includes("/") || userId.includes("..")) {
      return yield* new MemberDeletionError({
        reason: "invalid_target",
        message: "Name the member by email or user id.",
      });
    }
    user = yield* access.getUser(userId).pipe(Effect.mapError(storage("finding the user")));
  }

  const protectedEmails = yield* protectedEmailsOf(host).pipe(
    Effect.mapError(storage("reading staff")),
  );
  if (user !== null && protectedEmails.has(user.email.toLowerCase())) {
    return yield* new MemberDeletionError({
      reason: "protected",
      message: `${user.email} is staff or a protected owner account; it is never deleted.`,
    });
  }

  const digest = userDigest(userId);
  const leaving = new Set([userId, ...(options.alsoLeaving ?? [])]);
  const note = (what: string) => removed.push(dryRun ? `would remove ${what}` : what);

  // --- Workspaces and projects ---------------------------------------------------------------
  const membersOfWorkspace = (workspaceId: string) =>
    access
      .listWorkspaceMembers({ actorUserId: null, workspaceId })
      .pipe(Effect.orElseSucceed(() => []));

  const claimed = options.claimed ?? new Set<string>();
  const myWorkspaces = access
    .listWorkspaces(userId)
    .map((workspace) => workspace.workspaceId)
    .filter((workspaceId) => !claimed.has(workspaceId));
  const projectIds = Array.from(access.visibleProjectIds(userId))
    .filter((projectId) => !claimed.has(projectId))
    .toSorted();

  interface ProjectPlan {
    readonly projectId: string;
    readonly delete: boolean;
    readonly why: string;
    readonly promote: LogicPacksUser | null;
  }
  const projectPlans: Array<ProjectPlan> = [];
  for (const projectId of projectIds) {
    const direct = yield* access
      .listMembers(projectId)
      .pipe(Effect.mapError(storage("reading project members")));
    const workspaceId = access.projectWorkspaceId(projectId);
    const viaWorkspace = workspaceId === null ? [] : yield* membersOfWorkspace(workspaceId);
    const others = [...direct, ...viaWorkspace].filter((entry) => !leaving.has(entry.user.userId));
    const directOwners = direct.filter((entry) => entry.role === "owner");
    const hostWorkspace =
      workspaceId !== null && (yield* access.workspaceCreator(workspaceId)) === null;
    // Members' projects always record their creator as owner; no owner row = the operator's.
    const memberMade =
      directOwners.length > 0 && directOwners.every((entry) => leaving.has(entry.user.userId));
    const onlyTheirs = others.length === 0 && memberMade && !hostWorkspace;
    if (onlyTheirs) {
      projectPlans.push({ projectId, delete: true, why: "only theirs", promote: null });
      continue;
    }
    // Shared on: someone left must still own it.
    const otherOwner = others.some(
      (entry) => access.roleOf(entry.user.userId, projectId) === "owner",
    );
    const iOwnDirectly = directOwners.some((entry) => entry.user.userId === userId);
    const heir =
      iOwnDirectly && !otherOwner
        ? (direct.find((entry) => !leaving.has(entry.user.userId))?.user ?? null)
        : null;
    projectPlans.push({
      projectId,
      delete: false,
      why: hostWorkspace || !memberMade ? "the host's" : `shared with ${others.length} other(s)`,
      promote: heir,
    });
  }

  interface WorkspacePlan {
    readonly workspaceId: string;
    readonly name: string;
    readonly delete: boolean;
    readonly promote: LogicPacksUser | null;
  }
  const workspaceNames = new Map(
    access.listWorkspaces(null).map((workspace) => [workspace.workspaceId, workspace.name]),
  );
  const workspacePlans: Array<WorkspacePlan> = [];
  for (const workspaceId of myWorkspaces) {
    const members = yield* membersOfWorkspace(workspaceId);
    const others = members.filter((entry) => !leaving.has(entry.user.userId));
    const creator = yield* access.workspaceCreator(workspaceId);
    const name = workspaceNames.get(workspaceId) ?? workspaceId;
    if (others.length === 0 && creator !== null) {
      workspacePlans.push({ workspaceId, name, delete: true, promote: null });
      continue;
    }
    const iOwn = members.some((entry) => entry.user.userId === userId && entry.role === "owner");
    const otherOwner = others.some((entry) => entry.role === "owner");
    workspacePlans.push({
      workspaceId,
      name,
      delete: false,
      promote: iOwn && !otherOwner ? (others[0]?.user ?? null) : null,
    });
  }

  for (const plan of projectPlans) {
    const project =
      (yield* attempt(`project ${plan.projectId}`, host.getProject(plan.projectId))) ?? null;
    const label = `${plan.projectId}${project ? ` (${project.title})` : ""}`;
    if (!plan.delete) {
      keptProjects.push(plan.projectId);
      kept.push(
        `project ${label}: ${plan.why}; their access ${dryRun ? "would be" : "was"} dropped` +
          (plan.promote
            ? `, ${plan.promote.email} ${dryRun ? "would become" : "is now"} owner`
            : ""),
      );
      if (!dryRun && plan.promote !== null) {
        yield* attempt(
          `promote ${plan.promote.email} on ${plan.projectId}`,
          access.addMember({
            projectId: plan.projectId,
            actorUserId: null,
            user: plan.promote.email,
            role: "owner",
          }),
        );
      }
      continue;
    }
    deletedProjects.push(plan.projectId);
    note(`project ${label} and its threads`);
    if (!dryRun && project !== null) {
      yield* attempt(`project ${plan.projectId}`, host.deleteProject(plan.projectId));
    }
    // Its folder, only when it is in the host's projects dir or the member's own home.
    if (project !== null) {
      const root = project.workspaceRoot;
      const ours =
        isInside(root, NodePath.join(host.baseDir, "projects")) ||
        isInside(root, sandboxHome(host.baseDir, digest));
      if (!ours) {
        kept.push(`folder ${root}: outside the projects dir, left in place`);
      } else {
        for (const worktree of projectWorktreeDirs(root, host.worktreesDir)) {
          note(`worktree ${worktree}`);
          if (!dryRun) yield* fsStep(`worktree ${worktree}`, () => removeDir(worktree));
        }
        if (NodeFS.existsSync(root)) {
          note(`folder ${root}`);
          if (!dryRun)
            yield* fsStep(`folder ${root}`, () =>
              NodeFS.rmSync(root, { recursive: true, force: true }),
            );
        }
      }
    }
    const shares = yield* attempt(
      `shares of ${plan.projectId}`,
      forgetShareProject(plan.projectId, { dryRun }),
    );
    if (shares) {
      const total = Object.values(shares).reduce((sum, count) => sum + count, 0);
      if (total > 0) note(`${total} invite/link row(s) of ${plan.projectId}`);
    }
    const grants = yield* attempt(
      `expert rows of ${plan.projectId}`,
      experts.forgetProject(plan.projectId, { dryRun }),
    );
    if (grants && grants.grants + grants.requests > 0) {
      note(`${grants.grants} grant(s), ${grants.requests} expert request(s) of ${plan.projectId}`);
    }
    const offers = yield* attempt(
      `offers of ${plan.projectId}`,
      external.forgetProject(plan.projectId, { dryRun }),
    );
    if (offers && offers.offers > 0) {
      note(`${offers.offers} offer(s), ${offers.charges} charge(s) of ${plan.projectId}`);
    }
    const projectRows = yield* attempt(
      `rows of ${plan.projectId}`,
      Effect.gen(function* () {
        let total = 0;
        total += yield* purge(
          sql,
          "logicpacks_external_items",
          "thread_id IN (SELECT thread_id FROM logicpacks_external_sessions WHERE project_id = ?)",
          [plan.projectId],
          dryRun,
        );
        for (const table of [
          "logicpacks_external_sessions",
          "logicpacks_ledger",
          "logicpacks_sync_links",
          "logicpacks_thread_actor",
          "logicpacks_activity",
        ]) {
          total += yield* purge(sql, table, "project_id = ?", [plan.projectId], dryRun);
        }
        if (!dryRun) {
          const forgotten = yield* access.forgetProject(plan.projectId);
          total += Object.values(forgotten).reduce((sum, count) => sum + count, 0);
        }
        return total;
      }),
    );
    if (projectRows)
      note(`${projectRows} access/workspace/ledger/sync/session row(s) of ${plan.projectId}`);
    // Its Unix group.
    const group = projectGroupName(plan.projectId);
    if (!host.manageUnixUsers) {
      skipped.push(
        `group ${group}: Unix steps off (needs LOGICPACKS_MEMBER_SANDBOX=user and root)`,
      );
    } else if (host.os.groupExists(group)) {
      note(`group ${group}`);
      if (!dryRun) {
        const result = host.os.deleteGroup(group);
        if (!result.ok) failed.push(result.detail);
        forgetPreparedProject(plan.projectId);
      }
    }
  }

  for (const plan of workspacePlans) {
    if (plan.delete) {
      deletedWorkspaces.push(plan.workspaceId);
      note(`workspace ${plan.workspaceId} (${plan.name})`);
      if (!dryRun) {
        yield* attempt(
          `workspace ${plan.workspaceId}`,
          access.deleteWorkspace({ actorUserId: null, workspaceId: plan.workspaceId }),
        );
      }
      continue;
    }
    kept.push(
      `workspace ${plan.workspaceId} (${plan.name}): has other members; membership ${dryRun ? "would be" : "was"} dropped` +
        (plan.promote ? `, ${plan.promote.email} ${dryRun ? "would become" : "is now"} owner` : ""),
    );
    if (!dryRun && plan.promote !== null) {
      yield* attempt(
        `promote ${plan.promote.email} in ${plan.workspaceId}`,
        access.setWorkspaceRole({
          actorUserId: null,
          workspaceId: plan.workspaceId,
          userId: plan.promote.userId,
          role: "owner",
        }),
      );
    }
  }

  // --- Provider logins -----------------------------------------------------------------------
  const ownInstances = new Set(MEMBER_PROVIDER_KINDS.map((kind) => memberInstanceId(kind, userId)));
  const configured = yield* attempt("settings.json instances", host.providerInstanceIds);
  for (const instanceId of (configured ?? []).filter((id) => ownInstances.has(id))) {
    note(`provider instance ${instanceId} (settings.json)`);
    if (!dryRun) {
      yield* attempt(`instance ${instanceId}`, host.removeProviderInstance(instanceId));
    }
  }

  const segment = memberDirSegment(userId);
  const secretNames = safeReaddir(host.secretsDir)
    .filter((file) => file.endsWith(".bin"))
    .map((file) => file.slice(0, -".bin".length))
    .filter(
      (name) =>
        (name.startsWith("lp-member-") && name.endsWith(`-${segment}`)) ||
        memberSecretDigest(name) === digest,
    )
    .toSorted();
  for (const name of secretNames) {
    note(`secret ${name}`);
    if (!dryRun) yield* attempt(`secret ${name}`, host.removeSecret(name));
  }

  // Login homes: shred credentials (sealed and plaintext) first, then the whole tree.
  const memberRoot = sandboxHome(host.baseDir, digest);
  const legacyRoot = NodePath.join(host.stateDir, "logicpacks", "members", segment);
  for (const root of [legacyRoot, memberRoot]) {
    if (!NodeFS.existsSync(root)) continue;
    note(`member files ${root}`);
    if (dryRun) continue;
    yield* fsStep(`member files ${root}`, () => {
      for (const kind of MEMBER_PROVIDER_KINDS) {
        const home =
          root === memberRoot ? NodePath.join(root, ".lp", kind) : NodePath.join(root, kind);
        if (NodeFS.existsSync(home)) forgetProviderLogin(home);
      }
      NodeFS.rmSync(root, { recursive: true, force: true });
    });
  }
  for (const dir of [
    NodePath.join(host.baseDir, "sandbox", "bin", digest),
    NodePath.join(host.baseDir, "sandbox", "leases", digest),
  ]) {
    if (!NodeFS.existsSync(dir)) continue;
    note(`sandbox dir ${dir}`);
    if (!dryRun)
      yield* fsStep(`sandbox dir ${dir}`, () =>
        NodeFS.rmSync(dir, { recursive: true, force: true }),
      );
  }

  // --- Unix user -----------------------------------------------------------------------------
  const unixUser = sandboxUserName(digest);
  if (!host.manageUnixUsers) {
    skipped.push(
      `unix user ${unixUser}: Unix steps off (needs LOGICPACKS_MEMBER_SANDBOX=user and root)`,
    );
  } else if (host.os.userExists(unixUser)) {
    note(`unix user ${unixUser} (and its lp-p-* group memberships)`);
    if (!dryRun) {
      const result = host.os.deleteUser(unixUser);
      if (!result.ok) failed.push(result.detail);
    }
  }

  // --- Per-user rows -------------------------------------------------------------------------
  const subject = memberSubject(userId);
  const rowCounts: Record<string, number> = {};
  const rowsStep = Effect.gen(function* () {
    rowCounts["auth_sessions"] = yield* purge(
      sql,
      "auth_sessions",
      "subject = ?",
      [subject],
      dryRun,
    );
    rowCounts["auth_pairing_links"] = yield* purge(
      sql,
      "auth_pairing_links",
      "subject = ?",
      [subject],
      dryRun,
    );
    rowCounts["logicpacks_user_prefs"] = yield* purge(
      sql,
      "logicpacks_user_prefs",
      "owner = ?",
      [userId],
      dryRun,
    );
    // FeatureAccess keeps these in memory; the CLI runs with the service stopped.
    rowCounts["logicpacks_user_features"] = yield* purge(
      sql,
      "logicpacks_user_features",
      "id = ?",
      [userId],
      dryRun,
    );
    for (const table of [
      "logicpacks_turn_usage",
      "logicpacks_thread_actor",
      "logicpacks_activity",
      "logicpacks_achievements",
      "logicpacks_usage_sharing",
    ]) {
      rowCounts[table] = yield* purge(sql, table, "participant_id = ?", [userId], dryRun);
    }
    // Access-code redemptions: their entry goes, `uses` stays as it was.
    let redemptions = 0;
    if (yield* tableExists(sql, "logicpacks_access_codes")) {
      const codes = yield* sql<{ readonly id: string; readonly data: string }>`
        SELECT id, data FROM logicpacks_access_codes
      `;
      for (const row of codes) {
        const code = parseAccessCode(row.data);
        if (code === null) continue;
        const entries = code.redeemedBy ?? [];
        const rest = entries.filter((entry) => entry.userId !== userId);
        if (rest.length === entries.length) continue;
        redemptions += entries.length - rest.length;
        if (!dryRun) {
          yield* sql`
            UPDATE logicpacks_access_codes SET data = ${JSON.stringify({ ...code, redeemedBy: rest })}
            WHERE id = ${row.id}
          `;
        }
      }
    }
    rowCounts["logicpacks_access_codes.redeemedBy"] = redemptions;
  });
  yield* attempt("per-user rows", rowsStep);

  const shareRows = yield* attempt(
    "share invites",
    forgetShareUser({ userId, email: user?.email ?? null }, { dryRun }),
  );
  if (shareRows) {
    rowCounts["logicpacks_project_invites"] = shareRows.invites;
    rowCounts["logicpacks_project_link_joins"] = shareRows.linkJoins;
  }
  const expertRows = yield* attempt("expert grants", experts.forgetUser(userId, { dryRun }));
  if (expertRows) {
    rowCounts["logicpacks_provider_grants"] = expertRows.grants;
    rowCounts["logicpacks_expert_requests"] = expertRows.requests;
  }
  const externalRows = yield* attempt("external offers", external.forgetUser(userId, { dryRun }));
  if (externalRows) {
    rowCounts["logicpacks_external_offers"] = externalRows.offers;
    rowCounts["logicpacks_external_charges"] = externalRows.charges;
    rowCounts["logicpacks_external_offers.applications"] = externalRows.applications;
    rowCounts["logicpacks_external_prefs"] = externalRows.prefs;
    for (const offerId of externalRows.assignedOfferIds) {
      kept.push(`offer ${offerId}: assigns them to someone else's project; end it from /ops`);
    }
  }

  // The account itself, last: a run that stopped half way still finds them by email.
  if (dryRun) {
    for (const [table, column] of [
      ["logicpacks_project_access", "user_id"],
      ["logicpacks_workspace_members", "user_id"],
      ["logicpacks_current_workspace", "viewer"],
      ["logicpacks_sync_pushers", "user_id"],
      ["logicpacks_user_identities", "user_id"],
      ["logicpacks_member_onboarding", "user_id"],
      ["logicpacks_users", "user_id"],
    ] as const) {
      const count = yield* attempt(table, purge(sql, table, `${column} = ?`, [userId], true));
      rowCounts[table] = count ?? 0;
    }
  } else {
    const accountRows = yield* attempt("account rows", access.forgetUser(userId));
    Object.assign(rowCounts, accountRows ?? {});
  }
  for (const [table, count] of Object.entries(rowCounts)) {
    if (count > 0) removed.push(`${dryRun ? "would remove " : ""}${count} row(s) from ${table}`);
  }

  return {
    userId,
    email: user?.email ?? null,
    digest,
    found: user !== null,
    dryRun,
    deletedProjects,
    keptProjects,
    deletedWorkspaces,
    removed,
    kept,
    skipped,
    failed,
  } satisfies MemberDeletionReport;
});

/** Every member except staff and the protected emails; those are listed as kept. */
export const deleteAllMembers = Effect.fn("deleteAllMembers")(function* (
  host: MemberDeletionHost,
  options: { readonly dryRun?: boolean } = {},
) {
  const access = yield* LogicPacksAccess;
  const protectedEmails = yield* protectedEmailsOf(host).pipe(
    Effect.mapError(storage("reading staff")),
  );
  const users = yield* access.listUsers().pipe(Effect.mapError(storage("listing users")));
  const doomed = users.filter((user) => !protectedEmails.has(user.email.toLowerCase()));
  const spared = users.filter((user) => protectedEmails.has(user.email.toLowerCase()));
  const leaving = new Set(doomed.map((user) => user.userId));
  const reports: Array<MemberDeletionReport> = [];
  const claimed = new Set<string>();
  for (const user of doomed) {
    const report = yield* deleteMember(
      host,
      { userId: user.userId },
      { ...options, alsoLeaving: leaving, claimed },
    );
    for (const id of [...report.deletedProjects, ...report.deletedWorkspaces]) claimed.add(id);
    reports.push(report);
  }
  return { reports, spared: spared.map((user) => user.email) };
});

/** Plain text for the CLI. */
export const formatMemberDeletion = (report: MemberDeletionReport): string => {
  const head = report.found
    ? `${report.dryRun ? "[dry run] " : ""}member ${report.email} (${report.userId}, lpm-${report.digest})`
    : `${report.dryRun ? "[dry run] " : ""}${report.email ?? report.userId}: no account row`;
  const section = (title: string, lines: ReadonlyArray<string>) =>
    lines.length === 0 ? [] : [`  ${title}:`, ...lines.map((line) => `    - ${line}`)];
  return [
    head,
    ...section(
      report.dryRun ? "would remove" : "removed",
      report.removed.map((line) => line.replace(/^would remove /, "")),
    ),
    ...section("kept", report.kept),
    ...section("skipped", report.skipped),
    ...section("FAILED", report.failed),
    ...(report.removed.length === 0 && report.failed.length === 0
      ? ["  nothing left to remove"]
      : []),
  ].join("\n");
};
