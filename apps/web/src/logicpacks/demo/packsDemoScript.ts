/**
 * The /demo/packs script: a lab turns its work into a pack instead of fine-tuning. Every
 * value is a pure function of the playhead `t` (ms), so scrubbing and recordings agree.
 * Field names follow RecipeContext in packages/contracts/src/recipe.ts.
 */
import { formatDemoTime } from "./machineDemoScript";

export { formatDemoTime };

export const PACKS_DEMO_DURATION_MS = 64_000;

export const PACK_NAME = "kestrel-house-style";
export const PACK_PROJECT = "Assay Pipeline";

export type PacksStage = "pitch" | "build" | "plug" | "compare" | "versions" | "pulls" | "close";

export interface PacksChapter {
  readonly t: number;
  readonly stage: PacksStage;
  readonly label: string;
}

export const PACKS_CHAPTERS: readonly PacksChapter[] = [
  { t: 0, stage: "pitch", label: "The idea" },
  { t: 5_000, stage: "build", label: "Build the pack" },
  { t: 19_000, stage: "plug", label: "Plug in" },
  { t: 30_000, stage: "compare", label: "Same prompt" },
  { t: 43_000, stage: "versions", label: "v1 to v2" },
  { t: 52_000, stage: "pulls", label: "Who pulled what" },
  { t: 59_000, stage: "close", label: "No training run" },
];

const lastAtOrBefore = <T extends { t: number }>(items: readonly T[], t: number): T =>
  items.reduce((found, item) => (item.t <= t ? item : found), items[0]!);

export const packsChapterAt = (t: number): PacksChapter => lastAtOrBefore(PACKS_CHAPTERS, t);
export const packsStageAt = (t: number): PacksStage => packsChapterAt(t).stage;

const streamed = <T extends { t: number; text: string; ms?: number }>(line: T, t: number) => {
  const duration = line.ms ?? 700;
  const progress = Math.min(1, Math.max(0, (t - line.t) / duration));
  return {
    shown: line.text.slice(0, Math.round(line.text.length * progress)),
    streaming: progress < 1,
  };
};

// ── The pack, built from real work ─────────────────────────────────────────

export type PackEntryKind = "decision" | "style" | "preference" | "domain" | "memory" | "example";
export type ContextField = "summary" | "decisions" | "references" | "steps";

export interface PackEntry {
  readonly id: string;
  readonly t: number;
  readonly kind: PackEntryKind;
  /** Where it lands in the pack's `context`. */
  readonly field: ContextField;
  readonly text: string;
  readonly by: string;
  /** Where it came from in the project's history. */
  readonly from: string;
}

export const PACK_ENTRY_LABEL: Record<PackEntryKind, string> = {
  decision: "Decision",
  style: "Style",
  preference: "Preference",
  domain: "Domain knowledge",
  memory: "Memory",
  example: "Example",
};

export const PACK_ENTRIES: readonly PackEntry[] = [
  {
    id: "polars",
    t: 6_000,
    kind: "decision",
    field: "decisions",
    text: "Use Polars, not pandas, for new pipelines.",
    by: "Ana",
    from: "thread: Speed up the plate loader",
  },
  {
    id: "tables",
    t: 7_600,
    kind: "style",
    field: "decisions",
    text: "Short sentences. Tables before prose.",
    by: "Omar",
    from: "review comments on 14 reports",
  },
  {
    id: "units",
    t: 9_200,
    kind: "preference",
    field: "decisions",
    text: "Metric units. Always cite the dataset version.",
    by: "Ana",
    from: "thread: Fix the units mixup",
  },
  {
    id: "triplicate",
    t: 10_800,
    kind: "domain",
    field: "summary",
    text: "Assays run in triplicate. Flag CV above 15%.",
    by: "Mira",
    from: "lab handbook, section 3",
  },
  {
    id: "reader-b",
    t: 12_400,
    kind: "memory",
    field: "references",
    text: "Plate reader B drifts after 40 min. Re-zero before long runs.",
    by: "Omar",
    from: "thread: Why is plate 7 off",
  },
  {
    id: "weekly-report",
    t: 14_000,
    kind: "example",
    field: "references",
    text: "weekly-report-2026-10-24.md",
    by: "Mira",
    from: "the report the team liked most",
  },
  {
    id: "summarise-step",
    t: 15_600,
    kind: "example",
    field: "steps",
    text: "Summarise a plate run",
    by: "Ana",
    from: "the prompt used 31 times last month",
  },
];

export const BUILD_START_MS = PACK_ENTRIES[0]!.t;
export const BUILD_DONE_MS = 17_200;

/** Entries captured so far, newest last, each streaming in. */
export function packEntriesAt(t: number) {
  return PACK_ENTRIES.filter((entry) => entry.t <= t).map((entry) => ({
    ...entry,
    ...streamed({ ...entry, ms: 900 }, t),
  }));
}

/** The pack.json the build writes, revealed line by line as entries land. */
export const PACK_JSON_V1: readonly string[] = [
  "{",
  '  "formatVersion": "recipe/1",',
  `  "id": "${PACK_NAME}",`,
  '  "name": "Kestrel house style",',
  '  "summary": "How Kestrel Lab writes, decides and reports.",',
  '  "context": {',
  '    "source": {',
  `      "projectTitle": "${PACK_PROJECT}",`,
  '      "recipe": "code",',
  '      "savedBy": "Ana",',
  '      "savedAt": "2026-10-24T17:02:00Z"',
  "    },",
  '    "summary": "Assays run in triplicate. Flag CV above 15%.",',
  '    "decisions": [',
  '      { "text": "Use Polars, not pandas, for new pipelines.", "by": "Ana" },',
  '      { "text": "Short sentences. Tables before prose.", "by": "Omar" },',
  '      { "text": "Metric units. Always cite the dataset version.", "by": "Ana" }',
  "    ],",
  '    "references": [',
  '      { "kind": "note", "app": "lab", "name": "Plate reader B drift" },',
  '      { "kind": "file", "app": "repo", "name": "weekly-report-2026-10-24.md" }',
  "    ],",
  '    "steps": [{ "title": "Summarise a plate run" }]',
  "  }",
  "}",
];

/** How many lines of pack.json exist at `t`: the header first, then it fills with the build. */
export function packJsonLinesAt(t: number): number {
  const header = 6;
  if (t < BUILD_START_MS) return 0;
  if (t >= BUILD_DONE_MS) return PACK_JSON_V1.length;
  const progress = (t - BUILD_START_MS) / (BUILD_DONE_MS - BUILD_START_MS);
  return header + Math.round((PACK_JSON_V1.length - header) * progress);
}

// ── Plugging the pack into four agents ─────────────────────────────────────

export type PacksAgentKind = "claude" | "codex" | "opencode" | "gemini";
export const PACKS_AGENTS: readonly PacksAgentKind[] = ["claude", "codex", "opencode", "gemini"];
export const PACKS_AGENT_LABEL: Record<PacksAgentKind, string> = {
  claude: "Claude",
  codex: "Codex",
  opencode: "OpenCode",
  gemini: "Gemini",
};

/** When each agent gets the pack. Loading takes PLUG_LOAD_MS; there is no training run. */
export const PLUG_AT_MS: Record<PacksAgentKind, number> = {
  claude: 20_000,
  codex: 22_000,
  opencode: 24_000,
  gemini: 26_000,
};
export const PLUG_LOAD_MS = 1_200;

export type AgentPackState = "plain" | "loading" | "tuned";

export function agentStateAt(agent: PacksAgentKind, t: number): AgentPackState {
  const at = PLUG_AT_MS[agent];
  if (t < at) return "plain";
  return t < at + PLUG_LOAD_MS ? "loading" : "tuned";
}

/** The pack version an agent runs at `t`: everyone moves to v2 once it is published. */
export function agentPackVersionAt(agent: PacksAgentKind, t: number): 0 | 1 | 2 {
  if (agentStateAt(agent, t) !== "tuned") return 0;
  return t >= V2_ROLLOUT_MS[agent] ? 2 : 1;
}

export interface PacksTurnLine {
  readonly t: number;
  readonly agent: PacksAgentKind;
  readonly kind: "prompt" | "reply" | "tool";
  readonly text: string;
  readonly ms?: number;
}

export const PACKS_TURN_LINES: readonly PacksTurnLine[] = [
  { t: 20_000, agent: "claude", kind: "tool", text: `pack.load ${PACK_NAME}@1` },
  { t: 21_200, agent: "claude", kind: "reply", text: "Tuned in 0.4s. 7 entries, 2.1k tokens." },
  { t: 22_000, agent: "codex", kind: "tool", text: `pack.load ${PACK_NAME}@1` },
  { t: 23_200, agent: "codex", kind: "reply", text: "Tuned in 0.3s. No training run." },
  { t: 24_000, agent: "opencode", kind: "tool", text: `pack.load ${PACK_NAME}@1` },
  { t: 25_200, agent: "opencode", kind: "reply", text: "Tuned in 0.4s. Same pack, same rules." },
  { t: 26_000, agent: "gemini", kind: "tool", text: `pack.load ${PACK_NAME}@1` },
  { t: 27_200, agent: "gemini", kind: "reply", text: "Tuned in 0.5s. Ready." },
  { t: 31_000, agent: "claude", kind: "prompt", text: "Summarise this week's plate run." },
  { t: 34_000, agent: "claude", kind: "tool", text: "context: summary, decisions[3], steps[1]" },
  { t: 45_500, agent: "codex", kind: "tool", text: `pack.update ${PACK_NAME}@2`, ms: 500 },
  { t: 46_200, agent: "claude", kind: "tool", text: `pack.update ${PACK_NAME}@2`, ms: 500 },
  { t: 46_900, agent: "opencode", kind: "tool", text: `pack.update ${PACK_NAME}@2`, ms: 500 },
  { t: 47_600, agent: "gemini", kind: "tool", text: `pack.update ${PACK_NAME}@2`, ms: 500 },
  { t: 48_400, agent: "codex", kind: "reply", text: "Now reporting CV to one decimal." },
  { t: 53_000, agent: "claude", kind: "tool", text: "pulled 5 of 8 entries, 1.9k tokens" },
  { t: 53_800, agent: "codex", kind: "tool", text: "pulled 4 of 8 entries, 0.6k tokens" },
  { t: 54_600, agent: "opencode", kind: "tool", text: "pulled 3 of 8 entries, 0.8k tokens" },
  { t: 55_400, agent: "gemini", kind: "tool", text: "pulled 8 of 8 entries, 2.4k tokens" },
];

/** One agent's lines up to `t`, newest last. */
export function packsTurnsFor(agent: PacksAgentKind, t: number, limit = 3) {
  return PACKS_TURN_LINES.filter((line) => line.t <= t && line.agent === agent)
    .slice(-limit)
    .map((line) => ({ ...line, ...streamed(line, t) }));
}

// ── Same prompt, without and with the pack ─────────────────────────────────

export const COMPARE_PROMPT = "Summarise this week's plate run.";
export const COMPARE_PROMPT_MS = 31_000;

export interface CompareAnswer {
  readonly t: number;
  readonly ms: number;
  readonly lines: readonly string[];
}

export const GENERIC_ANSWER: CompareAnswer = {
  t: 32_500,
  ms: 4_000,
  lines: [
    "Great question! Here is a summary of your data.",
    "Overall the results look promising, with some variability",
    "between plates. You may want to consider running more",
    "replicates and using pandas to explore the data further.",
  ],
};

export const PACKED_ANSWER: CompareAnswer = {
  t: 34_500,
  ms: 5_500,
  lines: [
    "Plate run 2026-W44, dataset v3.2",
    "| Plate | Mean (µM) | CV    |",
    "| 1     | 4.12      | 6.1%  |",
    "| 3     | 3.87      | 18.2% |",
    "| 5     | 4.05      | 7.4%  |",
    "Plate 3 is above 15% CV. Re-run it in triplicate.",
    "Reader B ran 52 min. Re-zero it first.",
  ],
};

/** Lines of an answer revealed at `t`, the last one possibly mid-stream. */
export function answerAt(answer: CompareAnswer, t: number) {
  const total = answer.lines.join("\n");
  const { shown, streaming } = streamed({ t: answer.t, text: total, ms: answer.ms }, t);
  return { lines: shown.length === 0 ? [] : shown.split("\n"), streaming };
}

/** Which pack rules the packed answer visibly follows, ticked off as they show. */
export const ANSWER_CHECKS: readonly {
  readonly t: number;
  readonly entryId: string;
  readonly text: string;
}[] = [
  { t: 36_000, entryId: "tables", text: "Table before prose" },
  { t: 36_800, entryId: "units", text: "Units and dataset version" },
  { t: 38_400, entryId: "triplicate", text: "CV above 15% flagged" },
  { t: 39_600, entryId: "reader-b", text: "Reader B drift remembered" },
];

export const answerChecksAt = (t: number) => ANSWER_CHECKS.filter((check) => check.t <= t);

// ── Versions: v1 to v2 ─────────────────────────────────────────────────────

export const V2_PUBLISHED_MS = 45_000;
export const V2_ROLLOUT_MS: Record<PacksAgentKind, number> = {
  codex: 45_500,
  claude: 46_200,
  opencode: 46_900,
  gemini: 47_600,
};

export interface PackDiffLine {
  readonly t: number;
  readonly op: "+" | "-" | "~";
  readonly field: ContextField;
  readonly text: string;
  readonly why: string;
}

export const PACK_DIFF: readonly PackDiffLine[] = [
  {
    t: 43_600,
    op: "+",
    field: "decisions",
    text: "Report CV to one decimal place.",
    why: "Omar, review of W44",
  },
  {
    t: 44_200,
    op: "~",
    field: "summary",
    text: "Flag CV above 15%, or 12% for cell lines.",
    why: "Mira, new cell assay",
  },
  {
    t: 44_800,
    op: "-",
    field: "references",
    text: "Plate reader B drift",
    why: "reader replaced 10-28",
  },
  {
    t: 45_400,
    op: "+",
    field: "references",
    text: "weekly-report-2026-10-31.md",
    why: "newer example",
  },
];

export const packDiffAt = (t: number) => PACK_DIFF.filter((line) => line.t <= t);

/** The pack version the outliner shows at `t`. */
export const packVersionAt = (t: number): 1 | 2 => (t >= V2_PUBLISHED_MS ? 2 : 1);

/** Count of each context field, after the diff has applied as far as `t`. */
export function contextCountsAt(t: number): Record<ContextField, number> {
  const counts: Record<ContextField, number> = {
    summary: 0,
    decisions: 0,
    references: 0,
    steps: 0,
  };
  for (const entry of PACK_ENTRIES) if (entry.t <= t) counts[entry.field] += 1;
  for (const line of packDiffAt(t)) {
    if (line.op === "+") counts[line.field] += 1;
    if (line.op === "-") counts[line.field] -= 1;
  }
  return counts;
}

// ── Who pulled what, and personal layers ───────────────────────────────────

export interface AgentPull {
  readonly t: number;
  readonly agent: PacksAgentKind;
  readonly fields: readonly ContextField[];
  readonly entries: number;
  readonly tokens: number;
  readonly task: string;
}

export const PACK_ENTRY_TOTAL_V2 = 8;
export const CONTEXT_BUDGET_TOKENS = 3_000;

export const AGENT_PULLS: readonly AgentPull[] = [
  {
    t: 53_000,
    agent: "claude",
    fields: ["summary", "decisions", "steps"],
    entries: 5,
    tokens: 1_900,
    task: "weekly report",
  },
  {
    t: 53_800,
    agent: "codex",
    fields: ["decisions"],
    entries: 4,
    tokens: 600,
    task: "loader refactor",
  },
  {
    t: 54_600,
    agent: "opencode",
    fields: ["summary", "references"],
    entries: 3,
    tokens: 800,
    task: "QC script",
  },
  {
    t: 55_400,
    agent: "gemini",
    fields: ["summary", "decisions", "references", "steps"],
    entries: 8,
    tokens: 2_400,
    task: "grant draft",
  },
];

export const agentPullsAt = (t: number) => AGENT_PULLS.filter((pull) => pull.t <= t);

export interface PackLayer {
  readonly t: number;
  readonly scope: "team" | "person";
  readonly owner: string;
  readonly text: string;
}

export const PACK_LAYERS: readonly PackLayer[] = [
  { t: 56_200, scope: "team", owner: "Kestrel Lab", text: `${PACK_NAME} v2, everyone` },
  { t: 57_000, scope: "person", owner: "Ana", text: "Terse answers. No preamble." },
  { t: 57_800, scope: "person", owner: "Omar", text: "Explain the statistics step by step." },
];

export const packLayersAt = (t: number) => PACK_LAYERS.filter((layer) => layer.t <= t);

// ── Deep links ─────────────────────────────────────────────────────────────

/** `?t=` in seconds, clamped to this demo, for deep links and recordings. */
export function parsePacksDemoStart(value: unknown): number {
  const seconds = typeof value === "number" ? value : typeof value === "string" ? Number(value) : 0;
  if (!Number.isFinite(seconds)) return 0;
  return Math.min(PACKS_DEMO_DURATION_MS, Math.max(0, seconds * 1_000));
}
