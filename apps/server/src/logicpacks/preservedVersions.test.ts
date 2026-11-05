// @effect-diagnostics nodeBuiltinImport:off -- the tests build real folders and a git repo.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";

import {
  PRESERVED_DIR,
  readPreserved,
  readProjectFile,
  savePreserved,
  unionMerge,
  writeProjectFile,
} from "./preservedVersions.ts";

let root = "";
beforeEach(() => {
  root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lp-preserved-"));
  NodeChildProcess.spawnSync("git", ["init", "--quiet"], {
    cwd: root,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
  });
});
afterEach(() => NodeFS.rmSync(root, { recursive: true, force: true }));

const save = (threadId: string, name: string, content: string, path = "shared.txt") =>
  savePreserved({
    root,
    conflictId: "c-1",
    threadId,
    name,
    path,
    content: Buffer.from(content),
    nowMs: 1,
  });

describe("preserved versions", () => {
  it("keeps the first writer's version after the second writer replaced the file", () => {
    writeProjectFile(root, "shared.txt", Buffer.from("BO\n"));
    const bo = save("t-bo", "Bo", readProjectFile(root, "shared.txt")!.toString());
    writeProjectFile(root, "shared.txt", Buffer.from("CY\n"));
    const cy = save("t-cy", "Cy", readProjectFile(root, "shared.txt")!.toString());

    expect(NodeFS.readFileSync(NodePath.join(root, "shared.txt"), "utf8")).toBe("CY\n");
    expect(readPreserved(root, "c-1", bo!)?.toString()).toBe("BO\n");
    expect(readPreserved(root, "c-1", cy!)?.toString()).toBe("CY\n");
    expect(bo).toMatchObject({ threadId: "t-bo", name: "Bo", path: "shared.txt", text: true });
    // Restore: the saved bytes go back into the file.
    writeProjectFile(root, "shared.txt", readPreserved(root, "c-1", bo!)!);
    expect(NodeFS.readFileSync(NodePath.join(root, "shared.txt"), "utf8")).toBe("BO\n");
  });

  it("is stored under .logicpacks/preserved and kept out of git", () => {
    save("t-bo", "Bo", "BO\n", "docs/a.txt");
    expect(
      NodeFS.existsSync(NodePath.join(root, PRESERVED_DIR, "c-1", "t-bo", "docs", "a.txt")),
    ).toBe(true);
    const status = NodeChildProcess.spawnSync("git", ["status", "--porcelain", "-uall"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
    }).stdout;
    expect(status).not.toContain(".logicpacks");
    save("t-cy", "Cy", "CY\n", "docs/a.txt");
    const exclude = NodeFS.readFileSync(NodePath.join(root, ".git/info/exclude"), "utf8");
    expect(exclude.match(/\.logicpacks\//g)).toHaveLength(1);
  });

  it("refuses paths that leave the project and ignores missing or oversize files", () => {
    expect(save("t-bo", "Bo", "x", "../outside.txt")).toBeNull();
    expect(readProjectFile(root, "../outside.txt")).toBeNull();
    expect(readProjectFile(root, "missing.txt")).toBeNull();
    expect(writeProjectFile(root, "../escape.txt", Buffer.from("x"))).toBe(false);
  });

  it("marks binary content so it is restored whole, never merged by lines", () => {
    const version = savePreserved({
      root,
      conflictId: "c-1",
      threadId: "t-bo",
      name: "Bo",
      path: "logo.bin",
      content: Buffer.from([1, 0, 2]),
      nowMs: 1,
    });
    expect(version?.text).toBe(false);
  });
});

describe("unionMerge", () => {
  it("keeps every version: the first whole, then each later version's new lines", () => {
    expect(unionMerge(["BO VERSION\n", "CY VERSION\n"])).toBe("BO VERSION\nCY VERSION\n");
    expect(unionMerge(["a\nb\n", "a\nc\n", "a\nb\n"])).toBe("a\nb\nc\n");
  });
  it("collapses identical versions and handles a missing trailing newline", () => {
    expect(unionMerge(["same", "same\n"])).toBe("same\n");
    expect(unionMerge([])).toBe("");
  });
});
