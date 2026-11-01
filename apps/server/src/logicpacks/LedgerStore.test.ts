import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import type { LedgerThread } from "./ledger.ts";
import { LedgerStore, layerStore, layerTurnContext } from "./ProjectLedger.ts";
import { ProjectLedgerTurnContext } from "./turnContext.ts";

const layer = layerTurnContext.pipe(
  Layer.provideMerge(layerStore),
  Layer.provideMerge(SqlitePersistence.layerMemory),
);

const thread = (threadId: string, name: string): LedgerThread => ({
  threadId,
  projectId: "p1",
  title: `${name}'s thread`,
  members: [{ id: name.toLowerCase(), name }],
  agent: { name: `${name}'s agent`, model: "claude" },
  goal: `${name}'s goal`,
  goalSource: "summary",
  files: [],
  branch: "main",
  status: "idle",
  lastActiveAtMs: 0,
  branchedFrom: null,
});

it.layer(layer)("LedgerStore", (it) => {
  it.effect("hands a thread's messages to its next turn once, with the other threads", () =>
    Effect.gen(function* () {
      const store = yield* LedgerStore;
      const context = yield* ProjectLedgerTurnContext;
      yield* store.putThread(thread("t-ana", "Ana"));
      // Alone and with nothing waiting: no context at all.
      assert.strictEqual(yield* context.forTurn("t-ana"), "");
      yield* store.putThread(thread("t-ali", "Ali"));
      yield* store.putMessage({
        id: "m1",
        projectId: "p1",
        fromThreadId: "t-ana",
        fromName: "Ana's agent",
        toThreadId: "t-ali",
        text: "Please take the coupon field",
        kind: "ask",
        replyTo: null,
        createdAtMs: 0,
        deliveredAtMs: null,
        seenAtMs: null,
      });
      const first = yield* context.forTurn("t-ali");
      assert.include(first, "Please take the coupon field");
      assert.include(first, 'Ana in "Ana\'s thread" [thread t-ana]');
      assert.isNotNull(store.message("m1")?.deliveredAtMs);
      // Delivered once: the next turn sees the threads but not the message again.
      const second = yield* context.forTurn("t-ali");
      assert.notInclude(second, "coupon field");
      assert.include(second, "[thread t-ana]");
      // The person in the thread still sees it until they dismiss it.
      assert.isNull(store.message("m1")?.seenAtMs ?? null);
      assert.strictEqual(yield* context.forTurn("t-unknown"), "");
    }),
  );

  it.effect("keeps rows per project", () =>
    Effect.gen(function* () {
      const store = yield* LedgerStore;
      yield* store.putThread({ ...thread("t-x", "Xi"), projectId: "p2" });
      assert.deepStrictEqual(
        store.threads("p2").map((row) => row.threadId),
        ["t-x"],
      );
      assert.include(store.projectIds(), "p2");
      yield* store.putDecision({
        id: "d1",
        projectId: "p2",
        threadId: null,
        text: "Use one footer",
        by: "Xi",
        atMs: 1,
      });
      assert.strictEqual(store.decisions("p2").length, 1);
      assert.strictEqual(store.decisions("p1").length, 0);
    }),
  );
});
