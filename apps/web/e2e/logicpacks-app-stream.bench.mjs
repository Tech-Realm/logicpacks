#!/usr/bin/env node
// App-sharing benchmarks ("Any app"), on a real Mac:
//   node apps/web/e2e/logicpacks-app-stream.bench.mjs --home <LOGICPACKS_HOME> --project <id>
//        [--web http://127.0.0.1:5741] [--backend http://127.0.0.1:3881] [--cdp http://127.0.0.1:9341]
//        [--scenarios blender,text,resolve] [--samples 15] [--out research/benchmarks.json]
//
// Same stack as logicpacks-app-stream.e2e.mjs (desktop dev build as host over CDP, a member in
// headless Chrome on the same Mac; Mira must have the apps feature). Without --hidden it takes over the screen:
// each app is brought to the front and driven with injected input.
//
// Method, per scenario and transport:
// - Latency is input to photon, on the viewer's own clock: the viewer sends one input through the
//   control path (data channel or server), the host injects it into the app, the app redraws,
//   ScreenCaptureKit captures, the host encodes and sends, and the viewer times the first painted
//   frame (requestVideoFrameCallback expectedDisplayTime, or JPEG load) whose 96x60 downsample
//   differs from the frame before the input. No clock sync is needed. The input toggles something
//   large (Blender's sidebar, a Resolve page, a big character in TextEdit) so one input is one change.
// - Baseline "local-capture": the same input injected on the host and timed on frames read straight
//   off the capture track (no encode, no network): what capture plus the app's own redraw cost.
// - Frame rate: painted frames per second on the viewer over a window of constant motion (Blender
//   orbiting, Resolve playing, TextEdit scrolling). Capture only delivers frames when pixels change.
// - Host CPU: `top` second-sample %CPU summed over the desktop app's processes and lp-appctl
//   (100 = one core). The app's own CPU and the viewer's (Chrome) are reported separately.
// - Transports here are loopback (viewer and host on one Mac): the network adds no delay; the
//   viewer's decode still runs on the same machine. A TURN relay does not exist yet, so none is
//   measured.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const require = NodeModule.createRequire(import.meta.url);
const { chromium } = require("playwright");

const args = process.argv.slice(2);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const web = flag("--web") ?? "http://127.0.0.1:5741";
const backend = flag("--backend") ?? "http://127.0.0.1:3881";
const cdp = flag("--cdp") ?? "http://127.0.0.1:9341";
const home = flag("--home");
const projectId = flag("--project");
const samples = Number(flag("--samples") ?? 15);
const scenarios = (flag("--scenarios") ?? "blender,text,resolve").split(",");
// --hidden: the shared app runs on the hidden display (off the host's screen), input posted to it alone.
const hidden = process.argv.includes("--hidden");
const suffix = hidden ? "-hidden-display" : "";
const repo = NodePath.join(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "../../..");
const outFile = flag("--out") ?? NodePath.join(repo, "research/benchmarks.json");
if (!home || !projectId) throw new Error("--home and --project are required");
const MIRA = "mira@example.test";
const PASSWORD = "correct-horse-battery";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const machine = (() => {
  const sh = (cmd, cmdArgs) =>
    NodeChildProcess.execFileSync(cmd, cmdArgs, { encoding: "utf8" }).trim();
  return `${sh("sysctl", ["-n", "hw.model"])}, ${sh("sysctl", ["-n", "machdep.cpu.brand_string"])}, ${Math.round(NodeOS.totalmem() / 2 ** 30)} GB, macOS ${sh("sw_vers", ["-productVersion"])}`;
})();

const operatorToken = NodeChildProcess.execFileSync(
  process.execPath,
  ["src/bin.ts", "auth", "session", "issue", "--base-dir", home, "--token-only"],
  { cwd: NodePath.join(repo, "apps/server"), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
)
  .split("\n")
  .find((line) => line.startsWith("eyJ"));
async function api(path, body) {
  const response = await fetch(`${backend}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${operatorToken}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}
const op = async (name, opArgs = []) => {
  const out = await api("/api/lp/apps/run", {
    projectId,
    op: name,
    args: opArgs,
    noSnapshot: true,
  });
  if (out.status !== 200) throw new Error(`${name}: ${JSON.stringify(out.body).slice(0, 300)}`);
  return out.body.result;
};
const osa = (script) =>
  NodeChildProcess.execFileSync("/usr/bin/osascript", ["-e", script], { encoding: "utf8" }).trim();

// ── Process CPU ──────────────────────────────────────────────────────────────

function processTable() {
  return NodeChildProcess.execFileSync("/bin/ps", ["-axo", "pid=,ppid=,command="], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  })
    .split("\n")
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
    .filter(Boolean)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] }));
}
function descendants(rootPid, table) {
  const out = new Set([rootPid]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const row of table) {
      if (out.has(row.ppid) && !out.has(row.pid)) {
        out.add(row.pid);
        grew = true;
      }
    }
  }
  return [...out];
}
/** %CPU per pid group over `seconds`, from top's second sample (the first one is since boot). */
async function cpuOver(groups, seconds) {
  const pids = [...new Set(Object.values(groups).flat())];
  if (pids.length === 0) return {};
  // Async: the harness keeps driving motion (scrolling) while top samples.
  const out = await new Promise((resolve, reject) =>
    NodeChildProcess.execFile(
      "/usr/bin/top",
      [
        "-l",
        "2",
        "-s",
        String(seconds),
        "-stats",
        "pid,cpu",
        ...pids.flatMap((pid) => ["-pid", String(pid)]),
      ],
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    ),
  );
  const second = out.split(/^PID\s+%CPU\s*$/m).pop() ?? "";
  const cpu = new Map(
    second
      .split("\n")
      .map((line) => /^\s*(\d+)\s+([\d.]+)/.exec(line))
      .filter(Boolean)
      .map((m) => [Number(m[1]), Number(m[2])]),
  );
  return Object.fromEntries(
    Object.entries(groups).map(([name, list]) => [
      name,
      Math.round(list.reduce((sum, pid) => sum + (cpu.get(pid) ?? 0), 0) * 10) / 10,
    ]),
  );
}

// ── Stack ────────────────────────────────────────────────────────────────────

const electron = await chromium.connectOverCDP(cdp);
const host = electron
  .contexts()
  .flatMap((context) => context.pages())
  .find((page) => page.url().startsWith("logicpacks-dev://") || page.url().startsWith("http"));
const browser = await chromium.launch({
  headless: true,
  channel: process.env.LP_E2E_BROWSER_CHANNEL ?? "chrome",
});
const viewer = await (
  await browser.newContext({ viewport: { width: 1600, height: 1000 } })
).newPage();
await viewer.goto(`${web}/lp/login`);
await viewer.fill("#email", MIRA);
await viewer.fill("#password", PASSWORD);
await viewer.click("#submit");
await viewer.waitForURL(`${web}/`, { timeout: 20_000 });

const electronPids = () =>
  processTable()
    .filter(
      (row) => row.command.includes("LogicPacks (Dev).app") || row.command.includes("lp-appctl"),
    )
    .map((row) => row.pid);
/** The headless Chrome the viewer runs in: Playwright's temporary profile, and its children. */
const viewerPids = () => {
  const table = processTable();
  const roots = table.filter(
    (row) =>
      row.command.includes("playwright_chromiumdev_profile") && !row.command.includes("--type="),
  );
  return [...new Set(roots.flatMap((row) => descendants(row.pid, table)))];
};
const appPids = (pattern) =>
  processTable()
    .filter((row) => pattern.test(row.command))
    .map((row) => row.pid);

async function hostShare(appName, title) {
  await host.evaluate((id) => {
    location.hash = `#/machine?project=${id}&t=${Date.now()}`;
  }, projectId);
  await host.locator('[data-testid="live-machine"][data-role="host"]').waitFor({ timeout: 20_000 });
  // Same-machine runs bring the app forward (Stage Manager would capture a thumbnail). Hidden display
  // runs never touch the host's screen: no activation, nothing moved on the real displays.
  if (!hidden) {
    await op("app.activate", [appName]);
    await sleep(1500);
  }
  await host.getByRole("button", { name: "Refresh windows" }).click();
  const tile = host.locator(
    `[data-testid="live-machine-window"][data-app="${appName}"]${title ? `[data-title^="${title}"]` : ""}`,
  );
  await tile.first().waitFor({ timeout: 15_000 });
  await tile.first().click();
  await host.getByTestId("live-machine-live").waitFor({ timeout: 15_000 });
  await host.getByTestId("live-machine-kill").click();
  if (hidden) {
    await host.getByTestId("live-machine-hidden-toggle").click();
    await host
      .waitForFunction(() => window.__lpBench?.snapshot().hidden === true, undefined, {
        timeout: 15_000,
      })
      .catch(async (error) => {
        console.log(
          "hidden display:",
          await host.evaluate(() => window.__lpBench?.snapshot().hiddenError),
        );
        throw error;
      });
    await sleep(1000);
  }
}

async function viewerJoin() {
  await viewer.goto(`${web}/machine?project=${projectId}&t=${Date.now()}`);
  await viewer.getByTestId("live-machine-video").waitFor({ timeout: 30_000 });
  await viewer.waitForFunction(
    () => document.querySelector('[data-testid="live-machine-video"]')?.videoWidth > 0,
    undefined,
    { timeout: 30_000 },
  );
  await viewer.getByTestId("live-machine-request-control").click();
  await host.getByTestId("live-machine-approve").first().click();
  await viewer.getByTestId("live-machine-you-control").waitFor({ timeout: 10_000 });
}

async function viewerJpeg(retry = true) {
  await viewer.evaluate(() => window.__lpBench.forceJpeg());
  await viewer
    .waitForFunction(
      () => document.querySelector('[data-testid="live-machine-frame"]')?.naturalWidth > 0,
      undefined,
      { timeout: 20_000 },
    )
    .catch(async (error) => {
      console.log(
        "jpeg wait failed; host track:",
        await host.evaluate(() => window.__lpBench.trackState()),
      );
      if (!retry) throw error;
      await front?.();
      await viewerJpeg(false);
    });
}

const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round(sorted[index]);
};

/** `toggles` alternate, so the app goes back and forth and every input is one visible change. */
let front = null;
async function latency(page, toggles, { local = false, threshold = 2, region, reset } = {}) {
  const values = [];
  let misses = 0;
  for (let index = 0; index < samples; index += 1) {
    const ev = toggles[index % toggles.length];
    // Other windows (people or agents on this Mac) can come forward; keep the shared app in front.
    await front?.();
    const ms = await page.evaluate((input) => window.__lpBench.inputToPhoton(input), {
      ev,
      local,
      threshold,
      timeoutMs: 3000,
      ...(region ? { region } : {}),
    });
    if (ms === null) {
      misses += 1;
      if (process.env.LP_BENCH_DEBUG)
        console.log("miss", await page.evaluate(() => window.__lpLastProbe));
    } else values.push(ms);
    // Undo the input unmeasured (Resolve: stop playback again), so every sample starts still.
    if (reset) await reset();
    await sleep(350);
  }
  return { values, misses };
}

const stat = (page) => page.evaluate(() => window.__lpBench.snapshot().stats);

/** Frame rate, bitrate and drops on `page` over `ms` of motion, plus CPU of each side. */
async function motion(page, ms, { local = false, appPattern } = {}) {
  const before = local ? null : await stat(page);
  const groups = {
    host: electronPids(),
    viewer: local ? [] : viewerPids(),
    app: appPattern ? appPids(appPattern) : [],
  };
  const [frames, cpu] = await Promise.all([
    page.evaluate(
      ([duration, isLocal]) => window.__lpBench.sampleFrames(duration, isLocal),
      [ms, local],
    ),
    cpuOver(groups, Math.max(2, Math.round(ms / 1000) - 1)),
  ]);
  const after = local ? null : await stat(page);
  const decoded = after && before ? (after.framesDecoded ?? 0) - (before.framesDecoded ?? 0) : null;
  const dropped = after && before ? (after.framesDropped ?? 0) - (before.framesDropped ?? 0) : null;
  return {
    fps: Math.round(frames.fps * 10) / 10,
    gapP95: percentile(frames.gaps, 95),
    stats: after,
    droppedPct:
      decoded !== null && dropped !== null && decoded + dropped > 0
        ? Math.round((dropped / (decoded + dropped)) * 1000) / 10
        : null,
    cpu,
  };
}

const results = [];
const date = new Date().toISOString();
function record(entry) {
  const full = { date, machine, ...entry };
  results.push(full);
  console.log(JSON.stringify(full));
}

async function measureAll({
  scenario,
  app,
  toggles,
  startMotion,
  stopMotion,
  appPattern,
  threshold,
  region,
  prepare,
  reset,
  frontApp,
}) {
  let refocused = 0;
  front = async () => {
    // On the hidden display the app never needs to be in front.
    if (hidden) return;
    const top = osa(
      'tell application "System Events" to get name of first application process whose frontmost is true',
    );
    if (top === frontApp) return;
    refocused += 1;
    console.log(`refocus: ${top} was in front`);
    await op("app.activate", [frontApp]);
    await sleep(700);
  };
  // WebRTC peer to peer.
  if (prepare) await prepare();
  const rtcLatency = await latency(viewer, toggles, { threshold, region, reset });
  if (prepare) await prepare();
  await front?.();
  await startMotion?.();
  await sleep(1500);
  const rtcMotion = await motion(viewer, 10_000, { appPattern });
  await stopMotion?.();
  record({
    scenario,
    app,
    refocused_app: refocused,
    resolution: rtcMotion.stats?.width
      ? `${rtcMotion.stats.width}x${rtcMotion.stats.height}`
      : null,
    codec: rtcMotion.stats?.codec?.replace("video/", "") ?? null,
    transport: `webrtc-p2p-loopback${suffix}`,
    latency_ms_p50: percentile(rtcLatency.values, 50),
    latency_ms_p95: percentile(rtcLatency.values, 95),
    latency_samples: rtcLatency.values.length,
    latency_misses: rtcLatency.misses,
    fps_avg: startMotion ? rtcMotion.fps : null,
    frame_gap_ms_p95: startMotion ? rtcMotion.gapP95 : null,
    bitrate_kbps: rtcMotion.stats?.bitrateKbps ?? null,
    dropped_pct: rtcMotion.droppedPct,
    host_cpu_pct: rtcMotion.cpu.host ?? null,
    app_cpu_pct: rtcMotion.cpu.app ?? null,
    viewer_cpu_pct: rtcMotion.cpu.viewer ?? null,
  });

  // Baseline: capture on the host, no encode and no network.
  if (prepare) await prepare();
  const localLatency = await latency(host, toggles, { local: true, threshold, region, reset });
  if (prepare) await prepare();
  await front?.();
  await startMotion?.();
  await sleep(1500);
  let localMotion = await motion(host, 10_000, { local: true, appPattern });
  if (localMotion.fps === 0) {
    // Capture delivered nothing (the window was covered or capture paused): bring it back, once.
    console.log("local motion got no frames; retrying once");
    await front?.();
    await sleep(1000);
    localMotion = await motion(host, 10_000, { local: true, appPattern });
  }
  if (process.env.LP_BENCH_DEBUG)
    console.log(
      "host track after local motion:",
      await host.evaluate(() => window.__lpBench.trackState()),
    );
  await stopMotion?.();
  record({
    scenario,
    app,
    refocused_app: refocused,
    resolution: rtcMotion.stats?.width
      ? `${rtcMotion.stats.width}x${rtcMotion.stats.height}`
      : null,
    codec: "none (raw capture)",
    transport: `local-capture-baseline${suffix}`,
    latency_ms_p50: percentile(localLatency.values, 50),
    latency_ms_p95: percentile(localLatency.values, 95),
    latency_samples: localLatency.values.length,
    latency_misses: localLatency.misses,
    fps_avg: startMotion ? localMotion.fps : null,
    frame_gap_ms_p95: startMotion ? localMotion.gapP95 : null,
    dropped_pct: null,
    host_cpu_pct: localMotion.cpu.host ?? null,
    app_cpu_pct: localMotion.cpu.app ?? null,
  });

  // JPEG relay through the LogicPacks server (the fallback when no peer connection comes up).
  await viewerJpeg();
  if (prepare) await prepare();
  const jpegLatency = await latency(viewer, toggles, { threshold, region, reset });
  if (prepare) await prepare();
  await front?.();
  await startMotion?.();
  await sleep(1500);
  const jpegMotion = await motion(viewer, 10_000, { appPattern });
  await stopMotion?.();
  const frameSize = await viewer.evaluate(() => {
    const img = document.querySelector('[data-testid="live-machine-frame"]');
    return img ? `${img.naturalWidth}x${img.naturalHeight}` : null;
  });
  record({
    scenario,
    app,
    refocused_app: refocused,
    resolution: frameSize,
    codec: "jpeg q0.72, 15 fps cap",
    transport: `jpeg-relay-via-server-loopback${suffix}`,
    latency_ms_p50: percentile(jpegLatency.values, 50),
    latency_ms_p95: percentile(jpegLatency.values, 95),
    latency_samples: jpegLatency.values.length,
    latency_misses: jpegLatency.misses,
    fps_avg: startMotion ? jpegMotion.fps : null,
    frame_gap_ms_p95: startMotion ? jpegMotion.gapP95 : null,
    dropped_pct: null,
    host_cpu_pct: jpegMotion.cpu.host ?? null,
    app_cpu_pct: jpegMotion.cpu.app ?? null,
    viewer_cpu_pct: jpegMotion.cpu.viewer ?? null,
  });
}

const key = (code, extra = {}) => [
  { kind: "key", code, down: true, ...extra },
  { kind: "key", code, down: false, ...extra },
];
const omitted = [];

try {
  // ── Blender: a heavy scene in Material Preview, orbiting ─────────────────
  if (scenarios.includes("blender")) {
    await op("blender.open");
    await op("blender.python", [
      [
        "import bpy",
        "if 'LP_heavy_0' not in bpy.data.objects:",
        "    for i in range(16):",
        "        bpy.ops.mesh.primitive_monkey_add(location=((i % 4) * 2.6 - 3.9, (i // 4) * 2.6 - 3.9, 1.2))",
        "        o = bpy.context.active_object",
        "        o.name = 'LP_heavy_%d' % i",
        "        m = o.modifiers.new('sub', 'SUBSURF')",
        "        m.levels = 3",
        "for w in bpy.context.window_manager.windows:",
        // Timeline playback left running would repaint the window all the time and skew every number.
        "    if w.screen.is_animation_playing:",
        "        with bpy.context.temp_override(window=w, screen=w.screen):",
        "            bpy.ops.screen.animation_cancel(restore_frame=True)",
        "    for a in w.screen.areas:",
        "        if a.type == 'VIEW_3D':",
        "            a.spaces.active.shading.type = 'MATERIAL'",
        "            a.spaces.active.show_region_ui = False",
      ].join("\n"),
    ]);
    const tris = await op("blender.python", [
      "import bpy\ndg = bpy.context.evaluated_depsgraph_get()\nresult = sum(len(o.evaluated_get(dg).data.loop_triangles) if o.type == 'MESH' else 0 for o in bpy.context.scene.objects)",
    ]).catch(() => null);
    console.log(`blender scene: ${JSON.stringify(tris)}`);
    await hostShare("Blender");
    await viewerJoin();
    // Pointer over the 3D viewport, so N toggles its sidebar.
    const view = viewer.getByTestId("live-machine-view");
    const box = await view.boundingBox();
    await viewer.mouse.move(box.x + box.width * 0.35, box.y + box.height * 0.45, { steps: 4 });
    const orbit = (on) =>
      op("blender.python", [
        on
          ? [
              "import bpy, math, mathutils",
              "def _lp_orbit():",
              "    if not bpy.app.driver_namespace.get('lp_orbit'):",
              "        return None",
              "    for w in bpy.context.window_manager.windows:",
              "        for a in w.screen.areas:",
              "            if a.type == 'VIEW_3D':",
              "                r = a.spaces.active.region_3d",
              "                r.view_rotation = mathutils.Quaternion((0, 0, 1), math.radians(1.5)) @ r.view_rotation",
              "                a.tag_redraw()",
              "    return 1 / 60",
              "bpy.app.driver_namespace['lp_orbit'] = True",
              "bpy.app.timers.register(_lp_orbit)",
            ].join("\n")
          : "import bpy\nbpy.app.driver_namespace['lp_orbit'] = False",
      ]);
    await measureAll({
      scenario: "blender-viewport-heavy",
      frontApp: "Blender",
      app: "Blender 5.2.2, 16 subdivided monkeys, Material Preview",
      // The pointer goes over the 3D viewport first: Blender sends keys to the area under it.
      toggles: [[{ kind: "move", x: 0.35, y: 0.45 }, ...key("KeyN")]],
      startMotion: () => orbit(true),
      stopMotion: () => orbit(false),
      appPattern: /Blender\.app\/Contents\/MacOS\/Blender/,
      threshold: 0.7,
    });
    await host
      .getByTestId("live-machine-stop")
      .click()
      .catch(() => {});
  }

  // ── TextEdit: typing ────────────────────────────────────────────────────────
  if (scenarios.includes("text")) {
    // Our own document only, in big type so one character is a visible change.
    const docName = osa(
      `tell application "TextEdit"\n${hidden ? "" : "activate\n"}set d to make new document\nset text of d to "LogicPacks 888"\nset size of text of d to 160\nreturn name of d\nend tell`,
    );
    await sleep(1000);
    await hostShare("TextEdit", docName);
    await viewerJoin();
    const view = viewer.getByTestId("live-machine-view");
    const box = await view.boundingBox();
    await viewer.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5, { steps: 4 });
    const at = { kind: "move", x: 0.5, y: 0.5 };
    let typing = null;
    await measureAll({
      scenario: "text-editor",
      frontApp: "TextEdit",
      app: "TextEdit (macOS 26), 160 pt text, typing 20 keys/s",
      // Delete a large character, then type an 8 (digits have no press-and-hold accent menu). Deleting first
      // makes TextEdit take its typing size from the 160 pt text, so each input adds or removes one big glyph.
      toggles: [
        [at, ...key("Backspace")],
        [at, ...key("Digit8")],
      ],
      startMotion: async () => {
        // Typing through the control path at 20 keys a second, 8 then Backspace.
        typing = setInterval(() => {
          void viewer.evaluate(() => {
            const bench = window.__lpBench;
            const odd = (window.__lpTyped = (window.__lpTyped ?? 0) + 1) % 2 === 1;
            const code = odd ? "Backspace" : "Digit8";
            bench.input?.([
              { kind: "key", code, down: true },
              { kind: "key", code, down: false },
            ]);
          });
        }, 50);
      },
      stopMotion: async () => {
        if (typing) clearInterval(typing);
        typing = null;
      },
      appPattern: /TextEdit\.app\/Contents\/MacOS\/TextEdit/,
      threshold: 0.7,
    });
    await host
      .getByTestId("live-machine-stop")
      .click()
      .catch(() => {});
    osa(
      `tell application "TextEdit" to close (every document whose name is "${docName}") saving no`,
    );
  }

  // ── DaVinci Resolve ─────────────────────────────────────────────────────────
  if (scenarios.includes("resolve")) {
    const status = await api("/api/lp/apps/run", { projectId, op: "resolve.status", args: [] });
    console.log(`resolve.status: ${status.status} ${JSON.stringify(status.body).slice(0, 300)}`);
    const running = appPids(/DaVinci Resolve\.app\/Contents\/MacOS\/Resolve/).length > 0;
    if (!running) {
      omitted.push({
        scenario: "resolve-playback",
        reason:
          "DaVinci Resolve was not open on a timeline with media. Run with Resolve open, a project loaded and a timeline with a clip on the Edit page.",
      });
    } else {
      await hostShare("DaVinci Resolve");
      await viewerJoin();
      const view = viewer.getByTestId("live-machine-view");
      const box = await view.boundingBox();
      await viewer.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.3, { steps: 4 });
      // Space through the control path, so it works the same with Resolve in front or on the hidden display.
      const space = () =>
        viewer.evaluate(() =>
          window.__lpBench.input([
            { kind: "key", code: "Space", down: true },
            { kind: "key", code: "Space", down: false },
          ]),
        );
      await measureAll({
        scenario: "resolve-playback",
        frontApp: "DaVinci Resolve",
        app: "DaVinci Resolve 21.1.2 (free), Edit page, 1080p test clip",
        // Space starts playback; the viewer and timecode change at once. Each sample starts stopped.
        toggles: [key("Space")],
        reset: async () => {
          await sleep(500);
          await space();
          await sleep(600);
        },
        startMotion: space,
        stopMotion: space,
        appPattern: /DaVinci Resolve\.app\/Contents\/MacOS\/Resolve/,
        threshold: 0.7,
      });
      await host
        .getByTestId("live-machine-stop")
        .click()
        .catch(() => {});
    }
  }
} finally {
  await browser.close().catch(() => {});
  await electron.close().catch(() => {});
}

// The landing page's research format, with every measured row kept in `runs`.
const previous = NodeFS.existsSync(outFile) ? JSON.parse(NodeFS.readFileSync(outFile, "utf8")) : {};
const runs = [
  ...(previous.runs ?? []).filter(
    (row) => !results.some((r) => r.scenario === row.scenario && r.transport === row.transport),
  ),
  ...results,
];
const pickRuns = (scenario, transport, field) =>
  runs.find((row) => row.scenario === scenario && row.transport === transport)?.[field] ?? null;
const document = {
  updated: date.slice(0, 10),
  note: 'Only measured numbers go here. An entry with "value": null shows as "Benchmark running" on /research. Streaming entries are filled by the app-stream runs.',
  machine,
  methodology: [
    "Input to photon on the viewer's clock: one input through the control path, injected into the app on the host, captured (ScreenCaptureKit through Electron), encoded, sent, and timed at the first painted frame whose 96x60 downsample changed.",
    "Each input makes a large change (Blender's sidebar opening or closing, Resolve starting playback, one 160 pt character typed or deleted in TextEdit), 15 samples per row. The input is sent only after the picture has been still for 400 ms.",
    "Hidden display rows: the shared window runs on a virtual display off the host's screen and input is posted to the app alone; the host's cursor and front app are untouched.",
    "Frame rate: painted frames per second on the viewer over 10 s of constant motion. Capture only delivers frames when pixels change.",
    "Host CPU: top's second sample, summed over the desktop app's processes and lp-appctl (100 = one core).",
    "Baseline local-capture: the same input injected on the host and timed on raw capture frames, no encode or network.",
    "Viewer and host are the same Mac (loopback), so the network adds nothing and the viewer's decode shares the CPU. No TURN relay exists yet; none is measured.",
  ],
  streaming: [
    {
      id: "resolve-playback",
      title: "DaVinci Resolve playback",
      detail: "Timeline playback in a shared app view, viewer on the same machine (WebRTC).",
      metrics: [
        {
          label: "Glass to glass latency",
          unit: "ms",
          value: pickRuns("resolve-playback", "webrtc-p2p-loopback", "latency_ms_p50"),
        },
        {
          label: "Frame rate",
          unit: "fps",
          value: pickRuns("resolve-playback", "webrtc-p2p-loopback", "fps_avg"),
        },
      ],
    },
    {
      id: "blender-viewport",
      title: "Heavy Blender viewport",
      detail:
        "Orbiting a dense scene in Material Preview in a shared app view, viewer on the same machine (WebRTC).",
      metrics: [
        {
          label: "Input to screen latency",
          unit: "ms",
          value: pickRuns("blender-viewport-heavy", "webrtc-p2p-loopback", "latency_ms_p50"),
        },
        {
          label: "Frame rate",
          unit: "fps",
          value: pickRuns("blender-viewport-heavy", "webrtc-p2p-loopback", "fps_avg"),
        },
      ],
    },
    {
      id: "text-editor",
      title: "Text editor",
      detail: "Typing in a shared TextEdit window, viewer on the same machine (WebRTC).",
      metrics: [
        {
          label: "Input to screen latency",
          unit: "ms",
          value: pickRuns("text-editor", "webrtc-p2p-loopback", "latency_ms_p50"),
        },
        {
          label: "Frame rate",
          unit: "fps",
          value: pickRuns("text-editor", "webrtc-p2p-loopback", "fps_avg"),
        },
      ],
    },
  ],
  runs,
  omitted: [
    ...(previous.omitted ?? []).filter(
      (row) =>
        !omitted.some((o) => o.scenario === row.scenario) &&
        !results.some((r) => r.scenario === row.scenario),
    ),
    ...omitted,
    {
      scenario: "any",
      transport: "turn-relay",
      reason:
        "No TURN server is deployed (nothing paid; a self-hosted coturn is the documented next step), so relay beyond the LAN is not measured.",
    },
  ].filter(
    (row, index, all) =>
      all.findIndex(
        (other) => other.scenario === row.scenario && other.transport === row.transport,
      ) === index,
  ),
};
NodeFS.mkdirSync(NodePath.dirname(outFile), { recursive: true });
NodeFS.writeFileSync(outFile, `${JSON.stringify(document, null, 2)}\n`);
console.log(`wrote ${outFile}`);
process.exit(0);
