#!/usr/bin/env node
// Sync E2E: `node apps/web/e2e/logicpacks-sync.e2e.mjs [--port 3802] [--cloud-port 3812] [--keep]`.
// Boots a laptop and a cloud host from this tree; bare repos stand in for GitHub.
// Needs a built web client and Chrome (LP_E2E_BROWSER_CHANNEL=chromium for Playwright's own).
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const require = NodeModule.createRequire(import.meta.url);
const { chromium } = require("playwright");

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : Number(args[index + 1]) || fallback;
};
const laptopPort = flag("--port", 3802);
const cloudPort = flag("--cloud-port", 3812);
const keep = args.includes("--keep");
const LAPTOP = `http://127.0.0.1:${laptopPort}`;
const CLOUD = `http://127.0.0.1:${cloudPort}`;
const repo = NodePath.join(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "../../..");
const serverDir = NodePath.join(repo, "apps/server");
const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lp-sync-e2e-"));
const remotes = NodePath.join(root, "github");
NodeFS.mkdirSync(remotes);
const run = Date.now().toString(36);
const email = (name) => `${name}-${run}@example.com`;
const PASSWORD = "correct-horse-battery";
const PROJECT = "Team site";

// Each machine has its own git identity; the cloud host has none, like a fresh VPS.
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
  // The free Replay provider is the default, so turns run without a paid model.
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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const startLaptop = () =>
  startServer({
    name: "laptop",
    port: laptopPort,
    home: laptopHome,
    env: { GIT_CONFIG_GLOBAL: laptopGit, LOGICPACKS_CLOUD_URL: CLOUD },
  });
const startCloud = () =>
  startServer({
    name: "cloud",
    port: cloudPort,
    home: cloudHome,
    env: {
      GIT_CONFIG_GLOBAL: cloudGit,
      LOGICPACKS_CLOUD_HOST: "true",
      LOGICPACKS_MEMBERS_OWN_PROVIDERS: "false",
    },
  });

/** The laptop owner is the host operator: a pairing link signs the browser in, like the desktop app. */
function pairingUrl() {
  const out = NodeChildProcess.execFileSync(
    process.execPath,
    [
      "src/bin.ts",
      "auth",
      "pairing",
      "create",
      "--base-dir",
      laptopHome,
      "--base-url",
      LAPTOP,
      "--json",
    ],
    { cwd: serverDir, encoding: "utf8" },
  );
  const parsed = JSON.parse(out.slice(out.indexOf("{")));
  const url = parsed.pairUrl;
  if (typeof url !== "string") throw new Error(`no pairing url in ${out}`);
  return url;
}
function operatorToken() {
  return NodeChildProcess.execFileSync(
    process.execPath,
    ["src/bin.ts", "auth", "session", "issue", "--base-dir", laptopHome, "--token-only"],
    { cwd: serverDir, encoding: "utf8" },
  )
    .trim()
    .split("\n")
    .pop();
}

const results = [];
const pages = [];
const shotsDir = process.env.LP_E2E_SHOTS;
let failed = false;
async function step(name, body) {
  const started = Date.now();
  // Each flow builds on the last, so the first failure stops the run.
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
    if (shotsDir) {
      for (const [index, page] of pages.entries()) {
        await page
          .screenshot({ path: NodePath.join(shotsDir, `${results.length}-${index}.png`) })
          .catch(() => undefined);
      }
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
      last = error;
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
      return response.json();
    },
    [path, body ?? null],
  );
/** The header badge of the open project (or of `title` when named). */
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
/** Opens a new draft in one project through the draft heading's project picker. */
async function openProject(page, base, title) {
  await page.goto(`${base}/`);
  const heading = page.locator("main h1 button, main h2 button").first();
  await heading.waitFor({ timeout: 30_000 });
  if ((await heading.innerText()).trim() !== title) {
    await heading.click();
    await page.locator('[role="listbox"]').getByText(title, { exact: true }).click();
  }
  await page.waitForFunction(
    (name) =>
      (document.querySelector("main")?.textContent ?? "")
        .replace(/\s+/g, "")
        .includes(`buildin${name.replace(/\s+/g, "")}`),
    title,
    { timeout: 30_000 },
  );
}
const bareRepo = () => {
  const lp = NodePath.join(remotes, "lp");
  const found = NodeFS.existsSync(lp)
    ? NodeFS.readdirSync(lp).find((n) => n.startsWith("team-site"))
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
async function newPage(browser) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await context.newPage();
  pages.push(page);
  return page;
}
async function sendMessage(page, text) {
  const composer = page.locator('[contenteditable="true"]').first();
  await composer.waitFor({ timeout: 30_000 });
  await composer.click();
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
}

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

  let ana;
  let bo;
  let projectId;
  let laptopRoot;
  let cloudProjectId;
  let cloudRoot;

  await step("a new local project shows Not synced with a reminder", async () => {
    const created = await laptopApi("/api/lp/projects/new", {
      kind: "template",
      name: PROJECT,
      template: "website",
    });
    projectId = created.projectId;
    const projects = await laptopApi("/api/lp/projects");
    expect(
      projects.projects.some((p) => p.id === projectId),
      "project missing on the laptop",
    );
    ana = await newPage(browser);
    await ana.goto(pairingUrl());
    await ana.waitForURL((url) => !url.pathname.startsWith("/pair"), { timeout: 30_000 });
    // Home opens a draft in the newest project.
    await ana.goto(`${LAPTOP}/`);
    await waitForBadge(ana, "not_synced");
    await ana.getByText("Teammates can't see it until you sync.").waitFor({ timeout: 15_000 });
    const status = await laptopStatus(projectId);
    expect(status.state === "not_synced", `laptop says ${status.state}`);
  });

  await step("Sync button: connect the cloud host once, push, register, badge Synced", async () => {
    await ana.getByTestId("lp-sync-start").click();
    await ana.getByRole("dialog").waitFor();
    await ana.getByText("Create one", { exact: true }).click();
    await ana.getByLabel("Cloud host").fill(CLOUD);
    await ana.getByLabel("Your name").fill("Ana");
    await ana.getByLabel("Email").fill(email("ana"));
    await ana.getByLabel("Password").fill(PASSWORD);
    await ana.getByTestId("lp-cloud-connect").click();
    await waitForBadge(ana, "synced");
    const status = await laptopStatus(projectId);
    expect(status.cloudProjectId, "no cloud project id recorded");
    cloudProjectId = status.cloudProjectId;
    const bare = bareRepo();
    expect(bare, "no repository was created for the project");
    const syncJson = JSON.parse(remoteFile(bare, ".logicpacks/sync.json") ?? "{}");
    expect(syncJson.cloudHost === CLOUD, `sync.json names ${syncJson.cloudHost}`);
    expect(typeof syncJson.agents === "string", "sync.json carries no agent instruction");
  });

  await step("chat intent: 'sync this to the cloud' runs the same flow", async () => {
    await laptopApi("/api/lp/projects/new", { kind: "empty", name: "Notes" });
    // A fresh window, so home opens the new project rather than the last draft.
    const notesPage = await newPage(browser);
    await notesPage.goto(pairingUrl());
    await notesPage.waitForURL((url) => !url.pathname.startsWith("/pair"), { timeout: 30_000 });
    await notesPage.goto(`${LAPTOP}/`);
    await notesPage.waitForFunction(
      () =>
        (document.querySelector("main")?.textContent ?? "")
          .replace(/\s+/g, "")
          .includes("buildinNotes"),
      null,
      { timeout: 30_000 },
    );
    await waitForBadge(notesPage, "not_synced");
    const notes = (await laptopApi("/api/lp/projects")).projects.find((p) => p.title === "Notes");
    expect(notes, "Notes was not created");
    await sendMessage(notesPage, "sync this to the cloud");
    await waitFor(
      "Notes to sync from chat",
      async () => (await laptopStatus(notes.id)).state === "synced",
      60_000,
    );
    await waitForBadge(notesPage, "synced");
  });

  await step("the friend joins on the cloud host and sees Synced", async () => {
    bo = await newPage(browser);
    // Ana signs in on the cloud host in her browser too, and copies her invite link.
    const anaCloud = await newPage(browser);
    await anaCloud.goto(`${CLOUD}/lp/login`);
    await anaCloud.fill("#email", email("ana"));
    await anaCloud.fill("#password", PASSWORD);
    await anaCloud.click("#submit");
    await anaCloud.waitForURL(`${CLOUD}/`, { timeout: 30_000 });
    const session = await pageApi(anaCloud, "/api/lp/session");
    expect(
      Array.isArray(session.workspaces),
      `no cloud session for Ana: ${JSON.stringify(session)}`,
    );
    expect(session.cloudHost === true, "the cloud host does not say it is one");
    const workspace = session.workspaces.find((w) => w.projectIds.includes(cloudProjectId));
    expect(workspace, "the synced project is not in Ana's cloud workspace");
    const invite = await pageApi(
      anaCloud,
      `/api/lp/workspaces/invite?workspaceId=${workspace.workspaceId}`,
    );
    await bo.goto(`${CLOUD}${invite.path}`);
    await bo.getByText("You're invited to").waitFor();
    await bo.fill("#name", "Bo");
    await bo.fill("#email", email("bo"));
    await bo.fill("#password", PASSWORD);
    await bo.click("#submit");
    await bo.waitForURL((url) => url.origin === CLOUD && !url.pathname.startsWith("/lp/"), {
      timeout: 30_000,
    });
    await bo.getByTestId("lp-workspace-switcher").waitFor({ timeout: 30_000 });
    const projects = await pageApi(bo, "/api/lp/projects");
    expect(Array.isArray(projects.projects), `no projects for Bo: ${JSON.stringify(projects)}`);
    const shared = projects.projects.find((p) => p.id === cloudProjectId);
    expect(shared && shared.synced, "Bo cannot see the synced project");
    const status = (await pageApi(bo, "/api/lp/sync/status")).projects.find(
      (p) => p.projectId === cloudProjectId,
    );
    expect(status?.state === "synced", `cloud says ${status?.state}`);
    await bo.goto(`${CLOUD}/`);
    await waitForBadge(bo, "synced");
  });

  await step(
    "owner's laptop goes off; friend's cloud agent keeps working and its edits reach GitHub",
    async () => {
      await stopServer(laptop);
      expect(!alive(laptop), "laptop server still running");
      await openProject(bo, CLOUD, PROJECT);
      await waitForBadge(bo, "synced", PROJECT);
      const MESSAGE = `cloud turn ${run}`;
      await sendMessage(bo, MESSAGE);
      await bo.waitForFunction((needle) => document.body.textContent?.includes(needle), MESSAGE, {
        timeout: 30_000,
      });
      // The replay turn finishes on the cloud host with the laptop off.
      await waitFor(
        "the cloud turn to finish",
        async () => {
          const text = await bo.locator("main").innerText();
          return !/Working for|Thinking/.test(text) && text.includes(MESSAGE);
        },
        60_000,
      );
      // The agent's edit: the replay provider does not write files, so the harness writes
      // what a real agent's Write tool would, in the cloud host's checkout.
      const projects = await pageApi(bo, "/api/lp/projects");
      expect(projects.projects.length > 0, "no projects for Bo");
      cloudRoot = NodePath.join(cloudHome, "projects");
      const checkout = NodeFS.readdirSync(cloudRoot, { recursive: true })
        .map((entry) => NodePath.join(cloudRoot, String(entry)))
        .find(
          (dir) =>
            dir.endsWith(`${NodePath.sep}.logicpacks`) &&
            NodeFS.existsSync(NodePath.join(NodePath.dirname(dir), "index.html")),
        );
      expect(checkout, `no cloud checkout of the project under ${cloudRoot}`);
      cloudRoot = NodePath.dirname(checkout);
      NodeFS.writeFileSync(
        NodePath.join(cloudRoot, "cloud-notes.md"),
        `# Written on the cloud ${run}\n`,
      );
      const bare = bareRepo();
      await waitFor(
        "the cloud host to push the edit",
        () => remoteFile(bare, "cloud-notes.md")?.includes(run),
        30_000,
      );
    },
  );

  await step("owner's laptop comes back and fetches the cloud's changes", async () => {
    laptop = startLaptop();
    await laptop.ready;
    const shells = await laptopApi("/api/lp/projects");
    expect(
      shells.projects.some((p) => p.id === projectId),
      "project gone after restart",
    );
    const status = await waitFor("the laptop to pull", async () => {
      const current = await laptopStatus(projectId);
      return current.state === "synced" && current.lastSyncedAt ? current : null;
    });
    laptopRoot = NodePath.join(laptopHome, "projects");
    const local = NodeFS.readdirSync(laptopRoot, { recursive: true })
      .map((entry) => NodePath.join(laptopRoot, String(entry)))
      .find((file) => file.endsWith(`${NodePath.sep}cloud-notes.md`));
    expect(local, "the laptop checkout did not get cloud-notes.md");
    laptopRoot = NodePath.dirname(local);
    expect(NodeFS.readFileSync(local, "utf8").includes(run), "stale cloud-notes.md");
    expect(status.behind === 0, `laptop still ${status.behind} behind`);
  });

  await step("a forced conflict is surfaced in the UI and resolved", async () => {
    const bare = bareRepo();
    let conflicted = false;
    for (let attempt = 1; attempt <= 4 && !conflicted; attempt += 1) {
      // A teammate pushes from their own clone (as with gh) while the owner edits the same line.
      const teammate = NodePath.join(root, `teammate-${attempt}`);
      git(root, "clone", "-q", bare, teammate);
      NodeFS.writeFileSync(NodePath.join(teammate, "README.md"), `teammate version ${attempt}\n`);
      git(teammate, "commit", "-qam", `Teammate edit ${attempt}`);
      git(teammate, "push", "-q", "origin", "HEAD:main");
      NodeFS.writeFileSync(NodePath.join(laptopRoot, "README.md"), `owner version ${attempt}\n`);
      conflicted = Boolean(
        await waitFor(
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
        ).then((outcome) => outcome === "conflict"),
      );
    }
    expect(conflicted, "could not force a conflict in 4 attempts");
    const status = await laptopStatus(projectId);
    expect(status.conflictFiles.includes("README.md"), `conflict files ${status.conflictFiles}`);
    await openProject(ana, LAPTOP, PROJECT);
    await waitForBadge(ana, "conflict", PROJECT);
    await ana.getByText("Sync conflict").waitFor({ timeout: 15_000 });
    await ana.getByTestId("lp-sync-keep-mine").click();
    await waitForBadge(ana, "synced", PROJECT);
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
    await openProject(bo, CLOUD, PROJECT);
    await waitForBadge(bo, "synced", PROJECT);
  });
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  await browser?.close();
  for (const server of servers) await stopServer(server);
  if (failed) {
    for (const server of servers) {
      console.log(`--- ${server.name} log tail ---\n${server.log.slice(-3000)}`);
    }
  }
  if (!keep) NodeFS.rmSync(root, { recursive: true, force: true });
  else console.log(`kept ${root}`);
}

console.log("\n| Flow | Result | Time |\n| --- | --- | --- |");
for (const result of results) {
  console.log(
    `| ${result.name} | ${result.ok ? "pass" : `FAIL: ${result.error?.split("\n")[0]}`} | ${(result.ms / 1000).toFixed(1)}s |`,
  );
}
process.exit(failed ? 1 : 0);
