#!/usr/bin/env node
// Cross-thread context E2E: `node apps/web/e2e/logicpacks-crossthread.e2e.mjs [--port 3841] [--keep]
//   [--shots <dir>] [--codex]`.
// One cloud host from this tree, two browser profiles (Ana owns the workspace, Ali joins it), a
// scripted ACP agent (lp-ledger-mock-agent.mjs) that uses the real ledger MCP tools, and a REAL
// private GitHub repository named lp-e2e-<id> created through the product's own Sync (gh). Ali's
// conflicting push comes from his own clone. Afterwards the repository is deleted when the gh token
// has delete_repo, otherwise archived. `--codex` adds a real `codex exec` turn through `lp mcp`.
// Needs a built web client (apps/web/dist), gh signed in, and Playwright's Chromium.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import * as NodeURL from "node:url";

const require = NodeModule.createRequire(import.meta.url);
const { chromium } = require("playwright");

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : (args[index + 1] ?? fallback);
};
const port = Number(option("--port", 3841));
const keep = args.includes("--keep");
const withCodex = args.includes("--codex");
const shotsDir = option("--shots", null);
const HOST = `http://127.0.0.1:${port}`;
const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const repo = NodePath.join(here, "../../..");
const serverDir = NodePath.join(repo, "apps/server");
const helperCli = NodePath.join(repo, "packages/helper/src/cli.ts");
const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lp-crossthread-e2e-"));
if (shotsDir) NodeFS.mkdirSync(shotsDir, { recursive: true });
const run = Date.now().toString(36).slice(-6);
const REPO = `lp-e2e-${run}`;
const email = (name) => `${name}-${run}@example.com`;
const PASSWORD = "correct-horse-battery";
const mockLog = NodePath.join(root, "mock-agent.log");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sh = (command, commandArgs, options = {}) =>
  NodeChildProcess.execFileSync(command, commandArgs, { encoding: "utf8", ...options }).trim();
const git = (cwd, ...gitArgs) => sh("git", gitArgs, { cwd });
const aliGit = (cwd, ...gitArgs) =>
  sh("git", ["-c", "user.name=Ali", "-c", "user.email=ali@example.com", ...gitArgs], { cwd });

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

let server;
function startServer() {
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
        LOGICPACKS_CLOUD_HOST: "true",
        LOGICPACKS_MEMBERS_OWN_PROVIDERS: "false",
        LOGICPACKS_SYNC_SECONDS: "2",
        LP_MOCK_LOG: mockLog,
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    },
  );
  const started = { child, log: "" };
  started.ready = new Promise((resolve, reject) => {
    const onData = (chunk) => {
      started.log += chunk;
      if (started.log.length > 400_000) started.log = started.log.slice(-200_000);
      if (started.log.includes("server is ready")) resolve();
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code) =>
      reject(new Error(`server exited (${code})\n${started.log.slice(-2000)}`)),
    );
  });
  return started;
}
async function stopServer() {
  if (!server) return;
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    try {
      process.kill(-server.child.pid, signal);
    } catch {
      return;
    }
    for (let waited = 0; waited < 6_000; waited += 200) {
      try {
        process.kill(-server.child.pid, 0);
      } catch {
        return;
      }
      await sleep(200);
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
async function signUp(page, name) {
  await page.goto(`${HOST}/lp/login`);
  await page.click("#toggle");
  await page.fill("#name", name);
  await page.fill("#email", email(name.toLowerCase()));
  await page.fill("#password", PASSWORD);
  await page.click("#submit");
  await page.waitForURL(`${HOST}/`, { timeout: 30_000 });
}
/** Opens a new draft in the project through the draft heading's project picker. */
async function openProject(page, title) {
  await page.goto(`${HOST}/`);
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
        .includes(`buildin${name}`),
    title.replace(/\s+/g, ""),
    { timeout: 30_000 },
  );
}
async function sendMessage(page, text) {
  const composer = page.locator('[contenteditable="true"]').first();
  await composer.waitFor({ timeout: 30_000 });
  await composer.click();
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
}
/** Waits until the open thread shows `needle` outside the user's own message and is idle. */
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
const mockEntries = () =>
  NodeFS.existsSync(mockLog)
    ? NodeFS.readFileSync(mockLog, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
const projectLedger = (page, projectId) =>
  pageApi(page, `/api/lp/ledger/project?projectId=${encodeURIComponent(projectId)}`);
const threadLedger = (page, threadId) =>
  pageApi(page, `/api/lp/ledger/thread?threadId=${encodeURIComponent(threadId)}`);
const threadOf = (ledger, name) =>
  ledger.threads?.find(
    (thread) => thread.members?.some((member) => member.name === name) && !thread.branchedFrom,
  );
const syncStatus = async (page, projectId) =>
  (await pageApi(page, "/api/lp/sync/status")).projects?.find((p) => p.projectId === projectId);

let ghLogin = null;
let repoCreated = false;
const remoteReadme = (ref = "main") => {
  try {
    return Buffer.from(
      sh("gh", [
        "api",
        `repos/${ghLogin}/${REPO}/contents/README.md?ref=${ref}`,
        "--jq",
        ".content",
      ]),
      "base64",
    ).toString("utf8");
  } catch {
    return null;
  }
};

/** A JSON-RPC client for `lp mcp` over stdio. */
function startMcp(cwd, env) {
  const child = NodeChildProcess.spawn(
    process.execPath,
    [helperCli, "mcp", "--source", "codex", "--no-agents-md"],
    {
      cwd,
      env: { ...process.env, ...env },
    },
  );
  const lines = NodeReadline.createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  let id = 0;
  return {
    child,
    call: async (method, params) => {
      id += 1;
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      return JSON.parse(String((await lines.next()).value));
    },
  };
}

let browser;
try {
  ghLogin = sh("gh", ["api", "user", "--jq", ".login"]);
  server = startServer();
  await server.ready;
  browser = await chromium.launch({ headless: true });

  let ana;
  let ali;
  let projectId;
  let anaThread;
  let aliThread;
  let aliClone;
  let negotiationId;
  let aliHelperHome;

  await step(
    `1 Ana signs up and syncs ${REPO} to a new private GitHub repo; Ali joins`,
    async () => {
      ana = await newPage(browser);
      await signUp(ana, "Ana");
      const created = await pageApi(ana, "/api/lp/projects/new", {
        kind: "template",
        name: REPO,
        template: "website",
      });
      expect(created.projectId, `project not created: ${JSON.stringify(created)}`);
      projectId = created.projectId;
      const started = await pageApi(ana, "/api/lp/sync/start", { projectId });
      expect(started.httpStatus === 202, `sync start: ${JSON.stringify(started)}`);
      repoCreated = true;
      const status = await waitFor(
        "the project to sync",
        async () => {
          const current = await syncStatus(ana, projectId);
          if (current?.state === "error") throw new Error(current.message);
          return current?.state === "synced" ? current : null;
        },
        120_000,
      );
      const view = JSON.parse(
        sh("gh", ["repo", "view", `${ghLogin}/${REPO}`, "--json", "name,visibility,url"]),
      );
      expect(
        view.name === REPO && view.visibility === "PRIVATE",
        `GitHub repo: ${JSON.stringify(view)}`,
      );
      expect(remoteReadme() !== null, "README.md is not on GitHub");
      const session = await pageApi(ana, "/api/lp/session");
      const workspace = session.workspaces.find((w) => w.projectIds.includes(projectId));
      expect(workspace, "the project is not in Ana's workspace");
      const invite = await pageApi(
        ana,
        `/api/lp/workspaces/invite?workspaceId=${workspace.workspaceId}`,
      );
      ali = await newPage(browser);
      await ali.goto(`${HOST}${invite.path}`);
      await ali.getByText("You're invited to").waitFor();
      await ali.fill("#name", "Ali");
      await ali.fill("#email", email("ali"));
      await ali.fill("#password", PASSWORD);
      await ali.click("#submit");
      await ali.waitForURL((url) => url.origin === HOST && !url.pathname.startsWith("/lp/"), {
        timeout: 30_000,
      });
      const projects = await pageApi(ali, "/api/lp/projects");
      expect(
        projects.projects?.some((p) => p.id === projectId),
        "Ali cannot see the project",
      );
      console.log(`     repo ${view.url} (branch ${status.branch})`);
    },
  );

  await step("2 each person works in their own thread; the ledger knows both", async () => {
    await openProject(ana, REPO);
    const anaPrompt = "Rewrite the hero copy for the bakery homepage";
    await sendMessage(ana, anaPrompt);
    await waitForReply(ana, "Done.", anaPrompt);
    await openProject(ali, REPO);
    const aliPrompt = "Build the newsletter signup form";
    await sendMessage(ali, aliPrompt);
    await waitForReply(ali, "Done.", aliPrompt);
    const ledger = await waitFor("both threads in the ledger", async () => {
      const view = await projectLedger(ana, projectId);
      return threadOf(view, "Ana") && threadOf(view, "Ali") ? view : null;
    });
    anaThread = threadOf(ledger, "Ana");
    aliThread = threadOf(ledger, "Ali");
    expect(/newsletter/i.test(aliThread.goal ?? ""), `Ali's goal: ${aliThread.goal}`);
    expect(
      aliThread.agent?.name === "Ali's agent",
      `Ali's agent: ${JSON.stringify(aliThread.agent)}`,
    );
    // Ali's second turn carried the live summary of Ana's thread.
    const aliTurn = mockEntries()
      .filter((entry) => entry.userText?.includes(aliPrompt))
      .at(-1);
    expect(aliTurn?.ledger?.includes("Ana"), `Ali's agent saw no ledger: ${aliTurn?.ledger}`);
  });

  await step(
    "3 'what is Ali working on' is answered from the ledger; the popover lists his thread",
    async () => {
      const prompt = "what is Ali working on?";
      await sendMessage(ana, prompt);
      const reply = await waitForReply(ana, "LEDGER ANSWER", prompt);
      expect(/newsletter/i.test(reply), `answer: ${reply.slice(-400)}`);
      await ana.getByTestId("lp-ledger-open").click();
      await ana.getByTestId("lp-ledger-popover").waitFor();
      const rows = await ana.getByTestId("lp-ledger-thread").allInnerTexts();
      expect(
        rows.some((row) => row.includes("Ali") && /newsletter/i.test(row)),
        `popover rows: ${JSON.stringify(rows)}`,
      );
      await shot(ana, "03-who-is-working-popover");
      await ana.keyboard.press("Escape");
    },
  );

  await step(
    "4 'tell Ali to …' lands in Ali's thread and agent; his reply routes back to Ana",
    async () => {
      const prompt = "tell Ali to work on the footer links next";
      await sendMessage(ana, prompt);
      await waitForReply(ana, "Sent to Ali", prompt);
      await ali
        .getByTestId("lp-notice-text")
        .filter({ hasText: "footer links" })
        .first()
        .waitFor({ timeout: 30_000 });
      await shot(ali, "04a-ali-notice");
      const replyPrompt = "reply: will do the footer after the form";
      await sendMessage(ali, replyPrompt);
      await waitForReply(ali, "Replied to", replyPrompt);
      const aliTurn = mockEntries()
        .filter((entry) => entry.userText?.includes(replyPrompt))
        .at(-1);
      expect(
        aliTurn?.ledger?.includes("footer links"),
        `Ali's agent did not get the message: ${aliTurn?.ledger}`,
      );
      await ana
        .getByTestId("lp-notice-text")
        .filter({ hasText: "will do the footer" })
        .first()
        .waitFor({ timeout: 30_000 });
      expect(
        (await ana.locator('[data-testid="lp-notice"][data-kind="reply"]').count()) > 0,
        "the answer is not a reply",
      );
      await shot(ana, "04b-ana-reply");
    },
  );

  await step(
    "5 a real conflict on README.md (Ali's push vs Ana's agent) notifies both threads",
    async () => {
      const remoteUrl = sh("gh", [
        "repo",
        "view",
        `${ghLogin}/${REPO}`,
        "--json",
        "url",
        "--jq",
        ".url",
      ]);
      aliClone = NodePath.join(root, "ali-laptop");
      git(root, "clone", "-q", `${remoteUrl}.git`, aliClone);
      let conflicted = false;
      for (let attempt = 1; attempt <= 3 && !conflicted; attempt += 1) {
        // Ana's agent edits README.md and holds its turn open, so sync cannot commit yet.
        const prompt = `edit README.md # Ana's heading ${attempt}: fresh bread daily (hold 8s)`;
        await sendMessage(ana, prompt);
        await waitFor(
          "Ana's edit on disk",
          () => mockEntries().some((e) => e.userText?.includes(`Ana's heading ${attempt}`)),
          30_000,
        );
        // Meanwhile Ali pushes his own README.md from his laptop.
        aliGit(aliClone, "pull", "-q", "--rebase");
        NodeFS.writeFileSync(
          NodePath.join(aliClone, "README.md"),
          `# Ali's heading ${attempt}: open on Sundays\n`,
        );
        aliGit(aliClone, "commit", "-qam", `Ali's README ${attempt}`);
        aliGit(aliClone, "push", "-q", "origin", "HEAD");
        const midTurn = await syncStatus(ana, projectId);
        console.log(
          `     attempt ${attempt}: after Ali's push the host says ${midTurn?.state} (${midTurn?.message ?? ""})`,
        );
        conflicted = await waitFor(
          "a conflict or a clean sync",
          async () => {
            const status = await syncStatus(ana, projectId);
            if (status?.state === "conflict") return "conflict";
            return status?.state === "synced" &&
              remoteReadme()?.includes(`Ana's heading ${attempt}`)
              ? "clean"
              : null;
          },
          60_000,
        ).then((outcome) => outcome === "conflict");
      }
      expect(conflicted, "could not force a conflict in 3 attempts");
      const status = await syncStatus(ana, projectId);
      expect(status.conflictFiles.includes("README.md"), `conflict files ${status.conflictFiles}`);
      for (const [page, name] of [
        [ana, "Ana"],
        [ali, "Ali"],
      ]) {
        const card = page.getByTestId("lp-conflict-card").filter({ hasText: "README.md" });
        await card
          .first()
          .waitFor({ timeout: 30_000 })
          .catch(() => {
            throw new Error(`${name} sees no conflict card`);
          });
      }
      const anaView = await threadLedger(ana, anaThread.threadId);
      const conflict = anaView.conflicts?.[0];
      expect(
        conflict?.parties?.some((p) => p.threadId === aliThread.threadId),
        `parties: ${JSON.stringify(conflict?.parties)}`,
      );
      expect(/Ali/.test(conflict?.reason ?? ""), `reason: ${conflict?.reason}`);
      await shot(ana, "05a-ana-conflict");
      await shot(ali, "05b-ali-conflict");
    },
  );

  await step("6 Merge both starts a negotiation; agents insist; both users are asked", async () => {
    await ana.getByTestId("lp-conflict-merge").first().click();
    const awaiting = async (page) =>
      (await page
        .getByTestId("lp-negotiation-card")
        .first()
        .getAttribute("data-state")
        .catch(() => null)) === "awaiting_humans";
    await waitFor(
      "both users to be asked",
      async () => (await awaiting(ana)) && (await awaiting(ali)),
      90_000,
    );
    const anaView = await threadLedger(ana, anaThread.threadId);
    const negotiation = anaView.negotiations?.[0];
    negotiationId = negotiation?.id;
    expect(
      negotiation?.parties?.every((p) => p.position?.insist),
      `positions: ${JSON.stringify(negotiation?.parties)}`,
    );
    const question = await ali.getByTestId("lp-negotiation-text").first().innerText();
    expect(
      /insists/.test(question) && /keep yours|merge both/i.test(question),
      `Ali is asked: ${question}`,
    );
    const positionCalls = mockEntries().filter(
      (e) => e.tool === "lp_project_propose_merge" && e.args?.action === "position",
    );
    expect(positionCalls.length >= 2, `${positionCalls.length} positions posted`);
    await shot(ana, "06a-ana-asked");
    await shot(ali, "06b-ali-asked");
  });

  await step(
    "7 both choose Merge both; one agent merges on a branch; the outcome is posted in both threads",
    async () => {
      await ana.getByTestId("lp-neg-both").first().click();
      await ali.getByTestId("lp-neg-both").first().click();
      const merged = await waitFor(
        "the merge to be reported",
        async () => {
          const view = await threadLedger(ana, anaThread.threadId);
          const negotiation = [
            ...(view.negotiations ?? []),
            ...(view.recentNegotiations ?? []),
          ].find((n) => n.id === negotiationId);
          if (negotiation?.state === "failed")
            throw new Error(`merge failed: ${JSON.stringify(negotiation.outcome)}`);
          const decisions = (await projectLedger(ana, projectId)).decisions ?? [];
          return decisions.find((d) => /Kept both versions/.test(d.text)) ?? null;
        },
        120_000,
      );
      for (const page of [ana, ali]) {
        await page
          .getByTestId("lp-notice-text")
          .filter({ hasText: "Kept both versions" })
          .first()
          .waitFor({ timeout: 30_000 });
      }
      const branchReadme = remoteReadme(`lp/merge-${negotiationId}`);
      expect(
        branchReadme?.includes("Ana's heading") && branchReadme?.includes("Ali's heading"),
        `merge branch README: ${branchReadme}`,
      );
      await waitFor(
        "sync to push the merge to main",
        async () => {
          const readme = remoteReadme();
          return (
            (await syncStatus(ana, projectId))?.state === "synced" &&
            readme?.includes("Ana's heading") &&
            readme?.includes("Ali's heading")
          );
        },
        60_000,
      );
      console.log(`     decision: ${merged.text}`);
      await shot(ana, "07a-ana-merged");
      await shot(ali, "07b-ali-merged");
    },
  );

  await step("8 branch Ana's thread into a new chat carrying its context", async () => {
    const before = ana.url();
    await ana.getByTestId("lp-branch-thread").click();
    await waitFor("the branched thread to open", () => ana.url() !== before, 30_000);
    const branched = await waitFor(
      "the branch in the ledger",
      async () =>
        (await projectLedger(ana, projectId)).threads?.find(
          (t) => t.branchedFrom === anaThread.threadId,
        ) ?? null,
    );
    expect(
      branched.members.some((m) => m.name === "Ana"),
      `branch members ${JSON.stringify(branched.members)}`,
    );
    expect(branched.goal, "the branch has no goal carried over");
    const prompt = "what is Ali working on?";
    await sendMessage(ana, prompt);
    await waitForReply(ana, "LEDGER ANSWER", prompt);
    await shot(ana, "08-branch");
  });

  await step(
    "9 lp mcp (stdio) answers who_is_working_on from this host for Ali's clone",
    async () => {
      const token = await pageApi(ali, "/api/lp/helper/token", { device: "ali-laptop" });
      expect(token.token, `no helper token: ${JSON.stringify(token)}`);
      aliHelperHome = NodePath.join(root, "ali-helper");
      const env = {
        LP_HELPER_HOME: aliHelperHome,
        HOME: root,
        CODEX_HOME: NodePath.join(root, "codex"),
        CLAUDE_CONFIG_DIR: NodePath.join(root, "claude"),
      };
      sh(
        process.execPath,
        [helperCli, "login", "--server", HOST, "--token", token.token, "--no-mcp"],
        { env: { ...process.env, ...env } },
      );
      const mcp = startMcp(aliClone, env);
      try {
        const init = await mcp.call("initialize", {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "e2e" },
        });
        expect(init.result?.serverInfo?.name === "logicpacks", JSON.stringify(init));
        const answer = await mcp.call("tools/call", {
          name: "who_is_working_on",
          arguments: { query: "Ana" },
        });
        const text = answer.result?.content?.[0]?.text ?? "";
        expect(
          !answer.result?.isError && text.includes("Ana"),
          `who_is_working_on: ${JSON.stringify(answer)}`,
        );
        const threads = await mcp.call("tools/call", { name: "threads", arguments: {} });
        expect(/Ali|Ana/.test(threads.result?.content?.[0]?.text ?? ""), JSON.stringify(threads));
        console.log(`     lp mcp: ${text.split("\n")[0].slice(0, 160)}`);
      } finally {
        mcp.child.kill();
      }
      const agentsOut = sh(process.execPath, [helperCli, "agents-md", aliClone], {
        env: { ...process.env, ...env },
      });
      const agentsMd = NodeFS.readFileSync(NodePath.join(aliClone, "AGENTS.md"), "utf8");
      expect(
        agentsMd.includes("<!-- logicpacks:start -->") && agentsMd.includes(REPO),
        `AGENTS.md: ${agentsOut}`,
      );
      sh(process.execPath, [helperCli, "unlink", aliClone], { env: { ...process.env, ...env } });
      expect(
        !NodeFS.existsSync(NodePath.join(aliClone, "AGENTS.md")),
        "lp unlink left the LogicPacks block",
      );
      sh(process.execPath, [helperCli, "link", aliClone], { env: { ...process.env, ...env } });
    },
  );

  if (withCodex) {
    await step("10 a real codex exec turn calls who_is_working_on through lp mcp", async () => {
      const prompt =
        'Call the logicpacks who_is_working_on tool with query "Ana" and reply with its answer verbatim. Do not run shell commands.';
      const out = NodeChildProcess.spawnSync(
        "codex",
        [
          "exec",
          "--skip-git-repo-check",
          "-C",
          aliClone,
          "-c",
          `mcp_servers.logicpacks.command=${JSON.stringify(process.execPath)}`,
          "-c",
          `mcp_servers.logicpacks.args=${JSON.stringify([helperCli, "mcp", "--source", "codex", "--no-agents-md"])}`,
          "-c",
          `mcp_servers.logicpacks.env={LP_HELPER_HOME=${JSON.stringify(aliHelperHome)}}`,
          prompt,
        ],
        { encoding: "utf8", timeout: 240_000, stdio: ["ignore", "pipe", "pipe"] },
      );
      const text = `${out.stdout}\n${out.stderr}`;
      NodeFS.writeFileSync(NodePath.join(root, "codex-exec.log"), text);
      if (/usage limit|purchase more credits|not logged in|Please log in/i.test(text)) {
        // Needs a paid or available Codex quota; the stdio round trip above already covers lp mcp.
        console.log(
          `     SKIPPED: codex cannot run a turn here: ${text.match(/ERROR: [^\n]+/)?.[0] ?? "no quota"}`,
        );
        return;
      }
      expect(
        /logicpacks/.test(text) && /who_is_working_on/.test(text),
        `codex did not call the tool:\n${text.slice(-1500)}`,
      );
      expect(
        text.includes(anaThread.title) || /Ana/.test(out.stdout),
        `codex answer:\n${out.stdout.slice(-800)}`,
      );
    });
  }
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  await browser?.close();
  await stopServer();
  if (failed && server) console.log(`--- server log tail ---\n${server.log.slice(-4000)}`);
  if (repoCreated && ghLogin) {
    // Only the repository this run created. Deleted when the token allows it, archived otherwise.
    const scopes = NodeChildProcess.spawnSync("gh", ["auth", "status"], { encoding: "utf8" });
    const canDelete = /delete_repo/.test(
      `${scopes.stdout}${scopes.stderr}`
        .split("Active account: true")[0]
        .split("\n")
        .slice(-6)
        .join("\n"),
    );
    const target = `${ghLogin}/${REPO}`;
    const exists =
      NodeChildProcess.spawnSync("gh", ["repo", "view", target, "--json", "name"], {
        encoding: "utf8",
      }).status === 0;
    if (exists) {
      const cleanup = canDelete
        ? NodeChildProcess.spawnSync("gh", ["repo", "delete", target, "--yes"], {
            encoding: "utf8",
          })
        : NodeChildProcess.spawnSync("gh", ["repo", "archive", target, "--yes"], {
            encoding: "utf8",
          });
      console.log(
        `GitHub cleanup: ${canDelete ? "deleted" : "archived"} ${target} (exit ${cleanup.status}) ${cleanup.stderr.trim()}`,
      );
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
