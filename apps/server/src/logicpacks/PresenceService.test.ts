import { assert, it } from "@effect/vitest";
import { ProjectId, type PresenceEntry, type PresenceStreamEvent } from "@logicpacks/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import { layer, PresenceService, type PresenceWriteInput } from "./PresenceService.ts";

const shared = ProjectId.make("shared");
const secret = ProjectId.make("secret");

const report = (overrides: Partial<PresenceWriteInput>): PresenceWriteInput => ({
  key: "socket-a:tab",
  clientId: "tab",
  connectionId: "socket-a",
  projectId: shared,
  actor: { id: "host", kind: "human", name: "Host", colorIndex: 0 },
  source: "web",
  location: { view: "file", activity: "viewing", path: "src/app.ts" },
  ...overrides,
});

const follow = Effect.fn("test.follow")(function* (visible: (entry: PresenceEntry) => boolean) {
  const presence = yield* PresenceService;
  const events = yield* Queue.unbounded<PresenceStreamEvent>();
  yield* presence.stream(visible).pipe(
    Stream.runForEach((event) => Queue.offer(events, event)),
    Effect.forkScoped,
  );
  const snapshot = yield* Queue.take(events);
  return { events, snapshot };
});

it.layer(layer)("PresenceService", (it) => {
  it.effect("streams a snapshot, then only the changes a viewer may see", () =>
    Effect.gen(function* () {
      const presence = yield* PresenceService;
      yield* presence.write(report({}));
      const member = yield* follow((entry) => entry.projectId === shared);
      assert.deepStrictEqual(
        member.snapshot.type === "snapshot" && member.snapshot.entries.map((entry) => entry.key),
        ["socket-a:tab"],
      );

      yield* presence.write(report({ key: "socket-b:tab", projectId: secret }));
      yield* presence.write(
        report({ location: { view: "file", activity: "editing", path: "src/app.ts" } }),
      );
      const moved = yield* Queue.take(member.events);
      assert.strictEqual(moved.type === "upsert" && moved.entry.location.activity, "editing");

      // Moving into a project the member cannot see reads as leaving.
      yield* presence.write(report({ projectId: secret }));
      assert.deepStrictEqual(yield* Queue.take(member.events), {
        type: "remove",
        key: "socket-a:tab",
      });
      yield* presence.dropConnection("socket-b");
      yield* presence.dropConnection("socket-a");
      assert.strictEqual(yield* Queue.size(member.events), 0);
    }),
  );

  it.effect("expires a reporter that stops refreshing and drops a closed socket", () =>
    Effect.gen(function* () {
      const presence = yield* PresenceService;
      const viewer = yield* follow(() => true);
      yield* presence.write(report({ key: "agent:thread:1", connectionId: null, ttlMs: 10_000 }));
      yield* presence.write(report({ key: "socket-c:tab", connectionId: "socket-c" }));
      yield* Queue.take(viewer.events);
      yield* Queue.take(viewer.events);

      yield* TestClock.adjust(Duration.seconds(15));
      assert.deepStrictEqual(yield* Queue.take(viewer.events), {
        type: "remove",
        key: "agent:thread:1",
      });
      yield* presence.dropConnection("socket-c");
      assert.deepStrictEqual(yield* Queue.take(viewer.events), {
        type: "remove",
        key: "socket-c:tab",
      });
      assert.deepStrictEqual(yield* presence.list(() => true), []);
    }),
  );
});
