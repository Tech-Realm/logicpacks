#!/usr/bin/env node
// LogicPacks workspaces end to end: `node apps/web/e2e/logicpacks-workspaces.e2e.mjs [--port 3802] [--keep]`.
// Needs a built web client (or --web-port <port> for the Vite dev client) and Chrome (LP_E2E_BROWSER_CHANNEL=chromium for Playwright's own).
// The invitee's turn runs on the free Replay provider, which the host lends to members here.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { startDevWeb, webPortArg } from "./lpDevWeb.mjs";

// "How do you work?" (sign-in onboarding) comes before the first-run steps: skip it.
async function passOnboarding(page, timeout = 60_000) {
  const firstRun = page.getByTestId("lp-first-run");
  const question = page.getByTestId("lp-onboarding");
  await firstRun.or(question).first().waitFor({ timeout });
  if (await question.isVisible()) await page.getByTestId("lp-onboarding-skip").click();
  await firstRun.waitFor({ timeout });
}

const require = NodeModule.createRequire(import.meta.url);
const { chromium } = require("playwright");

const args = process.argv.slice(2);
const port = Number(args[args.indexOf("--port") + 1] || 0) || 3802;
const keep = args.includes("--keep");
const devWebPort = webPortArg(args);
const base = devWebPort ? `http://127.0.0.1:${devWebPort}` : `http://127.0.0.1:${port}`;
const repo = NodePath.join(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "../../..");
const serverDir = NodePath.join(repo, "apps/server");
const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lp-e2e-"));
const run = Date.now().toString(36);
const email = (name) => `${name}-${run}@example.com`;
const PASSWORD = "correct-horse-battery";

// The free Replay provider is the host default, so a member's first message runs a recorded turn.
NodeFS.mkdirSync(NodePath.join(home, "userdata"), { recursive: true });
NodeFS.writeFileSync(
  NodePath.join(home, "userdata/settings.json"),
  JSON.stringify({
    providerInstances: {
      devReplay: {
        displayName: "Replay (dev)",
        driver: "acpRegistry",
        config: {
          source: "local",
          commandPath: process.execPath,
          commandArgs: [NodePath.join(serverDir, "scripts/dev-replay-agent.ts")],
        },
      },
    },
    defaultModelSelection: { instanceId: "devReplay", model: "showcase" },
  }),
);

const server = NodeChildProcess.spawn(
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
  ],
  {
    cwd: serverDir,
    env: {
      ...process.env,
      LOGICPACKS_MEMBERS_OWN_PROVIDERS: "false",
      LOGICPACKS_SYNC_SECONDS: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
    // bin.ts relaunches itself; a process group lets teardown stop the real server too.
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
const serverGone = () => {
  try {
    process.kill(-server.pid, 0);
    return false;
  } catch {
    return true;
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

const results = [];
const pages = [];
const shotsDir = process.env.LP_E2E_SHOTS;
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
    if (shotsDir) {
      for (const [index, page] of pages.entries()) {
        await page
          .screenshot({ path: NodePath.join(shotsDir, `${results.length}-${index}.png`) })
          .catch(() => undefined);
      }
    }
  }
}
const expect = (condition, message) => {
  if (!condition) throw new Error(message);
};

const switcher = (page) => page.getByTestId("lp-workspace-switcher");
const switcherText = async (page) => (await switcher(page).innerText()).trim();
const waitForSwitcher = (page, name) =>
  page.waitForFunction(
    (expected) =>
      document.querySelector('[data-testid="lp-workspace-switcher"]')?.textContent?.trim() ===
      expected,
    name,
    { timeout: 30_000 },
  );
const session = (page) =>
  page.evaluate(() => fetch("/api/lp/session", { credentials: "include" }).then((r) => r.json()));
/** Home opens a draft in the newest project in view, or the first run when there is none. */
async function homeShows(page, project) {
  await page.goto(`${base}/`);
  if (project === null) {
    await passOnboarding(page);
    return;
  }
  await draftOpenIn(page, project);
}
const draftOpenIn = (page, project) =>
  page.waitForFunction(
    (name) =>
      (document.querySelector("main")?.textContent ?? "")
        .replace(/\s+/g, "")
        .includes(`buildin${name.replace(/\s+/g, "")}`),
    project,
    { timeout: 30_000 },
  );

async function signUp(browser, name) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await context.newPage();
  pages.push(page);
  await page.goto(`${base}/lp/login`);
  await page.click("#toggle");
  await page.fill("#name", name);
  await page.fill("#email", email(name.toLowerCase()));
  await page.fill("#password", PASSWORD);
  await page.click("#submit");
  await page.waitForURL(`${base}/`, { timeout: 30_000 });
  await waitForSwitcher(page, `${name}'s workspace`);
  return page;
}

async function openManage(page) {
  await page.getByTestId("lp-invite").click();
  await page.getByRole("dialog").waitFor();
}

/** Clicks something that reloads the app, and waits for the reload. */
const clickAndReload = (page, locator) =>
  Promise.all([page.waitForEvent("load", { timeout: 30_000 }), locator.click()]);

async function chooseWorkspace(page, name) {
  await switcher(page).click();
  await clickAndReload(page, page.getByRole("menuitemradio", { name }));
  await waitForSwitcher(page, name);
}

let browser;
const devWeb = devWebPort ? startDevWeb({ repo, serverPort: port, webPort: devWebPort }) : null;
try {
  await ready;
  await devWeb?.ready;
  browser = await chromium.launch({
    headless: true,
    channel: process.env.LP_E2E_BROWSER_CHANNEL ?? "chrome",
  });
  let ana;
  let bo;
  let inviteUrl;
  const PROJECT = "Team site";

  await step("sign up lands in a default workspace", async () => {
    ana = await signUp(browser, "Ana");
    await passOnboarding(ana);
    const state = await session(ana);
    expect(state.workspaces.length === 1, `expected 1 workspace, got ${state.workspaces.length}`);
    expect(state.workspaces[0].role === "owner", "Ana should own her workspace");
  });

  await step("add a project in one step (template)", async () => {
    await ana.getByRole("button", { name: "Skip for now" }).click();
    await ana.getByText("Template", { exact: true }).click();
    await ana.getByLabel("Project name").fill(PROJECT);
    await ana.getByTestId("lp-create-project").click();
    // The first thread opens by itself in the new project.
    await draftOpenIn(ana, PROJECT);
    const state = await session(ana);
    expect(state.workspaces[0].projectIds.length === 1, "the project should be in Ana's workspace");
  });

  await step("create a second workspace and switch between them", async () => {
    await switcher(ana).click();
    await ana.getByRole("menuitem", { name: "New workspace" }).click();
    await ana.getByLabel("Workspace name").fill("Side project");
    await clickAndReload(ana, ana.getByTestId("lp-create-workspace"));
    await waitForSwitcher(ana, "Side project");
    await homeShows(ana, null);
    await chooseWorkspace(ana, "Ana's workspace");
    await homeShows(ana, PROJECT);
  });

  await step("invite a new user with the link", async () => {
    await openManage(ana);
    const link = ana.getByTestId("lp-invite-link");
    await ana.waitForFunction(() =>
      document.querySelector('[data-testid="lp-invite-link"]')?.value?.includes("/lp/join"),
    );
    inviteUrl = await link.inputValue();
    await ana.keyboard.press("Escape");
    const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    bo = await context.newPage();
    pages.push(bo);
    await bo.goto(inviteUrl);
    await bo.getByText("You're invited to").waitFor();
    await bo.fill("#name", "Bo");
    await bo.fill("#email", email("bo"));
    await bo.fill("#password", PASSWORD);
    await bo.click("#submit");
    await bo.waitForURL(new RegExp(`^${base}/`), { timeout: 30_000 });
    await waitForSwitcher(bo, "Ana's workspace");
    await homeShows(bo, PROJECT);
    const state = await session(bo);
    const names = state.workspaces.map((w) => `${w.name}:${w.role}`).sort();
    expect(
      names.join(",") === "Ana's workspace:member,Bo's workspace:owner",
      `unexpected workspaces ${names}`,
    );
  });

  await step("invite existing users (by name, and by link while signed in)", async () => {
    const cy = await signUp(browser, "Cy");
    await openManage(ana);
    await ana.getByLabel("Email or name").fill(email("cy"));
    await ana.getByTestId("lp-add-person").click();
    await ana.waitForFunction(
      () => document.querySelectorAll('[data-testid="lp-member-row"]').length === 3,
    );
    await ana.keyboard.press("Escape");
    await cy.reload();
    await waitForSwitcher(cy, "Cy's workspace");
    await chooseWorkspace(cy, "Ana's workspace");
    await homeShows(cy, PROJECT);

    const dee = await signUp(browser, "Dee");
    await dee.goto(inviteUrl);
    await waitForSwitcher(dee, "Ana's workspace");
    await homeShows(dee, PROJECT);
  });

  const MESSAGE = `hello from bo ${run}`;
  await step("an invitee starts a thread the owner can see", async () => {
    // Home opens a draft in the workspace's most recent project.
    await bo.goto(`${base}/`);
    const composer = bo.locator('[contenteditable="true"]').first();
    await composer.waitFor({ timeout: 30_000 });
    await composer.click();
    await bo.keyboard.type(MESSAGE);
    await bo.keyboard.press("Enter");
    await bo.waitForFunction((needle) => document.body.textContent?.includes(needle), MESSAGE, {
      timeout: 30_000,
    });
    await bo.waitForURL((url) => url.pathname.split("/").filter(Boolean).length === 2, {
      timeout: 30_000,
    });
    // The thread gets a generated title, which may not echo the message, so look for any
    // thread row: Ana has started none herself.
    await ana.reload();
    await ana.waitForFunction(
      () => {
        const sidebar = document.querySelector('[data-sidebar="sidebar"]')?.textContent ?? "";
        return sidebar.includes("Team site") && !sidebar.includes("No threads yet");
      },
      null,
      { timeout: 30_000 },
    );
  });

  await step("revoking a member takes the workspace away", async () => {
    await openManage(ana);
    await ana.getByRole("button", { name: "Remove Bo" }).click();
    await ana.waitForFunction(
      () => document.querySelectorAll('[data-testid="lp-member-row"]').length === 3,
    );
    await ana.keyboard.press("Escape");
    await bo.goto(`${base}/`);
    await waitForSwitcher(bo, "Bo's workspace");
    await bo.locator('[data-sidebar="sidebar"]').getByText("No projects yet").waitFor();
    const page = await bo.locator("body").innerText();
    expect(!page.includes(PROJECT), "Bo still sees Ana's project");
    expect(!page.includes(run), "Bo still sees his thread in Ana's project");
    const state = await session(bo);
    expect(
      !state.workspaces.some((w) => w.name === "Ana's workspace"),
      "Bo still lists Ana's workspace",
    );
    const switcherLabel = await switcherText(bo);
    expect(switcherLabel === "Bo's workspace", `switcher shows ${switcherLabel}`);
  });
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  await browser?.close();
  devWeb?.stop();
  stopServer("SIGTERM");
  for (let waited = 0; !serverGone() && waited < 5_000; waited += 250) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  stopServer("SIGKILL");
  if (!keep) NodeFS.rmSync(home, { recursive: true, force: true });
}

console.log("\n| Flow | Result | Time |\n| --- | --- | --- |");
for (const result of results) {
  console.log(
    `| ${result.name} | ${result.ok ? "pass" : `FAIL: ${result.error?.split("\n")[0]}`} | ${(result.ms / 1000).toFixed(1)}s |`,
  );
}
process.exit(failed ? 1 : 0);
