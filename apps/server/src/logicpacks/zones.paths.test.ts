// @effect-diagnostics nodeBuiltinImport:off -- real temp folders for the sandbox launch test.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";
import {
  normalizeZones,
  zonesForPreset,
  canReadSecrets,
} from "@logicpacks/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { runLedgerTool } from "./ledgerHttp.ts";
import { LogicPacksAccess, layer as accessLayer } from "./LogicPacksAccess.ts";
import { ProjectGoals } from "./ProjectGoals.ts";
import { ProjectLedger } from "./ProjectLedger.ts";
import { READ_ONLY_MESSAGE } from "./readOnlyMessage.ts";
import { refuseIfReadOnly } from "./readOnly.ts";
import { hiddenSecretTest, refuseIfZone } from "./zoneHttp.ts";
import { limitsForRun, registerMemberMessage, clearRunSenders } from "./runLimits.ts";
import {
  clearTerminalOwners,
  captureFirstCommand,
  memberTerminalEnv,
  memberTerminalLaunch,
  ownerOfTerminal,
  registerTerminal,
} from "./memberTerminalRegistry.ts";
import { layerTerminalReaper } from "./memberTerminals.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as SqlClient from "effect/sql/SqlClient";
import { NEW_WORKSPACE_MESSAGE, PROJECTS_OFF_MESSAGE } from "@logicpacks/contracts";
import { hostWriteAllowedForThread } from "./runLimits.ts";
import { refuseIfProjectsOff } from "./zoneHttp.ts";

const decode = (response: { readonly body?: unknown } | null) =>
  response === null
    ? null
    : (JSON.parse(new TextDecoder().decode((response.body as { body?: Uint8Array }).body)) as {
        error: string;
        message: string;
      });

const closed: Array<string> = [];
const reaperLayer = layerTerminalReaper.pipe(
  Layer.provideMerge(
    Layer.mock(TerminalManager.TerminalManager)({
      close: (input: { threadId: string; terminalId?: string }) =>
        Effect.sync(() => {
          closed.push(`${input.threadId}/${input.terminalId}`);
        }),
    } as never),
  ),
  Layer.provideMerge(accessLayer),
  Layer.provideMerge(SqlitePersistence.layerMemory),
);

const world = (tag: string) =>
  Effect.gen(function* () {
    const access = yield* LogicPacksAccess;
    const owner = yield* access.signUp({ email: `o-${tag}@x.com`, password: "correct-horse" });
    yield* access.recordOwner(`p-${tag}`, owner.userId);
    const bo = yield* access.signUp({ email: `b-${tag}@x.com`, password: "correct-horse" });
    yield* access.addMember({ projectId: `p-${tag}`, actorUserId: owner.userId, user: bo.email });
    const set = (preset: Parameters<typeof zonesForPreset>[0]) =>
      access.setMemberZones({
        projectId: `p-${tag}`,
        actorUserId: owner.userId,
        userId: bo.userId,
        zones: zonesForPreset(preset),
      });
    return { access, owner, bo, set, projectId: `p-${tag}` };
  });

it.layer(reaperLayer)("access zones: HTTP, ws terminal, MCP ledger tools, agent runs", (it) => {
  it.effect("HTTP: files.write / files.read / compute refused per preset, host and helper never refused", () =>
    Effect.gen(function* () {
      const { bo, set, projectId } = yield* world("http");
      const member = { kind: "member", userId: bo.userId } as const;
      const refused = (need: Parameters<typeof refuseIfZone>[2]) =>
        refuseIfZone(member, projectId, need).pipe(Effect.map((r) => decode(r)?.error ?? null));
      yield* set("chat");
      assert.strictEqual(yield* refused(["files.write"]), "zone_off");
      assert.strictEqual(yield* refused(["files.read"]), "zone_off");
      assert.strictEqual(yield* refused(["compute"]), "zone_off");
      yield* set("edit");
      assert.strictEqual(yield* refused(["files.write"]), null);
      assert.strictEqual(yield* refused(["files.read"]), null);
      assert.strictEqual(yield* refused(["compute"]), "zone_off");
      yield* set("readonly");
      assert.strictEqual(yield* refused(["files.read"]), null);
      assert.strictEqual(yield* refused(["files.write"]), "zone_off");
      yield* set("full");
      assert.strictEqual(yield* refused(["compute"]), null);
      assert.isNull(yield* refuseIfZone({ kind: "operator" }, projectId, ["compute"]));
      assert.isNull(yield* refuseIfZone({ kind: "anonymous" }, projectId, ["compute"]));
      const message = decode(
        yield* Effect.gen(function* () {
          yield* set("chat");
          return yield* refuseIfZone(member, projectId, ["files.write"]);
        }),
      );
      assert.include(message?.message ?? "", "does not include its files");
    }),
  );

  it.effect("HTTP: secret files are hidden for Can edit and shown for Full access", () =>
    Effect.gen(function* () {
      const { bo, set, projectId } = yield* world("sec");
      const member = { kind: "member", userId: bo.userId } as const;
      yield* set("edit");
      const hidden = yield* hiddenSecretTest(member, projectId);
      assert.isNotNull(hidden);
      assert.isTrue(hidden!(".env"));
      assert.isTrue(hidden!("config/prod.pem"));
      assert.isFalse(hidden!("src/index.ts"));
      yield* set("full");
      assert.isNull(yield* hiddenSecretTest(member, projectId));
      assert.isNull(yield* hiddenSecretTest({ kind: "operator" }, projectId));
    }),
  );

  it.effect("HTTP: Read only through a seat and through an override are the same system", () =>
    Effect.gen(function* () {
      const { access, owner, bo, set, projectId } = yield* world("viewer");
      const member = { kind: "member", userId: bo.userId } as const;
      yield* set("readonly");
      const viaOverride = decode(yield* refuseIfReadOnly(member, projectId));
      assert.strictEqual(viaOverride?.error, "read_only");
      assert.strictEqual(viaOverride?.message, READ_ONLY_MESSAGE);
      yield* set("edit");
      assert.isNull(yield* refuseIfReadOnly(member, projectId));
      // A workspace Read only seat: derived the same way, and it beats the override.
      const workspace = yield* access.createWorkspace({ actorUserId: owner.userId, name: "W" });
      yield* access.attachProject(projectId, workspace.workspaceId);
      yield* access.addWorkspaceMember({
        actorUserId: owner.userId,
        workspaceId: workspace.workspaceId,
        user: bo.email,
        role: "viewer",
      });
      assert.strictEqual(access.roleOf(bo.userId, projectId), "viewer");
      assert.strictEqual(access.zonesOf(bo.userId, projectId).source, "seat");
      assert.strictEqual(decode(yield* refuseIfReadOnly(member, projectId))?.error, "read_only");
    }),
  );

  it.effect("MCP ledger tools: a Read only seat's agent cannot write, a Chat only seat's can", () =>
    Effect.gen(function* () {
      const { bo, set, projectId } = yield* world("mcp");
      const ledger = Layer.mock(ProjectLedger)({
        view: () =>
          Effect.succeed({
            threads: [{ threadId: "t-bo", members: [{ id: bo.userId, name: "Bo" }] }],
            decisions: [],
            conflicts: [],
          } as never),
        note: () => Effect.void,
      } as never);
      const run = (tool: "note" | "conflicts") =>
        runLedgerTool({ projectId, threadId: "t-bo", name: "agent", tool, args: { goal: "x" } }).pipe(
          Effect.provide(Layer.mergeAll(ledger, Layer.mock(ProjectGoals)({} as never))),
        );
      yield* set("readonly");
      assert.strictEqual((yield* run("note").pipe(Effect.flip)).message, READ_ONLY_MESSAGE);
      assert.isString(yield* run("conflicts"));
      yield* set("chat");
      assert.isString(yield* run("conflicts"));
      assert.isNotNull(yield* run("note").pipe(Effect.option));
    }),
  );

  it.effect("ws terminal: live revocation closes the member's terminals and logs it", () =>
    Effect.gen(function* () {
      clearTerminalOwners();
      closed.length = 0;
      const { access, bo, set, projectId } = yield* world("term");
      yield* set("full");
      registerTerminal({ userId: bo.userId, projectId, threadId: "t9", terminalId: "a", folders: ["/p"], mode: "sandboxed", memberHome: "/home/bo", stateDir: "/tmp/x" });
      registerTerminal({ userId: null, projectId, threadId: "t9", terminalId: "host" });
      yield* set("full");
      yield* TestClock.adjust("30 millis");
      assert.deepStrictEqual(closed, []);
      yield* set("edit");
      yield* TestClock.adjust("100 millis");
      assert.deepStrictEqual(closed, ["t9/a"]);
      assert.isUndefined(ownerOfTerminal("t9", "a"));
      assert.isDefined(ownerOfTerminal("t9", "host"));
      assert.isTrue(access.accessLog(projectId).some((entry) => entry.kind === "terminal.revoked"));
    }),
  );

  it("terminal launch: scrubbed environment; sandboxed on macOS, refused (fail closed) where it cannot be", () => {
    clearTerminalOwners();
    const base = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lp-term-"));
    const proj = NodePath.join(base, "proj");
    NodeFS.mkdirSync(proj);
    registerTerminal({
      userId: "u1",
      projectId: "p",
      threadId: "t",
      terminalId: "x",
      folders: [proj],
      mode: "sandboxed",
      memberHome: NodePath.join(base, "home"),
      stateDir: NodePath.join(base, "state"),
    });
    const input = {
      threadId: "t",
      terminalId: "x",
      command: "/bin/zsh",
      args: ["-l"],
      env: { PATH: "/usr/bin", GH_TOKEN: "secret", ANTHROPIC_API_KEY: "k", HOME: "/Users/host", LANG: "en_US.UTF-8" },
      exists: () => true,
    };
    if (process.platform === "darwin") {
      const launch = memberTerminalLaunch({ ...input, platform: "darwin" });
      assert.isTrue(launch !== null && !("error" in launch));
      if (launch !== null && !("error" in launch)) {
        assert.strictEqual(launch.command, "/usr/bin/sandbox-exec");
        assert.strictEqual(launch.args[0], "-f");
        assert.deepStrictEqual(launch.args.slice(2), ["/bin/zsh", "-l"]);
        assert.include(NodeFS.readFileSync(launch.args[1] ?? "", "utf8"), `(subpath "${NodeFS.realpathSync(proj)}")`);
        assert.strictEqual(launch.env.GH_TOKEN, undefined);
        assert.strictEqual(launch.env.ANTHROPIC_API_KEY, undefined);
        assert.strictEqual(launch.env.HOME, NodePath.join(base, "home"));
        assert.strictEqual(launch.env.LANG, "en_US.UTF-8");
      }
    }
    // Where no sandbox exists the terminal does NOT start: an error, never an unsandboxed shell.
    for (const platform of ["linux", "win32"] as const) {
      const refused = memberTerminalLaunch({ ...input, platform });
      assert.isTrue(refused !== null && "error" in refused, platform);
    }
    const noTool = memberTerminalLaunch({ ...input, platform: "darwin", exists: () => false });
    assert.isTrue(noTool !== null && "error" in noTool);
    // A forced sandbox failure (test hook) refuses the terminal even on macOS.
    process.env.LOGICPACKS_TEST_FORCE_SANDBOX_FAILURE = "1";
    try {
      const forced = memberTerminalLaunch({ ...input, platform: "darwin" });
      assert.isTrue(forced !== null && "error" in forced, "forced failure must refuse");
    } finally {
      delete process.env.LOGICPACKS_TEST_FORCE_SANDBOX_FAILURE;
    }
    // Unrestricted (Full access) is the host's shell, scrubbed but not sandboxed.
    registerTerminal({ userId: "u3", projectId: "p", threadId: "t", terminalId: "free", mode: "unrestricted", memberHome: "/m/u3" });
    const free = memberTerminalLaunch({ ...input, terminalId: "free", platform: "linux" });
    assert.isTrue(free !== null && !("error" in free) && free.sandboxed === false);
    // The host's own terminals are untouched.
    registerTerminal({ userId: null, projectId: "p", threadId: "t", terminalId: "hostterm" });
    assert.isNull(memberTerminalLaunch({ ...input, terminalId: "hostterm", platform: "darwin" }));
    assert.strictEqual(memberTerminalEnv({ SystemRoot: "C:\\Windows", GH_TOKEN: "x" }, "C:\\m", "win32").GH_TOKEN, undefined);
    NodeFS.rmSync(base, { recursive: true, force: true });
  });

  it("terminal activity: the first command line is captured once, secrets redacted", () => {
    const owner = registerTerminal({ userId: "u2", projectId: "p", threadId: "t2", terminalId: "y" });
    assert.isNull(captureFirstCommand(owner, "echo h"));
    assert.strictEqual(captureFirstCommand(owner, "i\r"), "echo hi");
    assert.isNull(captureFirstCommand(owner, "ls\r"));
  });

  it("agent runs: a member's run keeps to the sender's zones, read when the run starts", () => {
    clearRunSenders();
    assert.isUndefined(limitsForRun({ messageId: "host-message" }));
    registerMemberMessage("t", "m1", { userId: "nobody", projectId: "p-none" });
    // Whatever the limiter returns for an unknown seat is no wider than Read only.
    const limits = limitsForRun({ messageId: "m1" });
    assert.isFalse(limits?.shell);
    assert.isFalse(limits?.edits);
    assert.isTrue(limits?.hideSecrets);
    assert.isFalse(canReadSecrets(normalizeZones({})));
    // A message another agent sent from the member's thread inherits that thread's limits.
    registerMemberMessage("child-parent", "m2", { userId: "nobody", projectId: "p-none" });
    assert.isFalse(limitsForRun({ messageId: "agent-made", senderThreadId: "child-parent" })?.shell);
  });

  it.effect("Projects zone, HTTP (/api/lp/workspaces, /projects/new, /sync/import, onboarding): refused until granted", () =>
    Effect.gen(function* () {
      const { bo, set, projectId, access } = yield* world("projz");
      const member = { kind: "member", userId: bo.userId } as const;
      for (const preset of ["chat", "edit", "readonly"] as const) {
        yield* set(preset);
        assert.isFalse(access.canCreateProjects(bo.userId), preset);
        const refused = decode(yield* refuseIfProjectsOff(member));
        assert.strictEqual(refused?.error, "zone_off");
        assert.strictEqual(refused?.message, PROJECTS_OFF_MESSAGE);
      }
      assert.strictEqual(decode(yield* refuseIfProjectsOff(member, "workspace"))?.message, NEW_WORKSPACE_MESSAGE);
      yield* set("full");
      assert.isTrue(access.canCreateProjects(bo.userId));
      assert.isNull(yield* refuseIfProjectsOff(member));
      assert.isNull(yield* refuseIfProjectsOff({ kind: "operator" }));
      assert.isNotNull(projectId);
    }),
  );

  it.effect("Projects zone, MCP project tools: a member's agent needs Projects or Compute", () =>
    Effect.gen(function* () {
      const { bo, set, projectId } = yield* world("projmcp");
      registerMemberMessage("thread-mcp", "msg-mcp", { userId: bo.userId, projectId });
      yield* set("edit");
      assert.isFalse(hostWriteAllowedForThread("thread-mcp"));
      yield* set("full");
      assert.isTrue(hostWriteAllowedForThread("thread-mcp"));
      assert.isTrue(hostWriteAllowedForThread("thread-the-host-drives"));
    }),
  );

  it.effect("Projects zone migration: accounts that existed before keep it, later ones start off", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const first = yield* LogicPacksAccess;
      const owner = yield* first.signUp({ email: "mig-owner@x.com", password: "correct-horse" });
      yield* first.recordOwner("p-mig", owner.userId);
      const legacy = yield* first.signUp({ email: "mig-legacy@x.com", password: "correct-horse" });
      yield* first.addMember({ projectId: "p-mig", actorUserId: owner.userId, user: legacy.email });
      // A zone row written before the Projects zone existed has no projects.create key.
      yield* sql`
        INSERT INTO logicpacks_project_zones (project_id, user_id, zones, updated_by, updated_at)
        VALUES ('p-mig', ${legacy.userId}, '{"ai.agents":"claude","files.level":"write","files.secrets":"hidden","compute.terminal":"off"}', NULL, 'x')
      `;
      // Replay the first run of the new version against this database.
      yield* sql`DELETE FROM logicpacks_zone_migrations`;
      yield* sql`DELETE FROM logicpacks_projects_grandfathered`;
      const second = yield* Layer.build(Layer.fresh(accessLayer)).pipe(
        Effect.map((context) => context.pipe((c) => c)),
      );
      const reloaded = (yield* Effect.service(LogicPacksAccess).pipe(Effect.provide(second)));
      const later = yield* reloaded.signUp({ email: "mig-later@x.com", password: "correct-horse" });
      yield* reloaded.addMember({ projectId: "p-mig", actorUserId: owner.userId, user: later.email });
      assert.isTrue(reloaded.canCreateProjects(legacy.userId));
      assert.strictEqual(reloaded.zonesOf(legacy.userId, "p-mig").zones["projects.create"], "on");
      assert.isFalse(reloaded.canCreateProjects(later.userId));
      assert.strictEqual(reloaded.zonesOf(later.userId, "p-mig").zones["projects.create"], "off");
    }),
  );

  it.effect("old-shape seats keep working after the update: terminal on stays Unrestricted, projects stay on, link default too", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const first = yield* LogicPacksAccess;
      const owner = yield* first.signUp({ email: "old-owner@x.com", password: "correct-horse" });
      yield* first.recordOwner("p-old", owner.userId);
      const old = yield* first.signUp({ email: "old-member@x.com", password: "correct-horse" });
      yield* first.addMember({ projectId: "p-old", actorUserId: owner.userId, user: old.email });
      // Written by the version before the Projects zone and the Compute mode.
      yield* sql`
        INSERT INTO logicpacks_project_zones (project_id, user_id, zones, updated_by, updated_at)
        VALUES ('p-old', ${old.userId}, '{"ai.agents":"claude,codex","files.level":"write","files.secrets":"granted","compute.terminal":"on"}', NULL, 'x'),
               ('p-old', '*', '{"ai.agents":"claude","files.level":"write","files.secrets":"hidden","compute.terminal":"off"}', NULL, 'x')
      `;
      yield* sql`DELETE FROM logicpacks_zone_migrations`;
      yield* sql`DELETE FROM logicpacks_projects_grandfathered`;
      const second = yield* Layer.build(Layer.fresh(accessLayer));
      const started = yield* Effect.service(LogicPacksAccess).pipe(Effect.provide(second));
      const zones = started.zonesOf(old.userId, "p-old").zones;
      assert.strictEqual(zones["compute.terminal"], "on");
      assert.strictEqual(zones["compute.mode"], "unrestricted");
      assert.strictEqual(zones["projects.create"], "on");
      assert.strictEqual(zones["files.folders"], "");
      assert.isTrue(started.canCreateProjects(old.userId));
      // The share link's old default has no folder limit and no shell, as before.
      const fresh = yield* started.signUp({ email: "old-newcomer@x.com", password: "correct-horse" });
      yield* started.addMember({ projectId: "p-old", actorUserId: owner.userId, user: fresh.email });
      const freshZones = started.zonesOf(fresh.userId, "p-old").zones;
      assert.strictEqual(freshZones["compute.terminal"], "off");
      assert.strictEqual(freshZones["files.folders"], "");
      // New shares that turn the terminal on start Sandboxed unless Unrestricted is chosen on purpose.
      assert.strictEqual(normalizeZones({ "compute.terminal": "on" })["compute.mode"], "sandboxed");
    }),
  );
});
