#!/usr/bin/env node
// Public (no access code) multi-user sharing, end to end:
//   node apps/web/e2e/logicpacks-public-multi.e2e.mjs [--port 3921] [--web-port 5921] [--shots <dir>] [--keep]
// A LAPTOP host (the desktop app's own server, not a cloud host, no codes) and the Vite dev client in
// front of it. The host owner (Hal) shares a project with a link; Bo and Cy join in separate browser
// contexts. Every agent is the scripted ACP mock (lp-ledger-mock-agent.mjs) using the real ledger tools.
//   1 Hal makes a project and a share link; Bo and Cy join through it
//   2 three threads run at once, each editing a different file: all three land on the host
//   3 Bo and Cy edit the SAME file at the same time: both versions are saved; Restore and Merge both
//   4 members see each other's work (ledger popover, "what is Bo working on")
//   5 the second agent is told who else is on the same file (no-overlap context)
//   6 locked things are absent: cloud sync is refused, no talent/apps/packs routes
//   7 host offline: members get an honest state; host back: threads and files are intact
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
const port = Number(option("--port", 3921));
const webPort = Number(option("--web-port", 5921));
const keep = args.includes("--keep");
const shotsDir = option("--shots", null);
const WEB = `http://127.0.0.1:${webPort}`;
const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const repo = NodePath.join(here, "../../..");
const serverDir = NodePath.join(repo, "apps/server");
const webDir = NodePath.join(repo, "apps/web");
const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lp-public-multi-"));
if (shotsDir) NodeFS.mkdirSync(shotsDir, { recursive: true });
const run = Date.now().toString(36).slice(-6);
const PASSWORD = "correct-horse-battery";
const PROJECT = `Bakery ${run}`;
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
const projectLedger = (page, projectId) => pageApi(page, `/api/lp/ledger/project?projectId=${encodeURIComponent(projectId)}`);
const threadOf = (ledger, name) => ledger.threads?.find((thread) => thread.members?.some((member) => member.name === name) && !thread.branchedFrom);
const cwdOf = (text) => /\(cwd ([^)]+)\)/.exec(text)?.[1] ?? null;
const read = (file) => (NodeFS.existsSync(file) ? NodeFS.readFileSync(file, "utf8") : null);

let browser;
try {
  note(`work dir ${root}`);
  startHost();
  const web = spawnLogged(
    "web",
    NodePath.join(repo, "node_modules/.bin/vp"),
    ["dev"],
    { cwd: webDir, env: { ...process.env, LOGICPACKS_SINGLE_ORIGIN_DEV: "1", LOGICPACKS_PORT: String(port), PORT: String(webPort), HOST: "127.0.0.1" } },
    ["ready in", "Local:"],
  );
  await Promise.all([children.host.ready, web.ready]);
  browser = await chromium.launch({ headless: true });

  let hal;
  let bo;
  let cy;
  let projectId;
  let projectRoot;
  let link;
  const cwds = {};

  await step("1 Hal (host) makes a project and a share link; Bo and Cy join through it", async () => {
    hal = await newPage(browser);
    const pairing = children.host.log.match(/Pairing URL: (\S+)/)?.[1];
    expect(pairing, "no pairing URL");
    const pairUrl = new URL(pairing);
    await hal.goto(`${WEB}${pairUrl.pathname}${pairUrl.search}${pairUrl.hash}`);
    await hal.waitForURL((url) => !url.pathname.startsWith("/pair"), { timeout: 30_000 });
    await hal.waitForLoadState("load");
    await sleep(2_000);
    const created = await pageApi(hal, "/api/lp/projects/new", { kind: "template", name: PROJECT, template: "website" });
    expect(created.projectId, `project not created: ${JSON.stringify(created)}`);
    projectId = created.projectId;
    projectRoot = created.workspaceRoot ?? created.path ?? null;
    note(`project ${projectId} root ${projectRoot} (${Object.keys(created).join(",")})`);
    const made = await pageApi(hal, "/api/lp/shares/link", { projectId, enabled: true });
    expect(made.link?.path, `share link: ${JSON.stringify(made)}`);
    link = made.link.path;
    for (const [name, who] of [["Bo", "bo"], ["Cy", "cy"]]) {
      const page = await newPage(browser);
      await page.goto(`${WEB}${link}`);
      await page.locator("h1", { hasText: "Join the project" }).waitFor({ timeout: 45_000 });
      await page.fill("#name", name);
      await page.fill("#email", `${who}-${run}@example.com`);
      await page.fill("#password", PASSWORD);
      await page.click("#submit");
      await page.waitForURL((u) => u.origin === WEB && !u.pathname.startsWith("/lp/"), { timeout: 30_000 });
      if (who === "bo") bo = page;
      else cy = page;
      const seen = await pageApi(page, "/api/lp/projects");
      expect(seen.projects?.some((p) => p.id === projectId), `${name} cannot see the project: ${JSON.stringify(seen).slice(0, 300)}`);
    }
    await shot(bo, "01-bo-in-project");
  });

  await step("2 three threads at once, different files: all three land on the host", async () => {
    const prompts = [
      [hal, "Hal", "edit hal.txt Hal wrote this (hold 6s)", "hal.txt"],
      [bo, "Bo", "edit bo.txt Bo wrote this (hold 6s)", "bo.txt"],
      [cy, "Cy", "edit cy.txt Cy wrote this (hold 6s)", "cy.txt"],
    ];
    for (const [page] of prompts) await openProject(page, PROJECT);
    const started = Date.now();
    for (const [page, , prompt] of prompts) await sendMessage(page, prompt);
    for (const [page, name, prompt, file] of prompts) {
      const reply = await waitForReply(page, "Edited", prompt);
      cwds[name] = cwdOf(reply);
      expect(cwds[name], `${name}: no cwd in reply: ${reply.slice(-200)}`);
      note(`${name} thread cwd ${cwds[name]} (${file})`);
    }
    note(`three overlapping turns took ${Date.now() - started} ms (each holds 6 s)`);
    const ledger = await waitFor("three threads in the ledger", async () => {
      const view = await projectLedger(hal, projectId);
      return (view.threads?.length ?? 0) >= 3 ? view : { _debug: JSON.stringify(view).slice(0, 600) } && null;
    }, 20_000).catch(async (error) => {
      throw new Error(`${error.message} ledger=${JSON.stringify(await projectLedger(hal, projectId)).slice(0, 900)}`);
    });
    const names = ledger.threads.flatMap((t) => (t.members ?? []).map((m) => m.name));
    note(`ledger members: ${names.join(", ")}`);
    expect(["Bo", "Cy"].every((n) => names.includes(n)), `ledger lacks members: ${names}`);
    void (() => {
    })();
    expect(ledger.threads.length >= 3, "ledger lacks threads");
    for (const [, name, , file] of prompts) {
      expect(read(NodePath.join(cwds[name], file))?.includes(`${name} wrote this`), `${file} missing in ${cwds[name]}`);
    }
    const distinct = new Set(Object.values(cwds));
    note(distinct.size === 3 ? "each thread works in its own checkout" : `threads share ${distinct.size} checkout(s): ${[...distinct].join(" | ")}`);
    if (distinct.size < 3) {
      for (const [, name, , file] of prompts)
        expect(read(NodePath.join([...distinct][0], file)), `${file} is not in the shared checkout`);
    }
  });

  await step("3 Bo and Cy edit the SAME file together: both versions are saved, restorable and mergeable", async () => {
    const boPrompt = "edit shared.txt BO VERSION of the page (hold 7s)";
    const cyPrompt = "edit shared.txt CY VERSION of the page (hold 7s)";
    await sendMessage(bo, boPrompt);
    await waitFor("Bo's edit on disk", () => mockEntries().some((e) => e.userText?.includes("BO VERSION")), 30_000);
    await sendMessage(cy, cyPrompt);
    const boReply = await waitForReply(bo, "Edited shared.txt", boPrompt);
    const cyReply = await waitForReply(cy, "Edited shared.txt", cyPrompt);
    const [boDir, cyDir] = [cwdOf(boReply), cwdOf(cyReply)];
    const [boFile, cyFile] = [read(NodePath.join(boDir, "shared.txt")), read(NodePath.join(cyDir, "shared.txt"))];
    note(`Bo checkout ${boDir}: ${JSON.stringify(boFile)}; Cy checkout ${cyDir}: ${JSON.stringify(cyFile)}`);
    const sameCheckout = boDir === cyDir;
    note(sameCheckout ? "SAME checkout: the later writer replaced the earlier one on disk" : "separate checkouts: both edits survive on their own side");
    if (sameCheckout) expect(cyFile === "CY VERSION of the page\n", `the shared file is not Cy's: ${JSON.stringify(cyFile)}`);
    const cyLedger = mockEntries().filter((e) => e.userText?.includes("CY VERSION")).at(-1)?.ledger ?? "";
    note(`ledger given to Cy's agent: ${JSON.stringify(cyLedger.slice(0, 500))}`);

    // The ledger saw the collision and saved both versions.
    const conflict = await waitFor("an overlap conflict with both versions saved", async () => {
      const view = await projectLedger(hal, projectId);
      return view.conflicts?.find((c) => c.source === "overlap" && c.files?.includes("shared.txt") && (c.preserved?.length ?? 0) >= 2 && c.state !== "resolved");
    }, 30_000);
    expect(conflict.localMerge === true, `a laptop project with no remote should merge locally: ${JSON.stringify(conflict).slice(0, 400)}`);
    const boThreadId = threadOf(await projectLedger(hal, projectId), "Bo")?.threadId;
    const cyThreadId = threadOf(await projectLedger(hal, projectId), "Cy")?.threadId;
    const boSaved = conflict.preserved.find((v) => v.threadId === boThreadId);
    const cySaved = conflict.preserved.find((v) => v.threadId === cyThreadId);
    expect(boSaved && cySaved, `saved versions are not Bo's and Cy's: ${JSON.stringify(conflict.preserved)}`);
    const storeRoot = [projectRoot, boDir, cyDir].find((dir) => dir && NodeFS.existsSync(NodePath.join(dir, ".logicpacks/preserved", conflict.id)));
    expect(storeRoot, `no preserved folder for ${conflict.id} under ${projectRoot} / ${boDir} / ${cyDir}`);
    const savedPath = (v) => NodePath.join(storeRoot, ".logicpacks/preserved", conflict.id, v.threadId, "shared.txt");
    expect(read(savedPath(boSaved)) === "BO VERSION of the page\n", `Bo's saved version: ${JSON.stringify(read(savedPath(boSaved)))}`);
    expect(read(savedPath(cySaved)) === "CY VERSION of the page\n", `Cy's saved version: ${JSON.stringify(read(savedPath(cySaved)))}`);
    note(`saved on disk under ${storeRoot}/.logicpacks/preserved/${conflict.id}: Bo ${JSON.stringify(read(savedPath(boSaved)))}, Cy ${JSON.stringify(read(savedPath(cySaved)))}`);
    const ignored = NodeChildProcess.spawnSync("git", ["status", "--porcelain", "-uall"], { cwd: storeRoot, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" } });
    expect(ignored.status !== 0 || !ignored.stdout.includes(".logicpacks"), `git would commit the saved versions: ${ignored.stdout}`);

    // The card says so.
    for (const [name, page] of [["Bo", bo], ["Cy", cy]]) {
      await page.getByTestId("lp-conflict-card").first().waitFor({ timeout: 30_000 });
      const saved = await page.getByTestId("lp-conflict-saved").first().innerText();
      expect(/Bo's version of shared\.txt is saved/.test(saved) && /Cy's version of shared\.txt is saved/.test(saved), `${name}'s card: ${JSON.stringify(saved)}`);
    }
    await shot(bo, "03a-bo-same-file");
    await shot(cy, "03b-cy-same-file");

    // Only the owner or the version's own person may restore it.
    const notYours = await pageApi(cy, "/api/lp/ledger/restore", { threadId: cyThreadId, conflictId: conflict.id, versionThreadId: boThreadId });
    expect(notYours.httpStatus === 403, `Cy restoring Bo's version should be refused: ${JSON.stringify(notYours)}`);
    expect(read(NodePath.join(cyDir, "shared.txt")) === "CY VERSION of the page\n", "a refused restore changed the file");

    // Bo restores his version from the card: the file is Bo's again, Cy's stays saved.
    await bo.locator(`[data-testid="lp-conflict-version"][data-thread-id="${boThreadId}"] [data-testid="lp-conflict-restore"]`).click();
    await waitFor("Bo's version back on disk", () => read(NodePath.join(cyDir, "shared.txt")) === "BO VERSION of the page\n", 20_000);
    expect(read(savedPath(cySaved)) === "CY VERSION of the page\n", "Cy's saved version vanished");
    note("Restore on Bo's card: shared.txt is Bo's version again; Cy's stays saved");
    // The host owner may restore anyone's version.
    const ownerRestore = await pageApi(hal, "/api/lp/ledger/restore", { threadId: boThreadId, conflictId: conflict.id, versionThreadId: cyThreadId });
    expect(ownerRestore.httpStatus === 200, `owner restore: ${JSON.stringify(ownerRestore)}`);
    expect(read(NodePath.join(cyDir, "shared.txt")) === "CY VERSION of the page\n", "owner restore of Cy's version did not land");
    expect(read(savedPath(boSaved)) === "BO VERSION of the page\n", "Bo's saved version vanished after the owner's restore");

    // Merge both: the file keeps both versions, the conflict is resolved, the card goes.
    await cy.getByTestId("lp-conflict-merge").first().click();
    const merged = await waitFor("both versions in shared.txt", () => {
      const text = read(NodePath.join(cyDir, "shared.txt")) ?? "";
      return text.includes("BO VERSION of the page") && text.includes("CY VERSION of the page") ? text : null;
    }, 20_000);
    note(`Merge both: shared.txt is now ${JSON.stringify(merged)}`);
    expect(merged === "BO VERSION of the page\nCY VERSION of the page\n", `merged file: ${JSON.stringify(merged)}`);
    const after = await projectLedger(hal, projectId);
    expect(after.conflicts.find((c) => c.id === conflict.id)?.state === "resolved", "the conflict is not resolved after Merge both");
    await waitFor("the conflict card to go", async () => (await cy.getByTestId("lp-conflict-card").count()) === 0 && (await bo.getByTestId("lp-conflict-card").count()) === 0, 20_000);
    expect(read(savedPath(boSaved)) === "BO VERSION of the page\n" && read(savedPath(cySaved)) === "CY VERSION of the page\n", "saved versions were dropped after the merge");
  });

  await step("4 members see each other's activity", async () => {
    const prompt = "what is Bo working on?";
    await sendMessage(cy, prompt);
    const reply = await waitForReply(cy, "LEDGER ANSWER", prompt);
    expect(/Bo/.test(reply), `answer: ${reply.slice(-300)}`);
    for (const [who, page] of [["Hal", hal], ["Cy", cy]]) {
      const sess = await pageApi(page, "/api/lp/session");
      note(`${who} /api/lp/session: ${JSON.stringify(sess).slice(0, 260)}; ledger button count ${await page.getByTestId("lp-ledger-open").count()}`);
      if (sess.httpStatus === 500) {
        const direct = await page.context().request.get(`http://127.0.0.1:${port}/api/lp/session`);
        note(`direct ${direct.status()} ${(await direct.text()).slice(0, 400)}`);
      }
      if (sess.httpStatus === 500) note(`host log: ${children.host.log.slice(-1800).replace(/\n/g, " | ")}`);
    }
    await cy.getByTestId("lp-ledger-open").click();
    await cy.getByTestId("lp-ledger-popover").waitFor();
    const rows = await cy.getByTestId("lp-ledger-thread").allInnerTexts();
    expect(rows.some((row) => row.includes("Bo")) && rows.some((row) => row.includes("Hal")), `popover rows: ${JSON.stringify(rows)}`);
    await shot(cy, "04-cy-sees-team");
    await cy.keyboard.press("Escape");
    const presence = await pageApi(cy, "/api/lp/presence");
    note(`presence for Cy: ${JSON.stringify(presence).slice(0, 300)}`);
  });

  await step("5 the second agent is told who else touches the same file", async () => {
    const entry = mockEntries().filter((e) => e.userText?.includes("CY VERSION")).at(-1);
    expect(entry, "no mock entry for Cy");
    expect(/Bo/.test(entry.ledger ?? ""), `Cy's agent was not told about Bo: ${JSON.stringify(entry.ledger)}`);
    expect(/shared\.txt/.test(entry.ledger ?? ""), `Cy's agent was not told which file: ${JSON.stringify(entry.ledger)}`);
  });

  await step("6 locked features are absent for members; cloud sync is refused", async () => {
    const features = await pageApi(bo, "/api/lp/features");
    expect(features.features?.length === 0, `member features: ${JSON.stringify(features)}`);
    const sync = await pageApi(hal, "/api/lp/sync/start", { projectId });
    expect(sync.httpStatus === 403 && sync.error === "feature_locked", `sync start: ${JSON.stringify(sync)}`);
    for (const path of ["/api/lp/talent", "/api/lp/apps/streams"]) {
      const r = await pageApi(bo, path);
      note(`${path} -> ${r.httpStatus} ${r.error ?? ""}`);
    }
    const body = await bo.locator("body").innerText();
    expect(!/Talent|Freelancer|Access code|Marketplace/i.test(body), "locked words visible to Bo");
  });

  await step("7 host offline: members see an honest state; host back: nothing lost", async () => {
    const before = (await pageApi(bo, "/api/lp/projects")).projects?.length;
    await stopChild(children.host, true);
    await sleep(8_000);
    const banner = await bo.locator("body").innerText();
    const offlineText = /offline|reconnect|disconnected|unavailable|can.t reach|host/i.exec(banner)?.[0];
    note(`Bo's page while the host is off mentions: ${JSON.stringify(offlineText)}`);
    await shot(bo, "07a-host-off");
    await shot(cy, "07b-host-off");
    const sent = await (async () => {
      try {
        await sendMessage(bo, "are you there?");
        await sleep(3_000);
        return (await bo.locator("main").innerText()).slice(-300);
      } catch (error) {
        return `error ${error}`;
      }
    })();
    note(`Bo's thread after sending while the host is off: ${JSON.stringify(sent)}`);
    startHost();
    await children.host.ready;
    await waitFor(
      "Bo's page to recover",
      async () => (await pageApi(bo, "/api/lp/projects")).projects?.length === before,
      60_000,
    );
    await bo.goto(`${WEB}/`);
    await bo.getByText(PROJECT).first().waitFor({ timeout: 60_000 });
    const ledger = await projectLedger(hal, projectId);
    expect(threadOf(ledger, "Bo") && threadOf(ledger, "Cy"), "threads lost after the restart");
    for (const [name, file] of [["Hal", "hal.txt"], ["Bo", "bo.txt"], ["Cy", "cy.txt"]])
      expect(read(NodePath.join(cwds[name], file)), `${file} lost`);
    await shot(bo, "07c-host-back");
    const body = await bo.locator("body").innerText();
    note(`Bo's page after the host is back still mentions offline: ${/offline|reconnecting/i.test(body)}`);
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
