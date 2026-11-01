// oxlint-disable logicpacks/no-global-process-runtime -- plain Node CLI shipped as one file; there is no Effect runtime to inject.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { globalBlockBody } from "./connectText.ts";
import {
  type CreatedFiles,
  MARKDOWN_MARKERS,
  ownFileText,
  withYamlRead,
  writeBlockFile,
  writeOwnFile,
  type WriteOutcome,
  YAML_MARKERS,
} from "./globalBlock.ts";
import { commitFile, isDryRun, readPlanned } from "./fileOps.ts";
import { findHarness, type Harness, type Platform, resolveOsPath } from "./harnesses.ts";
import { helperHome, writeJson } from "./store.ts";

/**
 * `lp setup --agent <id>`: writes the block into the one file that harness reads, and
 * remembers it so `lp uninstall` takes back exactly what was written. Nothing outside
 * the chosen target is touched.
 */

export type TargetKind = "block" | "file" | "yaml-read";

export interface SetupRecord {
  readonly harness: string;
  readonly kind: TargetKind;
  readonly file: string;
  /** For yaml-read: the rules file the config points at. */
  readonly rulesFile?: string;
}

interface SetupState {
  records: Array<SetupRecord>;
  created: Array<string>;
}

const stateFile = () => NodePath.join(helperHome(), "setup.json");

export const loadSetupState = (): SetupState => {
  try {
    const parsed = JSON.parse(NodeFS.readFileSync(stateFile(), "utf8")) as Partial<SetupState>;
    return { records: parsed.records ?? [], created: parsed.created ?? [] };
  } catch {
    return { records: [], created: [] };
  }
};

const saveSetupState = (state: SetupState) => {
  if (!isDryRun()) writeJson(stateFile(), state);
};

const isInside = (folder: string, path: string) => {
  const relative = NodePath.relative(folder, path);
  return relative.length > 0 && !relative.startsWith("..") && !NodePath.isAbsolute(relative);
};

/**
 * `--file` must not be an instructions file in a folder above this one (say /Users/me/.claude/
 * CLAUDE.md when the project lives under /Users/me): an agent sees those files as project
 * memory and may pick one by mistake. Only the resolved global path or a file in or under
 * the working folder (or outside its parents) is written.
 */
export const checkExplicitFile = (file: string, cwd: string, allowed: ReadonlyArray<string>) => {
  if (allowed.includes(file)) return;
  let folder = NodePath.dirname(file);
  // ~/.claude/CLAUDE.md belongs to the folder that holds .claude.
  if (NodePath.basename(folder).startsWith(".")) folder = NodePath.dirname(folder);
  if (isInside(folder, cwd)) {
    throw new Error(
      `Refusing to write ${file}: it is an instructions file in a folder above ${cwd}, not this harness's global file${allowed[0] ? ` (${allowed[0]})` : ""}. Run lp setup --agent <id> without --file.`,
    );
  }
};

const createdOf = (state: SetupState): CreatedFiles => ({
  has: (file) => state.created.includes(file),
  add: (file) => {
    if (!state.created.includes(file)) state.created.push(file);
  },
  remove: (file) => {
    state.created = state.created.filter((entry) => entry !== file);
  },
});

const remember = (state: SetupState, record: SetupRecord) => {
  state.records = state.records.filter((entry) => entry.file !== record.file);
  state.records.push(record);
};

export interface SetupOptions {
  readonly agent: string;
  /** An explicit file; for `generic` and for anyone whose harness reads another file. */
  readonly file?: string | null;
  /** Also write the project-level file in `cwd`. */
  readonly project?: boolean;
  readonly cwd: string;
  readonly home?: string;
  readonly platform?: Platform;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface SetupResult {
  readonly harness: Harness;
  readonly changes: ReadonlyArray<{ readonly file: string; readonly outcome: WriteOutcome }>;
  /** Steps a person must do in a settings UI. */
  readonly steps: ReadonlyArray<string>;
}

const describeOutcome: Record<WriteOutcome, string> = {
  added: "added the LogicPacks block to",
  updated: "updated the LogicPacks block in",
  unchanged: "already up to date:",
  removed: "removed the LogicPacks block from",
  absent: "nothing to remove in",
};

export const outcomeLine = (change: { file: string; outcome: WriteOutcome }) =>
  `${describeOutcome[change.outcome]} ${change.file}`;

const writeBlock = (state: SetupState, harnessId: string, file: string) => {
  const outcome = writeBlockFile(file, globalBlockBody(), MARKDOWN_MARKERS, createdOf(state));
  remember(state, { harness: harnessId, kind: "block", file });
  return { file, outcome };
};

const writeFile = (state: SetupState, harnessId: string, file: string, frontmatter?: string) => {
  const outcome = writeOwnFile(file, ownFileText(globalBlockBody(), frontmatter));
  remember(state, { harness: harnessId, kind: "file", file });
  return { file, outcome };
};

export const runSetup = (options: SetupOptions): SetupResult => {
  const harness = findHarness(options.agent);
  if (harness === null) {
    throw new Error(
      `Unknown agent "${options.agent}". Run lp setup --list for the ids, or use --agent generic --file <path>.`,
    );
  }
  const env = options.env ?? process.env;
  const resolveOptions = {
    platform: options.platform ?? (process.platform as Platform),
    home: options.home ?? NodeOS.homedir(),
    env,
  };
  const state = loadSetupState();
  const changes: Array<{ file: string; outcome: WriteOutcome }> = [];
  let steps: ReadonlyArray<string> = [];
  let wroteProject = false;

  const writeProject = () => {
    if (harness.project === null || wroteProject) return;
    wroteProject = true;
    const file = NodePath.join(options.cwd, harness.project.path);
    changes.push(
      harness.project.kind === "file"
        ? writeFile(state, harness.id, file, harness.project.frontmatter)
        : writeBlock(state, harness.id, file),
    );
  };

  try {
    if (options.file) {
      const file = NodePath.resolve(options.cwd, options.file);
      const allowed: Array<string> = [];
      if (harness.global.kind === "block" || harness.global.kind === "file") {
        allowed.push(resolveOsPath(harness.global.path, resolveOptions));
      }
      if (harness.project !== null) allowed.push(NodePath.join(options.cwd, harness.project.path));
      checkExplicitFile(file, options.cwd, allowed);
      changes.push(writeBlock(state, harness.id, file));
    } else {
      const target = harness.global;
      switch (target.kind) {
        case "block":
          changes.push(writeBlock(state, harness.id, resolveOsPath(target.path, resolveOptions)));
          break;
        case "file":
          changes.push(
            writeFile(
              state,
              harness.id,
              resolveOsPath(target.path, resolveOptions),
              target.frontmatter,
            ),
          );
          break;
        case "yaml-read": {
          const rules = resolveOsPath(target.rules, resolveOptions);
          const config = resolveOsPath(target.config, resolveOptions);
          changes.push({
            file: rules,
            outcome: writeOwnFile(rules, ownFileText(globalBlockBody())),
          });
          const current = readPlanned(config);
          const exists = current !== null;
          const before = current ?? "";
          let after: string;
          try {
            after = withYamlRead(before, rules);
          } catch (error) {
            throw new Error(`${config}: ${(error as Error).message}`, { cause: error });
          }
          if (after !== before) {
            commitFile(config, after);
            if (!exists) createdOf(state).add(config);
          }
          remember(state, {
            harness: harness.id,
            kind: "yaml-read",
            file: config,
            rulesFile: rules,
          });
          changes.push({
            file: config,
            outcome:
              after === before
                ? "unchanged"
                : before.includes(YAML_MARKERS.start)
                  ? "updated"
                  : "added",
          });
          break;
        }
        case "ui":
          steps = target.steps;
          // No global file: the project file carries the block instead.
          writeProject();
          break;
      }
    }
    if (options.project) writeProject();
  } finally {
    saveSetupState(state);
  }
  return { harness, changes, steps };
};

/** Takes back every block and rules file `lp setup` wrote (or only `agent`'s). */
export const runUninstall = (agent: string | null = null) => {
  const state = loadSetupState();
  const created = createdOf(state);
  const lines: Array<string> = [];
  const harnessId = agent === null ? null : (findHarness(agent)?.id ?? agent);
  const keep: Array<SetupRecord> = [];
  for (const record of state.records) {
    if (harnessId !== null && record.harness !== harnessId) {
      keep.push(record);
      continue;
    }
    try {
      switch (record.kind) {
        case "block":
          lines.push(
            outcomeLine({
              file: record.file,
              outcome: writeBlockFile(record.file, null, MARKDOWN_MARKERS, created),
            }),
          );
          break;
        case "file":
          lines.push(outcomeLine({ file: record.file, outcome: writeOwnFile(record.file, null) }));
          break;
        case "yaml-read": {
          const before = readPlanned(record.file);
          if (before !== null) {
            const after = withYamlRead(before, null);
            if (after === "" && created.has(record.file)) {
              commitFile(record.file, null);
              created.remove(record.file);
            } else if (after !== before) {
              commitFile(record.file, after);
            }
            lines.push(
              outcomeLine({ file: record.file, outcome: after === before ? "absent" : "removed" }),
            );
          }
          if (record.rulesFile) {
            lines.push(
              outcomeLine({
                file: record.rulesFile,
                outcome: writeOwnFile(record.rulesFile, null),
              }),
            );
          }
          break;
        }
      }
    } catch (error) {
      lines.push((error as Error).message);
      keep.push(record);
    }
  }
  state.records = keep;
  saveSetupState(state);
  return lines;
};
