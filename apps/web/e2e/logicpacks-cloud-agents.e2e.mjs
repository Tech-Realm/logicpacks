#!/usr/bin/env node
// The cloud is coming soon without a code; with a cloud code: own computer or cloud logins:
//   node apps/web/e2e/logicpacks-cloud-agents.e2e.mjs [--port 3881] [--web-port 5816] [--local-port N]
//     [--shots <dir>] [--keep] [--results <file>]
// A cloud host from this tree with the Vite dev client in front, plus a second server from this
// tree standing in for Mia's computer (what `logicpacks serve` or the desktop app runs). Every agent
// is the scripted ACP mock (lp-ledger-mock-agent.mjs).
//   1 Mia has no access code: the first run asks her to connect her computer, offers no cloud
//     login, and every cloud login route answers 403 feature_locked
//   2 Mia pastes her computer's pairing URL; it connects as an environment
//   3 Mia adds a project on her computer and runs a turn from the web app: it runs there (with
//     her computer's agent) and streams back; nothing of hers is stored on the cloud host
//   4 Lee redeems a cloud_agents code at sign up: the cloud login is offered and stores
//   5 the owner sees stored cloud logins on /ops
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
const port = Number(option("--port", 3881));
const webPort = Number(option("--web-port", 5816));
const keep = args.includes("--keep");
const shotsDir = option("--shots", null);
const resultsFile = option("--results", null);
const WEB = `http://127.0.0.1:${webPort}`;
const HOST = `http://127.0.0.1:${port}`;
const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const repo = NodePath.join(here, "../../..");
const serverDir = NodePath.join(repo, "apps/server");
const webDir = NodePath.join(repo, "apps/web");
const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lp-cloud-agents-e2e-"));
if (shotsDir) NodeFS.mkdirSync(shotsDir, { recursive: true });
const run = Date.now().toString(36).slice(-6);
const PASSWORD = "correct-horse-battery";
const email = (name) => `${name}-${run}@example.com`;
const mockLog = NodePath.join(root, "mock-agent.log");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── Hosts ───────────────────────────────────────────────────────────────────
const LOCAL_PORT = Number(option("--local-port", port + 4));
const LOCAL = `http://127.0.0.1:${LOCAL_PORT}`;
const writeSettings = (dir) => {
  NodeFS.mkdirSync(NodePath.join(dir, "userdata"), { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(dir, "userdata/settings.json"),
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
};
const home = NodePath.join(root, "host");
const localHome = NodePath.join(root, "mia-computer");
writeSettings(home);
writeSettings(localHome);
const localProject = NodePath.join(root, "mia-site");
NodeFS.mkdirSync(localProject, { recursive: true });
NodeFS.writeFileSync(NodePath.join(localProject, "README.md"), "Mia's site\n");

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
  if (!shotsDir) return;
  for (const scheme of ["dark", "light"]) {
    await page.emulateMedia({ colorScheme: scheme });
    await sleep(900);
    await page.screenshot({ path: NodePath.join(shotsDir, `${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: "dark" });
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
/** One WebSocket RPC as this browser session (cookie auth), for checks the UI does not expose directly. */
const wsRpc = (page, tag, payload) =>
  page.evaluate(
    async ([tag, payload, ports]) => {
      const attempt = (origin) =>
        new Promise((resolve) => {
          const socket = new WebSocket(`${origin}/ws?orchestrationProtocol=2`);
          const timer = setTimeout(() => {
            socket.close();
            resolve({ error: "timeout" });
          }, 15_000);
          socket.onopen = () =>
            socket.send(JSON.stringify({ _tag: "Request", id: "1", tag, payload, headers: [] }));
          socket.onmessage = (event) => {
            const messages = [].concat(JSON.parse(String(event.data)));
            for (const message of messages) {
              if (message._tag === "Exit" && String(message.requestId) === "1") {
                clearTimeout(timer);
                socket.close();
                resolve({ exit: message.exit });
              }
            }
          };
          socket.onerror = () => {
            clearTimeout(timer);
            resolve({ error: "socket error" });
          };
        });
      for (const origin of ports) {
        const result = await attempt(origin);
        if (!result.error) return result;
      }
      return { error: "no socket" };
    },
    [tag, payload, [`ws://${new URL(WEB).host}`, `ws://${new URL(HOST).host}`]],
  );
/** Reads a WebSocket RPC stream as this session for a few seconds; returns the raw JSON text. */
const wsStream = (page, tag, payload, ms = 6000) =>
  page.evaluate(
    async ([tag, payload, origin, ms]) =>
      new Promise((resolve) => {
        const socket = new WebSocket(`${origin}/ws?orchestrationProtocol=2`);
        const seen = [];
        socket.onopen = () =>
          socket.send(JSON.stringify({ _tag: "Request", id: "1", tag, payload, headers: [] }));
        socket.onmessage = (event) => {
          seen.push(String(event.data));
          const messages = [].concat(JSON.parse(String(event.data)));
          for (const message of messages) {
            if (message._tag === "Chunk")
              socket.send(JSON.stringify({ _tag: "Ack", requestId: "1" }));
          }
        };
        setTimeout(() => {
          socket.close();
          resolve(seen.join("\n"));
        }, ms);
      }),
    [tag, payload, `ws://${new URL(WEB).host}`, ms],
  );
async function newPage(browser, headers = {}) {
  const context = await browser.newContext({
    viewport: { width: 1360, height: 900 },
    extraHTTPHeaders: headers,
  });
  const page = await context.newPage();
  pages.push(page);
  return page;
}
async function signUp(page, name, address, code = null, landing = "first-run") {
  await page.goto(`${WEB}/lp/login`);
  await page.click("#tab-signup");
  await page.fill("#name", name);
  await page.fill("#email", address);
  await page.fill("#password", PASSWORD);
  if (code !== null) {
    await page.getByTestId("lp-access-code-toggle").click();
    await page.getByTestId("lp-access-code-input").fill(code);
  }
  await page.click("#submit");
  await page.waitForURL((url) => url.origin === WEB && !url.pathname.startsWith("/lp/"), {
    timeout: 30_000,
  });
  if (landing === "soon")
    await page.getByTestId("lp-cloud-coming-soon").waitFor({ timeout: 60_000 });
  else await passOnboarding(page);
}
async function passOnboarding(page, timeout = 60_000) {
  const firstRun = page.getByTestId("lp-first-run");
  const question = page.getByTestId("lp-onboarding");
  await firstRun.or(question).first().waitFor({ timeout });
  if (await question.isVisible()) await page.getByTestId("lp-onboarding-skip").click();
  await firstRun.waitFor({ timeout });
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
const waitForReply = (page, needle, prompt, timeout = 90_000) =>
  waitFor(
    `a reply containing ${needle}`,
    async () => {
      const text = await page.locator("main").innerText();
      const withoutPrompt = text.split(prompt).join("");
      return !/Working for|Thinking/.test(text) && withoutPrompt.includes(needle)
        ? withoutPrompt
        : null;
    },
    timeout,
  );

let browser;
try {
  const env = {
    ...process.env,
    LOGICPACKS_CLOUD_HOST: "true",
    LOGICPACKS_SYNC_SECONDS: "0",
    LOGICPACKS_GOALS_JUDGE: "off",
    LOGICPACKS_STAFF_EMAILS: email("sam"),
    LP_MOCK_LOG: mockLog,
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
  // Mia's computer: a plain LogicPacks server, no cloud-host settings.
  const localEnv = { ...process.env, LP_MOCK_LOG: mockLog };
  for (const key of Object.keys(localEnv)) if (key.startsWith("LOGICPACKS_")) delete localEnv[key];
  const local = spawnLogged(
    "local",
    process.execPath,
    [
      "src/bin.ts",
      "serve",
      "--port",
      String(LOCAL_PORT),
      "--host",
      "127.0.0.1",
      "--base-dir",
      localHome,
      "--no-browser",
    ],
    { cwd: serverDir, env: localEnv },
    ["Pairing URL:"],
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
  await Promise.all([server.ready, web.ready, local.ready]);
  browser = await chromium.launch({ headless: true });
  const hostSettings = () =>
    NodeFS.readFileSync(NodePath.join(home, "userdata/settings.json"), "utf8");
  const PROMPT = "Look at the readme";

  let mia;
  let lee;
  let sam;
  let computerLabel = "";
  let cloudCode = "";
  await step(
    "1 without a code the cloud is coming soon; cloud routes answer 403 feature_locked",
    async () => {
      sam = await newPage(browser);
      await signUp(sam, "Sam", email("sam"));
      const made = await pageApi(sam, "/api/lp/ops/codes", {
        features: ["cloud"],
        maxUses: 2,
        expiresInDays: 7,
        note: "Mia and Lee",
      });
      expect(made.httpStatus === 201 && made.code, `code: ${JSON.stringify(made)}`);
      cloudCode = made.code;
      mia = await newPage(browser);
      await signUp(mia, "Mia", email("mia"), null, "soon");
      await mia.getByText("Cloud workspaces are coming soon.").waitFor({ timeout: 30_000 });
      await mia
        .getByText("Download the LogicPacks app for Mac or Windows to work with your team now.")
        .waitFor({ timeout: 10_000 });
      expect(
        (await mia.getByTestId("lp-cloud-download").getAttribute("href"))?.includes(
          "logicpacks.io/download",
        ),
        "no download link",
      );
      expect((await mia.getByText("Log in with Claude").count()) === 0, "a cloud login is offered");
      const features = await pageApi(mia, "/api/lp/features");
      expect(
        features.cloudHost === true && features.cloudAccess === false,
        `features: ${JSON.stringify(features)}`,
      );
      for (const [path, body] of [
        ["/api/lp/providers/login/start", { provider: "claude" }],
        ["/api/lp/providers/login/start", { provider: "codex" }],
        ["/api/lp/providers/claude", { token: "sk-ant-oat01-example-token-for-the-test" }],
        ["/api/lp/providers/free", { provider: "opencode" }],
        ["/api/lp/providers/key", { provider: "gemini", key: "AIzaSyExampleKeyForTheTest123456" }],
        ["/api/lp/workspaces", { name: "Mia's own" }],
        ["/api/lp/projects/new", { title: "site", source: "empty" }],
        [
          "/api/lp/sync/import",
          { remoteUrl: "https://github.com/example/site.git", title: "site" },
        ],
      ]) {
        const answer = await pageApi(mia, path, body);
        expect(
          answer.httpStatus === 403 &&
            answer.error === "feature_locked" &&
            answer.feature === "cloud",
          `${path} ${JSON.stringify(body)}: ${JSON.stringify(answer)}`,
        );
      }
      expect(!/-lp-/.test(hostSettings()), "a member login was stored on the host");
      await shot(mia, "01-cloud-coming-soon");
    },
  );

  await step(
    "2 Mia enters a cloud code and connects her computer with its pairing URL",
    async () => {
      await mia.getByTestId("lp-cloud-code-input").fill(cloudCode);
      await mia.getByTestId("lp-cloud-code-submit").click();
      await passOnboarding(mia);
      await mia.getByTestId("lp-run-on-computer").click({ timeout: 60_000 });
      const pairingUrl = local.log.match(/Pairing URL: (\S+)/)?.[1];
      expect(pairingUrl, "the local server printed no pairing URL");
      await mia.getByTestId("lp-pairing-url").fill(pairingUrl);
      await mia.getByTestId("lp-connect-computer-submit").click();
      await mia.getByText("Add a project").first().waitFor({ timeout: 30_000 });
      await mia
        .getByRole("button", { name: /Connect your agent|Your agents/ })
        .first()
        .click();
      if ((await mia.getByTestId("lp-computer-connected").count()) === 0) {
        await mia
          .getByTestId("lp-run-on-computer")
          .click({ timeout: 10_000 })
          .catch(() => undefined);
      }
      const card = mia.getByTestId("lp-computer-connected").first();
      await card.waitFor({ timeout: 30_000 });
      computerLabel = (await card.innerText()).replace(/\s*connected\s*$/, "").trim();
      expect(computerLabel.length > 0, "the connected computer has no name");
      await shot(mia, "02-computer-connected");
      await mia.keyboard.press("Escape");
    },
  );

  await step("3 a turn from the web app runs on her computer and streams back", async () => {
    await mia.goto(`${WEB}/`);
    await mia.getByText("Add project").first().click({ timeout: 60_000 });
    await mia.getByText(computerLabel, { exact: true }).last().click({ timeout: 30_000 });
    await sleep(800);
    await mia.keyboard.type(localProject);
    await sleep(800);
    await mia.keyboard.press("Enter");
    await mia.getByText("mia-site").first().waitFor({ timeout: 30_000 });
    await sendMessage(mia, PROMPT);
    await waitForReply(mia, "Done.", PROMPT);
    const turns = NodeFS.readFileSync(mockLog, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const turn = turns.find((entry) => String(entry.userText).includes(PROMPT));
    expect(turn && turn.cwd === localProject, `the turn ran in ${turn?.cwd}, not on her computer`);
    expect(!/-lp-/.test(hostSettings()), "a member login was stored on the host");
    await shot(mia, "03-turn-on-her-computer");
  });

  await step("4 with a cloud code at sign up the cloud login is offered and stores", async () => {
    lee = await newPage(browser);
    await signUp(lee, "Lee", email("lee"), cloudCode);
    const status = await pageApi(lee, "/api/lp/providers/status");
    expect(status.cloudAgents === true, `status: ${JSON.stringify(status)}`);
    await lee.getByText("Log in with Claude").first().waitFor({ timeout: 90_000 });
    const pasted = await pageApi(lee, "/api/lp/providers/claude", {
      token: "sk-ant-oat01-example-token-for-the-test",
    });
    expect(pasted.httpStatus === 200, `cloud login: ${JSON.stringify(pasted)}`);
    const after = await pageApi(lee, "/api/lp/providers/status");
    expect(
      after.providers.find((p) => p.kind === "claude")?.connected === true,
      `after: ${JSON.stringify(after)}`,
    );
    await shot(lee, "04-cloud-login-unlocked");
  });

  await step("5 the owner sees stored cloud logins on /ops", async () => {
    const codes = await pageApi(sam, "/api/lp/ops/codes");
    const entry = (codes.cloudLogins ?? []).find((login) => login.email === email("lee"));
    expect(
      entry && entry.status === "unlocked" && entry.agents.includes("claude"),
      JSON.stringify(codes.cloudLogins),
    );
    expect(
      !(codes.cloudLogins ?? []).some((login) => login.email === email("mia")),
      "Mia is listed",
    );
    await sam.goto(`${WEB}/ops`);
    await sam.getByText("Access codes").first().click({ timeout: 60_000 });
    await sam
      .getByTestId("lp-ops-cloud-logins")
      .getByText(email("lee"))
      .waitFor({ timeout: 30_000 });
    await shot(sam, "05-ops-cloud-logins");
  });
} catch (error) {
  failed = true;
  console.log(`ERROR ${String(error?.stack ?? error)}`);
} finally {
  const passed = results.filter((result) => result.ok).length;
  console.log(`\n${passed}/${results.length} steps passed`);
  for (const result of results.filter((r) => !r.ok))
    console.log(`  ${result.name}: ${result.error}`);
  if (resultsFile) {
    NodeFS.writeFileSync(
      resultsFile,
      JSON.stringify(
        {
          suite: "logicpacks-cloud-agents",
          date: new Date().toISOString(),
          passed,
          failed: results.length - passed,
          total: results.length,
          steps: results,
        },
        null,
        2,
      ),
    );
  }
  if (failed)
    for (const started of children)
      NodeFS.writeFileSync(NodePath.join(root, `${started.name}.log`), started.log);
  if (!keep) {
    await browser?.close().catch(() => undefined);
    await stopAll();
    if (!failed) NodeFS.rmSync(root, { recursive: true, force: true });
  }
  if (keep || failed) console.log(`logs and state in ${root}`);
  process.exit(failed ? 1 : 0);
}
