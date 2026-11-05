#!/usr/bin/env node
// Access gating for LogicPacks for Mac (a laptop host) and the cloud:
//   node apps/web/e2e/logicpacks-gating.e2e.mjs [--port 3971] [--web-port 5971] [--shots <dir>] [--keep]
// The cloud host (codes, signed grants) and a laptop host from this tree, the Vite dev client in
// front of the laptop as its owner sees it (the desktop app's own server). Grants are signed with
// a throwaway key; the laptop is told its public half.
//   1 no code: the laptop has the editor, projects and people; no talent, apps, pricing,
//     expert cards or cloud sync (only a small "Not synced" chip); its agents are the installed
//     CLIs with no login button; every gated route answers 403 feature_locked
//   2 the owner enters a talent+apps code: the laptop asks the cloud, stores the signed
//     grant, and talent, Any app, pricing and expert cards appear; cloud sync stays coming soon
//   3 a forged grant, a bad code and a bad device id are refused
//   4 a cloud code unlocks cloud sync on the laptop
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
const port = Number(option("--port", 3971));
const webPort = Number(option("--web-port", 5971));
const keep = args.includes("--keep");
const shotsDir = option("--shots", null);
const resultsFile = option("--results", null);
const WEB = `http://127.0.0.1:${webPort}`;
const HOST = `http://127.0.0.1:${port}`;
const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const repo = NodePath.join(here, "../../..");
const serverDir = NodePath.join(repo, "apps/server");
const webDir = NodePath.join(repo, "apps/web");
const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lp-gating-e2e-"));
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

const keys = NodeCrypto.generateKeyPairSync("ed25519");
const PRIVATE = keys.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
const PUBLIC = keys.publicKey.export({ format: "der", type: "spki" }).toString("base64");

let browser;
try {
  const cloudEnv = {
    ...process.env,
    LOGICPACKS_CLOUD_HOST: "true",
    LOGICPACKS_SYNC_SECONDS: "0",
    LOGICPACKS_GOALS_JUDGE: "off",
    LOGICPACKS_STAFF_EMAILS: email("sam"),
    LOGICPACKS_GRANT_PRIVATE_KEY: PRIVATE,
    LP_MOCK_LOG: mockLog,
  };
  const cloud = spawnLogged(
    "cloud",
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
    { cwd: serverDir, env: cloudEnv },
    ["server is ready"],
  );
  const laptopEnv = { ...process.env, LP_MOCK_LOG: mockLog };
  for (const key of Object.keys(laptopEnv))
    if (key.startsWith("LOGICPACKS_")) delete laptopEnv[key];
  Object.assign(laptopEnv, {
    LOGICPACKS_CLOUD_URL: HOST,
    LOGICPACKS_GRANT_PUBLIC_KEY: PUBLIC,
    LOGICPACKS_SYNC_SECONDS: "0",
    LOGICPACKS_GOALS_JUDGE: "off",
  });
  const laptop = spawnLogged(
    "laptop",
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
    { cwd: serverDir, env: laptopEnv },
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
        LOGICPACKS_PORT: String(LOCAL_PORT),
        PORT: String(webPort),
        HOST: "127.0.0.1",
      },
    },
    ["ready in", "Local:"],
  );
  await Promise.all([cloud.ready, laptop.ready, web.ready]);
  browser = await chromium.launch({ headless: true });

  // Staff on the cloud, signed in with a cookie jar of their own.
  const sam = await newPage(browser);
  await sam.goto(`${HOST}/lp/login`);
  await sam.click("#tab-signup");
  await sam.fill("#name", "Sam");
  await sam.fill("#email", email("sam"));
  await sam.fill("#password", PASSWORD);
  await sam.click("#submit");
  await sam.waitForURL((url) => !url.pathname.startsWith("/lp/"), { timeout: 30_000 });
  const makeCode = async (features) => {
    const made = await pageApi(sam, "/api/lp/ops/codes", {
      features,
      maxUses: 3,
      expiresInDays: 7,
      note: "gating e2e",
    });
    expect(made.httpStatus === 201 && made.code, `code: ${JSON.stringify(made)}`);
    return made.code;
  };

  // The laptop's owner: the pairing URL opened on the Vite origin.
  const owner = await newPage(browser);
  const pairing = laptop.log.match(/Pairing URL: (\S+)/)?.[1];
  expect(pairing, "the laptop printed no pairing URL");
  const pairUrl = new URL(pairing);
  await owner.goto(`${WEB}${pairUrl.pathname}${pairUrl.search}${pairUrl.hash}`);
  await owner.waitForLoadState("load");
  await waitFor(
    "the owner session",
    async () => (await pageApi(owner, "/api/lp/session")).operator === true,
    60_000,
  );
  const made = await pageApi(owner, "/api/lp/projects/new", { kind: "empty", name: "gating-site" });
  expect(made.httpStatus === 201, `project: ${JSON.stringify(made)}`);
  const projectId = made.projectId;
  const openHome = async () => {
    await owner.goto(`${WEB}/`);
    await owner
      .getByText("gating-site")
      .first()
      .waitFor({ timeout: 60_000 })
      .catch(async (error) => {
        throw new Error(
          `${error.message}\nurl ${owner.url()}\n${(
            await owner
              .locator("body")
              .innerText()
              .catch(() => "")
          ).slice(0, 600)}`,
        );
      });
    await sleep(1500);
  };

  await step(
    "1 no code: core works; talent, apps, pricing and cloud sync are absent; 403s",
    async () => {
      const features = await pageApi(owner, "/api/lp/features");
      expect(
        features.cloudHost === false && features.features.length === 0 && features.staff === false,
        `features: ${JSON.stringify(features)}`,
      );
      for (const [path, body, feature] of [
        ["/api/lp/pricing", null, "talent"],
        ["/api/lp/external/packages", null, "talent"],
        ["/api/lp/experts", null, "talent"],
        [`/api/lp/apps/ops?projectId=${projectId}`, null, "apps"],
        ["/api/lp/appstream/state", null, "apps"],
        ["/api/lp/jobs", null, "freelancer_jobs"],
        ["/api/lp/sync/start", { projectId }, "cloud"],
        [
          "/api/lp/cloud/connect",
          { url: HOST, mode: "login", email: "x@example.com", password: "x" },
          "cloud",
        ],
      ]) {
        const answer = await pageApi(owner, path, body);
        expect(
          answer.httpStatus === 403 &&
            answer.error === "feature_locked" &&
            answer.feature === feature,
          `${path}: ${JSON.stringify(answer).slice(0, 300)}`,
        );
      }
      await openHome();
      const body = await owner.locator("body").innerText();
      expect((await owner.getByTestId("any-app-demo-entry").count()) === 0, "Any app is shown");
      expect(
        (await owner.getByTestId("lp-request-assistance").count()) === 0,
        "Request assistance is shown",
      );
      expect(!/Request assistance|vetted freelancer/i.test(body), "a talent control is shown");
      const syncChip = owner.getByTestId("lp-cloud-sync-soon").first();
      await syncChip.waitFor({ timeout: 30_000 });
      expect(
        (await syncChip.innerText()).trim() === "Not synced",
        "the sync chip does not say Not synced",
      );
      expect((await syncChip.boundingBox()).width < 110, "the sync chip is not small");
      expect(
        !/Cloud sync/.test(await owner.locator("body").innerText()),
        "cloud is advertised in the header",
      );
      await syncChip.click();
      const syncNote = await owner.getByTestId("lp-cloud-sync-note").innerText();
      expect(
        syncNote.trim() ===
          "Sync is coming soon, so your projects keep running even when the host shuts off.",
        `sync note: ${syncNote}`,
      );
      expect(!/code/i.test(syncNote), "the note mentions a code");
      await owner.keyboard.press("Escape");
      expect(!/Sync to cloud|Make it synced/.test(body), "a cloud sync action is shown");
      // Agents: the installed CLIs, no login button.
      const menus = {
        avatar: await owner.getByTestId("lp-avatar").count(),
        switcher: await owner.getByTestId("lp-workspace-switcher").count(),
      };
      await owner
        .getByTestId(menus.avatar > 0 ? "lp-avatar" : "lp-workspace-switcher")
        .first()
        .click({ timeout: 15_000 });
      await owner
        .getByTestId("lp-your-agents")
        .click({ timeout: 15_000 })
        .catch(async (error) => {
          throw new Error(
            `${error.message}\nmenus ${JSON.stringify(menus)}\n${(await owner.locator("body").innerText()).slice(-800)}`,
          );
        });
      await owner.getByTestId("lp-local-agents").waitFor({ timeout: 30_000 });
      const agents = await owner.getByTestId("lp-local-agents").innerText();
      expect(/Claude Code/.test(agents) && /Codex/.test(agents), `agents panel: ${agents}`);
      expect(
        (await owner.getByText(/Log in with (Claude|Codex|ChatGPT)/).count()) === 0,
        "a Log in with button is shown",
      );
      await shot(owner, "01-laptop-no-code");
      await owner.keyboard.press("Escape");
      await owner.goto(`${WEB}/pricing`);
      await owner.waitForURL((url) => url.pathname !== "/pricing", { timeout: 30_000 });
    },
  );

  let talentCode = "";
  await step(
    "2 the owner enters a talent+apps code: the cloud signs a grant, the features appear",
    async () => {
      talentCode = await makeCode(["talent", "apps"]);
      const redeemed = await pageApi(owner, "/api/lp/features/redeem", {
        code: talentCode.toLowerCase().replaceAll("-", " "),
      });
      expect(redeemed.httpStatus === 200, `redeem: ${JSON.stringify(redeemed)}`);
      const features = await pageApi(owner, "/api/lp/features");
      for (const feature of ["talent", "apps", "freelancer_jobs"]) {
        expect(
          features.features.includes(feature),
          `missing ${feature}: ${JSON.stringify(features)}`,
        );
      }
      expect(!features.features.includes("cloud"), "cloud came with a talent code");
      const codes = await pageApi(sam, "/api/lp/ops/codes");
      expect(
        codes.codes.find((code) => code.hint === talentCode.slice(-4))?.redeemed === 1,
        "the cloud did not count the use",
      );
      expect((await pageApi(owner, "/api/lp/pricing")).httpStatus === 200, "pricing still locked");
      await openHome();
      await owner.getByTestId("any-app-demo-entry").waitFor({ timeout: 30_000 });
      await owner.getByTestId("lp-cloud-sync-soon").first().waitFor({ timeout: 30_000 });
      await owner.goto(`${WEB}/pricing`);
      await owner.getByTestId("lp-pricing-rates").waitFor({ timeout: 30_000 });
      await shot(owner, "02-laptop-talent-pricing");
    },
  );

  await step("3 a forged grant, a bad code and a bad device are refused", async () => {
    const bad = await pageApi(owner, "/api/lp/features/redeem", { code: "LP-2222-2222" });
    expect(
      bad.httpStatus === 404 && /isn't valid/.test(bad.message ?? ""),
      `bad code: ${JSON.stringify(bad)}`,
    );
    // A grant signed by anyone else does not verify on the laptop (cloud key mismatch).
    const otherKey = NodeCrypto.generateKeyPairSync("ed25519").privateKey;
    const body = Buffer.from(
      JSON.stringify({
        v: 1,
        deviceId: "dev-00000000-0000-4000-8000-000000000000",
        features: ["cloud"],
        codeId: "x",
        issuedAtMs: 0,
        expiresAtMs: null,
      }),
    ).toString("base64url");
    const forged = `${body}.${NodeCrypto.sign(null, Buffer.from(body), otherKey).toString("base64url")}`;
    const check = await pageApi(sam, "/api/lp/features/grant/check", { grant: forged });
    expect(check.valid === false, `forged grant: ${JSON.stringify(check)}`);
    const issued = await pageApi(sam, "/api/lp/features/grant", {
      code: talentCode,
      deviceId: "not-a-device",
    });
    expect(issued.httpStatus === 400, `bad device: ${JSON.stringify(issued)}`);
  });

  await step("4 a cloud code unlocks cloud sync on the laptop", async () => {
    const cloudCode = await makeCode(["cloud"]);
    const redeemed = await pageApi(owner, "/api/lp/features/redeem", { code: cloudCode });
    expect(redeemed.httpStatus === 200, `redeem: ${JSON.stringify(redeemed)}`);
    const features = await pageApi(owner, "/api/lp/features");
    expect(features.features.includes("cloud"), `features: ${JSON.stringify(features)}`);
    const start = await pageApi(owner, "/api/lp/sync/start", { projectId });
    expect(start.error !== "feature_locked", `sync start: ${JSON.stringify(start)}`);
    await openHome();
    expect((await owner.getByTestId("lp-cloud-sync-soon").count()) === 0, "still coming soon");
    await shot(owner, "04-laptop-cloud");
  });
} catch (error) {
  failed = true;
  console.log(`ERROR ${String(error?.stack ?? error)}`);
} finally {
  const passed = results.filter((result) => result.ok).length;
  console.log(`\n${passed}/${results.length} steps passed`);
  for (const result of results.filter((r) => !r.ok))
    console.log(`  ${result.name}: ${result.error}`);
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
