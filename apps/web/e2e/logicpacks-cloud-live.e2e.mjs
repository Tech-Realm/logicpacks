#!/usr/bin/env node
// Live check of a deployed LogicPacks cloud host (default https://app.logicpacks.io) against
// real GitHub: sign up, a laptop server syncs a template project through `gh`, the owner
// connects Claude and runs a turn, a friend joins by invite, the laptop goes off while the
// friend's agent edits on the cloud, and the laptop fetches that work when it comes back.
// Leaves its test accounts on the host and one private repository on the laptop's GitHub
// account (gh tokens usually lack delete_repo).
//
//   node apps/web/e2e/logicpacks-cloud-live.e2e.mjs --cloud https://app.logicpacks.io \
//     --port 3826 --shots <dir> --claude-token-file <file> [--crossthread]
// Without a Claude token, `--no-agent` runs everything that needs no real agent turn and
// reports the turn steps (5, 8, 10, 11) as skipped; step 9 then checks the laptop comes back
// synced instead of fetching the friend's edit.
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
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : (args[index + 1] ?? fallback);
};
const laptopPort = Number(option("--port", 3826));
const cloudUrl = option("--cloud", "https://app.logicpacks.io").replace(/\/$/, "");
const keep = args.includes("--keep");
const crossThread = args.includes("--crossthread");
const noAgent = args.includes("--no-agent");
// An invite-only host (LOGICPACKS_SIGNUP=invite) refuses plain sign-ups: Ana signs up through
// this invite link instead (any workspace on the host), then works in her own workspace.
const signupInvite = option("--invite", null);
const shotsDir = option("--shots", null);
const tokenFile = option("--claude-token-file", null);
const claudeToken = tokenFile ? NodeFS.readFileSync(tokenFile, "utf8").trim() : null;
const LAPTOP = `http://127.0.0.1:${laptopPort}`;
// --web-port: the laptop's pages come from the Vite dev client (no built apps/web/dist needed).
const devWebPort = webPortArg(args);
const LAPTOP_WEB = devWebPort ? `http://127.0.0.1:${devWebPort}` : LAPTOP;
const CLOUD = cloudUrl;
const repo = NodePath.join(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "../../..");
const serverDir = NodePath.join(repo, "apps/server");
const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lp-live-"));
if (shotsDir) NodeFS.mkdirSync(shotsDir, { recursive: true });
const run = Date.now().toString(36);
const email = (name) => `lp-check-${name}-${run}@example.com`;
const PASSWORD = "correct-horse-battery";
const PROJECT = `lp-e2e ${run}`;

function makeHome(name) {
  const home = NodePath.join(root, name);
  NodeFS.mkdirSync(NodePath.join(home, "userdata"), { recursive: true });
  // The free Replay provider is the operator's default; real Claude runs where a step asks.
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
  return home;
}
const laptopHome = makeHome("laptop");

// Some networks reset the odd TLS connection to Cloudflare; retry those
// instead of failing a whole run on a transport blip.
async function goto(page, url) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await page.goto(url);
    } catch (error) {
      const transient = /ERR_CONNECTION_RESET|ERR_QUIC_PROTOCOL_ERROR|ERR_CONNECTION_CLOSED/.test(
        String(error),
      );
      if (!transient || attempt >= 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
    }
  }
}

const servers = [];
function startServer({ name, port, home, env }) {
  const child = NodeChildProcess.spawn(
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
        LOGICPACKS_SYNC_SECONDS: "5",
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
      // bin.ts relaunches itself; a process group lets teardown stop the real server too.
      detached: true,
    },
  );
  const server = { name, child, log: "" };
  servers.push(server);
  server.ready = new Promise((resolve, reject) => {
    const onData = (chunk) => {
      server.log += chunk;
      if (server.log.length > 400_000) server.log = server.log.slice(-200_000);
      if (server.log.includes("server is ready")) resolve();
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code) =>
      reject(new Error(`${name} server exited (${code})\n${server.log.slice(-2000)}`)),
    );
  });
  return server;
}
const alive = (server) => {
  try {
    process.kill(-server.child.pid, 0);
    return true;
  } catch {
    return false;
  }
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function stopServer(server) {
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    try {
      process.kill(-server.child.pid, signal);
    } catch {
      return;
    }
    for (let waited = 0; alive(server) && waited < 6_000; waited += 200) {
      await sleep(200);
    }
    if (!alive(server)) return;
  }
}

const startLaptop = () =>
  startServer({
    name: "laptop",
    port: laptopPort,
    home: laptopHome,
    env: { LOGICPACKS_CLOUD_URL: CLOUD },
  });

const cli = (home, cliArgs, timeout = 30_000) =>
  NodeChildProcess.execFileSync(process.execPath, ["src/bin.ts", ...cliArgs, "--base-dir", home], {
    cwd: serverDir,
    encoding: "utf8",
    timeout,
    env: process.env,
  });
function pairingUrl() {
  const out = cli(laptopHome, ["auth", "pairing", "create", "--base-url", LAPTOP_WEB, "--json"]);
  const url = JSON.parse(out.slice(out.indexOf("{"))).pairUrl;
  if (typeof url !== "string") throw new Error(`no pairing url in ${out}`);
  return url;
}
const operatorToken = () =>
  cli(laptopHome, ["auth", "session", "issue", "--token-only"]).trim().split("\n").pop();

const results = [];
const pages = [];
let failed = false;
let stopAll = false;
async function shot(page, name) {
  if (!shotsDir) return;
  await page
    .screenshot({ path: NodePath.join(shotsDir, `${name}.png`) })
    .catch((error) => console.log(`     (screenshot ${name} failed: ${error.message})`));
}
/** `critical` steps stop the run when they fail: later steps need what they set up. */
async function step(name, body, { critical = true, needsAgent = false } = {}) {
  const started = Date.now();
  if (needsAgent && noAgent) {
    results.push({ name, ok: true, skipped: true, ms: 0 });
    console.log(`SKIP ${name} (--no-agent)`);
    return;
  }
  if (stopAll) {
    results.push({ name, ok: false, ms: 0, error: "skipped after an earlier failure" });
    return;
  }
  try {
    await body();
    results.push({ name, ok: true, ms: Date.now() - started });
    console.log(`PASS ${name} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  } catch (error) {
    failed = true;
    if (critical) stopAll = true;
    results.push({
      name,
      ok: false,
      ms: Date.now() - started,
      error: String(error?.message ?? error),
    });
    console.log(
      `FAIL ${name}\n     ${String(error?.message ?? error)
        .split("\n")
        .slice(0, 4)
        .join("\n     ")}`,
    );
    for (const [index, page] of pages.entries()) {
      await shot(page, `fail-${results.length}-${index}`);
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
  throw new Error(`timed out waiting for ${what} (last: ${JSON.stringify(last)?.slice(0, 300)})`);
}

let operatorBearer;
async function laptopApi(path, body) {
  const response = await fetch(`${LAPTOP}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${operatorBearer}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${path} ${response.status} ${JSON.stringify(payload)}`);
  return payload;
}
const laptopStatus = async (projectId) =>
  (await laptopApi("/api/lp/sync/status")).projects.find((p) => p.projectId === projectId);
const pageApi = (page, path, body) =>
  page.evaluate(
    async ([path, body]) => {
      const response = await fetch(path, {
        method: body === null ? "GET" : "POST",
        credentials: "include",
        headers: body === null ? {} : { "content-type": "application/json" },
        ...(body === null ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, ...(await response.json().catch(() => ({}))) };
    },
    [path, body ?? null],
  );
const waitForBadge = (page, state, title = null, timeout = 60_000) =>
  page.waitForFunction(
    ([expected, name]) =>
      Array.from(document.querySelectorAll('[data-testid="lp-sync-badge"]')).some(
        (badge) =>
          badge.getAttribute("data-sync-state") === expected &&
          (name === null || badge.getAttribute("aria-label")?.endsWith(`: ${name}`)),
      ),
    [state, title],
    { timeout },
  );
const draftOpenIn = (page, title) =>
  page.waitForFunction(
    (name) =>
      (document.querySelector("main")?.textContent ?? "")
        .replace(/\s+/g, "")
        .includes(`buildin${name.replace(/\s+/g, "")}`),
    title,
    { timeout: 30_000 },
  );
/** Opens a new draft in one project through the draft heading's project picker. */
async function openProject(page, base, title) {
  await goto(page, `${base}/`);
  const heading = page.locator("main h1 button, main h2 button").first();
  await heading.waitFor({ timeout: 30_000 });
  if ((await heading.innerText()).trim() !== title) {
    await heading.click();
    await page.locator('[role="listbox"]').getByText(title, { exact: true }).click();
  }
  await draftOpenIn(page, title);
}
const switcher = (page) => page.getByTestId("lp-workspace-switcher");
const waitForSwitcher = (page, name) =>
  page.waitForFunction(
    (expected) =>
      document.querySelector('[data-testid="lp-workspace-switcher"]')?.textContent?.trim() ===
      expected,
    name,
    { timeout: 30_000 },
  );
const clickAndReload = (page, locator) =>
  Promise.all([page.waitForEvent("load", { timeout: 30_000 }), locator.click()]);
async function chooseWorkspace(page, name) {
  await switcher(page).click();
  await clickAndReload(page, page.getByRole("menuitemradio", { name }));
  await waitForSwitcher(page, name);
}
async function newPage(browser, { clipboard = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  if (clipboard) {
    await context.grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: CLOUD,
    });
  }
  const page = await context.newPage();
  pages.push(page);
  return page;
}
async function signUp(page, name, base = CLOUD) {
  if (signupInvite !== null && base === CLOUD) {
    await goto(page, signupInvite);
    await page.getByText("You're invited to").waitFor();
    await page.fill("#name", name);
    await page.fill("#email", email(name.toLowerCase()));
    await page.fill("#password", PASSWORD);
    await page.click("#submit");
    await page.waitForURL((url) => url.origin === base && !url.pathname.startsWith("/lp/"), {
      timeout: 30_000,
    });
    // The invite put her in someone else's workspace; the checks work in her own.
    const session = await pageApi(page, "/api/lp/session");
    const own = (session.workspaces ?? []).find((workspace) => workspace.role === "owner");
    expect(own !== undefined, "no workspace of her own after the invite");
    await pageApi(page, "/api/lp/workspaces/current", { workspaceId: own.id ?? own.workspaceId });
    await goto(page, `${base}/`);
    await waitForSwitcher(page, `${name}'s workspace`);
    return;
  }
  await goto(page, `${base}/lp/login`);
  await page.click("#toggle");
  await page.fill("#name", name);
  await page.fill("#email", email(name.toLowerCase()));
  await page.fill("#password", PASSWORD);
  await page.click("#submit");
  await page.waitForURL(`${base}/`, { timeout: 30_000 });
  await waitForSwitcher(page, `${name}'s workspace`);
}
/**
 * Types and presses Enter at once, as a person would right after Connect Claude. The composer
 * holds a send made while the connection is still coming back, so nothing is retried here.
 */
async function sendMessage(page, text) {
  const composer = page.locator('[contenteditable="true"]').first();
  await composer.waitFor({ timeout: 30_000 });
  await composer.click();
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
  await waitFor(
    "the message to leave the composer",
    async () => !(await composer.innerText()).includes(text),
    60_000,
  );
}
/** Waits until the open thread shows `needle` outside the user's own message and is idle. */
const waitForReply = (page, needle, prompt, timeout = 180_000) =>
  waitFor(
    `a reply containing ${needle}`,
    async () => {
      const text = await page.locator("main").innerText();
      const withoutPrompt = text.split(prompt).join("");
      return !/Working for|Thinking/.test(text) && withoutPrompt.includes(needle);
    },
    timeout,
  );
async function connectClaude(page) {
  const nudge = page.getByTestId("lp-connect-claude-nudge");
  if (await nudge.isVisible().catch(() => false)) {
    await nudge.click();
  } else {
    await switcher(page).click();
    await page.getByRole("menuitem", { name: /Connect Claude/ }).click();
  }
  await page.getByRole("dialog").waitFor();
  // The dialog offers "Log in with Claude" first; the test pastes a token.
  const pasteToken = page.getByTestId("lp-paste-token-toggle");
  if (await pasteToken.isVisible().catch(() => false)) await pasteToken.click();
  await page.getByLabel("Claude token").fill(claudeToken);
  await page.getByTestId("lp-connect-claude").click();
  // The dialog stays open so more agents can be connected; close it once Claude is in.
  const session = await waitFor(
    "Claude to connect",
    async () => {
      const current = await pageApi(page, "/api/lp/session");
      return current.claude?.connected === true ? current : null;
    },
    30_000,
  );
  expect(session.claude?.connected === true, `Claude not connected: ${JSON.stringify(session)}`);
  if (
    await page
      .getByRole("dialog")
      .isVisible()
      .catch(() => false)
  ) {
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "detached", timeout: 15_000 });
  }
}
const gh = (...ghArgs) =>
  NodeChildProcess.execFileSync("gh", ghArgs, { encoding: "utf8", timeout: 30_000 }).trim();
/** `owner/repo` of a checkout's origin on GitHub. */
const githubRepo = (checkout) =>
  NodeChildProcess.execFileSync("git", ["-C", checkout, "remote", "get-url", "origin"], {
    encoding: "utf8",
  })
    .trim()
    .replace(/^(?:https:\/\/github\.com\/|git@github\.com:)/, "")
    .replace(/\.git$/, "");
const remoteFile = (repo, file) => {
  try {
    return Buffer.from(
      gh("api", `repos/${repo}/contents/${file}`, "--jq", ".content"),
      "base64",
    ).toString("utf8");
  } catch {
    return null;
  }
};
const findCheckout = (home, marker) => {
  const base = NodePath.join(home, "projects");
  if (!NodeFS.existsSync(base)) return null;
  const hit = NodeFS.readdirSync(base, { recursive: true })
    .map((entry) => NodePath.join(base, String(entry)))
    .find((file) => file.endsWith(`${NodePath.sep}${marker}`) && !file.includes(".git/"));
  return hit ? NodePath.dirname(hit) : null;
};

let browser;
let laptop;
const devWeb = devWebPort
  ? startDevWeb({ repo, serverPort: laptopPort, webPort: devWebPort })
  : null;
try {
  laptop = startLaptop();
  await laptop.ready;
  await devWeb?.ready;
  operatorBearer = operatorToken();
  browser = await chromium.launch({
    headless: true,
    channel: process.env.LP_E2E_BROWSER_CHANNEL ?? "chrome",
    // Cloudflare's HTTP/3 drops the odd first request from headless Chrome.
    args: ["--disable-quic"],
  });

  let anaCloud;
  let anaLaptop;
  let bo;
  let projectId;
  let cloudProjectId;
  let inviteUrl;
  let laptopRoot;
  let repo;

  await step("1 sign up on the cloud host: default workspace", async () => {
    anaCloud = await newPage(browser, { clipboard: true });
    await signUp(anaCloud, "Ana");
    await passOnboarding(anaCloud);
    const session = await pageApi(anaCloud, "/api/lp/session");
    expect(
      session.workspaces.filter((workspace) => workspace.role === "owner").length === 1,
      `${session.workspaces.length} workspaces`,
    );
    expect(
      session.workspaces.some((workspace) => workspace.role === "owner"),
      "Ana does not own her workspace",
    );
    await shot(anaCloud, "01-cloud-first-run");
  });

  await step("2 laptop: add a project; Not synced badge and reminder", async () => {
    anaLaptop = await newPage(browser);
    await goto(anaLaptop, pairingUrl());
    await anaLaptop.waitForURL((url) => !url.pathname.startsWith("/pair"), { timeout: 30_000 });
    await goto(anaLaptop, `${LAPTOP_WEB}/`);
    await anaLaptop.waitForURL(`${LAPTOP_WEB}/welcome`, { timeout: 30_000 });
    await anaLaptop.getByRole("button", { name: "Continue", exact: true }).click();
    await anaLaptop.getByText("Connect your agents").waitFor();
    await anaLaptop.getByRole("button", { name: "Continue", exact: true }).click();
    await anaLaptop.getByRole("button", { name: "Do not import projects" }).click();
    await anaLaptop.waitForURL((url) => url.pathname !== "/welcome", { timeout: 30_000 });
    await switcher(anaLaptop).click();
    await anaLaptop.getByRole("menuitem", { name: "Add project" }).click();
    await anaLaptop.getByRole("dialog").waitFor();
    await anaLaptop.getByText("Template", { exact: true }).click();
    await anaLaptop.getByLabel("Project name").fill(PROJECT);
    await anaLaptop.getByTestId("lp-create-project").click();
    await anaLaptop.getByRole("dialog").waitFor({ state: "detached", timeout: 30_000 });
    const created = (await laptopApi("/api/lp/projects")).projects.find((p) => p.title === PROJECT);
    expect(created, `${PROJECT} missing on the laptop`);
    projectId = created.id;
    await goto(anaLaptop, `${LAPTOP_WEB}/`);
    await draftOpenIn(anaLaptop, PROJECT);
    await waitForBadge(anaLaptop, "not_synced", PROJECT);
    await shot(anaLaptop, "02-laptop-not-synced");
  });

  await step("3 Sync button: sign in to the cloud host, GitHub repo, Synced", async () => {
    await anaLaptop.getByTestId("lp-sync-start").click();
    await anaLaptop.getByRole("dialog").waitFor();
    await anaLaptop.getByText("I have an account", { exact: true }).click();
    await anaLaptop.getByLabel("Cloud host").fill(CLOUD);
    await anaLaptop.getByLabel("Email").fill(email("ana"));
    await anaLaptop.getByLabel("Password").fill(PASSWORD);
    await anaLaptop.getByTestId("lp-cloud-connect").click();
    await waitForBadge(anaLaptop, "synced", PROJECT, 180_000);
    const status = await laptopStatus(projectId);
    expect(status.cloudProjectId, "no cloud project id recorded");
    cloudProjectId = status.cloudProjectId;
    laptopRoot = findCheckout(laptopHome, "index.html");
    expect(laptopRoot, "no laptop checkout");
    repo = githubRepo(laptopRoot);
    const syncJson = JSON.parse(remoteFile(repo, ".logicpacks/sync.json") ?? "{}");
    expect(syncJson.cloudHost === CLOUD, `sync.json on GitHub names ${syncJson.cloudHost}`);
    console.log(`     GitHub repository: ${repo}`);
    await shot(anaLaptop, "03-laptop-synced");
  });

  await step("4 cloud: the owner sees the project Synced", async () => {
    await goto(anaCloud, `${CLOUD}/`);
    const projects = await pageApi(anaCloud, "/api/lp/projects");
    expect(
      (projects.projects ?? []).some((p) => p.id === cloudProjectId),
      `cloud projects ${JSON.stringify(projects)}`,
    );
    await openProject(anaCloud, CLOUD, PROJECT);
    await waitForBadge(anaCloud, "synced", PROJECT, 120_000);
    await shot(anaCloud, "04-cloud-synced");
  });

  await step(
    "5 cloud: connect Claude in the web app and run one real turn",
    async () => {
      expect(claudeToken, "no --claude-token-file given");
      await connectClaude(anaCloud);
      await openProject(anaCloud, CLOUD, PROJECT);
      const PROMPT = "What is 19 plus 23? Reply with just the number.";
      await sendMessage(anaCloud, PROMPT);
      await waitForReply(anaCloud, "42", PROMPT);
      await shot(anaCloud, "05-cloud-claude-turn");
    },
    { critical: false, needsAgent: true },
  );

  await step("6 invite link", async () => {
    await goto(anaCloud, `${CLOUD}/`);
    await anaCloud.getByTestId("lp-invite").click();
    await anaCloud.getByRole("dialog").waitFor();
    await anaCloud.waitForFunction(() =>
      document.querySelector('[data-testid="lp-invite-link"]')?.value?.includes("/lp/join"),
    );
    inviteUrl = await anaCloud.getByTestId("lp-invite-link").inputValue();
    expect(inviteUrl.startsWith(`${CLOUD}/lp/join?invite=`), `invite link ${inviteUrl}`);
    await shot(anaCloud, "06-invite-dialog");
    await anaCloud.keyboard.press("Escape");
  });

  await step("7 friend joins as a new user and sees the project Synced", async () => {
    bo = await newPage(browser);
    await goto(bo, inviteUrl);
    await bo.getByText("You're invited to").waitFor();
    await bo.fill("#name", "Bo");
    await bo.fill("#email", email("bo"));
    await bo.fill("#password", PASSWORD);
    await bo.click("#submit");
    await bo.waitForURL((url) => url.origin === CLOUD && !url.pathname.startsWith("/lp/"), {
      timeout: 30_000,
    });
    await waitForSwitcher(bo, "Ana's workspace");
    const projects = await pageApi(bo, "/api/lp/projects");
    expect(
      (projects.projects ?? []).some((p) => p.id === cloudProjectId),
      "Bo misses the project",
    );
    await openProject(bo, CLOUD, PROJECT);
    await waitForBadge(bo, "synced", PROJECT);
    await shot(bo, "07-friend-synced");
  });

  await step(
    "8 laptop off: the friend's Claude agent edits on the cloud and it reaches GitHub",
    async () => {
      await stopServer(laptop);
      expect(!alive(laptop), "laptop server still running");
      expect(claudeToken, "no --claude-token-file given");
      const content = `hello from bo ${run}`;
      await connectClaude(bo);
      await openProject(bo, CLOUD, PROJECT);
      const PROMPT = `Create a file named bo-notes.md in the project root whose only line is: ${content}. Do nothing else and do not run git.`;
      await sendMessage(bo, PROMPT);
      await waitFor(
        "Bo's agent edit to reach GitHub",
        () => remoteFile(repo, "bo-notes.md")?.includes(content),
        300_000,
      );
      await shot(bo, "08-friend-agent-cloud");
    },
    { needsAgent: true },
  );

  await step(
    noAgent
      ? "9 laptop comes back synced (no friend edit to fetch: --no-agent)"
      : "9 laptop comes back and fetches the friend's work",
    async () => {
      // Step 8 turns the laptop off; without it, turn it off here so it really comes back.
      if (alive(laptop)) await stopServer(laptop);
      laptop = startLaptop();
      await laptop.ready;
      if (!noAgent) {
        await waitFor(
          "the laptop to pull bo-notes.md",
          () => NodeFS.existsSync(NodePath.join(laptopRoot, "bo-notes.md")),
          120_000,
        );
      }
      const status = await waitFor("synced and caught up", async () => {
        const current = await laptopStatus(projectId);
        return current.state === "synced" && current.behind === 0 ? current : null;
      });
      expect(status, "laptop not synced");
    },
  );

  if (crossThread) {
    await step(
      "10 cross-thread: Ana asks what Bo is working on",
      async () => {
        const PROMPT = "What is Bo working on in this project right now? Answer in one sentence.";
        await sendMessage(anaCloud, PROMPT);
        const reply = await waitFor(
          "an answer about Bo's work",
          async () => {
            const text = (await anaCloud.locator("main").innerText()).split(PROMPT).at(-1) ?? "";
            return !/Working for|Thinking/.test(text) && /bo-notes|bo notes/i.test(text)
              ? text
              : null;
          },
          240_000,
        );
        console.log(`     answer: ${reply.replace(/\s+/g, " ").slice(0, 300)}`);
        await anaCloud.getByTestId("lp-ledger-open").click();
        await anaCloud.getByTestId("lp-ledger-popover").waitFor();
        const rows = await waitFor(
          "the popover to list Bo's thread",
          async () => {
            const texts = await anaCloud.getByTestId("lp-ledger-thread").allInnerTexts();
            return texts.some((row) => row.includes("Bo")) ? texts : null;
          },
          30_000,
        );
        console.log(`     popover: ${JSON.stringify(rows).slice(0, 300)}`);
        expect(
          rows.some((row) => row.includes("Bo")),
          `popover rows: ${JSON.stringify(rows)}`,
        );
        await shot(anaCloud, "10-who-is-working");
        await anaCloud.keyboard.press("Escape");
      },
      { needsAgent: true },
    );

    await step(
      "11 cross-thread: Ana's message reaches Bo's thread",
      async () => {
        const PROMPT =
          "Send a message to Bo's thread: please add a second line saying see you at standup to bo-notes.md next.";
        await sendMessage(anaCloud, PROMPT);
        await bo
          .getByTestId("lp-notice-text")
          .filter({ hasText: /standup/i })
          .first()
          .waitFor({ timeout: 240_000 });
        await shot(bo, "11-bo-notice");
      },
      { needsAgent: true },
    );
  }
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  await browser?.close();
  devWeb?.stop();
  for (const server of servers) await stopServer(server);
  if (failed) {
    for (const server of servers.slice(-1)) {
      console.log(`--- ${server.name} log tail ---\n${server.log.slice(-3000)}`);
    }
  }
  if (!keep) NodeFS.rmSync(root, { recursive: true, force: true });
  else console.log(`kept ${root}`);
}

console.log("\n| Step | Result | Time |\n| --- | --- | --- |");
for (const result of results) {
  console.log(
    `| ${result.name} | ${result.skipped ? "skipped (--no-agent)" : result.ok ? "pass" : `FAIL: ${result.error?.split("\n")[0]}`} | ${(result.ms / 1000).toFixed(1)}s |`,
  );
}
process.exit(failed ? 1 : 0);
