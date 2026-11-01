// @effect-diagnostics nodeBuiltinImport:off - starts a detached app process and probes PATH; the CLI and the HTTP route share these plain functions.
/**
 * Finding, starting and serving app recipes on this machine. The rules about
 * what may start where live in `@logicpacks/shared/recipes/*`; this file does the
 * filesystem, PATH and process work they leave to the caller.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { RecipeManifest, RecipePlatform } from "@logicpacks/contracts";
import { BUILT_IN_RECIPES, findBuiltInRecipe } from "@logicpacks/shared/recipes/builtin";
import {
  planRecipeLaunch,
  recipeDetectCandidates,
  recipeMcpServer,
} from "@logicpacks/shared/recipes/launch";
import {
  normaliseRecipeBranch,
  platformFromNodePlatform,
  recipeAccess,
} from "@logicpacks/shared/recipes/runtime";

import { BLENDER_BRIDGE_ADDON, BLENDER_BRIDGE_ADDON_PATH } from "./blenderBridgeAddon.ts";
import { connectBridge, readBridgeInfo, waitForBridge } from "./bridgeClient.ts";

/** Files each recipe's adapter needs, by path under its assets directory. */
const RECIPE_ASSETS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  blender: { [BLENDER_BRIDGE_ADDON_PATH]: BLENDER_BRIDGE_ADDON },
};

// oxlint-disable-next-line logicpacks/no-global-process-runtime -- Plain functions shared by the CLI and HTTP route, outside the Effect runtime.
const HOST_PLATFORM = process.platform;

export function currentRecipePlatform(): RecipePlatform | null {
  return platformFromNodePlatform(HOST_PLATFORM);
}

function onPath(command: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const extensions = HOST_PLATFORM === "win32" ? ["", ".exe", ".cmd"] : [""];
  for (const dir of (env["PATH"] ?? "").split(NodePath.delimiter)) {
    if (dir.length === 0) continue;
    for (const extension of extensions) {
      const candidate = NodePath.join(dir, `${command}${extension}`);
      if (NodeFS.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** Where the app is on this machine, or null. */
export function detectRecipeApp(
  recipe: Pick<RecipeManifest, "integration">,
  platform: RecipePlatform | null = currentRecipePlatform(),
): string | null {
  if (platform === null) return null;
  const { paths, commands } = recipeDetectCandidates(recipe, platform, NodeOS.homedir());
  return (
    paths.find((path) => NodeFS.existsSync(path)) ??
    commands.map((c) => onPath(c)).find(Boolean) ??
    null
  );
}

export function defaultRecipeSession(project: string, recipeId: string, branch?: string): string {
  return NodePath.join(
    NodePath.resolve(project),
    ".logicpacks",
    recipeId,
    normaliseRecipeBranch(branch),
  );
}

/** Writes the recipe's embedded assets under `<session>/assets` and returns that directory. */
async function writeRecipeAssets(recipeId: string, session: string): Promise<string> {
  const assetsDir = NodePath.join(session, "assets");
  for (const [path, content] of Object.entries(RECIPE_ASSETS[recipeId] ?? {})) {
    const target = NodePath.join(assetsDir, path);
    await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
    await NodeFSP.writeFile(target, content);
  }
  return assetsDir;
}

export interface RecipeListing {
  readonly id: string;
  readonly name: string;
  readonly availability: RecipeManifest["availability"];
  readonly surfaces: ReadonlyArray<string>;
  readonly appPath: string | null;
  readonly status: string;
}

export function listRecipesHere(): RecipeListing[] {
  return BUILT_IN_RECIPES.map((recipe) => {
    const access = recipeAccess(recipe, "desktop");
    const appPath =
      recipe.integration === undefined || access.kind !== "open" ? null : detectRecipeApp(recipe);
    return {
      id: recipe.id,
      name: recipe.name,
      availability: recipe.availability,
      surfaces: recipe.surfaces,
      appPath,
      status:
        access.kind !== "open"
          ? access.message
          : recipe.integration === undefined
            ? "ready"
            : appPath === null
              ? "app not installed"
              : `ready (${appPath})`,
    };
  });
}

export interface CliInvocation {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string>>;
}

/**
 * How another process runs this install's `logicpacks`: the desktop app's CLI shim when
 * there is one, else this runtime and entry. Electron needs ELECTRON_RUN_AS_NODE.
 */
export function currentCliInvocation(env: NodeJS.ProcessEnv = process.env): CliInvocation {
  const shim = env["LOGICPACKS_CLI_PATH"]?.trim();
  if (shim && NodeFS.existsSync(shim)) return { command: shim, args: [], env: {} };
  return {
    command: process.execPath,
    args: process.argv[1] ? [process.argv[1]] : [],
    env: env["ELECTRON_RUN_AS_NODE"] === "1" ? { ELECTRON_RUN_AS_NODE: "1" } : {},
  };
}

async function readJsonObject(path: string): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(await NodeFSP.readFile(path, "utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Adds the recipe's MCP server to `<project>/.mcp.json` and allows it in
 * `.claude/settings.local.json`; Claude sessions skip unapproved project servers.
 * Both hold machine paths, so recipe projects gitignore them.
 */
export async function writeProjectMcpConfig(input: {
  readonly project: string;
  readonly name: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env?: Readonly<Record<string, string>>;
}): Promise<string> {
  const path = NodePath.join(NodePath.resolve(input.project), ".mcp.json");
  const config = await readJsonObject(path);
  const servers = (config["mcpServers"] ?? {}) as Record<string, unknown>;
  const entry = {
    command: input.command,
    args: input.args,
    ...(input.env && Object.keys(input.env).length > 0 ? { env: input.env } : {}),
  };
  await NodeFSP.writeFile(
    path,
    `${JSON.stringify({ ...config, mcpServers: { ...servers, [input.name]: entry } }, null, 2)}\n`,
  );

  const localPath = NodePath.join(
    NodePath.resolve(input.project),
    ".claude",
    "settings.local.json",
  );
  const local = await readJsonObject(localPath);
  const enabled = Array.isArray(local["enabledMcpjsonServers"])
    ? (local["enabledMcpjsonServers"] as unknown[]).filter((v) => typeof v === "string")
    : [];
  if (!enabled.includes(input.name)) {
    await NodeFSP.mkdir(NodePath.dirname(localPath), { recursive: true });
    await NodeFSP.writeFile(
      localPath,
      `${JSON.stringify({ ...local, enabledMcpjsonServers: [...enabled, input.name] }, null, 2)}\n`,
    );
  }
  return path;
}

export interface RecipeLaunchOutcome {
  readonly pid: number | undefined;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly session: string;
  readonly logPath: string;
  readonly port: number | null;
  readonly mcpConfigPath: string | null;
}

export class RecipeLaunchError extends Error {
  override readonly name = "RecipeLaunchError";
}

/** Whether a bridge answers in the session right now. */
export async function recipeBridgeRunning(session: string): Promise<boolean> {
  const info = await readBridgeInfo(session);
  if (info === null) return false;
  try {
    const client = await connectBridge(info, { timeoutMs: 2_000 });
    try {
      await client.call("status");
      return true;
    } finally {
      client.close();
    }
  } catch {
    return false;
  }
}

export async function launchRecipe(input: {
  readonly recipeId: string;
  readonly project: string;
  readonly branch?: string | undefined;
  readonly session?: string | undefined;
  readonly file?: string | undefined;
  readonly headless?: boolean | undefined;
  readonly writeMcpConfig?: boolean | undefined;
  readonly cli?: CliInvocation;
}): Promise<RecipeLaunchOutcome> {
  const recipe = findBuiltInRecipe(input.recipeId);
  if (!recipe) throw new RecipeLaunchError(`No recipe called ${input.recipeId}.`);
  const integration = recipe.integration;
  if (integration === undefined) {
    throw new RecipeLaunchError(
      `${recipe.name} needs nothing started: every project already is one.`,
    );
  }
  const platform = currentRecipePlatform();
  const app = detectRecipeApp(recipe, platform);
  if (recipe.availability !== "coming-soon" && app === null) {
    throw new RecipeLaunchError(
      `${integration.app.name} is not installed here.${integration.app.download ? ` Get it from ${integration.app.download}.` : ""}`,
    );
  }
  const session = NodePath.resolve(
    input.session ?? defaultRecipeSession(input.project, recipe.id, input.branch),
  );
  const context = {
    app: app ?? "",
    assetsDir: NodePath.join(session, "assets"),
    session,
    project: NodePath.resolve(input.project),
    file: input.file ? NodePath.resolve(input.file) : null,
  };
  const plan = planRecipeLaunch(recipe, platform, context, { headless: input.headless ?? false });
  if (!plan.ok) throw new RecipeLaunchError(plan.reason);

  await NodeFSP.mkdir(session, { recursive: true });
  await writeRecipeAssets(recipe.id, session);
  // A bridge.json left by an earlier run names a port nobody listens on now.
  await NodeFSP.rm(NodePath.join(session, "bridge.json"), { force: true });
  const logPath = NodePath.join(session, "app.log");
  const log = NodeFS.openSync(logPath, "a");
  const child = NodeChildProcess.spawn(plan.command, [...plan.args], {
    detached: true,
    stdio: ["ignore", log, log],
    cwd: context.project,
    // The app must not inherit Electron's run-as-node switch from the desktop backend.
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
  });
  child.unref();

  let mcpConfigPath: string | null = null;
  const mcp = recipeMcpServer(recipe, context);
  if (mcp && input.writeMcpConfig !== false) {
    const cli = input.cli ?? currentCliInvocation();
    const viaCli = mcp.command === "logicpacks";
    mcpConfigPath = await writeProjectMcpConfig({
      project: context.project,
      name: mcp.name,
      command: viaCli ? cli.command : mcp.command,
      args: viaCli ? [...cli.args, ...mcp.args] : [...mcp.args],
      env: viaCli ? cli.env : {},
    });
  }

  let port: number | null = null;
  if (integration.adapter.kind === "socket-addon") {
    const bridge = await waitForBridge(session, { timeoutMs: 90_000 });
    await bridge.call("status"); // answers only once the bridge is serving
    bridge.close();
    port = (await readBridgeInfo(session))?.port ?? null;
  }

  return {
    pid: child.pid,
    command: plan.command,
    args: plan.args,
    session,
    logPath,
    port,
    mcpConfigPath,
  };
}
