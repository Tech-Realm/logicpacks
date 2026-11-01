import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { ExpertsService } from "./ExpertsService.ts";
import type { GoalActor, GoalPlan } from "./goals.ts";
import type { LedgerMessage, LedgerThread } from "./ledger.ts";
import { LogicPacksAccess } from "./LogicPacksAccess.ts";
import { makeGoals, ProjectGoals, type ThreadWork } from "./ProjectGoals.ts";
import {
  LedgerError,
  LedgerStore,
  layerStore,
  layerTurnContext,
  ProjectLedger,
} from "./ProjectLedger.ts";
import { ProjectLedgerTurnContext } from "./turnContext.ts";

const users = [
  { userId: "u-ana", displayName: "Ana", email: "ana@x", createdAt: "" },
  { userId: "u-omar", displayName: "Omar", email: "omar@x", createdAt: "" },
  { userId: "u-priya", displayName: "Priya", email: "priya@x", createdAt: "" },
];

const thread = (threadId: string, userId: string, name: string, at: number): LedgerThread => ({
  threadId,
  projectId: "p1",
  title: `${name}'s thread`,
  members: [{ id: userId, name }],
  agent: { name: `${name}'s agent`, model: "mock" },
  goal: null,
  goalSource: "title",
  files: [],
  branch: "main",
  status: "idle",
  lastActiveAtMs: at,
  branchedFrom: null,
});

/** What the turn-end check reads, per thread; tests change it. */
const work = new Map<string, ThreadWork>();
const manifests = new Map<string, { before: string | null; after: string | null }>();

const ledgerMock = Layer.effect(
  ProjectLedger,
  Effect.gen(function* () {
    const store = yield* LedgerStore;
    let n = 0;
    const service: Pick<
      ProjectLedger["Service"],
      "projectOfThread" | "personName" | "refreshProject" | "send"
    > = {
      projectOfThread: (threadId) => Effect.succeed(store.thread(threadId)?.projectId ?? null),
      personName: (id) =>
        Effect.succeed(
          id === "host" ? "Host" : (users.find((u) => u.userId === id)?.displayName ?? "Member"),
        ),
      refreshProject: () => Effect.void,
      send: (input) =>
        Effect.gen(function* () {
          const target = store.thread(input.to);
          if (target === undefined) {
            return yield* new LedgerError({ reason: "not_found", message: "no thread" });
          }
          const message: LedgerMessage = {
            id: `m-${(n += 1)}`,
            projectId: input.projectId,
            fromThreadId: input.fromThreadId,
            fromName: input.fromName,
            toThreadId: target.threadId,
            text: input.text,
            kind: "ask",
            replyTo: null,
            createdAtMs: 0,
            deliveredAtMs: null,
            seenAtMs: null,
            ...(input.goalTask === undefined ? {} : { goalTask: input.goalTask }),
          };
          yield* store.putMessage(message);
          return message;
        }),
    };
    return service as ProjectLedger["Service"];
  }),
);

const goalsLayer = Layer.effect(
  ProjectGoals,
  makeGoals({
    threadWork: (threadId) => Effect.succeed(work.get(threadId) ?? null),
    manifestPair: (_cwd, path) => Effect.succeed(manifests.get(path) ?? null),
  }),
);

const layer = goalsLayer.pipe(
  Layer.provideMerge(ledgerMock),
  Layer.provideMerge(layerTurnContext),
  Layer.provideMerge(layerStore),
  Layer.provideMerge(
    Layer.mergeAll(
      Layer.succeed(LogicPacksAccess, {
        roleOf: (userId: string) =>
          userId === "u-ana" ? "owner" : users.some((u) => u.userId === userId) ? "member" : null,
        listUsers: () => Effect.succeed(users),
      } as unknown as LogicPacksAccess["Service"]),
      Layer.succeed(ExpertsService, {
        requests: () => [],
        experts: () => [],
      } as unknown as ExpertsService["Service"]),
    ),
  ),
  Layer.provideMerge(SqlitePersistence.layerMemory),
);

const plan: GoalPlan = {
  title: "Checkout v2",
  milestones: [
    {
      title: "Saved cards UI",
      assignee: "Omar",
      criteria: ["Cards render"],
      scope: { paths: ["checkout/"], avoid: ["api/"], branch: "feat/checkout" },
      due: "2030-01-01",
    },
    { title: "Checkout tests", assignee: "Priya", criteria: ["E2E passes"] },
  ],
};

const seed = Effect.gen(function* () {
  const store = yield* LedgerStore;
  yield* store.putThread(thread("t-ana", "u-ana", "Ana", 3));
  yield* store.putThread(thread("t-omar", "u-omar", "Omar", 2));
  yield* store.putThread(thread("t-priya", "u-priya", "Priya", 1));
});

const person = (id: string, name: string, isHost = false): GoalActor => ({
  id,
  name,
  isHost,
  threadId: null,
});

it.layer(layer)("ProjectGoals", (it) => {
  it.effect(
    "an agent drafts; nothing is sent until the owner confirms; then each task reaches its thread",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const goals = yield* ProjectGoals;
        const store = yield* LedgerStore;
        const context = yield* ProjectLedgerTurnContext;
        const goal = yield* goals.plan({ threadId: "t-ana", plan });
        assert.strictEqual(goal.ownerId, "u-ana");
        assert.strictEqual(goal.state, "draft");
        assert.strictEqual(store.messages("p1").length, 0);
        // The planner's next turn knows the draft waits.
        assert.include(yield* context.forTurn("t-ana"), "waits for Ana");
        // Omar cannot confirm Ana's goal.
        const refused = yield* goals
          .confirm({ goalId: goal.id, actor: person("u-omar", "Omar") })
          .pipe(Effect.flip);
        assert.strictEqual(refused.reason, "forbidden");
        const confirmed = yield* goals.confirm({
          goalId: goal.id,
          actor: person("u-ana", "Ana", true),
        });
        assert.deepStrictEqual(
          confirmed.milestones.map((m) => [m.status, m.threadId]),
          [
            ["sent", "t-omar"],
            ["sent", "t-priya"],
          ],
        );
        const sent = store.messages("p1");
        assert.deepStrictEqual(
          sent.map((m) => [m.fromThreadId, m.toThreadId]),
          [
            ["t-ana", "t-omar"],
            ["t-ana", "t-priya"],
          ],
        );
        assert.include(sent[0]!.text, "Saved cards UI");
        assert.include(sent[0]!.text, "do not touch api/");
        assert.deepStrictEqual(sent[0]!.goalTask, {
          goalId: goal.id,
          milestoneId: confirmed.milestones[0]!.id,
        });
        // Omar's agent gets the task and its milestone in its next turn.
        const omarTurn = yield* context.forTurn("t-omar");
        assert.include(omarTurn, `Your milestone ${confirmed.milestones[0]!.id}`);
        assert.include(omarTurn, "only checkout/");
      }),
  );

  it.effect("a milestone for someone without a thread waits, then goes out on the next tick", () =>
    Effect.gen(function* () {
      const goals = yield* ProjectGoals;
      const store = yield* LedgerStore;
      yield* store.putThread(thread("t-ana2", "u-ana", "Ana", 3));
      const goal = yield* goals.create({
        projectId: "p1",
        actor: person("u-ana", "Ana", true),
        threadId: "t-ana2",
        plan: { title: "Docs", milestones: [{ title: "Write docs", assignee: "Zoe" }] },
      });
      assert.strictEqual(goal.milestones[0]!.assignee.kind, "unknown");
      const blocked = yield* goals
        .confirm({ goalId: goal.id, actor: person("u-ana", "Ana", true) })
        .pipe(Effect.flip);
      assert.strictEqual(blocked.reason, "invalid");
      // Picked: the host gives it to Priya, who has a thread.
      yield* goals.edit({
        goalId: goal.id,
        actor: person("u-ana", "Ana", true),
        plan: { title: "Docs", milestones: [{ title: "Write docs", assignee: "Priya" }] },
      });
      yield* store.putThread({ ...thread("t-priya", "u-priya", "Priya", 1), projectId: "p-other" });
      const confirmed = yield* goals.confirm({
        goalId: goal.id,
        actor: person("u-ana", "Ana", true),
      });
      assert.strictEqual(confirmed.milestones[0]!.status, "pending");
      yield* store.putThread(thread("t-priya", "u-priya", "Priya", 1));
      yield* goals.tick();
      assert.strictEqual(goals.get(goal.id)!.milestones[0]!.threadId, "t-priya");
    }),
  );

  it.effect(
    "drift: an out-of-scope edit, the wrong branch and a new dependency are logged once",
    () =>
      Effect.gen(function* () {
        const goals = yield* ProjectGoals;
        const goal = (yield* goals.list("p1"))[0]!;
        const added = yield* goals.checkThread({
          threadId: "t-omar",
          files: ["api/server.ts"],
          turnEnd: false,
        });
        assert.deepStrictEqual(
          added.map((d) => d.reason),
          ["avoided_path"],
        );
        assert.strictEqual(added[0]!.subject.who.name, "Omar");
        // In scope: nothing new.
        assert.lengthOf(
          yield* goals.checkThread({
            threadId: "t-omar",
            files: ["checkout/a.ts"],
            turnEnd: false,
          }),
          0,
        );
        work.set("t-omar", { cwd: "/repo", branch: "main", lastReply: "" });
        manifests.set("package.json", {
          before: JSON.stringify({ dependencies: {} }),
          after: JSON.stringify({ dependencies: { stripe: "1" } }),
        });
        const atEnd = yield* goals.checkThread({
          threadId: "t-omar",
          files: ["package.json"],
          turnEnd: true,
        });
        assert.deepStrictEqual(atEnd.map((d) => d.reason).sort(), [
          "new_dependency",
          "outside_scope",
          "wrong_branch",
        ]);
        // The same evidence again adds nothing.
        assert.lengthOf(
          yield* goals.checkThread({ threadId: "t-omar", files: [], turnEnd: true }),
          0,
        );
        // A thread with no milestone is never checked.
        assert.lengthOf(
          yield* goals.checkThread({ threadId: "t-ana", files: ["api/x.ts"], turnEnd: true }),
          0,
        );
        assert.strictEqual(goals.get(goal.id)!.decisions.length, 4);
      }),
  );

  it.effect(
    "Message delivers the host's text into the person's thread and logs the resolution",
    () =>
      Effect.gen(function* () {
        const goals = yield* ProjectGoals;
        const store = yield* LedgerStore;
        const goal = (yield* goals.list("p1"))[0]!;
        const drift = goal.decisions[0]!;
        const notAllowed = yield* goals
          .decide({
            goalId: goal.id,
            decisionId: drift.id,
            actor: person("u-omar", "Omar"),
            action: "ignore",
          })
          .pipe(Effect.flip);
        assert.strictEqual(notAllowed.reason, "forbidden");
        const before = store.messages("p1").length;
        // A message needs text; "watch" is the app's own and never decided here.
        for (const [action, reason] of [
          ["message", "invalid"],
          ["watch", "invalid"],
          ["approve", "invalid"],
        ] as const) {
          const refused = yield* goals
            .decide({
              goalId: goal.id,
              decisionId: drift.id,
              actor: person("u-ana", "Ana", true),
              action,
            })
            .pipe(Effect.flip);
          assert.strictEqual(refused.reason, reason);
        }
        const next = yield* goals.decide({
          goalId: goal.id,
          decisionId: drift.id,
          actor: person("u-ana", "Ana", true),
          action: "message",
          note: "Please keep out of api/",
        });
        const messages = store.messages("p1");
        assert.strictEqual(messages.length, before + 1);
        assert.deepInclude(messages.at(-1)!, {
          toThreadId: "t-omar",
          fromName: "Ana",
          text: "Please keep out of api/",
        });
        assert.isUndefined(messages.at(-1)!.goalTask);
        assert.deepInclude(next.decisions[0]!, { status: "resolved" });
        assert.strictEqual(next.decisions[0]!.resolution?.action, "message");
        const accepted = yield* goals.decide({
          goalId: goal.id,
          decisionId: goal.decisions[1]!.id,
          actor: person("u-ana", "Ana", true),
          action: "accept",
        });
        assert.strictEqual(accepted.decisions[1]!.resolution?.action, "accept");
      }),
  );

  it.effect("review: Priya's agent marks done, only Ana approves, progress follows", () =>
    Effect.gen(function* () {
      const goals = yield* ProjectGoals;
      const goal = (yield* goals.list("p1"))[0]!;
      const priyas = goal.milestones[1]!;
      // Omar's agent cannot touch Priya's milestone.
      const omarAgent = (yield* goals.agentActor("t-omar"))!;
      const wrong = yield* goals
        .updateMilestone({ milestoneId: priyas.id, actor: omarAgent, status: "done" })
        .pipe(Effect.flip);
      assert.strictEqual(wrong.reason, "forbidden");
      const priyaAgent = (yield* goals.agentActor("t-priya"))!;
      const done = yield* goals.updateMilestone({
        milestoneId: priyas.id,
        actor: priyaAgent,
        status: "done",
        note: "All green",
        report: [{ criterion: "E2E passes", met: true, evidence: "12/12" }],
      });
      assert.strictEqual(done.milestones[1]!.status, "done");
      const store = yield* LedgerStore;
      const before = store.messages("p1").length;
      // Done raised a review request; the host answers it like any other.
      const request = done.decisions.find(
        (entry) => entry.kind === "goal.review" && entry.status === "open",
      )!;
      assert.strictEqual(request.subject.milestoneId, priyas.id);
      const approved = yield* goals.decide({
        goalId: goal.id,
        decisionId: request.id,
        actor: person("u-ana", "Ana", true),
        action: "approve",
      });
      assert.strictEqual(
        approved.decisions.find((entry) => entry.id === request.id)!.status,
        "resolved",
      );
      assert.strictEqual(approved.milestones[1]!.status, "approved");
      // Priya hears about it in her thread.
      assert.strictEqual(store.messages("p1").length, before + 1);
      assert.include(store.messages("p1").at(-1)!.text, "Approved");
    }),
  );
});
