#!/usr/bin/env node
// Screenshots of the main LogicPacks screens in light and dark, for theme reviews:
// `node apps/web/e2e/logicpacks-theme-shots.e2e.mjs --out <dir> [--prefix after] [--port 3802]`.
// Needs a built web client (`vp build` in apps/web) and Chrome. Sync states are stubbed on the
// status route, so no cloud host or GitHub account is needed.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

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
const arg = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};
const port = Number(arg("--port", "3802"));
const out = NodePath.resolve(arg("--out", "screens"));
const prefix = arg("--prefix", "shot");
const base = `http://127.0.0.1:${port}`;
const repo = NodePath.join(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "../../..");
const serverDir = NodePath.join(repo, "apps/server");
const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lp-shots-"));
const run = Date.now().toString(36);
const email = (name) => `${name}-${run}@example.com`;
const PASSWORD = "correct-horse-battery";
NodeFS.mkdirSync(out, { recursive: true });

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
  ["src/bin.ts", "serve", "--port", String(port), "--host", "127.0.0.1"].concat([
    "--base-dir",
    home,
    "--no-browser",
  ]),
  {
    cwd: serverDir,
    env: {
      ...process.env,
      LOGICPACKS_MEMBERS_OWN_PROVIDERS: "false",
      LOGICPACKS_SYNC_SECONDS: "0",
    },
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

const taken = [];
const missed = [];
/** One screenshot per colour scheme; the app follows the system scheme by default. */
async function shoot(page, name, prepare) {
  for (const scheme of ["dark", "light"]) {
    try {
      await page.emulateMedia({ colorScheme: scheme });
      if (prepare) await prepare(scheme);
      await page.waitForTimeout(450);
      const file = NodePath.join(out, `${prefix}-${name}-${scheme}.png`);
      await page.screenshot({ path: file });
      taken.push(file);
    } catch (error) {
      missed.push(`${name}-${scheme}: ${String(error?.message ?? error).split("\n")[0]}`);
    }
  }
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

let browser;
let failed = false;
try {
  await ready;
  browser = await chromium.launch({
    headless: true,
    channel: process.env.LP_E2E_BROWSER_CHANNEL ?? "chrome",
  });
  const newPage = async () =>
    (await browser.newContext({ viewport: { width: 1360, height: 860 } })).newPage();
  const PROJECT = "Team site";

  const ana = await newPage();
  await ana.goto(`${base}/lp/login`);
  await ana.click("#toggle");
  await shoot(ana, "01-login");
  await ana.fill("#name", "Ana");
  await ana.fill("#email", email("ana"));
  await ana.fill("#password", PASSWORD);
  await ana.click("#submit");
  await ana.waitForURL(`${base}/`, { timeout: 30_000 });
  await passOnboarding(ana);
  await shoot(ana, "02-home-first-run");

  await ana.getByRole("button", { name: "Skip for now" }).click();
  await ana.getByText("Template", { exact: true }).waitFor();
  await shoot(ana, "03-new-project");
  await ana.getByText("Template", { exact: true }).click();
  await ana.getByLabel("Project name").fill(PROJECT);
  await ana.getByTestId("lp-create-project").click();
  await draftOpenIn(ana, PROJECT);
  await shoot(ana, "04-project");

  await ana.getByTestId("lp-workspace-switcher").click();
  await ana.getByRole("menuitem", { name: "New workspace" }).waitFor();
  await shoot(ana, "05-workspace-switcher");
  await ana.keyboard.press("Escape");

  await ana.getByTestId("lp-invite").click();
  await ana.getByRole("dialog").waitFor();
  await ana.waitForFunction(() =>
    document.querySelector('[data-testid="lp-invite-link"]')?.value?.includes("/lp/join"),
  );
  const inviteUrl = await ana.getByTestId("lp-invite-link").inputValue();
  await shoot(ana, "06-manage");
  await ana.keyboard.press("Escape");

  const bo = await newPage();
  await bo.goto(inviteUrl);
  await bo.getByText("You're invited to").waitFor();
  await shoot(bo, "07-invite");
  await bo.fill("#name", "Bo");
  await bo.fill("#email", email("bo"));
  await bo.fill("#password", PASSWORD);
  await bo.click("#submit");
  await bo.waitForURL(new RegExp(`^${base}/`), { timeout: 30_000 });
  await draftOpenIn(bo, PROJECT);

  await ana.reload();
  await draftOpenIn(ana, PROJECT);
  const composer = ana.locator('[contenteditable="true"]').first();
  await composer.click();
  await ana.keyboard.type("Add a pricing section to the landing page");
  await ana.keyboard.press("Enter");
  await ana.waitForURL((url) => url.pathname.split("/").filter(Boolean).length === 2, {
    timeout: 30_000,
  });
  // Let the replayed turn stream in.
  await ana.waitForTimeout(6_000);
  await shoot(ana, "08-thread");
  const threadUrl = ana.url();

  // Sync states: rewrite the polled status for this project.
  const session = await ana.evaluate(() =>
    fetch("/api/lp/session", { credentials: "include" }).then((r) => r.json()),
  );
  const projectId = session.workspaces.find((w) => w.role === "owner").projectIds[0];
  const stubs = {
    "not-synced": { state: "not_synced" },
    syncing: { state: "syncing", message: "Pushing to GitHub" },
    synced: {
      state: "synced",
      remoteUrl: "https://github.com/acme/team-site.git",
      branch: "main",
      cloudUrl: "https://app.logicpacks.io",
      lastSyncedAt: new Date().toISOString(),
    },
    conflict: {
      state: "conflict",
      conflictFiles: ["src/pages/pricing.tsx"],
      theirsAuthor: "Bo",
      branch: "main",
    },
    error: { state: "error", message: "GitHub rejected the push: the token has expired." },
  };
  let stub = stubs["not-synced"];
  await ana.route("**/api/lp/sync/status", async (route) => {
    const response = await route.fetch();
    const body = await response.json().catch(() => ({ cloud: null, projects: [] }));
    const others = (body.projects ?? []).filter((p) => p.projectId !== projectId);
    const blank = {
      projectId,
      remoteUrl: null,
      branch: null,
      cloudUrl: null,
      cloudProjectId: null,
      ahead: 0,
      behind: 0,
      conflictFiles: [],
      theirsAuthor: null,
      message: null,
      lastSyncedAt: null,
    };
    await route.fulfill({
      response,
      json: {
        cloud: body.cloud ?? {
          isCloudHost: false,
          url: "https://app.logicpacks.io",
          connected: true,
          account: null,
        },
        projects: [...others, { ...blank, ...stub }],
      },
    });
  });
  for (const [name, value] of Object.entries(stubs)) {
    stub = value;
    await ana.goto(threadUrl);
    await ana
      .locator(`[data-testid="lp-sync-badge"][data-sync-state="${value.state}"]`)
      .first()
      .waitFor({ timeout: 20_000 });
    await shoot(ana, `09-sync-${name}`);
  }
  stub = stubs["not-synced"];
  await ana.goto(threadUrl);
  await ana.locator('[data-testid="lp-sync-badge"]').first().click();
  await ana.getByRole("dialog").waitFor();
  await shoot(ana, "10-sync-dialog");
  await ana.keyboard.press("Escape");

  for (const section of ["general", "appearance", "providers"]) {
    await ana.goto(`${base}/settings/${section}`);
    await ana.waitForLoadState("networkidle").catch(() => undefined);
    await shoot(ana, `11-settings-${section}`);
  }
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  await browser?.close();
  stopServer("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  stopServer("SIGKILL");
  NodeFS.rmSync(home, { recursive: true, force: true });
}
console.log(`${taken.length} screenshots in ${out}`);
for (const miss of missed) console.log(`MISSED ${miss}`);
process.exit(failed ? 1 : 0);
