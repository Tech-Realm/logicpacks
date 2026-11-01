import { DEFAULT_RECIPE_ID } from "@logicpacks/contracts";
import { findBuiltInRecipe } from "@logicpacks/shared/recipes/builtin";
import { recipeAccess } from "@logicpacks/shared/recipes/runtime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { LogicPacksAccess } from "./LogicPacksAccess.ts";
import { scaffoldProjectRecipe } from "./projectRecipe.ts";
import { findProjectTemplate } from "./projectTemplates.ts";
import { revealClaimedProject } from "./reveal.ts";
import { importSyncedProject } from "./syncImport.ts";

export type NewProjectInput =
  | { readonly kind: "empty"; readonly name: string; readonly recipe?: string | undefined }
  | { readonly kind: "template"; readonly name: string; readonly template: string }
  | { readonly kind: "git"; readonly remoteUrl: string };

export type NewProjectResult =
  | { readonly kind: "created"; readonly projectId: string }
  | { readonly kind: "invalid"; readonly message: string };

/**
 * One step from nothing to a project in the caller's current workspace: an
 * empty repository, a template, or a clone of a git URL. The clone path is
 * Sync's import, so a cloned project follows its remote like a synced one.
 */
export const createProject = Effect.fn("logicpacks.createProject")(function* (
  input: NewProjectInput,
  callerUserId: string | null,
) {
  const lp = yield* LogicPacksAccess;
  if (input.kind === "git") {
    const imported = yield* importSyncedProject({
      remoteUrl: input.remoteUrl,
      callerUserId,
      shareWith: [],
    });
    switch (imported.kind) {
      case "invalid_remote":
        return { kind: "invalid", message: "Use a git URL like https://github.com/team/app." };
      case "not_shared":
        return {
          kind: "invalid",
          message: "That repository is already here but not shared with you.",
        };
      default:
        return { kind: "created", projectId: imported.projectId } satisfies NewProjectResult;
    }
  }

  const name = input.name.trim();
  if (name.length === 0 || name.length > 80) {
    return { kind: "invalid", message: "Name the project in 1 to 80 characters." };
  }
  const template = input.kind === "template" ? findProjectTemplate(input.template) : null;
  if (input.kind === "template" && template === null) {
    return { kind: "invalid", message: "That template does not exist." };
  }
  const recipeId = input.kind === "empty" ? (input.recipe ?? DEFAULT_RECIPE_ID) : DEFAULT_RECIPE_ID;
  const recipe = findBuiltInRecipe(recipeId);
  if (recipe === undefined) return { kind: "invalid", message: "That recipe does not exist." };
  // App recipes drive an app on this machine, which only its operator (the desktop app) can open.
  const access = recipeAccess(recipe, callerUserId === null ? "desktop" : "web");
  if (access.kind !== "open") {
    return { kind: "invalid", message: `${recipe.name}: ${access.message}.` };
  }

  const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
  const created = yield* folders.createNamedProject({ name });
  if (template !== null) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const git = yield* GitVcsDriver.GitVcsDriver;
    const paths = Object.keys(template.files);
    yield* Effect.forEach(paths, (file) =>
      fileSystem.writeFileString(path.join(created.workspaceRoot, file), template.files[file]!),
    );
    yield* git.execute({
      operation: "logicpacks.template.add",
      cwd: created.workspaceRoot,
      args: ["add", "--force", "--", ...paths],
      timeoutMs: 10_000,
    });
    // A missing git identity leaves the files uncommitted; the agent can commit them.
    yield* git
      .execute({
        operation: "logicpacks.template.commit",
        cwd: created.workspaceRoot,
        args: ["commit", "--message", `Start from the ${template.title} template`],
        allowNonZeroExit: true,
        timeoutMs: 30_000,
      })
      .pipe(Effect.ignore);
  }
  if (recipe.id !== DEFAULT_RECIPE_ID) yield* scaffoldProjectRecipe(created.workspaceRoot, recipe);
  if (callerUserId !== null) yield* lp.recordOwner(created.projectId, callerUserId);
  const workspaceId = lp.currentWorkspaceId(callerUserId);
  if (workspaceId !== null) yield* lp.attachProject(created.projectId, workspaceId);
  yield* revealClaimedProject(created.projectId);
  return { kind: "created", projectId: created.projectId } satisfies NewProjectResult;
});
