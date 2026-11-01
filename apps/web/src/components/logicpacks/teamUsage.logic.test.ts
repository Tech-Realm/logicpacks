import { describe, expect, it } from "vite-plus/test";

import {
  buildHeatmap,
  formatCost,
  formatHours,
  newlyUnlocked,
  parseUsageView,
  weekOverWeek,
} from "./teamUsage.logic";

describe("teamUsage.logic", () => {
  it("opens Usage on the team view unless this machine is asked for", () => {
    expect(parseUsageView(undefined)).toBe("team");
    expect(parseUsageView("machine")).toBe("machine");
    expect(parseUsageView("nonsense")).toBe("team");
  });

  it("lays out a year of weeks ending today with quantile levels", () => {
    // Saturday 2026-10-31: the last column is a full week.
    const today = "2026-10-31T18:00:00Z";
    const columns = buildHeatmap(
      [
        { day: "2026-10-31", tokens: 100_000, turns: 9 },
        { day: "2026-10-30", tokens: 1_000, turns: 1 },
        { day: "2026-10-29", tokens: 10_000, turns: 2 },
        { day: "2026-10-28", tokens: 50_000, turns: 4 },
        { day: "2026-10-27", tokens: 0, turns: 1 },
      ],
      today,
    );
    expect(columns).toHaveLength(53);
    const last = columns.at(-1)!;
    expect(last.map((cell) => cell?.day)).toEqual([
      "2026-10-25",
      "2026-10-26",
      "2026-10-27",
      "2026-10-28",
      "2026-10-29",
      "2026-10-30",
      "2026-10-31",
    ]);
    expect(last.map((cell) => cell?.level)).toEqual([0, 0, 1, 3, 2, 1, 4]);
    const single = buildHeatmap([{ day: "2026-10-31", tokens: 5, turns: 1 }], today, 1)[0]!;
    expect(single.at(-1)?.level).toBe(4);
    // Midweek, days after today are blank.
    const wednesday = buildHeatmap([], "2026-10-28T08:00:00Z", 2).at(-1)!;
    expect(wednesday.filter((cell) => cell.future)).toHaveLength(3);
  });

  it("describes week over week change", () => {
    expect(weekOverWeek(150, 100)).toEqual({ label: "+50%", direction: "up" });
    expect(weekOverWeek(80, 100)).toEqual({ label: "-20%", direction: "down" });
    expect(weekOverWeek(100, 100)).toEqual({ label: "no change", direction: "flat" });
    expect(weekOverWeek(5, 0)).toEqual({ label: "new", direction: "up" });
    expect(weekOverWeek(0, 0).direction).toBe("flat");
  });

  it("formats hours and costs for the table", () => {
    expect(formatHours(0)).toBe("0h");
    expect(formatHours(0.25)).toBe("15m");
    expect(formatHours(2.34)).toBe("2.3h");
    expect(formatHours(42.6)).toBe("43h");
    expect(formatCost(null)).toBe("n/a");
    expect(formatCost(0.004)).toBe("<$0.01");
    expect(formatCost(12.345)).toBe("$12.35");
  });

  it("toasts only unlocks this device has not seen, never on the first visit", () => {
    expect(newlyUnlocked(["a", "b"], null)).toEqual({ fresh: [], seen: '["a","b"]' });
    expect(newlyUnlocked(["a", "b", "c"], '["a"]').fresh).toEqual(["b", "c"]);
    expect(newlyUnlocked(["a"], "not json").fresh).toEqual([]);
  });
});
