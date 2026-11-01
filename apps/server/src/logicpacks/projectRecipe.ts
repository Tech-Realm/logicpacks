import {
  DEFAULT_RECIPE_ID,
  PROJECT_RECIPE_PATH,
  ProjectRecipeFile,
  type RecipeManifest,
} from "@logicpacks/contracts";
import { findBuiltInRecipe } from "@logicpacks/shared/recipes/builtin";
import { fromJsonStringPretty } from "@logicpacks/shared/schemaJson";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";

const decodeProjectRecipe = Schema.decodeUnknownOption(Schema.fromJsonString(ProjectRecipeFile));
const encodeProjectRecipe = Schema.encodeEffect(fromJsonStringPretty(ProjectRecipeFile));

/** The project's recipe from its committed `.logicpacks/recipe.json`; Code when absent or unknown. */
export const readProjectRecipe = Effect.fn("logicpacks.readProjectRecipe")(function* (
  root: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const text = yield* fileSystem
    .readFileString(path.join(root, PROJECT_RECIPE_PATH))
    .pipe(Effect.option);
  const id = Option.getOrUndefined(Option.flatMap(text, decodeProjectRecipe))?.recipe;
  return (
    (id === undefined ? undefined : findBuiltInRecipe(id)) ?? findBuiltInRecipe(DEFAULT_RECIPE_ID)!
  );
});

/** Machine-local and bulky session files stay out of git; each branch's op log is shared. */
export const recipeGitignore = (recipeId: string) =>
  [
    "# LogicPacks recipe: machine-local files",
    ".mcp.json",
    ".claude/settings.local.json",
    `.logicpacks/${recipeId}/*/*`,
    `!.logicpacks/${recipeId}/*/oplog.jsonl`,
  ].join("\n");

/**
 * Sets a new project up for an app recipe: the recipe file, agent instructions
 * (AGENTS.md, which CLAUDE.md imports) and gitignore rules, committed so Sync
 * carries them to the cloud host and teammates.
 */
export const scaffoldProjectRecipe = Effect.fn("logicpacks.scaffoldProjectRecipe")(function* (
  root: string,
  recipe: RecipeManifest,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* GitVcsDriver.GitVcsDriver;
  yield* fileSystem.makeDirectory(path.join(root, ".logicpacks"), { recursive: true });
  yield* fileSystem.writeFileString(
    path.join(root, PROJECT_RECIPE_PATH),
    `${yield* encodeProjectRecipe({ recipe: recipe.id })}\n`,
  );
  const files = [PROJECT_RECIPE_PATH, ".gitignore"];
  if (recipe.agentInstructions !== undefined) {
    yield* fileSystem.writeFileString(
      path.join(root, "AGENTS.md"),
      `# ${recipe.name} project\n\n${recipe.agentInstructions}\n`,
    );
    yield* fileSystem.writeFileString(path.join(root, "CLAUDE.md"), "@AGENTS.md\n");
    files.push("AGENTS.md", "CLAUDE.md");
  }
  const gitignorePath = path.join(root, ".gitignore");
  const existing = yield* fileSystem
    .readFileString(gitignorePath)
    .pipe(Effect.orElseSucceed(() => ""));
  yield* fileSystem.writeFileString(
    gitignorePath,
    `${existing.length > 0 && !existing.endsWith("\n") ? `${existing}\n` : existing}${recipeGitignore(recipe.id)}\n`,
  );
  yield* git.execute({
    operation: "logicpacks.recipe.add",
    cwd: root,
    args: ["add", "--force", "--", ...files],
    timeoutMs: 10_000,
  });
  // A missing git identity leaves the files uncommitted; the agent can commit them.
  yield* git
    .execute({
      operation: "logicpacks.recipe.commit",
      cwd: root,
      args: ["commit", "--message", `Set up the ${recipe.name} recipe`],
      allowNonZeroExit: true,
      timeoutMs: 30_000,
    })
    .pipe(Effect.ignore);
});
