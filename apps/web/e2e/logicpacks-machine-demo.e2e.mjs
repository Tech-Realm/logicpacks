#!/usr/bin/env node
// E2E and screenshots for /demo/machine: opens it from the sidebar, checks play, pause and window
// switching, then shoots fixed `?t=` times (the timeline is deterministic). Needs a built web client.
// `node apps/web/e2e/logicpacks-machine-demo.e2e.mjs --out <dir> [--port 3822] [--width 1600]`
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { startDevWeb, webPortArg } from "./lpDevWeb.mjs";

const require = NodeModule.createRequire(import.meta.url);
const { chromium } = require("playwright");

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};
const port = Number(arg("--port", "3822"));
const width = Number(arg("--width", "1600"));
const out = NodePath.resolve(arg("--out", "screens/machine-demo"));
const devWebPort = webPortArg(args);
const base = devWebPort ? `http://127.0.0.1:${devWebPort}` : `http://127.0.0.1:${port}`;
const repo = NodePath.join(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "../../..");
const serverDir = NodePath.join(repo, "apps/server");
const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lp-demo-"));
NodeFS.mkdirSync(out, { recursive: true });

const server = NodeChildProcess.spawn(
  process.execPath,
  ["src/bin.ts", "serve", "--port", String(port), "--host", "127.0.0.1"].concat([
    "--base-dir",
    home,
    "--no-browser",
  ]),
  {
    cwd: serverDir,
    env: { ...process.env, LOGICPACKS_SYNC_SECONDS: "0" },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  },
);
const stopServer = (signal) => {
  try {
    process.kill(-server.pid, signal);
  } catch {
    // Already gone.
  }
};
let serverLog = "";
const ready = new Promise((resolve, reject) => {
  const onData = (chunk) => {
    serverLog += chunk;
    if (serverLog.includes("server is ready")) resolve();
  };
  server.stdout.on("data", onData);
  server.stderr.on("data", onData);
  server.on("exit", (code) =>
    reject(new Error(`server exited (${code})\n${serverLog.slice(-2000)}`)),
  );
});

const checks = [];
const check = (name, ok, detail = "") => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
};
const demoState = (page) =>
  page.getByTestId("machine-demo").evaluate((node) => ({
    time: Number(node.getAttribute("data-demo-time")),
    app: node.getAttribute("data-demo-app"),
  }));

const SHOTS = [
  [3, "01-blender-live"],
  [7, "02-agent-cursors"],
  [16.6, "03-snapshot"],
  [30, "04-resolve-agents-talking"],
  [37, "05-browser"],
  [44.5, "06-merge-replay"],
  [47, "07-conflict"],
  [50.5, "08-agent-resolving"],
  [53, "09-resolved"],
  [57, "10-merged"],
  [62, "11-code"],
  [69, "12-everyone"],
];

let browser;
let failed = false;
const devWeb = devWebPort ? startDevWeb({ repo, serverPort: port, webPort: devWebPort }) : null;
try {
  await ready;
  await devWeb?.ready;
  browser = await chromium.launch({
    headless: true,
    channel: process.env.LP_E2E_BROWSER_CHANNEL ?? "chrome",
  });
  const context = await browser.newContext({
    viewport: { width, height: Math.round(width * 0.5625) },
    colorScheme: "dark",
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  await page.goto(`${base}/lp/login`);
  await page.click("#toggle");
  await page.fill("#name", "Mira");
  await page.fill("#email", `mira-${Date.now().toString(36)}@example.com`);
  await page.fill("#password", "correct-horse-battery");
  await page.click("#submit");
  await page.waitForURL(`${base}/`, { timeout: 30_000 });

  await page.getByTestId("lp-invite").waitFor({ timeout: 30_000 });
  check(
    "signed-in sidebar has no demo links (a locked member sees no Any app either)",
    (await page.getByTestId("any-app-demo-entry").count()) === 0 &&
      (await page.getByTestId("packs-demo-entry").count()) === 0,
  );
  await page.goto(`${base}/demo/machine`);
  await page.getByTestId("machine-demo").waitFor({ timeout: 15_000 });
  check("demo route opens by direct URL", true, page.url());
  check("demo is labelled Beta", await page.getByTestId("machine-demo-coming-soon").isVisible());

  const before = await demoState(page);
  await page.waitForTimeout(2_000);
  const after = await demoState(page);
  check(
    "autoplay advances the timeline",
    after.time - before.time > 1_000,
    `${before.time} → ${after.time}`,
  );
  await page.getByTestId("machine-demo-play").click();
  const paused = await demoState(page);
  await page.waitForTimeout(800);
  check("pause stops the clock", (await demoState(page)).time === paused.time, String(paused.time));
  await page.keyboard.press("Space");
  await page.waitForTimeout(600);
  check("Space plays again", (await demoState(page)).time > paused.time);
  await page
    .getByTestId("machine-demo-windows")
    .getByRole("button", { name: /DaVinci Resolve/ })
    .click();
  const switched = await demoState(page);
  check("window strip switches the live view", switched.app === "resolve", switched.app);

  for (const [seconds, name] of SHOTS) {
    await page.goto(`${base}/demo/machine?t=${seconds}&autoplay=0`);
    await page.getByTestId("machine-demo").waitFor({ timeout: 15_000 });
    await page.waitForFunction(() =>
      [...document.querySelectorAll("[data-testid='machine-demo'] img")].every(
        (image) => image.complete,
      ),
    );
    await page.waitForTimeout(700);
    const file = NodePath.join(out, `machine-${name}.png`);
    await page.screenshot({ path: file });
    const state = await demoState(page);
    check(
      `shot ${name}`,
      Math.abs(state.time - seconds * 1000) < 2,
      `${state.app} at ${state.time}`,
    );
  }
  failed = checks.some((item) => !item.ok);
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  await browser?.close();
  devWeb?.stop();
  stopServer("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 500));
  stopServer("SIGKILL");
  NodeFS.rmSync(home, { recursive: true, force: true });
}
console.log(
  `${checks.filter((item) => item.ok).length}/${checks.length} checks passed, shots in ${out}`,
);
process.exit(failed ? 1 : 0);
