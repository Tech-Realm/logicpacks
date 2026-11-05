import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { ProjectRecipeFile } from "./recipe.ts";

const decodeProjectRecipe = Schema.decodeUnknownExit(ProjectRecipeFile);

describe("recipes", () => {
  it("reads a project's recipe file and rejects ids that are not slugs", () => {
    assert.isTrue(decodeProjectRecipe({ recipe: "blender" })._tag === "Success");
    assert.isTrue(decodeProjectRecipe({ recipe: "../x" })._tag === "Failure");
  });
});
