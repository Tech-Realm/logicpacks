import { describe, expect, it } from "@effect/vitest";

import { validatePrefsPatch } from "./userPrefs.ts";

describe("validatePrefsPatch", () => {
  it("accepts the known keys and stores them as JSON, null clears", () => {
    const result = validatePrefsPatch({
      workStyle: "developer",
      layout: { activeModeId: "dev" },
      intro: null,
    });
    expect(result).toEqual({
      ok: true,
      entries: [
        ["workStyle", '"developer"'],
        ["layout", '{"activeModeId":"dev"}'],
        ["intro", null],
      ],
    });
  });

  it("refuses unknown keys, a bad workStyle and oversized values", () => {
    expect(validatePrefsPatch({ theme: "dark" }).ok).toBe(false);
    expect(validatePrefsPatch({ workStyle: "wizard" }).ok).toBe(false);
    expect(validatePrefsPatch({ layout: { blob: "x".repeat(13 * 1024) } }).ok).toBe(false);
  });
});
