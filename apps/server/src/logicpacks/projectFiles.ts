// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- uploads and zips must see the real filesystem (realpath, symlinks) synchronously.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";

import { isWithin, realpathLenient } from "./memberJail.ts";
import { memberSandboxEnabled } from "./memberSandbox.ts";

/**
 * Uploads into, and zips of, a project's working copy. Paths stay inside the project root under
 * the member jail's realpath rules and never touch `.git`; the sync engine commits the rest.
 * Sandboxed hosts keep uploads group read/write for members' own Unix users.
 */

/** One uploaded file's default ceiling; LOGICPACKS_UPLOAD_MAX_MB overrides it. */
export const DEFAULT_UPLOAD_MAX_BYTES = 100 * 1024 * 1024;
/** The zip's ceiling (sum of file sizes); LOGICPACKS_ZIP_MAX_MB overrides it. */
export const DEFAULT_ZIP_MAX_BYTES = 500 * 1024 * 1024;

export type UploadConflict = "replace" | "keep-both" | "fail";

export type ProjectFileErrorReason =
  | "invalid_path"
  | "outside_project"
  | "too_large"
  | "exists"
  | "not_a_folder";

export class ProjectFileError extends Error {
  readonly reason: ProjectFileErrorReason;
  constructor(reason: ProjectFileErrorReason, message: string) {
    super(message);
    this.reason = reason;
  }
}

const megabytes = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed * 1024 * 1024) : fallback;
};

export const uploadMaxBytes = (env: NodeJS.ProcessEnv = process.env) =>
  megabytes(env.LOGICPACKS_UPLOAD_MAX_MB, DEFAULT_UPLOAD_MAX_BYTES);

export const zipMaxBytes = (env: NodeJS.ProcessEnv = process.env) =>
  megabytes(env.LOGICPACKS_ZIP_MAX_MB, DEFAULT_ZIP_MAX_BYTES);

/**
 * A project-relative path from what the browser sent (`folder/sub/file.txt`, forward slashes).
 * Rejects absolute paths, `..`, NUL and anything inside `.git`. Returns "" for the root.
 */
export const cleanRelativePath = (raw: string): string => {
  if (raw.includes("\0")) throw new ProjectFileError("invalid_path", "That path is not allowed.");
  const segments = raw
    .replaceAll("\\", "/")
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== ".");
  if (/^[A-Za-z]:/.test(raw) || raw.startsWith("/") || raw.startsWith("\\")) {
    throw new ProjectFileError("invalid_path", "Use a path inside the project.");
  }
  for (const segment of segments) {
    if (segment === "..")
      throw new ProjectFileError("invalid_path", "Use a path inside the project.");
    if (segment.toLowerCase() === ".git") {
      throw new ProjectFileError("invalid_path", "Files inside .git cannot be uploaded.");
    }
  }
  return segments.join("/");
};

/** The absolute target inside `root`, after following every symlink that already exists. */
export const resolveInsideProject = (root: string, relativePath: string): string => {
  const realRoot = realpathLenient(NodePath.resolve(root));
  const target = NodePath.join(realRoot, ...relativePath.split("/").filter(Boolean));
  if (!isWithin(realRoot, realpathLenient(target))) {
    throw new ProjectFileError("outside_project", "That path leaves the project.");
  }
  return target;
};

/** `name (1).ext`, `name (2).ext`, … the first one free in the same folder. */
export const keepBothName = (absolute: string): string => {
  const directory = NodePath.dirname(absolute);
  const extension = NodePath.extname(absolute);
  const stem = NodePath.basename(absolute, extension);
  for (let index = 1; index < 10_000; index += 1) {
    const candidate = NodePath.join(directory, `${stem} (${index})${extension}`);
    if (!NodeFS.existsSync(candidate)) return candidate;
  }
  throw new ProjectFileError("exists", "Too many copies of that file already.");
};

export interface UploadResult {
  /** Project-relative path that was written. */
  readonly path: string;
  readonly status: "created" | "replaced" | "renamed";
  readonly bytes: number;
}

/** Writes one uploaded file into the project's working copy. */
export const writeProjectUpload = (input: {
  readonly root: string;
  readonly folder: string;
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly conflict: UploadConflict;
  readonly maxBytes: number;
}): UploadResult => {
  if (input.bytes.byteLength > input.maxBytes) {
    throw new ProjectFileError(
      "too_large",
      `Files over ${Math.round(input.maxBytes / 1024 / 1024)} MB cannot be uploaded.`,
    );
  }
  const relative = [cleanRelativePath(input.folder), cleanRelativePath(input.path)]
    .filter(Boolean)
    .join("/");
  if (relative.length === 0) throw new ProjectFileError("invalid_path", "Name the file.");
  const realRoot = realpathLenient(NodePath.resolve(input.root));
  let target = resolveInsideProject(input.root, relative);
  const existing = NodeFS.lstatSync(target, { throwIfNoEntry: false });
  let status: UploadResult["status"] = "created";
  if (existing?.isDirectory()) {
    throw new ProjectFileError("not_a_folder", `${relative} is a folder.`);
  }
  if (existing) {
    if (input.conflict === "fail") throw new ProjectFileError("exists", `${relative} exists.`);
    if (input.conflict === "keep-both") {
      target = keepBothName(target);
      status = "renamed";
    } else {
      status = "replaced";
    }
  }
  const parent = NodePath.dirname(target);
  const shared = memberSandboxEnabled();
  const created = NodeFS.mkdirSync(parent, { recursive: true });
  // New folders in a sandboxed project keep its group (setgid) and group write.
  if (shared && created !== undefined) {
    for (let dir = parent; isWithin(created, dir); dir = NodePath.dirname(dir)) {
      NodeFS.chmodSync(dir, 0o2770);
      if (dir === created) break;
    }
  }
  // The folders now exist: check again that no symlink in them points outside.
  if (!isWithin(realRoot, NodeFS.realpathSync(parent))) {
    throw new ProjectFileError("outside_project", "That path leaves the project.");
  }
  // Replacing a symlink replaces the link, never the file it points at.
  if (status === "replaced" && existing?.isSymbolicLink()) NodeFS.rmSync(target);
  const temporary = `${target}.lp-upload-${process.pid}-${Date.now()}`;
  NodeFS.writeFileSync(temporary, input.bytes, { flag: "wx", mode: shared ? 0o660 : 0o644 });
  if (shared) NodeFS.chmodSync(temporary, 0o660);
  NodeFS.renameSync(temporary, target);
  return {
    path: NodePath.relative(realRoot, target).split(NodePath.sep).join("/"),
    status,
    bytes: input.bytes.byteLength,
  };
};

/** What the zip holds: tracked files plus untracked ones git does not ignore; never `.git`. */
export const listProjectFiles = (root: string): ReadonlyArray<string> => {
  const listed = NodeChildProcess.spawnSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: root, encoding: "buffer", maxBuffer: 256 * 1024 * 1024 },
  );
  if (listed.status === 0) {
    const names = listed.stdout
      .toString("utf8")
      .split("\0")
      .filter((name) => name.length > 0 && !name.split("/").includes(".git"));
    return Array.from(new Set(names)).sort();
  }
  const files: Array<string> = [];
  const walk = (relative: string) => {
    for (const entry of NodeFS.readdirSync(NodePath.join(root, relative), {
      withFileTypes: true,
    })) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) files.push(child);
    }
  };
  walk("");
  return files.sort();
};

const dosDateTime = (date: Date) => {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
};

export interface ZipEntry {
  readonly name: string;
  readonly data: Uint8Array;
  readonly modified?: Date;
}

/** A plain zip (deflate, UTF-8 names). Small enough to keep without a dependency. */
export const buildZip = (entries: ReadonlyArray<ZipEntry>): Buffer => {
  const chunks: Array<Buffer> = [];
  const central: Array<Buffer> = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const raw = Buffer.from(entry.data);
    const deflated = NodeZlib.deflateRawSync(raw);
    const stored = deflated.byteLength >= raw.byteLength;
    const body = stored ? raw : deflated;
    const crc = NodeZlib.crc32(raw) >>> 0;
    const { time, date } = dosDateTime(entry.modified ?? new Date());
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.byteLength, 18);
    local.writeUInt32LE(raw.byteLength, 22);
    local.writeUInt16LE(name.byteLength, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, name, body);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(0x031e, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt16LE(stored ? 0 : 8, 10);
    header.writeUInt16LE(time, 12);
    header.writeUInt16LE(date, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(body.byteLength, 20);
    header.writeUInt32LE(raw.byteLength, 24);
    header.writeUInt16LE(name.byteLength, 28);
    header.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    header.writeUInt32LE(offset, 42);
    central.push(header, name);
    offset += local.byteLength + name.byteLength + body.byteLength;
  }
  const centralSize = central.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, ...central, end]);
};

/** The project's working copy as a zip, inside a folder named after the project. */
export const zipProject = (input: {
  readonly root: string;
  readonly folderName: string;
  readonly maxBytes: number;
  /** Project-relative paths to leave out (secret files hidden from this person). */
  readonly exclude?: ((relative: string) => boolean) | undefined;
}): Buffer => {
  const realRoot = realpathLenient(NodePath.resolve(input.root));
  const entries: Array<ZipEntry> = [];
  let total = 0;
  for (const relative of listProjectFiles(realRoot)) {
    if (input.exclude?.(relative) === true) continue;
    const absolute = NodePath.join(realRoot, relative);
    const info = NodeFS.lstatSync(absolute, { throwIfNoEntry: false });
    // Symlinks are left out: following one could read outside the project.
    if (!info?.isFile()) continue;
    total += info.size;
    if (total > input.maxBytes) {
      throw new ProjectFileError(
        "too_large",
        `The project is over ${Math.round(input.maxBytes / 1024 / 1024)} MB. Clone it instead.`,
      );
    }
    entries.push({
      name: `${input.folderName}/${relative}`,
      data: NodeFS.readFileSync(absolute),
      modified: info.mtime,
    });
  }
  return buildZip(entries);
};

/** A safe folder and file name for the zip from the project title. */
export const zipFolderName = (title: string) =>
  title
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+|-+$/g, "")
    .slice(0, 80) || "project";

/** `owner/name` of a GitHub remote, or null. */
export const githubRepoOf = (remote: string | null): string | null => {
  if (!remote) return null;
  const match =
    /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/i.exec(
      remote.trim(),
    );
  return match ? `${match[1]}/${match[2]}` : null;
};

/**
 * The repository a project's folder already pushes to (its git `origin`), for a laptop project that
 * was shared with `lp share` and so has no Sync record. Null when the folder has none.
 */
export const originRemote = (root: string): string | null => {
  try {
    const result = NodeChildProcess.spawnSync("git", ["config", "--get", "remote.origin.url"], {
      cwd: root,
      encoding: "utf8",
      timeout: 3000,
    });
    const url = result.status === 0 ? result.stdout.trim() : "";
    return url === "" ? null : url;
  } catch {
    return null;
  }
};

/** The URL people clone: credentials stripped, GitHub as https. */
export const publicCloneUrl = (remote: string | null): string | null => {
  if (!remote) return null;
  const repo = githubRepoOf(remote);
  if (repo) return `https://github.com/${repo}.git`;
  try {
    const url = new URL(remote);
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return remote;
  }
};
