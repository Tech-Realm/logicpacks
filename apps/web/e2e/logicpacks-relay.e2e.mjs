#!/usr/bin/env node
// Public share links through the relay, end to end, with the attacks the relay must refuse:
//   node apps/web/e2e/logicpacks-relay.e2e.mjs [--port 3941] [--relay-port 19650] [--shots <dir>] [--keep]
//   node apps/web/e2e/logicpacks-relay.e2e.mjs --real [--port 3941]     (the deployed relay and a real DNS name)
//   node apps/web/e2e/logicpacks-relay.e2e.mjs --real --attach http://127.0.0.1:3993 --pairing <url>
//       a host that is already running somewhere else (for example a Windows host reached over an ssh tunnel);
//       steps that read the host's files or script its agent are skipped
// A LAPTOP host (`node src/bin.ts serve`, built web client in apps/web/dist) opens an outbound tunnel to the
// relay; the joiner is a separate browser context that only knows https://<id>.<domain>/... Local mode runs the
// relay in this process on the base domain lp-relay.test (Chrome maps *.lp-relay.test to it); --real uses
// wss://relay.logicpacks.io and the internet.
//   1 owner shares a project: the tunnel opens, the public origin is a random 128-bit label
//   2 Share dialog shows the public link first, the network link second
//   3 joiner opens the public invite link, signs up, sees the project
//   4 thread streams over the relay websocket, edit lands on the host
//   5 file upload (6 MB) through the relay
//   6 attacks: owner session, pairing, helper key, forged headers, unauthenticated probes, logs, secret
//   7 latency: relay overhead vs direct (200 requests, 200 websocket round trips)
//   8 relay restart: host reconnects, joiner's websocket comes back, thread works again (local mode)
//   9 member removed: access cut; stop sharing: tunnel and live sockets cut at once, id inactive
//  10 sharing again, then host offline page, host back
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
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
const REAL = args.includes("--real");
const ATTACH = option("--attach", null);
const ATTACH_PAIRING = option("--pairing", null);
const port = Number(option("--port", 3941));
const relayPort = Number(option("--relay-port", 19650));
const keep = args.includes("--keep");
const shotsDir = option("--shots", null);
const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const repo = NodePath.join(here, "../../..");
const serverDir = NodePath.join(repo, "apps/server");
const LOCAL_BASE = "lp-relay.test";
const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lp-relay-e2e-"));
if (shotsDir) NodeFS.mkdirSync(shotsDir, { recursive: true });
const run = Date.now().toString(36).slice(-6);
const PASSWORD = "correct-horse-battery";
const PROJECT = `Relay ${run}`;
const DIRECT = ATTACH ?? `http://127.0.0.1:${port}`;
const OWN_HOST = ATTACH === null;
const mockLog = NodePath.join(root, "mock-agent.log");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const home = NodePath.join(root, "host");
NodeFS.mkdirSync(NodePath.join(home, "userdata"), { recursive: true });
NodeFS.writeFileSync(
  NodePath.join(home, "userdata/settings.json"),
  JSON.stringify({
    providerInstances: {
      // Only the scripted agent may run: a real model would spend tokens and need credentials.
      codex: { driver: "codex", enabled: false },
      claudeAgent: { driver: "claudeAgent", enabled: false },
      ledgerMock: {
        displayName: "Ledger mock",
        driver: "acpRegistry",
        config: { source: "local", commandPath: process.execPath, commandArgs: [NodePath.join(here, "lp-ledger-mock-agent.mjs")] },
      },
    },
    defaultModelSelection: { instanceId: "ledgerMock", model: "ledger" },
  }),
);

// ── Processes ───────────────────────────────────────────────────────────────
const children = {};
function spawnLogged(name, command, commandArgs, options, readyText) {
  const child = NodeChildProcess.spawn(command, commandArgs, { ...options, stdio: ["ignore", "pipe", "pipe"], detached: true });
  const started = { name, child, log: "", killed: false };
  children[name] = started;
  started.ready = new Promise((resolve, reject) => {
    const onData = (chunk) => {
      started.log += chunk;
      if (started.log.length > 600_000) started.log = started.log.slice(-300_000);
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
const hostEnv = () => {
  const env = { ...process.env, LP_MOCK_LOG: mockLog };
  for (const key of Object.keys(env)) if (key.startsWith("LOGICPACKS_")) delete env[key];
  env.LOGICPACKS_SYNC_SECONDS = "0";
  env.LOGICPACKS_GOALS_JUDGE = "off";
  if (!REAL) env.LOGICPACKS_SHARE_RELAY_URL = `ws://127.0.0.1:${relayPort}/connect`;
  return env;
};
const startHost = () =>
  spawnLogged("host", process.execPath, ["src/bin.ts", "serve", "--port", String(port), "--host", "127.0.0.1", "--base-dir", home, "--no-browser"], { cwd: serverDir, env: hostEnv() }, ["Pairing URL:"]);

// ── The relay (local mode runs it in this process) ──────────────────────────
let relay = null;
const relayLogs = [];
const relayState = NodePath.join(root, "relay-hosts.json");
async function startLocalRelay() {
  const { startRelay } = await import(NodeURL.pathToFileURL(NodePath.join(repo, "infra/share-relay/src/relay.ts")).href);
  relay = await startRelay({ baseDomain: LOCAL_BASE, port: relayPort, stateFile: relayState, log: (line) => relayLogs.push(line) });
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
    console.log(`FAIL ${name}\n     ${String(error?.message ?? error).split("\n")[0]}`);
    if (boLog.length > 0) console.log(`     joiner browser log (last 12):\n       ${boLog.slice(-12).join("\n       ")}\n     ws: ${JSON.stringify(wsEvents)}`);
    for (const [index, page] of pages.entries())
      await page.screenshot({ path: NodePath.join(shotsDir ?? root, `fail-${results.length}-${index}.png`) }).catch(() => undefined);
  }
}
const expect = (condition, message) => {
  if (!condition) throw new Error(message);
};
async function waitFor(what, check, timeoutMs = 30_000, every = 400) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    try {
      last = await check();
      if (last) return last;
    } catch (error) {
      last = String(error?.message ?? error);
    }
    await sleep(every);
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
const pct = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};

// ── HTTP to the public name without a browser ───────────────────────────────
let origin = null; // https://<id>.<base> as the app reports it
const publicHostname = () => new URL(origin).hostname;
const publicBase = () => (REAL ? origin : `http://${publicHostname()}`);
function rawRequest(path, { method = "GET", headers = {}, body, hostname = publicHostname() } = {}) {
  return new Promise((resolve, reject) => {
    const options = REAL
      ? { host: hostname, port: 443, path, method, headers: { host: hostname, ...headers }, agent: false }
      : { host: "127.0.0.1", port: relayPort, path, method, headers: { host: hostname, ...headers }, agent: false };
    const req = (REAL ? NodeHttps : NodeHttp).request(options, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(body);
  });
}
const direct = async (path, { method = "GET", headers = {}, body } = {}) => {
  const response = await fetch(`${DIRECT}${path}`, { method, headers, body });
  return { status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() };
};
const cookieHeader = (cookies) => cookies.map((c) => `${c.name}=${c.value}`).join("; ");
const GENERIC = /This page is not available/;

let browser;
let hal; // the host's operator session (pairing), only used for the owner-session attacks
let projectOwner = null;
let owner; // Hal, the project owner, signed in on the host like any member
let bo;
let boContext;
let halCookies = [];
let projectId;
let linkPath;
let hostId;
let boCookie = "";
const wsEvents = [];
const boLog = [];

async function pair(page) {
  const pairing = ATTACH_PAIRING ?? children.host.log.match(/Pairing URL: (\S+)/)?.[1];
  expect(pairing, "no pairing URL");
  const url = new URL(pairing);
  await page.goto(`${DIRECT}${url.pathname}${url.search}${url.hash}`);
  await page.waitForURL((u) => !u.pathname.startsWith("/pair"), { timeout: 30_000 });
  await page.waitForLoadState("load");
  await sleep(1500);
  return url.hash.replace("#token=", "");
}
async function openProject(page, title, base) {
  await page.goto(`${base}/`);
  const heading = page.locator("main h1 button, main h2 button").first();
  await heading.waitFor({ timeout: 60_000 });
  if ((await heading.innerText()).trim() !== title) {
    await heading.click();
    await page.locator('[role="listbox"]').getByText(title, { exact: true }).click();
  }
  await page.waitForFunction(
    (name) => (document.querySelector("main")?.textContent ?? "").replace(/\s+/g, "").includes(`buildin${name}`),
    title.replace(/\s+/g, ""),
    { timeout: 45_000 },
  );
}
async function sendMessage(page, text) {
  const composer = page.locator('[contenteditable="true"]').first();
  await composer.waitFor({ timeout: 30_000 });
  await waitFor("the scripted agent to be selected", async () => /Ledger mock/.test(await page.locator("main").innerText()), 20_000, 300).catch(async () => {
    throw new Error(`the composer does not offer the scripted agent: ${(await page.locator("main").innerText()).slice(-200)}`);
  });
  await composer.click();
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
}
const waitForReply = (page, needle, prompt, timeout = 90_000) =>
  waitFor(
    `a reply containing ${needle}`,
    async () => {
      const text = await page.locator("main").innerText();
      const withoutPrompt = text.split(prompt).join("");
      return !/Working for|Thinking/.test(text) && withoutPrompt.includes(needle) ? withoutPrompt : null;
    },
    timeout,
  );
const relayStatus = () => pageApi(owner, "/api/lp/relay");

try {
  console.log(`work dir ${root} (${REAL ? "REAL relay" : "local relay"})`);
  if (!REAL) await startLocalRelay();
  if (OWN_HOST) {
    startHost();
    await children.host.ready;
  }
  browser = await chromium.launch({
    headless: true,
    args: REAL ? [] : [`--host-resolver-rules=MAP *.${LOCAL_BASE} 127.0.0.1:${relayPort}`],
  });
  const halContext = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  hal = await halContext.newPage();
  pages.push(hal);

  await step("1 the owner shares a project: the tunnel opens on a random 128-bit label", async () => {
    await pair(hal);
    projectOwner = null;
    const ownerContext = await browser.newContext({ viewport: { width: 1360, height: 900 } });
    owner = await ownerContext.newPage();
    pages.push(owner);
    await owner.goto(`${DIRECT}/lp/login`);
    await owner.click("#tab-signup");
    await owner.fill("#name", "Hal");
    await owner.fill("#email", `hal-${run}@example.com`);
    await owner.fill("#password", PASSWORD);
    await owner.click("#submit");
    await owner.waitForURL((u) => u.origin === DIRECT && !u.pathname.startsWith("/lp/"), { timeout: 120_000 });
    let created = await pageApi(owner, "/api/lp/projects/new", { kind: "template", name: PROJECT, template: "website" });
    if (created.error === "zone_off") {
      // This host does not let a plain member create projects (Projects zone): the host operator does it.
      note("members cannot create projects on this host: the operator owns the project, the Share dialog step is skipped");
      projectOwner = hal;
      created = await pageApi(hal, "/api/lp/projects/new", { kind: "template", name: PROJECT, template: "website" });
    }
    expect(created.projectId, `project not created: ${JSON.stringify(created)}`);
    projectId = created.projectId;
    projectOwner ??= owner;
    const before = await relayStatus();
    expect(before.available === true && before.state === "off", `relay before sharing: ${JSON.stringify(before)}`);
    const made = await pageApi(projectOwner, "/api/lp/shares/link", { projectId, enabled: true });
    expect(made.link?.path, `share link: ${JSON.stringify(made)}`);
    linkPath = made.link.path;
    const status = await waitFor("tunnel connected", async () => {
      const s = await relayStatus();
      return s.state === "connected" ? s : null;
    }, 30_000);
    origin = status.origin;
    hostId = publicHostname().split(".")[0];
    expect(/^[a-z2-7]{26}$/.test(hostId), `host id shape: ${hostId}`);
    note(`public origin ${origin} (reasons: ${status.reasons.join(",")})`);
    if (OWN_HOST) {
      const identity = JSON.parse(NodeFS.readFileSync(NodePath.join(home, "userdata/share-relay.json"), "utf8"));
      expect(identity.id === hostId && identity.secret.length >= 43, "identity file");
      expect((NodeFS.statSync(NodePath.join(home, "userdata/share-relay.json")).mode & 0o077) === 0, "identity file is not private");
    }
    const page = await rawRequest(linkPath);
    expect(page.status === 200 && /Join the project/.test(page.body), `join page through relay: ${page.status} ${page.body.slice(0, 200)}`);
    expect(!/127\.0\.0\.1/.test(page.body), "join page names the host's local address");
  });

  await step("2 the Share dialog offers the public link first and the network link second", async () => {
    if (projectOwner !== owner) return note("skipped: the signed-in member does not own the project on this host");
    await owner.goto(`${DIRECT}/`);
    const heading = owner.locator("main h1 button, main h2 button").first();
    await heading.waitFor({ timeout: 60_000 });
    if ((await heading.innerText()).trim() !== PROJECT) {
      await heading.click();
      await owner.locator('[role="listbox"]').getByText(PROJECT, { exact: true }).click();
    }
    const button = owner.getByTestId("lp-share-project-open").first();
    await button.waitFor({ timeout: 30_000 });
    await button.click();
    const dialog = owner.getByRole("dialog");
    await dialog.getByText(`Share ${PROJECT}`).waitFor({ timeout: 15_000 });
    const input = dialog.getByTestId("lp-share-link-url");
    await waitFor("public link in the dialog", async () => (await input.inputValue()).startsWith(origin), 20_000);
    const value = await input.inputValue();
    expect(value === `${origin}${linkPath}`, `dialog link ${value}`);
    const lan = await dialog.getByTestId("lp-share-link-lan").innerText();
    expect(lan.startsWith(DIRECT), `network link: ${lan}`);
    await shot(owner, "02-share-dialog");
    await owner.keyboard.press("Escape");
  });

  await step("3 the joiner opens the public invite link, signs up and sees the project", async () => {
    boContext = await browser.newContext({ viewport: { width: 1360, height: 900 } });
    bo = await boContext.newPage();
    pages.push(bo);
    bo.on("console", (m) => (m.type() === "error" || m.type() === "warning") && boLog.push(`${m.type()}: ${m.text().slice(0, 200)}`));
    bo.on("requestfailed", (r) => boLog.push(`requestfailed ${r.url().slice(0, 100)} ${r.failure()?.errorText}`));
    bo.on("response", (r) => r.status() >= 400 && boLog.push(`http ${r.status()} ${r.url().slice(0, 100)}`));
    bo.on("websocket", (ws) => {
      const entry = { url: ws.url(), closed: false, closedAt: 0 };
      wsEvents.push(entry);
      ws.on("close", () => {
        entry.closed = true;
        entry.closedAt = Date.now();
      });
    });
    await bo.goto(`${publicBase()}${linkPath}`);
    await bo.locator("h1", { hasText: "Join the project" }).waitFor({ timeout: 45_000 });
    await bo.fill("#name", "Bo");
    await bo.fill("#email", `bo-${run}@example.com`);
    await bo.fill("#password", PASSWORD);
    await bo.click("#submit");
    await bo.waitForURL((u) => u.origin === new URL(publicBase()).origin && !u.pathname.startsWith("/lp/"), { timeout: 30_000 });
    const seen = await pageApi(bo, "/api/lp/projects");
    expect(seen.projects?.some((p) => p.id === projectId), `Bo cannot see the project: ${JSON.stringify(seen).slice(0, 300)}`);
    boCookie = cookieHeader((await boContext.cookies()).filter((c) => c.name.includes("session")));
    expect(boCookie.length > 20, "no member session cookie");
    await shot(bo, "03-bo-joined");
  });

  await step("4 a thread streams over the relay websocket and the edit lands on the host", async () => {
    await openProject(bo, PROJECT, publicBase());
    if (OWN_HOST) {
      const prompt = "edit bo.txt Bo wrote this through the relay";
      await sendMessage(bo, prompt);
      const reply = await waitForReply(bo, "Edited", prompt);
      const cwd = /\(cwd ([^)]+)\)/.exec(reply)?.[1];
      expect(cwd, `no cwd in reply: ${reply.slice(-200)}`);
      expect(NodeFS.readFileSync(NodePath.join(cwd, "bo.txt"), "utf8").includes("Bo wrote this"), "bo.txt is not on the host");
    } else await waitFor("the app's own socket", () => wsEvents.some((w) => w.url.includes("/ws") && !w.closed), 30_000);
    const live = wsEvents.filter((w) => w.url.includes("/ws") && !w.closed);
    expect(live.length > 0, `no live /ws socket: ${JSON.stringify(wsEvents)}`);
    expect(live.every((w) => w.url.startsWith(REAL ? "wss://" : "ws://") && w.url.includes(publicHostname())), `ws goes elsewhere: ${live.map((w) => w.url)}`);
    await shot(bo, "04-bo-thread");
  });

  await step("5 a 6 MB file uploads through the relay", async () => {
    if (!OWN_HOST) return note("attached host: upload is covered by the run against the Mac host");
    const result = await bo.evaluate(async () => {
      const size = 6 * 1024 * 1024;
      const bytes = new Uint8Array(size);
      for (let i = 0; i < size; i += 4099) bytes[i] = (i / 4099) % 251;
      const started = performance.now();
      // The project's file area: upload a file through the member API the files panel uses.
      return { size, started };
    });
    // Use the host's real upload route: a signed attachment URL is requested over RPC by the composer.
    // The composer's own file input drives it so the whole path (token, POST body, storage) is exercised.
    const file = NodePath.join(root, "upload.bin");
    const payload = Buffer.alloc(result.size, 7);
    for (let i = 0; i < payload.length; i += 4099) payload[i] = (i / 4099) % 251;
    NodeFS.writeFileSync(file, payload);
    const input = bo.locator('input[type="file"]').first();
    await input.waitFor({ state: "attached", timeout: 15_000 });
    const attachments = NodePath.join(home, "userdata/attachments");
    const count = () => (NodeFS.existsSync(attachments) ? NodeFS.readdirSync(attachments).length : 0);
    const before = count();
    await input.setInputFiles(file);
    const prompt = "edit up.txt with the attached file";
    await sendMessage(bo, prompt);
    // Over the internet the 6 MB upload takes a while and the composer will not send before it is done: press send again.
    const composerEl = bo.locator('[contenteditable="true"]').first();
    for (let i = 0; i < 30; i++) {
      await sleep(3000);
      if (!(await composerEl.innerText().catch(() => "")).includes("with the attached file")) break;
      await bo.keyboard.press("Enter");
    }
    await waitForReply(bo, "Edited up.txt", prompt, 120_000);
    await waitFor("the attachment on the host", () => (NodeFS.existsSync(attachments) ? NodeFS.readdirSync(attachments).some((name) => NodeFS.statSync(NodePath.join(attachments, name)).size === payload.length) : false), 30_000);
    note(`attachments on host: ${before} -> ${count()}, one is exactly ${payload.length} bytes`);
  });

  await step("6a the owner's own session cannot be used through the relay", async () => {
    halCookies = (await halContext.cookies()).filter((c) => c.name.includes("session"));
    expect(halCookies.length > 0, "no owner cookie");
    const cookie = cookieHeader(halCookies);
    // Control: locally the same cookie is the owner.
    const local = await direct("/api/lp/relay", { headers: { cookie } });
    expect(local.status === 200, `owner cookie does not work locally: ${local.status}`);
    for (const path of ["/api/lp/relay", "/api/lp/me", "/api/auth/session", "/api/lp/projects", "/api/lp/workspaces"]) {
      const res = await rawRequest(path, { headers: { cookie } });
      const asLocal = await direct(path, { headers: { cookie } });
      // Some routes answer a signed-out caller with a harmless "nobody" payload; the owner must look like nobody.
      const nobody = res.status === 200 && /"user":null/.test(res.body) && /"operator":false/.test(res.body);
      if (nobody) note(`${path}: locally ${asLocal.body.slice(0, 40)}, through the relay ${res.body.slice(0, 40)}`);
      expect((res.status >= 401 && res.status <= 404) || nobody, `${path} with the owner cookie answered ${res.status}: ${res.body.slice(0, 160)} (local owner: ${asLocal.status} ${asLocal.body.slice(0, 80)})`);
      expect(!/"state":"connected"|"authenticated":true|"origin":|"role":"operator"/.test(res.body), `${path} leaked: ${res.body.slice(0, 600)}`);
    }
    const ticket = await rawRequest("/api/auth/websocket-ticket", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: "{}" });
    expect(ticket.status >= 401 && ticket.status <= 404, `owner websocket ticket through relay: ${ticket.status}`);
    const wsStatus = await wsUpgradeStatus(cookie);
    expect(wsStatus !== 101, `owner opened a websocket through the relay (${wsStatus})`);
    note(`owner cookie via relay: refused (ws upgrade ${wsStatus})`);
  });

  await step("6b pairing, the helper key and operator tokens are not reachable", async () => {
    const issued = await pageApi(hal, "/api/auth/pairing-token", {});
    const credential = issued.credential ?? issued.token ?? issued.pairingToken;
    note(`fresh pairing credential issued locally (${credential ? "yes" : "no"}; ${Object.keys(issued).join(",")})`);
    for (const path of ["/pair", "/pair/", "/PAIR", "/%70air", "/a/../pair", "/api/auth/pairing-token", "/api/auth/pairing-links/revoke", "/api/auth/clients/revoke", "/.well-known/oauth-authorization-server", "/.well-known/anything", "/mcp", "/api/connect/relay-config", "/api/lp/helper/pair/local", "/api/lp/helper/key", "/oauth/token"]) {
      for (const method of ["GET", "POST"]) {
        for (const headers of [{}, { cookie: boCookie }]) {
          const res = await rawRequest(path, { method, headers, body: method === "POST" ? "{}" : undefined });
          expect(res.status === 404 || res.status === 405, `${method} ${path} -> ${res.status}`);
          { const m = /"credential"|"token"|"key"|"local"/.exec(res.body); expect(!m, `${path} leaked ${m?.[0]} near: ${m ? res.body.slice(Math.max(0, m.index - 80), m.index + 80) : ""}`); }
        }
      }
    }
    if (credential) {
      const res = await rawRequest("/api/auth/browser-session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ credential }) });
      expect(res.status === 404, `pairing credential exchanged through the relay: ${res.status} ${res.body.slice(0, 120)}`);
    }
    const anonDescriptor = await rawRequest("/.well-known/t3/environment");
    expect(anonDescriptor.status === 404 && GENERIC.test(anonDescriptor.body), `environment descriptor for a stranger: ${anonDescriptor.status}`);
    const memberDescriptor = await rawRequest("/.well-known/t3/environment", { headers: { cookie: boCookie } });
    expect(memberDescriptor.status === 200, `environment descriptor for a member: ${memberDescriptor.status}`);
    note(`descriptor a member gets: ${memberDescriptor.body.slice(0, 260)}`);
    const probe = await direct("/api/lp/helper/pair/local");
    expect(probe.status === 200 && /"local":true/.test(probe.body), `control: local helper probe answered ${probe.status} ${probe.body.slice(0, 80)}`);
    const keyFile = NodePath.join(home, "userdata/helper-local.key");
    if (NodeFS.existsSync(keyFile)) {
      const key = NodeFS.readFileSync(keyFile, "utf8").trim();
      const forged = await rawRequest("/api/lp/helper/pair/local", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key }) });
      expect(forged.status === 404, `helper key accepted through the relay: ${forged.status}`);
      const fresh = await direct("/api/lp/helper/pair/local", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key }) });
      expect(fresh.status === 200 && /"token"/.test(fresh.body), `control: local helper pairing answered ${fresh.status}`);
      const operatorToken = JSON.parse(fresh.body).token;
      const viaRelay = await rawRequest("/api/lp/relay", { headers: { authorization: `Bearer ${operatorToken}` } });
      expect(viaRelay.status >= 401 && viaRelay.status <= 404 && !/connected/.test(viaRelay.body), `operator helper token through relay: ${viaRelay.status} ${viaRelay.body.slice(0, 100)}`);
      const wsOp = await wsUpgradeStatus(null, operatorToken);
      expect(wsOp !== 101, `operator token opened a websocket through the relay (${wsOp})`);
    }
  });

  await step("6c forged markers and addresses change nothing; strangers get one bare page", async () => {
    const forged = {
      "x-lp-relayed": "0".repeat(64),
      "x-forwarded-for": "127.0.0.1",
      "x-forwarded-host": "localhost",
      "x-real-ip": "127.0.0.1",
      "cf-connecting-ip": "127.0.0.1",
      forwarded: "for=127.0.0.1;host=localhost",
      "true-client-ip": "127.0.0.1",
    };
    if (REAL) {
      // Cloudflare's edge refuses a request that forges its own address header before it reaches the relay.
      const edge = await rawRequest("/api/lp/me", { headers: forged });
      note(`forged cf-connecting-ip at the Cloudflare edge: ${edge.status}`);
      expect(edge.status === 403 || edge.status === 404, `edge answered ${edge.status} to forged cf headers`);
      delete forged["cf-connecting-ip"];
    }
    const stranger = await rawRequest("/api/lp/me", { headers: forged });
    expect(stranger.status === 404 && GENERIC.test(stranger.body), `forged stranger: ${stranger.status}`);
    const asMember = await rawRequest("/api/lp/me", { headers: { ...forged, cookie: boCookie } });
    expect(asMember.status === 200 && /Bo/.test(asMember.body), `member with forged headers: ${asMember.status} ${asMember.body.slice(0, 100)}`);
    const memberAdmin = await rawRequest("/api/lp/relay", { headers: { ...forged, cookie: boCookie } });
    expect(memberAdmin.status === 404, `member reached the relay admin route: ${memberAdmin.status}`);
    const bare = [];
    for (const path of ["/", "/index.html", "/assets/none.js", "/api/lp/me", "/api/lp/projects", "/ws?orchestrationProtocol=2", "/api/auth/session", ...(REAL ? [] : ["/robots.txt"]), "/favicon.ico", "/lp/account"]) { // Cloudflare answers /robots.txt itself on the real domain
      const res = await rawRequest(path);
      expect(res.status === 404, `${path} -> ${res.status}`);
      bare.push(res.body);
      expect(GENERIC.test(res.body), `${path} body: ${res.body.slice(0, 120)}`);
      for (const header of ["server", "x-powered-by", "x-lp-version", "access-control-allow-origin"]) expect(res.headers[header] === undefined || (REAL && header === "server" && res.headers.server === "cloudflare"), `${path} sends ${header}: ${res.headers[header]}`);
      expect(!/\d+\.\d+\.\d+|logicpacks/i.test(res.body), `${path} names the host or a version`);
    }
    expect(new Set(bare).size === 1, "unauthenticated pages differ between paths");
    const realName = boCookie.split("=")[0];
    for (const path of ["/api/lp/me", "/api/auth/session", "/", "/.well-known/t3/environment"]) {
      const forgedSession = await rawRequest(path, { headers: { cookie: `${realName}=forged-value-123` } });
      expect(forgedSession.status === 404 && GENERIC.test(forgedSession.body), `forged session on ${path}: ${forgedSession.status} ${forgedSession.body.slice(0, 100)}`);
      const forgedBearer = await rawRequest(path, { headers: { authorization: "Bearer forged-value-123" } });
      expect(forgedBearer.status === 404 && GENERIC.test(forgedBearer.body), `forged bearer on ${path}: ${forgedBearer.status}`);
    }
    const badInvite = await rawRequest("/lp/join/project?invite=not-a-real-token");
    expect(badInvite.status === 200 && /no longer valid/.test(badInvite.body) && !/<input[^>]*id="password"/.test(badInvite.body), `bad invite shows the join form: ${badInvite.status} ${badInvite.body.replace(/<style[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 200)}`);
    expect(!badInvite.body.includes(PROJECT), "bad invite names a project");
  });

  await step("6d logs and files on the relay hold no tokens, bodies or secrets", async () => {
    const identity = OWN_HOST ? JSON.parse(NodeFS.readFileSync(NodePath.join(home, "userdata/share-relay.json"), "utf8")) : { secret: "n/a-secret" };
    const invite = linkPath.split("invite=")[1];
    if (!REAL) {
      const text = JSON.stringify(relayLogs);
      for (const secret of [identity.secret, invite, "correct-horse", boCookie.split("=")[1] ?? "x", "/lp/join", "/api/", "bo.txt", PASSWORD]) expect(!text.includes(secret), `relay log contains ${secret.slice(0, 12)}`);
      expect(relayLogs.every((l) => Object.keys(l).every((k) => ["ts", "ev", "h", "s", "b", "ms", "new"].includes(k))), "unexpected relay log fields");
      relay && (await sleep(700));
      const saved = NodeFS.readFileSync(relayState, "utf8");
      expect(!saved.includes(identity.secret) && saved.includes(hostId), "relay state holds the secret or lacks the id");
      note(`relay wrote ${relayLogs.length} log lines; none carries a path, query, body, cookie, address or secret`);
    } else {
      note("real relay: log content is covered by the local run and unit tests (journalctl not read here)");
    }
  });

  await step("7 latency: relay overhead against a direct connection", async () => {
    const jar = { cookie: boCookie };
    const direct200 = [];
    const relayed200 = [];
    // Direct needs a member session on the direct origin: sign in with the same account.
    const login = await fetch(`${DIRECT}/api/lp/auth/password`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "login", email: `bo-${run}@example.com`, password: PASSWORD }) });
    const setCookie = login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    expect(login.status === 200 && setCookie.length > 10, `direct member login ${login.status}`);
    for (let i = 0; i < 20; i++) {
      await direct("/api/lp/me", { headers: { cookie: setCookie } });
      await rawRequest("/api/lp/me", { headers: jar });
    }
    for (let i = 0; i < 200; i++) {
      let t = performance.now();
      const d = await direct("/api/lp/me", { headers: { cookie: setCookie } });
      direct200.push(performance.now() - t);
      t = performance.now();
      const r = await rawRequest("/api/lp/me", { headers: jar });
      relayed200.push(performance.now() - t);
      if (d.status !== 200 || r.status !== 200) throw new Error(`latency probe failed: ${d.status} ${r.status}`);
    }
    const line = (name, values) => `${name}: p50 ${pct(values, 50).toFixed(1)} ms, p95 ${pct(values, 95).toFixed(1)} ms, p99 ${pct(values, 99).toFixed(1)} ms`;
    note(`HTTP GET /api/lp/me x200 sequential. ${line("direct", direct200)} | ${line("via relay", relayed200)}`);
    note(`relay overhead: p50 +${(pct(relayed200, 50) - pct(direct200, 50)).toFixed(1)} ms, p95 +${(pct(relayed200, 95) - pct(direct200, 95)).toFixed(1)} ms`);
    const wsRtt = async (viaRelay) => {
      const { WebSocket } = await import(NodeURL.pathToFileURL(NodePath.join(repo, "infra/share-relay/node_modules/ws/wrapper.mjs")).href);
      const headers = viaRelay ? { cookie: boCookie, host: publicHostname() } : { cookie: setCookie };
      const url = viaRelay ? (REAL ? `wss://${publicHostname()}/ws?orchestrationProtocol=2` : `ws://127.0.0.1:${relayPort}/ws?orchestrationProtocol=2`) : `ws://127.0.0.1:${port}/ws?orchestrationProtocol=2`;
      const ws = new WebSocket(url, { headers });
      await new Promise((resolve, reject) => {
        ws.once("open", resolve);
        ws.once("error", reject);
      });
      const times = [];
      for (let i = 0; i < 220; i++) {
        const t = performance.now();
        const answered = new Promise((resolve) => ws.once("message", () => resolve(performance.now() - t)));
        ws.send(JSON.stringify({ _tag: "Ping" }));
        const dt = await Promise.race([answered, sleep(3000).then(() => -1)]);
        if (dt < 0) break;
        if (i >= 20) times.push(dt);
      }
      ws.close();
      return times;
    };
    const wsDirect = await wsRtt(false);
    const wsRelay = await wsRtt(true);
    expect(wsDirect.length >= 100 && wsRelay.length >= 100, `websocket ping/pong did not answer (direct ${wsDirect.length}, relay ${wsRelay.length})`);
    note(`WebSocket RPC ping/pong x200. ${line("direct", wsDirect)} | ${line("via relay", wsRelay)}`);
    note(`ws overhead: p50 +${(pct(wsRelay, 50) - pct(wsDirect, 50)).toFixed(1)} ms, p95 +${(pct(wsRelay, 95) - pct(wsDirect, 95)).toFixed(1)} ms`);
  });

  if (!REAL) {
    await step("8 the relay restarts: the host reconnects, the joiner's socket returns, threads work", async () => {
      const closedBefore = wsEvents.filter((w) => w.closed).length;
      await relay.close();
      const down = await waitFor("host to notice the relay is gone", async () => (await pageApi(owner, "/api/lp/relay")).state !== "connected", 90_000, 250);
      note(`host state after the relay died: ${down.state ?? "?"}`);
      const t0 = Date.now();
      await startLocalRelay();
      await waitFor("host reconnected", async () => (await pageApi(owner, "/api/lp/relay")).state === "connected" && relay.connected(hostId), 60_000, 250);
      note(`host reconnected ${Date.now() - t0} ms after the relay came back`);
      expect(wsEvents.filter((w) => w.closed).length > closedBefore, "joiner's websocket did not notice the restart");
      const prompt = "edit bo2.txt after the relay restarted";
      await waitFor("joiner's page ready", async () => (await bo.locator('[contenteditable="true"]').count()) > 0, 30_000);
      await sendMessage(bo, prompt);
      const reply = await waitForReply(bo, "Edited bo2.txt", prompt, 120_000);
      expect(reply.includes("Edited"), "no reply after the restart");
      const open = wsEvents.filter((w) => !w.closed).length;
      note(`joiner has ${open} live socket(s) again`);
    });
  }

  await step("9 removing the member and stopping the share cut access at once", async () => {
    const live = () => wsEvents.filter((w) => !w.closed).length;
    // Remove Bo: the project disappears for him and the link he joined with is not enough.
    const users = await pageApi(projectOwner, `/api/lp/shares?projectId=${encodeURIComponent(projectId)}`);
    const boId = users.members?.find((m) => m.user?.email === `bo-${run}@example.com`)?.user?.userId;
    expect(boId, `cannot find Bo in ${JSON.stringify(users).slice(0, 300)}`);
    const closedBeforeRemoval = wsEvents.filter((w) => w.closed).length;
    const t0 = Date.now();
    const removed = await pageApi(projectOwner, "/api/lp/members/remove", { projectId, userId: boId });
    expect(removed.httpStatus === 200, `remove: ${JSON.stringify(removed)}`);
    const gone = await rawRequest("/api/lp/projects", { headers: { cookie: boCookie } });
    expect(!gone.body.includes(projectId), `Bo still sees the project ${Date.now() - t0} ms after removal`);
    note(`member removed: his project list is empty ${Date.now() - t0} ms later; sockets still open: ${live()}`);
    // Removal also ends the sockets he already had open (they may reconnect, with the access he has now).
    await waitFor("the removed member's open socket is closed", async () => wsEvents.filter((w) => w.closed).length > closedBeforeRemoval, 5_000, 50);
    note(`the removed member's open socket(s) were closed ${Date.now() - t0} ms after the removal`);
    // Stop sharing: the tunnel closes and every relayed socket with it.
    const socketsBefore = live();
    const t1 = Date.now();
    const stopped = await pageApi(owner, "/api/lp/relay/disable", {});
    expect(stopped.state === "off", `disable: ${JSON.stringify(stopped)}`);
    if (!REAL) expect(!relay.connected(hostId), "relay still holds the tunnel");
    await waitFor("relayed sockets closed", () => live() === 0, 5_000, 25);
    note(`stop sharing: tunnel and ${socketsBefore} live socket(s) closed within ${Date.now() - t1} ms`);
    const page = await waitFor("the link answers inactive", async () => {
      const res = await rawRequest(linkPath);
      return res.status === 404 && /no longer active/.test(res.body) ? res : null;
    }, 10_000, 100);
    expect((page.headers["cache-control"] ?? "").startsWith("no-store"), "inactive page is cacheable");
    const status = await relayStatus();
    expect(status.state === "off", `status after stop: ${status.state}`);
    // The link is still on in the project, yet the tunnel stays closed until the host shares again.
    await sleep(4500);
    expect((await relayStatus()).state === "off", "tunnel reopened by itself after an explicit stop");
    await shot(bo, "09-bo-after-stop");
  });

  await step("10 sharing again reuses the id; a stopped host and a dead host show the right pages", async () => {
    const again = await pageApi(owner, "/api/lp/relay/enable", {});
    expect(again.available === true, `enable: ${JSON.stringify(again)}`);
    const status = await waitFor("tunnel back", async () => {
      const s = await relayStatus();
      return s.state === "connected" ? s : null;
    }, 30_000);
    expect(status.origin === origin, `host id changed: ${status.origin} vs ${origin}`);
    const ok = await rawRequest(linkPath);
    expect(ok.status === 200, `link after sharing again: ${ok.status}`);
    if (!OWN_HOST) return note("attached host: the dead-host page is covered by the run against the Mac host");
    // Host process dies: the relay keeps the id and says the host is offline. (The joiner's page is parked first:
    // an app that retries in a tight loop would, rightly, be rate limited from the same address.)
    await bo.goto("about:blank");
    await sleep(1500);
    await stopChild(children.host);
    const offline = await waitFor("offline page", async () => {
      const res = await rawRequest(linkPath);
      return res.status === 503 ? res : null;
    }, 90_000, 500);
    expect(/This host is offline/.test(offline.body), `offline body: ${offline.body.slice(0, 200)}`);
    expect((offline.headers["cache-control"] ?? "").startsWith("no-store"), "offline page is cacheable");
    expect(!/cloudflare/i.test(offline.body), "Cloudflare error page");
    await bo.goto(`${publicBase()}/`).catch(() => undefined);
    await shot(bo, "10-bo-host-offline");
    // Host comes back: same id, link works again without a click.
    startHost();
    await children.host.ready;
    await waitFor("link works after the host restarted", async () => (await rawRequest(linkPath)).status === 200, 60_000, 500);
    note("host restarted: the same public link answers again");
  });
} catch (error) {
  failed = true;
  console.log(`ERROR ${error?.stack ?? error}`);
} finally {
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} steps passed${failed ? " (a step failed)" : ""}`);
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name} (${r.ms} ms)${r.error ? `\n     ${r.error.split("\n")[0]}` : ""}`);
  if (browser) await browser.close().catch(() => undefined);
  if (!keep) {
    for (const child of Object.values(children)) await stopChild(child);
    if (relay) await relay.close().catch(() => undefined);
    NodeFS.rmSync(root, { recursive: true, force: true });
  } else console.log(`kept ${root}`);
  process.exit(failed ? 1 : 0);
}

/** The status code a websocket upgrade through the relay gets (101 means it opened). */
async function wsUpgradeStatus(cookie, bearer = null) {
  const { WebSocket } = await import(NodeURL.pathToFileURL(NodePath.join(repo, "infra/share-relay/node_modules/ws/wrapper.mjs")).href);
  const url = REAL ? `wss://${publicHostname()}/ws?orchestrationProtocol=2` : `ws://127.0.0.1:${relayPort}/ws?orchestrationProtocol=2`;
  const headers = { host: publicHostname(), ...(cookie ? { cookie } : {}), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) };
  return await new Promise((resolve) => {
    const ws = new WebSocket(url, { headers });
    const timer = setTimeout(() => {
      ws.terminate();
      resolve(0);
    }, 8000);
    ws.once("unexpected-response", (_req, res) => {
      clearTimeout(timer);
      resolve(res.statusCode);
    });
    ws.once("open", () => {
      clearTimeout(timer);
      ws.close();
      resolve(101);
    });
    ws.once("error", () => {
      clearTimeout(timer);
      resolve(-1);
    });
  });
}
