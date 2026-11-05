// @effect-diagnostics nodeBuiltinImport:off -- real folders and symlinks for the real-path rules, win32 path math for Windows hosts.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { folderAllows, resolveSharedFolders } from "./memberJail.ts";

describe("shared folders on the real path (posix)", () => {
  const base = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lp-sf-")));
  const project = NodePath.join(base, "proj");
  const outside = NodePath.join(base, "outside");
  for (const dir of ["docs", "src", "docs/deep"]) NodeFS.mkdirSync(NodePath.join(project, dir), { recursive: true });
  NodeFS.mkdirSync(outside, { recursive: true });
  NodeFS.symlinkSync(NodePath.join(project, "src"), NodePath.join(project, "docs", "to-src"));
  NodeFS.symlinkSync(outside, NodePath.join(project, "docs", "to-outside"));
  NodeFS.symlinkSync(outside, NodePath.join(project, "evil"));

  it("empty means the whole project", () => {
    expect(resolveSharedFolders(project, []).folders).toEqual([project]);
  });

  it("subfolders resolve to real paths; `..`, home and outside-pointing symlinks are rejected", () => {
    const { folders, rejected } = resolveSharedFolders(project, ["docs", "../outside", "evil", "~/x", "docs/deep"]);
    expect(folders).toEqual([NodePath.join(project, "docs"), NodePath.join(project, "docs", "deep")]);
    expect(rejected).toEqual(["../outside", "evil", "~/x"]);
  });

  it("an absolute entry is another folder the host chose; its real path is used", () => {
    expect(resolveSharedFolders(project, [outside]).folders).toEqual([outside]);
  });

  it("allows files in the folder and refuses siblings, symlinks that lead out, and `..`", () => {
    const { folders } = resolveSharedFolders(project, ["docs"]);
    expect(folderAllows(folders, NodePath.join(project, "docs", "deep", "a.txt"))).toBe(true);
    expect(folderAllows(folders, NodePath.join(project, "src", "b.txt"))).toBe(false);
    expect(folderAllows(folders, NodePath.join(project, "docs", "to-src", "b.txt"))).toBe(false);
    expect(folderAllows(folders, NodePath.join(project, "docs", "to-outside", "x"))).toBe(false);
    expect(folderAllows(folders, NodePath.join(project, "docs", "..", "src", "b.txt"))).toBe(false);
    expect(folderAllows(folders, NodePath.join(project, "docs-other", "a.txt"))).toBe(false);
  });

  it("a shared folder name that is a prefix of another does not leak the other", () => {
    NodeFS.mkdirSync(NodePath.join(project, "docs2"), { recursive: true });
    const { folders } = resolveSharedFolders(project, ["docs"]);
    expect(folderAllows(folders, NodePath.join(project, "docs2", "a.txt"))).toBe(false);
  });
});

describe("shared folders, Windows path rules (path.win32)", () => {
  const win = NodePath.win32;
  const project = "C:\\Users\\Host\\Proj";

  it("case and separators do not matter", () => {
    const { folders } = resolveSharedFolders(project, ["Docs"], win);
    expect(folders).toEqual(["C:\\Users\\Host\\Proj\\Docs"]);
    expect(folderAllows(folders, "c:/users/host/proj/docs/a.txt", win)).toBe(true);
    expect(folderAllows(folders, "C:\\USERS\\HOST\\PROJ\\DOCS\\deep\\a.txt", win)).toBe(true);
    expect(folderAllows(folders, "C:\\Users\\Host\\Proj\\Docs2\\a.txt", win)).toBe(false);
    expect(folderAllows(folders, "C:\\Users\\Host\\Proj\\src\\a.txt", win)).toBe(false);
    expect(folderAllows(folders, "C:\\Users\\Host\\Proj\\Docs\\..\\src\\a.txt", win)).toBe(false);
  });

  it("drive changes, extended prefixes and network paths are not inside", () => {
    const { folders } = resolveSharedFolders(project, ["Docs"], win);
    expect(folderAllows(folders, "D:\\Users\\Host\\Proj\\Docs\\a.txt", win)).toBe(false);
    expect(folderAllows(folders, "\\\\server\\share\\Docs\\a.txt", win)).toBe(false);
    expect(resolveSharedFolders(project, ["..\\Other", "\\\\server\\share"], win).rejected).toEqual(["..\\Other", "\\\\server\\share"]);
  });

  it("an absolute entry on another drive is a folder the host chose", () => {
    expect(resolveSharedFolders(project, ["D:\\Data"], win).folders).toEqual(["D:\\Data"]);
  });
});
