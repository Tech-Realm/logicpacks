// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalTimers:off - a standalone probe driving real Blender.
/**
 * The Blender live view against a real headless Blender (skips when missing):
 * `node apps/server/scripts/recipe-view-probe.ts [outDir] [--window]`. Starts Blender
 * with the bridge, asks for the view and saves the frame it returns. `--window` opens
 * a real Blender window (as the desktop app does) and expects a viewport capture.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { findBuiltInRecipe } from "@logicpacks/shared/recipes/builtin";
import { connectBridge, readBridgeInfo } from "../src/recipes/bridgeClient.ts";
import { detectRecipeApp, launchRecipe } from "../src/recipes/recipeRunner.ts";

const blender = findBuiltInRecipe("blender")!;
if (!detectRecipeApp(blender)) {
  console.log("SKIP: Blender is not installed here.");
  process.exit(0);
}
const windowed = process.argv.includes("--window");
const out = process.argv.slice(2).find((arg) => !arg.startsWith("--")) ?? NodeOS.tmpdir();
const project = NodeFS.mkdtempSync(NodePath.join(out, "lp-view-"));
const launched = await launchRecipe({ recipeId: "blender", project, headless: !windowed });
let info = await readBridgeInfo(launched.session);
for (let tries = 0; info === null && tries < 120; tries++) {
  await new Promise((resolve) => setTimeout(resolve, 250));
  info = await readBridgeInfo(launched.session);
}
const bridge = await connectBridge(info!);
let failed = false;
try {
  await bridge.call("add_object", { primitive: "monkey", name: "Suzanne", location: [2, 0, 0.5] });
  const before = (await bridge.call("list_scene")) as { objects: unknown[] };
  const view = (await bridge.call("view", { width: 640 })) as {
    image: string | null;
    mode: string | null;
    objects: Array<{ name: string; last: { actor: { kind: string } } | null }>;
    imageError?: string;
  };
  // Without a scene camera the view frames everything with a temporary one.
  await bridge.call("delete_object", { name: "Camera" });
  const before2 = (await bridge.call("list_scene")) as { objects: unknown[] };
  const framed = (await bridge.call("view", { width: 640 })) as {
    image: string | null;
    mode: string | null;
  };
  if (framed.image)
    NodeFS.writeFileSync(
      NodePath.join(out, "blender-view-framed.png"),
      Buffer.from(framed.image, "base64"),
    );
  const after = (await bridge.call("list_scene")) as { objects: unknown[] };
  const ops = (await bridge.call("export_oplog")) as { ops: Array<{ name?: string }> };
  if (windowed) {
    // A second frame a moment later: the window has drawn the scene by now.
    await new Promise((resolve) => setTimeout(resolve, 15_000));
    const later = (await bridge.call("view", { width: 640 })) as { image: string | null };
    if (later.image)
      NodeFS.writeFileSync(
        NodePath.join(out, "blender-view-window-later.png"),
        Buffer.from(later.image, "base64"),
      );
  }
  const png = view.image ? Buffer.from(view.image, "base64") : null;
  // Without a window the frame is rendered; with one it follows the viewport.
  const frameMoved = view.image !== framed.image;
  if (png) NodeFS.writeFileSync(NodePath.join(out, "blender-view.png"), png);
  const checks: Array<[string, boolean, unknown]> = [
    ["rendered a PNG", png !== null && png.subarray(1, 4).toString() === "PNG", view.imageError],
    windowed
      ? ["a window's viewport is drawn", view.mode === "viewport", view.mode]
      : ["headless mode renders", view.mode === "render", view.mode],
    ["outline lists the scene", view.objects.some((o) => o.name === "Suzanne"), view.objects],
    [
      "outline credits the agent",
      view.objects.find((o) => o.name === "Suzanne")?.last?.actor.kind === "agent",
      view.objects,
    ],
    ["renders without a scene camera", framed.image !== null, framed.mode],
    ["the frame follows edits", frameMoved, null],
    [
      "view leaves no objects behind",
      before2.objects.length === after.objects.length &&
        before.objects.length === after.objects.length + 1,
      after,
    ],
    ["view leaves no ops behind", !ops.ops.some((op) => op.name === "lp_view"), ops.ops.length],
  ];
  for (const [label, ok, detail] of checks) {
    console.log(
      `${ok ? "PASS" : "FAIL"} ${label}${ok ? "" : ` ${JSON.stringify(detail).slice(0, 400)}`}`,
    );
    failed ||= !ok;
  }
} finally {
  await bridge.call("quit").catch(() => undefined);
  bridge.close();
  // A windowed Blender keeps running after its bridge stops.
  if (windowed && launched.pid) process.kill(launched.pid, "SIGTERM");
  NodeFS.rmSync(project, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
