import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { asRecord } from "./events.ts";
import { globalBlockBody } from "./connectText.ts";
import { commitFile, readPlanned } from "./fileOps.ts";
import { assertBalanced, MARKDOWN_MARKERS } from "./globalBlock.ts";
import { claudeHome, codexHome } from "./store.ts";

/**
 * Registers `lp mcp` with Codex and Claude Code, and keeps the LogicPacks
 * rules in a project's AGENTS.md. Every edit touches only what the helper
 * owns: one TOML table, one JSON key, one marked block.
 */

export const MCP_NAME = "logicpacks";

export interface McpLaunch {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

const tomlString = (value: string) => JSON.stringify(value);

const HEADER =
  /^\s*\[\s*mcp_servers\s*\.\s*(?:logicpacks|"logicpacks"|'logicpacks')(\s*\.[^\]]*)?\s*\]\s*(#.*)?$/;
const ANY_HEADER = /^\s*\[/;
const OTHER_FORM =
  /^\s*(?:logicpacks|"logicpacks"|'logicpacks')\s*=|^\s*mcp_servers\s*\.\s*logicpacks\s*[.=]/;

export const codexTable = (launch: McpLaunch) => [
  `[mcp_servers.${MCP_NAME}]`,
  "# Added by the LogicPacks helper (lp install); lp uninstall removes this table.",
  `command = ${tomlString(launch.command)}`,
  `args = [${launch.args.map(tomlString).join(", ")}]`,
];

/** The [start, end) line ranges of our table and its subtables. */
const ownRanges = (lines: ReadonlyArray<string>) => {
  const ranges: Array<[number, number]> = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!HEADER.test(lines[index]!)) continue;
    let end = index + 1;
    while (end < lines.length && !ANY_HEADER.test(lines[end]!)) end += 1;
    // Trailing blank lines belong to whatever follows.
    while (end > index + 1 && lines[end - 1]!.trim() === "") end -= 1;
    ranges.push([index, end]);
    index = end - 1;
  }
  return ranges;
};

/**
 * Adds, updates (`launch`) or removes (`null`) the [mcp_servers.logicpacks]
 * table in Codex's config.toml text. Every other byte stays as it was; adding
 * then removing gives back the original text.
 */
export const withCodexMcp = (text: string, launch: McpLaunch | null): string => {
  const lines = text.split("\n");
  const ranges = ownRanges(lines);
  if (ranges.length === 0) {
    if (lines.some((line) => OTHER_FORM.test(line))) {
      throw new Error(
        "config.toml defines the logicpacks MCP server in another form; left it unchanged.",
      );
    }
    if (launch === null) return text;
    const prefix = text.length === 0 ? "" : text.endsWith("\n") ? "\n" : "\n\n";
    return `${text}${prefix}${codexTable(launch).join("\n")}\n`;
  }
  const next: Array<string> = [];
  let cursor = 0;
  ranges.forEach(([start, end], position) => {
    let keepUntil = start;
    // Removing: take back the blank line that separated our table.
    if (launch === null && keepUntil > cursor && lines[keepUntil - 1]!.trim() === "") {
      keepUntil -= 1;
    }
    next.push(...lines.slice(cursor, keepUntil));
    if (launch !== null && position === 0) next.push(...codexTable(launch));
    cursor = end;
  });
  next.push(...lines.slice(cursor));
  return next.join("\n");
};

export const codexConfigFile = () => NodePath.join(codexHome(), "config.toml");

/** Edits Codex's config.toml in place (write-then-rename). Returns the file, or null when nothing changed. */
export const writeCodexMcp = (launch: McpLaunch | null) => {
  const file = codexConfigFile();
  const current = readPlanned(file);
  if (current === null && launch === null) return null;
  const before = current ?? "";
  const after = withCodexMcp(before, launch);
  if (after === before) return null;
  commitFile(file, after, 0o600);
  return file;
};

export const codexMcpInstalled = () => {
  try {
    return ownRanges(NodeFS.readFileSync(codexConfigFile(), "utf8").split("\n")).length > 0;
  } catch {
    return false;
  }
};

/** Claude Code keeps user-scope MCP servers in ~/.claude.json (or $CLAUDE_CONFIG_DIR/.claude.json). */
export const claudeUserConfigFile = () =>
  process.env.CLAUDE_CONFIG_DIR
    ? NodePath.join(claudeHome(), ".claude.json")
    : NodePath.join(NodeOS.homedir(), ".claude.json");

export const withClaudeMcp = (settings: Record<string, unknown>, launch: McpLaunch | null) => {
  const servers = { ...asRecord(settings.mcpServers) };
  if (launch === null) delete servers[MCP_NAME];
  else
    servers[MCP_NAME] = { type: "stdio", command: launch.command, args: [...launch.args], env: {} };
  const next = { ...settings };
  if (Object.keys(servers).length > 0) next.mcpServers = servers;
  else delete next.mcpServers;
  return next;
};

/** Adds or removes the user-scope `logicpacks` MCP server. Refuses a file it cannot parse. */
export const writeClaudeMcp = (launch: McpLaunch | null) => {
  const file = claudeUserConfigFile();
  const before = readPlanned(file);
  if (before === null) {
    if (launch === null) return null;
    commitFile(file, `${JSON.stringify(withClaudeMcp({}, launch), null, 2)}\n`, 0o600);
    return file;
  }
  const parsed = asRecord(JSON.parse(before));
  if (parsed === null) throw new Error(`${file} is not a JSON object; left it unchanged.`);
  const had = asRecord(parsed.mcpServers)?.[MCP_NAME] !== undefined;
  if (launch === null && !had) return null;
  const after = `${JSON.stringify(withClaudeMcp(parsed, launch), null, 2)}\n`;
  return commitFile(file, after) ? file : null;
};

export const AGENTS_START = "<!-- logicpacks:start -->";
export const AGENTS_END = "<!-- logicpacks:end -->";

/**
 * The project AGENTS.md block `lp link` keeps: the same intents-to-commands block as an
 * agent's global instructions (connectText.ts), named for the project, plus the MCP tools.
 */
export const agentsBlockBody = (projectTitle: string | null) =>
  [
    globalBlockBody(projectTitle),
    "- With the `logicpacks` MCP tools: `who_is_working_on` before you start, `send_to_thread` / `ask` / `reply` to talk to other threads, `conflicts` and `propose_merge` on a conflict, `note` for your goal and decisions.",
    '- When your user asks teammates to do work ("ask Omar to do X by Friday"), draft it with `goal_plan`; your user confirms it in LogicPacks. If a milestone is assigned to you, stay inside its scope and report with `goal_update`.',
    "",
    "LogicPacks keeps only the text between these markers up to date; edit anything outside them freely.",
  ].join("\n");

/** Writes (`body`) or removes (`null`) the marked block, leaving the rest of the file untouched. */
export const withAgentsBlock = (text: string, body: string | null) => {
  assertBalanced(text, MARKDOWN_MARKERS, "AGENTS.md");
  const start = text.indexOf(AGENTS_START);
  const end = start < 0 ? -1 : text.indexOf(AGENTS_END, start);
  if (start >= 0 && end >= 0) {
    const tail = end + AGENTS_END.length;
    if (body !== null) return `${text.slice(0, start)}${AGENTS_START}\n${body}\n${text.slice(end)}`;
    // Removing: drop the block, the newline after it and the blank line we put before it.
    let from = start;
    let to = tail;
    if (text[to] === "\n") to += 1;
    if (from >= 2 && text.slice(from - 2, from) === "\n\n") from -= 1;
    const result = `${text.slice(0, from)}${text.slice(to)}`;
    return result.trim() === "" ? "" : result;
  }
  if (body === null) return text;
  const block = `${AGENTS_START}\n${body}\n${AGENTS_END}\n`;
  if (text.length === 0) return block;
  return `${text}${text.endsWith("\n") ? "\n" : "\n\n"}${block}`;
};

/** Keeps `<folder>/AGENTS.md` in step. Returns the file when it changed. */
export const writeAgentsBlock = (folder: string, body: string | null) => {
  const file = NodePath.join(folder, "AGENTS.md");
  const current = readPlanned(file);
  if (current === null && body === null) return null;
  const before = current ?? "";
  const after = withAgentsBlock(before, body);
  if (after === before) return null;
  commitFile(file, after === "" && body === null ? null : after);
  return file;
};
