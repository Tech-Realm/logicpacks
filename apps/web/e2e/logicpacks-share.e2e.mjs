#!/usr/bin/env node
// Sharing with people who have no account, end to end (Vite dev client, no build):
//   node apps/web/e2e/logicpacks-share.e2e.mjs [--port 3871] [--web-port 5806] [--shots <dir>] [--keep]
// A local SMTP server stands in for LOGICPACKS_SMTP_URL; Bo follows the link from that email.
// Steps: bad email hint, pending invite + email, Bo signs up via it, link on/off/reset.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeNet from "node:net";
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
const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lp-share-e2e-"));
if (shotsDir) NodeFS.mkdirSync(shotsDir, { recursive: true });
const run = Date.now().toString(36).slice(-6);
const PASSWORD = "correct-horse-battery";
const ANA = `ana-${run}@example.com`;
const BO = `bo-${run}@example1.com`;
const CY = `cy-${run}@example.com`;
const PROJECT = `Share test ${run}`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── Fake SMTP relay ─────────────────────────────────────────────────────────
const mails = [];
const smtp = NodeNet.createServer((socket) => {
  let buffer = "";
  let data = null;
  socket.write("220 e2e ESMTP\r\n");
  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let index;
    while ((index = buffer.indexOf("\r\n")) !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      if (data !== null) {
        if (line === ".") {
          mails.push(data.join("\r\n"));
          data = null;
          socket.write("250 queued\r\n");
        } else data.push(line.startsWith("..") ? line.slice(1) : line);
        continue;
      }
      if (line.startsWith("EHLO")) socket.write("250-e2e\r\n250 AUTH PLAIN\r\n");
      else if (line.startsWith("AUTH")) socket.write("235 ok\r\n");
      else if (line === "DATA") {
        data = [];
        socket.write("354 go\r\n");
      } else if (line === "QUIT") socket.end("221 bye\r\n");
      else socket.write("250 ok\r\n");
    }
  });
  socket.on("error", () => undefined);
});
await new Promise((resolve) => smtp.listen(0, "127.0.0.1", resolve));
const smtpPort = smtp.address().port;

/** The text part of a captured message, decoded. */
const mailText = (raw) => {
  const parts = raw.split(/\r\n--lp-[0-9a-f]+/);
  const textPart = parts.find((part) => part.includes("Content-Type: text/plain"));
  const body = textPart.split("\r\n\r\n").slice(1).join("").replace(/\r\n/g, "");
  return Buffer.from(body, "base64").toString("utf8");
};
const subjectOf = (raw) => /^Subject: (.*)$/m.exec(raw)?.[1] ?? "";

// ── Processes ───────────────────────────────────────────────────────────────
const home = NodePath.join(root, "host");
NodeFS.mkdirSync(NodePath.join(home, "userdata"), { recursive: true });
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
    await sleep(400);
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
async function newPage(browser) {
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: WEB });
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
async function openShareDialog(page) {
  const button = page.getByTestId("lp-share-project-open").first();
  await button.waitFor({ timeout: 30_000 });
  await button.click();
  await page.getByRole("dialog").getByText(`Share ${PROJECT}`).waitFor({ timeout: 15_000 });
}
const clipboard = (page) => page.evaluate(() => navigator.clipboard.readText());
const visibleProjects = async (page) =>
  ((await pageApi(page, "/api/lp/projects")).projects ?? []).map((project) => project.title);

let browser;
try {
  const env = {
    ...process.env,
    LOGICPACKS_CLOUD_HOST: "true",
    // Cloud workspaces (coming soon without a code) are not under test here.
    LOGICPACKS_MEMBER_FEATURES: "cloud",
    LOGICPACKS_SYNC_SECONDS: "0",
    LOGICPACKS_SMTP_URL: `smtp://e2e:e2e@127.0.0.1:${smtpPort}`,
    LOGICPACKS_MAIL_FROM: "LogicPacks <invites@logicpacks.io>",
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
  let bo;
  let cy;
  let oldLink;

  await step("1 an incomplete email gets a gentle inline hint, not a red error", async () => {
    ana = await newPage(browser);
    await signUpOnLanding(ana, "Ana", ANA);
    const created = await pageApi(ana, "/api/lp/projects/new", { kind: "empty", name: PROJECT });
    expect(created.projectId, `project not created: ${JSON.stringify(created)}`);
    await openProject(ana, PROJECT);
    await openShareDialog(ana);
    const dialog = ana.getByRole("dialog");
    await dialog.getByLabel("Email or name").fill("test@example1");
    await dialog.getByTestId("lp-share-project").click();
    const hint = dialog.getByTestId("lp-share-hint");
    await hint.waitFor();
    expect(/looks incomplete/.test(await hint.innerText()), "no incomplete-email hint");
    expect((await dialog.getByRole("alert").count()) === 0, "a red alert is shown");
    await shot(ana, "01-invalid-email-hint");
  });

  await step("2 an email with no account becomes Invited, pending, and gets an email", async () => {
    const dialog = ana.getByRole("dialog");
    await dialog.getByLabel("Email or name").fill(BO);
    await dialog.getByTestId("lp-share-project").click();
    const row = dialog.getByTestId("lp-share-pending");
    await row.waitFor({ timeout: 15_000 });
    expect((await row.innerText()).includes("Invited, pending"), "no pending label");
    expect((await row.innerText()).includes(BO), "pending row lacks the email");
    expect(
      /emailed them/.test(await dialog.getByTestId("lp-share-hint").innerText()),
      "no emailed note",
    );
    await row.getByTestId("lp-share-pending-copy").click();
    const copied = await waitFor("the copied invite link", async () => {
      const text = await clipboard(ana);
      return text.includes("/lp/join/project?invite=") ? text : null;
    });
    await waitFor("the invite email", async () => mails.length >= 1);
    expect(
      subjectOf(mails[0]) === `Ana shared ${PROJECT} with you on LogicPacks`,
      `subject: ${subjectOf(mails[0])}`,
    );
    const text = mailText(mails[0]);
    expect(text.includes(copied), `email link differs from the copied one:\n${text}`);
    expect(!text.includes("—"), "an em-dash in the email");
    await shot(ana, "02-pending-invite");
    // Resend sends a second email with the same link.
    await row.getByTestId("lp-share-pending-resend").click();
    await waitFor("the resent email", async () => mails.length >= 2);
    expect(mailText(mails[1]).includes(copied), "resent email has another link");
  });

  await step("3 Bo opens the emailed link, signs up and lands with the project", async () => {
    const link = /https?:\/\/\S+\/lp\/join\/project\?invite=\S+/.exec(mailText(mails[0]))[0];
    // The email names the host's public origin; the browser reaches it through the dev client.
    const url = new URL(link);
    bo = await newPage(browser);
    await bo.goto(`${WEB}${url.pathname}${url.search}`);
    await bo.locator("h1", { hasText: "Join the project" }).waitFor({ timeout: 30_000 });
    expect((await bo.inputValue("#email")) === BO, "email not prefilled");
    await shot(bo, "03-join-page-invite");
    await bo.fill("#name", "Bo");
    await bo.fill("#password", PASSWORD);
    await bo.click("#submit");
    await bo.waitForURL((u) => u.origin === WEB && !u.pathname.startsWith("/lp/"), {
      timeout: 30_000,
    });
    expect((await visibleProjects(bo)).includes(PROJECT), "Bo cannot see the project");
    await bo.getByText(PROJECT).first().waitFor({ timeout: 60_000 });
    await shot(bo, "04-bo-lands-in-project");
    // Ana's dialog now lists Bo as a member and no pending invite.
    await ana.getByRole("dialog").getByText("Share link").first().waitFor();
    await ana.keyboard.press("Escape");
    await openShareDialog(ana);
    const dialog = ana.getByRole("dialog");
    await dialog.getByText(BO).first().waitFor();
    expect((await dialog.getByTestId("lp-share-pending").count()) === 0, "invite still pending");
  });

  await step("4 Ana turns the share link on and sees its controls", async () => {
    const dialog = ana.getByRole("dialog");
    await dialog.getByTestId("lp-share-link-toggle").click();
    const input = dialog.getByTestId("lp-share-link-url");
    await input.waitFor({ timeout: 15_000 });
    oldLink = await input.inputValue();
    expect(oldLink.includes("/lp/join/project?invite="), `odd link ${oldLink}`);
    await dialog.getByTestId("lp-share-link-copy").click();
    await waitFor("the copied share link", async () => (await clipboard(ana)) === oldLink);
    expect((await dialog.getByText("7 days").count()) > 0, "no 7 day expiry");
    expect((await dialog.getByText(/Member/).count()) > 0, "no member role note");
    await shot(ana, "05-share-link-on");
  });

  await step("5 Ana turns the link off and a third user is turned away", async () => {
    const dialog = ana.getByRole("dialog");
    await dialog.getByTestId("lp-share-link-toggle").click();
    await waitFor(
      "the link to hide",
      async () => (await dialog.getByTestId("lp-share-link-url").count()) === 0,
    );
    await shot(ana, "06-share-link-off");
    cy = await newPage(browser);
    await signUpOnLanding(cy, "Cy", CY);
    await cy.goto(oldLink.replace(/^https?:\/\/[^/]+/, WEB));
    await cy.getByText("This link has been turned off").waitFor({ timeout: 30_000 });
    expect(!(await visibleProjects(cy)).includes(PROJECT), "Cy got in through a closed link");
    const api = await pageApi(cy, "/api/lp/join/project", {
      invite: new URL(oldLink).searchParams.get("invite"),
      mode: "session",
    });
    expect(
      api.httpStatus === 410 && api.error === "link_off",
      `server let Cy in: ${JSON.stringify(api)}`,
    );
    await shot(cy, "07-third-user-link-off");
  });

  await step("6 Ana resets the link: the old link fails, the new one works", async () => {
    const dialog = ana.getByRole("dialog");
    await dialog.getByTestId("lp-share-link-toggle").click();
    await dialog.getByTestId("lp-share-link-url").waitFor();
    await dialog.getByTestId("lp-share-link-reset").click();
    const newLink = await waitFor("a new link", async () => {
      const value = await dialog.getByTestId("lp-share-link-url").inputValue();
      return value !== oldLink ? value : null;
    });
    await cy.goto(oldLink.replace(/^https?:\/\/[^/]+/, WEB));
    await cy.getByText("This invite link is no longer valid").waitFor({ timeout: 30_000 });
    expect(!(await visibleProjects(cy)).includes(PROJECT), "the old link let Cy in");
    await shot(cy, "08-old-link-after-reset");
    await cy.goto(newLink.replace(/^https?:\/\/[^/]+/, WEB));
    await cy.waitForURL((u) => u.origin === WEB && !u.pathname.startsWith("/lp/"), {
      timeout: 30_000,
    });
    expect((await visibleProjects(cy)).includes(PROJECT), "the new link did not let Cy in");
    await ana.keyboard.press("Escape");
    await openShareDialog(ana);
    await ana.getByRole("dialog").getByTestId("lp-share-link-joins").getByText(CY).waitFor();
    await shot(ana, "09-joined-with-link");
  });
} catch (error) {
  failed = true;
  console.log(`ERROR ${String(error?.stack ?? error)}`);
} finally {
  await browser?.close().catch(() => undefined);
  await stopAll();
  smtp.close();
  if (!keep) NodeFS.rmSync(root, { recursive: true, force: true });
}

const passed = results.filter((result) => result.ok).length;
console.log(`\n${passed}/${results.length} steps passed`);
for (const result of results.filter((entry) => !entry.ok))
  console.log(`- ${result.name}: ${result.error}`);
process.exit(failed ? 1 : 0);
