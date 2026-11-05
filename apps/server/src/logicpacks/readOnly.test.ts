import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { runLedgerTool } from "./ledgerHttp.ts";
import { LogicPacksAccess } from "./LogicPacksAccess.ts";
import { ProjectGoals } from "./ProjectGoals.ts";
import { ProjectLedger } from "./ProjectLedger.ts";
import { READ_ONLY_MESSAGE, refuseIfReadOnly } from "./readOnly.ts";
import { viewerMayCall } from "./readOnlyRpc.ts";

describe("viewerMayCall", () => {
  it("lets a Read only member read, subscribe and mark threads seen", () => {
    for (const method of [
      "orchestration.subscribeShell",
      "orchestration.subscribeThread",
      "subscribeServerConfig",
      "orchestration.getThreadProjection",
      "orchestration.searchThreads",
      "projects.readFile",
      "projects.listEntries",
      "vcs.listRefs",
      "presence.update",
    ]) {
      assert.isTrue(viewerMayCall(method, {}), method);
    }
    assert.isTrue(viewerMayCall("orchestration.dispatchCommand", { type: "thread.visit" }));
    assert.isTrue(viewerMayCall("orchestration.dispatchCommand", { type: "thread.mark-unread" }));
  });

  it("refuses sends, turns, threads, files, git, approvals, terminals and settings", () => {
    for (const type of [
      "message.dispatch",
      "thread.create",
      "thread.archive",
      "thread.delete",
      "thread.metadata.update",
      "run.interrupt",
      "runtime-request.respond",
      "thread.runtime-mode.set",
    ]) {
      assert.isFalse(viewerMayCall("orchestration.dispatchCommand", { type }), type);
    }
    assert.isFalse(viewerMayCall("orchestration.dispatchCommand", {}));
    for (const method of [
      "orchestration.launchThread",
      "orchestration.forceStopThread",
      "orchestration.stopWorkflow",
      "projects.writeFile",
      "projects.mutate",
      "projects.createNew",
      "attachments.createUploadUrl",
      "assets.persistChatAttachments",
      "git.runStackedAction",
      "vcs.pull",
      "vcs.createRef",
      "vcs.switchRef",
      "vcs.createWorktree",
      "terminal.write",
      "terminal.open",
      "server.updateSettings",
      "scheduledTasks.upsert",
      "pullRequests.comment",
      "mcpApps.callTool",
      "something.new.nobody.listed",
    ]) {
      assert.isFalse(viewerMayCall(method, {}), method);
    }
  });
});

const accessWith = (readOnly: (userId: string, projectId: string | null) => boolean) =>
  Layer.mock(LogicPacksAccess)({ isReadOnly: readOnly } as never);

describe("refuseIfReadOnly", () => {
  it.effect("answers 403 read_only for a Read only member only", () =>
    Effect.gen(function* () {
      const refused = yield* refuseIfReadOnly({ kind: "member", userId: "bo" }, "p1");
      assert.strictEqual(refused?.status, 403);
      const body = (refused?.body as { body?: Uint8Array }).body;
      const text = new TextDecoder().decode(body);
      assert.deepStrictEqual(JSON.parse(text), { error: "read_only", message: READ_ONLY_MESSAGE });
      assert.isNull(yield* refuseIfReadOnly({ kind: "member", userId: "ana" }, "p1"));
      assert.isNull(yield* refuseIfReadOnly({ kind: "operator" }, "p1"));
      assert.isNull(yield* refuseIfReadOnly({ kind: "anonymous" }, null));
    }).pipe(Effect.provide(accessWith((userId) => userId === "bo"))),
  );

  it("uses the exact member-facing text", () => {
    assert.strictEqual(
      READ_ONLY_MESSAGE,
      "You have read-only access to this workspace. Ask an owner to change it.",
    );
  });
});

describe("ledger tools for an agent (lp mcp and in-app MCP)", () => {
  const ledger = Layer.mock(ProjectLedger)({
    view: () =>
      Effect.succeed({
        threads: [
          { threadId: "t-bo", members: [{ id: "bo", name: "Bo" }] },
          { threadId: "t-ana", members: [{ id: "ana", name: "Ana" }] },
        ],
        decisions: [],
        conflicts: [],
      } as never),
  });
  const run = (threadId: string, tool: "note" | "conflicts") =>
    runLedgerTool({
      projectId: "p1",
      threadId,
      name: "agent",
      tool,
      args: { goal: "x" },
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          ledger,
          Layer.mock(ProjectGoals)({} as never),
          accessWith((userId) => userId === "bo"),
        ),
      ),
    );

  it.effect("refuses writes from a Read only member's agent, keeps reads", () =>
    Effect.gen(function* () {
      const refused = yield* run("t-bo", "note").pipe(Effect.flip);
      assert.strictEqual(refused.message, READ_ONLY_MESSAGE);
      const read = yield* run("t-bo", "conflicts");
      assert.isString(read);
    }),
  );
});
