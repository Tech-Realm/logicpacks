#!/usr/bin/env node
// Layout modes, the intro and the product tour, end to end:
//   node apps/web/e2e/logicpacks-layout-modes.e2e.mjs [--port 3871] [--web-port 5806] [--shots <dir>] [--keep]
// One host from this tree and the Vite dev client in front of it (no production build). The agent
// is the scripted ACP mock. The onboarding's "How do you work?" answer is written through the
// shared `workStyle` pref, the way the sign-in screen writes it.
//   1 first sign-in: the intro shows, starts on Dev for a developer, and is calm (4 screens)
//   2 "Show me around" runs the tour: at least 6 steps, Back works, Skip ends it for good
//   3 switching Dev and Vibe moves and opens the workspace panel; the shortcut cycles modes
//   4 a custom layout exports as JSON and imports back the same; bad JSON names the problem
//   5 layouts follow the account: the server holds them and a fresh browser gets them
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const require = NodeModule.createRequire(import.meta.url);
const { chromium } = require("playwright");

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : (args[index + 1] ?? fallback);
};
const port = Number(option("--port", 3871));
const webPort = Number(option("--web-port", 5806));
const keep = args.includes("--keep");
const shotsDir = option("--shots", null);
const WEB = `http://127.0.0.1:${webPort}`;
const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const repo = NodePath.join(here, "../../..");
const serverDir = NodePath.join(repo, "apps/server");
const webDir = NodePath.join(repo, "apps/web");
const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lp-layout-e2e-"));
if (shotsDir) NodeFS.mkdirSync(shotsDir, { recursive: true });
const run = Date.now().toString(36).slice(-6);
const PASSWORD = "correct-horse-battery";
const ANA = `ana-${run}@example.com`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const home = NodePath.join(root, "host");
NodeFS.mkdirSync(NodePath.join(home, "userdata"), { recursive: true });
NodeFS.writeFileSync(
  NodePath.join(home, "userdata/settings.json"),
  JSON.stringify({
    providerInstances: {
      ledgerMock: {
        displayName: "Ledger mock",
        driver: "acpRegistry",
        config: {
          source: "local",
          commandPath: process.execPath,
          commandArgs: [NodePath.join(here, "lp-ledger-mock-agent.mjs")],
        },
      },
    },
    defaultModelSelection: { instanceId: "ledgerMock", model: "ledger" },
  }),
);

const children = [];
function spawnLogged(name, command, commandArgs, options, readyText) {
  const child = NodeChildProcess.spawn(command, commandArgs, {
    ...options,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  const started = { name, child, log: "" };
  children.push(started);
  started.ready = new Promise((resolve, reject) => {
    const onData = (chunk) => {
      started.log += chunk;
      if (started.log.length > 400_000) started.log = started.log.slice(-200_000);
      if (readyText.some((text) => started.log.includes(text))) resolve();
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code) =>
      reject(new Error(`${name} exited (${code})\n${started.log.slice(-2000)}`)),
    );
  });
  return started;
}
async function stopAll() {
  for (const started of children.toReversed()) {
    for (const signal of ["SIGTERM", "SIGKILL"]) {
      try {
        process.kill(-started.child.pid, signal);
      } catch {
        break;
      }
      let gone = false;
      for (let waited = 0; waited < 6_000; waited += 200) {
        try {
          process.kill(-started.child.pid, 0);
        } catch {
          gone = true;
          break;
        }
        await sleep(200);
      }
      if (gone) break;
    }
  }
}

// ── Harness ─────────────────────────────────────────────────────────────────
const results = [];
const pages = [];
let failed = false;
async function step(name, body) {
  const started = Date.now();
  if (failed) {
    results.push({ name, ok: false, ms: 0, error: "skipped after an earlier failure" });
    return;
  }
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
    for (const [index, page] of pages.entries()) {
      await page
        .screenshot({
          path: NodePath.join(shotsDir ?? root, `fail-${results.length}-${index}.png`),
        })
        .catch(() => undefined);
    }
  }
}
const expect = (condition, message) => {
  if (!condition) throw new Error(message);
};
async function waitFor(what, check, timeoutMs = 30_000) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    try {
      last = await check();
      if (last) return last;
    } catch (error) {
      last = String(error?.message ?? error);
    }
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${what} (last: ${JSON.stringify(last)?.slice(0, 400)})`);
}
const shot = async (page, name) => {
  // Let dialogs and toasts finish their entrance.
  await sleep(700);
  if (shotsDir) await page.screenshot({ path: NodePath.join(shotsDir, `${name}.png`) });
};
const pageApi = (page, path, body) =>
  page.evaluate(
    async ([path, body]) => {
      const response = await fetch(path, {
        method: body === null ? "GET" : "POST",
        credentials: "include",
        headers: body === null ? {} : { "content-type": "application/json" },
        ...(body === null ? {} : { body: JSON.stringify(body) }),
      });
      return { httpStatus: response.status, ...(await response.json().catch(() => ({}))) };
    },
    [path, body ?? null],
  );
async function newPage(browser, { intro = true } = {}) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    permissions: ["clipboard-read", "clipboard-write"],
  });
  // Automated browsers get no intro unless they ask for it (see LayoutModesHost).
  if (intro) await context.addInitScript(() => window.localStorage.setItem("lp:intro", "on"));
  const page = await context.newPage();
  pages.push(page);
  return page;
}
async function signUpOnLanding(page, name, email) {
  await page.goto(`${WEB}/lp/login`);
  await page.click("#tab-signup");
  await page.fill("#name", name);
  await page.fill("#email", email);
  await page.fill("#password", PASSWORD);
  await page.click("#submit");
  await page.waitForURL((url) => url.origin === WEB && !url.pathname.startsWith("/lp/"), {
    timeout: 30_000,
  });
}
async function openProject(page, title) {
  await page.goto(`${WEB}/`);
  const heading = page.locator("main h1 button, main h2 button").first();
  await heading.waitFor({ timeout: 60_000 });
  if ((await heading.innerText()).trim() !== title) {
    await heading.click();
    await page.locator('[role="listbox"]').getByText(title, { exact: true }).click();
  }
}
async function sendMessage(page, text) {
  const composer = page.locator('[contenteditable="true"]').first();
  await composer.waitFor({ timeout: 30_000 });
  await composer.click();
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
}

const layoutState = (page) =>
  page.evaluate(() => {
    const room = document.querySelector("[data-layout-mode]");
    const panel = document.querySelector('[data-preview-panel-mode="inline"]');
    const chat = document.querySelector("[data-chat-column]");
    const panelBox = panel?.getBoundingClientRect();
    const chatBox = chat?.getBoundingClientRect();
    return {
      mode: room?.getAttribute("data-layout-mode") ?? null,
      side: room?.getAttribute("data-workspace-panel-side") ?? null,
      panelWidth: panelBox ? Math.round(panelBox.width) : 0,
      panelLeftOfChat: panelBox && chatBox ? panelBox.left < chatBox.left : null,
    };
  });
const prefs = async (page) => (await pageApi(page, "/api/lp/prefs")).prefs ?? {};

let browser;
try {
  const env = {
    ...process.env,
    LOGICPACKS_CLOUD_HOST: "true",
    LOGICPACKS_MEMBERS_OWN_PROVIDERS: "false",
    LOGICPACKS_SYNC_SECONDS: "0",
  };
  const server = spawnLogged(
    "server",
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
    { cwd: serverDir, env },
    ["server is ready"],
  );
  const web = spawnLogged(
    "web",
    NodePath.join(repo, "node_modules/.bin/vp"),
    ["dev"],
    {
      cwd: webDir,
      env: {
        ...process.env,
        LOGICPACKS_SINGLE_ORIGIN_DEV: "1",
        LOGICPACKS_PORT: String(port),
        PORT: String(webPort),
        HOST: "127.0.0.1",
      },
    },
    ["ready in", "Local:"],
  );
  await Promise.all([server.ready, web.ready]);
  browser = await chromium.launch({ headless: true });

  let ana;
  const PROJECT = `Team site ${run}`;

  await step("1 first sign-in: intro shows, starts on Dev for a developer", async () => {
    // Signed up with the intro held back, so the project room exists before it shows.
    ana = await newPage(browser, { intro: false });
    await signUpOnLanding(ana, "Ana", ANA);
    // The sign-in onboarding answered "developer" through the shared pref.
    const answered = await pageApi(ana, "/api/lp/prefs", { prefs: { workStyle: "developer" } });
    expect(answered.httpStatus === 200, `workStyle write: ${JSON.stringify(answered)}`);
    const created = await pageApi(ana, "/api/lp/projects/new", { kind: "empty", name: PROJECT });
    expect(created.projectId, `project not created: ${JSON.stringify(created)}`);
    await openProject(ana, PROJECT);
    await sendMessage(ana, "Make the header sticky");
    await ana.waitForURL((url) => url.pathname.split("/").filter(Boolean).length === 2, {
      timeout: 60_000,
    });
    // Let the turn land before reloading, or the reload drops the message in flight.
    await waitFor(
      "the agent's reply",
      async () => ((await ana.locator("main").innerText()).includes("Done.") ? true : null),
      60_000,
    );
    await ana.evaluate(() => window.localStorage.setItem("lp:intro", "on"));
    await ana.reload();
    const intro = ana.getByTestId("lp-intro");
    await intro.waitFor({ timeout: 60_000 });
    await shot(ana, "intro-1");
    let screens = 1;
    while ((await ana.getByTestId("lp-intro-next").count()) > 0) {
      await ana.getByTestId("lp-intro-next").click();
      screens += 1;
    }
    expect(screens === 4, `intro has ${screens} screens`);
    const dev = ana.getByTestId("lp-intro-layout-dev");
    expect(
      (await dev.getAttribute("aria-checked")) === "true",
      "Dev is not preselected for a developer",
    );
    expect(await ana.getByTestId("lp-intro-show-tour").isVisible(), "no Show me around");
    const checked = await ana.getByTestId("lp-intro-show-tour").getAttribute("aria-checked");
    expect(
      checked === "true" ||
        (await ana.getByTestId("lp-intro-show-tour").getAttribute("data-checked")) !== null,
      "Show me around is not on by default",
    );
    await shot(ana, "intro-layout");
    const text = await intro.innerText();
    expect(!text.includes("\u2014"), "intro copy has an em-dash");
  });

  await step("2 the tour walks at least 6 steps, Back works, Skip ends it", async () => {
    await ana.getByTestId("lp-intro-start").click();
    await ana.getByTestId("lp-intro").waitFor({ state: "detached", timeout: 10_000 });
    await ana.getByTestId("lp-tour-callout").waitFor({ timeout: 20_000 });
    const seen = [];
    const stepId = () => ana.getByTestId("lp-tour-callout").getAttribute("data-tour-step");
    seen.push(await stepId());
    for (let index = 0; index < 5; index++) {
      await ana.getByTestId("lp-tour-next").click();
      await waitFor(
        "the next tour step",
        async () => {
          const id = await stepId();
          return id && id !== seen.at(-1) ? id : null;
        },
        10_000,
      );
      seen.push(await stepId());
      if (index === 1) await shot(ana, "tour-step");
    }
    console.log(`     tour steps: ${seen.join(", ")}`);
    expect(new Set(seen).size >= 6, `only ${new Set(seen).size} distinct steps`);
    const count = await ana.getByTestId("lp-tour-count").innerText();
    expect(/^6 of \d+$/.test(count.trim()), `counter says ${count}`);
    await ana.keyboard.press("ArrowLeft");
    await waitFor("Back", async () => ((await stepId()) === seen.at(-2) ? true : null), 10_000);
    await ana.getByTestId("lp-tour-skip").click();
    await ana.getByTestId("lp-tour").waitFor({ state: "detached", timeout: 10_000 });
    const stored = await waitFor("the tour state on the server", async () => {
      const p = await prefs(ana);
      return p.intro?.tour === "skipped" ? p : null;
    });
    expect(stored.intro.completedAt, "intro not marked complete");
    await ana.reload();
    await ana
      .locator("[data-layout-mode]")
      .first()
      .waitFor({ timeout: 60_000 })
      .catch(() => undefined);
    await sleep(2000);
    expect((await ana.getByTestId("lp-intro").count()) === 0, "intro came back after reload");
    expect((await ana.getByTestId("lp-tour").count()) === 0, "tour came back after skip");
  });

  await step("3 Dev and Vibe change the layout; the shortcut cycles", async () => {
    const dev = await waitFor("the Dev layout", async () => {
      const state = await layoutState(ana);
      return state.mode === "dev" && state.panelWidth > 300 ? state : null;
    });
    expect(
      dev.side === "left" && dev.panelLeftOfChat === true,
      `Dev layout: ${JSON.stringify(dev)}`,
    );
    await shot(ana, "layout-dev");
    await ana.getByTestId("lp-layout-switcher").click();
    await ana.getByTestId("lp-layout-option-vibe").click();
    const vibe = await waitFor("the Vibe layout", async () => {
      const state = await layoutState(ana);
      return state.mode === "vibe" && state.panelWidth < 10 ? state : null;
    });
    expect(vibe.side === "right", `Vibe layout: ${JSON.stringify(vibe)}`);
    await ana.keyboard.press("Escape");
    await shot(ana, "layout-vibe");
    await ana.locator("body").click({ position: { x: 700, y: 300 } });
    await ana.keyboard.press("Meta+Alt+KeyL");
    await waitFor("the shortcut to switch to Dev", async () =>
      (await layoutState(ana)).mode === "dev" ? true : null,
    );
    const stored = await waitFor("the active mode on the server", async () => {
      const p = await prefs(ana);
      return p.layout?.activeModeId === "dev" ? p : null;
    });
    expect(stored, "active mode not synced");
  });

  let exported;
  await step("4 a custom layout exports as JSON and imports back the same", async () => {
    await ana.goto(`${WEB}/settings/layout`);
    await ana.getByTestId("lp-layout-mode-dev").waitFor({ timeout: 60_000 });
    await ana.getByTestId("lp-layout-duplicate-dev").click();
    await ana.getByTestId("lp-layout-editor").waitFor();
    await ana.getByTestId("lp-layout-name").fill("Wide review");
    await ana.getByTestId("lp-layout-swap").click();
    await ana.getByTestId("lp-layout-width-workspace").fill("900");
    await ana.getByTestId("lp-layout-save").click();
    await ana.getByTestId("lp-layout-editor").waitFor({ state: "detached" });
    await ana.getByTestId("lp-layout-copy-json").click();
    exported = await waitFor("the copied JSON", async () => {
      const text = await ana.evaluate(() => navigator.clipboard.readText());
      return text.includes("Wide review") ? text : null;
    });
    const parsed = JSON.parse(exported);
    const mode = parsed.modes[0];
    expect(parsed.version === 1 && mode.id === "dev-copy", `export: ${exported.slice(0, 200)}`);
    expect(
      mode.label === "Wide review" &&
        mode.order.join() === "projects,chat,workspace" &&
        mode.widths.workspace === 900,
      `export fields: ${JSON.stringify(mode)}`,
    );
    await shot(ana, "settings-layout");

    // Bad input names the problem.
    await ana.getByTestId("lp-layout-paste").fill("{ nope");
    await ana.getByTestId("lp-layout-import").click();
    const badJson = await ana.getByTestId("lp-layout-errors").innerText();
    expect(/not valid JSON/.test(badJson), `bad JSON error: ${badJson}`);
    const unknownPanel = JSON.stringify({
      version: 1,
      modes: [{ ...mode, id: "x", order: ["projects", "editor", "chat"] }],
    });
    await ana.getByTestId("lp-layout-paste").fill(unknownPanel);
    await ana.getByTestId("lp-layout-import").click();
    await waitFor("the unknown panel error", async () =>
      /unknown panel "editor"/.test(await ana.getByTestId("lp-layout-errors").innerText()),
    );
    await shot(ana, "settings-layout-import-error");

    // Delete it, then import the exported JSON: the same layout comes back.
    await ana.getByRole("button", { name: "Delete" }).first().click();
    await waitFor(
      "the layout to go",
      async () => (await ana.getByTestId("lp-layout-mode-dev-copy").count()) === 0,
    );
    await ana.getByTestId("lp-layout-paste").fill(exported);
    await ana.getByTestId("lp-layout-import").click();
    await ana.getByTestId("lp-layout-mode-dev-copy").waitFor({ timeout: 10_000 });
    await ana.getByTestId("lp-layout-copy-json").click();
    const again = await waitFor("the copied JSON again", async () => {
      const text = await ana.evaluate(() => navigator.clipboard.readText());
      return text.includes("Wide review") ? text : null;
    });
    expect(again === exported, `round trip differs:\n${exported}\n---\n${again}`);
  });

  await step("5 layouts follow the account into a fresh browser", async () => {
    await ana.getByTestId("lp-layout-mode-dev-copy").click();
    await waitFor("the custom mode on the server", async () => {
      const p = await prefs(ana);
      return p.layout?.activeModeId === "dev-copy" && p.layout.customModes?.length === 1 ? p : null;
    });
    const other = await newPage(browser);
    await other.goto(`${WEB}/lp/login`);
    await other.fill("#email", ANA);
    await other.fill("#password", PASSWORD);
    await other.click("#submit");
    await other.waitForURL((url) => url.origin === WEB && !url.pathname.startsWith("/lp/"), {
      timeout: 30_000,
    });
    await other.goto(`${WEB}/settings/layout`);
    const card = other.getByTestId("lp-layout-mode-dev-copy");
    await card.waitFor({ timeout: 60_000 });
    await waitFor("the synced active mode", async () =>
      (await card.getAttribute("aria-checked")) === "true" ? true : null,
    );
    expect(
      (await other.getByTestId("lp-intro").count()) === 0,
      "the intro shows again on a new browser",
    );
  });
} catch (error) {
  failed = true;
  console.log(`ERROR ${error?.stack ?? error}`);
} finally {
  await browser?.close().catch(() => undefined);
  await stopAll();
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} steps passed`);
  for (const result of results.filter((r) => !r.ok))
    console.log(`  ${result.name}: ${result.error}`);
  if (failed) {
    for (const started of children)
      NodeFS.writeFileSync(NodePath.join(root, `${started.name}.log`), started.log);
    console.log(`logs and state in ${root}`);
  }
  if (!keep && !failed) NodeFS.rmSync(root, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}
