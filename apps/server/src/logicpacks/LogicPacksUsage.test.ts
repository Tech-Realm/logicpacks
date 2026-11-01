import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as LogicPacksAccess from "./LogicPacksAccess.ts";
import { LogicPacksUsage, layer, operatorCaller } from "./LogicPacksUsage.ts";
import { memberClaudeInstanceId } from "./memberProviders.ts";
import type { CompletedTurn } from "./turnLedger.ts";

const layerUsage = layer.pipe(
  Layer.provideMerge(LogicPacksAccess.layer),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "lp-lp-usage-test-" })),
  Layer.provideMerge(NodeServices.layer),
);

const NOW = Date.parse("2026-10-31T12:00:00.000Z");

const turn = (overrides: Partial<CompletedTurn>): CompletedTurn => ({
  providerInstanceId: "claudeAgent",
  providerTurnId: "turn-1",
  threadId: "t-1",
  driver: "claudeAgent",
  model: "claude-sonnet-4-5",
  status: "completed",
  startedAtMs: NOW - 90_000,
  completedAtMs: NOW,
  inputTokens: 12_000,
  cachedInputTokens: 8_000,
  cacheCreationTokens: 1_000,
  outputTokens: 900,
  reasoningTokens: 0,
  autonomous: false,
  ...overrides,
});

const dispatch = (
  type: "thread.create" | "message.dispatch",
  threadId: string,
  projectId?: string,
) => ({ type, threadId, ...(projectId === undefined ? {} : { projectId }) }) as const;

it.layer(layerUsage)("LogicPacksUsage", (it) => {
  it.effect("attributes turns to whoever drives the thread and awards collaboration badges", () =>
    Effect.gen(function* () {
      const access = yield* LogicPacksAccess.LogicPacksAccess;
      const usage = yield* LogicPacksUsage;
      const ali = yield* access.quickLogin("ali");
      const sara = yield* access.quickLogin("sara");
      yield* access.recordOwner("p-shop", ali.userId);
      yield* access.addMember({ projectId: "p-shop", actorUserId: ali.userId, user: "sara" });
      const aliCaller = { participantId: ali.userId, isOperator: false };
      const saraCaller = { participantId: sara.userId, isOperator: false };

      // Ali starts a thread in the shared project; the agent finishes a turn on the host login.
      yield* usage.observeRpc(
        aliCaller,
        "orchestration.dispatchCommand",
        dispatch("thread.create", "t-ali", "p-shop"),
      );
      yield* usage.recordTurn(turn({ threadId: "t-ali", providerTurnId: "a1" }));
      // Sara joins in on her own thread with her own Claude login, and a subagent turn follows.
      yield* usage.observeRpc(
        saraCaller,
        "orchestration.dispatchCommand",
        dispatch("thread.create", "t-sara", "p-shop"),
      );
      yield* usage.observeRpc(
        saraCaller,
        "orchestration.dispatchCommand",
        dispatch("message.dispatch", "t-sara"),
      );
      const saraInstance = memberClaudeInstanceId(sara.userId);
      yield* usage.recordTurn(
        turn({ threadId: "t-sara", providerTurnId: "s1", providerInstanceId: saraInstance }),
      );
      yield* usage.recordTurn(
        turn({
          threadId: "t-sara",
          providerTurnId: "s2",
          providerInstanceId: saraInstance,
          autonomous: true,
          model: "claude-haiku-4-5",
        }),
      );
      // The same provider turn reported twice counts once.
      yield* usage.recordTurn(
        turn({ threadId: "t-sara", providerTurnId: "s2", providerInstanceId: saraInstance }),
      );
      // A turn on a thread nobody claimed falls back to the login it ran on.
      yield* usage.recordTurn(
        turn({ threadId: "t-orphan", providerTurnId: "o1", providerInstanceId: saraInstance }),
      );
      yield* usage.recordTurn(turn({ threadId: "t-host", providerTurnId: "h1" }));

      // The composer launches a thread with its first message in one call; the id is in the
      // result, and the first turn may already be recorded by the time the launch is observed.
      yield* usage.recordTurn(turn({ threadId: "t-launch", providerTurnId: "l1" }));
      yield* usage.observeRpc(
        saraCaller,
        "orchestration.launchThread",
        { projectId: "p-shop" },
        { threadId: "t-launch" },
      );
      yield* usage.recordTurn(turn({ threadId: "t-launch", providerTurnId: "l2" }));

      const aliBadges = yield* usage.achievements({ caller: aliCaller });
      const unlocked = (badges: typeof aliBadges) =>
        badges.achievements.filter((item) => item.unlocked).map((item) => item.id);
      assert.includeMembers(unlocked(aliBadges), [
        "first_turn",
        "open_door",
        "in_the_open",
        "first_invite_accepted",
      ]);
      const saraBadges = yield* usage.achievements({ caller: saraCaller });
      assert.includeMembers(unlocked(saraBadges), ["first_turn", "joined_team", "in_the_open"]);
      assert.notInclude(unlocked(saraBadges), "first_invite_accepted");

      // Sync and reported events are deduplicated by subject.
      const firstSync = yield* usage.recordActivity({
        participantId: ali.userId,
        kind: "project.synced",
        subject: "p-shop",
        projectId: "p-shop",
      });
      assert.deepStrictEqual(
        firstSync.map((item) => item.id),
        ["first_sync"],
      );
      yield* usage.recordActivity({
        participantId: sara.userId,
        kind: "conflict.resolved",
        subject: "abc123",
      });
      const again = yield* usage.recordActivity({
        participantId: sara.userId,
        kind: "conflict.resolved",
        subject: "abc123",
      });
      assert.deepStrictEqual(again, []);
      const saraAfter = yield* usage.achievements({ caller: saraCaller });
      const peacemaker = saraAfter.achievements.find((item) => item.id === "peacemaker")!;
      assert.isTrue(peacemaker.unlocked);
      assert.strictEqual(
        saraAfter.achievements.find((item) => item.id === "merge_master")!.current,
        1,
      );

      const board = yield* usage.leaderboard({
        caller: operatorCaller,
        range: "7d",
        projectId: null,
        projectTitles: new Map([["p-shop", "Shop"]]),
      });
      const byName = new Map(board.entries.map((entry) => [entry.displayName, entry]));
      assert.strictEqual(byName.get("Sara")!.turns, 5);
      assert.strictEqual(byName.get("Ali")!.turns, 1);
      assert.strictEqual(byName.get("Host owner")!.turns, 1);
      assert.strictEqual(byName.get("Sara")!.tokens, 5 * 12_900);
      assert.strictEqual(board.entries[0]!.displayName, "Sara");
      const saraHaiku = board.agents.find(
        (agent) => agent.ownerName === "Sara" && agent.model === "claude-haiku-4-5",
      )!;
      assert.strictEqual(saraHaiku.autonomousTurns, 1);
      assert.strictEqual(board.byProject[0]!.title, "Shop");
      assert.strictEqual(board.byProject[0]!.turns, 5);
      assert.isAbove(byName.get("Ali")!.points, 0);

      // Sara goes private: Ali no longer sees her row, her badges or her numbers.
      yield* usage.setSharing(saraCaller, false);
      const aliView = yield* usage.leaderboard({
        caller: aliCaller,
        range: "7d",
        projectId: null,
        projectTitles: new Map([["p-shop", "Shop"]]),
      });
      assert.deepStrictEqual(aliView.entries.map((entry) => entry.displayName).sort(), [
        "Ali",
        "Host owner",
      ]);
      assert.strictEqual(aliView.hiddenParticipants, 1);
      assert.strictEqual(aliView.totals.turns, 2);
      const hidden = yield* usage
        .achievements({ caller: aliCaller, participantId: sara.userId })
        .pipe(Effect.flip);
      assert.strictEqual(hidden.reason, "not_found");
      const saraView = yield* usage.leaderboard({
        caller: saraCaller,
        range: "7d",
        projectId: null,
        projectTitles: new Map(),
      });
      assert.isTrue(saraView.entries.find((entry) => entry.isYou)!.private);
      assert.deepStrictEqual(saraView.viewer.sharing, { shareUsage: false, isDecided: true });
    }),
  );

  it.effect("credits publishing a pack and teammates reusing it, once per use", () =>
    Effect.gen(function* () {
      const access = yield* LogicPacksAccess.LogicPacksAccess;
      const usage = yield* LogicPacksUsage;
      const noor = yield* access.quickLogin("noor");
      const omar = yield* access.quickLogin("omar");
      const key = "checkout-flow@2026-11-01T10:00:00.000Z";
      const ids = (unlocked: ReadonlyArray<{ readonly id: string }>) =>
        unlocked.map((item) => item.id);
      const shelf = (participantId: string) =>
        usage
          .achievements({ caller: operatorCaller, participantId })
          .pipe(
            Effect.map((result) => new Map(result.achievements.map((item) => [item.id, item]))),
          );

      // Noor saves a thread as a pack: First pack.
      const published = yield* usage.recordPackPublished({
        authorId: noor.userId,
        key,
        projectId: "p-cafe",
      });
      assert.include(ids(published), "recipe_author");
      // Saving the same pack again does not count twice.
      yield* usage.recordPackPublished({ authorId: noor.userId, key, projectId: "p-cafe" });
      assert.strictEqual((yield* shelf(noor.userId)).get("recipe_author")!.current, 1);

      // Noor using her own pack earns nothing.
      assert.deepStrictEqual(
        yield* usage.recordPackReused({
          reuserId: noor.userId,
          key,
          useId: "own",
          projectId: "p-cafe",
        }),
        [],
      );
      assert.isFalse((yield* shelf(noor.userId)).get("passed_around")!.unlocked);

      // Omar reuses it: his reuse counts, and Noor's pack was passed around.
      const reused = yield* usage.recordPackReused({
        reuserId: omar.userId,
        key,
        useId: "m-1",
        projectId: "p-cafe",
      });
      assert.include(ids(reused), "second_helping");
      assert.isTrue((yield* shelf(noor.userId)).get("passed_around")!.unlocked);
      // The same delivery reported again is one use, not two.
      yield* usage.recordPackReused({ reuserId: omar.userId, key, useId: "m-1", projectId: null });
      assert.strictEqual((yield* shelf(noor.userId)).get("crowd_favourite")!.current, 1);

      // Nine more uses, one of them from a copy in another project: ten in all.
      for (let use = 2; use <= 10; use += 1) {
        yield* usage.recordPackReused({
          reuserId: omar.userId,
          key,
          useId: `m-${use}`,
          projectId: use === 10 ? "p-other" : "p-cafe",
        });
      }
      const noorShelf = yield* shelf(noor.userId);
      assert.isTrue(noorShelf.get("crowd_favourite")!.unlocked);
      assert.strictEqual(noorShelf.get("passed_around")!.current, 1);
      assert.isTrue((yield* shelf(omar.userId)).get("regular")!.unlocked);
      // Omar never published, so he has no author badges.
      assert.isFalse((yield* shelf(omar.userId)).get("passed_around")!.unlocked);
    }),
  );
});
