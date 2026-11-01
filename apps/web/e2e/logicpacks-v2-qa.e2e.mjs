#!/usr/bin/env node
// Whole-product QA: `node apps/web/e2e/logicpacks-v2-qa.e2e.mjs [--port 3805] [--cloud-port 3815]
//   [--keep] [--shots <dir>] [--claude-token-file <file>]`. A laptop and a cloud host from this tree,
// bare repos for GitHub. The token file (CLAUDE_CODE_OAUTH_TOKEN) enables real member Claude turns.
// Needs a built web client and Chrome.
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
const laptopPort = Number(option("--port", 3805));
const cloudPort = Number(option("--cloud-port", 3815));
const keep = args.includes("--keep");
const shotsDir = option("--shots", null);
const tokenFile = option("--claude-token-file", null);
const claudeToken = tokenFile ? NodeFS.readFileSync(tokenFile, "utf8").trim() : null;
const LAPTOP = `http://127.0.0.1:${laptopPort}`;
const CLOUD = `http://127.0.0.1:${cloudPort}`;
const repo = NodePath.join(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "../../..");
const serverDir = NodePath.join(repo, "apps/server");
const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lp-v2-qa-"));
const remotes = NodePath.join(root, "github");
NodeFS.mkdirSync(remotes);
if (shotsDir) NodeFS.mkdirSync(shotsDir, { recursive: true });
const run = Date.now().toString(36);
const email = (name) => `${name}-${run}@example.com`;
const PASSWORD = "correct-horse-battery";
const PROJECT = "Team site";
const NOTES = "Notes";

const gitConfig = (name, body) => {
  const file = NodePath.join(root, `gitconfig-${name}`);
  NodeFS.writeFileSync(file, body);
  return file;
};
const laptopGit = gitConfig("laptop", "[user]\n\tname = Ana\n\temail = ana@example.com\n");
const cloudGit = gitConfig("cloud", "");
const teammateGit = gitConfig("teammate", "[user]\n\tname = Cy\n\temail = cy@example.com\n");
const git = (cwd, ...gitArgs) =>
  NodeChildProcess.execFileSync("git", gitArgs, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: teammateGit, GIT_CONFIG_NOSYSTEM: "1" },
  }).trim();

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
const cloudHome = makeHome("cloud");

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
        GIT_CONFIG_NOSYSTEM: "1",
        LOGICPACKS_SYNC_SECONDS: "2",
        LOGICPACKS_SYNC_REMOTE_ROOT: remotes,
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
    env: { GIT_CONFIG_GLOBAL: laptopGit, LOGICPACKS_CLOUD_URL: CLOUD },
  });
// Members bring their own Claude on the cloud host, as in production.
const startCloud = () =>
  startServer({
    name: "cloud",
    port: cloudPort,
    home: cloudHome,
    env: { GIT_CONFIG_GLOBAL: cloudGit, LOGICPACKS_CLOUD_HOST: "true" },
  });

const cli = (home, cliArgs, timeout = 30_000) =>
  NodeChildProcess.execFileSync(process.execPath, ["src/bin.ts", ...cliArgs, "--base-dir", home], {
    cwd: serverDir,
    encoding: "utf8",
    timeout,
    env: { ...process.env, GIT_CONFIG_GLOBAL: laptopGit, GIT_CONFIG_NOSYSTEM: "1" },
  });
function pairingUrl() {
  const out = cli(laptopHome, ["auth", "pairing", "create", "--base-url", LAPTOP, "--json"]);
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
async function step(name, body, { critical = true } = {}) {
  const started = Date.now();
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
  await page.goto(`${base}/`);
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
  await page.goto(`${base}/lp/login`);
  await page.click("#toggle");
  await page.fill("#name", name);
  await page.fill("#email", email(name.toLowerCase()));
  await page.fill("#password", PASSWORD);
  await page.click("#submit");
  await page.waitForURL(`${base}/`, { timeout: 30_000 });
  await waitForSwitcher(page, `${name}'s workspace`);
}
async function sendMessage(page, text) {
  const composer = page.locator('[contenteditable="true"]').first();
  await composer.waitFor({ timeout: 30_000 });
  await composer.click();
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
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
  await page.getByLabel("Claude token").fill(claudeToken);
  await page.getByTestId("lp-connect-claude").click();
  await page.getByRole("dialog").waitFor({ state: "detached", timeout: 15_000 });
  const session = await pageApi(page, "/api/lp/session");
  expect(session.claude?.connected === true, `Claude not connected: ${JSON.stringify(session)}`);
}
const bareRepo = (prefix) => {
  const lp = NodePath.join(remotes, "lp");
  const found = NodeFS.existsSync(lp)
    ? NodeFS.readdirSync(lp).find((n) => n.startsWith(prefix))
    : undefined;
  return found ? NodePath.join(lp, found) : null;
};
const remoteFile = (bare, file) => {
  try {
    return git(bare, "show", `main:${file}`);
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
let cloud;
try {
  cloud = startCloud();
  laptop = startLaptop();
  await Promise.all([cloud.ready, laptop.ready]);
  operatorBearer = operatorToken();
  browser = await chromium.launch({
    headless: true,
    channel: process.env.LP_E2E_BROWSER_CHANNEL ?? "chrome",
  });

  let anaCloud;
  let anaLaptop;
  let bo;
  let cy;
  let dee;
  let projectId;
  let notesId;
  let cloudProjectId;
  let cloudNotesId;
  let inviteUrl;
  let laptopRoot;
  let cloudRoot;

  await step("1 sign up on the cloud host: default workspace", async () => {
    anaCloud = await newPage(browser, { clipboard: true });
    await signUp(anaCloud, "Ana");
    await passOnboarding(anaCloud);
    const session = await pageApi(anaCloud, "/api/lp/session");
    expect(session.workspaces.length === 1, `${session.workspaces.length} workspaces`);
    expect(session.workspaces[0].role === "owner", "Ana does not own her workspace");
    await shot(anaCloud, "01-cloud-first-run");
  });

  await step("2 second workspace: create, switch, switch back", async () => {
    await switcher(anaCloud).click();
    await anaCloud.getByRole("menuitem", { name: "New workspace" }).click();
    await anaCloud.getByLabel("Workspace name").fill("Side project");
    await clickAndReload(anaCloud, anaCloud.getByTestId("lp-create-workspace"));
    await waitForSwitcher(anaCloud, "Side project");
    await switcher(anaCloud).click();
    await shot(anaCloud, "02-workspace-switcher");
    await anaCloud.keyboard.press("Escape");
    await chooseWorkspace(anaCloud, "Ana's workspace");
    const session = await pageApi(anaCloud, "/api/lp/session");
    expect(session.workspaces.length === 2, `${session.workspaces.length} workspaces`);
  });

  await step("3 laptop: add a project; Not synced badge and reminder", async () => {
    anaLaptop = await newPage(browser);
    await anaLaptop.goto(pairingUrl());
    await anaLaptop.waitForURL((url) => !url.pathname.startsWith("/pair"), { timeout: 30_000 });
    await anaLaptop.goto(`${LAPTOP}/`);
    // A host with no projects opens the welcome wizard, as the desktop app does on first run.
    await anaLaptop.waitForURL(`${LAPTOP}/welcome`, { timeout: 30_000 });
    await anaLaptop.getByRole("button", { name: "Continue" }).click();
    await anaLaptop.getByText("Connect your agents").waitFor();
    await anaLaptop
      .getByRole("dialog")
      .getByText("Claude", { exact: true })
      .waitFor({ timeout: 30_000 });
    await shot(anaLaptop, "03a-laptop-welcome-agents");
    await anaLaptop.getByRole("button", { name: "Continue" }).click();
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
    expect(created, "Team site missing on the laptop");
    projectId = created.id;
    await anaLaptop.goto(`${LAPTOP}/`);
    await draftOpenIn(anaLaptop, PROJECT);
    await waitForBadge(anaLaptop, "not_synced", PROJECT);
    await anaLaptop
      .getByText("Teammates can't see it until you sync.")
      .waitFor({ timeout: 15_000 });
    await shot(anaLaptop, "03-laptop-not-synced");
  });

  await step(
    "4 laptop: real Claude turn on the machine's own Claude Code login",
    async () => {
      const out = cli(
        laptopHome,
        [
          "thread",
          "start",
          projectId,
          "What is 17 plus 25? Reply with just the number.",
          "--provider",
          "claudeAgent",
          "--model",
          "claude-haiku-5-5",
          "--title",
          "Claude check",
          "--wait",
          "--json",
        ],
        240_000,
      );
      expect(out.includes("42"), `no 42 in the reply: ${out.slice(-600)}`);
      await anaLaptop.goto(`${LAPTOP}/`);
      await anaLaptop
        .locator('[data-sidebar="sidebar"] :not(.sr-only):text-is("Claude check")')
        .first()
        .click();
      await anaLaptop.waitForFunction(
        () => /^42$/m.test(document.querySelector("main")?.innerText ?? ""),
        null,
        { timeout: 30_000 },
      );
      await shot(anaLaptop, "04-laptop-claude-turn");
    },
    { critical: false },
  );

  await step("5 laptop: agent thread from the composer", async () => {
    await openProject(anaLaptop, LAPTOP, PROJECT);
    const MESSAGE = `plan the hero section ${run}`;
    await sendMessage(anaLaptop, MESSAGE);
    await anaLaptop.waitForURL((url) => url.pathname.split("/").filter(Boolean).length === 2, {
      timeout: 30_000,
    });
    await waitFor(
      "the replay turn to finish",
      async () => {
        const text = await anaLaptop.locator("main").innerText();
        return !/Working for|Thinking/.test(text) && text.includes(MESSAGE);
      },
      60_000,
    );
    await shot(anaLaptop, "05-laptop-agent-thread");
  });

  await step("6 Sync button: sign in to the cloud host once, push, Synced", async () => {
    await waitForBadge(anaLaptop, "not_synced", PROJECT);
    await anaLaptop.getByTestId("lp-sync-start").click();
    await anaLaptop.getByRole("dialog").waitFor();
    await shot(anaLaptop, "06a-sync-dialog");
    await anaLaptop.getByText("I have an account", { exact: true }).click();
    await anaLaptop.getByLabel("Cloud host").fill(CLOUD);
    await anaLaptop.getByLabel("Email").fill(email("ana"));
    await anaLaptop.getByLabel("Password").fill(PASSWORD);
    await anaLaptop.getByTestId("lp-cloud-connect").click();
    await waitForBadge(anaLaptop, "synced", PROJECT);
    const status = await laptopStatus(projectId);
    expect(status.cloudProjectId, "no cloud project id recorded");
    cloudProjectId = status.cloudProjectId;
    const bare = bareRepo("team-site");
    expect(bare, "no repository was created");
    const syncJson = JSON.parse(remoteFile(bare, ".logicpacks/sync.json") ?? "{}");
    expect(syncJson.cloudHost === CLOUD, `sync.json names ${syncJson.cloudHost}`);
    expect(typeof syncJson.agents === "string", "sync.json carries no agent instruction");
    await shot(anaLaptop, "06b-laptop-synced");
  });

  await step("7 chat prompt 'sync this to the cloud' syncs a second project", async () => {
    await switcher(anaLaptop).click();
    await anaLaptop.getByRole("menuitem", { name: "Add project" }).click();
    await anaLaptop.getByRole("dialog").waitFor();
    await anaLaptop.getByLabel("Project name").fill(NOTES);
    await anaLaptop.getByTestId("lp-create-project").click();
    await anaLaptop.getByRole("dialog").waitFor({ state: "detached", timeout: 30_000 });
    notesId = (await laptopApi("/api/lp/projects")).projects.find((p) => p.title === NOTES)?.id;
    expect(notesId, "Notes was not created");
    await openProject(anaLaptop, LAPTOP, NOTES);
    await waitForBadge(anaLaptop, "not_synced", NOTES);
    await sendMessage(anaLaptop, "sync this to the cloud");
    await waitFor(
      "Notes to sync from chat",
      async () => (await laptopStatus(notesId)).state === "synced",
      90_000,
    );
    await waitForBadge(anaLaptop, "synced", NOTES);
    cloudNotesId = (await laptopStatus(notesId)).cloudProjectId;
    expect(cloudNotesId, "Notes has no cloud project id");
    await shot(anaLaptop, "07-laptop-chat-sync");
  });

  await step("8 cloud: the owner sees both projects as Synced", async () => {
    await anaCloud.goto(`${CLOUD}/`);
    const projects = await pageApi(anaCloud, "/api/lp/projects");
    const ids = (projects.projects ?? []).map((p) => p.id);
    expect(
      ids.includes(cloudProjectId) && ids.includes(cloudNotesId),
      `cloud projects ${JSON.stringify(projects)}`,
    );
    const session = await pageApi(anaCloud, "/api/lp/session");
    const home = session.workspaces.find((w) => w.name === "Ana's workspace");
    expect(
      home.projectIds.includes(cloudProjectId) && home.projectIds.includes(cloudNotesId),
      "synced projects are not in Ana's workspace",
    );
    // The sidebar lists projects by their threads; the header shows the open project's state.
    await openProject(anaCloud, CLOUD, NOTES);
    await waitForBadge(anaCloud, "synced", NOTES);
    await openProject(anaCloud, CLOUD, PROJECT);
    await waitForBadge(anaCloud, "synced", PROJECT);
    await shot(anaCloud, "08-cloud-both-synced");
  });

  await step(
    "9 cloud: connect Claude in the web app and run one real turn",
    async () => {
      expect(claudeToken, "no --claude-token-file given");
      await connectClaude(anaCloud);
      await openProject(anaCloud, CLOUD, PROJECT);
      const PROMPT = "What is 19 plus 23? Reply with just the number.";
      await sendMessage(anaCloud, PROMPT);
      await waitForReply(anaCloud, "42", PROMPT);
      await shot(anaCloud, "09-cloud-claude-turn");
    },
    { critical: false },
  );

  await step("10 invite link and paste-in prompt", async () => {
    await anaCloud.goto(`${CLOUD}/`);
    await anaCloud.getByTestId("lp-invite").click();
    await anaCloud.getByRole("dialog").waitFor();
    await anaCloud.waitForFunction(() =>
      document.querySelector('[data-testid="lp-invite-link"]')?.value?.includes("/lp/join"),
    );
    inviteUrl = await anaCloud.getByTestId("lp-invite-link").inputValue();
    expect(inviteUrl.startsWith(`${CLOUD}/lp/join?invite=`), `invite link ${inviteUrl}`);
    await anaCloud.getByRole("button", { name: "Copy prompt for their Claude Code" }).click();
    const prompt = await waitFor("the prompt on the clipboard", async () => {
      const text = await anaCloud.evaluate(() => navigator.clipboard.readText());
      return text.includes(inviteUrl) ? text : null;
    });
    expect(prompt.includes("Ana's workspace"), `prompt does not name the workspace: ${prompt}`);
    await shot(anaCloud, "10-invite-dialog");
    await anaCloud.keyboard.press("Escape");
  });

  await step("11 friend joins as a new user and sees Synced projects", async () => {
    bo = await newPage(browser);
    await bo.goto(inviteUrl);
    await bo.getByText("You're invited to").waitFor();
    await shot(bo, "11a-join-page");
    await bo.fill("#name", "Bo");
    await bo.fill("#email", email("bo"));
    await bo.fill("#password", PASSWORD);
    await bo.click("#submit");
    await bo.waitForURL((url) => url.origin === CLOUD && !url.pathname.startsWith("/lp/"), {
      timeout: 30_000,
    });
    await waitForSwitcher(bo, "Ana's workspace");
    const projects = await pageApi(bo, "/api/lp/projects");
    const ids = (projects.projects ?? []).map((p) => p.id);
    expect(ids.includes(cloudProjectId) && ids.includes(cloudNotesId), "Bo misses a project");
    await openProject(bo, CLOUD, NOTES);
    await waitForBadge(bo, "synced", NOTES);
    await openProject(bo, CLOUD, PROJECT);
    await waitForBadge(bo, "synced", PROJECT);
    await shot(bo, "11b-friend-synced");
  });

  await step("12 an existing user joins with the same link", async () => {
    cy = await newPage(browser);
    await signUp(cy, "Cy");
    await cy.goto(inviteUrl);
    await waitForSwitcher(cy, "Ana's workspace");
    const session = await pageApi(cy, "/api/lp/session");
    const names = session.workspaces.map((w) => `${w.name}:${w.role}`).sort();
    expect(
      names.join(",") === "Ana's workspace:member,Cy's workspace:owner",
      `Cy's workspaces ${names}`,
    );
  });

  await step("13 owner's laptop off: the friend's agent works on the cloud", async () => {
    await stopServer(laptop);
    expect(!alive(laptop), "laptop server still running");
    const bare = bareRepo("team-site");
    const content = `hello from bo ${run}`;
    if (claudeToken) {
      await connectClaude(bo);
      await openProject(bo, CLOUD, PROJECT);
      // Bo's picker offers his own login only: not Ana's, not the host's.
      await bo.locator('[data-chat-provider-model-picker="true"]').first().click();
      const rail = bo.locator('[aria-label="Providers"]');
      await rail.waitFor();
      const offered = await rail
        .locator("[aria-label]")
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label")));
      await shot(bo, "13a-friend-model-picker");
      await bo.keyboard.press("Escape");
      expect(
        offered.some((label) => label?.startsWith("Claude (Bo)")) &&
          !offered.some((label) => /Ana|Replay|Codex/.test(label ?? "")),
        `Bo's picker offers ${JSON.stringify(offered)}`,
      );
      const PROMPT = `Create a file named bo-notes.md in the project root whose only line is: ${content}. Do nothing else and do not run git.`;
      await sendMessage(bo, PROMPT);
      await waitFor(
        "Bo's agent edit to reach GitHub",
        () => remoteFile(bare, "bo-notes.md")?.includes(content),
        240_000,
      );
    } else {
      // Without a real model the harness writes what the agent's Write tool would.
      await openProject(bo, CLOUD, PROJECT);
      await sendMessage(bo, `cloud turn ${run}`);
      cloudRoot = findCheckout(cloudHome, "index.html");
      NodeFS.writeFileSync(NodePath.join(cloudRoot, "bo-notes.md"), `${content}\n`);
      await waitFor(
        "the cloud host to push the edit",
        () => remoteFile(bare, "bo-notes.md")?.includes(content),
        60_000,
      );
    }
    cloudRoot = findCheckout(cloudHome, "bo-notes.md");
    expect(cloudRoot, "no cloud checkout holds bo-notes.md");
    await shot(bo, "13-friend-agent-cloud");
  });

  await step("14 owner's laptop comes back and fetches the friend's work", async () => {
    laptop = startLaptop();
    await laptop.ready;
    await waitFor(
      "the laptop to pull",
      async () => {
        laptopRoot = findCheckout(laptopHome, "bo-notes.md");
        return laptopRoot !== null;
      },
      60_000,
    );
    const status = await waitFor("synced and caught up", async () => {
      const current = await laptopStatus(projectId);
      return current.state === "synced" && current.behind === 0 ? current : null;
    });
    expect(status, "laptop not synced");
    await openProject(anaLaptop, LAPTOP, PROJECT);
    await waitForBadge(anaLaptop, "synced", PROJECT);
  });

  await step("15 a conflict is surfaced and resolved", async () => {
    const bare = bareRepo("team-site");
    let conflicted = false;
    for (let attempt = 1; attempt <= 4 && !conflicted; attempt += 1) {
      const teammate = NodePath.join(root, `teammate-${attempt}`);
      git(root, "clone", "-q", bare, teammate);
      NodeFS.writeFileSync(NodePath.join(teammate, "README.md"), `teammate version ${attempt}\n`);
      git(teammate, "commit", "-qam", `Teammate edit ${attempt}`);
      git(teammate, "push", "-q", "origin", "HEAD:main");
      NodeFS.writeFileSync(NodePath.join(laptopRoot, "README.md"), `owner version ${attempt}\n`);
      const outcome = await waitFor(
        "a conflict or a clean sync",
        async () => {
          const status = await laptopStatus(projectId);
          if (status.state === "conflict") return "conflict";
          const pushed = remoteFile(bare, "README.md");
          return pushed === `owner version ${attempt}` && status.state === "synced"
            ? "clean"
            : null;
        },
        30_000,
      );
      conflicted = outcome === "conflict";
    }
    expect(conflicted, "could not force a conflict in 4 attempts");
    const status = await laptopStatus(projectId);
    expect(status.conflictFiles.includes("README.md"), `conflict files ${status.conflictFiles}`);
    await openProject(anaLaptop, LAPTOP, PROJECT);
    await waitForBadge(anaLaptop, "conflict", PROJECT);
    await anaLaptop.getByText("Sync conflict").waitFor({ timeout: 15_000 });
    await shot(anaLaptop, "15a-conflict");
    await anaLaptop.getByTestId("lp-sync-keep-mine").click();
    await waitForBadge(anaLaptop, "synced", PROJECT);
    const kept = remoteFile(bare, "README.md");
    expect(kept?.startsWith("owner version"), `GitHub has ${kept}`);
    await waitFor(
      "the cloud host to pull the resolution",
      () =>
        NodeFS.readFileSync(NodePath.join(cloudRoot, "README.md"), "utf8").startsWith(
          "owner version",
        ),
      30_000,
    );
    await shot(anaLaptop, "15b-conflict-resolved");
  });

  await step("16 share one project with an LP user outside the workspace", async () => {
    dee = await newPage(browser);
    await signUp(dee, "Dee");
    let before = await pageApi(dee, "/api/lp/projects");
    expect(
      !(before.projects ?? []).some((p) => p.id === cloudProjectId),
      "Dee already sees Team site",
    );
    // One step from the project itself: Share next to its sync badge.
    await openProject(anaCloud, CLOUD, PROJECT);
    await anaCloud.getByTestId("lp-share-project-open").click();
    await anaCloud.getByRole("dialog").waitFor();
    await anaCloud.getByLabel("Email or name").fill(email("dee"));
    await anaCloud.getByTestId("lp-share-project").click();
    await anaCloud.getByRole("dialog").getByText(email("dee")).waitFor({ timeout: 15_000 });
    await shot(anaCloud, "16-share-dialog");
    await anaCloud.keyboard.press("Escape");
    await dee.goto(`${CLOUD}/`);
    before = await pageApi(dee, "/api/lp/projects");
    expect(
      (before.projects ?? []).some((p) => p.id === cloudProjectId),
      `Dee cannot see Team site: ${JSON.stringify(before)}`,
    );
    expect(
      !(before.projects ?? []).some((p) => p.id === cloudNotesId),
      "Dee sees Notes, which was not shared",
    );
    await dee
      .locator('[data-sidebar="sidebar"]')
      .getByText(PROJECT, { exact: true })
      .first()
      .waitFor({ timeout: 30_000 });
  });

  await step(
    "17 recipes picker on the web: Code works, Blender asks for the desktop app",
    async () => {
      await switcher(anaCloud).click();
      await anaCloud.getByRole("menuitem", { name: "Add project" }).click();
      await anaCloud.getByRole("dialog").waitFor();
      const code = anaCloud.getByTestId("lp-recipe-code");
      await code.waitFor();
      expect((await code.getAttribute("aria-checked")) === "true", "Code is not the default");
      const blender = anaCloud.getByTestId("lp-recipe-blender");
      expect(await blender.isDisabled(), "Blender is selectable on the web");
      expect(
        (await blender.innerText()).includes("Needs the LogicPacks desktop app"),
        "Blender does not ask for the desktop app",
      );
      const download = anaCloud.getByTestId("lp-recipe-download");
      expect(
        (await download.getAttribute("href")) === "https://logicpacks.io/download",
        "no desktop download link",
      );
      await shot(anaCloud, "17-recipes-picker");
      await anaCloud.getByLabel("Project name").fill("Scratch");
      await anaCloud.getByTestId("lp-create-project").click();
      await anaCloud.getByRole("dialog").waitFor({ state: "detached", timeout: 30_000 });
      const session = await pageApi(anaCloud, "/api/lp/session");
      const home = session.workspaces.find((w) => w.name === "Ana's workspace");
      expect(home.projectIds.length === 3, `workspace has ${home.projectIds.length} projects`);
    },
    { critical: false },
  );

  await step(
    "18 demo route plays by direct URL, not linked in the app",
    async () => {
      await anaCloud.goto(`${CLOUD}/`);
      await anaCloud.getByTestId("lp-invite").waitFor({ timeout: 30_000 });
      expect(
        (await anaCloud.getByTestId("any-app-demo-entry").count()) === 0 &&
          (await anaCloud.getByTestId("packs-demo-entry").count()) === 0,
        "signed-in sidebar still links the demo videos",
      );
      await anaCloud.goto(`${CLOUD}/demo/machine`);
      const demo = anaCloud.getByTestId("machine-demo");
      await demo.waitFor({ timeout: 15_000 });
      const time = async () => Number(await demo.getAttribute("data-demo-time"));
      const before = await time();
      await sleep(2_000);
      const after = await time();
      expect(after - before > 1_000, `demo clock ${before} -> ${after}`);
      await shot(anaCloud, "18-demo-route");
    },
    { critical: false },
  );

  await step("19 revoke: remove the friend and unshare the project", async () => {
    await anaCloud.goto(`${CLOUD}/`);
    await anaCloud.getByTestId("lp-invite").click();
    await anaCloud.getByRole("dialog").waitFor();
    await anaCloud.getByRole("button", { name: "Remove Bo" }).click();
    await anaCloud.waitForFunction(() => !document.body.textContent?.includes("Remove Bo"), null, {
      timeout: 15_000,
    });
    await anaCloud.keyboard.press("Escape");
    await bo.goto(`${CLOUD}/`);
    await waitForSwitcher(bo, "Bo's workspace");
    const boProjects = await pageApi(bo, "/api/lp/projects");
    expect(
      !(boProjects.projects ?? []).some((p) => p.id === cloudProjectId),
      "Bo still sees Team site",
    );
    await bo.locator('[data-sidebar="sidebar"]').getByText("No projects yet").waitFor();
    expect(!(await bo.locator("body").innerText()).includes(PROJECT), "Bo's UI shows Team site");

    await openProject(anaCloud, CLOUD, PROJECT);
    await anaCloud.getByTestId("lp-share-project-open").click();
    await anaCloud.getByRole("dialog").waitFor();
    await anaCloud.getByRole("dialog").getByText(email("dee")).waitFor({ timeout: 15_000 });
    await anaCloud.getByRole("dialog").getByRole("button", { name: "Remove" }).click();
    await anaCloud
      .getByRole("dialog")
      .getByText(email("dee"))
      .waitFor({ state: "detached", timeout: 15_000 });
    await anaCloud.keyboard.press("Escape");
    await dee.goto(`${CLOUD}/`);
    const deeProjects = await pageApi(dee, "/api/lp/projects");
    expect(
      !(deeProjects.projects ?? []).some((p) => p.id === cloudProjectId),
      "Dee still sees Team site",
    );
    await shot(bo, "19-friend-revoked");
  });
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  await browser?.close();
  for (const server of servers) await stopServer(server);
  if (failed) {
    for (const server of servers.slice(-2)) {
      console.log(`--- ${server.name} log tail ---\n${server.log.slice(-3000)}`);
    }
  }
  if (!keep) NodeFS.rmSync(root, { recursive: true, force: true });
  else console.log(`kept ${root}`);
}

console.log("\n| Step | Result | Time |\n| --- | --- | --- |");
for (const result of results) {
  console.log(
    `| ${result.name} | ${result.ok ? "pass" : `FAIL: ${result.error?.split("\n")[0]}`} | ${(result.ms / 1000).toFixed(1)}s |`,
  );
}
process.exit(failed ? 1 : 0);
