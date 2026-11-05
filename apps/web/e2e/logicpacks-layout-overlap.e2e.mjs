#!/usr/bin/env node
// Header controls never collide, in either layout, either sidebar state, at phone to desktop widths:
//   node apps/web/e2e/logicpacks-layout-overlap.e2e.mjs [--port 3941] [--web-port 5941] [--shots <dir>] [--keep]
//                                                       [--web-dir <apps/web copy>]  (to run an older client) [--continue]
// A LAPTOP host (no code, no cloud) and the Vite dev client. The host owner (Hal) shares a project
// by link, Bo joins as a member; both open the same thread and the test measures the bounding box of
// every control in every header: chat header (project chip, sync chip, people, Share, tools tray),
// the window-corner controls (maximize, layout switcher, panel toggles), the Files/editor tab bar,
// the sidebar header and the sidebar toggle. It fails on any intersection, clipping, or control that
// is neither visible nor inside the "more" tray.
//   1 Dev opens at 70% files and editor, 30% chat; a dragged width is kept after reload
//   2 widths 320 400 480 600 900 1280 x Dev/Vibe x sidebar open/collapsed x Hal and Bo
//   3 Dev chat column 280..700 in 40 px steps (and the 70/30 default)
//   4 the "more" tray: every moved control is reachable and does not collide
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
const port = Number(option("--port", 3941));
const webPort = Number(option("--web-port", 5941));
const keep = args.includes("--keep");
// Run every step even after a failure (to list all the collisions of an older client).
const keepGoing = args.includes("--continue");
const shotsDir = option("--shots", null);
const WEB = `http://127.0.0.1:${webPort}`;
const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const repo = NodePath.join(here, "../../..");
const serverDir = NodePath.join(repo, "apps/server");
const webDir = option("--web-dir", NodePath.join(repo, "apps/web"));
const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lp-layout-overlap-"));
if (shotsDir) NodeFS.mkdirSync(shotsDir, { recursive: true });
const run = Date.now().toString(36).slice(-6);
const PASSWORD = "correct-horse-battery";
const PROJECT = `lp-demo-${run}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const home = NodePath.join(root, "host");
NodeFS.mkdirSync(NodePath.join(home, "userdata"), { recursive: true });

// ── Processes ───────────────────────────────────────────────────────────────
const children = {};
function spawnLogged(name, command, commandArgs, options, readyText) {
  const child = NodeChildProcess.spawn(command, commandArgs, {
    ...options,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  const started = { name, child, log: "", killed: false };
  children[name] = started;
  started.ready = new Promise((resolve, reject) => {
    const onData = (chunk) => {
      started.log += chunk;
      if (started.log.length > 400_000) started.log = started.log.slice(-200_000);
      if (readyText.some((text) => started.log.includes(text))) resolve();
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code) => {
      if (!started.killed) reject(new Error(`${name} exited (${code})\n${started.log.slice(-2000)}`));
    });
  });
  started.ready.catch(() => undefined);
  return started;
}
async function stopAll() {
  for (const started of Object.values(children).toReversed()) {
    started.killed = true;
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
const notes = [];
const note = (text) => {
  notes.push(text);
  console.log(`     ${text}`);
};
async function step(name, body) {
  const started = Date.now();
  if (failed && !keepGoing) {
    results.push({ name, ok: false, ms: 0, error: "skipped after an earlier failure" });
    return;
  }
  try {
    await body();
    results.push({ name, ok: true, ms: Date.now() - started });
    console.log(`PASS ${name}`);
  } catch (error) {
    failed = true;
    results.push({ name, ok: false, ms: Date.now() - started, error: String(error?.message ?? error) });
    console.log(`FAIL ${name}\n${String(error?.message ?? error).split("\n").map((l) => `     ${l}`).join("\n")}`);
    for (const [index, page] of pages.entries())
      await page.screenshot({ path: NodePath.join(shotsDir ?? root, `fail-${results.length}-${index}.png`) }).catch(() => undefined);
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
    await sleep(300);
  }
  throw new Error(`timed out waiting for ${what} (last: ${JSON.stringify(last)?.slice(0, 400)})`);
}
const shot = async (page, name) => {
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
async function newPage(browser, width = 1500, height = 900) {
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();
  pages.push(page);
  return page;
}

// ── In-page measurement ─────────────────────────────────────────────────────
// Everything runs in the page: it returns plain data, the node side judges it.
const MEASURE = () => {
  const REGIONS = [
    ["chat header", "[data-chat-header]"],
    ["panel tab bar", "[data-right-panel-tabbar]"],
    ["window controls", "[data-workspace-titlebar-controls]"],
    ["sidebar toggle", "[data-sidebar-control]"],
    ["sidebar header", '[data-sidebar="header"], [data-slot="sidebar-header"]'],
  ];
  const INTERACTIVE = 'button, a[href], [role="button"], [role="tab"], [role="combobox"], input, h2, [data-lp-project-chip]';
  const labelOf = (element) => {
    const bits = [
      element.getAttribute("data-testid"),
      element.getAttribute("aria-label"),
      element.tagName === "H2" ? "thread title" : null,
      element.hasAttribute("data-lp-project-chip") ? "project chip" : null,
      (element.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 24) || null,
    ].filter(Boolean);
    return bits.slice(0, 2).join(" | ") || element.tagName.toLowerCase();
  };
  const visible = (element) => {
    const box = element.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) return false;
    return element.checkVisibility({ checkVisibilityCSS: true, opacityProperty: true });
  };
  const clipRects = (element) => {
    const clips = [];
    for (let node = element.parentElement; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      const clipping = [style.overflowX, style.overflowY].some((v) => v !== "visible");
      if (clipping && node !== document.body && node !== document.documentElement) {
        clips.push({ box: node.getBoundingClientRect(), who: labelOf(node) });
      }
    }
    return clips;
  };
  const found = new Map();
  // A phone-width sidebar is a modal sheet laid over the page on purpose: while it is open only
  // its own header and the toggle are judged (the page underneath is judged with it closed).
  const sheet = document.querySelector('[data-mobile="true"]');
  const sheetOpen = sheet !== null && visible(sheet);
  // A collapsed sidebar is slid off the left edge: its controls are not on screen.
  const sidebarHidden = document.querySelector("[data-sidebar-state]")?.getAttribute("data-sidebar-state") === "collapsed";
  for (const [region, selector] of REGIONS) {
    if (sheetOpen && !["sidebar toggle", "sidebar header"].includes(region)) continue;
    if (sidebarHidden && region === "sidebar header") continue;
    for (const container of document.querySelectorAll(selector)) {
      const cbox = container.getBoundingClientRect();
      for (const element of container.querySelectorAll(INTERACTIVE)) {
        if (!visible(element) || element.closest(".sr-only") || element.matches(".sr-only")) continue;
        if (element.closest("[data-lp-overflow-tray]")) continue;
        // The tray hangs under the bar on purpose; it is judged in its own step.
        const box = element.getBoundingClientRect();
        if (box.top > cbox.bottom + 1 && !container.matches("[data-workspace-titlebar-controls]")) continue;
        if (!found.has(element)) found.set(element, region);
      }
    }
  }
  const sidebar = document.querySelector('[data-slot="sidebar-inner"], [data-sidebar="sidebar"]');
  if (sidebar && !sidebarHidden) {
    for (const element of sidebar.querySelectorAll(INTERACTIVE)) {
      if (!visible(element)) continue;
      if (element.getBoundingClientRect().top < 100 && !found.has(element)) found.set(element, "sidebar header");
    }
  }
  const items = [...found].map(([element, region]) => {
    const box = element.getBoundingClientRect();
    const tabList = element.closest("[data-right-panel-tab-list]");
    return {
      element,
      region,
      label: labelOf(element),
      box: { left: box.left, top: box.top, right: box.right, bottom: box.bottom },
      scrolls: tabList !== null,
      clips: clipRects(element),
    };
  });
  const violations = [];
  const eps = 1.5;
  const vw = window.innerWidth;
  for (const item of items) {
    const { box } = item;
    if (box.left < -eps || box.right > vw + eps) {
      violations.push(`${item.region}: "${item.label}" is outside the viewport (${Math.round(box.left)}..${Math.round(box.right)} of ${vw})`);
    }
    if (item.scrolls) continue;
    for (const clip of item.clips) {
      if (box.left < clip.box.left - eps || box.right > clip.box.right + eps) {
        violations.push(
          `${item.region}: "${item.label}" is clipped by "${clip.who}" (${Math.round(box.left)}..${Math.round(box.right)} vs ${Math.round(clip.box.left)}..${Math.round(clip.box.right)})`,
        );
        break;
      }
    }
  }
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i];
      const b = items[j];
      if (a.element.contains(b.element) || b.element.contains(a.element)) continue;
      // Tabs scroll under each other's fade: only the tab bar's own non-tab controls are judged.
      const w = Math.min(a.box.right, b.box.right) - Math.max(a.box.left, b.box.left);
      const h = Math.min(a.box.bottom, b.box.bottom) - Math.max(a.box.top, b.box.top);
      if (w > eps && h > eps) {
        violations.push(`"${a.label}" (${a.region}) overlaps "${b.label}" (${b.region}) by ${Math.round(w)}x${Math.round(h)}`);
      }
    }
  }
  // Every overflow item: in the bar (visible) or in the tray (not visible until opened).
  const toolbars = [...document.querySelectorAll("[data-lp-overflow-toolbar]")].map((toolbar) => ({
    id: toolbar.getAttribute("data-testid") ?? "toolbar",
    items: [...toolbar.querySelectorAll(":scope > [data-lp-overflow-item]")].map((item) => ({
      id: item.getAttribute("data-lp-overflow-item"),
      moved: item.getAttribute("data-overflowed") === "true",
      width: Math.round(item.getBoundingClientRect().width),
    })),
    hasMore: toolbar.querySelector(":scope > [data-lp-overflow-trigger]") !== null,
  }));
  const chat = document.querySelector("[data-chat-column]")?.getBoundingClientRect();
  const panel = document.querySelector('[data-preview-panel-mode="inline"]')?.getBoundingClientRect();
  const mode = document.querySelector("[data-layout-mode]")?.getAttribute("data-layout-mode") ?? null;
  const sidebarState = document.querySelector("[data-sidebar-state]")?.getAttribute("data-sidebar-state") ?? null;
  return {
    violations: [...new Set(violations)],
    controls: items.length,
    toolbars,
    chatWidth: chat ? Math.round(chat.width) : 0,
    panelWidth: panel ? Math.round(panel.width) : 0,
    mode,
    sidebarState,
  };
};

const measure = async (page) => {
  // Hover tooltips from the last click are not part of the layout under test.
  await page.mouse.move(2, 2);
  await page.keyboard.press("Escape");
  return page.evaluate(MEASURE);
};
/** Opens every "more" tray and measures again: moved controls must be reachable and clear. */
async function measureWithTrays(page) {
  const base = await measure(page);
  const problems = [...base.violations];
  const triggers = page.locator("[data-lp-overflow-trigger]");
  const count = await triggers.count();
  for (let index = 0; index < count; index++) {
    const trigger = triggers.nth(index);
    if (!(await trigger.isVisible())) continue;
    await trigger.click({ force: true });
    await sleep(150);
    const opened = await page.evaluate(() => {
      const out = [];
      const trays = [...document.querySelectorAll("[data-lp-overflow-tray]")].filter(
        (tray) => tray.checkVisibility({ checkVisibilityCSS: true }),
      );
      for (const tray of trays) {
        const tbox = tray.getBoundingClientRect();
        const toolbar = tray.parentElement;
        const bar = toolbar.getBoundingClientRect();
        if (tbox.left < -1.5 || tbox.right > window.innerWidth + 1.5) out.push(`tray is outside the viewport (${Math.round(tbox.left)}..${Math.round(tbox.right)})`);
        if (tbox.top < bar.bottom - 1.5) out.push("tray overlaps its own bar");
        const moved = [...toolbar.querySelectorAll(':scope > [data-lp-overflow-item][data-overflowed="true"]')];
        let last = null;
        for (const item of moved) {
          const ibox = item.getBoundingClientRect();
          const shown = item.checkVisibility({ checkVisibilityCSS: true });
          const empty = ibox.width < 1;
          if (!shown && !empty) out.push(`moved control "${item.getAttribute("data-lp-overflow-item")}" is not shown while the tray is open`);
          if (ibox.left < tbox.left - 1.5 || ibox.right > tbox.right + 1.5 || ibox.bottom > tbox.bottom + 1.5) {
            out.push(`moved control "${item.getAttribute("data-lp-overflow-item")}" sticks out of the tray`);
          }
          if (last && ibox.top < last.bottom - 1.5) out.push(`moved controls overlap in the tray ("${item.getAttribute("data-lp-overflow-item")}")`);
          last = ibox;
        }
        out.push(`ok:${moved.length}`);
      }
      return out;
    });
    for (const line of opened) if (!line.startsWith("ok:")) problems.push(line);
    await page.keyboard.press("Escape");
    await sleep(100);
  }
  return { ...base, problems, trays: count };
}

async function setSidebar(page, wanted) {
  const state = await page.evaluate(() => document.querySelector("[data-sidebar-state]")?.getAttribute("data-sidebar-state"));
  if (state === wanted) return;
  // The window-corner toggle (a second, hidden trigger can come first in the DOM).
  const trigger = page.locator('[data-sidebar-control] [data-sidebar="trigger"]').first();
  // Narrow windows turn the sidebar into a sheet with its own opener: nothing to toggle here.
  if (!(await trigger.isVisible())) return;
  await trigger.click();
  await waitFor(`sidebar ${wanted}`, async () =>
    (await page.evaluate(() => document.querySelector("[data-sidebar-state]")?.getAttribute("data-sidebar-state"))) === wanted ? true : null,
  );
  await sleep(450);
}
async function setLayout(page, id) {
  const mode = await page.evaluate(() => document.querySelector("[data-layout-mode]")?.getAttribute("data-layout-mode"));
  if (mode === id) return;
  await page.getByTestId("lp-layout-switcher").click();
  await page.getByTestId(`lp-layout-option-${id}`).click();
  await page.keyboard.press("Escape");
  await waitFor(`layout ${id}`, async () =>
    (await page.evaluate(() => document.querySelector("[data-layout-mode]")?.getAttribute("data-layout-mode"))) === id ? true : null,
  );
  await sleep(500);
}
async function openThread(page) {
  const row = page.getByText("claude session").first();
  await row.waitFor({ timeout: 45_000 });
  await row.click({ force: true });
  await page.locator("[data-chat-header]").first().waitFor({ timeout: 45_000 });
  await page.locator("[data-lp-project-chip]").first().waitFor({ timeout: 45_000 });
  await sleep(1000);
}

let browser;
try {
  const env = { ...process.env, LOGICPACKS_SYNC_SECONDS: "0", LOGICPACKS_GOALS_JUDGE: "off" };
  for (const key of Object.keys(env)) if (key.startsWith("LOGICPACKS_") && !["LOGICPACKS_SYNC_SECONDS", "LOGICPACKS_GOALS_JUDGE"].includes(key)) delete env[key];
  note(`work dir ${root}`);
  spawnLogged(
    "host",
    process.execPath,
    ["src/bin.ts", "serve", "--port", String(port), "--host", "127.0.0.1", "--base-dir", home, "--no-browser"],
    { cwd: serverDir, env },
    ["Pairing URL:"],
  );
  const webEnv = { ...process.env, LOGICPACKS_SINGLE_ORIGIN_DEV: "1", LOGICPACKS_PORT: String(port), PORT: String(webPort), HOST: "127.0.0.1" };
  spawnLogged("web", NodePath.join(repo, "node_modules/.bin/vp"), ["dev"], { cwd: webDir, env: webEnv }, ["ready in", "Local:"]);
  await Promise.all([children.host.ready, children.web.ready]);
  browser = await chromium.launch({ headless: true });

  let hal;
  let bo;
  const who = () => [["Hal (host owner)", hal], ["Bo (member)", bo]];

  await step("0 Hal shares a project by link, Bo joins, both open the same thread", async () => {
    hal = await newPage(browser);
    const pairing = children.host.log.match(/Pairing URL: (\S+)/)?.[1];
    expect(pairing, "no pairing URL");
    const pairUrl = new URL(pairing);
    await hal.goto(`${WEB}${pairUrl.pathname}${pairUrl.search}${pairUrl.hash}`);
    await hal.waitForURL((url) => !url.pathname.startsWith("/pair"), { timeout: 30_000 });
    await hal.waitForLoadState("load");
    await sleep(2_000);
    const created = await pageApi(hal, "/api/lp/projects/new", { kind: "template", name: PROJECT, template: "website" });
    expect(created.projectId, `project not created: ${JSON.stringify(created)}`);
    const made = await pageApi(hal, "/api/lp/shares/link", { projectId: created.projectId, enabled: true });
    expect(made.link?.path, `share link: ${JSON.stringify(made)}`);
    // A thread without a model provider: an agent connected through the lp CLI.
    const reg = await pageApi(hal, "/api/lp/connect/register", {
      cwd: NodePath.join(home, "projects", PROJECT),
      sessionId: `layout-${run}`,
      harness: "claude",
    });
    expect(reg.threadId, `register: ${JSON.stringify(reg)}`);
    bo = await newPage(browser);
    await bo.goto(`${WEB}${made.link.path}`);
    await bo.locator("h1", { hasText: "Join the project" }).waitFor({ timeout: 45_000 });
    await bo.fill("#name", "Bo");
    await bo.fill("#email", `bo-${run}@example.com`);
    await bo.fill("#password", PASSWORD);
    await bo.click("#submit");
    await bo.waitForURL((u) => u.origin === WEB && !u.pathname.startsWith("/lp/"), { timeout: 30_000 });
    await Promise.all([openThread(hal), openThread(bo)]);
    for (const [, page] of who()) await setLayout(page, "dev");
    await shot(hal, "00-hal-dev");
    await shot(bo, "00-bo-dev");
  });

  await step("1 Dev opens at 70% files and editor, 30% chat; a dragged width is kept", async () => {
    for (const [name, page] of who()) {
      await page.setViewportSize({ width: 1500, height: 900 });
      await setSidebar(page, "expanded");
      await sleep(600);
      const state = await measure(page);
      const total = state.chatWidth + state.panelWidth;
      const share = state.panelWidth / total;
      note(`${name}: files/editor ${state.panelWidth}px, chat ${state.chatWidth}px (${(share * 100).toFixed(1)}% / ${((1 - share) * 100).toFixed(1)}%)`);
      expect(Math.abs(share - 0.7) < 0.02, `${name}: Dev default is ${(share * 100).toFixed(1)}% files, not 70%`);
    }
    // Drag the split so chat is about 360px wide, reload: the dragged width wins over the default.
    const page = bo;
    const handle = page.locator('[data-preview-panel-mode="inline"] [role="separator"]').first();
    const hbox = await handle.boundingBox();
    const before = await measure(page);
    const targetX = hbox.x + hbox.width / 2 + (before.chatWidth - 360);
    await page.mouse.move(hbox.x + hbox.width / 2, hbox.y + 200);
    await page.mouse.down();
    await page.mouse.move(targetX, hbox.y + 200, { steps: 8 });
    await page.mouse.up();
    await sleep(500);
    const dragged = await measure(page);
    note(`after the drag: files ${dragged.panelWidth}px, chat ${dragged.chatWidth}px (was ${before.panelWidth}/${before.chatWidth})`);
    expect(Math.abs(dragged.chatWidth - 360) < 8, `the drag did not set the chat to 360px (${dragged.chatWidth})`);
    await page.reload();
    await openThread(page);
    await sleep(800);
    const kept = await measure(page);
    expect(Math.abs(kept.chatWidth - dragged.chatWidth) < 4, `the dragged width was not kept: ${dragged.chatWidth} -> ${kept.chatWidth}`);
    // Back to the default for the sweeps.
    await page.evaluate(() => {
      for (const key of Object.keys(localStorage)) if (key.startsWith("logicpacks:preview-panel-width")) localStorage.removeItem(key);
    });
    await page.reload();
    await openThread(page);
  });

  const widths = [320, 400, 480, 600, 900, 1280];
  await step("2 widths x layouts x sidebar states x people: no header control collides or is clipped", async () => {
    const bad = [];
    let states = 0;
    for (const [name, page] of who()) {
      for (const layout of ["dev", "vibe"]) {
        await setLayout(page, layout);
        for (const sidebar of ["expanded", "collapsed"]) {
          for (const width of widths) {
            await page.setViewportSize({ width, height: 800 });
            await setSidebar(page, sidebar);
            await sleep(500);
            const result = await measureWithTrays(page);
            states++;
            const tag = `${name} / ${layout} / sidebar ${sidebar} / ${width}px`;
            // Phone widths turn the sidebar into a sheet (closed here); wider ones must really be in the state asked for.
            if (width > 768 && result.sidebarState !== sidebar) result.problems.push(`the sidebar is ${result.sidebarState}, not ${sidebar}`);
            if (result.problems.length > 0) {
              bad.push(`${tag}: ${result.problems.join("; ")}`);
              await shot(page, `bad-${name.split(" ")[0]}-${layout}-${sidebar}-${width}`);
            } else if (shotsDir && (width === 480 || width === 1280)) {
              await shot(page, `ok-${name.split(" ")[0]}-${layout}-${sidebar}-${width}`);
            }
          }
        }
      }
    }
    note(`${states} states measured, ${bad.length} with problems`);
    if (bad.length > 0) throw new Error(`${bad.length} of ${states} states collide:\n${bad.slice(0, 40).join("\n")}`);
  });

  // The inline workspace panel needs a window wider than 980 px, so the chat column is narrowed by
  // dragging the split (the same drag a person does), in a 1280 px window with the sidebar collapsed.
  async function prepareDevRow(page, sidebarWanted) {
    await setLayout(page, "dev");
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.evaluate(() => {
      for (const key of Object.keys(localStorage)) if (key.startsWith("logicpacks:preview-panel-width")) localStorage.removeItem(key);
    });
    await page.reload();
    await openThread(page);
    // Applying the Dev mode (on load, when the panel opens) also opens the sidebar: let that
    // settle, open the panel, and only then collapse the sidebar.
    await sleep(2000);
    if ((await page.locator('[data-preview-panel-mode="inline"]').count()) === 0) {
      await page.getByRole("button", { name: "Toggle right panel" }).first().click();
      await sleep(1000);
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      await setSidebar(page, sidebarWanted);
      await sleep(800);
    }
    await sleep(600);
    const state = await measure(page);
    const triggerShown = await page.locator('[data-sidebar-control] [data-sidebar="trigger"]').first().isVisible().catch(() => false);
    expect(state.panelWidth > 0 && state.sidebarState === sidebarWanted, `Dev row is not ready (panel ${state.panelWidth}px, sidebar ${state.sidebarState}, trigger visible ${triggerShown})`);
    return state;
  }
  async function dragChatTo(page, chat) {
    const handle = page.locator('[data-preview-panel-mode="inline"] [role="separator"]').first();
    const hbox = await handle.boundingBox();
    const before = await measure(page);
    const x = hbox.x + hbox.width / 2;
    await page.mouse.move(x, hbox.y + 200);
    await page.mouse.down();
    await page.mouse.move(x + (before.chatWidth - chat), hbox.y + 200, { steps: 6 });
    await page.mouse.up();
    await sleep(500);
  }

  await step("3 Dev chat column 280..700 px (40 px steps): clean, and the default is 30% chat", async () => {
    const bad = [];
    let states = 0;
    let skipped = 0;
    for (const [name, page] of who()) {
      // With the sidebar open every width 280..700 is reachable; with it collapsed the panel's 70% cap
      // keeps the chat above ~30% of the window, so the widths below that are not a reachable state.
      for (const sidebar of ["expanded", "collapsed"]) {
        const first = await prepareDevRow(page, sidebar);
        const share = first.panelWidth / (first.panelWidth + first.chatWidth);
        note(`${name} / sidebar ${sidebar}: default at 1280 px: files ${first.panelWidth}px, chat ${first.chatWidth}px (${(share * 100).toFixed(1)}% / ${((1 - share) * 100).toFixed(1)}%)`);
        if (Math.abs(share - 0.7) > 0.02) bad.push(`${name} / ${sidebar}: default is ${(share * 100).toFixed(1)}% files, not 70%`);
        const defaultResult = await measureWithTrays(page);
        states++;
        if (defaultResult.problems.length > 0) bad.push(`${name} / ${sidebar} / default 70-30: ${defaultResult.problems.join("; ")}`);
        for (let chat = 280; chat <= 700; chat += 40) {
          await dragChatTo(page, chat);
          const result = await measureWithTrays(page);
          const tag = `${name} / sidebar ${sidebar} / chat ${result.chatWidth}px (asked ${chat})`;
          if (Math.abs(result.chatWidth - chat) > 12) {
            if (sidebar === "collapsed") {
              skipped++;
              continue;
            }
            bad.push(`${tag}: chat column is not the width asked for`);
          }
          states++;
          if (result.problems.length > 0) {
            bad.push(`${tag}: ${result.problems.join("; ")}`);
            await shot(page, `bad-chat-${name.split(" ")[0]}-${sidebar}-${chat}`);
          } else if (shotsDir && (chat === 280 || chat === 360 || chat === 440)) {
            await shot(page, `ok-chat-${name.split(" ")[0]}-${sidebar}-${chat}`);
          }
        }
      }
    }
    note(`${states} chat widths measured (incl. the 70/30 defaults), ${skipped} unreachable with the sidebar collapsed, ${bad.length} with problems`);
    if (bad.length > 0) throw new Error(`${bad.length} of ${states} chat widths collide:\n${bad.slice(0, 40).join("\n")}`);
  });

  await step("4 the more tray keeps every control reachable (nothing lost at 280 px)", async () => {
    const page = bo;
    await prepareDevRow(page, "expanded");
    await dragChatTo(page, 280);
    const state = await measure(page);
    const moved = state.toolbars.flatMap((bar) => bar.items.filter((item) => item.moved).map((item) => `${bar.id}:${item.id}`));
    note(`at a ${state.chatWidth}px chat column ${moved.length} controls sit in the tray: ${moved.join(", ") || "none"}`);
    expect(moved.length > 0, "nothing moved into the more tray at 280px: the test cannot see the overflow");
    for (const bar of state.toolbars) {
      const movedHere = bar.items.some((item) => item.moved);
      expect(!movedHere || bar.hasMore, `${bar.id} moved controls but has no more button`);
    }
    await shot(page, "04-chat-280");
    const trigger = page.locator('[data-testid="lp-header-controls"] [data-lp-overflow-trigger]').first();
    if (await trigger.isVisible()) {
      await trigger.click();
      await sleep(200);
      await shot(page, "04-tray-open");
      await page.keyboard.press("Escape");
    }
  });
} catch (error) {
  failed = true;
  console.log(`FAIL setup\n     ${String(error?.message ?? error).split("\n")[0]}`);
  results.push({ name: "setup", ok: false, ms: 0, error: String(error?.message ?? error) });
} finally {
  await browser?.close().catch(() => undefined);
  await stopAll();
  if (!keep) NodeFS.rmSync(root, { recursive: true, force: true });
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} steps passed${failed ? " (FAILED)" : ""}`);
  process.exit(failed ? 1 : 0);
}
