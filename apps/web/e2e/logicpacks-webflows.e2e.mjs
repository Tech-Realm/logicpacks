#!/usr/bin/env node
// Web flows on a cloud host, end to end:
//   node apps/web/e2e/logicpacks-webflows.e2e.mjs [--port 3871] [--web-port 5871] [--shots <dir>] [--keep]
// One cloud host from this tree and the Vite dev client in front of it (no production build).
// The agent is the scripted ACP mock (lp-ledger-mock-agent.mjs); GitHub is a folder of bare repos.
//   1 a member signs up, makes a project and runs a turn
//   2 the details rail (Machine, Branch, Lineage) hides from its chevron, stays hidden after a
//     reload and in other threads, and comes back from the header toggle
//   3 Upload button: two files into a folder; the same file again asks, keep both; a file over the
//     host's limit is refused
//   4 a folder dropped on the file tree uploads with its structure and shows in the tree
//   5 the agent lists the uploaded files from its checkout
//   6 Get it on your computer: a project not on GitHub offers Make it synced and the zip; the zip
//     holds the uploads
//   7 Make it synced: the dialog turns into lp clone / git clone with the host's pull interval
//   8 lp clone into a temp HOME, edit, commit, push: the host pulls it
//   9 the signed-in sidebar has no demo links
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
const webPort = Number(option("--web-port", 5871));
const keep = args.includes("--keep");
const shotsDir = option("--shots", null);
const WEB = `http://127.0.0.1:${webPort}`;
const SERVER = `http://127.0.0.1:${port}`;
const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const repo = NodePath.join(here, "../../..");
const serverDir = NodePath.join(repo, "apps/server");
const webDir = NodePath.join(repo, "apps/web");
const helperCli = NodePath.join(repo, "packages/helper/src/cli.ts");
const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lp-webflows-e2e-"));
if (shotsDir) NodeFS.mkdirSync(shotsDir, { recursive: true });
const run = Date.now().toString(36).slice(-6);
const PASSWORD = "correct-horse-battery";
const SYNC_SECONDS = 3;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── Host ────────────────────────────────────────────────────────────────────
const home = NodePath.join(root, "host");
const remotes = NodePath.join(root, "remotes");
NodeFS.mkdirSync(NodePath.join(home, "userdata"), { recursive: true });
NodeFS.mkdirSync(remotes, { recursive: true });
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

// Files to upload, made on "the computer".
const desk = NodePath.join(root, "desk");
const put = (relative, text) => {
  const file = NodePath.join(desk, relative);
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
  NodeFS.writeFileSync(file, text);
  return file;
};
const logo = put("logo.svg", "<svg xmlns='http://www.w3.org/2000/svg'/>");
const notes = put("notes.txt", "first notes\n");
const big = put("big.bin", "x".repeat(1024 * 1024 + 10));

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
const zipNames = (file) =>
  NodeChildProcess.execFileSync("unzip", ["-Z1", file], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
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
/** The file tree's text, through its open shadow roots. */
const treeText = (page) =>
  page.evaluate(() => {
    const parts = [];
    const visit = (node) => {
      if (node.nodeType === Node.TEXT_NODE) parts.push(node.textContent.trim());
      // Rows can carry their path in attributes (aria-label, data-*) rather than text.
      if (node.nodeType === Node.ELEMENT_NODE) {
        for (const attribute of node.attributes) {
          if (/label|path|name|title/i.test(attribute.name)) parts.push(attribute.value);
        }
      }
      if (node.shadowRoot) visit(node.shadowRoot);
      for (const child of node.childNodes ?? []) visit(child);
    };
    visit(document.querySelector("[data-lp-upload-drop]") ?? document.body);
    return parts.filter(Boolean).join(" ");
  });
const rail = (page) => page.locator('[data-thread-details-panel="inline"]');
const helper = (helperHome, cwd, ...helperArgs) =>
  NodeChildProcess.spawnSync(process.execPath, [helperCli, ...helperArgs], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: helperHome,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
    timeout: 120_000,
  });

let browser;
try {
  const env = {
    ...process.env,
    LOGICPACKS_CLOUD_HOST: "true",
    // Cloud workspaces (coming soon without a code) are not under test here.
    LOGICPACKS_MEMBER_FEATURES: "cloud",
    LOGICPACKS_MEMBERS_OWN_PROVIDERS: "false",
    LOGICPACKS_SYNC_SECONDS: String(SYNC_SECONDS),
    LOGICPACKS_SYNC_REMOTE_ROOT: remotes,
    LOGICPACKS_UPLOAD_MAX_MB: "1",
    LP_MOCK_LOG: NodePath.join(root, "mock-agent.log"),
    LP_E2E_RUN: run,
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
  browser = await chromium.launch({
    headless: true,
    channel: process.env.LP_E2E_BROWSER_CHANNEL ?? "chrome",
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true,
    colorScheme: "dark",
  });
  const page = await context.newPage();
  pages.push(page);
  const PROJECT = `Team site ${run}`;
  let projectId;
  let projectRoot;

  await step("1 a member signs up, makes a project and runs a turn", async () => {
    await page.goto(`${WEB}/lp/login`);
    await page.click("#tab-signup");
    await page.fill("#name", "Test");
    await page.fill("#email", `test-${run}@example.com`);
    await page.fill("#password", PASSWORD);
    await page.click("#submit");
    await page.waitForURL((url) => url.origin === WEB && !url.pathname.startsWith("/lp/"), {
      timeout: 60_000,
    });
    const created = await pageApi(page, "/api/lp/projects/new", { kind: "empty", name: PROJECT });
    expect(created.projectId, `project not created: ${JSON.stringify(created)}`);
    projectId = created.projectId;
    await openProject(page, PROJECT);
    const prompt = "Build index.html";
    await sendMessage(page, prompt);
    await waitForReply(page, "Done.", prompt);
    await rail(page).waitFor({ timeout: 30_000 });
    await shot(page, "01-thread-with-details-rail");
  });

  await step("2 the details rail hides, stays hidden after a reload, and comes back", async () => {
    const chevron = page.locator("[data-thread-details-collapse]");
    await chevron.hover();
    await shot(page, "02-rail-chevron-tooltip");
    await chevron.click();
    await rail(page).waitFor({ state: "detached", timeout: 10_000 });
    await shot(page, "03-rail-hidden");
    await page.reload();
    await page.locator('[contenteditable="true"]').first().waitFor({ timeout: 60_000 });
    await sleep(1500);
    expect((await rail(page).count()) === 0, "the rail came back after a reload");
    const toggle = page.getByRole("button", { name: "Toggle thread details panel" }).first();
    await toggle.hover();
    await shot(page, "04-header-toggle-tooltip");
    await toggle.click();
    await rail(page).waitFor({ timeout: 10_000 });
    await page.keyboard.press("ControlOrMeta+Shift+B");
    await rail(page).waitFor({ state: "detached", timeout: 10_000 });
    await page.keyboard.press("ControlOrMeta+Shift+B");
    await rail(page).waitFor({ timeout: 10_000 });
  });

  await step("3 Upload button: files into a folder, a conflict, and the size limit", async () => {
    await page.getByTestId("lp-upload-open").click();
    const dialog = page.getByTestId("lp-upload-dialog");
    await dialog.waitFor();
    await page.getByLabel("Upload folder").fill("assets");
    await page.getByTestId("lp-upload-files-input").setInputFiles([logo, notes]);
    await shot(page, "05-upload-dialog-chosen");
    await page.getByTestId("lp-upload-start").click();
    await waitFor("two uploads done", async () =>
      (await dialog.locator('[data-state="done"]').count()) === 2 ? true : null,
    );
    await shot(page, "06-upload-done");
    // Same file again: Ask me (default) asks, Keep both writes notes (1).txt.
    await page.getByTestId("lp-upload-files-input").setInputFiles([notes]);
    await page.getByTestId("lp-upload-start").click();
    await page.getByTestId("lp-upload-conflict").waitFor({ timeout: 15_000 });
    await shot(page, "07-upload-conflict");
    await page
      .getByTestId("lp-upload-conflict")
      .getByRole("button", { name: "Keep both", exact: true })
      .click();
    await waitFor("kept both", async () =>
      (await dialog.locator('[data-path="assets/notes (1).txt"][data-state="done"]').count()) === 1
        ? true
        : null,
    );
    // Over the 1 MB limit: refused before it is sent.
    await page.getByTestId("lp-upload-files-input").setInputFiles([big]);
    await page.getByTestId("lp-upload-start").click();
    await waitFor("size refused", async () =>
      /limit/.test(
        (await dialog
          .locator('[data-state="failed"]')
          .first()
          .innerText()
          .catch(() => "")) ?? "",
      )
        ? true
        : null,
    );
    await shot(page, "08-upload-size-limit");
    // The server enforces it too.
    const direct = await page.evaluate(
      async ([projectId]) => {
        const response = await fetch(
          `/api/lp/projects/upload?projectId=${encodeURIComponent(projectId)}&path=huge.bin&conflict=fail`,
          { method: "POST", credentials: "include", body: new Uint8Array(1024 * 1024 + 5) },
        );
        return response.status;
      },
      [projectId],
    );
    expect(direct === 413, `server took an oversized upload (${direct})`);
    const escape = await page.evaluate(
      async ([projectId]) =>
        (
          await fetch(
            `/api/lp/projects/upload?projectId=${encodeURIComponent(projectId)}&path=../escape.txt`,
            { method: "POST", credentials: "include", body: "x" },
          )
        ).status,
      [projectId],
    );
    expect(escape === 400, `a path outside the project was accepted (${escape})`);
    await page.keyboard.press("Escape");
  });

  await step("4 a folder dropped on the file tree uploads and shows in the tree", async () => {
    await page.locator("[data-right-panel-toggle]").first().click();
    const filesTab = page
      .getByRole("button", { name: /^Files/ })
      .or(page.getByRole("menuitem", { name: /^Files/ }));
    if (
      await filesTab
        .first()
        .isVisible()
        .catch(() => false)
    )
      await filesTab.first().click();
    const tree = page.locator("[data-lp-upload-drop]");
    await tree.waitFor({ timeout: 30_000 });
    await shot(page, "09-file-tree-with-upload");
    await page.evaluate(() => {
      const target = document.querySelector("[data-lp-upload-drop]");
      const transfer = new DataTransfer();
      const make = (path, text) => {
        const file = new File([text], path.split("/").at(-1), { type: "text/plain" });
        Object.defineProperty(file, "webkitRelativePath", { value: path });
        transfer.items.add(file);
      };
      make("drop-folder/readme.md", "# dropped\n");
      make("drop-folder/img/a.txt", "a\n");
      for (const type of ["dragenter", "dragover", "drop"]) {
        target.dispatchEvent(
          new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }),
        );
      }
    });
    const dialog = page.getByTestId("lp-upload-dialog");
    await dialog.waitFor({ timeout: 15_000 });
    await waitFor("the dropped files listed", async () =>
      /2 files/.test(await page.getByTestId("lp-upload-summary").innerText()) ? true : null,
    );
    await shot(page, "10-drop-prefilled-dialog");
    await page.getByTestId("lp-upload-start").click();
    await waitFor("dropped uploads done", async () =>
      (await dialog.locator('[data-state="done"]').count()) === 2 ? true : null,
    );
    await page.keyboard.press("Escape");
    await waitFor("drop-folder in the tree", async () => {
      const text = await treeText(page);
      if (!text.includes("drop-folder")) throw new Error(`tree: ${text.slice(0, 300)}`);
      return true;
    });
    await shot(page, "11-tree-shows-upload");
  });

  await step("5 the agent lists the uploaded files from its checkout", async () => {
    const prompt = "list files please";
    await sendMessage(page, prompt);
    const reply = await waitForReply(page, "FILES:", prompt);
    for (const name of [
      "assets/logo.svg",
      "assets/notes (1).txt",
      "drop-folder/img/a.txt",
      "drop-folder/readme.md",
    ]) {
      expect(reply.includes(name), `the agent did not see ${name}`);
    }
    await shot(page, "12-agent-lists-uploads");
  });

  await step("6 Get it on your computer: not synced yet, the zip holds the uploads", async () => {
    await page.getByTestId("lp-get-local-open").click();
    const dialog = page.getByTestId("lp-get-local");
    await dialog.waitFor();
    await page.getByTestId("lp-get-local-sync").waitFor({ timeout: 15_000 });
    expect((await page.getByTestId("lp-open-on-mac").count()) === 0, "Mac link without GitHub");
    await shot(page, "13-get-local-not-synced");
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 30_000 }),
      page.getByTestId("lp-download-zip").click(),
    ]);
    const zipFile = NodePath.join(root, "download.zip");
    await download.saveAs(zipFile);
    const names = zipNames(zipFile);
    for (const name of ["assets/logo.svg", "drop-folder/readme.md"]) {
      expect(
        names.some((entry) => entry.endsWith(`/${name}`)),
        `zip lacks ${name}: ${names.join(", ")}`,
      );
    }
    expect(!names.some((entry) => entry.includes("/.git/")), "zip holds .git");
  });

  await step("7 Make it synced turns the dialog into clone commands", async () => {
    await page.getByTestId("lp-get-local-sync").click();
    await page.getByTestId("lp-clone-command").waitFor({ timeout: 90_000 });
    const text = await page.getByTestId("lp-get-local").innerText();
    expect(/lp clone/.test(text), "no lp clone");
    expect(/git clone/.test(text), "no git clone");
    const description = await page.getByRole("dialog").innerText();
    expect(
      description.includes(`within ${SYNC_SECONDS} seconds`),
      `no pull interval line: ${description.slice(0, 300)}`,
    );
    await shot(page, "14-get-local-synced");
    await page.keyboard.press("Escape");
    const local = await pageApi(page, `/api/lp/projects/local?projectId=${projectId}`);
    expect(local.synced && local.cloneUrl, `not synced: ${JSON.stringify(local)}`);
  });

  await step("8 lp clone, edit, push: the host pulls it", async () => {
    const issued = await pageApi(page, "/api/lp/helper/token", { device: "e2e laptop" });
    expect(issued.token, `no helper token: ${JSON.stringify(issued)}`);
    const helperHome = NodePath.join(root, "laptop-home");
    const work = NodePath.join(root, "laptop-work");
    NodeFS.mkdirSync(helperHome, { recursive: true });
    NodeFS.mkdirSync(work, { recursive: true });
    const login = helper(
      helperHome,
      work,
      "login",
      "--server",
      SERVER,
      "--token",
      issued.token,
      "--no-mcp",
    );
    expect(login.status === 0, `lp login: ${login.stdout}${login.stderr}`);
    const cloned = helper(helperHome, work, "clone", PROJECT, "site");
    expect(cloned.status === 0, `lp clone: ${cloned.stdout}${cloned.stderr}`);
    expect(
      /host pulls your pushes within 3 seconds/.test(cloned.stdout),
      `clone output: ${cloned.stdout}`,
    );
    const site = NodePath.join(work, "site");
    expect(NodeFS.existsSync(NodePath.join(site, "assets/logo.svg")), "clone lacks the uploads");
    NodeFS.writeFileSync(NodePath.join(site, "from-laptop.txt"), `pushed ${run}\n`);
    const git = (...gitArgs) =>
      NodeChildProcess.execFileSync(
        "git",
        ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...gitArgs],
        {
          cwd: site,
          encoding: "utf8",
        },
      );
    git("add", "from-laptop.txt");
    git("commit", "-qm", "From the laptop");
    git("push", "-q");
    const local = await pageApi(page, `/api/lp/projects/local?projectId=${projectId}`);
    projectRoot = local.title;
    await waitFor(
      "the host pulled the push",
      async () => {
        const reply = await page.evaluate(
          async ([projectId]) => {
            const response = await fetch(
              `/api/lp/projects/zip?projectId=${encodeURIComponent(projectId)}`,
              {
                credentials: "include",
              },
            );
            const bytes = new Uint8Array(await response.arrayBuffer());
            return new TextDecoder("latin1").decode(bytes).includes("from-laptop.txt");
          },
          [projectId],
        );
        return reply;
      },
      60_000,
    );
    console.log(`     ${cloned.stdout.trim().split("\n").at(-2)}`);
  });

  await step("9 the signed-in sidebar has no demo links", async () => {
    await page.goto(`${WEB}/`);
    await page.locator('[contenteditable="true"]').first().waitFor({ timeout: 60_000 });
    expect((await page.getByTestId("any-app-demo-entry").count()) === 0, "Any app demo link");
    expect((await page.getByTestId("packs-demo-entry").count()) === 0, "Packs demo link");
    expect((await page.getByText("Beta", { exact: true }).count()) === 0, "Beta group");
    await shot(page, "15-sidebar-no-demos");
  });
  void projectRoot;
} catch (error) {
  failed = true;
  console.log(`FAIL setup\n     ${String(error?.message ?? error)}`);
} finally {
  await browser?.close().catch(() => undefined);
  await stopAll();
  if (!keep) NodeFS.rmSync(root, { recursive: true, force: true });
  else console.log(`kept ${root}`);
}

const passed = results.filter((result) => result.ok).length;
console.log(`\n${passed}/${results.length} steps passed`);
for (const result of results) {
  console.log(
    `${result.ok ? "ok  " : "FAIL"} ${result.name} (${result.ms} ms)${result.error ? `\n     ${result.error}` : ""}`,
  );
}
process.exit(failed || passed !== results.length ? 1 : 0);
