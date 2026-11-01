import { RecipeManifest, recipeFromPackManifest } from "@logicpacks/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  chainPacks,
  decodePack,
  encodePack,
  packFromThread,
  packHandoffText,
  packIdFromName,
  referencesByApp,
  renderPackContext,
  stepTitle,
  type PackThreadInput,
} from "./packContext.ts";

const blenderThread: PackThreadInput = {
  projectId: "project-1",
  projectTitle: "Launch film",
  threadId: "thread-1",
  threadTitle: "Hero shot set dressing",
  recipe: "blender",
  savedBy: "Ana",
  savedAt: "2026-10-31T12:00:00.000Z",
  goal: "Dress the hero shot with the brass lamp and a warm key light",
  branch: "lp/ana-hero",
  people: ["Ana", "Ali"],
  files: [
    { path: "scene.blend", activity: "editing" },
    { path: "textures/brass.png", activity: "reading" },
  ],
  decisions: [{ text: "Key light stays warm, 3200K", by: "Ana" }],
  prompts: [
    "<logicpacks_project>ledger</logicpacks_project>Hi, add a brass lamp on the desk. Keep it small.",
    "Now add a warm key light from the left",
  ],
  appItems: [
    { kind: "app-object", name: "BrassLamp", detail: "MESH" },
    { kind: "app-object", name: "KeyLight", detail: "LIGHT" },
  ],
};

describe("pack context", () => {
  it("saves a thread as a recipe/1 pack that survives encode and decode unchanged", () => {
    const pack = packFromThread(blenderThread);
    expect(() => Schema.decodeSync(RecipeManifest)(pack)).not.toThrow();
    const text = encodePack(pack);
    const decoded = decodePack(text);
    expect(decoded).toEqual(pack);
    expect(decoded?.context?.source.threadId).toBe("thread-1");
    expect(decoded?.context?.decisions).toEqual([
      { text: "Key light stays warm, 3200K", by: "Ana" },
    ]);
    expect(decoded?.apps).toEqual(["blender"]);
  });

  it("carries app objects, files and workflow steps, without ledger blocks or greetings", () => {
    const pack = packFromThread(blenderThread);
    const context = pack.context!;
    expect(context.references.map((ref) => `${ref.kind}:${ref.name}`)).toEqual([
      "file:scene.blend",
      "file:textures/brass.png",
      "app-object:BrassLamp",
      "app-object:KeyLight",
    ]);
    expect(context.steps.map((step) => step.title)).toEqual([
      "Add a brass lamp on the desk",
      "Add a warm key light from the left",
    ]);
    expect(context.steps[0]?.prompt).not.toContain("logicpacks_project");
    expect(context.summary).toContain("Goal: Dress the hero shot");
  });

  it("renders the text an agent in another app reads", () => {
    const pack = packFromThread({ ...blenderThread, name: "Hero lamp look" });
    expect(pack.id).toBe("hero-lamp-look");
    const text = renderPackContext({ name: pack.name, context: pack.context! });
    expect(text).toContain(
      'Pack "Hero lamp look" from thread "Hero shot set dressing" in Launch film (Blender)',
    );
    expect(text).toContain("- app-object BrassLamp (MESH)");
    expect(text).toContain("Decisions:\n- Key light stays warm, 3200K (Ana)");
    expect(text).toContain("Workflow:\n1. Add a brass lamp on the desk");
    expect(pack.agentInstructions).toBe(text);
    const handoff = packHandoffText({ name: pack.name, context: pack.context! }, "davinci-resolve");
    expect(handoff).toContain("(DaVinci Resolve)");
    expect(handoff).toContain("Key light stays warm");
  });

  it("reads context from a v1 pack.json and chains two packs into one workflow", () => {
    const blender = packFromThread(blenderThread);
    const v1 = {
      identity: { name: "resolve-grade", version: "1.0.0", summary: "Grade the hero shot" },
      context: {
        source: {
          projectId: "project-2",
          projectTitle: "Launch film edit",
          recipe: "davinci-resolve",
          savedBy: "Ali",
          savedAt: "2026-10-31T13:00:00.000Z",
        },
        summary: "Timeline v3, warm grade.",
        decisions: [],
        references: [
          {
            kind: "timeline-marker",
            app: "davinci-resolve",
            name: "Hero in",
            detail: "01:00:04:12",
          },
        ],
        steps: [{ title: "Match the grade to the lamp", recipe: "davinci-resolve" }],
      },
    };
    const resolve = recipeFromPackManifest(v1);
    expect(resolve?.context?.references[0]?.name).toBe("Hero in");
    const chained = chainPacks(blender, resolve!);
    expect(chained.map((step) => step.recipe)).toEqual(["blender", "blender", "davinci-resolve"]);
    expect(referencesByApp(resolve!.context!.references)[0]?.app).toBe("davinci-resolve");
  });

  it("names steps and ids plainly", () => {
    expect(stepTitle("ok. fix the checkout total! then deploy")).toBe("Fix the checkout total");
    expect(packIdFromName("  Résumé: v2 !! ")).toBe("r-sum-v2");
    expect(packIdFromName("!!!")).toBe("pack");
  });
});
