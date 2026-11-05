import { describe, expect, it } from "vite-plus/test";

import { chooseVisibleIds } from "./overflowToolbar.logic";

const items = [
  { id: "people", priority: 3, width: 60 },
  { id: "share", priority: 1, width: 70 },
  { id: "tools", priority: 2, width: 100 },
];

describe("chooseVisibleIds", () => {
  it("keeps everything when there is room or no budget", () => {
    expect([...chooseVisibleIds(items, null, 8, 28)]).toHaveLength(3);
    expect([...chooseVisibleIds(items, 260, 8, 28)]).toHaveLength(3);
  });

  it("moves the least important out first and reserves room for the more button", () => {
    // 70 + 8 + 100 = 178 plus the more button 8 + 28 = 214
    expect([...chooseVisibleIds(items, 214, 8, 28)].toSorted()).toEqual(["share", "tools"]);
    expect([...chooseVisibleIds(items, 213, 8, 28)]).toEqual(["share"]);
  });

  it("falls back to the more button alone", () => {
    expect([...chooseVisibleIds(items, 30, 8, 28)]).toEqual([]);
    expect([...chooseVisibleIds(items, 0, 8, 28)]).toEqual([]);
  });

  it("never shows a less important item in place of a more important one that did not fit", () => {
    const wide = [
      { id: "a", priority: 1, width: 200 },
      { id: "b", priority: 2, width: 20 },
    ];
    expect([...chooseVisibleIds(wide, 100, 8, 28)]).toEqual([]);
  });
});
