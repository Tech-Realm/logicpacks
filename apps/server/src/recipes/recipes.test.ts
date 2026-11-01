// @effect-diagnostics nodeBuiltinImport:off globalDate:off - exercises the plain async recipe runner against temp folders and fixed op times.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { RecipeActor, RecipeOp } from "@logicpacks/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { agentActorFromEnv, blenderMcpTools, mergeIntoBridge } from "./blenderMcp.ts";
import { handleMcpRequest } from "./mcpStdio.ts";
import {
  currentCliInvocation,
  defaultRecipeSession,
  writeProjectMcpConfig,
} from "./recipeRunner.ts";

const human: RecipeActor = { kind: "human", id: "sara" };
const agentB: RecipeActor = { kind: "agent", id: "agent-b" };

const op = (
  seq: number,
  partial: Omit<RecipeOp, "id" | "seq" | "at"> & { id?: string },
): RecipeOp => ({
  id: partial.id ?? `op-${seq}`,
  seq,
  at: new Date(Date.UTC(2026, 9, 31, 12, 0, seq)).toISOString(),
  ...partial,
});

const base = [
  op(1, {
    id: "b1",
    actor: human,
    kind: "object.add",
    objectId: "cube",
    objectType: "MESH",
    value: { name: "Cube", location: [0, 0, 0] },
  }),
];

const dirs: string[] = [];
const tempDir = () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lp-recipes-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
});

function fakeBridge(ours: RecipeOp[]) {
  const calls: Array<{ cmd: string; args: unknown }> = [];
  return {
    calls,
    call: async (cmd: string, args: Record<string, unknown> = {}) => {
      calls.push({ cmd, args });
      if (cmd === "export_oplog") return { ops: ours };
      if (cmd === "apply_ops")
        return { applied: (args["drafts"] as unknown[]).length, skipped: [] };
      return {};
    },
  };
}

describe("mergeIntoBridge", () => {
  it("applies the clean part, reports the clash and writes a report", async () => {
    const session = tempDir();
    const ours = [
      ...base,
      op(2, {
        actor: human,
        kind: "object.set",
        objectId: "cube",
        property: "location",
        value: [1, 0, 0],
      }),
    ];
    const theirs = [
      ...base,
      op(3, {
        actor: agentB,
        kind: "object.set",
        objectId: "cube",
        property: "location",
        value: [2, 0, 0],
      }),
      op(4, {
        actor: agentB,
        kind: "object.set",
        objectId: "cube",
        property: "name",
        value: "Box",
      }),
    ];
    const bridge = fakeBridge(ours);
    const outcome = await mergeIntoBridge({
      bridge,
      session,
      theirs,
      from: "agent-b",
      actor: human,
      now: () => new Date("2026-10-31T12:00:00.000Z"),
    });
    expect(outcome.report.baseOps).toBe(1);
    expect(outcome.report.applied).toBe(1);
    expect(outcome.report.conflicts).toHaveLength(1);
    expect(outcome.report.conflicts[0]).toMatchObject({
      property: "location",
      theirsActor: agentB,
    });
    const applied = bridge.calls.find((call) => call.cmd === "apply_ops")?.args as {
      drafts: Array<{ property?: string; value?: unknown }>;
    };
    expect(applied.drafts).toEqual([expect.objectContaining({ property: "name", value: "Box" })]);
    expect(JSON.parse(NodeFS.readFileSync(outcome.reportPath, "utf8")).from).toBe("agent-b");
  });

  it("refuses logs with no shared history", async () => {
    const theirs = [
      op(9, { id: "x", actor: agentB, kind: "object.add", objectId: "y", value: {} }),
    ];
    await expect(
      mergeIntoBridge({
        bridge: fakeBridge(base),
        session: tempDir(),
        theirs,
        from: "x",
        actor: human,
      }),
    ).rejects.toThrow(/share no history/);
  });
});

describe("MCP over stdio", () => {
  const server = {
    name: "logicpacks-blender",
    version: "0.1.0",
    tools: blenderMcpTools({
      session: "/nowhere",
      actor: agentActorFromEnv({}),
      bridge: async () => ({
        call: async (cmd: string) => ({ cmd }),
        close: () => undefined,
      }),
    }),
  };

  it("initializes and lists the recipe's tools", async () => {
    const init = await handleMcpRequest(server, { jsonrpc: "2.0", id: 1, method: "initialize" });
    expect(init).toMatchObject({ result: { serverInfo: { name: "logicpacks-blender" } } });
    const list = (await handleMcpRequest(server, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    })) as {
      result: { tools: Array<{ name: string }> };
    };
    expect(list.result.tools.map((tool) => tool.name)).toContain("blender_merge");
    expect(list.result.tools).toHaveLength(9);
  });

  it("calls a tool through the bridge and reports errors as tool errors", async () => {
    const ok = await handleMcpRequest(server, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "blender_status", arguments: {} },
    });
    expect(JSON.stringify(ok)).toContain("status");
    const unknown = await handleMcpRequest(server, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "nope" },
    });
    expect(unknown).toMatchObject({ error: { code: -32602 } });
    expect(
      await handleMcpRequest(server, { jsonrpc: "2.0", method: "notifications/initialized" }),
    ).toBeNull();
  });
});

describe("runner helpers", () => {
  it("puts each branch in its own session", () => {
    expect(defaultRecipeSession("/p", "blender", "Agent B")).toBe("/p/.logicpacks/blender/agent-b");
    expect(defaultRecipeSession("/p", "blender")).toBe("/p/.logicpacks/blender/main");
  });

  it("merges into an existing .mcp.json instead of replacing it", async () => {
    const project = tempDir();
    await writeProjectMcpConfig({ project, name: "other", command: "x", args: [] });
    const path = await writeProjectMcpConfig({
      project,
      name: "logicpacks-blender",
      command: "logicpacks",
      args: ["recipe", "mcp", "blender"],
    });
    expect(Object.keys(JSON.parse(NodeFS.readFileSync(path, "utf8")).mcpServers)).toEqual([
      "other",
      "logicpacks-blender",
    ]);
    // Claude sessions skip project servers nobody approved on this machine.
    expect(
      JSON.parse(
        NodeFS.readFileSync(NodePath.join(project, ".claude", "settings.local.json"), "utf8"),
      ),
    ).toEqual({ enabledMcpjsonServers: ["other", "logicpacks-blender"] });
  });

  it("runs the desktop app's logicpacks through its shim, else this runtime as node", () => {
    const shim = NodePath.join(tempDir(), "logicpacks");
    NodeFS.writeFileSync(shim, "");
    expect(currentCliInvocation({ LOGICPACKS_CLI_PATH: shim })).toEqual({
      command: shim,
      args: [],
      env: {},
    });
    expect(currentCliInvocation({ ELECTRON_RUN_AS_NODE: "1" })).toMatchObject({
      command: process.execPath,
      env: { ELECTRON_RUN_AS_NODE: "1" },
    });
  });
});
