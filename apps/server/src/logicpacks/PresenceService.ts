import {
  PRESENCE_TTL_MS,
  type PresenceEntry,
  type PresenceStreamEvent,
} from "@logicpacks/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";

import {
  applyPresenceWrite,
  dropPresenceWhere,
  expirePresence,
  type PresenceChange,
  type PresenceRecord,
  type PresenceWrite,
} from "./presence.ts";

const SWEEP_INTERVAL = Duration.seconds(5);

export type PresenceWriteInput = Omit<PresenceWrite, "nowMs" | "ttlMs"> & {
  readonly ttlMs?: number | undefined;
};

/**
 * Live presence lives in memory only: it is about the next minute, survives
 * nothing, and must never reach the event store or a replay fixture.
 */
export class PresenceService extends Context.Service<
  PresenceService,
  {
    readonly write: (input: PresenceWriteInput) => Effect.Effect<void>;
    readonly dropWhere: (predicate: (record: PresenceRecord) => boolean) => Effect.Effect<void>;
    readonly dropConnection: (connectionId: string) => Effect.Effect<void>;
    readonly list: (
      visible: (entry: PresenceEntry) => boolean,
    ) => Effect.Effect<ReadonlyArray<PresenceEntry>>;
    /** A snapshot of what `visible` lets through, then its changes. */
    readonly stream: (
      visible: (entry: PresenceEntry) => boolean,
    ) => Stream.Stream<PresenceStreamEvent>;
  }
>()("logicpacks/logicpacks/PresenceService") {}

const make = Effect.gen(function* () {
  const records = new Map<string, PresenceRecord>();
  const changes = yield* PubSub.unbounded<PresenceChange>();
  const publish = (list: ReadonlyArray<PresenceChange>) =>
    list.length === 0 ? Effect.void : PubSub.publishAll(changes, list).pipe(Effect.asVoid);

  const write = Effect.fn("PresenceService.write")(function* (input: PresenceWriteInput) {
    const nowMs = yield* Clock.currentTimeMillis;
    const change = applyPresenceWrite(records, {
      ...input,
      nowMs,
      ttlMs: input.ttlMs ?? PRESENCE_TTL_MS,
    });
    if (change !== null) yield* publish([change]);
  });

  const dropWhere = (predicate: (record: PresenceRecord) => boolean) =>
    Effect.suspend(() => publish(dropPresenceWhere(records, predicate)));

  yield* Effect.gen(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    yield* publish(expirePresence(records, nowMs));
  }).pipe(Effect.delay(SWEEP_INTERVAL), Effect.forever, Effect.forkScoped);

  const list = (visible: (entry: PresenceEntry) => boolean) =>
    Effect.sync(() =>
      Array.from(records.values(), (record) => record.entry).filter((entry) => visible(entry)),
    );

  const stream = (visible: (entry: PresenceEntry) => boolean) =>
    Stream.unwrap(
      Effect.gen(function* () {
        // Subscribe before the snapshot so no change falls between them.
        const subscription = yield* PubSub.subscribe(changes);
        const snapshot = yield* list(visible);
        const seen = new Set(snapshot.map((entry) => entry.key));
        const toViewerEvent = (change: PresenceChange): PresenceStreamEvent | null => {
          if (change.type === "remove") return seen.delete(change.key) ? change : null;
          if (visible(change.entry)) {
            seen.add(change.entry.key);
            return change;
          }
          // An entry that moved somewhere this viewer cannot see leaves their view.
          return seen.delete(change.entry.key) ? { type: "remove", key: change.entry.key } : null;
        };
        const live = Stream.fromSubscription(subscription).pipe(
          Stream.filterMap((change) => {
            const event = toViewerEvent(change);
            return event === null ? Result.failVoid : Result.succeed(event);
          }),
        );
        const first: PresenceStreamEvent = { type: "snapshot", entries: snapshot };
        return Stream.concat(Stream.make(first), live);
      }),
    );

  return {
    write,
    dropWhere,
    dropConnection: (connectionId) => dropWhere((record) => record.connectionId === connectionId),
    list,
    stream,
  } satisfies PresenceService["Service"];
});

export const layer = Layer.effect(PresenceService, make);
