// @effect-diagnostics nodeBuiltinImport:off globalDate:off - MCP tool handlers are plain async functions served over stdio outside the Effect runtime.
/**
 * The Blender recipe's agent tools. Each is a thin call into the bridge add-on
 * (blenderBridgeAddon.ts), which records every change in the session op log;
 * `blender_merge` runs the shared three-way merge and applies what merged cleanly.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type { RecipeActor, RecipeMergeReport, RecipeOp } from "@logicpacks/contracts";
import { findBuiltInRecipe } from "@logicpacks/shared/recipes/builtin";
import { mergeRecipeOpLogs, parseRecipeOpLog } from "@logicpacks/shared/recipes/opLog";

import type { BridgeClient } from "./bridgeClient.ts";
import type { McpTool } from "./mcpStdio.ts";

const vector = { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 };
const objectRef = {
  id: { type: "string", description: "The object's lp_id (preferred: survives renames)." },
  name: { type: "string", description: "The object's current name, when the id is unknown." },
};

export function agentActorFromEnv(env: NodeJS.ProcessEnv = process.env): RecipeActor {
  const id = env["LP_RECIPE_AGENT_ID"]?.trim() || "agent";
  const name = env["LP_RECIPE_AGENT_NAME"]?.trim();
  return { kind: "agent", id, ...(name ? { name } : {}) };
}

async function readTheirs(path: string): Promise<RecipeOp[]> {
  const info = await NodeFSP.stat(path);
  const file = info.isDirectory() ? NodePath.join(path, "oplog.jsonl") : path;
  return parseRecipeOpLog(await NodeFSP.readFile(file, "utf8"));
}

export interface BlenderMergeOutcome {
  readonly report: RecipeMergeReport;
  readonly reportPath: string;
  readonly skipped: ReadonlyArray<unknown>;
}

/**
 * Merge another branch's op log into the running scene. Refuses two logs with
 * no shared history: without a common base every object is "added on both
 * sides" and the result would be a guess, not a merge.
 */
export async function mergeIntoBridge(input: {
  readonly bridge: Pick<BridgeClient, "call">;
  readonly session: string;
  readonly theirs: ReadonlyArray<RecipeOp>;
  readonly from: string;
  readonly actor: RecipeActor;
  readonly now?: () => Date;
}): Promise<BlenderMergeOutcome> {
  const exported = (await input.bridge.call("export_oplog", {}, input.actor)) as {
    ops: RecipeOp[];
  };
  const ours = exported.ops;
  const merge = mergeRecipeOpLogs(ours, input.theirs);
  if (merge.baseOps === 0 && ours.length > 0 && input.theirs.length > 0) {
    throw new Error(
      "These two op logs share no history. Branch from a blender_snapshot, then merge that branch back.",
    );
  }
  const applied = (await input.bridge.call("apply_ops", { drafts: merge.apply }, input.actor)) as {
    applied: number;
    skipped: unknown[];
  };
  const at = (input.now?.() ?? new Date()).toISOString();
  const report: RecipeMergeReport = {
    at,
    from: input.from,
    into: input.session,
    baseOps: merge.baseOps,
    applied: applied.applied,
    conflicts: [...merge.conflicts],
  };
  const dir = NodePath.join(input.session, "merges");
  await NodeFSP.mkdir(dir, { recursive: true });
  const reportPath = NodePath.join(dir, `${at.replace(/[:.]/g, "-")}.json`);
  await NodeFSP.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return { report, reportPath, skipped: applied.skipped };
}

export function blenderMcpTools(input: {
  readonly session: string;
  readonly bridge: () => Promise<BridgeClient>;
  readonly actor: RecipeActor;
}): McpTool[] {
  const summaries = new Map(
    (findBuiltInRecipe("blender")?.integration?.tools ?? []).map((tool) => [
      tool.name,
      tool.summary,
    ]),
  );
  const describe = (name: string, extra = "") => `${summaries.get(name) ?? name}${extra}`;
  const call = async (cmd: string, args: Record<string, unknown> = {}) =>
    (await input.bridge()).call(cmd, args, input.actor);

  return [
    {
      name: "blender_status",
      description: describe("blender_status"),
      inputSchema: { type: "object", properties: {} },
      run: () => call("status"),
    },
    {
      name: "blender_list_scene",
      description: describe("blender_list_scene", " Use the ids it returns in later calls."),
      inputSchema: { type: "object", properties: {} },
      run: () => call("list_scene"),
    },
    {
      name: "blender_add_object",
      description: describe("blender_add_object"),
      inputSchema: {
        type: "object",
        properties: {
          primitive: {
            type: "string",
            enum: [
              "cube",
              "plane",
              "uv_sphere",
              "ico_sphere",
              "cylinder",
              "cone",
              "torus",
              "monkey",
              "empty",
              "camera",
              "point_light",
              "sun_light",
              "spot_light",
              "area_light",
            ],
          },
          name: { type: "string" },
          location: vector,
          rotation_euler: vector,
          scale: vector,
        },
        required: ["primitive"],
      },
      run: (args) => call("add_object", args),
    },
    {
      name: "blender_modify_object",
      description: describe(
        "blender_modify_object",
        " Properties: name, location, rotation_euler, scale, hide_viewport, hide_render, parent (an lp_id or null), light.energy, light.color, camera.lens.",
      ),
      inputSchema: {
        type: "object",
        properties: {
          ...objectRef,
          props: { type: "object", additionalProperties: true },
        },
        required: ["props"],
      },
      run: (args) => call("modify_object", args),
    },
    {
      name: "blender_delete_object",
      description: describe("blender_delete_object"),
      inputSchema: { type: "object", properties: objectRef },
      run: (args) => call("delete_object", args),
    },
    {
      name: "blender_run_op",
      description: describe(
        "blender_run_op",
        ' Pass operator as "module.name", e.g. "object.shade_smooth".',
      ),
      inputSchema: {
        type: "object",
        properties: {
          operator: { type: "string" },
          kwargs: { type: "object", additionalProperties: true },
        },
        required: ["operator"],
      },
      run: (args) => call("run_op", args),
    },
    {
      name: "blender_snapshot",
      description: describe(
        "blender_snapshot",
        " Open the snapshot's scene.blend with its own session to work on a branch.",
      ),
      inputSchema: { type: "object", properties: { name: { type: "string" } } },
      run: (args) => call("snapshot", args),
    },
    {
      name: "blender_export_oplog",
      description: describe("blender_export_oplog"),
      inputSchema: {
        type: "object",
        properties: { path: { type: "string", description: "Write JSON lines here." } },
      },
      run: async (args) => {
        const { ops } = (await call("export_oplog")) as { ops: RecipeOp[] };
        if (typeof args["path"] === "string" && args["path"].length > 0) {
          await NodeFSP.writeFile(
            args["path"],
            ops.map((op) => JSON.stringify(op)).join("\n") + "\n",
          );
          return { path: args["path"], ops: ops.length };
        }
        return { ops };
      },
    },
    {
      name: "blender_merge",
      description: describe(
        "blender_merge",
        " Pass theirs: the other branch's session directory or oplog.jsonl. Tell the person about every conflict.",
      ),
      inputSchema: {
        type: "object",
        properties: { theirs: { type: "string" } },
        required: ["theirs"],
      },
      run: async (args) => {
        const theirsPath = String(args["theirs"] ?? "");
        const outcome = await mergeIntoBridge({
          bridge: await input.bridge(),
          session: input.session,
          theirs: await readTheirs(theirsPath),
          from: theirsPath,
          actor: input.actor,
        });
        return {
          applied: outcome.report.applied,
          conflicts: outcome.report.conflicts,
          skipped: outcome.skipped,
          report: outcome.reportPath,
        };
      },
    },
  ];
}
