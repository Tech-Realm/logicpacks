// @effect-diagnostics nodeBuiltinImport:off -- real git repositories in a temp folder.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterAll, describe, expect, it } from "@effect/vitest";
import { findBuiltInRecipe } from "@logicpacks/shared/recipes/builtin";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { readProjectRecipe, scaffoldProjectRecipe } from "./projectRecipe.ts";

const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lp-project-recipe-"));
afterAll(() => NodeFS.rmSync(root, { recursive: true, force: true }));

const layer = GitVcsDriver.layer.pipe(
  Layer.provideMerge(ServerConfig.layerTest(root, { prefix: "lp-project-recipe-config-" })),
  Layer.provideMerge(NodeServices.layer),
);

const repo = (name: string) => {
  const dir = NodePath.join(root, name);
  NodeFS.mkdirSync(dir);
  NodeChildProcess.spawnSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  return dir;
};

describe("project recipes", () => {
  it.effect("a project without a recipe file, or with an unknown recipe, is Code", () =>
    Effect.gen(function* () {
      const dir = repo("plain");
      expect((yield* readProjectRecipe(dir)).id).toBe("code");
      NodeFS.mkdirSync(NodePath.join(dir, ".logicpacks"));
      NodeFS.writeFileSync(NodePath.join(dir, ".logicpacks/recipe.json"), '{"recipe":"nope"}');
      expect((yield* readProjectRecipe(dir)).id).toBe("code");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("scaffolds a Blender project that Sync carries and git keeps clean", () =>
    Effect.gen(function* () {
      const dir = repo("scene");
      NodeFS.writeFileSync(NodePath.join(dir, ".gitignore"), "node_modules");
      yield* scaffoldProjectRecipe(dir, findBuiltInRecipe("blender")!);
      expect((yield* readProjectRecipe(dir)).id).toBe("blender");
      expect(NodeFS.readFileSync(NodePath.join(dir, "CLAUDE.md"), "utf8")).toBe("@AGENTS.md\n");
      expect(NodeFS.readFileSync(NodePath.join(dir, "AGENTS.md"), "utf8")).toContain(
        "logicpacks-blender MCP tools",
      );
      const tracked = NodeChildProcess.spawnSync("git", ["ls-files", "--cached"], {
        cwd: dir,
        encoding: "utf8",
      }).stdout;
      expect(tracked.split("\n").filter(Boolean).toSorted()).toEqual([
        ".gitignore",
        ".logicpacks/recipe.json",
        "AGENTS.md",
        "CLAUDE.md",
      ]);
      // Session files stay local; each branch's op log is shared.
      const session = NodePath.join(dir, ".logicpacks/blender/main");
      NodeFS.mkdirSync(session, { recursive: true });
      for (const file of ["oplog.jsonl", "bridge.json", "app.log"]) {
        NodeFS.writeFileSync(NodePath.join(session, file), "x");
      }
      NodeFS.writeFileSync(NodePath.join(dir, ".mcp.json"), "{}");
      const untracked = NodeChildProcess.spawnSync(
        "git",
        ["ls-files", "--others", "--exclude-standard"],
        { cwd: dir, encoding: "utf8" },
      ).stdout;
      expect(untracked.trim()).toBe(".logicpacks/blender/main/oplog.jsonl");
      expect(NodeFS.readFileSync(NodePath.join(dir, ".gitignore"), "utf8")).toMatch(
        /^node_modules\n# LogicPacks recipe/,
      );
    }).pipe(Effect.provide(layer)),
  );
});
