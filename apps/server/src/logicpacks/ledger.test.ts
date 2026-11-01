import { describe, expect, it } from "@effect/vitest";

import {
  addMember,
  conflictParties,
  describeThread,
  recordFile,
  resolveTarget,
  summarizeGoal,
  turnContextText,
  whoIsWorkingOn,
  type LedgerConflict,
  type LedgerMessage,
  type LedgerThread,
} from "./ledger.ts";

const NOW = 10_000_000;
const thread = (input: Partial<LedgerThread> & { threadId: string }): LedgerThread => ({
  projectId: "p1",
  title: "Untitled",
  members: [],
  agent: null,
  goal: null,
  goalSource: "title",
  files: [],
  branch: "main",
  status: "idle",
  lastActiveAtMs: NOW - 60_000,
  branchedFrom: null,
  ...input,
});

const ana = { id: "u-ana", name: "Ana" };
const ali = { id: "u-ali", name: "Ali Khan" };
const threads: ReadonlyArray<LedgerThread> = [
  thread({
    threadId: "t1",
    title: "Checkout page",
    members: [ana],
    goal: "Fix the checkout total rounding",
    files: [{ path: "src/checkout.tsx", activity: "editing", by: "Ana's agent", atMs: NOW }],
    lastActiveAtMs: NOW - 30_000,
  }),
  thread({
    threadId: "t2",
    title: "Footer",
    members: [ali],
    goal: "Add a newsletter footer",
    files: [{ path: "src/footer.tsx", activity: "editing", by: "Ali Khan's agent", atMs: NOW }],
    lastActiveAtMs: NOW - 10_000,
  }),
  thread({ threadId: "t9", title: "Old", members: [ali], lastActiveAtMs: NOW - 900_000 }),
];

describe("summarizeGoal", () => {
  it("takes the first sentence without greetings or the ledger block", () => {
    expect(
      summarizeGoal(
        "<logicpacks_project>\nOther threads\n</logicpacks_project>\nHey, fix the login bug. Then deploy.",
      ),
    ).toBe("fix the login bug.");
    expect(summarizeGoal("  ")).toBeNull();
    expect(summarizeGoal("x".repeat(400))?.length).toBeLessThanOrEqual(140);
  });
});

describe("recordFile and addMember", () => {
  it("keeps one entry per path, newest first, and remembers editing", () => {
    let files = recordFile([], { path: "a.ts", activity: "editing", by: "A", atMs: 1 });
    files = recordFile(files, { path: "b.ts", activity: "reading", by: "A", atMs: 2 });
    files = recordFile(files, { path: "a.ts", activity: "reading", by: "A", atMs: 3 });
    expect(files.map((file) => `${file.path}:${file.activity}`)).toEqual([
      "a.ts:editing",
      "b.ts:reading",
    ]);
    const capped = Array.from({ length: 12 }, (_, i) => i).reduce(
      (acc, i) => recordFile(acc, { path: `f${i}`, activity: "reading", by: "A", atMs: i }),
      files,
    );
    expect(capped).toHaveLength(8);
  });

  it("adds a member once", () => {
    expect(addMember(addMember([], ana), ana)).toEqual([ana]);
  });
});

describe("whoIsWorkingOn", () => {
  it("finds a person by first name, most recent thread first", () => {
    const matches = whoIsWorkingOn(threads, "ali");
    expect(matches.map((match) => match.thread.threadId)).toEqual(["t2", "t9"]);
    expect(matches[0]?.why).toBe("person");
  });

  it("finds a file by path or name", () => {
    expect(whoIsWorkingOn(threads, "src/checkout.tsx")[0]?.thread.threadId).toBe("t1");
    expect(whoIsWorkingOn(threads, "checkout")[0]?.why).toBe("file");
  });

  it("finds a topic in goals and titles", () => {
    const matches = whoIsWorkingOn(threads, "who is working on the newsletter?");
    expect(matches.map((match) => match.thread.threadId)).toEqual(["t2"]);
    expect(matches[0]?.why).toBe("topic");
    expect(whoIsWorkingOn(threads, "kubernetes")).toEqual([]);
  });
});

describe("resolveTarget", () => {
  it("prefers an exact id, else the person's latest other thread", () => {
    expect(resolveTarget(threads, "t9", "t1")).toMatchObject({ kind: "thread" });
    const byName = resolveTarget(threads, "Ali", "t1");
    expect(byName.kind === "thread" && byName.thread.threadId).toBe("t2");
    const none = resolveTarget(threads, "Zed", "t1");
    expect(none.kind).toBe("none");
    expect(none.kind === "none" && none.message).toContain("Ana");
  });
});

describe("conflictParties", () => {
  it("joins threads on the files and the pushing author", () => {
    const parties = conflictParties({
      threads,
      files: ["src/checkout.tsx"],
      theirsAuthor: "Ali Khan",
      nowMs: NOW,
    });
    expect(parties.map((party) => party.threadId).sort()).toEqual(["t1", "t2", "t9"]);
  });

  it("falls back to recently active threads so nobody misses it", () => {
    const parties = conflictParties({
      threads,
      files: ["nobody.txt"],
      theirsAuthor: null,
      nowMs: NOW,
    });
    expect(parties.map((party) => party.threadId).sort()).toEqual(["t1", "t2", "t9"]);
  });
});

describe("turnContextText", () => {
  const base = {
    ownThreadId: "t1",
    projectTitle: "Shop",
    threads,
    inbox: [] as ReadonlyArray<LedgerMessage>,
    conflicts: [] as ReadonlyArray<LedgerConflict>,
    decisions: [],
    negotiationLines: [],
    nowMs: NOW,
  };

  it("is empty for a lone thread with nothing waiting", () => {
    expect(turnContextText({ ...base, threads: [threads[0]!] })).toBe("");
  });

  it("lists the other threads, the inbox with reply instructions, and conflicts", () => {
    const text = turnContextText({
      ...base,
      inbox: [
        {
          id: "m1",
          projectId: "p1",
          fromThreadId: "t2",
          fromName: "Ali Khan",
          toThreadId: "t1",
          text: "Please work on the coupon field",
          kind: "ask",
          replyTo: null,
          createdAtMs: NOW,
          deliveredAtMs: null,
          seenAtMs: null,
        },
      ],
      conflicts: [
        {
          id: "c1",
          projectId: "p1",
          source: "sync",
          files: ["src/checkout.tsx"],
          parties: [
            { threadId: "t1", name: "Ana" },
            { threadId: "t2", name: "Ali Khan" },
          ],
          people: ["Ana", "Ali Khan"],
          reason: "both changed the same lines",
          state: "open",
          negotiationId: null,
          createdAtMs: NOW,
          resolvedAtMs: null,
        },
      ],
    });
    expect(text.startsWith("<logicpacks_project>")).toBe(true);
    expect(text).toContain('Ali Khan in "Footer" [thread t2]');
    expect(text).toContain("goal: Add a newsletter footer");
    expect(text).toContain('replyTo "m1"');
    expect(text).toContain("Open conflict c1");
    expect(text).not.toContain("[thread t1]");
  });

  it("describes a thread in one line", () => {
    expect(describeThread(threads[0]!, NOW)).toContain("files: src/checkout.tsx (editing)");
  });
});
