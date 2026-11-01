// @effect-diagnostics nodeBuiltinImport:off - resolves user-given session paths for the plain async recipe runner.
/** `logicpacks recipe`: list the recipes this machine can run, start one, and serve its agent tools over MCP. */
import * as NodePath from "node:path";

import { findBuiltInRecipe } from "@logicpacks/shared/recipes/builtin";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Argument, Command, Flag } from "effect/cli";

import { agentActorFromEnv, blenderMcpTools } from "./blenderMcp.ts";
import { connectBridge, readBridgeInfo, type BridgeClient } from "./bridgeClient.ts";
import { serveMcpOverStdio } from "./mcpStdio.ts";
import { defaultRecipeSession, launchRecipe, listRecipesHere } from "./recipeRunner.ts";

class RecipeCliError extends Data.TaggedError("RecipeCliError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const projectFlag = Flag.String("project").pipe(
  Flag.withDescription("The project folder. Defaults to the current directory."),
  Flag.optional,
);
const branchFlag = Flag.String("branch").pipe(
  Flag.withDescription("Whose line of work this is. Each branch gets its own session and op log."),
  Flag.optional,
);
const sessionFlag = Flag.String("session").pipe(
  Flag.withDescription("Session directory. Defaults to <project>/.logicpacks/<recipe>/<branch>."),
  Flag.optional,
);

const recipeListCommand = Command.make("list", {}).pipe(
  Command.withDescription("List recipes and whether this machine can run each one."),
  Command.withHandler(() =>
    Console.log(
      listRecipesHere()
        .map(
          (row) =>
            `${row.id.padEnd(16)} ${row.availability.padEnd(12)} ${row.surfaces.join(",").padEnd(18)} ${row.status}`,
        )
        .join("\n"),
    ),
  ),
);

const recipeLaunchCommand = Command.make("launch", {
  recipe: Argument.String("recipe").pipe(Argument.withDescription("Recipe id, e.g. blender.")),
  project: projectFlag,
  branch: branchFlag,
  session: sessionFlag,
  file: Flag.String("file").pipe(Flag.withDescription("Document to open."), Flag.optional),
  headless: Flag.Boolean("headless").pipe(
    Flag.withDescription("Run without a window, e.g. on the cloud host."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription(
    "Start a recipe's app with its bridge loaded and give this project's agents its tools.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const outcome = yield* Effect.tryPromise({
        try: () =>
          launchRecipe({
            recipeId: flags.recipe,
            project: Option.getOrElse(flags.project, () => process.cwd()),
            branch: Option.getOrUndefined(flags.branch),
            session: Option.getOrUndefined(flags.session),
            file: Option.getOrUndefined(flags.file),
            headless: flags.headless,
          }),
        catch: (cause) =>
          new RecipeCliError({
            message: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
      });
      yield* Console.log(
        [
          `Started ${flags.recipe} (pid ${outcome.pid ?? "unknown"}).`,
          `Session: ${outcome.session}`,
          ...(outcome.port === null ? [] : [`Bridge: 127.0.0.1:${outcome.port}`]),
          ...(outcome.mcpConfigPath === null
            ? []
            : [`Agent tools: added to ${outcome.mcpConfigPath}`]),
          `Log: ${outcome.logPath}`,
        ].join("\n"),
      );
    }),
  ),
);

const recipeMcpCommand = Command.make("mcp", {
  recipe: Argument.String("recipe").pipe(Argument.withDescription("Recipe id, e.g. blender.")),
  project: projectFlag,
  branch: branchFlag,
  session: sessionFlag,
}).pipe(
  Command.withDescription("Serve a recipe's agent tools over MCP on stdio."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const recipe = findBuiltInRecipe(flags.recipe);
      if (recipe?.id !== "blender") {
        return yield* new RecipeCliError({
          message: `The ${flags.recipe} recipe has no agent tools to serve yet.`,
        });
      }
      const session = NodePath.resolve(
        Option.getOrElse(flags.session, () =>
          defaultRecipeSession(
            Option.getOrElse(flags.project, () => process.cwd()),
            recipe.id,
            Option.getOrUndefined(flags.branch),
          ),
        ),
      );
      let client: BridgeClient | null = null;
      const bridge = async () => {
        if (client) return client;
        const info = await readBridgeInfo(session);
        if (!info) {
          throw new Error(
            "Blender is not running for this project. Press Open Blender in LogicPacks, or run: logicpacks recipe launch blender",
          );
        }
        client = await connectBridge(info);
        return client;
      };
      yield* Effect.promise(() =>
        serveMcpOverStdio({
          name: recipe.integration?.adapter.mcp?.serverName ?? "logicpacks-blender",
          version: "0.1.0",
          tools: blenderMcpTools({ session, bridge, actor: agentActorFromEnv() }),
        }),
      );
    }),
  ),
);

export const recipeCommand = Command.make("recipe").pipe(
  Command.withDescription("Recipes: work with people and agents in an app (Code, Blender, ...)."),
  Command.withSubcommands([recipeListCommand, recipeLaunchCommand, recipeMcpCommand]),
);
