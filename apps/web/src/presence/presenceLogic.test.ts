import { ProjectId, type PresenceEntry } from "@logicpacks/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  appPointer,
  entriesInApp,
  entriesOnAppObject,
  othersOnly,
  presenceAvatars,
  presencePositionsFromSelection,
  presenceTreeDecoration,
  remoteCaretsForFile,
} from "./presenceLogic";

const entry = (overrides: Partial<PresenceEntry> & Pick<PresenceEntry, "key">): PresenceEntry => ({
  clientId: `${overrides.key}:file`,
  projectId: ProjectId.make("p"),
  actor: { id: "lp-user:ali", kind: "human", name: "Ali", colorIndex: 1 },
  source: "web",
  location: { view: "file", activity: "viewing", path: "src/app/page.tsx" },
  since: "1970-01-01T00:00:00.000Z",
  updatedAt: "1970-01-01T00:00:00.000Z",
  ...overrides,
});

const ali = entry({ key: "tab-a" });
const aliSecondTab = entry({ key: "tab-b", updatedAt: "1970-01-01T00:00:05.000Z" });
const agent = entry({
  key: "agent:thread:1",
  actor: { id: "agent:thread:1", kind: "agent", name: "Ali's agent", colorIndex: 1 },
  location: {
    view: "file",
    activity: "editing",
    path: "src/app/page.tsx",
    cursor: { line: 42, column: 4 },
  },
});
const noor = entry({
  key: "tab-n",
  actor: { id: "lp-user:noor", kind: "human", name: "Noor", colorIndex: 5 },
  location: {
    view: "file",
    activity: "viewing",
    path: "src/lib/cart.ts",
    cursor: { line: 3, column: 0 },
    anchor: { line: 1, column: 2 },
  },
});

describe("presence avatars", () => {
  it("shows one avatar per person across tabs, people before agents, and hides this tab", () => {
    expect(
      presenceAvatars([agent, ali, aliSecondTab]).map(({ actor, entries }) => [
        actor.name,
        entries.length,
      ]),
    ).toEqual([
      ["Ali", 2],
      ["Ali's agent", 1],
    ]);
    expect(othersOnly([ali, noor], "tab-a").map((e) => e.key)).toEqual(["tab-n"]);
  });

  it("marks files and the folders above them, with who and what on hover", () => {
    const nowMs = 2 * 60_000;
    const file = presenceTreeDecoration([ali, agent, noor], "src/app/page.tsx", nowMs);
    expect(file?.text).toBe("●◆");
    expect(file?.parts.map((part) => part.color)).toEqual([
      "var(--presence-1)",
      "var(--presence-1)",
    ]);
    expect(file?.title).toBe("Ali viewing, 2m\nAli's agent editing line 42, 2m");

    const folder = presenceTreeDecoration([ali, agent, noor], "src/", nowMs);
    expect(folder?.text).toBe("●●◆");
    expect(folder?.title).toContain("Noor viewing src/lib/cart.ts:3, 2m");
    expect(presenceTreeDecoration([ali], "src/application/", nowMs)).toBeNull();
  });
});

describe("remote carets", () => {
  it("converts presence lines to the editor's zero-based carets with a selection", () => {
    expect(remoteCaretsForFile([noor, ali], "src/lib/cart.ts")).toEqual([
      {
        anchor: { line: 0, character: 2 },
        focus: { line: 2, character: 0 },
        metadata: { color: "var(--presence-5)", name: "Noor", agent: false },
      },
    ]);
  });

  it("reports the caret end of an editor selection as the cursor", () => {
    const range = { start: { line: 0, character: 1 }, end: { line: 4, character: 0 } };
    expect(presencePositionsFromSelection({ ...range, direction: 1 })).toEqual({
      cursor: { line: 5, column: 0 },
      anchor: { line: 1, column: 1 },
    });
    expect(presencePositionsFromSelection({ ...range, direction: -1 })).toEqual({
      cursor: { line: 1, column: 1 },
      anchor: { line: 5, column: 0 },
    });
    expect(
      presencePositionsFromSelection({ start: range.start, end: range.start, direction: 0 }),
    ).toEqual({ cursor: { line: 1, column: 1 } });
  });
});

describe("presence in an app recipe", () => {
  const onApp = (key: string, appItem?: PresenceEntry["location"]["appItem"]) =>
    entry({
      key,
      location: { view: "app", activity: "viewing", ...(appItem ? { appItem } : {}) },
    });
  const byId = onApp("a", { recipeId: "blender", itemId: "lp-1", label: "Car" });
  const byName = onApp("b", { recipeId: "blender", itemId: "Wheel" });
  const otherRecipe = onApp("c", { recipeId: "davinci-resolve", itemId: "lp-1" });
  const looking = onApp("d");
  const inFile = entry({ key: "e" });
  const all = [byId, byName, otherRecipe, looking, inFile];

  it("puts people and agents on the outline row they are on, by id or by name", () => {
    expect(entriesOnAppObject(all, "blender", { id: "lp-1", name: "Car" })).toEqual([byId]);
    expect(entriesOnAppObject(all, "blender", { id: "lp-2", name: "Wheel" })).toEqual([byName]);
    expect(entriesOnAppObject(all, "blender", { id: null, name: "Light" })).toEqual([]);
  });

  it("counts everyone in this app, not other recipes or files", () => {
    expect(entriesInApp(all, "blender")).toEqual([byId, byName, looking]);
  });

  it("turns a pointer into rounded fractions of the view", () => {
    expect(appPointer(50, 25, 200, 100)).toEqual({ x: 0.25, y: 0.25 });
    expect(appPointer(-5, 140, 200, 100)).toEqual({ x: 0, y: 1 });
    expect(appPointer(1, 1, 3, 3)).toEqual({ x: 0.333, y: 0.333 });
    expect(appPointer(1, 1, 0, 100)).toBeNull();
  });
});
