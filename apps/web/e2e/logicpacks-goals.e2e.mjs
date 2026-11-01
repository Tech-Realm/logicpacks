#!/usr/bin/env node
// Goals (Beta), end to end:
//   node apps/web/e2e/logicpacks-goals.e2e.mjs [--port 3871] [--web-port 5806] [--shots <dir>] [--keep]
// One cloud host from this tree and the Vite dev client in front of it (no production build).
// Every agent is the scripted ACP mock (lp-ledger-mock-agent.mjs), using the real goal tools.
//   1 Ana signs up, makes a project and invites Omar and Priya; each works in a thread
//   2 Ana plans with her agent: the draft card appears, she edits it and confirms
//   3 the milestones arrive in Omar's and Priya's threads as task cards
//   4 Omar's agent edits api/ (outside his guardrails): Ana gets the decision dialog
//   5 Ana messages Omar from the dialog; it lands in his thread
//   6 Ana opens Watch on Omar's milestone and follows his thread
//   7 Priya's agent marks her milestone done; Ana approves the review card; progress 50%
// Screens (dark and light): plan draft, goal view, drift dialog, review card.
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
const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lp-goals-e2e-"));
if (shotsDir) NodeFS.mkdirSync(shotsDir, { recursive: true });
const run = Date.now().toString(36).slice(-6);
const PASSWORD = "correct-horse-battery";
const email = (name) => `${name}-${run}@example.com`;
const mockLog = NodePath.join(root, "mock-agent.log");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
/** One screen in dark and in light (the app follows the system scheme). */
const shot = async (page, name) => {
  if (!shotsDir) return;
  for (const scheme of ["dark", "light"]) {
    await page.emulateMedia({ colorScheme: scheme });
    // Let dialogs, toasts and the theme change settle.
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
const threadIdFromUrl = (page) => new URL(page.url()).pathname.split("/").filter(Boolean)[1];
async function join(page, invitePath, name) {
  await page.goto(`${WEB}${invitePath}`);
  await page.getByText("You're invited to").waitFor({ timeout: 60_000 });
  await page.fill("#name", name);
  await page.fill("#email", email(name.toLowerCase()));
  await page.fill("#password", PASSWORD);
  await page.click("#submit");
  await page.waitForURL((url) => url.origin === WEB && !url.pathname.startsWith("/lp/"), {
    timeout: 30_000,
  });
}
const goals = (page, projectId) => pageApi(page, `/api/lp/goals?projectId=${projectId}`);
/** Clears any decision dialog still open (later drift from the same turn) by accepting it. */
async function acceptOpenDialogs(page) {
  for (let i = 0; i < 6; i += 1) {
    const dialog = page.getByTestId("lp-decision-dialog");
    if (!(await dialog.isVisible().catch(() => false))) {
      await sleep(1500);
      if (!(await dialog.isVisible().catch(() => false))) return;
    }
    await dialog.getByTestId("lp-decision-accept").click();
    await sleep(800);
  }
}

let browser;
try {
  const env = {
    ...process.env,
    LOGICPACKS_CLOUD_HOST: "true",
    LOGICPACKS_MEMBERS_OWN_PROVIDERS: "false",
    LOGICPACKS_SYNC_SECONDS: "0",
    LOGICPACKS_GOALS_JUDGE: "off",
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
  let omar;
  let priya;
  let projectId;
  let anaThread;
  let omarThread;
  let priyaThread;
  let goal;
  const PROJECT = `Checkout ${run}`;

  await step("1 Ana makes a project, Omar and Priya join; each works in a thread", async () => {
    ana = await newPage(browser);
    await signUpOnLanding(ana, "Ana", email("ana"));
    const created = await pageApi(ana, "/api/lp/projects/new", { kind: "empty", name: PROJECT });
    expect(created.projectId, `project not created: ${JSON.stringify(created)}`);
    projectId = created.projectId;
    const session = await pageApi(ana, "/api/lp/session");
    const workspace = session.workspaces.find((w) => w.projectIds.includes(projectId));
    expect(workspace, "the project is not in Ana's workspace");
    const invite = await pageApi(
      ana,
      `/api/lp/workspaces/invite?workspaceId=${workspace.workspaceId}`,
    );
    omar = await newPage(browser);
    await join(omar, invite.path, "Omar");
    priya = await newPage(browser);
    await join(priya, invite.path, "Priya");
    for (const [page, prompt] of [
      [ana, "Plan the checkout work"],
      [omar, "Look at the checkout page"],
      [priya, "Look at the checkout tests"],
    ]) {
      await openProject(page, PROJECT);
      await sendMessage(page, prompt);
      await waitForReply(page, "Done.", prompt);
    }
    anaThread = threadIdFromUrl(ana);
    omarThread = threadIdFromUrl(omar);
    priyaThread = threadIdFromUrl(priya);
    expect(new Set([anaThread, omarThread, priyaThread]).size === 3, "threads are not distinct");
  });

  await step("2 Ana plans with her agent; the draft appears; she edits and confirms", async () => {
    const prompt =
      "ask Omar to build the saved cards list in checkout/ and not touch api/, and Priya to write the checkout tests in tests/, by friday";
    await sendMessage(ana, prompt);
    await waitForReply(ana, "GOAL DRAFT", prompt);
    const card = ana.getByTestId("lp-goal-draft-card");
    await card.waitFor({ timeout: 30_000 });
    goal = (await goals(ana, projectId)).goals?.find((g) => g.state === "draft");
    expect(goal?.milestones.length === 2, `draft: ${JSON.stringify(goal).slice(0, 400)}`);
    expect(
      goal.milestones[0].assignee.name === "Omar" &&
        goal.milestones[0].scope.avoid.includes("api/"),
      `Omar's milestone: ${JSON.stringify(goal.milestones[0])}`,
    );
    await shot(ana, "goals-plan-draft-card");
    await ana.getByTestId("lp-goal-draft-review").click();
    await ana.getByTestId("lp-goal-editor").waitFor();
    await ana.getByTestId("lp-goal-edit-title").fill("Checkout v2: saved cards");
    await shot(ana, "goals-plan-draft-editor");
    await ana.getByTestId("lp-goal-confirm").click();
    await ana
      .getByTestId("lp-goal-detail")
      .and(ana.locator('[data-state="active"]'))
      .waitFor({ timeout: 30_000 });
    goal = (await goals(ana, projectId)).goals.find((g) => g.id === goal.id);
    expect(goal.title === "Checkout v2: saved cards", `title ${goal.title}`);
    await shot(ana, "goals-goal-view");
  });

  await step("3 the milestones arrive in Omar's and Priya's threads", async () => {
    goal = await waitFor("both milestones delivered", async () => {
      const current = (await goals(ana, projectId)).goals.find((g) => g.id === goal.id);
      return current.milestones.every((m) => m.status === "sent") ? current : null;
    });
    expect(
      goal.milestones[0].threadId === omarThread,
      `Omar's milestone went to ${goal.milestones[0].threadId}`,
    );
    expect(
      goal.milestones[1].threadId === priyaThread,
      `Priya's milestone went to ${goal.milestones[1].threadId}`,
    );
    for (const page of [omar, priya]) {
      await page.getByTestId("lp-goal-task-card").first().waitFor({ timeout: 30_000 });
    }
    await ana.keyboard.press("Escape");
    await shot(omar, "goals-task-card");
  });

  await step("4 Omar's agent edits api/: Ana gets the decision dialog", async () => {
    const prompt = "edit api/server.ts export const hacked = true";
    await sendMessage(omar, prompt);
    await waitForReply(omar, "Edited api/server.ts", prompt);
    const dialog = ana.getByTestId("lp-decision-dialog");
    await dialog.waitFor({ timeout: 45_000 });
    const title = await ana.getByTestId("lp-decision-title").innerText();
    expect(
      title.startsWith("Outside the guardrails: Omar edited api/server.ts"),
      `dialog title: ${title}`,
    );
    expect((await dialog.getAttribute("data-kind")) === "goal.drift", "dialog kind");
    await shot(ana, "goals-drift-dialog");
  });

  await step("5 Ana messages Omar from the dialog; it lands in his thread", async () => {
    const text = `Please keep out of api/ ${run}`;
    const dialog = ana.getByTestId("lp-decision-dialog");
    await dialog.getByTestId("lp-decision-note").fill(text);
    await dialog.getByTestId("lp-decision-message").click();
    await waitFor("Omar to see the message", async () =>
      (await omar.getByTestId("lp-notice-text").allInnerTexts()).some((t) => t.includes(text)),
    );
    await acceptOpenDialogs(ana);
    goal = (await goals(ana, projectId)).goals.find((g) => g.id === goal.id);
    const messaged = goal.decisions.find((d) => d.resolution?.action === "message");
    expect(messaged?.resolution.note === text, `decision: ${JSON.stringify(messaged)}`);
    await shot(omar, "goals-message-received");
  });

  await step("6 Ana opens Watch on Omar's milestone and follows his thread", async () => {
    await ana.getByTestId("lp-goals-open").click();
    const sheet = ana.getByTestId("lp-goals-sheet");
    await sheet.waitFor();
    if (
      !(await sheet
        .getByTestId("lp-goal-detail")
        .isVisible()
        .catch(() => false))
    ) {
      await sheet.getByTestId("lp-goal-row").first().click();
    }
    await sheet
      .locator('[data-testid="lp-milestone"][data-assignee="Omar"]')
      .getByTestId("lp-milestone-watch")
      .click();
    await ana.getByTestId("lp-watch-bar").waitFor({ timeout: 30_000 });
    expect(threadIdFromUrl(ana) === omarThread, `Ana is on ${ana.url()}`);
    await shot(ana, "goals-watch");
  });

  await step("7 Priya's agent marks done; Ana approves the review card; progress 50%", async () => {
    const prompt = "goal done: all green";
    await sendMessage(priya, prompt);
    await waitForReply(priya, "GOAL UPDATE", prompt);
    await ana.goto(`${WEB}/${ana.url().split("/").slice(3, 4).join("/")}/${anaThread}`);
    const card = ana.getByTestId("lp-decision-card");
    await card.waitFor({ timeout: 45_000 });
    expect((await card.getAttribute("data-kind")) === "goal.review", "card kind");
    await acceptOpenDialogs(ana);
    await shot(ana, "goals-review-card");
    await ana.getByTestId("lp-decision-approve").first().click();
    await waitFor("the milestone approved", async () => {
      const current = (await goals(ana, projectId)).goals.find((g) => g.id === goal.id);
      return current.milestones[1].status === "approved" ? current : null;
    });
    await ana.getByTestId("lp-goals-open").click();
    const sheet = ana.getByTestId("lp-goals-sheet");
    if (
      !(await sheet
        .getByTestId("lp-goal-detail")
        .isVisible()
        .catch(() => false))
    ) {
      await sheet.getByTestId("lp-goal-row").first().click();
    }
    const bar = sheet.getByTestId("lp-goal-progress");
    await waitFor("progress 50%", async () => (await bar.getAttribute("data-percent")) === "50");
    await shot(ana, "goals-goal-progress");
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
