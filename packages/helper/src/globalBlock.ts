import { commitFile, readPlanned } from "./fileOps.ts";

/**
 * Writes the LogicPacks block into an agent's instructions file and takes it out again.
 * Only the marked block (or a file of our own) changes; removing it gives back the file
 * byte for byte, whatever its line endings and trailing newline were.
 */

export interface Markers {
  readonly start: string;
  readonly end: string;
}

export const MARKDOWN_MARKERS: Markers = {
  start: "<!-- logicpacks:start -->",
  end: "<!-- logicpacks:end -->",
};
export const YAML_MARKERS: Markers = { start: "# logicpacks:start", end: "# logicpacks:end" };

/**
 * Adds, replaces (`body`) or removes (`null`) the marked block. Appending always adds exactly
 * one newline before the block, and removal takes exactly that one back, so the original
 * comes back byte for byte whether or not it ended with a newline.
 */
export const withMarkedBlock = (text: string, body: string | null, markers: Markers): string => {
  assertBalanced(text, markers);
  const start = text.indexOf(markers.start);
  const end = start < 0 ? -1 : text.indexOf(markers.end, start);
  if (start >= 0 && end >= 0) {
    const tail = end + markers.end.length;
    if (body !== null) {
      return `${text.slice(0, start)}${markers.start}\n${body}\n${text.slice(end)}`;
    }
    let from = start;
    let to = tail;
    if (text[to] === "\n") to += 1;
    if (from >= 1 && text[from - 1] === "\n") {
      // "x\n\n<block>" came from "x\n"; "x\n<block>" came from "x" (no trailing newline).
      from -= 1;
    }
    return `${text.slice(0, from)}${text.slice(to)}`;
  }
  if (body === null) return text;
  const block = `${markers.start}\n${body}\n${markers.end}\n`;
  if (text.length === 0) return block;
  // One newline: after a trailing newline it makes the blank line, else it ends the last line.
  return `${text}\n${block}`;
};

const count = (text: string, needle: string) => text.split(needle).length - 1;

/** Markers we cannot pair safely; the caller refuses to write. */
export class UnbalancedMarkersError extends Error {}

/**
 * One start marker followed by one end marker, or neither. Anything else (a lone marker, two
 * blocks, end before start) means someone edited by hand: we refuse rather than guess.
 */
export const assertBalanced = (text: string, markers: Markers, file = "The file") => {
  const starts = count(text, markers.start);
  const ends = count(text, markers.end);
  if (starts === 0 && ends === 0) return;
  if (starts !== 1 || ends !== 1 || text.indexOf(markers.end) < text.indexOf(markers.start)) {
    throw new UnbalancedMarkersError(
      `${file} has unbalanced LogicPacks markers (${starts} start, ${ends} end). Fix or remove them by hand; nothing was changed.`,
    );
  }
};

export const hasMarkedBlock = (text: string, markers: Markers) => {
  const start = text.indexOf(markers.start);
  return start >= 0 && text.indexOf(markers.end, start) >= 0;
};

/** Files LogicPacks created from nothing, so uninstall deletes them rather than leaving them empty. */
export interface CreatedFiles {
  readonly has: (file: string) => boolean;
  readonly add: (file: string) => void;
  readonly remove: (file: string) => void;
}

export type WriteOutcome = "added" | "updated" | "unchanged" | "removed" | "absent";

/** Puts (`body`) or takes out (`null`) the block in `file`. */
export const writeBlockFile = (
  file: string,
  body: string | null,
  markers: Markers,
  created: CreatedFiles,
): WriteOutcome => {
  const before = readPlanned(file);
  if (before === null) {
    if (body === null) return "absent";
    commitFile(file, withMarkedBlock("", body, markers));
    created.add(file);
    return "added";
  }
  assertBalanced(before, markers, file);
  const had = hasMarkedBlock(before, markers);
  const after = withMarkedBlock(before, body, markers);
  if (after === before) return body === null ? "absent" : "unchanged";
  if (body === null && after === "" && created.has(file)) {
    commitFile(file, null);
    created.remove(file);
    return "removed";
  }
  commitFile(file, after);
  if (body === null) return "removed";
  return had ? "updated" : "added";
};

/** The first line of a file LogicPacks owns outright; we never delete a file without it. */
export const OWN_FILE_MARK =
  "<!-- logicpacks: this file is managed by `lp setup`; lp uninstall removes it -->";

export const ownFileText = (body: string, frontmatter = "") =>
  `${frontmatter}${OWN_FILE_MARK}\n${body}\n`;

/** Writes or removes a rules file of our own (Cline, Roo, Kiro, Cursor .mdc). */
export const writeOwnFile = (file: string, text: string | null): WriteOutcome => {
  const current = readPlanned(file);
  if (text === null) {
    if (current === null) return "absent";
    if (!current.includes(OWN_FILE_MARK)) {
      throw new Error(`${file} was not written by LogicPacks; left it unchanged.`);
    }
    commitFile(file, null);
    return "removed";
  }
  if (current !== null) {
    if (!current.includes(OWN_FILE_MARK)) {
      throw new Error(`${file} already exists and is not LogicPacks'; left it unchanged.`);
    }
    if (current === text) return "unchanged";
    commitFile(file, text);
    return "updated";
  }
  commitFile(file, text);
  return "added";
};

/**
 * Aider: a marked `read:` entry in ~/.aider.conf.yml. When the file already has a top-level
 * `read:` key we cannot add a second one, so we refuse and say what to add by hand.
 */
export const withYamlRead = (text: string, rulesFile: string | null) => {
  if (rulesFile === null) return withMarkedBlock(text, null, YAML_MARKERS);
  const withoutOurs = withMarkedBlock(text, null, YAML_MARKERS);
  if (/^read\s*:/m.test(withoutOurs)) {
    throw new Error(
      `It already has a read: list. Add ${JSON.stringify(rulesFile)} to it yourself.`,
    );
  }
  return withMarkedBlock(text, `read: [${JSON.stringify(rulesFile)}]`, YAML_MARKERS);
};
