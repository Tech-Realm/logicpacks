import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  type OrchestrationV2DomainEvent,
  type PresenceStreamEvent,
  ProjectId,
  ThreadId,
} from "@logicpacks/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { LogicPacksAccess } from "./LogicPacksAccess.ts";
import { memberClaudeInstanceId } from "./memberProviders.ts";
import * as PresenceAgents from "./presenceAgents.ts";
import * as Presence from "./PresenceService.ts";

const projectId = ProjectId.make("project-1");
const threadId = ThreadId.make("thread-1");

/** The next change on the presence stream, after its opening snapshot. */
const followPresence = Effect.fn("test.followPresence")(function* () {
  const presence = yield* Presence.PresenceService;
  const changes = yield* Queue.unbounded<PresenceStreamEvent>();
  const subscribed = yield* Deferred.make<void>();
  yield* presence
    .stream(() => true)
    .pipe(
      Stream.runForEach((event) =>
        event.type === "snapshot"
          ? Deferred.succeed(subscribed, undefined)
          : Queue.offer(changes, event),
      ),
      Effect.forkScoped,
    );
  yield* Deferred.await(subscribed);
  return changes;
});

it.effect("moves a member's agent cursor with its edits and removes it when the run ends", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "lp-presence-agents-" });
    yield* fileSystem.makeDirectory(path.join(root, "src"));
    yield* fileSystem.writeFileString(
      path.join(root, "src", "cart.ts"),
      "export const cart = [];\n\nexport function total() {\n  return 42;\n}\n",
    );
    const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
    const emit = (event: unknown) => Queue.offer(events, event as OrchestrationV2DomainEvent);

    const dependencies = Layer.mergeAll(
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        streamDomainEvents: Stream.fromQueue(events),
        getThreadShell: () =>
          Effect.succeed({
            projectId,
            worktreePath: root,
            modelSelection: { instanceId: memberClaudeInstanceId("ali") },
          } as never),
      }),
      Layer.mock(ProjectStore.ProjectStoreV2)({
        listShells: () => Effect.succeed([{ workspaceRoot: root }] as never),
      }),
      Layer.mock(LogicPacksAccess)({
        listUsers: () => Effect.succeed([{ userId: "ali", displayName: "Ali" }] as never),
        roleOf: () => null,
        visibleProjectIds: () => new Set(),
        isSynced: () => false,
        syncedProjectIds: () => new Set(),
        listWorkspaces: () => [],
        currentWorkspaceId: () => null,
        workspaceForInvite: () => null,
        syncPusher: () => null,
        onboardingChoice: () => null,
        projectWorkspaceId: () => null,
        inView: () => true,
      }),
    );

    yield* Effect.gen(function* () {
      const changes = yield* followPresence();
      yield* emit({
        type: "turn-item.updated",
        threadId,
        payload: {
          threadId,
          type: "file_change",
          fileName: path.join(root, "src", "cart.ts"),
          newStr: "return 42;",
        },
      });
      const upsert = yield* Queue.take(changes);
      const entry = upsert.type === "upsert" ? upsert.entry : undefined;
      assert.strictEqual(entry?.actor.name, "Ali's agent");
      assert.strictEqual(entry?.actor.kind, "agent");
      assert.strictEqual(entry?.source, "server");
      assert.deepStrictEqual(entry?.location, {
        view: "file",
        activity: "editing",
        path: "src/cart.ts",
        cursor: { line: 4, column: 2 },
      });

      // A file outside the project is not shown.
      yield* emit({
        type: "turn-item.updated",
        threadId,
        payload: { threadId, type: "file_change", fileName: "/etc/hosts", newStr: "x" },
      });
      yield* emit({ type: "run.updated", threadId, payload: { status: "completed" } });
      const removed = yield* Queue.take(changes);
      assert.deepStrictEqual(removed, { type: "remove", key: "agent:thread:thread-1" });
    }).pipe(
      Effect.provide(
        PresenceAgents.layer.pipe(Layer.provideMerge(Presence.layer), Layer.provide(dependencies)),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
