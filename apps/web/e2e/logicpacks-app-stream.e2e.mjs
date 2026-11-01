#!/usr/bin/env node
// LogicPacks "Any app" live, end to end, on a real Mac with Blender installed:
//   node apps/web/e2e/logicpacks-app-stream.e2e.mjs --home <LOGICPACKS_HOME> [--web http://127.0.0.1:5741]
//        [--backend http://127.0.0.1:3881] [--cdp http://127.0.0.1:9341] [--out <dir>] [--project <id>]
//
// It drives a running desktop dev build (the host) over CDP and a member in Chrome. Bring the stack up first:
//   web:     PORT=5741 LOGICPACKS_PORT=3881 vp dev --host 127.0.0.1 --port 5741        (apps/web)
//   desktop: VITE_DEV_SERVER_URL=http://127.0.0.1:5741 LOGICPACKS_HOME=<tmp> LOGICPACKS_PORT=3881 \
//            LOGICPACKS_DESKTOP_REMOTE_DEBUGGING_PORT=9341 \
//            node scripts/dev-electron.mjs                                        (apps/desktop, after vp pack
//            in apps/server and apps/desktop)
// The desktop app (or the terminal that started it) needs Screen Recording and Accessibility.
// Mira redeems an access code for "apps", Lena does not. The host shares Blender; Mira watches, asks for control,
// moves the Vase with the keyboard, her agent runs `lp app run`, the host revokes and stops sharing.
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
const shotsDir = flag("--out");
if (!home) throw new Error("--home <the desktop app's LOGICPACKS_HOME> is required");
const repo = NodePath.join(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "../../..");
const serverDir = NodePath.join(repo, "apps/server");
const helperCli = NodePath.join(repo, "packages/helper/src/cli.ts");
const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lp-app-stream-e2e-"));
const PASSWORD = "correct-horse-battery";
const MIRA = "mira@example.test";
const LENA = "lena@example.test";
if (shotsDir) NodeFS.mkdirSync(shotsDir, { recursive: true });

const results = [];
const metrics = {};
let failed = false;
async function step(name, body) {
  if (failed) {
    results.push({ name, ok: false, error: "skipped after an earlier failure" });
    return;
  }
  const started = Date.now();
  try {
    await body();
    results.push({ name, ok: true, ms: Date.now() - started });
    console.log(`PASS ${name}`);
  } catch (error) {
    failed = true;
    results.push({ name, ok: false, error: String(error?.message ?? error) });
    console.log(`FAIL ${name}\n     ${String(error?.message ?? error).split("\n")[0]}`);
  }
}
const expect = (condition, message) => {
  if (!condition) throw new Error(message);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(what, probe, timeoutMs = 20_000, everyMs = 250) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await probe();
    if (last) return last;
    await sleep(everyMs);
  }
  throw new Error(`timed out waiting for ${what}`);
}
const shot = async (page, name) => {
  if (shotsDir) await page.screenshot({ path: NodePath.join(shotsDir, `${name}.png`) });
};

const operatorToken = NodeChildProcess.execFileSync(
  process.execPath,
  ["src/bin.ts", "auth", "session", "issue", "--base-dir", home, "--token-only"],
  { cwd: serverDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
)
  .split("\n")
  .find((line) => line.startsWith("eyJ"));
if (!operatorToken) throw new Error("could not issue an operator token for --home");

async function api(path, body, token = operatorToken) {
  const response = await fetch(`${backend}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}
/** A member's request from their own page, so their session cookie is the credential. */
const pageApi = (page, path, body) =>
  page.evaluate(
    async ({ path, body }) => {
      const response = await fetch(path, {
        method: body === undefined ? "GET" : "POST",
        credentials: "include",
        headers: body === undefined ? {} : { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: await response.json().catch(() => ({})) };
    },
    { path, body },
  );
let projectId = flag("--project");
const runOp = (op, opArgs = [], extra = {}) =>
  api("/api/lp/apps/run", { projectId, op, args: opArgs, ...extra });
const vase = async () => {
  const out = await runOp("blender.objects", [], { as: "human" });
  return out.body.result?.objects?.find((object) => object.name === "Vase") ?? null;
};
function lp(helperHome, ...cliArgs) {
  const result = NodeChildProcess.spawnSync(process.execPath, [helperCli, ...cliArgs], {
    encoding: "utf8",
    env: {
      ...process.env,
      LP_HELPER_HOME: helperHome,
      HOME: scratch,
      CLAUDE_CONFIG_DIR: NodePath.join(scratch, "claude"),
      CODEX_HOME: NodePath.join(scratch, "codex"),
    },
  });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

async function signIn(page, name, email) {
  await page.goto(`${web}/lp/login?mode=signup`);
  await page.fill("#name", name);
  await page.fill("#email", email);
  await page.fill("#password", PASSWORD);
  await page.click("#submit");
  const joined = await page
    .waitForURL(`${web}/`, { timeout: 8_000 })
    .then(() => true)
    .catch(() => false);
  if (joined) return;
  // A rerun: the account exists already.
  await page.goto(`${web}/lp/login`);
  await page.fill("#email", email);
  await page.fill("#password", PASSWORD);
  await page.click("#submit");
  await page.waitForURL(`${web}/`, { timeout: 20_000 });
}

let browser;
let electron;
let host;
let mira;
let lena;
try {
  await step("setup: a Blender project with a Vase, open on the host", async () => {
    if (!projectId) {
      const created = await api("/api/lp/projects/new", {
        kind: "empty",
        name: "Vase scene",
        recipe: "blender",
      });
      expect(created.status === 201, `create: ${created.status} ${JSON.stringify(created.body)}`);
      projectId = created.body.projectId;
    }
    const opened = await runOp("blender.open", [], { noSnapshot: true });
    expect(opened.status === 200, `blender.open: ${JSON.stringify(opened.body)}`);
    if ((await vase()) === null) {
      const added = await runOp("blender.add", ["cylinder", "Vase", "0", "0", "0"], {
        noSnapshot: true,
      });
      expect(added.status === 200, `blender.add: ${JSON.stringify(added.body)}`);
    }
    await runOp("blender.move", ["Vase", "0", "0", "0"], { noSnapshot: true });
    const select = await runOp(
      "blender.python",
      [
        "import bpy\nfor o in bpy.context.view_layer.objects: o.select_set(o.name == 'Vase')\nbpy.context.view_layer.objects.active = bpy.data.objects['Vase']",
      ],
      { noSnapshot: true },
    );
    expect(select.status === 200, `select Vase: ${JSON.stringify(select.body)}`);
    expect((await vase())?.location[2] === 0, "Vase is not at z 0");
  });

  await step("setup: Mira redeems an apps access code; Lena (locked) does not", async () => {
    browser = await chromium.launch({
      headless: true,
      channel: process.env.LP_E2E_BROWSER_CHANNEL ?? "chrome",
    });
    const context = () =>
      browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
    mira = await (await context()).newPage();
    lena = await (await context()).newPage();
    await signIn(mira, "Mira", MIRA);
    await signIn(lena, "Lena", LENA);
    for (const user of [MIRA, LENA]) {
      const added = await api("/api/lp/members", { projectId, user, role: "member" });
      expect(added.status === 200, `add ${user}: ${added.status} ${JSON.stringify(added.body)}`);
    }
    // The host owner is staff: it mints a one-use code for "apps" and Mira redeems it.
    const minted = await api("/api/lp/ops/codes", {
      features: ["apps"],
      maxUses: 1,
      expiresInDays: 1,
      note: "app-stream e2e",
    });
    expect(
      minted.status === 201 && minted.body.code,
      `code: ${minted.status} ${JSON.stringify(minted.body)}`,
    );
    const before = await pageApi(mira, "/api/lp/features");
    if (!before.body.features?.includes("apps")) {
      const redeemed = await pageApi(mira, "/api/lp/features/redeem", { code: minted.body.code });
      expect(
        redeemed.status === 200,
        `redeem: ${redeemed.status} ${JSON.stringify(redeemed.body)}`,
      );
    }
    const miraFeatures = await pageApi(mira, "/api/lp/features");
    const lenaFeatures = await pageApi(lena, "/api/lp/features");
    expect(miraFeatures.body.features?.includes("apps"), "Mira should have the apps feature");
    expect(!lenaFeatures.body.features?.includes("apps"), "Lena should not have the apps feature");
  });

  await step("locked: Lena gets feature_locked from the server and from lp app", async () => {
    const ticket = await pageApi(lena, "/api/lp/appstream/ticket", { projectId });
    expect(
      ticket.status === 403 && ticket.body.error === "feature_locked",
      `ticket: ${ticket.status} ${JSON.stringify(ticket.body)}`,
    );
    const ops = await pageApi(lena, `/api/lp/apps/ops?projectId=${projectId}`);
    expect(ops.status === 403 && ops.body.error === "feature_locked", `ops: ${ops.status}`);
    const run = await pageApi(lena, "/api/lp/apps/run", {
      projectId,
      op: "blender.objects",
      args: [],
    });
    expect(run.status === 403 && run.body.error === "feature_locked", `run: ${run.status}`);
    const token = await pageApi(lena, "/api/lp/helper/token", { device: "lena-laptop" });
    const lenaHome = NodePath.join(scratch, "lena-helper");
    lp(lenaHome, "login", "--server", backend, "--token", token.body.token, "--no-mcp");
    const cli = lp(lenaHome, "app", "ops", "--project", projectId);
    expect(
      cli.code !== 0 && /not unlocked|feature_locked/i.test(cli.out),
      `lp app ops as Lena: ${cli.code} ${cli.out.slice(0, 200)}`,
    );
  });

  await step("locked: Lena sees no Any app entry and no live view, not even by URL", async () => {
    await lena.goto(`${web}/`);
    await lena
      .getByTestId("lp-workspace-people")
      .waitFor({ timeout: 20_000 })
      .catch(() => {});
    await sleep(1500);
    expect((await lena.getByTestId("any-app-demo-entry").count()) === 0, "Lena sees Any app");
    await lena.goto(`${web}/machine?project=${projectId}`);
    await sleep(3000);
    expect((await lena.getByTestId("live-machine").count()) === 0, "Lena sees the live view");
    expect((await lena.getByTestId("live-machine-pick").count()) === 0, "Lena sees the picker");
    await shot(lena, "00-locked-member");
  });

  await step("host: the desktop app shares the Blender window", async () => {
    electron = await chromium.connectOverCDP(cdp);
    host = electron
      .contexts()
      .flatMap((context) => context.pages())
      .find((page) => page.url().startsWith("logicpacks-dev://") || page.url().startsWith("http"));
    expect(host, "no desktop app window over CDP");
    await host.evaluate((id) => {
      location.hash = `#/machine?project=${id}`;
    }, projectId);
    await host
      .locator('[data-testid="live-machine"][data-role="host"]')
      .waitFor({ timeout: 20_000 });
    // The window has to be on screen to be captured: bring Blender forward on the host.
    await runOp("app.activate", ["Blender"]);
    await sleep(1500);
    await host.getByRole("button", { name: "Refresh windows" }).click();
    const blender = host.locator('[data-testid="live-machine-window"][data-app="Blender"]');
    await blender.first().waitFor({ timeout: 15_000 });
    await blender.first().click();
    await host.getByTestId("live-machine-live").waitFor({ timeout: 15_000 });
    // A rerun: grants from an earlier run that stopped halfway are still live; start clean.
    await host.getByTestId("live-machine-kill").click();
    await shot(host, "01-host-sharing");
  });

  await step("member: Mira sees the host's Blender live over WebRTC", async () => {
    await mira.goto(`${web}/`);
    await mira.getByTestId("any-app-demo-entry").waitFor({ timeout: 20_000 });
    await mira.goto(`${web}/machine?project=${projectId}`);
    await mira.getByTestId("live-machine").waitFor({ timeout: 20_000 });
    const transport = await waitFor(
      "a picture",
      () =>
        mira.evaluate(() => {
          const video = document.querySelector('[data-testid="live-machine-video"]');
          if (video && video.videoWidth > 0)
            return `webrtc ${video.videoWidth}x${video.videoHeight}`;
          const frame = document.querySelector('[data-testid="live-machine-frame"]');
          return frame && frame.naturalWidth > 0
            ? `jpeg ${frame.naturalWidth}x${frame.naturalHeight}`
            : null;
        }),
      25_000,
    );
    await sleep(2500);
    const stats = await mira.evaluate(() => window.__lpBench?.snapshot().stats ?? null);
    metrics.viewer = { transport, ...stats };
    console.log(`     ${transport}, ${JSON.stringify(stats)}`);
    await shot(mira, "02-member-watching");
  });

  await step("control: Mira asks, the host allows her for 15 minutes", async () => {
    await mira.getByTestId("live-machine-request-control").click();
    await host.getByTestId("live-machine-request").waitFor({ timeout: 10_000 });
    await shot(host, "03-host-request");
    await host.getByTestId("live-machine-approve").first().click();
    await mira.getByTestId("live-machine-you-control").waitFor({ timeout: 10_000 });
    await host.getByTestId("live-machine-grant").waitFor({ timeout: 10_000 });
  });

  await step("control: Mira's cursor shows on the host; she moves the Vase up by 1", async () => {
    const view = mira.getByTestId("live-machine-view");
    const box = await view.boundingBox();
    // Over the 3D viewport (left of the outliner and properties).
    await mira.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.45, { steps: 8 });
    await host
      .locator('[data-testid="live-machine-cursor"][data-cursor-name="Mira"]')
      .waitFor({ timeout: 10_000 });
    await view.evaluate((element) => element.focus());
    for (const key of ["g", "z", "1", "Enter"]) {
      await mira.keyboard.press(key);
      await sleep(120);
    }
    const moved = await waitFor(
      "the Vase to move",
      async () => {
        const object = await vase();
        return object && Math.abs(object.location[2] - 1) < 0.01 ? object : null;
      },
      10_000,
    );
    console.log(`     Vase z ${moved.location[2]}`);
    await sleep(800);
    await shot(mira, "04-member-moved-vase");
    await shot(host, "05-host-sees-cursor");
  });

  await step(
    "agent: Mira's Claude runs lp app run; it is logged with a snapshot first",
    async () => {
      const token = await pageApi(mira, "/api/lp/helper/token", { device: "mira-laptop" });
      expect(token.body.token, `no helper token: ${JSON.stringify(token.body)}`);
      const miraHome = NodePath.join(scratch, "mira-helper");
      lp(miraHome, "login", "--server", backend, "--token", token.body.token, "--no-mcp");
      const out = lp(
        miraHome,
        "app",
        "run",
        "blender.move",
        "Vase",
        "x",
        "1.5",
        "--project",
        projectId,
        "--agent",
        "Claude",
        "--json",
      );
      expect(out.code === 0, `lp app run: ${out.code} ${out.out.slice(0, 300)}`);
      const reply = JSON.parse(out.out.slice(out.out.indexOf("{")));
      expect(reply.autoSnapshot, `no automatic snapshot: ${out.out.slice(0, 300)}`);
      expect(Math.abs((await vase()).location[0] - 1.5) < 0.01, "the agent's move did not land");
      const logs = await api(`/api/lp/apps/log?projectId=${projectId}`);
      const entry = logs.body.entries?.find(
        (line) => line.actor === "Mira's Claude" && line.op === "blender.move",
      );
      expect(entry, "no log line for Mira's Claude");
      await mira
        .getByTestId("live-machine-log-entry")
        .filter({ hasText: "Mira's Claude" })
        .first()
        .waitFor({ timeout: 10_000 });
      await mira.getByTestId("live-machine-snapshot-row").first().waitFor({ timeout: 15_000 });
      metrics.agentLog = `${entry.actor}: ${entry.op} ${entry.detail}`;
      await shot(mira, "06-agent-op-logged");
    },
  );

  await step(
    "revoke: after the host revokes, Mira's keys and her agent's edits are refused",
    async () => {
      await host.getByTestId("live-machine-revoke").first().click();
      await mira.getByTestId("live-machine-request-control").waitFor({ timeout: 10_000 });
      const before = (await vase()).location[2];
      const view = mira.getByTestId("live-machine-view");
      await view.evaluate((element) => element.focus());
      for (const key of ["g", "z", "1", "Enter"]) await mira.keyboard.press(key);
      await sleep(1500);
      expect((await vase()).location[2] === before, "a revoked viewer still moved the Vase");
      const sneaky = await pageApi(mira, "/api/lp/apps/run", {
        projectId,
        op: "blender.move",
        args: ["Vase", "z", "5"],
      });
      expect(sneaky.status === 403 && sneaky.body.error === "not_granted", `run: ${sneaky.status}`);
      await shot(host, "07-host-revoked");
    },
  );

  await step("kill switch: Stop all control ends every grant at once", async () => {
    await mira.getByTestId("live-machine-request-control").click();
    await host.getByTestId("live-machine-approve").first().click();
    await mira.getByTestId("live-machine-you-control").waitFor({ timeout: 10_000 });
    await host.getByTestId("live-machine-kill").click();
    await mira.getByTestId("live-machine-request-control").waitFor({ timeout: 10_000 });
    expect((await host.getByTestId("live-machine-grant").count()) === 0, "a grant survived");
  });

  await step("restore: the snapshot brings the Vase back to before the agent's edit", async () => {
    const snapshots = await runOp("blender.snapshots", [], { as: "human" });
    const auto = snapshots.body.result?.snapshots?.find((s) => String(s.name).startsWith("auto"));
    expect(auto, `no auto snapshot in ${JSON.stringify(snapshots.body).slice(0, 300)}`);
    const restored = await runOp("blender.restore", [auto.name]);
    expect(restored.status === 200, `restore: ${JSON.stringify(restored.body).slice(0, 300)}`);
    const object = await vase();
    expect(Math.abs(object.location[0]) < 0.01, `Vase x is ${object.location[0]} after restore`);
  });

  await step("stop: the host stops sharing; Mira waits for the host", async () => {
    await host.getByTestId("live-machine-stop").click();
    await mira.getByTestId("live-machine-empty").waitFor({ timeout: 10_000 });
    await shot(mira, "08-member-after-stop");
  });
} finally {
  await browser?.close().catch(() => {});
  // Leave the desktop app running: it belongs to whoever started it.
  if (electron) await electron.close().catch(() => {});
  NodeFS.rmSync(scratch, { recursive: true, force: true });
}

console.log(JSON.stringify({ projectId, metrics }, null, 2));
const passed = results.filter((result) => result.ok).length;
console.log(`\n${passed}/${results.length} steps passed`);
if (shotsDir) {
  NodeFS.writeFileSync(
    NodePath.join(shotsDir, "results.json"),
    JSON.stringify({ results, metrics }, null, 2),
  );
}
process.exit(passed === results.length ? 0 : 1);
