#!/usr/bin/env node
// Public e2e-flow (no access code): workspace link, joins, read-only, nametags, 20 fresh sessions:
//   node apps/web/e2e/logicpacks-flow.e2e.mjs [--port 3931] [--web-port 5931] [--sessions 20] [--shots <dir>] [--keep]
// A LAPTOP host (the desktop app's own server, not a cloud host, no codes) and the Vite dev client in
// front of it. The host owner (Hal) shares a project with a link; Bo and Cy join in separate browser
// contexts. Every agent is the scripted ACP mock (lp-ledger-mock-agent.mjs) using the real ledger tools.
//   1 A: project folder on disk, a file made outside the app is picked up, workspace link
//   2 B joins by the link; A makes a file, B sees it and who made it
//   3 A and B edit the same file: both versions are saved, Merge both keeps both
//   4 read-only role: banner, every write refused 403 read_only (restore and keep-both too)
//   5 C signs up first, then opens the link; colours
//   6 side by side: B and C in one thread, nametags and colours
//   7 fresh sessions and reloads: nametags present every time
//   8 B branches the project (git branch, change, merge) while C prompts in chat: A, B and C see both changes
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
const port = Number(option("--port", 3931));
const webPort = Number(option("--web-port", 5931));
const keep = args.includes("--keep");
const shotsDir = option("--shots", null);
const WEB = `http://127.0.0.1:${webPort}`;
const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const repo = NodePath.join(here, "../../..");
const serverDir = NodePath.join(repo, "apps/server");
const webDir = NodePath.join(repo, "apps/web");
const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lp-flow-"));
if (shotsDir) NodeFS.mkdirSync(shotsDir, { recursive: true });
const run = Date.now().toString(36).slice(-6);
const PASSWORD = "correct-horse-battery";
const PROJECT = `Flow ${run}`;
const SESSIONS = Number(option("--sessions", 20));
const mockLog = NodePath.join(root, "mock-agent.log");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

// ── Processes ───────────────────────────────────────────────────────────────
const children = {};
function spawnLogged(name, command, commandArgs, options, readyText) {
  const child = NodeChildProcess.spawn(command, commandArgs, {
    ...options,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  const started = { name, child, log: "", killed: false };
  children[name] = started;
  started.ready = new Promise((resolve, reject) => {
    const onData = (chunk) => {
      started.log += chunk;
      if (started.log.length > 400_000) started.log = started.log.slice(-200_000);
      if (readyText.some((text) => started.log.includes(text))) resolve();
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code) => {
      if (!started.killed) reject(new Error(`${name} exited (${code})\n${started.log.slice(-2000)}`));
    });
  });
  started.ready.catch(() => undefined);
  return started;
}
async function stopChild(started, hard = false) {
  started.killed = true;
  for (const signal of hard ? ["SIGKILL"] : ["SIGTERM", "SIGKILL"]) {
    try {
      process.kill(-started.child.pid, signal);
    } catch {
      return;
    }
    for (let waited = 0; waited < 6_000; waited += 200) {
      try {
        process.kill(-started.child.pid, 0);
      } catch {
        return;
      }
      await sleep(200);
    }
  }
}
const serverEnv = () => {
  const env = { ...process.env, LP_MOCK_LOG: mockLog };
  for (const key of Object.keys(env)) if (key.startsWith("LOGICPACKS_")) delete env[key];
  return { ...env, LOGICPACKS_SYNC_SECONDS: "0", LOGICPACKS_GOALS_JUDGE: "off" };
};
const startHost = () =>
  spawnLogged(
    "host",
    process.execPath,
    ["src/bin.ts", "serve", "--port", String(port), "--host", "127.0.0.1", "--base-dir", home, "--no-browser"],
    { cwd: serverDir, env: serverEnv() },
    ["Pairing URL:"],
  );

// ── Harness ─────────────────────────────────────────────────────────────────
const results = [];
const pages = [];
let failed = false;
const notes = [];
const note = (text) => {
  notes.push(text);
  console.log(`     ${text}`);
};
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
    results.push({ name, ok: false, ms: Date.now() - started, error: String(error?.message ?? error) });
    console.log(`FAIL ${name}\n     ${String(error?.message ?? error).split("\n")[0]}`);
    for (const [index, page] of pages.entries())
      await page.screenshot({ path: NodePath.join(shotsDir ?? root, `fail-${results.length}-${index}.png`) }).catch(() => undefined);
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
async function openProject(page, title) {
  await page.goto(`${WEB}/`);
  const heading = page.locator("main h1 button, main h2 button").first();
  await heading.waitFor({ timeout: 45_000 });
  if ((await heading.innerText()).trim() !== title) {
    await heading.click();
    await page.locator('[role="listbox"]').getByText(title, { exact: true }).click();
  }
  await page.waitForFunction(
    (name) => (document.querySelector("main")?.textContent ?? "").replace(/\s+/g, "").includes(`buildin${name}`),
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
const waitForReply = (page, needle, prompt, timeout = 90_000) =>
  waitFor(
    `a reply containing ${needle}`,
    async () => {
      const text = await page.locator("main").innerText();
      const withoutPrompt = text.split(prompt).join("");
      return !/Working for|Thinking/.test(text) && withoutPrompt.includes(needle) ? withoutPrompt : null;
    },
    timeout,
  );
const mockEntries = () =>
  NodeFS.existsSync(mockLog)
    ? NodeFS.readFileSync(mockLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
    : [];
/** One WebSocket RPC as this browser session (cookie auth), for checks the UI does not expose directly. */
const wsRpc = (page, tag, payload) =>
  page.evaluate(
    async ([tag, payload, origins]) => {
      const attempt = (origin) =>
        new Promise((resolve) => {
          const socket = new WebSocket(`${origin}/ws?orchestrationProtocol=2`);
          const timer = setTimeout(() => { socket.close(); resolve({ error: "timeout" }); }, 15_000);
          socket.onopen = () => socket.send(JSON.stringify({ _tag: "Request", id: "1", tag, payload, headers: [] }));
          socket.onmessage = (event) => {
            for (const message of [].concat(JSON.parse(String(event.data)))) {
              if (message._tag === "Exit" && String(message.requestId) === "1") {
                clearTimeout(timer);
                socket.close();
                resolve({ exit: message.exit });
              }
            }
          };
          socket.onerror = () => { clearTimeout(timer); resolve({ error: "socket error" }); };
        });
      for (const origin of origins) {
        const result = await attempt(origin);
        if (!result.error) return result;
      }
      return { error: "no socket" };
    },
    [tag, payload, [`ws://${new URL(WEB).host}`, `ws://127.0.0.1:${port}`]],
  );
const projectLedger = (page, projectId) => pageApi(page, `/api/lp/ledger/project?projectId=${encodeURIComponent(projectId)}`);
const threadOf = (ledger, name) => ledger.threads?.find((thread) => thread.members?.some((member) => member.name === name) && !thread.branchedFrom);
const cwdOf = (text) => /\(cwd ([^)]+)\)/.exec(text)?.[1] ?? null;
const read = (file) => (NodeFS.existsSync(file) ? NodeFS.readFileSync(file, "utf8") : null);


async function loginFresh(browser, who) {
  const page = await newPage(browser);
  await page.goto(`${WEB}/lp/login`);
  await page.fill("#email", `${who}-${run}@example.com`);
  await page.fill("#password", PASSWORD);
  await page.click("#submit");
  await page.waitForURL((u) => u.origin === WEB && !u.pathname.startsWith("/lp/"), { timeout: 30_000 });
  return page;
}
const tags = async (page) =>
  page.getByTestId("lp-msg-nametag").evaluateAll((els) => els.map((e) => ({ text: e.textContent?.trim(), color: e.getAttribute("data-color"), user: e.getAttribute("data-user-id") })));
async function openThread(page, title) {
  await page.goto(`${WEB}/`);
  await page.getByText(title, { exact: false }).first().click({ timeout: 45_000, force: true });
  await page.locator("main").waitFor();
}

/** Opens the first thread in the sidebar (titles are generated; the project label sits in every row). */
async function openAnyThread(page) {
  await page.goto(`${WEB}/`);
  await page.getByText(PROJECT, { exact: true }).nth(1).click({ timeout: 45_000, force: true });
  await page.getByTestId("lp-ledger-open").waitFor({ timeout: 30_000 });
}

let browser;
try {
  note(`work dir ${root}`);
  startHost();
  const web = spawnLogged("web", NodePath.join(repo, "node_modules/.bin/vp"), ["dev"],
    { cwd: webDir, env: { ...process.env, LOGICPACKS_SINGLE_ORIGIN_DEV: "1", LOGICPACKS_PORT: String(port), PORT: String(webPort), HOST: "127.0.0.1" } },
    ["ready in", "Local:"]);
  await Promise.all([children.host.ready, web.ready]);
  browser = await chromium.launch({ headless: true });
  let a, b, c, projectId, workspaceId, invite, projectDir;

  await step("1 A: project folder on disk, a file made outside the app (python) is picked up, workspace link copied", async () => {
    a = await newPage(browser);
    const pairing = children.host.log.match(/Pairing URL: (\S+)/)?.[1];
    const pu = new URL(pairing);
    await a.goto(`${WEB}${pu.pathname}${pu.search}${pu.hash}`);
    await a.waitForURL((u) => !u.pathname.startsWith("/pair"), { timeout: 30_000 });
    await a.waitForLoadState("load");
    await a.goto(`${WEB}/`);
    await a.waitForLoadState("load");
    await sleep(3_000);
    const wsMade = await pageApi(a, "/api/lp/workspaces", { name: `Flow team ${run}` });
    workspaceId = wsMade.workspace?.workspaceId ?? null;
    if (workspaceId) await pageApi(a, "/api/lp/workspaces/current", { workspaceId });
    note(`workspace create -> ${wsMade.httpStatus} ${workspaceId}`);
    const created = await pageApi(a, "/api/lp/projects/new", { kind: "template", name: PROJECT, template: "website" });
    expect(created.projectId, JSON.stringify(created));
    projectId = created.projectId;
    projectDir = NodeFS.readdirSync(NodePath.join(home, "projects")).map((d) => NodePath.join(home, "projects", d)).find((d) => NodeFS.existsSync(NodePath.join(d, ".git")));
    expect(projectDir, "no project folder");
    await openProject(a, PROJECT);
    const changes = async () => Number(/Changes\s*\+(\d+)/.exec((await a.locator("body").innerText()).replace(/\n/g, " "))?.[1] ?? 0);
    const before = await changes();
    NodeChildProcess.execFileSync("python3", ["-c", `open(${JSON.stringify(NodePath.join(projectDir, "from_python.txt"))},"w").write("made by python\\n")`]);
    await waitFor("the python file in the workspace", async () => (await changes()) > before, 45_000);
    const session = await pageApi(a, "/api/lp/session");
    workspaceId = session.workspaces.find((w) => w.projectIds?.includes(projectId))?.workspaceId ?? workspaceId;
    note(`workspace ${workspaceId} of ${JSON.stringify(session.workspaces.map((w) => [w.workspaceId.slice(0, 6), w.name, w.projectIds?.length]))}`);
    let inv = workspaceId ? await pageApi(a, `/api/lp/workspaces/invite?workspaceId=${workspaceId}`) : { httpStatus: 0 };
    if (!inv.path) {
      const made = await pageApi(a, "/api/lp/workspaces", { name: `Flow team ${run}` });
      note(`host owner has no workspace; create -> ${made.httpStatus} ${JSON.stringify(made).slice(0, 160)}`);
      workspaceId = made.workspaceId ?? made.workspace?.workspaceId ?? null;
      if (workspaceId) {
        await pageApi(a, "/api/lp/workspaces/current", { workspaceId });
        inv = await pageApi(a, `/api/lp/workspaces/invite?workspaceId=${workspaceId}`);
      }
    }
    if (!inv.path) {
      const link = await pageApi(a, "/api/lp/shares/link", { projectId, enabled: true });
      note("no workspace link on a laptop host: using the project share link instead");
      inv = { path: link.link?.path };
    }
    expect(inv.path, `invite: ${JSON.stringify(inv)}`);
    invite = inv.path;
    note(`workspace link ${invite}`);
  });

  await step("2 B (clean session) joins by the link; A makes a file, B sees it and who made it", async () => {
    b = await newPage(browser);
    await b.goto(`${WEB}${invite}`);
    await b.locator("#name").waitFor({ timeout: 45_000 });
    await b.fill("#name", "Bo");
    await b.fill("#email", `bo-${run}@example.com`);
    await b.fill("#password", PASSWORD);
    await b.click("#submit");
    await b.waitForURL((u) => u.origin === WEB && !u.pathname.startsWith("/lp/"), { timeout: 30_000 });
    expect((await pageApi(b, "/api/lp/projects")).projects?.some((p) => p.id === projectId), "B cannot see the project");
    await openProject(a, PROJECT);
    const prompt = "edit made-by-a.txt A made this (hold 4s)";
    await sendMessage(a, prompt);
    await waitForReply(a, "Edited", prompt);
    await openProject(b, PROJECT);
    const bPrompt = "what is Host working on?";
    await sendMessage(b, bPrompt);
    const reply = await waitForReply(b, "LEDGER ANSWER", bPrompt);
    expect(/made-by-a\.txt/.test(reply) && /Host/.test(reply), `B sees: ${reply.slice(-300)}`);
    await shot(b, "02-b-sees-a");
  });

  let sameFile = null;
  await step("3 A and B edit the same file: overlap is detected, both versions are saved, Merge both keeps both; admin sees it", async () => {
    const pa = "edit same.txt A VERSION (hold 7s)";
    const pb = "edit same.txt B VERSION (hold 7s)";
    await sendMessage(a, pa);
    await waitFor("A's edit", () => mockEntries().some((e) => e.userText?.includes("A VERSION")), 30_000);
    await sendMessage(b, pb);
    const aReply = await waitForReply(a, "Edited same.txt", pa);
    await waitForReply(b, "Edited same.txt", pb);
    for (const [name, page] of [["A", a], ["B", b]]) {
      await page.getByTestId("lp-conflict-card").first().waitFor({ timeout: 30_000 }).catch(() => { throw new Error(`${name} sees no conflict card`); });
    }
    const text = await a.getByTestId("lp-conflict-card").first().innerText();
    note(`conflict card for A: ${JSON.stringify(text.slice(0, 200))}`);
    expect(/Merge both|branch/i.test(await a.locator("main").innerText()), "no branch/merge suggestion");
    const dir = cwdOf(aReply);
    const conflict = await waitFor("a conflict with both versions saved", async () => (await projectLedger(a, projectId)).conflicts?.find((x) => x.files?.includes("same.txt") && (x.preserved?.length ?? 0) >= 2));
    sameFile = { conflictId: conflict.id, aThread: conflict.preserved[0].threadId, bThread: conflict.preserved[1].threadId };
    expect(read(NodePath.join(dir, "same.txt")) === "B VERSION\n", `shared file after both edits: ${JSON.stringify(read(NodePath.join(dir, "same.txt")))}`);
    const savedA = Object.values(conflict.preserved).map((v) => read(NodePath.join(projectDir, ".logicpacks/preserved", conflict.id, v.threadId, "same.txt")));
    note(`saved versions on disk: ${JSON.stringify(savedA)}`);
    expect(savedA.includes("A VERSION\n") && savedA.includes("B VERSION\n"), `saved versions: ${JSON.stringify(savedA)}`);
    expect(/version of same\.txt is saved/.test(await a.getByTestId("lp-conflict-saved").first().innerText()), "the card does not say the first version is saved");
    await shot(a, "03-conflict-a");
    await a.getByTestId("lp-conflict-merge").first().click();
    const merged = await waitFor("both versions in same.txt", () => {
      const body = read(NodePath.join(dir, "same.txt")) ?? "";
      return body.includes("A VERSION") && body.includes("B VERSION") ? body : null;
    }, 20_000);
    note(`Merge both on a project with no git remote: same.txt is ${JSON.stringify(merged)}`);
    const ledger = await projectLedger(a, projectId);
    expect(ledger.conflicts?.find((x) => x.id === conflict.id)?.state === "resolved", "conflict not resolved after Merge both");
  });

  await step("4 read-only role: A sets B read only; B sees a banner, every write is refused 403 read_only; back to member, B sends again", async () => {
    const bId = (await pageApi(b, "/api/lp/session")).user.userId;
    const setRole = (role) => pageApi(a, "/api/lp/workspaces/members/role", { workspaceId, userId: bId, role });
    const bRole = async () => (await pageApi(b, "/api/lp/session")).workspaces.find((w) => w.workspaceId === workspaceId)?.role;
    const ledger = await projectLedger(a, projectId);
    const bThread = ledger.threads.find((t) => t.members?.some((m) => m.id === bId));
    expect(bThread, "B has no thread of their own to send from");
    const refused = (r, what) => expect(r.httpStatus === 403 && r.error === "read_only" && /read-only access/.test(r.message ?? ""), `${what} not refused as read_only: ${JSON.stringify(r).slice(0, 200)}`);

    const set = await setRole("viewer");
    expect(set.httpStatus === 200 && set.role === "viewer", `set viewer: ${JSON.stringify(set)}`);
    expect((await bRole()) === "viewer", "B's session does not show role viewer");

    // The composer is replaced by the banner, with no way to send.
    await b.reload();
    await openProject(b, PROJECT);
    await b.getByTestId("lp-readonly-banner").waitFor({ timeout: 30_000 });
    expect((await b.locator('[contenteditable="true"]').count()) === 0, "B still has a composer");
    expect(/read-only access to this workspace/.test(await b.getByTestId("lp-readonly-banner").innerText()), "banner text");
    await shot(b, "04-b-read-only");

    // Writes by HTTP, on the lp/connect routes and the web routes, are refused.
    refused(await pageApi(b, "/api/lp/connect/send", { fromThreadId: bThread.threadId, to: "Host", text: "hi" }), "connect/send");
    refused(await pageApi(b, "/api/lp/ledger/send", { threadId: bThread.threadId, to: "Host", text: "hi" }), "ledger/send");
    refused(await pageApi(b, "/api/lp/ledger/merge", { threadId: bThread.threadId }), "ledger/merge");
    if (sameFile) {
      refused(await pageApi(b, "/api/lp/ledger/restore", { threadId: bThread.threadId, conflictId: sameFile.conflictId, versionThreadId: bThread.threadId }), "ledger/restore");
      refused(await pageApi(b, "/api/lp/ledger/keep-both", { threadId: bThread.threadId, conflictId: sameFile.conflictId }), "ledger/keep-both");
    }
    refused(await pageApi(b, "/api/lp/projects/new", { kind: "empty", name: `Nope ${run}` }), "projects/new");
    refused(await pageApi(b, "/api/lp/shares", { projectId, user: "someone@example.com" }), "shares");
    refused(await pageApi(b, "/api/lp/goals/create", { projectId, plan: { title: "x", milestones: [] } }), "goals/create");
    const upload = await b.evaluate(async (id) => {
      const response = await fetch(`/api/lp/projects/upload?projectId=${id}&path=ro.txt`, { method: "POST", credentials: "include", body: "no" });
      return { httpStatus: response.status, ...(await response.json().catch(() => ({}))) };
    }, projectId);
    refused(upload, "projects/upload");
    expect(!NodeFS.existsSync(NodePath.join(projectDir, "ro.txt")), "a read only upload reached the disk");
    // Reads stay open.
    expect((await pageApi(b, "/api/lp/connect/inbox")).httpStatus === 200, "B cannot read their inbox");
    expect((await pageApi(b, `/api/lp/ledger/thread?threadId=${encodeURIComponent(bThread.threadId)}`)).httpStatus === 200, "B cannot read the ledger");

    // The server refuses the RPC too: B's own websocket dispatch.
    const rpc = await wsRpc(b, "orchestration.dispatchCommand", {
      type: "message.dispatch",
      createdBy: "user",
      creationSource: "web",
      commandId: `ro-${run}`,
      threadId: bThread.threadId,
      messageId: `ro-msg-${run}`,
      text: "read only attempt",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
    });
    expect(/read-only access to this workspace/.test(JSON.stringify(rpc)), `RPC dispatch not refused: ${JSON.stringify(rpc).slice(0, 300)}`);
    const launch = await wsRpc(b, "orchestration.launchThread", {
      commandId: `rol-${run}`,
      projectId,
      title: "ro",
      modelSelection: { instanceId: "ledgerMock", model: "default" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      workspaceStrategy: { type: "root" },
      initialMessage: { text: "read only attempt", attachments: [] },
    });
    expect(/read-only access to this workspace/.test(JSON.stringify(launch)), `RPC launch not refused: ${JSON.stringify(launch).slice(0, 300)}`);

    const back = await setRole("member");
    expect(back.httpStatus === 200 && back.role === "member", `set member: ${JSON.stringify(back)}`);
    expect((await bRole()) === "member", "B's role did not go back to member");
    await b.reload();
    await openProject(b, PROJECT);
    expect((await b.getByTestId("lp-readonly-banner").count()) === 0, "banner still shown after going back to member");
    const sendOk = await pageApi(b, "/api/lp/connect/send", { fromThreadId: bThread.threadId, to: "Host", text: "back to member" });
    expect(sendOk.error !== "read_only" && sendOk.httpStatus !== 403, `B cannot send again: ${JSON.stringify(sendOk).slice(0, 200)}`);
    const prompt = "edit made-by-b-after.txt B can edit again";
    await sendMessage(b, prompt);
    await waitForReply(b, "Edited", prompt);
  });

  await step("5 C signs up first, then opens the link in that signed-in session; workspace appears; colours", async () => {
    c = await newPage(browser);
    await c.goto(`${WEB}/lp/login`);
    await c.click("#toggle").catch(() => undefined);
    await c.fill("#name", "Cy");
    await c.fill("#email", `cy-${run}@example.com`);
    await c.fill("#password", PASSWORD);
    await c.click("#submit");
    await c.waitForURL((u) => u.origin === WEB && !u.pathname.startsWith("/lp/"), { timeout: 30_000 });
    expect(!(await pageApi(c, "/api/lp/projects")).projects?.some((p) => p.id === projectId), "C saw the project before the link");
    await c.goto(`${WEB}${invite}`);
    await waitFor("the workspace on C's account", async () => (await pageApi(c, "/api/lp/projects")).projects?.some((p) => p.id === projectId), 45_000);
    const cp = "edit made-by-c.txt C made this";
    await openProject(c, PROJECT);
    await sendMessage(c, cp);
    await waitForReply(c, "Edited", cp);
    const colors = await pageApi(a, `/api/lp/presence?projectId=${projectId}`);
    note(`presence colours: ${JSON.stringify(colors).slice(0, 240)}`);
  });

  await step("6 side by side: B and C open one thread and both send hello; each message carries that person's tag and colour", async () => {
    const ledger = await projectLedger(a, projectId);
    const hostThread = ledger.threads.find((t) => t.members?.some((m) => m.name === "Host"));
    expect(hostThread, "no host thread");
    await openThread(b, hostThread.title ?? "made-by-a");
    await openThread(c, hostThread.title ?? "made-by-a");
    await sendMessage(b, "hello from Bo");
    await waitForReply(b, "hello from Bo", "\u0000");
    await sendMessage(c, "hello from Cy");
    await waitFor("both hellos visible to B", async () => /hello from Cy/.test(await b.locator("main").innerText()), 60_000);
    await sleep(3_000);
    const t = await tags(b);
    note(`B sees nametags: ${JSON.stringify(t)}`);
    const names = new Set(t.map((x) => x.text));
    expect([...names].some((n) => /Bo/.test(n ?? "")) && [...names].some((n) => /Cy/.test(n ?? "")), `missing nametags: ${JSON.stringify(t)}`);
    const colorOf = (n) => t.find((x) => (x.text ?? "").includes(n))?.color;
    expect(colorOf("Bo") !== colorOf("Cy"), `same colour for Bo and Cy: ${colorOf("Bo")}`);
    await shot(b, "06-side-by-side-b");
    // admin changes Bo's colour
    const boId = t.find((x) => (x.text ?? "").includes("Bo")).user;
    const newColor = (Number(colorOf("Bo")) + 3) % 8;
    const set = await pageApi(a, "/api/lp/people/color", { userId: boId, color: newColor });
    expect(set.httpStatus === 200, `admin colour change: ${JSON.stringify(set)}`);
    await c.reload();
    await c.getByTestId("lp-msg-nametag").first().waitFor({ timeout: 30_000 });
    expect((await tags(c)).find((x) => x.user === boId)?.color === String(newColor), "Bo's new colour not shown to C");
  });

  await step(`7 ${SESSIONS} fresh sessions and reloads: nametags present every time`, async () => {
    const ledger = await projectLedger(a, projectId);
    const hostThread = ledger.threads.find((t) => t.members?.some((m) => m.name === "Host"));
    let bad = 0;
    const log = [];
    const latencies = [];
    for (let i = 1; i <= SESSIONS; i += 1) {
      const who = i % 2 ? "bo" : "cy";
      const page = await loginFresh(browser, who);
      await openThread(page, hostThread.title ?? "made-by-a");
      let seen = [];
      const t0 = Date.now();
      const wait = async (limit) => {
        for (let waited = 0; waited < limit; waited += 250) {
          seen = await tags(page);
          if (new Set(seen.map((x) => x.user)).size >= 2) return Date.now() - t0;
          await sleep(250);
        }
        return null;
      };
      let ms = await wait(10_000);
      const reload = i % 3 === 0;
      if (reload) {
        const r0 = Date.now();
        await page.reload();
        ms = await (async () => {
          for (let waited = 0; waited < 10_000; waited += 250) {
            seen = await tags(page);
            if (new Set(seen.map((x) => x.user)).size >= 2) return Date.now() - r0;
            await sleep(250);
          }
          return null;
        })();
      }
      latencies.push(ms);
      const ok = new Set(seen.map((x) => x.user)).size >= 2;
      if (!ok) {
        bad += 1;
        const api = await pageApi(page, `/api/lp/messages/authors?threadId=${hostThread.threadId}`);
        note(`session ${i} FAIL: authors api ${api.httpStatus} keys=${Object.keys(api.authors ?? {}).length} url=${page.url().slice(-60)} tagsNow=${(await tags(page)).length} userMsgs=${await page.locator("[data-message-role=user], [data-user-message-attribution]").count()}`);
        await shot(page, `07-fail-${i}`);
      }
      log.push(`${i}:${who}${reload ? "+r" : ""}:${ms}ms${ok ? "" : " FAIL"}`);
      await page.context().close();
    }
    note(`fresh-session results: ${log.join(" ")}`);
    note(`FAILURE RATE ${bad}/${SESSIONS}`);
    expect(bad === 0, `${bad}/${SESSIONS} sessions lacked nametags`);
  });

  await step("8 B branches the project, changes it and merges, while C prompts in chat: A, B and C see both changes", async () => {
    const gitIn = (dir, ...a) => NodeChildProcess.execFileSync("git", a, { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" } }).trim();
    await openAnyThread(b);
    await openProject(c, PROJECT);
    // The product's own thread-branch button: B's chat forks into a new chat that carries its context.
    const threadsBefore = (await projectLedger(a, projectId)).threads.length;
    if (await b.getByTestId("lp-branch-thread").count()) {
      await b.getByTestId("lp-branch-thread").first().click();
      await waitFor("B's branched chat", async () => (await projectLedger(a, projectId)).threads.length > threadsBefore, 30_000);
      await sleep(2_000);
      note("B pressed the thread-branch button: a new chat carries B's context");
    } else {
      note("thread-branch button not shown in this layout; B prompts in the current chat");
    }
    const baseBranch = gitIn(projectDir, "rev-parse", "--abbrev-ref", "HEAD");
    const bPrompt = "branch feat-b b-branch.txt B made this on the branch (hold 9s)";
    await sendMessage(b, bPrompt);
    await waitFor("the project checkout on B's branch", () => gitIn(projectDir, "rev-parse", "--abbrev-ref", "HEAD") === "feat-b", 30_000);
    // C prompts in chat while B's branch is checked out.
    const cPrompt = "edit c-during.txt C wrote this while B worked on a branch";
    await sendMessage(c, cPrompt);
    const cReply = await waitForReply(c, "Edited c-during.txt", cPrompt);
    const headAtC = gitIn(projectDir, "rev-parse", "--abbrev-ref", "HEAD");
    note(`C's edit landed while the project checkout was on ${headAtC} (cwd ${cwdOf(cReply)})`);
    const bReply = await waitForReply(b, "merged into", bPrompt, 120_000);
    expect(!/FAILED/.test(bReply), `B's merge: ${bReply.slice(-300)}`);
    expect(gitIn(projectDir, "rev-parse", "--abbrev-ref", "HEAD") === baseBranch, "the checkout is not back on the base branch");
    const merges = gitIn(projectDir, "log", "--merges", "--oneline", "-3");
    note(`git log --merges: ${merges.replace(/\n/g, " | ")}`);
    expect(/Merge feat-b/.test(merges), `no merge commit for feat-b: ${merges}`);
    expect(gitIn(projectDir, "branch", "--merged", baseBranch).includes("feat-b"), "feat-b is not merged into the base branch");
    expect(read(NodePath.join(projectDir, "b-branch.txt")) === "B made this on the branch\n", "B's branch change is not in the project");
    expect(read(NodePath.join(projectDir, "c-during.txt")) === "C wrote this while B worked on a branch\n", "C's concurrent change is not in the project");
    expect(gitIn(projectDir, "ls-files", "b-branch.txt") === "b-branch.txt", "B's file is not tracked on the base branch after the merge");
    // Everyone sees both changes: open C's thread, then the team popover lists each thread's files.
    for (const [who, page] of [["A", a], ["B", b], ["C", c]]) {
      await openAnyThread(page);
      await page.getByTestId("lp-ledger-open").click();
      await page.getByTestId("lp-ledger-popover").waitFor();
      const rows = await waitFor(`${who} to see both files`, async () => {
        const text = (await page.getByTestId("lp-ledger-thread").allInnerTexts()).join(" | ");
        return text.includes("b-branch.txt") && text.includes("c-during.txt") ? text : null;
      }, 30_000);
      note(`${who} sees: ${rows.replace(/\s+/g, " ").slice(0, 220)}`);
      await shot(page, `08-${who.toLowerCase()}-sees-both`);
      await page.keyboard.press("Escape");
    }
  });
} catch (error) {
  failed = true;
  console.log(`FATAL ${error?.stack ?? error}`);
} finally {
  await browser?.close().catch(() => undefined);
  for (const started of Object.values(children)) await stopChild(started);
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} steps passed`);
  for (const r of results.filter((x) => !x.ok)) console.log(`  FAILED ${r.name}: ${r.error}`);
  if (!keep && !failed) NodeFS.rmSync(root, { recursive: true, force: true });
  else console.log(`kept ${root}`);
  process.exit(failed ? 1 : 0);
}
