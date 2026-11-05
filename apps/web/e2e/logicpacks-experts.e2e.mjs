#!/usr/bin/env node
// Experts, agent login and the signed-out landing, end to end:
//   node apps/web/e2e/logicpacks-experts.e2e.mjs [--port 3861] [--web-port 5796] [--shots <dir>] [--keep]
// One cloud host from this tree and the Vite dev client in front of it (no production build).
// The agent is the scripted ACP mock (lp-ledger-mock-agent.mjs). `claude setup-token` and
// `codex login --device-auth` are stand-in scripts that print what the real CLIs print, so the
// browser flow runs to the link / device-code stage and, for Claude, through a pasted code; the
// real CLIs were checked by hand (OAuth cannot be completed headlessly).
//   1 signed-out visitor lands on the LogicPacks log in page; the pairing link still works
//   2 sign up lands on onboarding: "Connect your agent"; Codex shows a device code; Claude connects
//   3 Ana works in a thread, opens Request assistance, picks an expert, brief comes from the thread
//   4 the expert signs in, sees the request, accepts and joins the project with a thread
//   5 Ana shares her agent login (grant), delegates; it arrives in the expert's thread
//   6 who's working shows the expert
//   5b the expert runs a real turn on Ana's granted Claude login (a scripted Claude that
//      answers with the token and config dir it runs under): it is Ana's
//   6b Ana revokes the grant: the login leaves the expert's picker and a turn on it is
//      refused before Claude starts
//   7 Ana ends the session: the grant is revoked and the expert is out of the project
//   8 log out lands on the log in page again
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
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : (args[index + 1] ?? fallback);
};
const port = Number(option("--port", 3861));
const webPort = Number(option("--web-port", 5796));
const keep = args.includes("--keep");
const shotsDir = option("--shots", null);
const WEB = `http://127.0.0.1:${webPort}`;
const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const repo = NodePath.join(here, "../../..");
const serverDir = NodePath.join(repo, "apps/server");
const webDir = NodePath.join(repo, "apps/web");
const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lp-experts-e2e-"));
if (shotsDir) NodeFS.mkdirSync(shotsDir, { recursive: true });
const run = Date.now().toString(36).slice(-6);
const PASSWORD = "correct-horse-battery";
const ANA = `ana-${run}@example.com`;
const INGRID = "ingrid-solberg@experts.logicpacks.internal";
const mockLog = NodePath.join(root, "mock-agent.log");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── Stand-in CLIs ───────────────────────────────────────────────────────────
const bin = NodePath.join(root, "bin");
NodeFS.mkdirSync(bin, { recursive: true });
const fakeClaude = NodePath.join(bin, "claude");
// The scripted Claude (lp-claude-scripted.mjs): setup-token for the login, and for turns it
// answers with the login it runs under, so step 5b can prove a turn ran on Ana's grant.
const claudeLog = NodePath.join(root, "claude-scripted.log");
NodeFS.writeFileSync(
  fakeClaude,
  `#!/bin/sh\nexec "${process.execPath}" "${NodePath.join(here, "lp-claude-scripted.mjs")}" "$@"\n`,
);
const fakeCodex = NodePath.join(bin, "codex");
NodeFS.writeFileSync(
  fakeCodex,
  `#!/usr/bin/env node
if (process.argv[2] !== "login") { console.log("codex-cli 0.0.0-e2e"); process.exit(0); }
console.log("Follow these steps to sign in with ChatGPT using device code authorization:");
console.log("1. Open this link in your browser and sign in to your account");
console.log("   https://auth.openai.com/codex/device");
console.log("2. Enter this one-time code (expires in 15 minutes)");
console.log("   E2E7-${run.toUpperCase().slice(0, 5)}");
setInterval(() => undefined, 1000);
`,
);
NodeFS.chmodSync(fakeClaude, 0o755);
NodeFS.chmodSync(fakeCodex, 0o755);

// ── Host ────────────────────────────────────────────────────────────────────
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
async function newPage(browser) {
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
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
const claudeTurns = () =>
  NodeFS.existsSync(claudeLog)
    ? NodeFS.readFileSync(claudeLog, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .filter((entry) => entry.event === "turn")
    : [];
/** Picks a provider instance by its display name in the composer's model picker. */
async function pickInstance(page, displayName, model) {
  const picker = page.locator('[data-chat-provider-model-picker="true"]').first();
  await picker.waitFor({ timeout: 30_000 });
  await picker.click();
  await page.locator(`[aria-label="${displayName}"]`).first().click({ timeout: 30_000 });
  await page.getByRole("option").filter({ hasText: model }).first().click({ timeout: 30_000 });
  await waitFor(`${displayName} picked`, async () =>
    model.test(await picker.innerText()) ? true : null,
  );
}
const threadIdFromUrl = (page) => new URL(page.url()).pathname.split("/").filter(Boolean)[1];

let browser;
try {
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    LOGICPACKS_CLOUD_HOST: "true",
    LOGICPACKS_MEMBERS_OWN_PROVIDERS: "false",
    LOGICPACKS_SYNC_SECONDS: "0",
    // Storing their Claude and Codex logins on this host is cloud_agents: unlocked for both.
    LOGICPACKS_FEATURES_CLOUD_AGENTS: `${ANA},${INGRID}`,
    // Request assistance (expert cards) is part of Talent.
    LOGICPACKS_FEATURES_TALENT: `${ANA},${INGRID}`,
    // Cloud workspaces (coming soon without a code) are not under test here.
    LOGICPACKS_MEMBER_FEATURES: "cloud",
    LOGICPACKS_MEMBER_CLAUDE_BINARY: fakeClaude,
    LOGICPACKS_MEMBER_CODEX_BINARY: fakeCodex,
    LP_MOCK_LOG: mockLog,
    LP_E2E_RUN: run,
    LP_CLAUDE_SCRIPTED_LOG: claudeLog,
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
  let ingrid;
  let projectId;
  let anaThreadId;
  let request;
  const PROJECT = `Hero shot ${run}`;

  await step("1 a signed-out visitor lands on log in; the pairing link still works", async () => {
    ana = await newPage(browser);
    await ana.goto(`${WEB}/`);
    await ana.waitForURL((url) => url.pathname === "/lp/login", { timeout: 60_000 });
    await ana.locator("#tab-login").waitFor();
    expect(await ana.locator("#tab-signup").isVisible(), "no Sign up tab");
    await shot(ana, "login-landing");
    await ana.click("#pairing");
    await ana.waitForURL((url) => url.pathname === "/pair", { timeout: 30_000 });
    await sleep(1500);
    expect(new URL(ana.url()).pathname === "/pair", `pairing bounced to ${ana.url()}`);
    await shot(ana, "login-pairing-link");
  });

  await step(
    "2 sign up lands on onboarding; Codex shows a device code; Claude connects",
    async () => {
      await signUpOnLanding(ana, "Ana", ANA);
      await passOnboarding(ana);
      await ana.getByText("Connect your agent").first().waitFor();
      await shot(ana, "onboarding-connect-agent");
      await ana.getByTestId("lp-login-codex").click();
      const code = ana.getByTestId("lp-login-codex-code");
      await waitFor("the device code", async () => /E2E7-/.test(await code.innerText()));
      expect(
        (await ana.getByTestId("lp-login-codex-link").getAttribute("href")) ===
          "https://auth.openai.com/codex/device",
        "codex link",
      );
      await shot(ana, "onboarding-codex-device-code");
      await pageApi(ana, "/api/lp/providers/login/cancel", { provider: "codex" });
      await ana.reload();
      await ana.getByTestId("lp-login-claude").waitFor({ timeout: 60_000 });
      await ana.getByTestId("lp-login-claude").click();
      const link = ana.getByTestId("lp-login-claude-link");
      await link.waitFor({ timeout: 30_000 });
      expect(
        (await link.getAttribute("href")).startsWith("https://claude.ai/oauth/authorize"),
        "claude link",
      );
      await shot(ana, "onboarding-claude-link");
      await ana.getByTestId("lp-login-claude-code").fill("e2e-code#state");
      await ana.getByTestId("lp-login-claude-code").press("Enter");
      const status = await waitFor("Claude connected", async () => {
        const result = await pageApi(ana, "/api/lp/providers/status");
        return result.providers?.find((p) => p.kind === "claude" && p.connected) ?? null;
      });
      const body = await ana.locator("body").innerText();
      expect(!body.includes("E2E_"), "the token is visible on the page");
      await shot(ana, "onboarding-claude-connected");
      console.log(`     claude instance ${status.instanceId}`);
      // The stand-in token cannot run turns: work in the threads runs on the scripted agent, and
      // the login comes back (pasted) when Ana shares it with the expert.
      const removed = await pageApi(ana, "/api/lp/providers/remove", { provider: "claude" });
      expect(removed.httpStatus < 300, `remove: ${JSON.stringify(removed)}`);
    },
  );

  await step("3 Ana works in a thread and requests an expert with a brief from it", async () => {
    const created = await pageApi(ana, "/api/lp/projects/new", { kind: "empty", name: PROJECT });
    expect(created.projectId, `project not created: ${JSON.stringify(created)}`);
    projectId = created.projectId;
    await openProject(ana, PROJECT);
    const prompt = "Light the hero shot in scene.blend";
    await sendMessage(ana, prompt);
    await waitForReply(ana, "Done.", prompt);
    anaThreadId = threadIdFromUrl(ana);
    await ana.getByTestId("lp-request-assistance").click();
    await ana.getByTestId("lp-experts-panel").waitFor();
    const cards = await ana.getByTestId("lp-expert-card").count();
    expect(cards >= 6, `only ${cards} expert cards`);
    await sleep(800);
    await shot(ana, "experts-panel");
    await ana
      .locator('[data-testid="lp-expert-card"][data-expert-id="ingrid-solberg"]')
      .getByTestId("lp-expert-pick")
      .click();
    const brief = ana.getByTestId("lp-expert-brief");
    await waitFor("the brief from the thread", async () =>
      (await brief.inputValue()).includes("What I need help with"),
    );
    await brief.fill(`${await brief.inputValue()}Warm key light on the lamp, soft fill.`);
    await shot(ana, "experts-request-brief");
    await ana.getByTestId("lp-expert-send").click();
    const row = ana.getByTestId("lp-expert-request").first();
    await row.waitFor();
    expect(
      (await row.getAttribute("data-status")) === "requested",
      "request not listed as requested",
    );
    await shot(ana, "experts-requested");
    const listed = await pageApi(ana, `/api/lp/experts/requests?projectId=${projectId}`);
    request = listed.requests[0];
    expect(
      request.fromThreadId === anaThreadId,
      `fromThreadId ${request.fromThreadId} vs ${anaThreadId}`,
    );
    expect(
      !JSON.stringify(listed).includes("experts.logicpacks.internal"),
      "the expert's account email leaked",
    );
    await ana.keyboard.press("Escape");
  });

  await step(
    "4 the expert signs in, sees the request, accepts and joins with a thread",
    async () => {
      ingrid = await newPage(browser);
      await signUpOnLanding(ingrid, "Ingrid Solberg", INGRID);
      const entry = ingrid.getByTestId("lp-inbox-entry");
      await entry.waitFor({ timeout: 60_000 });
      await entry.click();
      await ingrid.getByTestId("lp-inbox-dialog").waitFor();
      await shot(ingrid, "experts-inbox");
      await ingrid.getByTestId("lp-inbox-accept").click();
      const accepted = await waitFor("accepted", async () => {
        const inbox = await pageApi(ingrid, "/api/lp/experts/requests");
        return inbox.requests?.find((r) => r.id === request.id && r.status === "accepted") ?? null;
      });
      expect(accepted.expertThreadId, "no expert thread");
      request = accepted;
      const members = await pageApi(ana, `/api/lp/members?projectId=${projectId}`);
      expect(
        JSON.stringify(members).includes("Ingrid"),
        `Ingrid is not a project member: ${JSON.stringify(members).slice(0, 300)}`,
      );
      const ledger = await pageApi(ingrid, `/api/lp/ledger/project?projectId=${projectId}`);
      expect(
        ledger.threads?.some((t) => t.threadId === request.expertThreadId),
        "Ingrid cannot see her thread",
      );
      await waitFor(
        "Ingrid on her thread",
        async () => {
          if (!ingrid.url().includes(request.expertThreadId)) {
            await ingrid.goto(
              `${WEB}/${new URL(ana.url()).pathname.split("/")[1]}/${request.expertThreadId}`,
            );
          }
          return (await ingrid.locator("main").innerText()).length > 0;
        },
        60_000,
      );
      await sleep(1500);
      await shot(ingrid, "experts-expert-thread");
    },
  );

  await step(
    "5 Ana shares her login for this project and delegates; it reaches the expert",
    async () => {
      await ana.getByTestId("lp-request-assistance").click();
      const row = ana.getByTestId("lp-expert-request").first();
      await waitFor(
        "accepted row",
        async () => (await row.getAttribute("data-status")) === "accepted",
        30_000,
      );
      const pasted = await pageApi(ana, "/api/lp/providers/claude", {
        token: `sk-ant-oat01-E2E_${run}_pastedToken`,
      });
      expect(pasted.httpStatus < 300, `paste token: ${JSON.stringify(pasted)}`);
      await row.getByTestId("lp-expert-grant").click();
      await waitFor("grant active", async () => {
        const listed = await pageApi(ana, `/api/lp/experts/requests?projectId=${projectId}`);
        return listed.requests.find((r) => r.id === request.id)?.grantActive ?? false;
      });
      const granted = (await pageApi(ana, `/api/lp/experts/requests?projectId=${projectId}`))
        .requests[0];
      expect(
        granted.grants[0].instanceIds.some((id) => id.startsWith("claude-lp-")),
        `grant ${JSON.stringify(granted.grants)}`,
      );
      const task = `Please add a warm key light ${run}`;
      await row.getByTestId("lp-expert-delegate-input").fill(task);
      await row.getByTestId("lp-expert-delegate").click();
      await waitFor(
        "working",
        async () => (await row.getAttribute("data-status")) === "working",
        30_000,
      );
      await shot(ana, "experts-granted-delegated");
      await ana.keyboard.press("Escape");
      const notices = await waitFor("the task in Ingrid's thread", async () => {
        const ledger = await pageApi(
          ingrid,
          `/api/lp/ledger/thread?threadId=${request.expertThreadId}`,
        );
        return ledger.notices?.find((n) => n.text?.includes(task)) ?? null;
      });
      expect(notices.fromName?.includes("Ana"), `from ${notices.fromName}`);
      await ingrid.reload();
      await waitFor(
        "the notice on Ingrid's screen",
        async () => (await ingrid.locator("body").innerText()).includes(task),
        60_000,
      );
      await shot(ingrid, "experts-delegated-arrives");
    },
  );

  await step("5b the expert's turn runs on Ana's granted Claude login", async () => {
    const before = claudeTurns().length;
    await pickInstance(ingrid, "Claude (Ana)", /Sonnet|Opus|Haiku/);
    const prompt = `Key light pass ${run}`;
    await sendMessage(ingrid, prompt);
    const reply = await waitForReply(ingrid, "GRANTED LOGIN", prompt, 120_000);
    // The scripted Claude names the login it ran under: Ana's pasted token, Ana's home.
    expect(reply.includes(`E2E_${run}_pastedToken`), `not Ana's token: ${reply.slice(-300)}`);
    const turns = claudeTurns().slice(before);
    expect(turns.length === 1, `${turns.length} Claude turns`);
    expect(
      turns[0].login.includes(`E2E_${run}_pastedToken`) &&
        /members\/[^/]+\/claude/.test(turns[0].login),
      `login ${turns[0].login}`,
    );
    // Run in Ana's own member home, not the expert's.
    const anaId = (await pageApi(ana, "/api/lp/session")).user?.userId;
    const ingridId = (await pageApi(ingrid, "/api/lp/session")).user?.userId;
    expect(anaId && ingridId, "no user ids from the session");
    expect(
      turns[0].login.includes(`/members/${anaId}/`) && !turns[0].login.includes(ingridId),
      `not Ana's home: ${turns[0].login}`,
    );
    await shot(ingrid, "experts-turn-on-grant");
  });

  await step("6 who's working marks the expert", async () => {
    await ana.getByTestId("lp-ledger-open").click();
    await ana.getByTestId("lp-ledger-expert").first().waitFor({ timeout: 30_000 });
    await shot(ana, "experts-who-is-working");
    await ana.keyboard.press("Escape");
  });

  await step(
    "6b Ana revokes the grant: the expert's next turn on her login does not run",
    async () => {
      const revoked = await pageApi(ana, "/api/lp/experts/revoke", { requestId: request.id });
      expect(revoked.httpStatus < 300, `revoke: ${JSON.stringify(revoked).slice(0, 300)}`);
      const listed = await pageApi(ana, `/api/lp/experts/requests?projectId=${projectId}`);
      expect(
        listed.requests.find((r) => r.id === request.id)?.grantActive === false,
        "grant still active",
      );
      const statuses = await pageApi(ingrid, "/api/lp/providers/status");
      expect(
        !JSON.stringify(statuses).includes("Claude (Ana)") &&
          !(statuses.providers ?? []).some((p) => p.granted && p.kind === "claude"),
        `Ana's login still offered: ${JSON.stringify(statuses).slice(0, 300)}`,
      );
      // Ingrid's thread still has Ana's login selected (she has not reloaded), so this send
      // names Ana's instance and must be refused by the host, before Claude starts.
      const picker = ingrid.locator('[data-chat-provider-model-picker="true"]').first();
      const selected = await picker.innerText();
      expect(/Sonnet|Opus|Haiku/.test(selected), `Ana's login not selected: ${selected}`);
      const before = claudeTurns().length;
      const prompt = `After revoke ${run}`;
      await sendMessage(ingrid, prompt);
      await waitFor(
        "the host's refusal",
        async () =>
          (await ingrid.locator("body").innerText()).includes(
            "That provider login belongs to another member",
          ),
        60_000,
      );
      await sleep(3_000);
      expect(claudeTurns().length === before, "a Claude turn ran on Ana's login after revoke");
      const after = (await ingrid.locator("main").innerText()).split(prompt).at(-1) ?? "";
      expect(
        !after.includes("GRANTED LOGIN"),
        `a reply came back after revoke: ${after.slice(0, 300)}`,
      );
      await shot(ingrid, "experts-revoked-refused");
      // After a reload Ana's login is gone from the picker.
      await ingrid.reload();
      await picker.waitFor({ timeout: 30_000 });
      await picker.click();
      await ingrid.locator('input[placeholder="Search models..."]').waitFor({ timeout: 30_000 });
      expect(
        (await ingrid.locator('[aria-label="Claude (Ana)"]').count()) === 0,
        "Claude (Ana) still in the picker after revoke",
      );
      await ingrid.keyboard.press("Escape");
      await shot(ingrid, "experts-after-revoke");
    },
  );

  await step("7 Ana ends the session: grant revoked, expert out of the project", async () => {
    const ended = await pageApi(ana, "/api/lp/experts/end", { requestId: request.id });
    expect(
      ended.request?.status === "ended" && ended.request.grantActive === false,
      `end ${JSON.stringify(ended).slice(0, 300)}`,
    );
    expect(ended.removed === true, "the expert was not removed");
    const theirs = await pageApi(ingrid, `/api/lp/ledger/project?projectId=${projectId}`);
    expect(theirs.httpStatus >= 400, `Ingrid still sees the project ledger (${theirs.httpStatus})`);
    const delegate = await pageApi(ana, "/api/lp/experts/delegate", {
      requestId: request.id,
      text: "again",
    });
    expect(delegate.httpStatus >= 400, "delegating after the end still works");
  });

  await step("8 log out lands on log in again", async () => {
    await pageApi(ana, "/api/lp/auth/logout", {});
    await ana.goto(`${WEB}/`);
    await ana.waitForURL((url) => url.pathname === "/lp/login", { timeout: 60_000 });
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
