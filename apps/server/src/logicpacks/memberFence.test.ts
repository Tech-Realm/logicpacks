import { describe, expect, it } from "@effect/vitest";

import { syncIntentTarget } from "./memberFence.ts";

describe("syncIntentTarget", () => {
  it("finds a sync request in a new thread's first message", () => {
    expect(
      syncIntentTarget("orchestration.launchThread", {
        projectId: "p1",
        initialMessage: { text: "sync this to the cloud", attachments: [] },
      }),
    ).toEqual({ projectId: "p1", threadId: "" });
  });

  it("finds a sync request sent to an existing thread", () => {
    expect(
      syncIntentTarget("orchestration.dispatchCommand", {
        type: "message.dispatch",
        threadId: "t1",
        text: "please sync this project to the cloud",
      }),
    ).toEqual({ projectId: null, threadId: "t1" });
  });

  it("ignores other messages and methods", () => {
    expect(
      syncIntentTarget("orchestration.dispatchCommand", {
        type: "message.dispatch",
        threadId: "t1",
        text: "add a footer",
      }),
    ).toBeNull();
    expect(syncIntentTarget("projects.writeFile", { text: "sync to the cloud" })).toBeNull();
  });
});
