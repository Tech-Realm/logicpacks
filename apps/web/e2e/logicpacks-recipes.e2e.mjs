#!/usr/bin/env node
// LogicPacks recipes end to end: `node apps/web/e2e/logicpacks-recipes.e2e.mjs [--port 3802] [--out <dir>]`.
// Needs a built web client, Chrome and Blender. The server runs as a cloud host, so Blender starts headless.
// A member on the web gets Code only; the operator creates a Blender project, opens it and drives it over MCP.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
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
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const port = Number(flag("--port") ?? 0) || 3802;
const shotsDir = flag("--out");
const base = `http://127.0.0.1:${port}`;
const repo = NodePath.join(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "../../..");
const serverDir = NodePath.join(repo, "apps/server");
const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lp-recipes-e2e-"));
const run = Date.now().toString(36);
const PASSWORD = "correct-horse-battery";
if (shotsDir) NodeFS.mkdirSync(shotsDir, { recursive: true });

const server = NodeChildProcess.spawn(
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
    env: { ...process.env, LOGICPACKS_CLOUD_HOST: "true", LOGICPACKS_SYNC_SECONDS: "0" },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  },
);
let serverLog = "";
const ready = new Promise((resolve, reject) => {
  const onData = (chunk) => {
    serverLog += chunk;
    if (serverLog.includes("server is ready")) resolve();
  };
  server.stdout.on("data", onData);
  server.stderr.on("data", onData);
  server.on("exit", (code) =>
    reject(new Error(`server exited (${code})\n${serverLog.slice(-2000)}`)),
  );
});

const cli = (...cliArgs) =>
  NodeChildProcess.execFileSync(process.execPath, ["src/bin.ts", ...cliArgs], {
    cwd: serverDir,
    encoding: "utf8",
  });
const operatorToken = () =>
  cli("auth", "session", "issue", "--base-dir", home, "--token-only").trim().split("\n").pop();
const pairingUrl = () => {
  const out = cli("auth", "pairing", "create", "--base-dir", home, "--base-url", base, "--json");
  return JSON.parse(out.slice(out.indexOf("{"))).pairUrl;
};

const results = [];
let failed = false;
async function step(name, body) {
  if (failed) {
    results.push({ name, ok: false, error: "skipped after an earlier failure" });
    return;
  }
  try {
    await body();
    results.push({ name, ok: true });
    console.log(`PASS ${name}`);
  } catch (error) {
    failed = true;
    results.push({ name, ok: false, error: String(error?.message ?? error) });
    console.log(`FAIL ${name}\n     ${String(error?.message ?? error).split("\n")[0]}`);
  }
}
const expect = (condition, message) => {
  if (!condition) throw new Error(message);
};
const shot = async (page, name) => {
  if (shotsDir) await page.screenshot({ path: NodePath.join(shotsDir, `${name}.png`) });
};

let bearer;
async function api(path, body, auth = `Bearer ${bearer}`) {
  const response = await fetch(`${base}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: auth,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

/** The project folder: the only one under the test home holding a recipe file. */
function findRecipeProject() {
  const stack = [home];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (NodeFS.existsSync(NodePath.join(dir, ".logicpacks/recipe.json"))) return dir;
    for (const entry of NodeFS.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") {
        stack.push(NodePath.join(dir, entry.name));
      }
    }
  }
  return null;
}

function bridgeCall({ port, token }, cmd) {
  return new Promise((resolve, reject) => {
    const socket = NodeNet.createConnection({ host: "127.0.0.1", port }, () =>
      socket.write(`${JSON.stringify({ id: 1, cmd, args: {}, token })}\n`),
    );
    socket.setEncoding("utf8");
    socket.once("data", (line) => {
      socket.end();
      resolve(JSON.parse(line));
    });
    socket.once("error", reject);
  });
}

let browser;
let projectDir = null;
try {
  await ready;
  bearer = operatorToken();
  browser = await chromium.launch({
    headless: true,
    channel: process.env.LP_E2E_BROWSER_CHANNEL ?? "chrome",
  });

  let ana;
  await step(
    "web: the recipe picker offers Code, and Blender only in the desktop app",
    async () => {
      const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
      ana = await context.newPage();
      await ana.goto(`${base}/lp/login`);
      await ana.click("#toggle");
      await ana.fill("#name", "Ana");
      await ana.fill("#email", `ana-${run}@example.com`);
      await ana.fill("#password", PASSWORD);
      await ana.click("#submit");
      await ana.waitForURL(`${base}/`, { timeout: 30_000 });
      await passOnboarding(ana);
      await ana.getByRole("button", { name: "Skip for now" }).click();
      const code = ana.getByTestId("lp-recipe-code");
      await code.waitFor();
      expect((await code.getAttribute("aria-checked")) === "true", "Code is not the default");
      const blender = ana.getByTestId("lp-recipe-blender");
      expect(await blender.isDisabled(), "Blender should be disabled on the web");
      expect(
        (await blender.innerText()).includes("Needs the LogicPacks desktop app"),
        "Blender does not say it needs the desktop app",
      );
      const download = ana.getByTestId("lp-recipe-download");
      expect(
        (await download.getAttribute("href")) === "https://logicpacks.io/download",
        "no desktop download link",
      );
      const text = await ana.locator("body").innerText();
      expect(text.includes("Beta: DaVinci Resolve"), "Beta apps are not listed");
      await shot(ana, "web-add-project-recipes");
    },
  );

  await step("web: a member cannot create a Blender project through the API either", async () => {
    const cookies = await ana.context().cookies();
    const cookie = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const response = await fetch(`${base}/api/lp/projects/new`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ kind: "empty", name: "Sneaky scene", recipe: "blender" }),
    });
    const body = await response.json();
    expect(response.status === 400, `expected 400, got ${response.status}`);
    expect(String(body.message).includes("desktop app"), `unexpected message ${body.message}`);
  });

  await step("web: a Code project is created as before and shows no app control", async () => {
    await ana.getByLabel("Project name").fill("Team site");
    await ana.getByTestId("lp-create-project").click();
    await ana.waitForFunction(
      () => (document.querySelector("main")?.textContent ?? "").includes("Team site"),
      null,
      { timeout: 30_000 },
    );
    await ana.getByTestId("lp-sync-badge").waitFor({ timeout: 30_000 });
    expect(
      (await ana.getByTestId("lp-recipe-desktop-cta").count()) === 0 &&
        (await ana.getByTestId("lp-recipe-open").count()) === 0,
      "a Code project shows a recipe control",
    );
  });

  let projectId;
  await step("operator: create a Blender project; its recipe is committed", async () => {
    const created = await api("/api/lp/projects/new", {
      kind: "empty",
      name: "Robot scene",
      recipe: "blender",
    });
    expect(created.status === 201, `create: ${created.status} ${JSON.stringify(created.body)}`);
    projectId = created.body.projectId;
    projectDir = findRecipeProject();
    expect(projectDir !== null, "no project folder with .logicpacks/recipe.json");
    const recipeFile = JSON.parse(
      NodeFS.readFileSync(NodePath.join(projectDir, ".logicpacks/recipe.json"), "utf8"),
    );
    expect(recipeFile.recipe === "blender", `recipe.json says ${JSON.stringify(recipeFile)}`);
    const tracked = NodeChildProcess.execFileSync("git", ["ls-files"], {
      cwd: projectDir,
      encoding: "utf8",
    });
    for (const file of [".logicpacks/recipe.json", "AGENTS.md", "CLAUDE.md", ".gitignore"]) {
      expect(tracked.includes(file), `${file} is not in git`);
    }
    const status = await api(`/api/lp/projects/recipe?projectId=${projectId}`);
    expect(status.body.recipeId === "blender", `recipe ${JSON.stringify(status.body)}`);
    expect(status.body.app?.installed === true, "Blender is not detected");
    expect(status.body.app?.running === false, "Blender should not be running yet");
  });

  await step("operator: Open Blender starts it with the bridge and saves the scene", async () => {
    const launched = await api("/api/lp/recipes/launch", { projectId });
    expect(launched.status === 200, `launch ${launched.status} ${JSON.stringify(launched.body)}`);
    expect(launched.body.running === true, "launch did not report running");
    const status = await api(`/api/lp/projects/recipe?projectId=${projectId}`);
    expect(status.body.app?.running === true, "status does not say running");
    expect(NodeFS.existsSync(NodePath.join(projectDir, "scene.blend")), "scene.blend not saved");
    const again = await api("/api/lp/recipes/launch", { projectId });
    expect(again.body.alreadyRunning === true, "a second open started another Blender");
  });

  await step("an agent's MCP server from .mcp.json edits the scene and logs it", async () => {
    const mcpConfig = JSON.parse(
      NodeFS.readFileSync(NodePath.join(projectDir, ".mcp.json"), "utf8"),
    );
    const local = JSON.parse(
      NodeFS.readFileSync(NodePath.join(projectDir, ".claude/settings.local.json"), "utf8"),
    );
    expect(local.enabledMcpjsonServers.includes("logicpacks-blender"), "server not allowed");
    const entry = mcpConfig.mcpServers["logicpacks-blender"];
    const mcp = NodeChildProcess.spawn(entry.command, entry.args, {
      cwd: projectDir,
      stdio: ["pipe", "pipe", "inherit"],
      env: { ...process.env, ...entry.env, LP_RECIPE_AGENT_ID: "agent-e2e" },
    });
    const replies = new Map();
    NodeReadline.createInterface({ input: mcp.stdout }).on("line", (line) => {
      const message = JSON.parse(line);
      replies.get(message.id)?.(message);
    });
    let id = 0;
    const rpc = (method, params = {}) =>
      new Promise((resolve) => {
        id += 1;
        replies.set(id, resolve);
        mcp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
    const added = await rpc("tools/call", {
      name: "blender_add_object",
      arguments: { primitive: "cone", name: "Antenna", location: [0, 0, 2] },
    });
    expect(!added.result?.isError, `add failed: ${JSON.stringify(added.result)}`);
    const log = await rpc("tools/call", { name: "blender_export_oplog", arguments: {} });
    const ops = JSON.parse(log.result.content[0].text).ops;
    expect(
      ops.some((op) => op.name === "Antenna" && op.actor.id === "agent-e2e"),
      "the op log does not credit the agent's edit",
    );
    mcp.kill();
  });

  await step(
    "operator: the app view renders the headless scene and credits the agent",
    async () => {
      const view = await api(`/api/lp/recipes/view?projectId=${projectId}&width=640`);
      expect(view.status === 200, `view ${view.status} ${JSON.stringify(view.body).slice(0, 300)}`);
      expect(view.body.running === true, "view says Blender is not running");
      expect(view.body.mode === "render", `headless view mode ${view.body.mode}`);
      const png = Buffer.from(view.body.image ?? "", "base64");
      expect(png.subarray(1, 4).toString() === "PNG", `no PNG frame: ${view.body.imageError}`);
      if (shotsDir) NodeFS.writeFileSync(NodePath.join(shotsDir, "blender-view.png"), png);
      const antenna = view.body.objects.find((object) => object.name === "Antenna");
      expect(antenna?.last?.actor?.id === "agent-e2e", `outline: ${JSON.stringify(antenna)}`);
      const cookies = await ana.context().cookies();
      const member = await fetch(`${base}/api/lp/recipes/view?projectId=${projectId}`, {
        headers: { cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; ") },
      });
      expect(member.status === 404 || member.status === 409, `member got ${member.status}`);
    },
  );

  await step("web: the operator's browser shows the Blender project's desktop chip", async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const page = await context.newPage();
    const url = pairingUrl();
    await page.goto(url);
    await page
      .waitForURL((next) => !next.pathname.startsWith("/pair"), { timeout: 30_000 })
      .catch(async (error) => {
        await shot(page, "debug-pair");
        throw new Error(
          `${error.message} at ${page.url()} (from ${url}): ${(await page.locator("body").innerText()).slice(0, 300)}`,
        );
      });
    // Pairing lands on home, which opens a draft in the newest project.
    await page.waitForFunction(
      () => (document.querySelector("main")?.textContent ?? "").includes("Robot scene"),
      null,
      { timeout: 30_000 },
    );
    const chip = page.getByTestId("lp-recipe-desktop-cta");
    await chip.waitFor({ timeout: 30_000 });
    expect((await chip.innerText()).includes("Blender"), "chip does not name Blender");
    await shot(page, "web-blender-project-header");
  });
} finally {
  if (projectDir) {
    const info = NodePath.join(projectDir, ".logicpacks/blender/main/bridge.json");
    if (NodeFS.existsSync(info)) {
      await bridgeCall(JSON.parse(NodeFS.readFileSync(info, "utf8")), "quit").catch(
        () => undefined,
      );
    }
  }
  await browser?.close().catch(() => undefined);
  try {
    process.kill(-server.pid, "SIGTERM");
  } catch {
    // Already gone.
  }
  await new Promise((resolve) => setTimeout(resolve, 1500));
  NodeFS.rmSync(home, { recursive: true, force: true });
}
const passed = results.filter((result) => result.ok).length;
console.log(`${passed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
