import { describe, expect, it } from "vite-plus/test";

import {
  CONFLICT_AT_MS,
  CURSOR_TRACKS,
  DEMO_DURATION_MS,
  MERGE_DONE_MS,
  RESOLVED_AT_MS,
  actionLogAt,
  agentMessagesAt,
  codeLinesAt,
  CODE_LINES,
  conflictAt,
  cursorAt,
  focusAppAt,
  parseDemoStart,
  presenceOnItems,
  snapshotAt,
  turnsFor,
  viewFor,
} from "./machineDemoScript";

describe("machine demo script", () => {
  it("walks through the apps in story order", () => {
    expect([0, 22_000, 34_000, 41_000, 58_000, 66_000].map(focusAppAt)).toEqual([
      "blender",
      "resolve",
      "browser",
      "blender",
      "code",
      "blender",
    ]);
    expect(focusAppAt(DEMO_DURATION_MS)).toBe("blender");
  });

  it("swaps to the merged scene only after the merge lands", () => {
    expect(viewFor("blender", MERGE_DONE_MS - 1)).toBe("blender");
    expect(viewFor("blender", MERGE_DONE_MS)).toBe("blenderMerged");
    expect(viewFor("resolve", 27_999)).toBe("resolveEdit");
    expect(viewFor("resolve", 28_000)).toBe("resolveCut");
  });

  it("keeps every cursor path in time order", () => {
    for (const track of Object.values(CURSOR_TRACKS)) {
      const times = track.map((key) => key.t);
      expect(times).toEqual([...times].toSorted((a, b) => a - b));
    }
  });

  it("places cursors deterministically and only in the app they are in", () => {
    const first = cursorAt("miraAgent", "blender", 5_900);
    const again = cursorAt("miraAgent", "blender", 5_900);
    expect(first).toEqual(again);
    // Gliding from the camera row (88,13) toward the key light row (88,21).
    expect(first!.y).toBeGreaterThan(13);
    expect(first!.y).toBeLessThan(21);
    expect(cursorAt("miraAgent", "resolve", 5_900)).toBeNull();
    expect(cursorAt("ana", "blender", 1_000)).toBeNull();
    expect(cursorAt("omarAgent", "resolve", 24_500)).toMatchObject({
      x: 43.6,
      item: "studio_close",
      doing: "trimming clip 2 to 2s",
    });
  });

  it("puts presence avatars on the items people are working on", () => {
    const presence = presenceOnItems("blender", 7_000);
    expect(presence.get("Key_Light")?.map((actor) => actor.id)).toEqual(["miraAgent"]);
    expect(presence.get("Table_Top")?.map((actor) => actor.id)).toEqual(["mira"]);
  });

  it("takes a snapshot, works locally, then merges it back with a conflict on the way", () => {
    expect(snapshotAt(15_000).phase).toBe("none");
    expect(snapshotAt(16_500).phase).toBe("taking");
    expect(snapshotAt(30_000)).toMatchObject({ phase: "local", localOps: 4 });
    expect(snapshotAt(42_500)).toMatchObject({ phase: "merging", replayed: 1 });
    expect(snapshotAt(CONFLICT_AT_MS)).toMatchObject({ phase: "conflict", replayed: 3 });
    expect(snapshotAt(50_000).phase).toBe("resolving");
    expect(snapshotAt(RESOLVED_AT_MS).phase).toBe("merging");
    expect(snapshotAt(MERGE_DONE_MS)).toMatchObject({ phase: "merged", replayed: 6, total: 6 });
  });

  it("has an agent resolve the conflict", () => {
    expect(conflictAt(CONFLICT_AT_MS - 1)).toBeNull();
    expect(conflictAt(CONFLICT_AT_MS)).toMatchObject({ status: "open" });
    const resolving = conflictAt(49_000)!;
    expect(resolving.status).toBe("resolving");
    expect(resolving.streaming).toBe(true);
    expect(resolving.resolution.length).toBeGreaterThan(0);
    expect(conflictAt(RESOLVED_AT_MS)).toMatchObject({ status: "resolved", streaming: false });
    expect(conflictAt(70_000)).toBeNull();
  });

  it("logs live ops and replayed snapshot ops newest first, flagging the conflicting one", () => {
    const log = actionLogAt(47_000, 10);
    expect(log[0]).toMatchObject({ source: "snapshot", conflict: true });
    expect(log.map((entry) => entry.t)).toEqual(
      log.map((entry) => entry.t).toSorted((a, b) => b - a),
    );
    expect(actionLogAt(RESOLVED_AT_MS + 1, 10).some((entry) => entry.conflict)).toBe(false);
    expect(actionLogAt(0)).toEqual([]);
  });

  it("streams agent turns and agent messages", () => {
    const [prompt, reply] = turnsFor("mira", 4_000);
    expect(prompt).toMatchObject({ kind: "prompt", streaming: false });
    expect(reply!.streaming).toBe(true);
    expect(reply!.text.startsWith(reply!.shown)).toBe(true);
    expect(turnsFor("ana", 10_000)).toEqual([]);
    expect(agentMessagesAt(25_000)).toEqual([]);
    expect(agentMessagesAt(40_000).map((message) => message.from)).toEqual([
      "omarAgent",
      "miraAgent",
      "anaAgent",
    ]);
  });

  it("types the render script during the code chapter", () => {
    expect(codeLinesAt(0)).toBe(5);
    expect(codeLinesAt(61_500)).toBeGreaterThan(5);
    expect(codeLinesAt(70_000)).toBe(CODE_LINES.length);
  });

  it("reads ?t= in seconds and clamps it", () => {
    expect(parseDemoStart("12.5")).toBe(12_500);
    expect(parseDemoStart(999)).toBe(DEMO_DURATION_MS);
    expect(parseDemoStart(-3)).toBe(0);
    expect(parseDemoStart("nope")).toBe(0);
    expect(parseDemoStart(undefined)).toBe(0);
  });
});
