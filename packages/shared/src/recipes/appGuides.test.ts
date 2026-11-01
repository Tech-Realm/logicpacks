import { describe, expect, it } from "vite-plus/test";

import { appGuideFor, renderAppGuide, sharedAppTurnContext } from "./appGuides.ts";

describe("app guides", () => {
  it("picks the app's own recipe, else Any app", () => {
    expect(appGuideFor("Blender").id).toBe("blender");
    expect(appGuideFor("DaVinci Resolve").id).toBe("resolve");
    expect(appGuideFor("TextEdit").id).toBe("any");
  });

  it("tells agents to use lp app ops and the grant rule", () => {
    const text = renderAppGuide(appGuideFor("Blender"));
    expect(text).toContain("lp app run blender.move");
    expect(text).toContain("lp app ops");
    expect(text).toContain("grant");
  });

  it("wraps the shared app for the agent's turn", () => {
    const block = sharedAppTurnContext({
      appName: "Blender",
      title: "scene.blend",
      hostName: "Ana",
    });
    expect(block.startsWith("<logicpacks_shared_app>")).toBe(true);
    expect(block).toContain('Ana is sharing Blender ("scene.blend")');
    expect(block).not.toContain("—");
  });
});
