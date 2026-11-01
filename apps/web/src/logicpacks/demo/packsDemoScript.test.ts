import { describe, expect, it } from "vite-plus/test";

import {
  AGENT_PULLS,
  ANSWER_CHECKS,
  BUILD_DONE_MS,
  COMPARE_PROMPT_MS,
  CONTEXT_BUDGET_TOKENS,
  GENERIC_ANSWER,
  PACK_DIFF,
  PACK_ENTRIES,
  PACK_ENTRY_TOTAL_V2,
  PACK_JSON_V1,
  PACK_LAYERS,
  PACKED_ANSWER,
  PACKS_AGENTS,
  PACKS_CHAPTERS,
  PACKS_DEMO_DURATION_MS,
  PACKS_TURN_LINES,
  PLUG_AT_MS,
  PLUG_LOAD_MS,
  V2_PUBLISHED_MS,
  V2_ROLLOUT_MS,
  agentPackVersionAt,
  agentStateAt,
  answerAt,
  contextCountsAt,
  packEntriesAt,
  packJsonLinesAt,
  packsChapterAt,
  packsStageAt,
  packsTurnsFor,
  packVersionAt,
  parsePacksDemoStart,
} from "./packsDemoScript";

const chapterEnd = (stage: string) => {
  const index = PACKS_CHAPTERS.findIndex((chapter) => chapter.stage === stage);
  return PACKS_CHAPTERS[index + 1]?.t ?? PACKS_DEMO_DURATION_MS;
};
const chapterStart = (stage: string) =>
  PACKS_CHAPTERS.find((chapter) => chapter.stage === stage)!.t;

const ascending = (values: readonly number[]) =>
  values.every((value, index) => index === 0 || value > values[index - 1]!);

describe("packs demo script", () => {
  it("tells the story in order and fits the runtime", () => {
    expect(PACKS_CHAPTERS.map((chapter) => chapter.stage)).toEqual([
      "pitch",
      "build",
      "plug",
      "compare",
      "versions",
      "pulls",
      "close",
    ]);
    expect(PACKS_CHAPTERS[0]?.t).toBe(0);
    expect(ascending(PACKS_CHAPTERS.map((chapter) => chapter.t))).toBe(true);
    expect(PACKS_CHAPTERS.at(-1)!.t).toBeLessThan(PACKS_DEMO_DURATION_MS);
    // Every chapter lasts long enough to read.
    for (const chapter of PACKS_CHAPTERS) {
      expect(chapterEnd(chapter.stage) - chapter.t, chapter.label).toBeGreaterThanOrEqual(4_000);
    }
    expect(packsStageAt(0)).toBe("pitch");
    expect(packsStageAt(PACKS_DEMO_DURATION_MS)).toBe("close");
    expect(packsChapterAt(25_000).label).toBe("Plug in");
  });

  it("builds the pack from work inside the build chapter, every RecipeContext field covered", () => {
    expect(ascending(PACK_ENTRIES.map((entry) => entry.t))).toBe(true);
    for (const entry of PACK_ENTRIES) {
      expect(entry.t).toBeGreaterThanOrEqual(chapterStart("build"));
      expect(entry.t + 900).toBeLessThanOrEqual(BUILD_DONE_MS);
    }
    expect(BUILD_DONE_MS).toBeLessThanOrEqual(chapterEnd("build"));
    expect(new Set(PACK_ENTRIES.map((entry) => entry.kind))).toEqual(
      new Set(["decision", "style", "preference", "domain", "memory", "example"]),
    );
    expect(new Set(PACK_ENTRIES.map((entry) => entry.field))).toEqual(
      new Set(["summary", "decisions", "references", "steps"]),
    );
    expect(packEntriesAt(chapterStart("build") - 1)).toEqual([]);
    const mid = packEntriesAt(PACK_ENTRIES[0]!.t + 300)[0]!;
    expect(mid.streaming).toBe(true);
    expect(mid.shown.length).toBeLessThan(mid.text.length);
    expect(packEntriesAt(BUILD_DONE_MS).every((entry) => !entry.streaming)).toBe(true);
  });

  it("writes a pack.json in the recipe/1 format with a context section", () => {
    const json = PACK_JSON_V1.join("\n");
    const parsed = JSON.parse(json) as {
      formatVersion: string;
      context: Record<string, unknown>;
    };
    expect(parsed.formatVersion).toBe("recipe/1");
    expect(Object.keys(parsed.context)).toEqual([
      "source",
      "summary",
      "decisions",
      "references",
      "steps",
    ]);
    expect(packJsonLinesAt(0)).toBe(0);
    expect(packJsonLinesAt(BUILD_DONE_MS)).toBe(PACK_JSON_V1.length);
    const counts = [6_000, 9_000, 12_000, 15_000, BUILD_DONE_MS].map(packJsonLinesAt);
    expect(counts.every((count, index) => index === 0 || count >= counts[index - 1]!)).toBe(true);
  });

  it("tunes each agent by loading the pack, one after another, during the plug chapter", () => {
    const plugs = PACKS_AGENTS.map((agent) => PLUG_AT_MS[agent]);
    expect(ascending(plugs)).toBe(true);
    for (const agent of PACKS_AGENTS) {
      const at = PLUG_AT_MS[agent];
      expect(at).toBeGreaterThanOrEqual(chapterStart("plug"));
      expect(at + PLUG_LOAD_MS).toBeLessThanOrEqual(chapterEnd("plug"));
      expect(agentStateAt(agent, at - 1)).toBe("plain");
      expect(agentStateAt(agent, at)).toBe("loading");
      expect(agentStateAt(agent, at + PLUG_LOAD_MS)).toBe("tuned");
      expect(agentPackVersionAt(agent, at - 1)).toBe(0);
      expect(agentPackVersionAt(agent, at + PLUG_LOAD_MS)).toBe(1);
      expect(agentPackVersionAt(agent, PACKS_DEMO_DURATION_MS)).toBe(2);
    }
  });

  it("answers the same prompt twice, generic first, both done before versions", () => {
    expect(COMPARE_PROMPT_MS).toBeGreaterThanOrEqual(chapterStart("compare"));
    expect(GENERIC_ANSWER.t).toBeGreaterThan(COMPARE_PROMPT_MS);
    expect(PACKED_ANSWER.t).toBeGreaterThan(GENERIC_ANSWER.t);
    for (const answer of [GENERIC_ANSWER, PACKED_ANSWER]) {
      expect(answer.t + answer.ms).toBeLessThanOrEqual(chapterEnd("compare"));
      expect(answerAt(answer, answer.t - 1).lines).toEqual([]);
      expect(answerAt(answer, answer.t + answer.ms)).toEqual({
        lines: answer.lines,
        streaming: false,
      });
    }
    expect(ascending(ANSWER_CHECKS.map((check) => check.t))).toBe(true);
    const entryIds = new Set(PACK_ENTRIES.map((entry) => entry.id));
    for (const check of ANSWER_CHECKS) {
      expect(entryIds.has(check.entryId)).toBe(true);
      expect(check.t).toBeLessThan(chapterEnd("compare"));
    }
  });

  it("diffs v1 to v2 and rolls every agent onto v2", () => {
    expect(ascending(PACK_DIFF.map((line) => line.t))).toBe(true);
    for (const line of PACK_DIFF) expect(line.t).toBeGreaterThanOrEqual(chapterStart("versions"));
    expect(packVersionAt(V2_PUBLISHED_MS - 1)).toBe(1);
    expect(packVersionAt(V2_PUBLISHED_MS)).toBe(2);
    for (const agent of PACKS_AGENTS) {
      expect(V2_ROLLOUT_MS[agent]).toBeGreaterThanOrEqual(V2_PUBLISHED_MS);
      expect(V2_ROLLOUT_MS[agent]).toBeLessThan(chapterEnd("versions"));
    }
    const before = contextCountsAt(chapterStart("versions") - 1);
    const after = contextCountsAt(PACKS_DEMO_DURATION_MS);
    expect(before).toEqual({ summary: 1, decisions: 3, references: 2, steps: 1 });
    expect(after).toEqual({ summary: 1, decisions: 4, references: 2, steps: 1 });
    const total = Object.values(after).reduce((sum, count) => sum + count, 0);
    expect(total).toBe(PACK_ENTRY_TOTAL_V2);
  });

  it("shows what each agent pulled within budget, then personal layers", () => {
    expect(AGENT_PULLS.map((pull) => pull.agent)).toEqual([...PACKS_AGENTS]);
    expect(ascending(AGENT_PULLS.map((pull) => pull.t))).toBe(true);
    for (const pull of AGENT_PULLS) {
      expect(pull.t).toBeGreaterThanOrEqual(chapterStart("pulls"));
      expect(pull.tokens).toBeLessThanOrEqual(CONTEXT_BUDGET_TOKENS);
      expect(pull.entries).toBeLessThanOrEqual(PACK_ENTRY_TOTAL_V2);
    }
    expect(ascending(PACK_LAYERS.map((layer) => layer.t))).toBe(true);
    expect(PACK_LAYERS[0]?.scope).toBe("team");
    expect(PACK_LAYERS.at(-1)!.t).toBeLessThan(chapterEnd("pulls"));
  });

  it("streams agent turns in time order and keeps only the latest", () => {
    expect(ascending(PACKS_TURN_LINES.map((line) => line.t))).toBe(true);
    expect(PACKS_TURN_LINES.at(-1)!.t).toBeLessThan(PACKS_DEMO_DURATION_MS);
    expect(packsTurnsFor("claude", PLUG_AT_MS.claude - 1)).toEqual([]);
    const latest = packsTurnsFor("claude", PACKS_DEMO_DURATION_MS, 2);
    expect(latest).toHaveLength(2);
    expect(latest.at(-1)?.text).toContain("pulled");
  });

  it("parses ?t= in seconds and clamps it to the demo", () => {
    expect(parsePacksDemoStart(undefined)).toBe(0);
    expect(parsePacksDemoStart("12")).toBe(12_000);
    expect(parsePacksDemoStart(-5)).toBe(0);
    expect(parsePacksDemoStart(9_999)).toBe(PACKS_DEMO_DURATION_MS);
    expect(parsePacksDemoStart("nope")).toBe(0);
  });

  it("keeps the copy plain: no em dashes, no 'coming soon', no 'enterprise'", () => {
    const copy = JSON.stringify({
      PACK_ENTRIES,
      PACK_JSON_V1,
      PACKS_TURN_LINES,
      GENERIC_ANSWER,
      PACKED_ANSWER,
      PACK_DIFF,
      AGENT_PULLS,
      PACK_LAYERS,
      PACKS_CHAPTERS,
      ANSWER_CHECKS,
    }).toLowerCase();
    expect(copy).not.toContain("—");
    expect(copy).not.toContain("coming soon");
    expect(copy).not.toContain("enterprise");
  });
});
