// @effect-diagnostics nodeBuiltinImport:off -- the fence reads real directories; the test makes some.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  zonesForPreset,
  normalizeZones,
  COMPUTE_OFF_MESSAGE,
  FILES_OFF_MESSAGE,
  FILES_READ_ONLY_MESSAGE,
  SECRET_FILE_MESSAGE,
  PROJECTS_OFF_MESSAGE,
} from "@logicpacks/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { LogicPacksAccess, layer as accessLayer } from "./LogicPacksAccess.ts";
import { makeMemberFence } from "./memberFence.ts";
import { clearTerminalOwners, ownerOfTerminal } from "./memberTerminalRegistry.ts";
import { READ_ONLY_MESSAGE } from "./readOnlyMessage.ts";
import { memberSubject } from "./projectAccess.ts";
import { OUTSIDE_FOLDERS_MESSAGE } from "./zoneHttp.ts";

const root = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lp-zones-")));
const projectRoot = NodePath.join(root, "proj");
NodeFS.mkdirSync(projectRoot, { recursive: true });

const layer = Layer.mergeAll(
  Layer.mock(ThreadManagementService.ThreadManagementService)({
    getThreadShell: () =>
      Effect.succeed({
        projectId: "p-zones",
        modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
      } as never),
  }),
  Layer.mock(ProjectStore.ProjectStoreV2)({
    listShells: () =>
      Effect.succeed([{ id: "p-zones", workspaceRoot: projectRoot, title: "Zones" }] as never),
  }),
).pipe(
  Layer.provideMerge(accessLayer),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provideMerge(ServerConfig.layerTest(root, { prefix: "lp-zones-config-" })),
  Layer.provideMerge(NodeServices.layer),
);

const setup = (tag: string) =>
  Effect.gen(function* () {
    clearTerminalOwners();
    const access = yield* LogicPacksAccess;
    const owner = yield* access.signUp({ email: `own-${tag}@example.com`, password: "correct-horse" });
    yield* access.recordOwner("p-zones", owner.userId).pipe(Effect.ignore);
    const bo = yield* access.signUp({ email: `bo-${tag}@example.com`, password: "correct-horse" });
    yield* access.addMember({
      projectId: "p-zones",
      actorUserId: owner.userId,
      user: bo.email,
    });
    const fence = yield* makeMemberFence(memberSubject(bo.userId));
    assert.isNotNull(fence);
    const setZones = (preset: Parameters<typeof zonesForPreset>[0]) =>
      access.setMemberZones({
        projectId: "p-zones",
        actorUserId: owner.userId,
        userId: bo.userId,
        zones: zonesForPreset(preset),
      });
    return { access, owner, bo, fence: fence!, setZones };
  });

const message = (fence: { check: (m: string, p: unknown) => Effect.Effect<void, { message: string }> }, method: string, payload: unknown) =>
  fence.check(method, payload).pipe(
    Effect.as(null as string | null),
    Effect.catch((error) => Effect.succeed(error.message)),
  );

const read = { cwd: projectRoot, relativePath: "a.txt" };
const readSecret = { cwd: projectRoot, relativePath: ".env" };
const write = { cwd: projectRoot, relativePath: "a.txt", contents: "x" };
let messageCounter = 0;
const dispatch = (instanceId: string) => ({
  type: "message.dispatch",
  threadId: "t1",
  messageId: `m-${messageCounter++}`,
  modelSelection: { instanceId, model: "m" },
  text: "hi",
});
const terminal = (id = "term-1") => ({ threadId: "t1", terminalId: id, cwd: projectRoot });

it.layer(layer)("member fence: access zones on the RPC path", (it) => {
  it.effect("Chat only: AI yes, files and compute refused", () =>
    Effect.gen(function* () {
      const { fence, setZones } = yield* setup("chat");
      yield* setZones("chat");
      assert.strictEqual(yield* message(fence, "orchestration.dispatchCommand", dispatch("claudeAgent")), null);
      assert.strictEqual(yield* message(fence, "projects.readFile", read), FILES_OFF_MESSAGE);
      assert.strictEqual(yield* message(fence, "projects.writeFile", write), FILES_OFF_MESSAGE);
      assert.strictEqual(yield* message(fence, "projects.searchEntries", { cwd: projectRoot, query: "a", limit: 5 }), FILES_OFF_MESSAGE);
      assert.strictEqual(yield* message(fence, "vcs.pull", { cwd: projectRoot }), FILES_OFF_MESSAGE);
      assert.strictEqual(yield* message(fence, "terminal.open", terminal()), COMPUTE_OFF_MESSAGE);
      assert.strictEqual(yield* message(fence, "subscribeTerminalMetadata", {}), COMPUTE_OFF_MESSAGE);
      assert.strictEqual(yield* message(fence, "mcpApps.callTool", {}), COMPUTE_OFF_MESSAGE);
    }),
  );

  it.effect("Can edit (the default): files read and write, secrets hidden, no compute", () =>
    Effect.gen(function* () {
      const { fence } = yield* setup("edit");
      // No override and no project default: the fallback is Can edit.
      assert.strictEqual(yield* message(fence, "projects.readFile", read), null);
      assert.strictEqual(yield* message(fence, "projects.writeFile", write), null);
      assert.strictEqual(yield* message(fence, "projects.readFile", readSecret), SECRET_FILE_MESSAGE);
      assert.strictEqual(
        yield* message(fence, "projects.writeFile", { ...write, relativePath: "keys/server.pem" }),
        SECRET_FILE_MESSAGE,
      );
      // t3.json holds scripts that run on worktree setup: writing it is running code.
      assert.strictEqual(
        yield* message(fence, "projects.writeFile", { ...write, relativePath: "t3.json" }),
        COMPUTE_OFF_MESSAGE,
      );
      assert.strictEqual(yield* message(fence, "terminal.open", terminal()), COMPUTE_OFF_MESSAGE);
      assert.strictEqual(
        yield* message(fence, "orchestration.dispatchCommand", { type: "runtime-request.respond", threadId: "t1" }),
        COMPUTE_OFF_MESSAGE,
      );
      assert.strictEqual(yield* message(fence, "scheduledTasks.upsert", {}), COMPUTE_OFF_MESSAGE);
      assert.strictEqual(yield* message(fence, "orchestration.dispatchCommand", dispatch("claudeAgent")), null);
    }),
  );

  it.effect("Full access: terminal and secret files; the terminal is theirs alone", () =>
    Effect.gen(function* () {
      const { fence, setZones, bo } = yield* setup("full");
      yield* setZones("full");
      assert.strictEqual(yield* message(fence, "projects.readFile", readSecret), null);
      assert.strictEqual(yield* message(fence, "terminal.open", terminal()), null);
      assert.strictEqual(ownerOfTerminal("t1", "term-1")?.userId, bo.userId);
      assert.strictEqual(yield* message(fence, "terminal.write", { ...terminal(), data: "ls\r" }), null);
      // A terminal the host opened (registered through the operator fence) is not theirs.
      const operator = yield* makeMemberFence("owner:operator");
      yield* operator!.check("terminal.open", terminal("host-term"));
      assert.strictEqual(
        yield* message(fence, "terminal.attach", terminal("host-term")),
        "That terminal belongs to someone else. Open a new one.",
      );
      assert.strictEqual(
        yield* message(fence, "terminal.write", { ...terminal("never-opened"), data: "x" }),
        "That terminal is not yours.",
      );
    }),
  );

  it.effect("Read only (the preset and the old viewer seat): reads pass, everything else is refused", () =>
    Effect.gen(function* () {
      const { fence, setZones } = yield* setup("ro");
      yield* setZones("readonly");
      assert.strictEqual(yield* message(fence, "projects.readFile", read), null);
      assert.strictEqual(yield* message(fence, "orchestration.subscribeThread", { threadId: "t1" }), null);
      assert.strictEqual(yield* message(fence, "orchestration.dispatchCommand", dispatch("claudeAgent")), READ_ONLY_MESSAGE);
      assert.strictEqual(yield* message(fence, "projects.writeFile", write), READ_ONLY_MESSAGE);
      assert.strictEqual(yield* message(fence, "terminal.open", terminal()), READ_ONLY_MESSAGE);
    }),
  );

  it.effect("files read without write: reads pass, writes say why", () =>
    Effect.gen(function* () {
      const { fence, access, owner, bo } = yield* setup("rd");
      yield* access.setMemberZones({
        projectId: "p-zones",
        actorUserId: owner.userId,
        userId: bo.userId,
        zones: normalizeZones({ "ai.agents": "claude", "files.level": "read" }),
      });
      assert.strictEqual(yield* message(fence, "projects.readFile", read), null);
      assert.strictEqual(yield* message(fence, "projects.writeFile", write), FILES_READ_ONLY_MESSAGE);
    }),
  );

  it.effect("AI zone: only the allowed host agents; their own login always works", () =>
    Effect.gen(function* () {
      const { fence, access, owner, bo } = yield* setup("ai");
      yield* access.setMemberZones({
        projectId: "p-zones",
        actorUserId: owner.userId,
        userId: bo.userId,
        zones: normalizeZones({ "ai.agents": "codex", "files.level": "write" }),
      });
      assert.strictEqual(yield* message(fence, "orchestration.dispatchCommand", dispatch("codex")), null);
      const refused = yield* message(fence, "orchestration.dispatchCommand", dispatch("claudeAgent"));
      assert.include(refused ?? "", "Claude");
      assert.include(refused ?? "", "Request it");
      const { memberClaudeInstanceId } = yield* Effect.promise(() => import("./memberProviders.ts"));
      assert.strictEqual(
        yield* message(fence, "orchestration.dispatchCommand", dispatch(memberClaudeInstanceId(bo.userId))),
        null,
      );
    }),
  );

  it.effect("precedence: the project default applies until a per-member override; a change is immediate", () =>
    Effect.gen(function* () {
      const { fence, access, owner, setZones } = yield* setup("prec");
      yield* access.setProjectZones({ projectId: "p-zones", actorUserId: owner.userId, zones: zonesForPreset("chat") });
      assert.strictEqual(yield* message(fence, "projects.writeFile", write), FILES_OFF_MESSAGE);
      yield* setZones("edit");
      assert.strictEqual(yield* message(fence, "projects.writeFile", write), null);
      yield* access.setProjectZones({ projectId: "p-zones", actorUserId: owner.userId, zones: null });
      yield* access.setMemberZones({ projectId: "p-zones", actorUserId: owner.userId, userId: (yield* access.listMembers("p-zones")).find((m) => m.role !== "owner")!.user.userId, zones: null });
      // Back to the fallback (Can edit).
      assert.strictEqual(yield* message(fence, "projects.writeFile", write), null);
    }),
  );

  it.effect("live revocation: the very next terminal call is refused, and a change event fires", () =>
    Effect.gen(function* () {
      const { fence, access, setZones, bo } = yield* setup("live");
      const changes: Array<string | null> = [];
      const stop = access.onZonesChanged((change) => changes.push(change.userId));
      yield* setZones("full");
      assert.strictEqual(yield* message(fence, "terminal.open", terminal("live-1")), null);
      yield* setZones("edit");
      assert.strictEqual(
        yield* message(fence, "terminal.write", { ...terminal("live-1"), data: "id\r" }),
        COMPUTE_OFF_MESSAGE,
      );
      assert.strictEqual(yield* message(fence, "terminal.attach", terminal("live-1")), COMPUTE_OFF_MESSAGE);
      assert.deepStrictEqual(changes, [bo.userId, bo.userId]);
      stop();
    }),
  );

  it.effect("Projects zone on the RPC path: create, update, move, delete, clone and adopt are refused until granted", () =>
    Effect.gen(function* () {
      const { fence, setZones } = yield* setup("projz");
      const newRoot = NodePath.join(root, "another");
      const entries: ReadonlyArray<readonly [string, unknown]> = [
        ["projects.mutate", { type: "project.create", commandId: "c1", projectId: "p-new", title: "N", workspaceRoot: newRoot }],
        ["projects.mutate", { type: "project.update", commandId: "c2", projectId: "p-zones", title: "Renamed" }],
        ["projects.mutate", { type: "project.update", commandId: "c3", projectId: "p-zones", workspaceRoot: newRoot }],
        ["projects.mutate", { type: "project.delete", commandId: "c4", projectId: "p-zones" }],
        ["projects.createNew", { name: "x" }],
        ["projects.createFromThread", { threadId: "t1" }],
        ["projectClone.start", { url: "https://example.com/r.git", destinationPath: newRoot }],
        ["sourceControl.cloneRepository", { destinationPath: newRoot }],
        ["orchestration.dispatchCommand", { type: "thread.project.adopt-folder", threadId: "t1" }],
      ];
      for (const preset of ["chat", "edit"] as const) {
        yield* setZones(preset);
        for (const [method, payload] of entries) {
          assert.strictEqual(yield* message(fence, method, payload), PROJECTS_OFF_MESSAGE, `${preset} ${method} ${JSON.stringify(payload).slice(0, 40)}`);
        }
      }
      yield* setZones("full");
      for (const [method, payload] of entries) {
        assert.notStrictEqual(yield* message(fence, method, payload), PROJECTS_OFF_MESSAGE, `full ${method}`);
      }
    }),
  );

  it.effect("Projects zone matrix: every project-making RPC, every preset (create, rename, move, delete, clone, publish, adopt, thread launch)", () =>
    Effect.gen(function* () {
      const { fence, setZones } = yield* setup("projmatrix");
      const newRoot = NodePath.join(root, "matrix-new");
      const entries: ReadonlyArray<readonly [string, unknown]> = [
        ["projects.mutate", { type: "project.create", commandId: "m1", projectId: "p-new2", title: "N", workspaceRoot: newRoot }],
        ["projects.mutate", { type: "project.update", commandId: "m2", projectId: "p-zones", title: "Renamed" }],
        ["projects.mutate", { type: "project.update", commandId: "m3", projectId: "p-zones", workspaceRoot: newRoot }],
        ["projects.mutate", { type: "project.delete", commandId: "m4", projectId: "p-zones" }],
        ["projects.createNew", { name: "x" }],
        ["projects.createFromThread", { threadId: "t1" }],
        ["projectClone.start", { url: "https://example.com/r.git", destinationPath: newRoot }],
        ["sourceControl.cloneRepository", { destinationPath: newRoot }],
        ["sourceControl.publishRepository", { cwd: projectRoot }],
        ["orchestration.dispatchCommand", { type: "thread.project.adopt-folder", threadId: "t1" }],
      ];
      for (const preset of ["chat", "edit", "readonly"] as const) {
        yield* setZones(preset);
        for (const [method, payload] of entries) {
          const refused = yield* message(fence, method, payload);
          assert.isNotNull(refused, `${preset} ${method} must be refused`);
          assert.isTrue(
            refused === PROJECTS_OFF_MESSAGE || refused === READ_ONLY_MESSAGE,
            `${preset} ${method} says why: ${refused}`,
          );
        }
        // Launching a thread in a project that is not theirs (a made-up new one) is refused too.
        const launch = yield* message(fence, "orchestration.dispatchCommand", {
          type: "thread.create",
          commandId: "m5",
          threadId: "t-new",
          projectId: "p-not-theirs",
          title: "x",
        });
        assert.isNotNull(launch, `${preset} thread launch in a project that is not theirs`);
      }
      yield* setZones("full");
      for (const [method, payload] of entries) {
        assert.notStrictEqual(yield* message(fence, method, payload), PROJECTS_OFF_MESSAGE, `full ${method}`);
      }
    }),
  );

  it.effect("Files zone folders: only the shared subfolders, judged on the real path; other folders by choice", () =>
    Effect.gen(function* () {
      const { access, owner, bo, fence } = yield* setup("folders");
      const docs = NodePath.join(projectRoot, "docs");
      const src = NodePath.join(projectRoot, "src");
      const other = NodePath.join(root, "other-share");
      for (const dir of [docs, src, other]) NodeFS.mkdirSync(dir, { recursive: true });
      NodeFS.writeFileSync(NodePath.join(docs, "a.txt"), "a");
      NodeFS.writeFileSync(NodePath.join(src, "b.txt"), "b");
      NodeFS.writeFileSync(NodePath.join(other, "o.txt"), "o");
      NodeFS.rmSync(NodePath.join(docs, "link"), { force: true });
      NodeFS.symlinkSync(src, NodePath.join(docs, "link"));
      yield* access.setMemberZones({
        projectId: "p-zones",
        actorUserId: owner.userId,
        userId: bo.userId,
        zones: normalizeZones({ ...zonesForPreset("edit"), "files.folders": `docs\n${other}` }),
      });
      const inDocs = { cwd: projectRoot, relativePath: "docs/a.txt" };
      assert.isNull(yield* message(fence, "projects.readFile", inDocs));
      assert.isNull(yield* message(fence, "projects.writeFile", { ...inDocs, contents: "x" }));
      for (const relativePath of ["src/b.txt", "docs/link/b.txt", "README.md"]) {
        assert.strictEqual(
          yield* message(fence, "projects.readFile", { cwd: projectRoot, relativePath }),
          OUTSIDE_FOLDERS_MESSAGE,
          `read ${relativePath}`,
        );
        assert.strictEqual(
          yield* message(fence, "projects.writeFile", { cwd: projectRoot, relativePath, contents: "x" }),
          OUTSIDE_FOLDERS_MESSAGE,
          `write ${relativePath}`,
        );
      }
      // `..` is refused outright, before any folder is looked at.
      assert.isNotNull(yield* message(fence, "projects.readFile", { cwd: projectRoot, relativePath: "docs/../src/b.txt" }));
      // An "other folder" outside the project is reachable because the host chose it.
      assert.isNull(yield* message(fence, "projects.readFile", { cwd: other, relativePath: "o.txt" }));
      // A folder the host did not choose is not.
      assert.isNotNull(yield* message(fence, "projects.readFile", { cwd: root, relativePath: "other-share/o.txt" }));
      // Back to the whole project.
      yield* access.setMemberZones({
        projectId: "p-zones",
        actorUserId: owner.userId,
        userId: bo.userId,
        zones: zonesForPreset("edit"),
      });
      assert.isNull(yield* message(fence, "projects.readFile", { cwd: projectRoot, relativePath: "src/b.txt" }));
    }),
  );

  it.effect("a project a member makes shows them as its creator, joins the host's workspace, and the host can remove it", () =>
    Effect.gen(function* () {
      const { access, bo, fence, setZones } = yield* setup("creator");
      const hostWorkspace = yield* access.createWorkspace({ actorUserId: null, name: "Host workspace" });
      yield* access.attachProject("p-zones", hostWorkspace.workspaceId);
      yield* setZones("full");
      const newRoot = NodePath.join(root, "member-made");
      const payload = { type: "project.create", commandId: "c-made", projectId: "p-made", title: "Made", workspaceRoot: newRoot };
      assert.notStrictEqual(yield* message(fence, "projects.mutate", payload), PROJECTS_OFF_MESSAGE);
      yield* fence.afterSuccess("projects.mutate", payload, { projectId: "p-made" });
      assert.strictEqual(access.projectWorkspaceId("p-made"), hostWorkspace.workspaceId);
      const members = yield* access.listMembers("p-made");
      assert.deepStrictEqual(
        members.map((member) => [member.user.userId, member.role]),
        [[bo.userId, "owner"]],
      );
      // The host (operator) is never fenced: it sees and can delete what the member made.
      const hostFence = yield* makeMemberFence("operator");
      assert.isNotNull(hostFence);
      assert.isNull(
        yield* message(hostFence!, "projects.mutate", { type: "project.delete", commandId: "c-del", projectId: "p-made" }),
      );
    }),
  );
});
