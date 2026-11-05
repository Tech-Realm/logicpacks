// @effect-diagnostics nodeBuiltinImport:off -- a few small files in the project's own checkout, read and written synchronously.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { cleanRelativePath, resolveInsideProject } from "./projectFiles.ts";

/**
 * Two agents on one checkout write to the same file and the later write replaces the earlier one.
 * The ledger sees it (a conflict) and, from then on, never lets that be silent: each party's last
 * written version is copied to `<project>/.logicpacks/preserved/<conflictId>/<threadId>/<path>`.
 * The folder is kept out of git through `.git/info/exclude`, so sync never commits it. A person
 * restores a version, or Merge both writes every version into the file.
 */

export const PRESERVED_DIR = ".logicpacks/preserved";
/** Bigger files are not copied: they are not the text two agents merge by hand. */
export const MAX_PRESERVED_BYTES = 2 * 1024 * 1024;

export interface PreservedVersion {
  readonly threadId: string;
  /** The person whose agent wrote it. */
  readonly name: string;
  /** Project-relative, forward slashes. */
  readonly path: string;
  readonly bytes: number;
  /** False for binary content: it can be restored but not merged line by line. */
  readonly text: boolean;
  readonly savedAtMs: number;
}

const isText = (bytes: Buffer) => !bytes.includes(0);

/** The file as the agents see it now; null when it is missing, a folder, outside the root or too big. */
export const readProjectFile = (root: string, relativePath: string): Buffer | null => {
  try {
    const absolute = resolveInsideProject(root, cleanRelativePath(relativePath));
    const info = NodeFS.statSync(absolute);
    if (!info.isFile() || info.size > MAX_PRESERVED_BYTES) return null;
    return NodeFS.readFileSync(absolute);
  } catch {
    return null;
  }
};

const versionFile = (root: string, conflictId: string, threadId: string, relativePath: string) =>
  NodePath.join(
    root,
    PRESERVED_DIR,
    conflictId.replaceAll(/[^\w.-]/g, "_"),
    threadId.replaceAll(/[^\w.-]/g, "_"),
    ...cleanRelativePath(relativePath).split("/"),
  );

/** Keeps `.logicpacks/` out of commits without touching the project's own .gitignore. */
const excludeFromGit = (root: string) => {
  try {
    const gitDir = NodePath.join(root, ".git");
    if (!NodeFS.statSync(gitDir).isDirectory()) return;
    const exclude = NodePath.join(gitDir, "info", "exclude");
    const current = NodeFS.existsSync(exclude) ? NodeFS.readFileSync(exclude, "utf8") : "";
    if (current.split("\n").some((line) => line.trim() === ".logicpacks/")) return;
    NodeFS.mkdirSync(NodePath.dirname(exclude), { recursive: true });
    NodeFS.appendFileSync(exclude, `${current.endsWith("\n") || current === "" ? "" : "\n"}.logicpacks/\n`);
  } catch {
    // A project without a git directory has nothing to exclude from.
  }
};

/** Copies one party's version into the store; returns its record, or null when nothing could be saved. */
export const savePreserved = (input: {
  readonly root: string;
  readonly conflictId: string;
  readonly threadId: string;
  readonly name: string;
  readonly path: string;
  readonly content: Buffer;
  readonly nowMs: number;
}): PreservedVersion | null => {
  try {
    const target = versionFile(input.root, input.conflictId, input.threadId, input.path);
    NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
    NodeFS.writeFileSync(target, input.content);
    excludeFromGit(input.root);
    return {
      threadId: input.threadId,
      name: input.name,
      path: cleanRelativePath(input.path),
      bytes: input.content.byteLength,
      text: isText(input.content),
      savedAtMs: input.nowMs,
    };
  } catch {
    return null;
  }
};

export const readPreserved = (
  root: string,
  conflictId: string,
  version: Pick<PreservedVersion, "threadId" | "path">,
): Buffer | null => {
  try {
    return NodeFS.readFileSync(versionFile(root, conflictId, version.threadId, version.path));
  } catch {
    return null;
  }
};

/** Puts `content` at the project path (creating folders); returns false if it cannot. */
export const writeProjectFile = (root: string, relativePath: string, content: Buffer): boolean => {
  try {
    const absolute = resolveInsideProject(root, cleanRelativePath(relativePath));
    NodeFS.mkdirSync(NodePath.dirname(absolute), { recursive: true });
    NodeFS.writeFileSync(absolute, content);
    return true;
  } catch {
    return false;
  }
};

/**
 * Every version in one file, nothing dropped: the first version whole, then each later version's
 * lines that the file does not have yet, in their own order. Identical versions collapse to one.
 */
export const unionMerge = (versions: ReadonlyArray<string>): string => {
  const distinct = versions.filter((text, index) => versions.indexOf(text) === index);
  const [first, ...rest] = distinct;
  if (first === undefined) return "";
  const lines = first.replace(/\n$/, "").split("\n");
  const seen = new Set(lines);
  for (const text of rest) {
    for (const line of text.replace(/\n$/, "").split("\n")) {
      if (seen.has(line)) continue;
      seen.add(line);
      lines.push(line);
    }
  }
  return `${lines.join("\n")}\n`;
};
