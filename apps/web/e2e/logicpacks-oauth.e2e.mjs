#!/usr/bin/env node
// Sign in with Google and GitHub, Connect Cloudflare and the "How do you work?" onboarding,
// end to end on the mock providers:
//   node apps/web/e2e/logicpacks-oauth.e2e.mjs [--port 3830] [--web-port 5830] [--keep]
// Runs the server against a Vite dev server (no web build needed; --reuse-web uses one
// already on --web-port started with LOGICPACKS_PORT=<port>) and drives Chrome
// (LP_E2E_BROWSER_CHANNEL=chromium for Playwright's own). Screenshots: LP_E2E_SHOTS=<dir>.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const require = NodeModule.createRequire(import.meta.url);
const { chromium } = require("playwright");

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 ? Number(args[at + 1]) : fallback;
};
const port = flag("--port", 3830);
const webPort = flag("--web-port", 5830);
const keep = args.includes("--keep");
// Use a Vite already serving --web-port (its first dependency scan is slow on a cold cache).
const reuseWeb = args.includes("--reuse-web");
// The browser talks to Vite, which proxies /api and /lp to the server.
const base = `http://127.0.0.1:${webPort}`;
const repo = NodePath.join(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "../../..");
const serverDir = NodePath.join(repo, "apps/server");
const webDir = NodePath.join(repo, "apps/web");
const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lp-oauth-e2e-"));
const run = Date.now().toString(36);
const shotsDir = process.env.LP_E2E_SHOTS;
if (shotsDir) NodeFS.mkdirSync(shotsDir, { recursive: true });

const children = [];
const spawn = (command, commandArgs, options, readyText) => {
  const child = NodeChildProcess.spawn(command, commandArgs, {
    ...options,
    stdio: ["ignore", "pipe", "pipe"],
    // Both relaunch or fork; a process group lets teardown stop the whole tree.
    detached: true,
  });
  children.push(child);
  let log = "";
  const ready = new Promise((resolve, reject) => {
    const onData = (chunk) => {
      log += chunk;
      if (readyText.test(log)) resolve();
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code) =>
      reject(new Error(`${command} exited (${code})\n${log.slice(-2000)}`)),
    );
  });
  return { child, ready, log: () => log };
};
const stopAll = async () => {
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    for (const child of children) {
      try {
        process.kill(-child.pid, signal);
      } catch {
        // Already gone.
      }
    }
    if (signal === "SIGTERM") await new Promise((resolve) => setTimeout(resolve, 1500));
  }
};

const web = reuseWeb
  ? { ready: Promise.resolve(), log: () => "" }
  : spawn(
      NodePath.join(webDir, "node_modules/.bin/vp"),
      ["dev", "--host", "127.0.0.1"],
      {
        cwd: webDir,
        env: { ...process.env, PORT: String(webPort), LOGICPACKS_PORT: String(port) },
      },
      /Local:|ready in/i,
    );
const server = spawn(
  process.execPath,
  [
    "src/bin.ts",
    "serve",
    "--port",
    String(port),
    "--host",
    "127.0.0.1",
    "--base-dir",
    home,
    "--no-browser",
    "--dev-url",
    `${base}/`,
  ],
  {
    cwd: serverDir,
    env: {
      ...process.env,
      LOGICPACKS_MEMBERS_LANDING: "true",
      LOGICPACKS_SYNC_SECONDS: "0",
      // Callbacks come back through the Vite origin the browser uses.
      LOGICPACKS_CLOUD_URL: base,
      LOGICPACKS_GOOGLE_PROVIDER: "mock",
      LOGICPACKS_GITHUB_PROVIDER: "mock",
      LOGICPACKS_CLOUDFLARE_PROVIDER: "mock",
    },
  },
  /server is ready/,
);

const results = [];
const pages = [];
let failed = false;
async function step(name, body) {
  const started = Date.now();
  try {
    await body();
    results.push({ name, ok: true, ms: Date.now() - started });
    console.log(`PASS ${name}`);
  } catch (error) {
    failed = true;
    results.push({
      name,
      ok: false,
      ms: Date.now() - started,
      error: String(error?.message ?? error),
    });
    console.log(`FAIL ${name}\n     ${String(error?.message ?? error).split("\n")[0]}`);
  }
  if (shotsDir) {
    for (const [index, page] of pages.entries()) {
      await page
        .screenshot({ path: NodePath.join(shotsDir, `${results.length}-${index}.png`) })
        .catch(() => undefined);
    }
  }
}
const expect = (condition, message) => {
  if (!condition) throw new Error(message);
};
const session = (page) => page.evaluate(() => fetch("/api/lp/session").then((r) => r.json()));

/** The mock provider's consent screen: who signs in, then back to the host. */
async function consent(page, email, name) {
  await page.waitForSelector("#mock-form", { timeout: 30_000 });
  await page.fill("#mock-email", email);
  if (name) await page.fill("#mock-name", name);
  await Promise.all([
    page.waitForURL(`${base}/`, { timeout: 30_000 }),
    page.click("#mock-continue"),
  ]);
}

async function newPage(browser) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  pages.push(page);
  return page;
}

let browser;
try {
  await Promise.all([web.ready, server.ready]);
  browser = await chromium.launch({
    headless: true,
    channel: process.env.LP_E2E_BROWSER_CHANNEL ?? "chrome",
  });
  let gina;
  let inviteToken = null;

  await step("login page offers Continue with Google and GitHub", async () => {
    gina = await newPage(browser);
    await gina.goto(`${base}/lp/login`);
    expect(await gina.isVisible("#continue-google"), "no Continue with Google");
    expect(await gina.isVisible("#continue-github"), "no Continue with GitHub");
    await gina.click("#tab-signup");
    expect(await gina.isVisible("#continue-google"), "Google button gone on Sign up");
  });

  await step("Continue with Google signs a new member in and asks how they work", async () => {
    await gina.click("#continue-google");
    await consent(gina, `gina-${run}@example.com`, "Gina");
    await gina.getByTestId("lp-onboarding").waitFor({ timeout: 60_000 });
    const state = await session(gina);
    expect(state.user?.email === `gina-${run}@example.com`, `signed in as ${state.user?.email}`);
    expect(state.onboarding === null, `onboarding already ${state.onboarding}`);
  });

  await step("beginner: a ready project on the host, then the first thread", async () => {
    await gina.getByTestId("lp-onboarding-beginner").click();
    await gina.getByTestId("lp-onboarding").waitFor({ state: "detached", timeout: 60_000 });
    await gina.getByText("My first project").first().waitFor({ timeout: 60_000 });
    const state = await session(gina);
    expect(state.onboarding === "beginner", `onboarding is ${state.onboarding}`);
    expect(state.connections?.github?.connected === false, "beginner has GitHub connected");
    const workspace = state.workspaces.find((w) => w.workspaceId === state.currentWorkspaceId);
    expect(workspace?.projectIds.length === 1, "no starter project in the workspace");
    const invite = await gina.evaluate(
      (id) => fetch(`/api/lp/workspaces/invite?workspaceId=${id}`).then((r) => r.json()),
      state.currentWorkspaceId,
    );
    inviteToken = new URL(invite.path, "http://x").searchParams.get("invite");
  });

  let dev;
  await step("developer: GitHub sign-in counts as connected, Cloudflare connects", async () => {
    dev = await newPage(browser);
    await dev.goto(`${base}/lp/login`);
    await dev.click("#continue-github");
    await consent(dev, `dev-${run}@example.com`, "Dev");
    await dev.getByTestId("lp-onboarding-pro").click();
    await dev.getByText(`GitHub connected as dev-${run}`).waitFor({ timeout: 30_000 });
    await dev.getByTestId("lp-connect-cloudflare").click();
    await consent(dev, `dev-${run}@example.com`);
    await dev.getByText(/Cloudflare connected/).waitFor({ timeout: 30_000 });
    await dev.getByText("Connect your agent").first().waitFor({ timeout: 30_000 });
    const state = await session(dev);
    expect(state.onboarding === "pro", `onboarding is ${state.onboarding}`);
    expect(
      state.connections.github.connected && state.connections.cloudflare.connected,
      "not both connected",
    );
  });

  await step("an invite link with Continue with Google joins that workspace", async () => {
    expect(inviteToken, "no invite from the beginner step");
    const invitee = await newPage(browser);
    await invitee.goto(`${base}/lp/join?invite=${encodeURIComponent(inviteToken)}`);
    await invitee.click("#continue-google");
    await consent(invitee, `invitee-${run}@example.com`, "Ivy");
    const state = await session(invitee);
    const joined = state.workspaces.find((w) => w.workspaceId === state.currentWorkspaceId);
    expect(joined?.name === "Gina's workspace", `current workspace is ${joined?.name}`);
    expect(joined?.role === "member", `role is ${joined?.role}`);
  });

  await step("a sign-in started in another browser is refused (state check)", async () => {
    const attacker = await newPage(browser);
    const response = await attacker.goto(`${base}/lp/auth/google/callback?code=x&state=forged`);
    expect(response?.status() === 400, `status ${response?.status()}`);
    expect(await attacker.getByText("does not match this browser").isVisible(), "no state error");
  });
} catch (error) {
  failed = true;
  console.error(error);
  console.error(server.log().slice(-3000));
  console.error(web.log().slice(-2000));
} finally {
  await browser?.close();
  await stopAll();
  if (!keep) NodeFS.rmSync(home, { recursive: true, force: true });
}

console.log("\n| Flow | Result | Time |\n| --- | --- | --- |");
for (const result of results) {
  console.log(
    `| ${result.name} | ${result.ok ? "pass" : `FAIL: ${result.error?.split("\n")[0]}`} | ${(result.ms / 1000).toFixed(1)}s |`,
  );
}
process.exit(failed ? 1 : 0);
