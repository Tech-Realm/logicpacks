import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { ProjectRecipeFile, RecipeManifest, recipeFromPackManifest } from "./recipe.ts";

const decodeRecipe = Schema.decodeSync(RecipeManifest);
const decodeProjectRecipe = Schema.decodeUnknownExit(ProjectRecipeFile);

describe("recipes", () => {
  it("converts a v1 pack into a code recipe that keeps its knowledge", () => {
    const recipe = recipeFromPackManifest({
      formatVersion: "2.0",
      identity: {
        name: "vercel-deploy",
        version: "1.2.0",
        displayName: "Vercel deploy",
        summary: "Deploys to Vercel.",
      },
      capability: { does: "Deploys." },
      knowledge: { integration: [{ text: "Run vercel link before the first deploy." }] },
    });
    assert.isNotNull(recipe);
    decodeRecipe(recipe);
    assert.strictEqual(recipe?.id, "vercel-deploy");
    assert.strictEqual(recipe?.agentInstructions, "Run vercel link before the first deploy.");
    assert.deepStrictEqual(recipe?.fromPack, { name: "vercel-deploy", version: "1.2.0" });
    assert.isUndefined(recipe?.integration);
    assert.isNull(recipeFromPackManifest({ identity: { name: "x" } }));
  });

  it("turns a v1 pack's recipe section into an app recipe", () => {
    const recipe = recipeFromPackManifest({
      identity: { name: "recipe-blender", version: "0.1.0", displayName: "Blender" },
      recipe: {
        id: "blender",
        stage: "mvp",
        runtimes: ["desktop", "cloud"],
        app: { name: "Blender" },
        platforms: ["macos"],
        detect: [{ platform: "macos", paths: ["/Applications/Blender.app"] }],
        launch: [{ platform: "macos", executable: "{app}/Contents/MacOS/Blender", args: [] }],
        adapter: { kind: "socket-addon", summary: "Bridge add-on.", assets: [] },
        tools: [],
        opLog: { unit: "object", mergeGranularity: "property", snapshot: "blend", recordedBy: "x" },
        statusPanels: ["participants"],
        limitations: [],
      },
    });
    assert.isNotNull(recipe);
    decodeRecipe(recipe);
    assert.strictEqual(recipe?.id, "blender");
    assert.strictEqual(recipe?.availability, "preview");
    assert.deepStrictEqual(recipe?.surfaces, ["desktop", "cloud"]);
    assert.strictEqual(recipe?.integration?.app.name, "Blender");
  });

  it("reads a project's recipe file and rejects ids that are not slugs", () => {
    assert.isTrue(decodeProjectRecipe({ recipe: "blender" })._tag === "Success");
    assert.isTrue(decodeProjectRecipe({ recipe: "../x" })._tag === "Failure");
  });
});
