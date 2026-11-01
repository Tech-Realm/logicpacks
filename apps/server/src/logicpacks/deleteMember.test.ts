// @effect-diagnostics nodeBuiltinImport:off -- the test lays out a host's member folders on disk.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { deleteAllMembers, deleteMember, type MemberDeletionHost } from "./deleteMember.ts";
import { ExpertsService, layer as expertsLayer } from "./ExpertsService.ts";
import { layer as externalLayer } from "./ExternalTeamService.ts";
import { LogicPacksAccess, layer as accessLayer } from "./LogicPacksAccess.ts";
import { memberInstanceId, userDigest } from "./memberProviders.ts";
import { canManageSandboxUsers, projectGroupName, type MemberSandboxOs } from "./memberSandbox.ts";
import { memberSubject } from "./projectAccess.ts";

const makeLayer = () =>
  Layer.mergeAll(accessLayer, expertsLayer, externalLayer).pipe(
    Layer.provideMerge(SqlitePersistence.layerMemory),
  );

interface FakeOs extends MemberSandboxOs {
  readonly calls: Array<string>;
}

const fakeOs = (root: boolean): FakeOs => {
  const calls: Array<string> = [];
  const users = new Set<string>();
  const groups = new Set<string>();
  return {
    calls,
    isRoot: () => root,
    userExists: (user) => {
      // Every lpm-* user "exists" until deleted once.
      if (!users.has(`gone:${user}`)) users.add(user);
      return users.has(user);
    },
    groupExists: (group) => !groups.has(`gone:${group}`),
    deleteUser: (user) => {
      calls.push(`userdel ${user}`);
      users.delete(user);
      users.add(`gone:${user}`);
      return { ok: true, detail: `user ${user}: removed` };
    },
    deleteGroup: (group) => {
      calls.push(`groupdel ${group}`);
      groups.add(`gone:${group}`);
      return { ok: true, detail: `group ${group}: removed` };
    },
  };
};

/** A throwaway host: base dir on disk, projects and settings in memory. */
const makeHost = (options: { readonly os?: FakeOs; readonly manageUnixUsers?: boolean } = {}) => {
  const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lp-delete-member-"));
  const stateDir = NodePath.join(baseDir, "userdata");
  const secretsDir = NodePath.join(stateDir, "secrets");
  const worktreesDir = NodePath.join(baseDir, "worktrees");
  NodeFS.mkdirSync(secretsDir, { recursive: true });
  NodeFS.mkdirSync(worktreesDir, { recursive: true });
  const projects = new Map<string, { title: string; workspaceRoot: string }>();
  const instances = new Set<string>();
  const deletedProjects: Array<string> = [];
  const os = options.os ?? fakeOs(false);
  const host: MemberDeletionHost = {
    baseDir,
    stateDir,
    secretsDir,
    worktreesDir,
    getProject: (projectId) => Effect.succeed(projects.get(projectId) ?? null),
    deleteProject: (projectId) =>
      Effect.sync(() => {
        projects.delete(projectId);
        deletedProjects.push(projectId);
      }),
    providerInstanceIds: Effect.sync(() => Array.from(instances)),
    removeProviderInstance: (instanceId) => Effect.sync(() => void instances.delete(instanceId)),
    removeSecret: (name) =>
      Effect.sync(() => NodeFS.rmSync(NodePath.join(secretsDir, `${name}.bin`), { force: true })),
    os,
    manageUnixUsers: options.manageUnixUsers ?? false,
    protectedEmails: ["owner@example.com"],
  };
  const addProject = (projectId: string, folder: string | null) => {
    const workspaceRoot = folder ?? NodePath.join(baseDir, "projects", projectId);
    NodeFS.mkdirSync(NodePath.join(workspaceRoot, ".git"), { recursive: true });
    projects.set(projectId, { title: projectId, workspaceRoot });
    return workspaceRoot;
  };
  const writeSecret = (name: string) =>
    NodeFS.writeFileSync(NodePath.join(secretsDir, `${name}.bin`), "x");
  return {
    host,
    baseDir,
    secretsDir,
    projects,
    instances,
    deletedProjects,
    addProject,
    writeSecret,
    os,
  };
};

const providerEnvSecret = (instanceId: string, variable: string) =>
  `provider-env-${Buffer.from(instanceId).toString("base64url")}-${variable}`;

it.effect("deletes a member: own project goes, shared and host projects stay", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const access = yield* LogicPacksAccess;
    const experts = yield* ExpertsService;
    const fixture = makeHost();
    const ana = yield* access.signUp({ email: "ana@example.com", password: "correct-horse" });
    const bo = yield* access.signUp({ email: "bo@example.com", password: "correct-horse" });
    const anaWorkspace = access.currentWorkspaceId(ana.userId)!;
    const anaDigest = userDigest(ana.userId);

    // Her own project, with a worktree.
    const ownRoot = fixture.addProject("p-own", null);
    yield* access.recordOwner("p-own", ana.userId);
    yield* access.attachProject("p-own", anaWorkspace);
    const worktree = NodePath.join(fixture.baseDir, "worktrees", "p-own", "feature");
    NodeFS.mkdirSync(worktree, { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(worktree, ".git"),
      `gitdir: ${NodePath.join(ownRoot, ".git", "worktrees", "feature")}\n`,
    );
    // Her project shared with Bo.
    fixture.addProject("p-shared", null);
    yield* access.recordOwner("p-shared", ana.userId);
    yield* access.attachProject("p-shared", anaWorkspace);
    yield* access.addMember({ projectId: "p-shared", actorUserId: ana.userId, user: bo.email });
    // The operator's project, shared with her.
    fixture.addProject("p-host", null);
    yield* access.addMember({ projectId: "p-host", actorUserId: null, user: ana.email });

    // Logins, secrets, sandbox files.
    fixture.instances.add(memberInstanceId("claude", ana.userId));
    fixture.instances.add(memberInstanceId("codex", bo.userId));
    fixture.instances.add("claudeAgent");
    fixture.writeSecret(`lp-member-github-${ana.userId}`);
    fixture.writeSecret(
      providerEnvSecret(memberInstanceId("claude", ana.userId), "ANTHROPIC_API_KEY"),
    );
    fixture.writeSecret(`lp-member-github-${bo.userId}`);
    fixture.writeSecret(providerEnvSecret(memberInstanceId("codex", bo.userId), "OPENAI_API_KEY"));
    const memberRoot = NodePath.join(fixture.baseDir, "members", anaDigest);
    NodeFS.mkdirSync(NodePath.join(memberRoot, ".lp", "claude"), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(memberRoot, ".lp", "claude", ".credentials.json.lpvault"),
      "sealed",
    );
    const legacy = NodePath.join(
      fixture.baseDir,
      "userdata",
      "logicpacks",
      "members",
      ana.userId,
      "codex",
    );
    NodeFS.mkdirSync(legacy, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(legacy, "auth.json"), "{}");
    const wrapperDir = NodePath.join(fixture.baseDir, "sandbox", "bin", anaDigest);
    NodeFS.mkdirSync(wrapperDir, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(wrapperDir, "claude"), "#!/bin/sh\n");
    const leaseDir = NodePath.join(fixture.baseDir, "sandbox", "leases", anaDigest, "claude");
    NodeFS.mkdirSync(leaseDir, { recursive: true });

    // Per-user rows.
    yield* access.setOnboardingChoice(ana.userId, "pro");
    yield* sql`CREATE TABLE IF NOT EXISTS logicpacks_user_prefs (owner TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (owner, key))`;
    yield* sql`INSERT INTO logicpacks_user_prefs VALUES (${ana.userId}, 'layout', '{}', 'now')`;
    yield* sql`CREATE TABLE IF NOT EXISTS logicpacks_user_features (id TEXT PRIMARY KEY, data TEXT NOT NULL)`;
    yield* sql`INSERT INTO logicpacks_user_features VALUES (${ana.userId}, '{}'), (${bo.userId}, '{}')`;
    yield* sql`CREATE TABLE IF NOT EXISTS logicpacks_access_codes (id TEXT PRIMARY KEY, data TEXT NOT NULL)`;
    const code = {
      id: "code-1",
      uses: 2,
      redeemedBy: [
        { userId: ana.userId, atMs: 1 },
        { userId: bo.userId, atMs: 2 },
      ],
    };
    yield* sql`INSERT INTO logicpacks_access_codes VALUES ('hash-1', ${JSON.stringify(code)})`;
    yield* sql`
      INSERT INTO auth_sessions (session_id, subject, scopes, method, issued_at, expires_at)
      VALUES ('s-ana', ${memberSubject(ana.userId)}, '[]', 'browser-session-cookie', 'now', 'later'),
             ('s-bo', ${memberSubject(bo.userId)}, '[]', 'browser-session-cookie', 'now', 'later')
    `;
    yield* experts.putGrant({
      id: "grant-1",
      projectId: "p-host",
      ownerUserId: null,
      ownerName: "Host",
      granteeUserId: ana.userId,
      instanceIds: ["claudeAgent"],
      requestId: null,
      createdAtMs: 1,
      revokedAtMs: null,
    });

    // A dry run changes nothing.
    const dry = yield* deleteMember(fixture.host, { email: "ANA@example.com" }, { dryRun: true });
    assert.isTrue(dry.found);
    assert.deepStrictEqual(dry.deletedProjects, ["p-own"]);
    assert.isNotNull(yield* access.getUser(ana.userId));
    assert.isTrue(NodeFS.existsSync(ownRoot));
    assert.isTrue(fixture.instances.has(memberInstanceId("claude", ana.userId)));

    const report = yield* deleteMember(fixture.host, { email: "ana@example.com" });
    assert.deepStrictEqual(report.failed, []);
    assert.deepStrictEqual(report.deletedProjects, ["p-own"]);
    assert.sameMembers([...report.keptProjects], ["p-shared", "p-host"]);
    assert.deepStrictEqual(report.deletedWorkspaces, [anaWorkspace]);
    assert.deepStrictEqual(fixture.deletedProjects, ["p-own"]);

    // Account and rows.
    assert.isNull(yield* access.getUser(ana.userId));
    assert.isNotNull(yield* access.getUser(bo.userId));
    assert.isNull(access.onboardingChoice(ana.userId));
    assert.strictEqual(access.roleOf(ana.userId, "p-shared"), null);
    assert.strictEqual(access.roleOf(ana.userId, "p-host"), null);
    assert.strictEqual(access.roleOf(bo.userId, "p-shared"), "owner");
    assert.strictEqual(access.roleOf(bo.userId, "p-own"), null);
    assert.isFalse(access.listWorkspaces(null).some((w) => w.workspaceId === anaWorkspace));
    const sessions = yield* sql<{
      readonly session_id: string;
    }>`SELECT session_id FROM auth_sessions`;
    assert.deepStrictEqual(
      sessions.map((row) => row.session_id),
      ["s-bo"],
    );
    const features = yield* sql<{ readonly id: string }>`SELECT id FROM logicpacks_user_features`;
    assert.deepStrictEqual(
      features.map((row) => row.id),
      [bo.userId],
    );
    const prefs = yield* sql<{
      readonly n: number;
    }>`SELECT COUNT(*) AS n FROM logicpacks_user_prefs`;
    assert.strictEqual(prefs[0]?.n, 0);
    const codes = yield* sql<{ readonly data: string }>`SELECT data FROM logicpacks_access_codes`;
    const after = JSON.parse(codes[0]!.data) as typeof code;
    assert.strictEqual(after.uses, 2);
    assert.deepStrictEqual(after.redeemedBy, [{ userId: bo.userId, atMs: 2 }]);
    assert.strictEqual(experts.grants().length, 0);

    // Files, logins, secrets.
    assert.isFalse(NodeFS.existsSync(ownRoot));
    assert.isFalse(NodeFS.existsSync(worktree));
    assert.isTrue(NodeFS.existsSync(fixture.projects.get("p-shared")!.workspaceRoot));
    assert.isFalse(NodeFS.existsSync(memberRoot));
    assert.isFalse(NodeFS.existsSync(NodePath.dirname(legacy)));
    assert.isFalse(NodeFS.existsSync(wrapperDir));
    assert.isFalse(NodeFS.existsSync(NodePath.dirname(leaseDir)));
    assert.sameMembers(Array.from(fixture.instances), [
      memberInstanceId("codex", bo.userId),
      "claudeAgent",
    ]);
    assert.sameMembers(NodeFS.readdirSync(fixture.secretsDir), [
      `lp-member-github-${bo.userId}.bin`,
      `${providerEnvSecret(memberInstanceId("codex", bo.userId), "OPENAI_API_KEY")}.bin`,
    ]);

    // Not root: Unix steps are reported as skipped, never run.
    assert.isTrue(report.skipped.some((line) => line.startsWith(`unix user lpm-${anaDigest}`)));
    assert.deepStrictEqual(fixture.os.calls, []);

    // Idempotent: nothing left either way.
    const again = yield* deleteMember(fixture.host, { email: "ana@example.com" });
    assert.isFalse(again.found);
    assert.deepStrictEqual(again.removed, []);
    const byId = yield* deleteMember(fixture.host, { userId: ana.userId });
    assert.isFalse(byId.found);
    assert.deepStrictEqual(byId.removed, []);
    assert.deepStrictEqual(byId.failed, []);
    assert.deepStrictEqual(fixture.deletedProjects, ["p-own"]);
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("refuses staff and protected owner accounts", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const access = yield* LogicPacksAccess;
    const fixture = makeHost();
    yield* access.signUp({ email: "owner@example.com", password: "correct-horse" });
    yield* access.signUp({ email: "staff@example.com", password: "correct-horse" });
    yield* access.signUp({ email: "test@example.com", password: "correct-horse" });
    yield* sql`CREATE TABLE IF NOT EXISTS logicpacks_staff (id TEXT PRIMARY KEY, data TEXT NOT NULL)`;
    yield* sql`INSERT INTO logicpacks_staff VALUES ('staff@example.com', '{}')`;

    const owner = yield* deleteMember(fixture.host, { email: "owner@example.com" }).pipe(
      Effect.flip,
    );
    assert.strictEqual(owner.reason, "protected");
    const staff = yield* deleteMember(fixture.host, { email: "staff@example.com" }).pipe(
      Effect.flip,
    );
    assert.strictEqual(staff.reason, "protected");

    const all = yield* deleteAllMembers(fixture.host);
    assert.sameMembers([...all.spared], ["owner@example.com", "staff@example.com"]);
    assert.deepStrictEqual(
      all.reports.map((report) => report.email),
      ["test@example.com"],
    );
    assert.sameMembers(
      (yield* access.listUsers()).map((user) => user.email),
      ["owner@example.com", "staff@example.com"],
    );
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("--all-members: a project shared only between leaving members goes too", () =>
  Effect.gen(function* () {
    const access = yield* LogicPacksAccess;
    const fixture = makeHost();
    const ana = yield* access.signUp({ email: "ana2@example.com", password: "correct-horse" });
    const bo = yield* access.signUp({ email: "bo2@example.com", password: "correct-horse" });
    fixture.addProject("p-pair", null);
    yield* access.recordOwner("p-pair", ana.userId);
    yield* access.attachProject("p-pair", access.currentWorkspaceId(ana.userId)!);
    yield* access.addMember({ projectId: "p-pair", actorUserId: ana.userId, user: bo.email });

    const dry = yield* deleteAllMembers(fixture.host, { dryRun: true });
    assert.deepStrictEqual(
      dry.reports.flatMap((report) => report.deletedProjects),
      ["p-pair"],
    );
    assert.strictEqual((yield* access.listUsers()).length, 2);

    const done = yield* deleteAllMembers(fixture.host);
    assert.deepStrictEqual(
      done.reports.flatMap((report) => report.failed),
      [],
    );
    assert.deepStrictEqual(fixture.deletedProjects, ["p-pair"]);
    assert.strictEqual((yield* access.listUsers()).length, 0);
    assert.strictEqual(access.listWorkspaces(null).length, 0);
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("sandbox Unix steps: skipped unless sandboxed and root; run once when they are", () =>
  Effect.gen(function* () {
    const access = yield* LogicPacksAccess;
    const notRoot = fakeOs(false);
    assert.isFalse(canManageSandboxUsers({ LOGICPACKS_MEMBER_SANDBOX: "user" }, notRoot));
    assert.isFalse(canManageSandboxUsers({}, fakeOs(true)));
    assert.isTrue(canManageSandboxUsers({ LOGICPACKS_MEMBER_SANDBOX: "user" }, fakeOs(true)));

    const rootOs = fakeOs(true);
    const fixture = makeHost({ os: rootOs, manageUnixUsers: true });
    const cy = yield* access.signUp({ email: "cy@example.com", password: "correct-horse" });
    fixture.addProject("p-cy", null);
    yield* access.recordOwner("p-cy", cy.userId);
    yield* access.attachProject("p-cy", access.currentWorkspaceId(cy.userId)!);

    const report = yield* deleteMember(fixture.host, { email: "cy@example.com" });
    assert.deepStrictEqual(report.failed, []);
    assert.deepStrictEqual(rootOs.calls, [
      `groupdel ${projectGroupName("p-cy")}`,
      `userdel lpm-${userDigest(cy.userId)}`,
    ]);
    // Second run: the user and group are gone, nothing is called again.
    yield* deleteMember(fixture.host, { userId: cy.userId });
    assert.strictEqual(rootOs.calls.length, 2);
  }).pipe(Effect.provide(makeLayer())),
);
