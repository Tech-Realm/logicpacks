import { DEFAULT_RECIPE_ID, RecipeManifest, recipesForSurface } from "@logicpacks/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { BUILT_IN_RECIPES, findBuiltInRecipe } from "./builtin.ts";
import { normaliseRecipeBranch, platformFromNodePlatform, recipeAccess } from "./runtime.ts";

const decodeRecipe = Schema.decodeUnknownSync(RecipeManifest);

describe("built-in recipes", () => {
  it("every recipe decodes, ids are unique, and Code is the default, listed first", () => {
    for (const recipe of BUILT_IN_RECIPES) {
      expect(() => decodeRecipe(recipe), recipe.id).not.toThrow();
    }
    const ids = BUILT_IN_RECIPES.map((recipe) => recipe.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).toBe(DEFAULT_RECIPE_ID);
    expect(findBuiltInRecipe(DEFAULT_RECIPE_ID)?.integration).toBeUndefined();
  });

  it("ships the coming-soon recipes the roadmap names, none of them runnable", () => {
    for (const id of ["davinci-resolve", "browser", "godot", "reaper", "office", "jupyter"]) {
      const recipe = findBuiltInRecipe(id);
      expect(recipe?.availability, id).toBe("coming-soon");
      expect(
        recipe?.integration?.tools.every((tool) => tool.status === "coming-soon"),
        id,
      ).toBe(true);
      expect(recipe?.integration?.limitations[0], id).toMatch(/^Beta/);
    }
  });

  it("blender declares a launch for every platform it claims, and its MCP server", () => {
    const blender = findBuiltInRecipe("blender")!.integration!;
    expect(blender.launch.map((entry) => entry.platform).toSorted()).toEqual(
      [...blender.platforms].toSorted(),
    );
    expect(blender.adapter.mcp?.args.slice(0, 3)).toEqual(["recipe", "mcp", "blender"]);
    expect(blender.adapter.assets).toEqual(["blender/logicpacks_bridge.py"]);
  });

  it("the web can start Code only; the desktop app also starts Blender", () => {
    expect(recipesForSurface(BUILT_IN_RECIPES, "web").map((recipe) => recipe.id)).toEqual(["code"]);
    expect(recipesForSurface(BUILT_IN_RECIPES, "desktop").map((recipe) => recipe.id)).toEqual([
      "code",
      "blender",
    ]);
  });

  it("no user-facing text uses an em dash", () => {
    expect(JSON.stringify(BUILT_IN_RECIPES)).not.toContain("—");
  });
});

describe("recipeAccess", () => {
  const code = findBuiltInRecipe("code")!;
  const blender = findBuiltInRecipe("blender")!;
  const godot = findBuiltInRecipe("godot")!;

  it("the web build is code only and sends app recipes to the desktop app", () => {
    expect(recipeAccess(code, "web").kind).toBe("open");
    expect(recipeAccess(blender, "web")).toEqual({
      kind: "open-in-desktop",
      message: "Needs the LogicPacks desktop app",
    });
    expect(recipeAccess(blender, "desktop").kind).toBe("open");
    expect(recipeAccess(blender, "cloud").kind).toBe("open");
  });

  it("coming-soon recipes are never openable", () => {
    expect(recipeAccess(godot, "desktop").kind).toBe("coming-soon");
    expect(recipeAccess(godot, "web").kind).toBe("coming-soon");
  });
});

describe("helpers", () => {
  it("maps node platforms", () => {
    expect(platformFromNodePlatform("darwin")).toBe("macos");
    expect(platformFromNodePlatform("aix")).toBeNull();
  });

  it("keeps branch names to one safe path segment", () => {
    expect(normaliseRecipeBranch(undefined)).toBe("main");
    expect(normaliseRecipeBranch("Agent A/../x")).toBe("agent-a-..-x");
    expect(normaliseRecipeBranch("../..")).toBe("main");
    expect(normaliseRecipeBranch("  ")).toBe("main");
  });
});
