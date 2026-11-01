// @effect-diagnostics nodeBuiltinImport:off - reads the generated route tree from disk.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { MachineDemo } from "./MachineDemo";

const at = (seconds: number) =>
  renderToStaticMarkup(<MachineDemo initialTime={seconds * 1_000} autoplay={false} />);

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replaceAll("&#x27;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&")
    .replace(/\s+/g, " ");

describe("MachineDemo", () => {
  it("opens on the live Blender view, labelled Beta", () => {
    const html = at(0);
    expect(html).toContain('data-testid="machine-demo"');
    expect(html).toContain('data-demo-app="blender"');
    expect(text(html)).toContain("Beta");
    expect(text(html)).toContain("Scene outliner");
    expect(text(html)).toContain("Suzanne_Hero");
    expect(html).toContain("blender-studio");
    // The window strip lists every app on the shared machine.
    for (const app of ["Blender", "DaVinci Resolve", "Browser", "LogicPacks IDE"]) {
      expect(text(html)).toContain(app);
    }
    expect(html).toContain('aria-label="Play demo"');
  });

  it("shows cursors with name labels and streams agent turns", () => {
    const html = at(7);
    expect(html).toContain('data-testid="machine-demo-cursor-mira"');
    expect(html).toContain('data-testid="machine-demo-cursor-miraAgent"');
    expect(text(html)).toContain("Mira's agent");
    expect(text(html)).toContain("Light the table for the hero shot");
    expect(text(html)).toContain("set Key_Light.energy 800 → 1200");
  });

  it("moves to Resolve with bins and timeline as context and agents talking", () => {
    const html = at(30);
    expect(html).toContain('data-demo-app="resolve"');
    expect(text(html)).toContain("Bins and timeline");
    expect(html).toContain("resolve-cut");
    expect(html).toContain('data-testid="machine-demo-cursor-omarAgent"');
    expect(text(html)).toContain("Need the final hero render");
    expect(html).toContain('data-testid="machine-demo-snapshot"');
    expect(html).toContain('data-phase="local"');
  });

  it("replays the snapshot, raises a conflict and shows the agent resolving it", () => {
    const open = at(47);
    expect(text(open)).toContain("Merging snapshot #14");
    expect(open).toContain('data-testid="machine-demo-conflict"');
    expect(open).toContain('data-status="open"');
    expect(at(50)).toContain('data-status="resolving"');
    const resolved = at(53);
    expect(resolved).toContain('data-status="resolved"');
    expect(text(resolved)).toContain("Conflict resolved");
    // The resolved card lingers briefly, then the merge is simply done.
    const merged = at(58);
    expect(merged).toContain('data-phase="merged"');
    expect(merged).not.toContain('data-testid="machine-demo-conflict"');
  });

  it("shows the code recipe as files and an editor", () => {
    const html = at(62);
    expect(html).toContain('data-demo-app="code"');
    expect(text(html)).toContain("render_hero.py");
    expect(text(html)).toContain("Files");
  });

  it("renders the same frame for the same time", () => {
    expect(at(44.25)).toBe(at(44.25));
  });

  it("is routed at /demo/machine inside the app shell", () => {
    const tree = NodeFS.readFileSync(
      NodePath.join(
        NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
        "../../routeTree.gen.ts",
      ),
      "utf8",
    );
    expect(tree).toMatch(
      /ChatDemoMachineRouteImport\.update\(\{\s*id: '\/demo\/machine',\s*path: '\/demo\/machine',\s*getParentRoute: \(\) => ChatRoute,/,
    );
  });
});
