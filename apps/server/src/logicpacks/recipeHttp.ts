import { DEFAULT_RECIPE_ID, type ProjectId } from "@logicpacks/contracts";
import { recipeAccess } from "@logicpacks/shared/recipes/runtime";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpRouter } from "effect/http";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { connectBridge, readBridgeInfo } from "../recipes/bridgeClient.ts";
import {
  defaultRecipeSession,
  detectRecipeApp,
  launchRecipe,
  recipeBridgeRunning,
} from "../recipes/recipeRunner.ts";
import { json, queryParam, readBody, resolveCaller } from "./http.ts";
import { LogicPacksAccess } from "./LogicPacksAccess.ts";
import { readProjectRecipe } from "./projectRecipe.ts";

/** The scene a Blender project opens; saved on first open so there is a file to sync. */
const BLENDER_SCENE = "scene.blend";

const ProjectRequest = Schema.Struct({ projectId: Schema.String });

/** The caller may see the project; resolves its folder and recipe. */
const projectRecipeFor = Effect.fn("logicpacks.recipes.projectRecipeFor")(function* (
  projectId: string,
) {
  const caller = yield* resolveCaller;
  if (caller.kind === "anonymous") return { ok: false as const, status: 401 };
  const access = yield* LogicPacksAccess;
  if (caller.kind === "member" && access.roleOf(caller.userId, projectId) === null) {
    return { ok: false as const, status: 404 };
  }
  const store = yield* ProjectStore.ProjectStoreV2;
  const shell = yield* store
    .getShell(projectId as ProjectId)
    .pipe(Effect.orElseSucceed(() => Option.none()));
  if (Option.isNone(shell)) return { ok: false as const, status: 404 };
  const root = shell.value.workspaceRoot;
  const recipe = yield* readProjectRecipe(root);
  return { ok: true as const, caller, root, recipe };
});

/** Which recipe a project uses and whether this caller can open its app here. */
const projectRecipeRoute = HttpRouter.add(
  "GET",
  "/api/lp/projects/recipe",
  Effect.gen(function* () {
    const found = yield* projectRecipeFor(yield* queryParam("projectId"));
    if (!found.ok)
      return json({ error: found.status === 401 ? "unauthenticated" : "not_found" }, found.status);
    const { caller, root, recipe } = found;
    if (recipe.id === DEFAULT_RECIPE_ID || recipe.integration === undefined) {
      return json({ recipeId: recipe.id, app: null });
    }
    const access = recipeAccess(recipe, caller.kind === "operator" ? "desktop" : "web");
    const installed = access.kind === "open" && detectRecipeApp(recipe) !== null;
    const running = yield* Effect.promise(() =>
      recipeBridgeRunning(defaultRecipeSession(root, recipe.id)),
    );
    return json({
      recipeId: recipe.id,
      app: {
        name: recipe.integration.app.name,
        download: recipe.integration.app.download ?? null,
        access: access.kind,
        installed,
        running,
      },
    });
  }),
);

/** Opens the project's app on this machine with the bridge loaded. Operator only. */
const launchRoute = HttpRouter.add(
  "POST",
  "/api/lp/recipes/launch",
  Effect.gen(function* () {
    const body = yield* readBody(ProjectRequest);
    if (body === null) return json({ error: "bad_request" }, 400);
    const found = yield* projectRecipeFor(body.projectId);
    if (!found.ok)
      return json({ error: found.status === 401 ? "unauthenticated" : "not_found" }, found.status);
    const { caller, root, recipe } = found;
    const access = recipeAccess(recipe, caller.kind === "operator" ? "desktop" : "web");
    if (recipe.integration === undefined || access.kind !== "open") {
      return json(
        {
          error: "not_here",
          message:
            access.kind === "open"
              ? `${recipe.name} has no app to open.`
              : `${recipe.name}: ${access.message}.`,
        },
        409,
      );
    }
    const session = defaultRecipeSession(root, recipe.id);
    if (yield* Effect.promise(() => recipeBridgeRunning(session))) {
      return json({ running: true, alreadyRunning: true });
    }
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const scene = path.join(root, BLENDER_SCENE);
    const hasScene =
      recipe.id === "blender" &&
      (yield* fileSystem.exists(scene).pipe(Effect.orElseSucceed(() => false)));
    // The cloud host has no screen: its app runs headless and agents keep working in it.
    const headless = yield* Config.Boolean("LOGICPACKS_CLOUD_HOST").pipe(
      Config.withDefault(false),
      Effect.orElseSucceed(() => false),
    );
    const outcome = yield* Effect.tryPromise(() =>
      launchRecipe({
        recipeId: recipe.id,
        project: root,
        headless,
        ...(hasScene ? { file: scene } : {}),
      }),
    );
    if (recipe.id === "blender" && !hasScene) {
      yield* Effect.tryPromise(async () => {
        const info = await readBridgeInfo(session);
        if (info === null) return;
        const bridge = await connectBridge(info);
        try {
          await bridge.call("save", { path: scene });
        } finally {
          bridge.close();
        }
      }).pipe(Effect.ignore);
    }
    return json({ running: true, alreadyRunning: false, pid: outcome.pid ?? null });
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed(
        json(
          {
            error: "launch_failed",
            message: error instanceof Error ? error.message : String(error),
          },
          500,
        ),
      ),
    ),
  ),
);

/**
 * What the project's workspace shows for an app recipe: the app's live view and
 * its outline (the scene's objects for Blender), each item credited to whoever
 * changed it last. Operator only, like launch: the web stays on Code.
 */
const viewRoute = HttpRouter.add(
  "GET",
  "/api/lp/recipes/view",
  Effect.gen(function* () {
    const found = yield* projectRecipeFor(yield* queryParam("projectId"));
    if (!found.ok)
      return json({ error: found.status === 401 ? "unauthenticated" : "not_found" }, found.status);
    const { caller, root, recipe } = found;
    const access = recipeAccess(recipe, caller.kind === "operator" ? "desktop" : "web");
    if (recipe.integration === undefined || access.kind !== "open") {
      return json({ error: "not_here" }, 409);
    }
    const width = Number(yield* queryParam("width"));
    const image = (yield* queryParam("image")) !== "0";
    const info = yield* Effect.promise(() => readBridgeInfo(defaultRecipeSession(root, recipe.id)));
    if (info === null) return json({ running: false });
    const view = yield* Effect.tryPromise(async () => {
      const bridge = await connectBridge(info, { timeoutMs: 20_000 });
      try {
        return await bridge.call("view", {
          image,
          ...(Number.isFinite(width) && width > 0 ? { width } : {}),
        });
      } finally {
        bridge.close();
      }
    }).pipe(Effect.orElseSucceed(() => null));
    // A stale bridge.json from an app that has since quit.
    if (view === null) return json({ running: false });
    return json({ running: true, ...(view as Record<string, unknown>) });
  }),
);

export const layer = Layer.mergeAll(projectRecipeRoute, launchRoute, viewRoute);
