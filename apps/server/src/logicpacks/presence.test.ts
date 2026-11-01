import { describe, expect, it } from "@effect/vitest";
import { ProjectId, ThreadId } from "@logicpacks/contracts";

import {
  agentAppTouchFromTurnItem,
  agentTouchFromTurnItem,
  applyPresenceWrite,
  describePresence,
  dropPresenceWhere,
  expirePresence,
  normalizePresencePath,
  positionOfText,
  type PresenceRecord,
  type PresenceWrite,
  relativeToRoots,
} from "./presence.ts";
import { agentActorFor } from "./presenceConnection.ts";

const projectId = ProjectId.make("project-1");
const base: PresenceWrite = {
  key: "socket-a:tab-1",
  clientId: "tab-1",
  connectionId: "socket-a",
  projectId,
  actor: { id: "lp-user:ali", kind: "human", name: "Ali", colorIndex: 3 },
  source: "web",
  location: { view: "file", activity: "viewing", path: "src/a.ts", cursor: { line: 4, column: 2 } },
  nowMs: 1_000,
  ttlMs: 75_000,
};

describe("presence writes", () => {
  it("broadcasts moves, stays quiet on heartbeats, and keeps `since` until the file changes", () => {
    const records = new Map<string, PresenceRecord>();
    const first = applyPresenceWrite(records, base);
    expect(first?.type).toBe("upsert");

    expect(applyPresenceWrite(records, { ...base, nowMs: 31_000 })).toBeNull();
    expect(records.get(base.key)?.expiresAtMs).toBe(106_000);

    const moved = applyPresenceWrite(records, {
      ...base,
      nowMs: 40_000,
      location: { ...base.location!, cursor: { line: 9, column: 0 } },
    });
    expect(moved?.type === "upsert" && moved.entry.since).toBe("1970-01-01T00:00:01.000Z");

    const otherFile = applyPresenceWrite(records, {
      ...base,
      nowMs: 50_000,
      location: { view: "file", activity: "editing", path: "src/b.ts" },
    });
    expect(otherFile?.type === "upsert" && otherFile.entry.since).toBe("1970-01-01T00:00:50.000Z");

    expect(applyPresenceWrite(records, { ...base, location: null })).toEqual({
      type: "remove",
      key: base.key,
    });
    expect(applyPresenceWrite(records, { ...base, location: null })).toBeNull();
  });

  it("expires idle reporters and drops a closed connection's entries only", () => {
    const records = new Map<string, PresenceRecord>();
    applyPresenceWrite(records, base);
    applyPresenceWrite(records, {
      ...base,
      key: "socket-b:tab-9",
      clientId: "tab-9",
      connectionId: "socket-b",
      nowMs: 60_000,
    });
    expect(dropPresenceWhere(records, (record) => record.connectionId === "socket-a")).toEqual([
      { type: "remove", key: base.key },
    ]);
    expect(expirePresence(records, 134_999)).toEqual([]);
    expect(expirePresence(records, 135_000)).toEqual([{ type: "remove", key: "socket-b:tab-9" }]);
  });

  it("describes a spot the way agents and hover cards read it", () => {
    const records = new Map<string, PresenceRecord>();
    applyPresenceWrite(records, {
      ...base,
      actor: { ...base.actor, kind: "agent", name: "Ali's agent" },
      location: {
        view: "file",
        activity: "editing",
        path: "src/checkout.tsx",
        cursor: { line: 42, column: 0 },
      },
    });
    const entry = records.get(base.key)!.entry;
    expect(describePresence(entry, 1_000 + 2 * 60_000)).toBe(
      "Ali's agent editing src/checkout.tsx:42, 2m",
    );
  });
});

describe("presence paths", () => {
  it("keeps paths inside the project", () => {
    expect(normalizePresencePath("./src//a.ts")).toBe("src/a.ts");
    expect(normalizePresencePath("src\\win\\b.ts")).toBe("src/win/b.ts");
    expect(normalizePresencePath("../secret")).toBeNull();
    expect(normalizePresencePath("/etc/passwd")).toBeNull();
    expect(normalizePresencePath("C:\\x")).toBeNull();
  });

  it("maps an agent's absolute tool path through the thread worktree or project root", () => {
    const roots = ["/repo/.logicpacks/worktrees/feature", "/repo"];
    expect(relativeToRoots("/repo/.logicpacks/worktrees/feature/src/a.ts", roots)).toBe("src/a.ts");
    expect(relativeToRoots("/repo/src/b.ts", roots)).toBe("src/b.ts");
    expect(relativeToRoots("src/c.ts", roots)).toBe("src/c.ts");
    expect(relativeToRoots("/elsewhere/d.ts", roots)).toBeNull();
    expect(relativeToRoots("/repository/e.ts", roots)).toBeNull();
  });

  it("finds where written text landed", () => {
    expect(positionOfText("one\ntwo\n  three", "three")).toEqual({ line: 3, column: 2 });
    expect(positionOfText("abc", "zzz")).toBeNull();
    expect(positionOfText("abc", "")).toBeNull();
  });
});

describe("agent tool calls", () => {
  const item = { threadId: ThreadId.make("thread-1") };

  it("places edits and reads, and ignores other tools", () => {
    expect(
      agentTouchFromTurnItem({ ...item, type: "file_change", fileName: "/r/a.ts", newStr: "x" }),
    ).toEqual({ filePath: "/r/a.ts", activity: "editing", writtenText: "x" });
    expect(
      agentTouchFromTurnItem({
        ...item,
        type: "file_change",
        fileName: "2 files",
        changes: [{ path: "/r/b.ts" }, { path: "/r/c.ts" }],
      }),
    ).toEqual({ filePath: "/r/b.ts", activity: "editing", writtenText: undefined });
    expect(
      agentTouchFromTurnItem({
        ...item,
        type: "dynamic_tool",
        toolName: "Read",
        input: { file_path: "/r/d.ts" },
      }),
    ).toEqual({ filePath: "/r/d.ts", activity: "reading" });
    expect(
      agentTouchFromTurnItem({
        ...item,
        type: "dynamic_tool",
        toolName: "Grep",
        input: { path: "/r" },
      }),
    ).toBeNull();
    expect(agentTouchFromTurnItem({ ...item, type: "command_execution" })).toBeNull();
  });
});

describe("agent actors", () => {
  it("names an agent after its session owner and wears the owner's colour", () => {
    const owner = { id: "lp-user:ali", name: "Ali" };
    const plain = agentActorFor(owner, "a");
    expect(plain.name).toBe("Ali's agent");
    expect(agentActorFor(owner, "b", "Claude Code").name).toBe("Ali's Claude Code");
    // A reporter cannot rename the owner: its own possessive is dropped.
    expect(agentActorFor(owner, "c", "Noor's agent").name).toBe("Ali's agent");
    expect(agentActorFor(owner, "d", "  ").name).toBe("Ali's agent");
    expect(agentActorFor(owner, "e", "Claude").colorIndex).toBe(plain.colorIndex);
  });
});

describe("presence in app recipes", () => {
  it("places an agent on the Blender object its MCP tool call is on", () => {
    const tool = (toolName: string, input: unknown) => ({ type: "dynamic_tool", toolName, input });
    expect(
      agentAppTouchFromTurnItem(
        tool("mcp__blender__blender_modify_object", { id: "lp-7", props: { location: [0, 0, 1] } }),
      ),
    ).toEqual({ recipeId: "blender", itemId: "lp-7", activity: "editing" });
    expect(
      agentAppTouchFromTurnItem(tool("blender/blender_delete_object", { name: "Wheel" })),
    ).toEqual({ recipeId: "blender", itemId: "Wheel", label: "Wheel", activity: "editing" });
    // An added object has no id yet: its requested name places the agent.
    expect(
      agentAppTouchFromTurnItem(tool("blender_add_object", { primitive: "cube", name: "Crate" })),
    ).toEqual({ recipeId: "blender", itemId: "Crate", label: "Crate", activity: "editing" });
    expect(
      agentAppTouchFromTurnItem(tool("blender_modify_object", { props: { name: "Lamp" } })),
    ).toEqual({ recipeId: "blender", itemId: "Lamp", label: "Lamp", activity: "editing" });
  });

  it("ignores scene-wide tools, unknown objects and file tools", () => {
    expect(
      agentAppTouchFromTurnItem({
        type: "dynamic_tool",
        toolName: "blender_list_scene",
        input: {},
      }),
    ).toBeNull();
    expect(
      agentAppTouchFromTurnItem({
        type: "dynamic_tool",
        toolName: "blender_add_object",
        input: {},
      }),
    ).toBeNull();
    expect(
      agentAppTouchFromTurnItem({
        type: "dynamic_tool",
        toolName: "not_blender_modify_objects",
        input: { id: "x" },
      }),
    ).toBeNull();
    expect(agentAppTouchFromTurnItem({ type: "file_change" })).toBeNull();
  });

  it("broadcasts a moved pointer over the app and stays quiet on a still one", () => {
    const records = new Map<string, PresenceRecord>();
    const app = {
      ...base,
      location: {
        view: "app" as const,
        activity: "viewing" as const,
        appItem: { recipeId: "blender", itemId: "lp-7", label: "Cube" },
        pointer: { x: 0.25, y: 0.5 },
      },
    };
    expect(applyPresenceWrite(records, app)?.type).toBe("upsert");
    expect(applyPresenceWrite(records, { ...app, nowMs: 2_000 })).toBeNull();
    const moved = applyPresenceWrite(records, {
      ...app,
      nowMs: 3_000,
      location: { ...app.location, pointer: { x: 0.3, y: 0.5 } },
    });
    expect(moved?.type).toBe("upsert");
    expect(describePresence(records.get(app.key)!.entry, 3_000)).toBe("Ali viewing Cube, just now");
  });
});
