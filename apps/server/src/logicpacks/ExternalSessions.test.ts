import { assert, it } from "@effect/vitest";
import { ProjectId, type OrchestrationProjectShell } from "@logicpacks/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { ExternalSessions, type HelperCaller, layer } from "./ExternalSessions.ts";
import type { ExternalSessionBatch } from "./externalSessionMapping.ts";
import * as LogicPacksAccess from "./LogicPacksAccess.ts";
import * as LogicPacksPresence from "./PresenceService.ts";

const shell = (id: string, title: string, workspaceRoot: string): OrchestrationProjectShell => ({
  id: ProjectId.make(id),
  title,
  workspaceRoot,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-10-31T00:00:00.000Z",
  updatedAt: "2026-10-31T00:00:00.000Z",
});

const shells = [
  shell("shop", "Shop", "/work/shop"),
  shell("shop-api", "Shop API", "/work/shop/api"),
  shell("hosted", "Hosted app", "/srv/logicpacks/acme-app"),
];
const remotes: Record<string, string> = {
  "/srv/logicpacks/acme-app": "https://github.com/acme/app.git",
};

const stores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);
const layerSessions = layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      stores,
      EventSink.layer.pipe(Layer.provide(stores)),
      LogicPacksAccess.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
      LogicPacksPresence.layer,
      Layer.mock(ProjectStore.ProjectStoreV2)({
        listShells: (options) =>
          Effect.succeed(
            options?.projectIds === undefined
              ? shells
              : shells.filter((candidate) => options.projectIds!.includes(candidate.id)),
          ),
        getShell: (projectId) =>
          Effect.succeed(
            Option.fromNullishOr(shells.find((candidate) => candidate.id === projectId)),
          ),
      }),
      Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
        resolve: (cwd) =>
          Effect.succeed(
            remotes[cwd] === undefined
              ? null
              : {
                  canonicalKey: "github.com/acme/app",
                  locator: { source: "git-remote", remoteName: "origin", remoteUrl: remotes[cwd]! },
                },
          ),
      }),
    ),
  ),
);

const operator: HelperCaller = { kind: "operator" };

const batch = (overrides: Partial<ExternalSessionBatch> = {}): ExternalSessionBatch => ({
  source: "claude",
  sessionId: "9f1c2d3e-0000-4000-8000-000000000001",
  cwd: "/work/shop/api/src",
  gitRoot: "/work/shop",
  gitRemote: null,
  device: "Ali's MacBook",
  events: [],
  ...overrides,
});

const threadRows = (threadId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const thread = yield* sql<{ readonly project_id: string; readonly title: string }>`
      SELECT project_id, title FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}
    `;
    const items = yield* sql<{
      readonly ordinal: number;
      readonly type: string;
      readonly status: string;
    }>`
      SELECT ordinal, type, status FROM orchestration_v2_projection_turn_items
      WHERE thread_id = ${threadId} ORDER BY ordinal
    `;
    const messages = yield* sql<{ readonly role: string }>`
      SELECT role FROM orchestration_v2_projection_messages WHERE thread_id = ${threadId} ORDER BY created_at
    `;
    return { thread: thread[0] ?? null, items, messages: messages.map((row) => row.role) };
  });

it.layer(layerSessions)("ExternalSessions", (it) => {
  it.effect(
    "streams a session into the deepest matching project and updates finished tool calls",
    () =>
      Effect.gen(function* () {
        const sessions = yield* ExternalSessions;
        const first = yield* sessions.ingest(
          operator,
          batch({
            events: [
              {
                uid: "u1",
                at: "2026-10-31T10:00:00.000Z",
                type: "user",
                text: "Fix the checkout total\nit rounds wrong",
              },
              {
                uid: "toolu_1",
                at: "2026-10-31T10:00:05.000Z",
                type: "tool",
                tool: {
                  name: "Edit",
                  kind: "file_change",
                  input: "src/total.ts",
                  status: "running",
                  files: ["/work/shop/api/src/total.ts"],
                },
              },
            ],
          }),
        );
        assert.isTrue(first.linked);
        if (!first.linked) return;
        assert.strictEqual(first.projectId, "shop-api");
        assert.strictEqual(first.accepted, 2);

        const second = yield* sessions.ingest(
          operator,
          batch({
            events: [
              {
                uid: "u1",
                at: "2026-10-31T10:00:00.000Z",
                type: "user",
                text: "Fix the checkout total\nit rounds wrong",
              },
              {
                uid: "toolu_1",
                at: "2026-10-31T10:00:06.000Z",
                type: "tool",
                tool: {
                  name: "Edit",
                  kind: "file_change",
                  input: "src/total.ts",
                  status: "completed",
                  files: ["/work/shop/api/src/total.ts"],
                },
              },
              {
                uid: "a1",
                at: "2026-10-31T10:00:09.000Z",
                type: "assistant",
                text: "Fixed the rounding.",
              },
            ],
          }),
        );
        assert.deepStrictEqual(second.linked && [second.accepted, second.duplicates], [2, 1]);

        const rows = yield* threadRows(first.threadId);
        assert.deepStrictEqual(rows.thread, {
          project_id: "shop-api",
          title: "Fix the checkout total",
        });
        assert.deepStrictEqual(
          rows.items.map((item) => [item.ordinal, item.type, item.status]),
          [
            [1, "system_notice", "completed"],
            [2, "user_message", "completed"],
            [3, "file_change", "completed"],
            [4, "assistant_message", "completed"],
          ],
        );
        assert.deepStrictEqual(rows.messages, ["user", "assistant"]);

        const presence = yield* sessions.presence("shop-api");
        assert.deepStrictEqual(
          presence.map((entry) => [entry.who, entry.files.map((file) => [file.path, file.action])]),
          [["Ali's MacBook", [["src/total.ts", "editing"]]]],
        );

        // The same session shows as a live agent cursor beside people and host agents.
        const live = yield* LogicPacksPresence.PresenceService.pipe(
          Effect.flatMap((service) => service.list((entry) => entry.projectId === "shop-api")),
        );
        assert.deepStrictEqual(
          live.map((entry) => [entry.actor.kind, entry.actor.name, entry.source, entry.location]),
          [
            [
              "agent",
              "Host's Claude Code",
              "helper",
              { view: "file", activity: "editing", path: "src/total.ts" },
            ],
          ],
        );
      }),
  );

  it.effect("links by git remote when the folder is not a project on this host", () =>
    Effect.gen(function* () {
      const sessions = yield* ExternalSessions;
      const linked = yield* sessions.ingest(
        operator,
        batch({
          source: "codex",
          sessionId: "019a-remote",
          cwd: "/Users/sara/code/app",
          gitRoot: "/Users/sara/code/app",
          gitRemote: "git@github.com:Acme/App.git",
          events: [{ uid: "1", at: "2026-10-31T11:00:00.000Z", type: "user", text: "hi" }],
        }),
      );
      assert.deepStrictEqual(linked.linked && linked.projectId, "hosted");

      const unknown = yield* sessions.ingest(
        operator,
        batch({
          sessionId: "elsewhere",
          cwd: "/tmp/scratch",
          gitRoot: null,
          gitRemote: "https://github.com/someone/else",
          events: [{ uid: "1", at: "2026-10-31T11:00:00.000Z", type: "user", text: "hi" }],
        }),
      );
      assert.deepStrictEqual(unknown.linked ? null : unknown.reason, "no_project");
    }),
  );

  it.effect("keeps members inside shared projects and sessions with their owner", () =>
    Effect.gen(function* () {
      const sessions = yield* ExternalSessions;
      const access = yield* LogicPacksAccess.LogicPacksAccess;
      const ana = yield* access.quickLogin("ana");
      const ben = yield* access.quickLogin("ben");
      const anaCaller: HelperCaller = { kind: "member", userId: ana.userId };
      const event = {
        uid: "1",
        at: "2026-10-31T12:00:00.000Z",
        type: "user" as const,
        text: "start",
      };
      const session = batch({
        sessionId: "ana-session",
        cwd: "/work/shop",
        gitRoot: "/work/shop",
        events: [event],
      });

      const unshared = yield* sessions.ingest(anaCaller, session);
      assert.deepStrictEqual(unshared.linked ? null : unshared.reason, "no_project");

      yield* access.recordOwner("shop", ana.userId);
      const shared = yield* sessions.ingest(anaCaller, session);
      assert.deepStrictEqual(shared.linked && shared.projectId, "shop");

      const hijack = yield* sessions.ingest({ kind: "member", userId: ben.userId }, session);
      assert.deepStrictEqual(hijack.linked ? null : hijack.reason, "not_owner");
    }),
  );

  it.effect("tells an agent who else is editing the same files", () =>
    Effect.gen(function* () {
      const sessions = yield* ExternalSessions;
      const edit = (sessionId: string, device: string) =>
        sessions.ingest(
          operator,
          batch({
            sessionId,
            device,
            cwd: "/srv/logicpacks/acme-app",
            gitRoot: "/srv/logicpacks/acme-app",
            events: [
              { uid: "u", at: "2026-10-31T13:00:00.000Z", type: "user", text: `${device} task` },
              {
                uid: "t",
                at: "2026-10-31T13:00:01.000Z",
                type: "tool",
                tool: {
                  name: "Write",
                  kind: "file_change",
                  input: "",
                  status: "completed",
                  files: ["/srv/logicpacks/acme-app/src/cart.ts"],
                },
              },
            ],
          }),
        );
      yield* edit("context-a", "Laptop A");
      yield* edit("context-b", "Laptop B");
      const live = yield* LogicPacksPresence.PresenceService;
      yield* live.write({
        key: "ws:alice",
        clientId: "alice-tab",
        connectionId: "socket-alice",
        projectId: ProjectId.make("hosted"),
        actor: { id: "member:alice", kind: "human", name: "Alice", colorIndex: 1 },
        source: "web",
        location: { view: "file", activity: "editing", path: "src/checkout.tsx" },
      });
      const context = yield* sessions.context(operator, {
        cwd: "/srv/logicpacks/acme-app",
        source: "claude",
        sessionId: "context-a",
      });
      assert.isTrue(context.linked);
      if (!context.linked) return;
      assert.include(context.text, `Laptop B's Claude Code: "Laptop B task"`);
      assert.include(context.text, "not synced");
      assert.include(context.text, "- Alice editing src/checkout.tsx, just now");
      assert.notInclude(context.text, "Host's Claude Code editing");
      assert.deepStrictEqual(context.conflicts, ["src/cart.ts"]);
    }),
  );
});
