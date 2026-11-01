#!/usr/bin/env node
// Screenshots of the main LogicPacks surfaces for brand reviews, against an already running
// server and web client (no build, no server spawn):
//
//   node apps/web/e2e/logicpacks-brand-shots.e2e.mjs --web http://localhost:5791 \
//     --server http://localhost:3871 --out <dir> [--prefix after] [--only thread,settings]
//
// The server should run with a replay provider as its default model (see
// logicpacks-theme-shots.e2e.mjs) so the thread shows tool calls and "Worked for" lines.
// Both origins must share a hostname so the session cookie set by /lp/login reaches the client.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

const require = NodeModule.createRequire(import.meta.url);
const { chromium } = require("playwright");

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};
const web = arg("--web", "http://localhost:5791");
const server = arg("--server", "http://localhost:3871");
const out = NodePath.resolve(arg("--out", "screens"));
const prefix = arg("--prefix", "shot");
const only = arg("--only", "")
  .split(",")
  .filter((name) => name.length > 0);
const schemes = arg("--schemes", "dark,light").split(",");
const run = Date.now().toString(36);
const PASSWORD = "correct-horse-battery";
NodeFS.mkdirSync(out, { recursive: true });

const taken = [];
const missed = [];
const wanted = (name) => only.length === 0 || only.some((part) => name.includes(part));
async function shoot(page, name, prepare) {
  if (!wanted(name)) return;
  for (const scheme of schemes) {
    try {
      await page.emulateMedia({ colorScheme: scheme });
      if (prepare) await prepare(scheme);
      await page.waitForTimeout(500);
      const file = NodePath.join(out, `${prefix}-${name}-${scheme}.png`);
      await page.screenshot({ path: file });
      taken.push(file);
    } catch (error) {
      missed.push(`${name}-${scheme}: ${String(error?.message ?? error).split("\n")[0]}`);
    }
  }
}

const browser = await chromium.launch({ headless: true });
let failed = false;
let page;
try {
  const context = await browser.newContext({ viewport: { width: 1360, height: 860 } });
  // Show the app as a release build does: no Dev/Nightly channel artwork in the sidebar.
  await context.addInitScript(() => {
    const key = "logicpacks:client-settings:v1";
    if (window.localStorage.getItem(key) === null) {
      window.localStorage.setItem(key, JSON.stringify({ environmentIdentificationMode: "none" }));
    }
  });
  page = await context.newPage();

  // Boot frame: hold the module entry so the inline boot shell stays on screen.
  await page.route("**/src/bootstrap.ts*", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    await route.continue().catch(() => undefined);
  });
  await page.goto(`${web}/`, { waitUntil: "commit" });
  await page.waitForSelector("#boot-shell-logo");
  await shoot(page, "00-boot");
  await page.unroute("**/src/bootstrap.ts*");

  await page.goto(`${server}/lp/login`);
  await shoot(page, "01-login");
  await page.click("#toggle");
  await page.fill("#name", "Ana");
  await page.fill("#email", `ana-${run}@example.com`);
  await page.fill("#password", PASSWORD);
  await page.click("#submit");
  await page.waitForTimeout(1_500);

  await page.goto(`${web}/`);
  const firstRun = page.getByTestId("lp-first-run");
  if (
    await firstRun.waitFor({ timeout: 30_000 }).then(
      () => true,
      () => false,
    )
  ) {
    await shoot(page, "02-first-run");
    await page.getByRole("button", { name: "Skip for now" }).click();
  }
  await page.getByText("Template", { exact: true }).waitFor({ timeout: 30_000 });
  await page.getByText("Template", { exact: true }).click();
  await page.getByLabel("Project name").fill("Team site");
  await page.getByTestId("lp-create-project").click();
  await page.waitForFunction(
    () => (document.querySelector("main")?.textContent ?? "").includes("build in"),
    undefined,
    { timeout: 30_000 },
  );
  await shoot(page, "03-empty-thread");

  await page.getByTestId("lp-invite").click();
  await page.getByRole("dialog").waitFor();
  await page.waitForTimeout(800);
  await shoot(page, "04-invite-dialog");
  await page.keyboard.press("Escape");

  const composer = page.locator('[contenteditable="true"]').first();
  await composer.click();
  await page.keyboard.type("Add a pricing section to the landing page");
  await shoot(page, "05-composer-typed");
  await page.keyboard.press("Enter");
  await page.waitForURL((url) => url.pathname.split("/").filter(Boolean).length === 2, {
    timeout: 30_000,
  });
  await page.waitForTimeout(9_000);
  await shoot(page, "06-thread");
  if (wanted("06b-thread-tools")) {
    const worked = page.getByText(/^Worked for/).first();
    await worked.click();
    await page.waitForTimeout(600);
    await worked.evaluate((node) => node.scrollIntoView({ block: "start" }));
    await shoot(page, "06b-thread-tools");
  }

  if (wanted("06c-assistance")) {
    await page.getByTestId("lp-request-assistance").click();
    await page.getByTestId("lp-assistance-dialog").waitFor();
    await page.waitForTimeout(800);
    await shoot(page, "06c-assistance");
    await page.keyboard.press("Escape");
  }
  if (wanted("06d-packs")) {
    await page.getByTestId("lp-packs-open").click();
    await page.getByTestId("lp-packs-dialog").waitFor();
    await page.waitForTimeout(800);
    await shoot(page, "06d-packs");
    await page.keyboard.press("Escape");
  }

  await page.getByTestId("lp-avatar").click();
  await page.waitForTimeout(300);
  await shoot(page, "07-avatar-menu");
  await page.keyboard.press("Escape");

  await page.goto(`${server}/lp/account`);
  await shoot(page, "08-account");

  for (const section of ["general", "appearance", "providers"]) {
    if (!wanted(`09-settings-${section}`)) continue;
    await page.goto(`${web}/settings/${section}`);
    await page.waitForLoadState("networkidle").catch(() => undefined);
    await shoot(page, `09-settings-${section}`);
  }

  if (wanted("10-demo-machine")) {
    await page.goto(`${web}/demo/machine`);
    await page.waitForTimeout(6_000);
    await shoot(page, "10-demo-machine");
  }
} catch (error) {
  failed = true;
  console.error(error);
  await page
    ?.screenshot({ path: NodePath.join(out, `${prefix}-error.png`) })
    .catch(() => undefined);
  console.error(`at ${page?.url()}`);
} finally {
  await browser.close();
}
console.log(`${taken.length} screenshots in ${out}`);
for (const miss of missed) console.log(`MISSED ${miss}`);
process.exit(failed ? 1 : 0);
