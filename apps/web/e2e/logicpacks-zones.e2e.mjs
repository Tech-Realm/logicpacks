#!/usr/bin/env node
// Access zones, end to end, on a LAPTOP host:
//   node apps/web/e2e/logicpacks-zones.e2e.mjs [--port 3931] [--web-port 5931] [--origin <url>]
//        [--claude-token-file <file>] [--shots <dir>] [--keep]
// The host owner (Hal) shares a project with a link; Bo and Cy join as members. The agent is the
// scripted ACP mock (lp-ledger-mock-agent.mjs): "run! <cmd>" and "edit! <file> <text>" ask the host
// for permission like a real agent's execute and edit tools, so the zone limits show.
//   1  Hal makes a project and a link; Bo and Cy join: they start on Can edit (the default)
//   2  Can edit:     upload and zip work, secret files are hidden, no terminal, agent edits but cannot run
//   3  Chat only:    no files, no upload, agent can neither edit nor run, chat still works
//   4  Share dialog: presets and Advanced render from the registry, Full access needs the confirmation
//   5  Full access:  terminal opens and is logged, the agent can run commands, Terminal badge shows
//   6  live revocation: Hal turns Compute off, Bo's open terminal is closed and the panel appears at once
//   7  Read only:    sending, upload and agent runs are refused; reading and zip still work
//   8  AI zone request: Cy has no host agent, requests it, Hal allows (and a second request is denied)
//   9  terminal request: Cy asks for terminal access; the blunt warning gates the Allow
//  10  per-member override beats the share-link default, and a default change applies at once
//  11  (optional, --claude-token-file) real Haiku turn on the host's Claude: Can edit answers, Chat only cannot run bash
// `--origin <url>` sends every page and API call through that base URL (a public relay hostname)
// instead of the local one; the host still runs here so files and logs can be checked.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
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
const port = Number(option("--port", 3931));
const webPort = Number(option("--web-port", 5931));
// --public-relay: the members (Bo, Cy) reach the host through the deployed relay at a name this run
// chooses up front; Hal, the owner, stays on the host's own address (the relay never carries the owner).
const publicRelay = args.includes("--public-relay");
const relayIdentity = (() => {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  const bytes = NodeCrypto.randomBytes(26);
  return {
    id: Array.from(bytes, (b) => alphabet[b % 32]).join(""),
    secret: NodeCrypto.randomBytes(32).toString("base64url"),
  };
})();
const origin = publicRelay ? `https://${relayIdentity.id}.logicpacks.io` : option("--origin", null);
const claudeTokenFile = option("--claude-token-file", null);
const keep = args.includes("--keep");
const shotsDir = option("--shots", null);
const WEB = origin ? origin.replace(/\/+$/, "") : `http://127.0.0.1:${webPort}`;
const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const repo = NodePath.join(here, "../../..");
const serverDir = NodePath.join(repo, "apps/server");
const webDir = NodePath.join(repo, "apps/web");
const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lp-zones-"));
if (shotsDir) NodeFS.mkdirSync(shotsDir, { recursive: true });
const run = Date.now().toString(36).slice(-6);
const PASSWORD = "correct-horse-battery";
const PROJECT = `Zones ${run}`;
const mockLog = NodePath.join(root, "mock-agent.log");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const COMPUTE_SENTENCE =
  "Off blocks the terminal and the agent's shell tool. It cannot stop an agent you let edit files from writing code that someone later runs.";

const home = NodePath.join(root, "host");
NodeFS.mkdirSync(NodePath.join(home, "userdata"), { recursive: true });
if (publicRelay) {
  NodeFS.writeFileSync(NodePath.join(home, "userdata", "share-relay.json"), JSON.stringify(relayIdentity), { mode: 0o600 });
}
const HAL = publicRelay ? `http://127.0.0.1:${port}` : null;
const hostSettings = {
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
};
NodeFS.writeFileSync(NodePath.join(home, "userdata/settings.json"), JSON.stringify(hostSettings));

// ── Processes ───────────────────────────────────────────────────────────────
const children = {};
function spawnLogged(name, command, commandArgs, options, readyText) {
  const child = NodeChildProcess.spawn(command, commandArgs, { ...options, stdio: ["ignore", "pipe", "pipe"], detached: true });
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
async function stopChild(started) {
  started.killed = true;
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    try {
      process.kill(-started.child.pid, signal);
    } catch {
      return;
    }
    for (let waited = 0; waited < 6_000; waited += 200) {
      try {
        process.kill(-started.child.pid, 0);
      } catch {
        return;
      }
      await sleep(200);
    }
  }
}
const serverEnv = (extra = {}) => {
  const env = { ...process.env, LP_MOCK_LOG: mockLog };
  for (const key of Object.keys(env)) if (key.startsWith("LOGICPACKS_")) delete env[key];
  return { ...env, LOGICPACKS_SYNC_SECONDS: "0", LOGICPACKS_GOALS_JUDGE: "off", ...extra };
};
const startHost = (env = {}) =>
  spawnLogged(
    "host",
    process.execPath,
    ["src/bin.ts", "serve", "--port", String(port), "--host", "127.0.0.1", "--base-dir", home, "--no-browser"],
    { cwd: serverDir, env: serverEnv(env) },
    ["Pairing URL:"],
  );

// ── Harness ─────────────────────────────────────────────────────────────────
const results = [];
const pages = [];
let failed = false;
const note = (text) => console.log(`     ${text}`);
const matrix = [];
/** One line per (path, zone) check: what was tried and what the server said. */
const record = (path, who, what, outcome) => {
  matrix.push({ path, who, what, outcome });
};
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
    results.push({ name, ok: false, ms: Date.now() - started, error: String(error?.message ?? error) });
    console.log(`FAIL ${name}\n     ${String(error?.message ?? error).split("\n").slice(0, 4).join(" | ")}`);
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
    await sleep(400);
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
/** A file upload as the page's own session; the status and the JSON answer. */
const pageUpload = (page, projectId, path, text) =>
  page.evaluate(
    async ([projectId, path, text]) => {
      const response = await fetch(`/api/lp/projects/upload?projectId=${encodeURIComponent(projectId)}&folder=&path=${encodeURIComponent(path)}&conflict=replace`, {
        method: "POST",
        credentials: "include",
        body: text,
      });
      return { httpStatus: response.status, ...(await response.json().catch(() => ({}))) };
    },
    [projectId, path, text],
  );
/** The project zip as the page's session: the status and whether a name is inside the archive. */
const pageZip = (page, projectId, needles) =>
  page.evaluate(
    async ([projectId, needles]) => {
      const response = await fetch(`/api/lp/projects/zip?projectId=${encodeURIComponent(projectId)}`, { credentials: "include" });
      if (!response.ok) return { httpStatus: response.status, ...(await response.json().catch(() => ({}))) };
      const text = new TextDecoder("latin1").decode(new Uint8Array(await response.arrayBuffer()));
      return { httpStatus: 200, has: Object.fromEntries(needles.map((needle) => [needle, text.includes(needle)])) };
    },
    [projectId, needles],
  );
async function newPage(browser) {
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const page = await context.newPage();
  pages.push(page);
  return page;
}
async function openProject(page, title) {
  // The owner stays on the host's own address; members use the public name.
  await page.goto(`${page.__owner && HAL ? HAL : WEB}/`);
  const heading = page.locator("main h1 button, main h2 button").first();
  await heading.waitFor({ timeout: 45_000 });
  if ((await heading.innerText()).trim() !== title) {
    await heading.click();
    await page.locator('[role="listbox"]').getByText(title, { exact: true }).click();
  }
  await page.waitForFunction(
    (name) => (document.querySelector("main")?.textContent ?? "").replace(/\s+/g, "").includes(`buildin${name}`),
    title.replace(/\s+/g, ""),
    { timeout: 30_000 },
  );
}
async function sendMessage(page, text) {
  const composer = page.locator('[contenteditable="true"]').first();
  await composer.waitFor({ timeout: 30_000 });
  await composer.click();
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
}
const lastReply = async (page, prompt) => (await page.locator("main").innerText()).split(prompt).join("");
const waitForReply = (page, needle, prompt, timeout = 60_000) =>
  waitFor(
    `a reply containing ${needle}`,
    async () => {
      const text = await lastReply(page, prompt);
      return !/Working for|Thinking/.test(text) && text.includes(needle) ? text : null;
    },
    timeout,
  );
const read = (file) => (NodeFS.existsSync(file) ? NodeFS.readFileSync(file, "utf8") : null);
const cwdOf = (text) => /\(cwd ([^)]+)\)/.exec(text)?.[1] ?? null;

/** The project's checkout on the host: the git folder under the host dir that is named for it. */
function findProjectRoot() {
  const slug = PROJECT.toLowerCase().replace(/[^a-z0-9]+/g, "");
  let found = null;
  const walk = (dir, depth) => {
    if (found || depth > 5) return;
    for (const entry of NodeFS.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === "node_modules" || entry.name === ".git") continue;
      const full = NodePath.join(dir, entry.name);
      if (NodeFS.existsSync(NodePath.join(full, ".git")) && full.toLowerCase().replace(/[^a-z0-9]+/g, "").includes(slug)) {
        found = full;
        return;
      }
      walk(full, depth + 1);
    }
  };
  walk(home, 0);
  return found;
}

let browser;
try {
  note(`work dir ${root}${origin ? `; all calls through ${WEB}` : ""}`);
  startHost();
  const web = origin && !publicRelay
    ? null
    : spawnLogged(
        "web",
        NodePath.join(repo, "node_modules/.bin/vp"),
        ["dev"],
        { cwd: webDir, env: { ...process.env, LOGICPACKS_SINGLE_ORIGIN_DEV: "1", LOGICPACKS_PORT: String(port), PORT: String(webPort), HOST: "127.0.0.1" } },
        ["ready in", "Local:"],
      );
  await Promise.all([children.host.ready, web?.ready].filter(Boolean));
  browser = await chromium.launch({ headless: true });

  let hal;
  let bo;
  let cy;
  let boId;
  let cyId;
  let projectId;
  let projectRoot;
  const setAccess = (userId, preset, extra = {}) =>
    pageApi(hal, "/api/lp/access/set", { projectId, ...(userId ? { userId } : {}), preset, ...extra });
  const sessionSeat = async (page) => (await pageApi(page, "/api/lp/session")).access?.[projectId];
  const accessLog = async () => (await pageApi(hal, `/api/lp/access?projectId=${projectId}`)).log ?? [];
  const seatEventually = (page, preset) =>
    waitFor(`seat ${preset}`, async () => (await sessionSeat(page))?.preset === preset, 15_000);

  await step("1 Hal makes a project and a share link; Bo and Cy join and start on Can edit", async () => {
    hal = await newPage(browser);
    hal.__owner = true;
    const pairing = children.host.log.match(/Pairing URL: (\S+)/)?.[1];
    expect(pairing, "no pairing URL");
    const pairUrl = new URL(pairing);
    await hal.goto(`${HAL ?? WEB}${pairUrl.pathname}${pairUrl.search}${pairUrl.hash}`);
    await hal.waitForURL((url) => !url.pathname.startsWith("/pair"), { timeout: 30_000 });
    await hal.waitForLoadState("load");
    await sleep(2_000);
    const created = await pageApi(hal, "/api/lp/projects/new", { kind: "template", name: PROJECT, template: "website" });
    expect(created.projectId, `project not created: ${JSON.stringify(created)}`);
    projectId = created.projectId;
    projectRoot = created.workspaceRoot ?? created.path ?? findProjectRoot();
    expect(projectRoot, "could not find the project folder on the host");
    const made = await pageApi(hal, "/api/lp/shares/link", { projectId, enabled: true });
    expect(made.link?.path, `share link: ${JSON.stringify(made)}`);
    if (publicRelay) {
      // The host opens its tunnel a moment after the link exists: wait until the public name answers.
      // Slowly: the relay rate-limits a stranger asking for a name that is not up yet.
      let up = false;
      for (let i = 0; i < 40 && !up; i++) {
        await sleep(i === 0 ? 4_000 : 2_000);
        const r = await fetch(`${WEB}${made.link.path}`).catch(() => null);
        up = r !== null && r.status === 200;
      }
      expect(up, "the public link never answered");
    }
    for (const [name, who] of [["Bo", "bo"], ["Cy", "cy"]]) {
      const page = await newPage(browser);
      await page.goto(`${WEB}${made.link.path}`);
      await page.locator("h1", { hasText: "Join the project" }).waitFor({ timeout: 45_000 });
      await page.fill("#name", name);
      await page.fill("#email", `${who}-${run}@example.com`);
      await page.fill("#password", PASSWORD);
      await page.click("#submit");
      await page.waitForURL((u) => u.origin === new URL(WEB).origin && !u.pathname.startsWith("/lp/"), { timeout: 30_000 });
      if (who === "bo") bo = page;
      else cy = page;
      const session = await pageApi(page, "/api/lp/session");
      const seat = session.access?.[projectId];
      expect(seat?.preset === "edit" && seat.source === "fallback", `${name} should start on Can edit: ${JSON.stringify(seat)}`);
      if (who === "bo") boId = session.user.userId;
      else cyId = session.user.userId;
      expect(session.hostAgents !== undefined, "session lacks hostAgents");
    }
    NodeFS.writeFileSync(NodePath.join(projectRoot, ".env"), "SECRET=1\n");
    NodeFS.writeFileSync(NodePath.join(projectRoot, "readme-zones.txt"), "hello\n");
    record("session", "Bo", "default seat", "Can edit (fallback)");
  });

  await step("2 Can edit: upload and zip work, secrets are hidden, no terminal, the agent edits but cannot run", async () => {
    const up = await pageUpload(bo, projectId, "bo-upload.txt", "from bo");
    expect(up.httpStatus === 200, `upload should work: ${JSON.stringify(up)}`);
    expect(read(NodePath.join(projectRoot, "bo-upload.txt")) === "from bo", "upload not on disk");
    const zip = await pageZip(bo, projectId, ["readme-zones.txt", ".env"]);
    expect(zip.httpStatus === 200 && zip.has["readme-zones.txt"] && !zip.has[".env"], `zip should hide .env: ${JSON.stringify(zip)}`);
    const secretUpload = await pageUpload(bo, projectId, ".env", "x");
    expect(secretUpload.httpStatus === 403 && secretUpload.error === "zone_off", `secret upload: ${JSON.stringify(secretUpload)}`);
    record("HTTP upload", "Bo/Can edit", "files.write", "allowed");
    record("HTTP zip", "Bo/Can edit", "files.read, secrets hidden", "allowed, .env left out");
    record("HTTP upload .env", "Bo/Can edit", "secret file", "403 zone_off");
    await openProject(bo, PROJECT);
    const note1 = await bo.locator('[data-testid="lp-composer-access-note"]').first().innerText({ timeout: 20_000 });
    expect(/Using host's/.test(note1), `composer should say whose agent: ${note1}`);
    record("composer", "Bo/Can edit", "note", note1);
    const editPrompt = "edit! zones-edit.txt written by the agent";
    await sendMessage(bo, editPrompt);
    const editReply = await waitForReply(bo, "WROTE zones-edit.txt", editPrompt);
    const cwd = cwdOf(editReply);
    expect(read(NodePath.join(cwd, "zones-edit.txt"))?.includes("written by the agent"), "agent edit missing");
    const runPrompt = "run! echo hi-from-agent";
    await sendMessage(bo, runPrompt);
    await waitForReply(bo, "REFUSED run: echo hi-from-agent", runPrompt);
    record("agent run", "Bo/Can edit", "edit tool", "allowed");
    record("agent run", "Bo/Can edit", "shell tool", "REFUSED (permission request denied by zone limits)");
    // The terminal: off, with the way to ask.
    await bo.getByLabel("Toggle terminal drawer").first().click();
    await bo.locator('[data-testid="lp-terminal-off"]').waitFor({ timeout: 20_000 });
    expect(await bo.locator('[data-testid="lp-request-terminal"]').count() === 1, "no Request terminal access action");
    expect(!(await bo.locator("main").innerText()).includes("Terminals are not available to members"), "old terminal text is still shown");
    record("terminal", "Bo/Can edit", "open", "panel with Request terminal access (server refuses terminal.open)");
    await shot(bo, "02-bo-can-edit");
  });

  await step("3 Chat only: no files, no upload, the agent can neither edit nor run, chat still works", async () => {
    const set = await setAccess(boId, "chat");
    expect(set.httpStatus === 200, `set chat: ${JSON.stringify(set)}`);
    await seatEventually(bo, "chat");
    const up = await pageUpload(bo, projectId, "chat-upload.txt", "x");
    expect(up.httpStatus === 403 && up.error === "zone_off", `upload: ${JSON.stringify(up)}`);
    const zip = await pageZip(bo, projectId, ["readme-zones.txt"]);
    expect(zip.httpStatus === 403, `zip: ${JSON.stringify(zip)}`);
    record("HTTP upload", "Bo/Chat only", "files.write", "403 zone_off");
    record("HTTP zip", "Bo/Chat only", "files.read", "403 zone_off");
    await openProject(bo, PROJECT);
    const editPrompt = "edit! chat-edit.txt should not exist";
    await sendMessage(bo, editPrompt);
    await waitForReply(bo, "REFUSED edit: chat-edit.txt", editPrompt);
    const runPrompt = "run! echo chat-run";
    await sendMessage(bo, runPrompt);
    await waitForReply(bo, "REFUSED run: echo chat-run", runPrompt);
    const hi = "just say hello";
    await sendMessage(bo, hi);
    await waitForReply(bo, "Done.", hi);
    record("agent run", "Bo/Chat only", "edit and shell tools", "both REFUSED; plain chat works");
    await shot(bo, "03-bo-chat-only");
  });

  await step("4 Share dialog: presets and Advanced render from the registry; Full access needs the confirmation", async () => {
    await hal.goto(`${HAL ?? WEB}/`);
    await openProject(hal, PROJECT);
    await hal.locator('[data-testid="lp-share-project-open"]').first().click();
    await hal.locator('[data-testid="lp-access"]').waitFor({ timeout: 20_000 });
    const noteText = await hal.locator('[data-testid="lp-access-ai-note"]').innerText();
    expect(/Claude subscription/.test(noteText), `subscription note: ${noteText}`);
    for (const id of ["chat", "edit", "full", "readonly"]) {
      expect(await hal.locator(`[data-testid="lp-access-default-${id}"]`).count() === 1, `preset ${id} missing`);
    }
    await hal.locator('[data-testid="lp-access-advanced-toggle"]').click();
    const guarantee = await hal.locator('[data-testid="lp-zone-guarantee-compute"]').innerText();
    expect(guarantee.includes(COMPUTE_SENTENCE), `compute guarantee text: ${guarantee}`);
    for (const zone of ["ai", "files", "compute"]) {
      expect(await hal.locator(`[data-testid="lp-zone-guarantee-${zone}"]`).count() === 1, `${zone} zone not rendered`);
    }
    // Server: a shell is never granted without the confirmation.
    const unconfirmed = await setAccess(boId, "full");
    expect(unconfirmed.httpStatus === 409 && unconfirmed.error === "confirm_required", `unconfirmed: ${JSON.stringify(unconfirmed)}`);
    record("HTTP access/set", "Hal", "Full access without confirmation", "409 confirm_required");
    // UI: the per-person select, then the blunt dialog.
    await hal.locator(`[data-testid="lp-access-member-${boId}"]`).click();
    await hal.getByRole("option", { name: "Full access" }).click();
    await hal.locator('[data-testid="lp-access-confirm"]').waitFor({ timeout: 10_000 });
    const warning = await hal.locator('[data-testid="lp-access-confirm"]').innerText();
    expect(/shell as the host's user/.test(warning) && /real computer/.test(warning), `warning text: ${warning}`);
    expect(await hal.locator('[data-testid="lp-access-confirm-go"]').isDisabled(), "Give full access should wait for the checkbox");
    await shot(hal, "04-share-dialog-full-confirm");
    await hal.locator('[data-testid="lp-access-confirm-checkbox"]').check();
    await hal.locator('[data-testid="lp-access-confirm-go"]').click();
    await hal.locator('[data-testid="lp-badge-terminal"]').first().waitFor({ timeout: 15_000 });
    await seatEventually(bo, "full");
    record("Share dialog", "Hal", "Full access to Bo", "blunt confirmation, then Terminal badge");
  });

  await step("5 Full access: the terminal opens and is logged, the agent can run commands, secrets are allowed", async () => {
    const zip = await pageZip(bo, projectId, [".env"]);
    expect(zip.httpStatus === 200 && zip.has[".env"], `Full access zip should include .env: ${JSON.stringify(zip)}`);
    record("HTTP zip", "Bo/Full access", "secret files", "allowed, .env included");
    await openProject(bo, PROJECT);
    const runPrompt = "run! echo ran-on-host";
    await sendMessage(bo, runPrompt);
    await waitForReply(bo, "RAN echo ran-on-host: ran-on-host", runPrompt);
    record("agent run", "Bo/Full access", "shell tool", "allowed");
    await bo.getByLabel("Toggle terminal drawer").first().click();
    await waitFor("terminal.open in the access log", async () => (await accessLog()).some((e) => e.kind === "terminal.open"), 30_000);
    expect(await bo.locator('[data-testid="lp-terminal-off"]').count() === 0, "terminal panel should be gone with Compute on");
    record("terminal (ws)", "Bo/Full access", "open", "allowed, logged to the access trail");
    const entry = (await accessLog()).find((e) => e.kind === "terminal.open");
    note(`access log: ${entry.name}: ${entry.detail}`);
    await shot(bo, "05-bo-full-access-terminal");
  });

  await step("6 live revocation: Compute off closes Bo's open terminal and shows the panel without a reload", async () => {
    const set = await setAccess(boId, "edit");
    expect(set.httpStatus === 200, `set edit: ${JSON.stringify(set)}`);
    // The panel shows by itself when the drawer is open; the new layout can close the drawer when its
    // only terminal is closed by the host, so the drawer is reopened and the panel must be there.
    const panel = bo.locator('[data-testid="lp-terminal-off"]');
    if (!(await panel.waitFor({ timeout: 8_000 }).then(() => true, () => false))) {
      note("the drawer closed with the terminal: reopening it shows the panel");
      await bo.getByLabel("Toggle terminal drawer").first().click();
      await panel.waitFor({ timeout: 20_000 });
    }
    await waitFor("terminal.revoked in the access log", async () => (await accessLog()).some((e) => e.kind === "terminal.revoked"), 20_000);
    const runPrompt = "run! echo after-revoke";
    await sendMessage(bo, runPrompt);
    await waitForReply(bo, "REFUSED run: echo after-revoke", runPrompt);
    record("terminal (ws)", "Bo", "live revocation", "terminal closed, logged terminal.revoked, panel shown");
    record("agent run", "Bo", "live revocation", "next shell request REFUSED");
  });

  // A member's terminal on a Mac host is a live PTY inside the OS sandbox: it reads the shared folder
  // and is refused everything outside it. The probe only reads a canary file this run made and writes
  // its answers into the shared folder; nothing launches an app or signals a process.
  if (process.platform === "darwin") {
    await step("5b sandboxed terminal over a live PTY (Mac host): shared folder yes, a file outside no", async () => {
      const canary = NodePath.join(root, "outside-canary.txt");
      NodeFS.writeFileSync(canary, "CANARY-OUTSIDE-SECRET\n");
      const out = NodePath.join(projectRoot, "pty-probe.txt");
      const done = NodePath.join(projectRoot, "pty-probe-done.txt");
      NodeFS.rmSync(out, { force: true });
      NodeFS.rmSync(done, { force: true });
      await pageApi(hal, "/api/lp/access/set", {
        projectId,
        userId: boId,
        zones: { "ai.agents": "", "files.level": "write", "files.secrets": "hidden", "compute.terminal": "on", "compute.mode": "sandboxed" },
      });
      await waitFor("Bo terminal on, sandboxed", async () => {
        const z = (await sessionSeat(bo))?.zones;
        return z?.["compute.terminal"] === "on" && z?.["compute.mode"] === "sandboxed";
      }, 15_000);
      await bo.locator('[data-testid="lp-terminal-off"]').waitFor({ state: "detached", timeout: 20_000 });
      // Compute came back: the drawer starts a clean terminal (the one closed at revocation is forgotten).
      await sleep(2_000);
      if ((await bo.locator(".xterm").count()) === 0) {
        await bo.getByLabel("Toggle terminal drawer").first().click();
        await sleep(2_000);
      }
      const target = bo.locator(".xterm, [data-testid*='terminal'] textarea, [class*='terminal'] textarea, [class*='terminal'] canvas").first();
      await target.click({ timeout: 15_000 });
      await sleep(1_500);
      expect(!(await bo.locator("main").innerText()).includes("That terminal is not yours"), "the drawer kept a terminal the host had closed");
      NodeFS.writeFileSync(
        NodePath.join(projectRoot, "pty-probe.sh"),
        `( echo "IN=$(cat readme-zones.txt)"; echo "OUT=$(cat ${canary} 2>&1)"; echo "WHO=$(id -un)" ) > pty-probe.txt\necho ok > pty-probe-done.txt\n`,
      );
      const command = "sh pty-probe.sh";
      await bo.keyboard.type(command, { delay: 15 });
      await bo.keyboard.press("Enter");
      await sleep(2_000);
      await shot(bo, "05b-sandboxed-terminal");
      await waitFor("the terminal wrote its answers", async () => NodeFS.existsSync(done), 30_000);
      const answer = read(out);
      note(`pty probe: ${answer.replace(/\n/g, " | ")}`);
      expect(/IN=hello/.test(answer), `the shared folder should be readable in the sandboxed terminal: ${answer}`);
      expect(!answer.includes("CANARY-OUTSIDE-SECRET"), `a file outside the shared folder was readable: ${answer}`);
      expect(/OUT=.*(not permitted|denied|No such file)/i.test(answer), `the outside read should be refused: ${answer}`);
      record("terminal (pty)", "Bo/Full access", "sandboxed shell", "shared folder readable, file outside refused");
    });
  }

  await step("7 Read only: sending and uploads refused, reading and zip work, the banner shows", async () => {
    await setAccess(boId, "readonly");
    await seatEventually(bo, "readonly");
    await openProject(bo, PROJECT);
    await bo.locator('[data-testid="lp-readonly-banner"]').waitFor({ timeout: 20_000 });
    const up = await pageUpload(bo, projectId, "ro.txt", "x");
    expect(up.httpStatus === 403 && up.error === "read_only", `upload: ${JSON.stringify(up)}`);
    const zip = await pageZip(bo, projectId, ["readme-zones.txt", ".env"]);
    expect(zip.httpStatus === 200 && zip.has["readme-zones.txt"] && !zip.has[".env"], `zip: ${JSON.stringify(zip)}`);
    record("HTTP upload", "Bo/Read only", "write", "403 read_only");
    record("HTTP zip", "Bo/Read only", "read", "allowed (secrets hidden)");
    record("composer", "Bo/Read only", "send", "banner replaces the composer (lp-readonly-banner)");
    await shot(bo, "07-bo-read-only");
  });

  await step("8 AI zone request: Cy has no host agent, requests it, Hal allows; a second request is denied", async () => {
    const custom = await pageApi(hal, "/api/lp/access/set", {
      projectId,
      userId: cyId,
      zones: { "ai.agents": "", "files.level": "write", "files.secrets": "hidden", "compute.terminal": "off" },
    });
    expect(custom.httpStatus === 200, `custom: ${JSON.stringify(custom)}`);
    await waitFor("Cy seat custom", async () => (await sessionSeat(cy))?.preset === "custom", 15_000);
    await openProject(cy, PROJECT);
    const noteEl = cy.locator('[data-testid="lp-composer-access-note"]').first();
    const text = await noteEl.innerText({ timeout: 20_000 });
    expect(/has not lent you/.test(text) && (await cy.locator('[data-testid="lp-request-ai"]').count()) === 1, `request note: ${text}`);
    const blocked = "just say hello there";
    await sendMessage(cy, blocked);
    await waitFor("refusal text", async () => /has not allowed you|Request it/.test(await cy.locator("main").innerText()), 20_000);
    record("RPC dispatch", "Cy/AI off", "host agent", "refused: Request it, or use your own login");
    await cy.locator('[data-testid="lp-request-ai"]').click();
    await cy.locator('[data-testid="lp-request-ai-sent"]').waitFor({ timeout: 10_000 });
    const pending = await waitFor("request visible to Hal", async () => {
      const view = await pageApi(hal, `/api/lp/access?projectId=${projectId}`);
      return view.requests?.find((r) => r.zone === "ai" && r.userId === cyId) ?? null;
    }, 20_000);
    const allowed = await pageApi(hal, "/api/lp/access/decide", { projectId, requestId: pending.id, decision: "allow" });
    expect(allowed.httpStatus === 200, `allow: ${JSON.stringify(allowed)}`);
    await waitFor("Cy lent the agent", async () => (await sessionSeat(cy))?.zones?.["ai.agents"]?.includes("claude"), 15_000);
    await openProject(cy, PROJECT);
    const hi = "just say hi again";
    await sendMessage(cy, hi);
    await waitForReply(cy, "Done.", hi);
    record("request flow", "Cy", "AI request -> Allow", "turn runs on the host's agent");
    // A second time: ask again, Hal denies, the turn stays refused.
    await pageApi(hal, "/api/lp/access/set", { projectId, userId: cyId, zones: { "ai.agents": "", "files.level": "write", "files.secrets": "hidden", "compute.terminal": "off" } });
    await waitFor("Cy AI off again", async () => !(await sessionSeat(cy))?.zones?.["ai.agents"], 15_000);
    await pageApi(cy, "/api/lp/access/request", { projectId, zone: "ai" });
    const second = await waitFor("second request", async () => (await pageApi(hal, `/api/lp/access?projectId=${projectId}`)).requests?.find((r) => r.zone === "ai") ?? null, 15_000);
    await pageApi(hal, "/api/lp/access/decide", { projectId, requestId: second.id, decision: "deny" });
    expect(!(await sessionSeat(cy))?.zones?.["ai.agents"], "a denied request must not turn AI on");
    record("request flow", "Cy", "AI request -> Deny", "stays refused");
  });

  await step("9 terminal request: Cy asks for terminal access; the warning gates Allow", async () => {
    await pageApi(hal, "/api/lp/access/set", { projectId, userId: cyId, preset: "edit" });
    await seatEventually(cy, "edit");
    await openProject(cy, PROJECT);
    await cy.getByLabel("Toggle terminal drawer").first().click();
    // The drawer remembers whether it was open: if the first click closed it, open it again.
    if (!(await cy.locator('[data-testid="lp-request-terminal"]').waitFor({ timeout: 6_000 }).then(() => true, () => false))) {
      await cy.getByLabel("Toggle terminal drawer").first().click();
    }
    await cy.locator('[data-testid="lp-request-terminal"]').click();
    await cy.locator('[data-testid="lp-request-terminal-sent"]').waitFor({ timeout: 10_000 });
    const pending = await waitFor("terminal request", async () => (await pageApi(hal, `/api/lp/access?projectId=${projectId}`)).requests?.find((r) => r.zone === "compute") ?? null, 20_000);
    const unconfirmed = await pageApi(hal, "/api/lp/access/decide", { projectId, requestId: pending.id, decision: "allow" });
    expect(unconfirmed.httpStatus === 409 && unconfirmed.error === "confirm_required", `Allow needs the warning: ${JSON.stringify(unconfirmed)}`);
    const done = await pageApi(hal, "/api/lp/access/decide", { projectId, requestId: pending.id, decision: "allow", confirmFull: true });
    expect(done.httpStatus === 200, `confirmed allow: ${JSON.stringify(done)}`);
    await waitFor("Cy Terminal on", async () => (await sessionSeat(cy))?.zones?.["compute.terminal"] === "on", 15_000);
    await cy.locator('[data-testid="lp-terminal-off"]').waitFor({ state: "detached", timeout: 15_000 });
    record("request flow", "Cy", "terminal request -> Allow", "warning required, then terminal panel gone");
    await pageApi(hal, "/api/lp/access/set", { projectId, userId: cyId, clear: true });
  });

  await step("10 override beats the share-link default; a default change applies at once", async () => {
    await pageApi(hal, "/api/lp/access/set", { projectId, userId: boId, clear: true });
    const toChat = await pageApi(hal, "/api/lp/access/set", { projectId, preset: "chat" });
    expect(toChat.httpStatus === 200, `default chat: ${JSON.stringify(toChat)}`);
    await seatEventually(bo, "chat");
    await seatEventually(cy, "chat");
    await setAccess(cyId, "edit");
    await seatEventually(cy, "edit");
    expect((await sessionSeat(bo)).source === "default" && (await sessionSeat(cy)).source === "override", "default vs override");
    const up = await pageUpload(cy, projectId, "cy-override.txt", "x");
    expect(up.httpStatus === 200, `Cy's override should allow upload: ${JSON.stringify(up)}`);
    const upBo = await pageUpload(bo, projectId, "bo-default.txt", "x");
    expect(upBo.httpStatus === 403, `Bo follows the Chat only default: ${JSON.stringify(upBo)}`);
    record("precedence", "Bo/Cy", "default Chat only, Cy override Can edit", "Cy uploads, Bo refused");
    await pageApi(hal, "/api/lp/access/set", { projectId, clear: true });
    await pageApi(hal, "/api/lp/access/set", { projectId, userId: cyId, clear: true });
  });

  if (claudeTokenFile) {
    await step("11 real Haiku on the host's Claude: Can edit answers, Chat only cannot run bash", async () => {
      const token = NodeFS.readFileSync(claudeTokenFile, "utf8").trim();
      await stopChild(children.host);
      const claudeHome = NodePath.join(root, "claude-home");
      NodeFS.mkdirSync(NodePath.join(claudeHome, ".claude"), { recursive: true });
      NodeFS.writeFileSync(
        NodePath.join(home, "userdata/settings.json"),
        JSON.stringify({ ...hostSettings, defaultModelSelection: { instanceId: "claudeAgent", model: "claude-haiku-4-5" } }),
      );
      startHost({ HOME: claudeHome, CLAUDE_CONFIG_DIR: NodePath.join(claudeHome, ".claude"), CLAUDE_CODE_OAUTH_TOKEN: token });
      await children.host.ready;
      await sleep(2_000);
      await setAccess(boId, "edit");
      await openProject(bo, PROJECT);
      const ping = "Reply with the single word PONG and nothing else.";
      await sendMessage(bo, ping);
      await waitForReply(bo, "PONG", ping, 120_000);
      const noteText = await bo.locator('[data-testid="lp-composer-access-note"]').first().innerText();
      expect(/Using host's Claude/.test(noteText), `composer note: ${noteText}`);
      record("real Claude (Haiku)", "Bo/Can edit", "plain turn", `PONG; composer says "${noteText}"`);
      await setAccess(boId, "chat");
      await seatEventually(bo, "chat");
      const bash = "Use your Bash tool to run `echo SHELL-RAN-9137` and reply with its output. If you have no Bash tool, reply exactly: NO-BASH";
      await sendMessage(bo, bash);
      const answer = await waitFor("the Claude answer", async () => {
        const text = await lastReply(bo, bash);
        return !/Working for|Thinking/.test(text) && /NO-BASH|cannot|can't|don't have|unable|not available/i.test(text) ? text : null;
      }, 120_000);
      expect(!/\nSHELL-RAN-9137\n/.test(answer), "the shell output appeared although Compute is off");
      record("real Claude (Haiku)", "Bo/Chat only", "bash tool", "unavailable; no shell output");
    });
  }

  await step("12 summary", async () => {
    console.log("\nZone matrix (path | who | what | outcome)");
    for (const row of matrix) console.log(`  ${row.path} | ${row.who} | ${row.what} | ${row.outcome}`);
  });
} finally {
  await browser?.close().catch(() => undefined);
  // LP_E2E_HOSTLOG=<file>: keep the host server's output (for diagnosing a failed step).
  if (process.env.LP_E2E_HOSTLOG && children.host) NodeFS.writeFileSync(process.env.LP_E2E_HOSTLOG, children.host.log);
  if (!keep) for (const started of Object.values(children)) await stopChild(started);
  if (!keep) NodeFS.rmSync(root, { recursive: true, force: true });
  const bad = results.filter((r) => !r.ok);
  console.log(`\n${results.length - bad.length}/${results.length} steps passed`);
  process.exitCode = bad.length === 0 ? 0 : 1;
}
