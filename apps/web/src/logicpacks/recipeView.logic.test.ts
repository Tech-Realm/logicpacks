import { describe, expect, it } from "vite-plus/test";

import type { LpRecipeViewItem } from "./api";
import { actorLabel, outlineRows, recentEdits, shortAge, viewWidth } from "./recipeView.logic";

const item = (
  id: string,
  name: string,
  parent: string | null = null,
  last: LpRecipeViewItem["last"] = null,
): LpRecipeViewItem => ({ id, name, type: "MESH", parent, hidden: false, last });

const edit = (kind: "human" | "agent", actorId: string, at: string) => ({
  actor: { kind, id: actorId },
  at,
  kind: "object.set",
});

describe("outlineRows", () => {
  it("puts children under their parent and sorts each level by name", () => {
    const rows = outlineRows([
      item("c", "Wheel", "b"),
      item("b", "Car"),
      item("a", "Camera"),
      item("d", "Axle", "b"),
    ]);
    expect(rows.map((row) => [row.item.name, row.depth])).toEqual([
      ["Camera", 0],
      ["Car", 0],
      ["Axle", 1],
      ["Wheel", 1],
    ]);
  });

  it("keeps objects whose parent is not listed at the root", () => {
    expect(outlineRows([item("x", "Lamp", "missing")]).map((row) => row.depth)).toEqual([0]);
  });
});

describe("actorLabel", () => {
  it("names the local operator You and an unnamed agent Agent", () => {
    expect(actorLabel({ kind: "human", id: "local" })).toBe("You");
    expect(actorLabel({ kind: "agent", id: "agent" })).toBe("Agent");
    expect(actorLabel({ kind: "agent", id: "a1", name: "Ali's agent" })).toBe("Ali's agent");
  });
});

describe("shortAge", () => {
  const now = Date.parse("2026-10-31T12:00:00.000Z");
  it("reads like an outline badge", () => {
    expect(shortAge("2026-10-31T11:59:58.000Z", now)).toBe("now");
    expect(shortAge("2026-10-31T11:59:20.000Z", now)).toBe("40s");
    expect(shortAge("2026-10-31T11:57:00.000Z", now)).toBe("3m");
    expect(shortAge("2026-10-31T09:00:00.000Z", now)).toBe("3h");
    expect(shortAge("2026-10-26T12:00:00.000Z", now)).toBe("5d");
  });
});

describe("recentEdits", () => {
  it("lists edited items newest first, up to the limit", () => {
    const recent = recentEdits(
      [
        item("a", "Cube", null, edit("human", "local", "2026-10-31T10:00:00.000Z")),
        item("b", "Light"),
        item("c", "Suzanne", null, edit("agent", "agent", "2026-10-31T11:00:00.000Z")),
        item("d", "Camera", null, edit("agent", "agent", "2026-10-31T09:00:00.000Z")),
      ],
      2,
    );
    expect(recent.map((entry) => entry.name)).toEqual(["Suzanne", "Cube"]);
  });
});

describe("viewWidth", () => {
  it("follows the panel in device pixels, within bounds", () => {
    expect(viewWidth(500, 2)).toBe(1000);
    expect(viewWidth(900, 3)).toBe(1280);
    expect(viewWidth(100, 1)).toBe(320);
  });
});
