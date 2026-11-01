// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalConsole:off - a standalone script driving real Blender processes.
/**
 * Blender recipe end to end against a real headless Blender (skips when missing):
 * `node apps/server/scripts/recipe-blender-e2e.ts`. Launches, drives the MCP server
 * from .mcp.json, branches from a snapshot, makes clashing edits, merges, checks.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

import { connectBridge, readBridgeInfo } from "../src/recipes/bridgeClient.ts";
import { detectRecipeApp, launchRecipe } from "../src/recipes/recipeRunner.ts";
import { findBuiltInRecipe } from "@logicpacks/shared/recipes/builtin";

const repo = NodePath.resolve(import.meta.dirname, "..", "..", "..");
const blender = findBuiltInRecipe("blender")!;
if (!detectRecipeApp(blender)) {
  console.log("SKIP: Blender is not installed here.");
  process.exit(0);
}

const project = NodeFS.mkdtempSync(
  NodePath.join(process.env["TMPDIR"] ?? NodeOS.tmpdir(), "lp-recipe-e2e-"),
);
const failures: string[] = [];
const check = (label: string, ok: boolean, detail?: unknown) => {
  console.log(
    `${ok ? "PASS" : "FAIL"} ${label}${ok || detail === undefined ? "" : ` ${JSON.stringify(detail)}`}`,
  );
  if (!ok) failures.push(label);
};

const cli = {
  command: process.execPath,
  args: [NodePath.join(repo, "apps/server/src/bin.ts")],
  env: {},
};
const main = await launchRecipe({ recipeId: "blender", project, headless: true, cli });
check("main Blender started headless with a bridge", main.port !== null, main);

// The MCP server exactly as an agent session would start it.
const mcpConfig = JSON.parse(NodeFS.readFileSync(main.mcpConfigPath!, "utf8"));
const server = mcpConfig.mcpServers["logicpacks-blender"];
const mcp = NodeChildProcess.spawn(server.command, server.args, {
  stdio: ["pipe", "pipe", "inherit"],
  env: {
    ...process.env,
    ...server.env,
    LP_RECIPE_AGENT_ID: "agent-a",
    LP_RECIPE_AGENT_NAME: "Agent A",
  },
});
const replies = new Map<number, (value: any) => void>();
NodeReadline.createInterface({ input: mcp.stdout! }).on("line", (line) => {
  const message = JSON.parse(line);
  replies.get(message.id)?.(message);
});
let nextId = 1;
const rpc = (method: string, params: Record<string, unknown> = {}) =>
  new Promise<any>((done) => {
    const id = nextId++;
    replies.set(id, done);
    mcp.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
const tool = async (name: string, args: Record<string, unknown> = {}) => {
  const reply = await rpc("tools/call", { name, arguments: args });
  if (reply.result?.isError) throw new Error(`${name}: ${reply.result.content[0].text}`);
  return JSON.parse(reply.result.content[0].text);
};

const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
check("MCP initialize", init.result?.serverInfo?.name === "logicpacks-blender", init);
const listed = await rpc("tools/list");
check("MCP lists 9 tools", listed.result?.tools?.length === 9, listed.result?.tools?.length);

const scene = await tool("blender_list_scene");
const cube = scene.objects.find((object: any) => object.name === "Cube");
check("default scene has a Cube with an lp_id", Boolean(cube?.id), scene);
const ball = (
  await tool("blender_add_object", { primitive: "uv_sphere", name: "Ball", location: [0, 3, 0] })
).object;
const snap = await tool("blender_snapshot", { name: "fork" });
check("snapshot written", typeof snap.blend === "string", snap);

// Branch: a second Blender on the snapshot, with the snapshot's op log as its history.
const branchSession = NodePath.join(project, ".logicpacks", "blender", "agent-b");
NodeFS.mkdirSync(branchSession, { recursive: true });
NodeFS.copyFileSync(
  NodePath.join(snap.dir, "oplog.jsonl"),
  NodePath.join(branchSession, "oplog.jsonl"),
);
const branch = await launchRecipe({
  recipeId: "blender",
  project,
  session: branchSession,
  file: snap.blend,
  headless: true,
  writeMcpConfig: false,
});
check("branch Blender started on the snapshot", branch.port !== null, branch);
const agentB = await connectBridge((await readBridgeInfo(branchSession))!);
const actorB = { kind: "agent" as const, id: "agent-b", name: "Agent B" };
await agentB.call("modify_object", { id: cube.id, props: { location: [5, 0, 0] } }, actorB);
await agentB.call(
  "modify_object",
  { id: ball.id, props: { name: "Planet", scale: [2, 2, 2] } },
  actorB,
);
await agentB.call("add_object", { primitive: "torus", name: "Ring", location: [0, 3, 2] }, actorB);

// Main keeps working meanwhile: one clash (the cube) and one clean edit.
await tool("blender_modify_object", { id: cube.id, props: { location: [-5, 0, 0] } });
await tool("blender_add_object", { primitive: "cone", name: "Tree", location: [3, 3, 0] });

const merged = await tool("blender_merge", { theirs: branchSession });
console.log(JSON.stringify(merged, null, 2));
const conflictProps = merged.conflicts.map((c: any) => `${c.objectId}.${c.property}`);
check(
  "cube location reported as a conflict",
  conflictProps.includes(`${cube.id}.location`),
  conflictProps,
);
check("exactly one conflict", merged.conflicts.length === 1, merged.conflicts);
check(
  "conflict names both agents",
  merged.conflicts[0]?.oursActor?.id === "agent-a" &&
    merged.conflicts[0]?.theirsActor?.id === "agent-b",
  merged.conflicts[0],
);

const after = (await tool("blender_list_scene")).objects;
const byName = (name: string) => after.find((object: any) => object.name === name);
check(
  "rename from the branch applied",
  byName("Planet")?.id === ball.id,
  after.map((o: any) => o.name),
);
check("scale from the branch applied", byName("Planet")?.scale?.[0] === 2, byName("Planet"));
check("object added on the branch arrived", byName("Ring")?.primitive === "torus", byName("Ring"));
check(
  "main's own addition kept",
  Boolean(byName("Tree")),
  after.map((o: any) => o.name),
);
check("ours kept on the conflict", byName("Cube")?.location?.[0] === -5, byName("Cube"));

const log = await tool("blender_export_oplog");
const actors = new Set(log.ops.map((op: any) => op.actor.id));
check("op log credits agent-a and agent-b", actors.has("agent-a") && actors.has("agent-b"), [
  ...actors,
]);

await agentB.call("quit");
agentB.close();
const mainBridge = await connectBridge((await readBridgeInfo(main.session))!);
await mainBridge.call("quit");
mainBridge.close();
mcp.kill();
await new Promise((done) => setTimeout(done, 1500));
if (failures.length === 0) NodeFS.rmSync(project, { recursive: true, force: true });
else console.log(`Kept ${project} for inspection.`);
console.log(failures.length === 0 ? "ALL PASSED" : `${failures.length} FAILED`);
process.exit(failures.length === 0 ? 0 : 1);
