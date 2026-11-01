/**
 * Turns a recipe integration's detect, launch and MCP entries into commands.
 * Pure: the caller probes the candidates `recipeDetectCandidates` returns and
 * passes the hit in as `app`.
 */
import type { RecipeManifest, RecipeMcpServer, RecipePlatform } from "@logicpacks/contracts";

export interface RecipeLaunchContext {
  /** The detected app path (a bundle, an executable or a command on PATH). */
  readonly app: string;
  /** The recipe's assets directory. */
  readonly assetsDir: string;
  /** Where this session keeps its op log, snapshots and bridge state. */
  readonly session: string;
  readonly project?: string | undefined;
  /** The document to open. When absent, a bare `{file}` argument is dropped. */
  readonly file?: string | null | undefined;
}

export interface RecipeCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

export type RecipeLaunchPlan =
  | ({ readonly ok: true } & RecipeCommand)
  | { readonly ok: false; readonly reason: string };

function joinAsset(assetsDir: string, relative: string): string {
  const separator = assetsDir.includes("\\") && !assetsDir.includes("/") ? "\\" : "/";
  return `${assetsDir.replace(/[\\/]+$/, "")}${separator}${relative.replace(/^[\\/]+/, "")}`;
}

function substitute(value: string, context: RecipeLaunchContext): string {
  return value
    .replace(/\{asset:([^}]+)\}/g, (_, relative: string) => joinAsset(context.assetsDir, relative))
    .replaceAll("{app}", context.app)
    .replaceAll("{session}", context.session)
    .replaceAll("{project}", context.project ?? context.session)
    .replaceAll("{file}", context.file ?? "");
}

/** Substitute placeholders; an argument that is exactly `{file}` goes when there is no file. */
export function substituteRecipeArgs(
  args: ReadonlyArray<string>,
  context: RecipeLaunchContext,
): string[] {
  return args
    .filter((arg) => arg !== "{file}" || (context.file ?? "").length > 0)
    .map((arg) => substitute(arg, context));
}

/** Paths to check in order (with `~/` expanded), then commands to look up on PATH. */
export function recipeDetectCandidates(
  recipe: Pick<RecipeManifest, "integration">,
  platform: RecipePlatform,
  home: string,
): { readonly paths: ReadonlyArray<string>; readonly commands: ReadonlyArray<string> } {
  const entries = (recipe.integration?.detect ?? []).filter((entry) => entry.platform === platform);
  return {
    paths: entries.flatMap((entry) =>
      entry.paths.map((path) => (path.startsWith("~/") ? `${home}${path.slice(1)}` : path)),
    ),
    commands: entries.flatMap((entry) => entry.commands ?? []),
  };
}

export function planRecipeLaunch(
  recipe: Pick<RecipeManifest, "id" | "availability" | "integration">,
  platform: RecipePlatform | null,
  context: RecipeLaunchContext,
  options: { readonly headless?: boolean } = {},
): RecipeLaunchPlan {
  if (recipe.availability === "coming-soon") {
    return {
      ok: false,
      reason: `The ${recipe.id} recipe is in Beta and cannot be started yet.`,
    };
  }
  const integration = recipe.integration;
  if (integration === undefined) {
    return { ok: false, reason: `The ${recipe.id} recipe has no app to start.` };
  }
  if (platform === null || !integration.platforms.includes(platform)) {
    return { ok: false, reason: `The ${recipe.id} recipe does not run on this platform.` };
  }
  const entry = integration.launch.find((candidate) => candidate.platform === platform);
  if (!entry) {
    return { ok: false, reason: `The ${recipe.id} recipe has nothing to launch on ${platform}.` };
  }
  const args = options.headless ? entry.headlessArgs : entry.args;
  if (args === undefined) {
    return { ok: false, reason: `The ${recipe.id} recipe cannot run without a window.` };
  }
  return {
    ok: true,
    command: substitute(entry.executable, context),
    args: substituteRecipeArgs(args, context),
  };
}

/** The MCP server entry an agent session needs, with placeholders filled in. */
export function recipeMcpServer(
  recipe: Pick<RecipeManifest, "integration">,
  context: Pick<RecipeLaunchContext, "assetsDir" | "session" | "project">,
): (RecipeCommand & { readonly name: string }) | null {
  const mcp: RecipeMcpServer | undefined = recipe.integration?.adapter.mcp;
  if (!mcp) return null;
  const full: RecipeLaunchContext = { ...context, app: "" };
  return {
    name: mcp.serverName,
    command: substitute(mcp.command, full),
    args: substituteRecipeArgs(mcp.args, full),
  };
}
