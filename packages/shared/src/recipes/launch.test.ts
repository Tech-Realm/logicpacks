import { describe, expect, it } from "vite-plus/test";

import { findBuiltInRecipe } from "./builtin.ts";
import {
  planRecipeLaunch,
  recipeDetectCandidates,
  recipeMcpServer,
  substituteRecipeArgs,
} from "./launch.ts";

const blender = findBuiltInRecipe("blender")!;
const context = {
  app: "/Applications/Blender.app",
  assetsDir: "/opt/lp/recipes/blender/",
  session: "/work/.logicpacks/blender/main",
};

describe("planRecipeLaunch", () => {
  it("starts Blender with the bundled bridge and no file", () => {
    expect(planRecipeLaunch(blender, "macos", context)).toEqual({
      ok: true,
      command: "/Applications/Blender.app/Contents/MacOS/Blender",
      args: [
        "--python",
        "/opt/lp/recipes/blender/blender/logicpacks_bridge.py",
        "--",
        "--session",
        "/work/.logicpacks/blender/main",
      ],
    });
  });

  it("opens a file, and serves without a window when headless", () => {
    const plan = planRecipeLaunch(
      blender,
      "linux",
      { ...context, app: "/usr/bin/blender", file: "/work/scene.blend" },
      { headless: true },
    );
    expect(plan.ok && plan.command).toBe("/usr/bin/blender");
    expect(plan.ok && plan.args.slice(0, 2)).toEqual(["-b", "/work/scene.blend"]);
    expect(plan.ok && plan.args.at(-1)).toBe("--serve");
  });

  it("refuses coming-soon recipes and unsupported platforms", () => {
    const godot = findBuiltInRecipe("godot")!;
    expect(planRecipeLaunch(godot, "macos", context)).toMatchObject({ ok: false });
    expect(planRecipeLaunch(blender, null, context)).toMatchObject({ ok: false });
  });

  it("refuses Code, which has no app to start", () => {
    const code = findBuiltInRecipe("code")!;
    expect(planRecipeLaunch(code, "macos", context, { headless: true })).toMatchObject({
      ok: false,
    });
  });
});

describe("helpers", () => {
  it("expands ~ in detect paths and keeps commands", () => {
    expect(recipeDetectCandidates(blender, "macos", "/Users/sara")).toEqual({
      paths: ["/Applications/Blender.app", "/Users/sara/Applications/Blender.app"],
      commands: ["blender"],
    });
  });

  it("fills the MCP server's session", () => {
    expect(recipeMcpServer(blender, context)).toEqual({
      name: "logicpacks-blender",
      command: "logicpacks",
      args: ["recipe", "mcp", "blender", "--session", "/work/.logicpacks/blender/main"],
    });
    expect(recipeMcpServer(findBuiltInRecipe("code")!, context)).toBeNull();
  });

  it("only drops a bare {file}", () => {
    expect(substituteRecipeArgs(["{file}", "--x={file}"], context)).toEqual(["--x="]);
  });
});
