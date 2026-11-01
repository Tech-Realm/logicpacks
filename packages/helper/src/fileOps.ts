import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

/**
 * Every file the helper changes outside its own folder goes through here, so it can be
 * shown first (`--dry-run` prints a unified diff and writes nothing) and backed up before
 * it changes (`<file>.lp-backup-<YYYYMMDD-HHMMSS>`, printed). Commands such as launchctl
 * are listed in a dry run instead of run.
 */

export interface FileChange {
  readonly file: string;
  /** null: the file does not exist (before) or is deleted (after). */
  readonly before: string | null;
  readonly after: string | null;
}

export interface FileSession {
  readonly dryRun: boolean;
  readonly stamp: string;
  readonly changes: Array<FileChange>;
  readonly backups: Array<string>;
  /** Commands a dry run would have run (launchctl, systemctl, wscript). */
  readonly commands: Array<string>;
}

const pad = (value: number) => String(value).padStart(2, "0");

export const backupStamp = (at: Date) =>
  `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;

let current: FileSession | null = null;

/** Starts collecting changes; with `dryRun`, nothing is written until the session ends. */
export const beginFileSession = (dryRun: boolean, at = new Date()): FileSession => {
  current = { dryRun, stamp: backupStamp(at), changes: [], backups: [], commands: [] };
  return current;
};

export const endFileSession = (): FileSession | null => {
  const session = current;
  current = null;
  return session;
};

export const isDryRun = () => current?.dryRun === true;

const readOrNull = (file: string) => {
  try {
    return NodeFS.readFileSync(file, "utf8");
  } catch {
    return null;
  }
};

/** In a dry run, what a file holds after the changes planned so far. */
export const readPlanned = (file: string): string | null => {
  if (current?.dryRun) {
    for (let index = current.changes.length - 1; index >= 0; index -= 1) {
      const change = current.changes[index]!;
      if (change.file === file) return change.after;
    }
  }
  return readOrNull(file);
};

const backedUp = new Set<string>();

/** Copies `file` next to itself once per session; returns the copy's path. */
const backup = (file: string, stamp: string) => {
  const key = `${stamp}\0${file}`;
  if (backedUp.has(key)) return null;
  backedUp.add(key);
  let target = `${file}.lp-backup-${stamp}`;
  for (let n = 2; NodeFS.existsSync(target); n += 1) target = `${file}.lp-backup-${stamp}-${n}`;
  NodeFS.copyFileSync(file, target);
  return target;
};

/**
 * Writes `after` to `file` (null deletes it). Unchanged content is not written. Outside a
 * session the write still backs up an existing file first.
 */
export const commitFile = (file: string, after: string | null, mode?: number): boolean => {
  const before = current?.dryRun ? readPlanned(file) : readOrNull(file);
  if (before === after) return false;
  current?.changes.push({ file, before, after });
  if (current?.dryRun) return true;
  if (before !== null) {
    const copy = backup(file, current?.stamp ?? backupStamp(new Date()));
    if (copy !== null) current?.backups.push(copy);
  }
  if (after === null) {
    NodeFS.rmSync(file, { force: true });
    return true;
  }
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
  const fileMode = before !== null ? NodeFS.statSync(file).mode & 0o777 : (mode ?? 0o644);
  const temp = `${file}.lp-${process.pid}.tmp`;
  NodeFS.writeFileSync(temp, after, { mode: fileMode });
  NodeFS.renameSync(temp, file);
  return true;
};

/** Runs a side effect, or in a dry run lists it. */
export const runOrList = <A>(description: string, run: () => A, dryValue: A): A => {
  if (current?.dryRun) {
    current.commands.push(description);
    return dryValue;
  }
  return run();
};

// ── Unified diff ──

const splitLines = (text: string | null) => {
  if (text === null || text.length === 0) return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
};

type Op = { readonly kind: " " | "-" | "+"; readonly line: string };

const lineOps = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): Array<Op> => {
  // Common prefix and suffix first; the edited middle is small, so the LCS table stays small.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const ops: Array<Op> = a.slice(0, start).map((line) => ({ kind: " ", line }));
  if (midA.length * midB.length > 4_000_000) {
    ops.push(...midA.map((line) => ({ kind: "-" as const, line })));
    ops.push(...midB.map((line) => ({ kind: "+" as const, line })));
  } else {
    const rows = midA.length + 1;
    const cols = midB.length + 1;
    const table = new Uint32Array(rows * cols);
    for (let i = midA.length - 1; i >= 0; i -= 1) {
      for (let j = midB.length - 1; j >= 0; j -= 1) {
        table[i * cols + j] =
          midA[i] === midB[j]
            ? table[(i + 1) * cols + j + 1]! + 1
            : Math.max(table[(i + 1) * cols + j]!, table[i * cols + j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < midA.length && j < midB.length) {
      if (midA[i] === midB[j]) {
        ops.push({ kind: " ", line: midA[i]! });
        i += 1;
        j += 1;
      } else if (table[(i + 1) * cols + j]! >= table[i * cols + j + 1]!) {
        ops.push({ kind: "-", line: midA[i]! });
        i += 1;
      } else {
        ops.push({ kind: "+", line: midB[j]! });
        j += 1;
      }
    }
    while (i < midA.length) ops.push({ kind: "-", line: midA[i++]! });
    while (j < midB.length) ops.push({ kind: "+", line: midB[j++]! });
  }
  ops.push(...a.slice(endA).map((line) => ({ kind: " " as const, line })));
  return ops;
};

/** A unified diff (3 lines of context), as `diff -u` prints it. */
export const unifiedDiff = (change: FileChange, context = 3): string => {
  const a = splitLines(change.before);
  const b = splitLines(change.after);
  const ops = lineOps(a, b);
  const header = [
    `--- ${change.before === null ? "/dev/null" : change.file}`,
    `+++ ${change.after === null ? "/dev/null" : change.file}`,
  ];
  const hunks: Array<string> = [];
  let index = 0;
  while (index < ops.length) {
    if (ops[index]!.kind === " ") {
      index += 1;
      continue;
    }
    let from = Math.max(0, index - context);
    let to = index;
    // Extend while changes are within 2 * context of each other.
    for (let cursor = index; cursor < ops.length; cursor += 1) {
      if (ops[cursor]!.kind !== " ") to = cursor;
      else if (cursor - to > context * 2) break;
    }
    const end = Math.min(ops.length, to + context + 1);
    let lineA = 1;
    let lineB = 1;
    for (let cursor = 0; cursor < from; cursor += 1) {
      if (ops[cursor]!.kind !== "+") lineA += 1;
      if (ops[cursor]!.kind !== "-") lineB += 1;
    }
    const slice = ops.slice(from, end);
    const countA = slice.filter((op) => op.kind !== "+").length;
    const countB = slice.filter((op) => op.kind !== "-").length;
    hunks.push(
      `@@ -${countA === 0 ? lineA - 1 : lineA},${countA} +${countB === 0 ? lineB - 1 : lineB},${countB} @@`,
      ...slice.map((op) => `${op.kind}${op.line}`),
    );
    index = end;
    from = end;
  }
  return [...header, ...hunks].join("\n");
};

/** What a dry run prints: one diff per file, then the commands it would run. */
export const describeSession = (session: FileSession): string => {
  const parts: Array<string> = [];
  if (session.changes.length === 0 && session.commands.length === 0) {
    return "Nothing would change.";
  }
  for (const change of session.changes) parts.push(unifiedDiff(change));
  if (session.commands.length > 0) {
    parts.push(
      ["It would also run:", ...session.commands.map((command) => `  ${command}`)].join("\n"),
    );
  }
  return parts.join("\n\n");
};

export const describeBackups = (session: FileSession): string =>
  session.backups.length === 0
    ? ""
    : ["Backups of the files changed:", ...session.backups.map((file) => `  ${file}`)].join("\n");
