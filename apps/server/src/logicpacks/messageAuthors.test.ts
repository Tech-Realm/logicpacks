// @effect-diagnostics nodeBuiltinImport:off -- a tiny synchronous JSON file store.
import * as NodeFS from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import { describe, expect, it } from "@effect/vitest";

import { canSetPersonColor } from "./messageAuthorsHttp.ts";
import {
  defaultPersonColor,
  dispatchedMessage,
  MessageAuthorStore,
} from "./messageAuthors.ts";
import { LogicPacksAccess } from "./LogicPacksAccess.ts";

const tmpFile = () => NodePath.join(NodeFS.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "lp-authors-")), "lp-message-authors.json");

describe("MessageAuthorStore", () => {
  it("records authors, first write wins, and survives a reload", () => {
    const path = tmpFile();
    const store = new MessageAuthorStore(path);
    store.record("t1", "m1", "ann");
    store.record("t1", "m1", "bob");
    store.record("t1", "m2", null);
    expect(store.authorsOf("t1")).toEqual({ m1: "ann", m2: null });
    expect(JSON.parse(NodeFS.readFileSync(path, "utf8")).threads.t1.m1).toBe("ann");
    expect(new MessageAuthorStore(path).authorsOf("t1")).toEqual({ m1: "ann", m2: null });
  });

  it("uses the stable hash until an admin colour is set", () => {
    const store = new MessageAuthorStore(tmpFile());
    expect(store.colorOf("ann")).toBe(defaultPersonColor("ann"));
    expect(defaultPersonColor("ann")).toBeGreaterThanOrEqual(0);
    expect(defaultPersonColor("ann")).toBeLessThan(8);
    const other = (defaultPersonColor("ann") + 1) % 8;
    expect(store.setColor("ann", other)).toBe(true);
    expect(store.colorOf("ann")).toBe(other);
    expect(store.setColor("ann", 8)).toBe(false);
    expect(store.setColor("ann", -1)).toBe(false);
    expect(store.colorOf(null)).toBe(defaultPersonColor(null));
  });

  it("gives people in one project different colours even when their hashes collide", () => {
    const store = new MessageAuthorStore(tmpFile());
    const ids = Array.from({ length: 40 }, (_, index) => `user-${index}`);
    const first = ids[0]!;
    const clash = ids.find((id) => id !== first && defaultPersonColor(id) === defaultPersonColor(first));
    expect(clash).toBeDefined();
    store.record("t1", "m1", first);
    store.record("t1", "m2", clash!);
    store.record("t1", "m3", null);
    const colors = new Set([store.colorOf(first), store.colorOf(clash!), store.colorOf(null)]);
    expect(colors.size).toBe(3);
  });

  it("starts empty from a damaged file", () => {
    expect(new MessageAuthorStore("/nonexistent-dir-x/none.json").authorsOf("t")).toEqual({});
  });
});

describe("dispatchedMessage", () => {
  it("reads message.dispatch and launchThread initial messages", () => {
    expect(
      dispatchedMessage("orchestration.dispatchCommand", { type: "message.dispatch", threadId: "t", messageId: "m" }, {}),
    ).toEqual({ threadId: "t", messageId: "m" });
    expect(
      dispatchedMessage("orchestration.launchThread", { initialMessage: { messageId: "m" } }, { threadId: "t" }),
    ).toEqual({ threadId: "t", messageId: "m" });
    expect(dispatchedMessage("orchestration.launchThread", { initialMessage: {} }, { threadId: "t" })).toBeNull();
    expect(dispatchedMessage("orchestration.dispatchCommand", { type: "thread.create" }, {})).toBeNull();
  });
});

describe("canSetPersonColor", () => {
  const access = {
    listWorkspaces: (userId: string) => [
      { workspaceId: "w1", role: userId === "owner" ? "owner" : "member" },
    ],
    listWorkspaceMembers: () => Effect.succeed([{ user: { userId: "ann" } }]),
  } as unknown as LogicPacksAccess["Service"];
  const run = (caller: Parameters<typeof canSetPersonColor>[0], target: string | null) =>
    Effect.runPromise(
      canSetPersonColor(caller, target).pipe(Effect.provideService(LogicPacksAccess, access)),
    );

  it("allows the host operator and a workspace owner of the person's workspace", async () => {
    expect(await run({ kind: "operator" }, "ann")).toBe(true);
    expect(await run({ kind: "member", userId: "owner" }, "ann")).toBe(true);
  });
  it("refuses plain members, strangers and anonymous callers", async () => {
    expect(await run({ kind: "member", userId: "bob" }, "ann")).toBe(false);
    expect(await run({ kind: "member", userId: "owner" }, "zed")).toBe(false);
    expect(await run({ kind: "member", userId: "owner" }, null)).toBe(false);
    expect(await run({ kind: "anonymous" }, "ann")).toBe(false);
  });
});
