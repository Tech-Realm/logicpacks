import { describe, expect, it } from "vite-plus/test";

import {
  DEV_LAYOUT_MODE,
  VIBE_LAYOUT_MODE,
  duplicateLayoutMode,
  mergeImportedLayoutModes,
  parseLayoutModesJson,
  resolveLayoutMode,
  serializeLayoutModes,
  workspaceBeforeChat,
} from "./layoutModes";
import { EMPTY_USER_PREFS, decodeUserPrefs, mergeUserPrefs } from "./userPrefs.logic";

const custom = duplicateLayoutMode(DEV_LAYOUT_MODE, [], "My dev");

describe("layout mode schema", () => {
  it("ships Dev workspace-first with files auto-open and Vibe chat-first with nothing open", () => {
    expect(workspaceBeforeChat(DEV_LAYOUT_MODE)).toBe(true);
    expect(DEV_LAYOUT_MODE.autoOpen).toBe("files");
    expect(DEV_LAYOUT_MODE.widths.projects).toBeLessThan(VIBE_LAYOUT_MODE.widths.projects);
    expect(workspaceBeforeChat(VIBE_LAYOUT_MODE)).toBe(false);
    expect(VIBE_LAYOUT_MODE.open.workspace).toBe(false);
    expect(VIBE_LAYOUT_MODE.autoOpen).toBe("none");
  });

  it("opens Dev at 70% files and editor, 30% chat, like Cursor; copies keep their own pixel width", () => {
    expect(DEV_LAYOUT_MODE.workspaceShare).toBe(0.7);
    expect(VIBE_LAYOUT_MODE.workspaceShare).toBeUndefined();
    expect(custom.workspaceShare).toBeUndefined();
    expect(custom.widths.workspace).toBe(DEV_LAYOUT_MODE.widths.workspace);
  });

  it("defaults to Dev for developers and Vibe otherwise, and falls back from unknown ids", () => {
    expect(resolveLayoutMode(null, [], "developer").id).toBe("dev");
    expect(resolveLayoutMode(null, [], "beginner").id).toBe("vibe");
    expect(resolveLayoutMode(null, [], null).id).toBe("vibe");
    expect(resolveLayoutMode("gone", [], "developer").id).toBe("dev");
    expect(resolveLayoutMode(custom.id, [custom], null)).toEqual(custom);
  });

  it("duplicates with an id that collides with nothing", () => {
    expect(custom.id).toBe("my-dev");
    expect(duplicateLayoutMode(DEV_LAYOUT_MODE, [custom], "My dev").id).toBe("my-dev-2");
    expect(duplicateLayoutMode(VIBE_LAYOUT_MODE, [], "Vibe").id).toBe("vibe-2");
  });
});

describe("layout import validation", () => {
  it("round trips an export", () => {
    const result = parseLayoutModesJson(serializeLayoutModes([custom]));
    expect(result).toEqual({ ok: true, modes: [custom] });
  });

  it.each([
    ["{ not json", /not valid JSON \(line 1\)/],
    ["", /empty/],
    ['{"version": 2, "modes": []}', /version 1/],
    ['{"modes": []}', /no layouts/],
  ])("rejects %j", (text, message) => {
    const result = parseLayoutModesJson(text);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join("\n")).toMatch(message);
  });

  it("names each bad field: unknown panel, order, widths, open, built-in id", () => {
    const result = parseLayoutModesJson(
      JSON.stringify({
        version: 1,
        modes: [
          { ...custom, order: ["projects", "editor", "chat"] },
          { ...custom, id: "b", order: ["chat", "projects", "workspace"] },
          { ...custom, id: "c", widths: { projects: 50, workspace: 600 } },
          { ...custom, id: "d", open: { projects: true, sidebar: true } },
          { ...custom, id: "dev" },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContain(
      'modes[0].order[1]: unknown panel "editor". Use projects, chat or workspace.',
    );
    expect(result.errors).toContain(
      "modes[1].order: projects has to come first, the sidebar sits on the left.",
    );
    expect(result.errors).toContain(
      "modes[2].widths.projects: 50 is out of range, use 200 to 480.",
    );
    expect(result.errors).toContain(
      "modes[3].open.sidebar: unknown panel. Use projects, workspace or terminal.",
    );
    expect(result.errors).toContain('modes[4].id: "dev" is a built-in layout. Pick another id.');
  });

  it("rejects duplicate ids and accepts a single bare mode", () => {
    const dupes = parseLayoutModesJson(JSON.stringify([custom, custom]));
    expect(dupes.ok).toBe(false);
    expect(parseLayoutModesJson(JSON.stringify(custom))).toEqual({ ok: true, modes: [custom] });
  });

  it("replaces custom modes with the same id on import", () => {
    const renamed = { ...custom, label: "Renamed" };
    expect(mergeImportedLayoutModes([custom], [renamed])).toEqual([renamed]);
  });
});

describe("account prefs persistence", () => {
  const at = (minute: number) => `2026-11-01T10:${String(minute).padStart(2, "0")}:00.000Z`;

  it("keeps the newer layout slice and pushes the local one when it is newer", () => {
    const local = {
      ...EMPTY_USER_PREFS,
      layout: { activeModeId: "dev", customModes: [custom], updatedAt: at(5) },
    };
    const olderServer = { layout: { activeModeId: "vibe", customModes: [], updatedAt: at(1) } };
    const merged = mergeUserPrefs(local, olderServer);
    expect(merged.prefs.layout.activeModeId).toBe("dev");
    expect(merged.push.layout).toEqual(local.layout);

    const newerServer = { layout: { activeModeId: "vibe", customModes: [], updatedAt: at(9) } };
    const fromServer = mergeUserPrefs(local, newerServer);
    expect(fromServer.prefs.layout.activeModeId).toBe("vibe");
    expect(fromServer.push.layout).toBeUndefined();
  });

  it("takes the onboarding's workStyle from the server", () => {
    const merged = mergeUserPrefs(
      { ...EMPTY_USER_PREFS, workStyle: "beginner" },
      { workStyle: "developer" },
    );
    expect(merged.prefs.workStyle).toBe("developer");
    expect(merged.push.workStyle).toBeUndefined();
  });

  it("does not push slices nobody has touched", () => {
    expect(mergeUserPrefs(EMPTY_USER_PREFS, {}).push).toEqual({});
  });

  it("decodes stored prefs leniently, dropping custom modes that no longer validate", () => {
    const decoded = decodeUserPrefs({
      layout: { activeModeId: "x", customModes: [custom, { id: "bad" }], updatedAt: at(1) },
      workStyle: "wizard",
      intro: { completedAt: at(2), tour: "pending", updatedAt: at(2) },
    });
    expect(decoded.layout?.customModes).toEqual([custom]);
    expect(decoded.workStyle).toBeUndefined();
    expect(decoded.intro?.tour).toBe("pending");
  });
});
