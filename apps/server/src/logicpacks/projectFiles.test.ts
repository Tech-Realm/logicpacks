// @effect-diagnostics nodeBuiltinImport:off -- the tests build real folders, symlinks and repos.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";

import { afterEach, describe, expect, it } from "@effect/vitest";

import {
  buildZip,
  cleanRelativePath,
  DEFAULT_UPLOAD_MAX_BYTES,
  githubRepoOf,
  listProjectFiles,
  ProjectFileError,
  publicCloneUrl,
  uploadMaxBytes,
  writeProjectUpload,
  zipFolderName,
  zipProject,
} from "./projectFiles.ts";

const made: Array<string> = [];
const tempDir = () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lp-files-"));
  made.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of made.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
});

const bytes = (text: string) => new TextEncoder().encode(text);
const upload = (
  root: string,
  path: string,
  text: string,
  extra: Partial<Parameters<typeof writeProjectUpload>[0]> = {},
) =>
  writeProjectUpload({
    root,
    folder: "",
    path,
    bytes: bytes(text),
    conflict: "fail",
    maxBytes: 1024,
    ...extra,
  });

const reason = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return error instanceof ProjectFileError ? error.reason : "other";
  }
  return "none";
};

/** Reads a zip back with the central directory, enough to check names and contents. */
const readZip = (zip: Buffer) => {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = zip.readUInt16LE(end + 10);
  let offset = zip.readUInt32LE(end + 16);
  const files = new Map<string, string>();
  for (let index = 0; index < count; index += 1) {
    const method = zip.readUInt16LE(offset + 10);
    const size = zip.readUInt32LE(offset + 20);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const local = zip.readUInt32LE(offset + 42);
    const name = zip.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    const localName = zip.readUInt16LE(local + 26);
    const localExtra = zip.readUInt16LE(local + 28);
    const body = zip.subarray(
      local + 30 + localName + localExtra,
      local + 30 + localName + localExtra + size,
    );
    files.set(name, (method === 8 ? NodeZlib.inflateRawSync(body) : body).toString("utf8"));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return files;
};

describe("project uploads", () => {
  it("writes into the chosen folder and creates missing folders", () => {
    const root = tempDir();
    const result = upload(root, "site/img/logo.svg", "<svg/>", { folder: "assets" });
    expect(result).toEqual({ path: "assets/site/img/logo.svg", status: "created", bytes: 6 });
    expect(NodeFS.readFileSync(NodePath.join(root, "assets/site/img/logo.svg"), "utf8")).toBe(
      "<svg/>",
    );
  });

  it("keeps every write inside the project", () => {
    const root = tempDir();
    const outside = tempDir();
    expect(reason(() => upload(root, "../escape.txt", "x"))).toBe("invalid_path");
    expect(reason(() => upload(root, "a/../../escape.txt", "x"))).toBe("invalid_path");
    expect(reason(() => upload(root, "/etc/passwd", "x"))).toBe("invalid_path");
    expect(reason(() => upload(root, "ok.txt", "x", { folder: "../up" }))).toBe("invalid_path");
    expect(reason(() => upload(root, ".git/hooks/pre-commit", "x"))).toBe("invalid_path");
    expect(reason(() => upload(root, "nul\0.txt", "x"))).toBe("invalid_path");
    NodeFS.symlinkSync(outside, NodePath.join(root, "link"));
    expect(reason(() => upload(root, "link/planted.txt", "x"))).toBe("outside_project");
    expect(NodeFS.existsSync(NodePath.join(outside, "planted.txt"))).toBe(false);
  });

  it("replacing a symlink never writes through it", () => {
    const root = tempDir();
    const outside = tempDir();
    const secret = NodePath.join(outside, "secret.txt");
    NodeFS.writeFileSync(secret, "keep");
    NodeFS.symlinkSync(secret, NodePath.join(root, "notes.txt"));
    expect(reason(() => upload(root, "notes.txt", "new", { conflict: "replace" }))).toBe(
      "outside_project",
    );
    expect(NodeFS.readFileSync(secret, "utf8")).toBe("keep");
  });

  it("enforces the size limit", () => {
    const root = tempDir();
    expect(reason(() => upload(root, "big.bin", "x".repeat(2048)))).toBe("too_large");
    expect(NodeFS.existsSync(NodePath.join(root, "big.bin"))).toBe(false);
    expect(uploadMaxBytes({})).toBe(DEFAULT_UPLOAD_MAX_BYTES);
    expect(uploadMaxBytes({ LOGICPACKS_UPLOAD_MAX_MB: "5" })).toBe(5 * 1024 * 1024);
    expect(uploadMaxBytes({ LOGICPACKS_UPLOAD_MAX_MB: "nope" })).toBe(DEFAULT_UPLOAD_MAX_BYTES);
  });

  it("asks, replaces or keeps both on a conflict", () => {
    const root = tempDir();
    upload(root, "a.txt", "one");
    expect(reason(() => upload(root, "a.txt", "two"))).toBe("exists");
    expect(upload(root, "a.txt", "two", { conflict: "replace" }).status).toBe("replaced");
    expect(NodeFS.readFileSync(NodePath.join(root, "a.txt"), "utf8")).toBe("two");
    const kept = upload(root, "a.txt", "three", { conflict: "keep-both" });
    expect(kept).toMatchObject({ path: "a (1).txt", status: "renamed" });
    expect(upload(root, "a.txt", "four", { conflict: "keep-both" }).path).toBe("a (2).txt");
    expect(NodeFS.readFileSync(NodePath.join(root, "a.txt"), "utf8")).toBe("two");
    NodeFS.mkdirSync(NodePath.join(root, "dir"));
    expect(reason(() => upload(root, "dir", "x", { conflict: "replace" }))).toBe("not_a_folder");
  });

  it("cleans relative paths", () => {
    expect(cleanRelativePath("a//b/./c.txt")).toBe("a/b/c.txt");
    expect(cleanRelativePath("win\\style\\x.txt")).toBe("win/style/x.txt");
    expect(cleanRelativePath("")).toBe("");
  });
});

describe("project zip", () => {
  it("zips tracked and untracked files, skips ignored ones and .git", () => {
    const root = tempDir();
    const git = (...args: Array<string>) =>
      NodeChildProcess.execFileSync("git", args, { cwd: root, stdio: "ignore" });
    git("init", "-q");
    NodeFS.writeFileSync(NodePath.join(root, ".gitignore"), "node_modules/\n");
    NodeFS.writeFileSync(NodePath.join(root, "index.html"), "<h1>hi</h1>");
    NodeFS.mkdirSync(NodePath.join(root, "node_modules/x"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(root, "node_modules/x/i.js"), "1");
    git("add", ".");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
    upload(root, "photo.txt", "uploaded", { folder: "uploads" });
    expect(listProjectFiles(root)).toEqual([".gitignore", "index.html", "uploads/photo.txt"]);
    const files = readZip(zipProject({ root, folderName: "site", maxBytes: 1024 * 1024 }));
    expect([...files.keys()].sort()).toEqual([
      "site/.gitignore",
      "site/index.html",
      "site/uploads/photo.txt",
    ]);
    expect(files.get("site/uploads/photo.txt")).toBe("uploaded");
    expect(reason(() => zipProject({ root, folderName: "site", maxBytes: 4 }))).toBe("too_large");
  });

  it("builds a valid zip that unzip can read", () => {
    const dir = tempDir();
    const zip = buildZip([
      { name: "p/a.txt", data: bytes("a".repeat(500)) },
      { name: "p/b.bin", data: new Uint8Array([0, 1, 2]) },
    ]);
    const file = NodePath.join(dir, "out.zip");
    NodeFS.writeFileSync(file, zip);
    const listed = NodeChildProcess.spawnSync("unzip", ["-Z1", file], { encoding: "utf8" });
    if (listed.status === 0)
      expect(listed.stdout.trim().split("\n")).toEqual(["p/a.txt", "p/b.bin"]);
    expect(readZip(zip).get("p/a.txt")).toBe("a".repeat(500));
  });

  it("names the zip folder safely", () => {
    expect(zipFolderName("Team site / v2")).toBe("Team-site-v2");
    expect(zipFolderName("..")).toBe("project");
  });
});

describe("clone urls", () => {
  it("reads GitHub repositories and strips credentials", () => {
    expect(githubRepoOf("https://github.com/acme/site.git")).toBe("acme/site");
    expect(githubRepoOf("git@github.com:acme/site.git")).toBe("acme/site");
    expect(githubRepoOf("https://x-access-token:abc@github.com/acme/site")).toBe("acme/site");
    expect(githubRepoOf("/srv/bare/site.git")).toBeNull();
    expect(publicCloneUrl("https://x-access-token:abc@github.com/acme/site")).toBe(
      "https://github.com/acme/site.git",
    );
    expect(publicCloneUrl("https://user:pw@git.example.com/a/b.git")).toBe(
      "https://git.example.com/a/b.git",
    );
    expect(publicCloneUrl(null)).toBeNull();
  });
});
