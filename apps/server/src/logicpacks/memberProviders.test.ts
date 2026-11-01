import { describe, expect, it } from "@effect/vitest";

import {
  decideInstanceUse,
  memberClaudeInstanceId,
  providersForMember,
  selectedInstanceId,
  threadRunWithoutSelection,
} from "./memberProviders.ts";

describe("member provider instances", () => {
  const mine = memberClaudeInstanceId("alice");
  const theirs = memberClaudeInstanceId("bob");

  it("gives each member a stable, valid instance id", () => {
    expect(mine).toBe(memberClaudeInstanceId("alice"));
    expect(mine).not.toBe(theirs);
    expect(mine).toMatch(/^[a-zA-Z][a-zA-Z0-9_-]*$/);
  });

  it("never lets a member spend another member's login", () => {
    expect(decideInstanceUse({ instanceId: mine, userId: "alice", membersMustUseOwn: true })).toBe(
      "allow",
    );
    expect(
      decideInstanceUse({ instanceId: theirs, userId: "alice", membersMustUseOwn: false }),
    ).toBe("someone_elses");
    expect(
      decideInstanceUse({ instanceId: "claudeAgent", userId: "alice", membersMustUseOwn: false }),
    ).toBe("allow");
    expect(
      decideInstanceUse({ instanceId: "claudeAgent", userId: "alice", membersMustUseOwn: true }),
    ).toBe("needs_own_login");
  });

  it("reads the instance from either model selection shape", () => {
    expect(selectedInstanceId({ modelSelection: { instanceId: "a", model: "m" } })).toBe("a");
    expect(selectedInstanceId({ modelSelection: { provider: "codex", model: "m" } })).toBe("codex");
    expect(selectedInstanceId({ projectId: "p" })).toBeNull();
  });

  it("checks the thread's instance when a message names no model", () => {
    expect(threadRunWithoutSelection({ type: "message.dispatch", threadId: "t1" })).toBe("t1");
    expect(
      threadRunWithoutSelection({
        type: "message.dispatch",
        threadId: "t1",
        modelSelection: { instanceId: "a", model: "m" },
      }),
    ).toBeNull();
    expect(threadRunWithoutSelection({ type: "thread.archive", threadId: "t1" })).toBeNull();
  });
  it("lists only the logins a member may use", () => {
    const host = { instanceId: "claudeAgent" };
    const own = { instanceId: mine };
    const other = { instanceId: theirs };
    const ids = (list: ReadonlyArray<{ readonly instanceId: string }>) =>
      list.map((provider) => provider.instanceId);
    // Before connecting, the host's logins stay listed so the refusal explains itself.
    expect(
      ids(providersForMember([host, other], { userId: "alice", membersMustUseOwn: true })),
    ).toEqual(["claudeAgent"]);
    expect(
      ids(providersForMember([host, own, other], { userId: "alice", membersMustUseOwn: true })),
    ).toEqual([mine]);
    // A host that lends its logins keeps them listed beside the member's own.
    expect(
      ids(providersForMember([host, own, other], { userId: "alice", membersMustUseOwn: false })),
    ).toEqual(["claudeAgent", mine]);
  });
});
