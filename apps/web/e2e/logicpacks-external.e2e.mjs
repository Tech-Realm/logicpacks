#!/usr/bin/env node
// Vetted freelancers (Beta) and feature access codes, end to end:
//   node apps/web/e2e/logicpacks-external.e2e.mjs [--port 3881] [--web-port 5816] [--shots <dir>] [--keep]
//     [--results <file>]
// One cloud host from this tree and the Vite dev client in front of it (no production build).
// Every agent is the scripted ACP mock (lp-ledger-mock-agent.mjs); briefs use the built-in
// template estimator (LOGICPACKS_EXTERNAL_DRAFT=template), so no model or paid API is called.
//   1 staff (Sam) opens /ops and makes access codes; a code can be revoked
//   2 a locked user (Lee) sees no packs or talent UI, gets 403 feature_locked, and core works
//   3 Dana signs up with an access code and talent unlocks; a used-up code is refused
//   4 /pricing shows PKR for CF-IPCountry PK and How we vet
//   5 Dana (CF-IPCountry PK) asks for help on one screen, sees PKR, accepts
//   6 Sam sees the brief on /ops, suggests matches and assigns Omar K.
//   7 Omar joins through the invite; Dana's thread shows him and the hours
//   8 Omar cannot list or open .env and sees Dana's pasted key redacted
//   9 Omar cannot run on Dana's shared login until she allows it
//  10 Omar's agent edits outside the brief: Dana gets the drift decision dialog
//  11 staff log 6 hours; the thread shows 6 of N; overage needs a new offer
//  12 jobs board: staff publish, an invited freelancer runs lp jobs search/show/apply,
//     staff accept, she joins; a non-invited account is refused
//  13 Dana completes the work: Omar's access ends
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
const port = Number(option("--port", 3881));
const webPort = Number(option("--web-port", 5816));
const keep = args.includes("--keep");
const shotsDir = option("--shots", null);
const resultsFile = option("--results", null);
const WEB = `http://127.0.0.1:${webPort}`;
const HOST = `http://127.0.0.1:${port}`;
const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const repo = NodePath.join(here, "../../..");
const serverDir = NodePath.join(repo, "apps/server");
const webDir = NodePath.join(repo, "apps/web");
const helperCli = NodePath.join(repo, "packages/helper/src/cli.ts");
const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lp-external-e2e-"));
if (shotsDir) NodeFS.mkdirSync(shotsDir, { recursive: true });
const run = Date.now().toString(36).slice(-6);
const PASSWORD = "correct-horse-battery";
const email = (name) => `${name}-${run}@example.com`;
const OMAR_EMAIL = "omar-k@talent.logicpacks.internal";
const PASTED_KEY = `sk-ant-api03-${run}abcdefghijklmnopqrstuvwxyz`;
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
const shot = async (page, name) => {
  if (!shotsDir) return;
  for (const scheme of ["dark", "light"]) {
    await page.emulateMedia({ colorScheme: scheme });
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
/** One WebSocket RPC as this browser session (cookie auth), for checks the UI does not expose directly. */
const wsRpc = (page, tag, payload) =>
  page.evaluate(
    async ([tag, payload, ports]) => {
      const attempt = (origin) =>
        new Promise((resolve) => {
          const socket = new WebSocket(`${origin}/ws?orchestrationProtocol=2`);
          const timer = setTimeout(() => {
            socket.close();
            resolve({ error: "timeout" });
          }, 15_000);
          socket.onopen = () =>
            socket.send(JSON.stringify({ _tag: "Request", id: "1", tag, payload, headers: [] }));
          socket.onmessage = (event) => {
            const messages = [].concat(JSON.parse(String(event.data)));
            for (const message of messages) {
              if (message._tag === "Exit" && String(message.requestId) === "1") {
                clearTimeout(timer);
                socket.close();
                resolve({ exit: message.exit });
              }
            }
          };
          socket.onerror = () => {
            clearTimeout(timer);
            resolve({ error: "socket error" });
          };
        });
      for (const origin of ports) {
        const result = await attempt(origin);
        if (!result.error) return result;
      }
      return { error: "no socket" };
    },
    [tag, payload, [`ws://${new URL(WEB).host}`, `ws://${new URL(HOST).host}`]],
  );
/** Reads a WebSocket RPC stream as this session for a few seconds; returns the raw JSON text. */
const wsStream = (page, tag, payload, ms = 6000) =>
  page.evaluate(
    async ([tag, payload, origin, ms]) =>
      new Promise((resolve) => {
        const socket = new WebSocket(`${origin}/ws?orchestrationProtocol=2`);
        const seen = [];
        socket.onopen = () =>
          socket.send(JSON.stringify({ _tag: "Request", id: "1", tag, payload, headers: [] }));
        socket.onmessage = (event) => {
          seen.push(String(event.data));
          const messages = [].concat(JSON.parse(String(event.data)));
          for (const message of messages) {
            if (message._tag === "Chunk")
              socket.send(JSON.stringify({ _tag: "Ack", requestId: "1" }));
          }
        };
        setTimeout(() => {
          socket.close();
          resolve(seen.join("\n"));
        }, ms);
      }),
    [tag, payload, `ws://${new URL(WEB).host}`, ms],
  );
async function newPage(browser, headers = {}) {
  const context = await browser.newContext({
    viewport: { width: 1360, height: 900 },
    extraHTTPHeaders: headers,
  });
  const page = await context.newPage();
  pages.push(page);
  return page;
}
async function signUp(page, name, address, code = null) {
  await page.goto(`${WEB}/lp/login`);
  await page.click("#tab-signup");
  await page.fill("#name", name);
  await page.fill("#email", address);
  await page.fill("#password", PASSWORD);
  if (code !== null) {
    await page.getByTestId("lp-access-code-toggle").click();
    await page.getByTestId("lp-access-code-input").fill(code);
  }
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
const features = async (page) => (await pageApi(page, "/api/lp/features")).features ?? [];
const helperEnv = (name) => {
  const base = NodePath.join(root, `${name}-home`);
  NodeFS.mkdirSync(base, { recursive: true });
  return {
    ...process.env,
    LP_HELPER_HOME: NodePath.join(base, "lp"),
    HOME: base,
    CODEX_HOME: NodePath.join(base, "codex"),
    CLAUDE_CONFIG_DIR: NodePath.join(base, "claude"),
  };
};
const lp = (env, cliArgs) => {
  const out = NodeChildProcess.spawnSync(process.execPath, [helperCli, ...cliArgs], {
    env,
    encoding: "utf8",
    timeout: 60_000,
  });
  return { code: out.status, text: `${out.stdout}${out.stderr}` };
};
async function helperLogin(page, name) {
  const token = await pageApi(page, "/api/lp/helper/token", { device: `${name}-laptop` });
  expect(token.token, `no helper token for ${name}: ${JSON.stringify(token)}`);
  const env = helperEnv(name);
  const login = lp(env, ["login", "--server", HOST, "--token", token.token, "--no-mcp"]);
  expect(login.code === 0, `lp login for ${name}: ${login.text}`);
  return env;
}
const opsInbox = async (page) => (await pageApi(page, "/api/lp/ops/inbox")).offers ?? [];

let browser;
try {
  const env = {
    ...process.env,
    LOGICPACKS_CLOUD_HOST: "true",
    LOGICPACKS_MEMBERS_OWN_PROVIDERS: "false",
    LOGICPACKS_SYNC_SECONDS: "0",
    LOGICPACKS_GOALS_JUDGE: "off",
    LOGICPACKS_EXTERNAL_DRAFT: "template",
    // Cloud workspaces (coming soon without a code) are not under test here.
    LOGICPACKS_MEMBER_FEATURES: "cloud",
    LOGICPACKS_STAFF_EMAILS: email("sam"),
    LOGICPACKS_FEATURES_FREELANCER_JOBS: email("fatima"),
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

  let sam;
  let lee;
  let dana;
  let omar;
  let fatima;
  let talentCode;
  let projectId;
  let danaThreadPath;
  let offer;
  let projectRoot;
  const PROJECT = `Storefront ${run}`;
  const NEED =
    "Set up a complete GitHub Actions deploy pipeline to our VPS with nginx, SSL certificates and monitoring in deploy/";

  await step("1 staff open /ops and make access codes; a code can be revoked", async () => {
    sam = await newPage(browser);
    await signUp(sam, "Sam", email("sam"));
    await sam.goto(`${WEB}/ops`);
    await sam.getByTestId("lp-ops-tab-codes").click();
    await sam.getByTestId("lp-ops-code-feature-talent").check();
    await sam.getByTestId("lp-ops-code-max").fill("1");
    await sam.getByTestId("lp-ops-code-create").click();
    talentCode = (await sam.getByTestId("lp-ops-code-value").innerText()).trim();
    expect(
      /^LP-[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/.test(talentCode),
      `code shape: ${talentCode}`,
    );
    const listed = await pageApi(sam, "/api/lp/ops/codes");
    expect(!JSON.stringify(listed).includes(talentCode), "the plain code is stored or listed");
    const revokable = await pageApi(sam, "/api/lp/ops/codes", {
      features: ["packs"],
      maxUses: 5,
      expiresInDays: 7,
      note: "to revoke",
    });
    expect(revokable.httpStatus === 201, `second code: ${JSON.stringify(revokable)}`);
    await sam.reload();
    await sam.getByTestId("lp-ops-tab-codes").click();
    const row = sam.locator(`[data-testid="lp-ops-code-row"]`, { hasText: "to revoke" });
    await row.getByTestId("lp-ops-code-revoke").click();
    await waitFor("revoked status", async () => (await row.innerText()).includes("Revoked"));
    sam.revokedCode = revokable.code;
    await shot(sam, "external-ops-codes");
  });

  await step(
    "2 a locked user sees no packs or talent UI, gets 403 feature_locked; core works",
    async () => {
      lee = await newPage(browser);
      await signUp(lee, "Lee", email("lee"));
      expect(
        !(await features(lee)).some((f) =>
          ["talent", "packs", "apps", "freelancer_jobs"].includes(f),
        ),
        `Lee has features: ${await features(lee)}`,
      );
      const created = await pageApi(lee, "/api/lp/projects/new", {
        kind: "empty",
        name: `Lee ${run}`,
      });
      expect(created.projectId, `Lee's project: ${JSON.stringify(created)}`);
      await openProject(lee, `Lee ${run}`);
      await sendMessage(lee, "Hello from Lee");
      await waitForReply(lee, "Done.", "Hello from Lee");
      await sleep(1500);
      for (const testId of ["lp-external-open", "lp-save-pack", "packs-demo-entry"]) {
        expect(
          (await lee.getByTestId(testId).count()) === 0,
          `${testId} is visible to a locked user`,
        );
      }
      const packs = await pageApi(lee, `/api/lp/packs?projectId=${created.projectId}`);
      expect(
        packs.httpStatus === 403 && packs.error === "feature_locked" && packs.feature === "packs",
        `packs: ${JSON.stringify(packs)}`,
      );
      const draft = await pageApi(lee, "/api/lp/external/draft", {
        projectId: created.projectId,
        need: NEED,
      });
      expect(
        draft.httpStatus === 403 && draft.error === "feature_locked",
        `draft: ${JSON.stringify(draft)}`,
      );
      const revoked = await pageApi(lee, "/api/lp/features/redeem", { code: sam.revokedCode });
      expect(
        revoked.httpStatus === 410 && revoked.error === "revoked",
        `revoked code: ${JSON.stringify(revoked)}`,
      );
      await lee.goto(`${WEB}/ops`);
      await lee.getByTestId("lp-ops-forbidden").waitFor({ timeout: 20_000 });
      // Staff have every feature: packs answers them.
      const samPacks = await pageApi(sam, `/api/lp/packs?projectId=${created.projectId}`);
      expect(
        samPacks.error !== "feature_locked",
        `staff packs: ${JSON.stringify(samPacks).slice(0, 200)}`,
      );
    },
  );

  await step(
    "3 Dana signs up with an access code: talent unlocks; the used-up code is refused",
    async () => {
      dana = await newPage(browser, { "cf-ipcountry": "PK" });
      await signUp(dana, "Dana", email("dana"), talentCode);
      await waitFor("talent unlocked", async () => (await features(dana)).includes("talent"));
      const again = await pageApi(lee, "/api/lp/features/redeem", {
        code: talentCode.toLowerCase(),
      });
      expect(
        again.httpStatus === 410 && again.error === "used_up",
        `used-up code: ${JSON.stringify(again)}`,
      );
      const codes = await pageApi(sam, "/api/lp/ops/codes");
      const used = codes.codes.find((c) => c.features.includes("talent"));
      expect(used.uses === 1 && used.status === "used_up", `uses: ${JSON.stringify(used)}`);
    },
  );

  await step("4 /pricing shows PKR for CF-IPCountry PK and How we vet", async () => {
    await dana.goto(`${WEB}/pricing`);
    const rates = dana.getByTestId("lp-pricing-rates");
    await rates.waitFor({ timeout: 30_000 });
    expect((await rates.getAttribute("data-currency")) === "PKR", "pricing currency");
    expect((await rates.innerText()).includes("PKR"), "rates not in PKR");
    const vet = await dana.getByTestId("lp-how-we-vet").innerText();
    for (const check of [
      "Identity verified",
      "Skills test passed",
      "NDA signed",
      "Keys-never-shared policy",
    ]) {
      expect(vet.includes(check), `How we vet lacks ${check}`);
    }
    const page = await dana.locator("main").innerText();
    expect(!page.includes("—") && !/enterprise/i.test(page), "copy rules");
    await shot(dana, "external-pricing");
  });

  await step("5 Dana asks for help on one screen, sees PKR, accepts", async () => {
    const created = await pageApi(dana, "/api/lp/projects/new", { kind: "empty", name: PROJECT });
    expect(created.projectId, `project not created: ${JSON.stringify(created)}`);
    projectId = created.projectId;
    await openProject(dana, PROJECT);
    const envPrompt = `edit .env API_TOKEN=${PASTED_KEY}`;
    await sendMessage(dana, envPrompt);
    await waitForReply(dana, "Edited .env", envPrompt);
    danaThreadPath = new URL(dana.url()).pathname;
    const appPrompt = "edit src/app.ts export const ok = 1";
    await sendMessage(dana, appPrompt);
    await waitForReply(dana, "Edited src/app.ts", appPrompt);
    const logged = NodeFS.readFileSync(mockLog, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .find((entry) => typeof entry.userText === "string" && entry.userText.includes("edit .env"));
    projectRoot = logged?.cwd;
    expect(
      projectRoot && NodeFS.existsSync(NodePath.join(projectRoot, ".env")),
      `.env not written (${projectRoot})`,
    );

    await dana.getByTestId("lp-external-open").click();
    const dialog = dana.getByTestId("lp-external-dialog");
    await dialog.waitFor();
    await dialog.getByTestId("lp-external-need").fill(NEED);
    await dialog.getByTestId("lp-external-see-price").click();
    const price = dialog.getByTestId("lp-external-price");
    await price.waitFor({ timeout: 30_000 });
    expect((await price.getAttribute("data-currency")) === "PKR", "price is not in PKR");
    const quoteText = await dialog.getByTestId("lp-external-quote").innerText();
    expect(
      quoteText.includes("You pay for the person's hours. Their AI is included."),
      "price copy",
    );
    expect(/Saves roughly .* agent tokens \(an estimate\)/.test(quoteText), "token estimate");
    expect(quoteText.includes("Payment: invoiced"), "payment line");
    expect(quoteText.includes("built-in estimator"), "template note");
    expect(
      (await dialog.innerText()).includes("Brings their own AI tools. Uses none of your tokens."),
      "BYO AI copy",
    );
    await shot(dana, "external-request-quote");
    await dialog.getByTestId("lp-external-accept").click();
    await dialog.getByTestId("lp-external-accepted").waitFor({ timeout: 20_000 });
    const offers = (await pageApi(dana, `/api/lp/external/offers?projectId=${projectId}`)).offers;
    offer = offers.find((o) => o.status === "accepted");
    expect(
      offer?.quote.currency === "PKR" && offer.regionSource === "cf-ipcountry PK",
      `offer: ${JSON.stringify(offer).slice(0, 400)}`,
    );
    expect(offer.charge?.status === "invoiced", `charge: ${JSON.stringify(offer.charge)}`);
    await dana.keyboard.press("Escape");
  });

  await step("6 staff see the brief on /ops, suggest matches and assign Omar K.", async () => {
    await sam.goto(`${WEB}/ops`);
    const card = sam.locator(`[data-testid="lp-ops-offer"][data-offer-id="${offer.id}"]`);
    await card.waitFor({ timeout: 30_000 });
    expect(
      (await card.getByTestId("lp-ops-brief-scope").innerText()).includes("deploy"),
      "brief scope",
    );
    await card.getByTestId("lp-ops-suggest").click();
    const omarCard = card.locator('[data-testid="lp-talent-card"][data-talent-id="omar-k"]');
    await omarCard.waitFor({ timeout: 20_000 });
    expect((await omarCard.getByTestId("lp-vetted-badge").count()) === 1, "vetted badge");
    expect(
      (await omarCard.getByTestId("lp-talent-tools").innerText()).includes(
        "Uses none of your tokens",
      ),
      "tools copy",
    );
    await shot(sam, "external-ops-matches");
    await omarCard.getByTestId("lp-ops-assign").click();
    offer = await waitFor("the offer assigned", async () => {
      const current = (await opsInbox(sam)).find((o) => o.id === offer.id);
      return current?.status === "assigned" && current.assignment?.invitePath ? current : null;
    });
    expect(offer.assignment.email === OMAR_EMAIL, `assigned to ${offer.assignment.email}`);
  });

  await step("7 Omar joins through the invite; Dana's thread shows him and the hours", async () => {
    omar = await newPage(browser);
    await omar.goto(`${WEB}${offer.assignment.invitePath}`);
    await omar.getByText("You're invited to").waitFor({ timeout: 60_000 });
    await omar.fill("#name", "Omar K.");
    await omar.fill("#email", OMAR_EMAIL);
    await omar.fill("#password", PASSWORD);
    await omar.click("#submit");
    await omar.waitForURL((url) => url.origin === WEB && !url.pathname.startsWith("/lp/"), {
      timeout: 30_000,
    });
    offer = await waitFor("the offer active", async () => {
      const current = (
        await pageApi(dana, `/api/lp/external/offers?projectId=${projectId}`)
      ).offers.find((o) => o.id === offer.id);
      return current?.status === "active" ? current : null;
    });
    await dana.goto(`${WEB}${danaThreadPath}`);
    const banner = dana.getByTestId("lp-external-joined");
    await banner.waitFor({ timeout: 30_000 });
    const text = await banner.innerText();
    expect(
      text.includes(
        `Omar K. (vetted devops freelancer) joined: 0 of ${offer.quote.hours} hours used`,
      ),
      `banner: ${text}`,
    );
    await shot(dana, "external-joined-banner");
  });

  await step("8 Omar cannot list or open .env and sees Dana's pasted key redacted", async () => {
    const danaList = await wsRpc(dana, "projects.listEntries", { cwd: projectRoot });
    const danaPaths = (danaList.exit?.value?.entries ?? []).map((e) => e.path);
    expect(danaPaths.includes(".env"), `Dana's listing: ${JSON.stringify(danaList).slice(0, 400)}`);
    const omarList = await wsRpc(omar, "projects.listEntries", { cwd: projectRoot });
    const omarPaths = (omarList.exit?.value?.entries ?? []).map((e) => e.path);
    expect(
      omarList.exit?._tag === "Success" && omarPaths.some((p) => p.startsWith("src")),
      `Omar's listing: ${JSON.stringify(omarList).slice(0, 400)}`,
    );
    expect(!omarPaths.includes(".env"), `Omar sees .env: ${omarPaths}`);
    const read = await wsRpc(omar, "projects.readFile", { cwd: projectRoot, relativePath: ".env" });
    expect(
      read.exit?._tag === "Failure" &&
        JSON.stringify(read).includes("hidden from vetted freelancers"),
      `read: ${JSON.stringify(read).slice(0, 400)}`,
    );
    const readApp = await wsRpc(omar, "projects.readFile", {
      cwd: projectRoot,
      relativePath: "src/app.ts",
    });
    expect(readApp.exit?._tag === "Success", `app.ts: ${JSON.stringify(readApp).slice(0, 300)}`);
    // Straight from the host, as Omar: the thread snapshot carries no pasted key.
    const danaThreadId = danaThreadPath.split("/").filter(Boolean).at(-1);
    const raw = await wsStream(omar, "orchestration.subscribeThread", {
      threadId: danaThreadId,
      acceptCompactTurnItems: true,
      acceptDedupedBodies: true,
    });
    expect(
      raw.includes('"kind":"snapshot"') && !raw.includes(PASTED_KEY),
      `raw thread stream for Omar: ${raw.slice(0, 300)}`,
    );
    await omar.goto(`${WEB}${danaThreadPath}`);
    // The message itself, not only the thread title.
    await waitFor(
      "Dana's messages for Omar",
      async () => (await omar.locator("main").innerText()).includes("Edited src/app.ts"),
      45_000,
    );
    const seen = await omar.locator("main").innerText();
    const at = seen.indexOf(PASTED_KEY);
    expect(
      at === -1 && seen.includes("[redacted]"),
      `Omar sees the pasted key: ${JSON.stringify(seen.slice(Math.max(0, at - 200), at + 80))}`,
    );
    const danaSees = await dana.locator("main").innerText();
    expect(danaSees.includes(PASTED_KEY), "Dana no longer sees her own message");
  });

  await step("9 Omar cannot run on Dana's shared login until she allows it", async () => {
    await openProject(omar, PROJECT);
    const prompt = `Hello from Omar ${run}`;
    await sendMessage(omar, prompt);
    await waitFor(
      "the host's refusal",
      async () =>
        (await omar.locator("body").innerText()).includes(
          "Vetted freelancers run on their own AI login",
        ),
      60_000,
    );
    await shot(omar, "external-own-login-refused");
    await dana.getByTestId("lp-external-open").click();
    const row = dana.locator(`[data-testid="lp-external-offer"][data-offer-id="${offer.id}"]`);
    await row.getByTestId("lp-external-shared-login").click();
    await waitFor(
      "shared login allowed",
      async () =>
        (await pageApi(dana, `/api/lp/external/offers?projectId=${projectId}`)).offers.find(
          (o) => o.id === offer.id,
        )?.allowSharedLogin === true,
    );
    await dana.keyboard.press("Escape");
    await openProject(omar, PROJECT);
    const retry = `Hello again from Omar ${run}`;
    const composer = omar.locator('[contenteditable="true"]').first();
    await composer.click();
    await omar.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
    await omar.keyboard.press("Backspace");
    await sendMessage(omar, retry);
    // The turn ran: the scripted agent saw the prompt.
    await waitFor(
      "Omar's turn on the shared login",
      async () =>
        NodeFS.existsSync(mockLog) && NodeFS.readFileSync(mockLog, "utf8").includes(retry),
      60_000,
    );
  });

  await step(
    "10 Omar's agent edits outside the brief: Dana gets the drift decision dialog",
    async () => {
      await omar.getByTestId("lp-goal-task-card").first().waitFor({ timeout: 45_000 });
      const prompt = "edit api/server.ts export const hacked = true";
      await sendMessage(omar, prompt);
      await waitFor(
        "Omar's agent to edit api/server.ts",
        async () => NodeFS.existsSync(NodePath.join(projectRoot, "api/server.ts")),
        90_000,
      );
      const dialog = dana.getByTestId("lp-decision-dialog");
      await dialog.waitFor({ timeout: 45_000 });
      expect((await dialog.getAttribute("data-kind")) === "goal.drift", "dialog kind");
      const title = await dana.getByTestId("lp-decision-title").innerText();
      expect(title.includes("api/server.ts"), `dialog title: ${title}`);
      await shot(dana, "external-drift-dialog");
      for (let i = 0; i < 6; i += 1) {
        if (!(await dialog.isVisible().catch(() => false))) break;
        await dialog.getByTestId("lp-decision-accept").click();
        await sleep(800);
      }
    },
  );

  await step(
    "11 staff log 6 hours; the thread shows 6 of N; overage needs a new offer",
    async () => {
      await sam.goto(`${WEB}/ops`);
      const card = sam.locator(`[data-testid="lp-ops-offer"][data-offer-id="${offer.id}"]`);
      await card.getByTestId("lp-ops-hours").fill("6");
      await card.getByTestId("lp-ops-log-hours").click();
      await waitFor(
        "6 hours logged",
        async () => (await opsInbox(sam)).find((o) => o.id === offer.id)?.hoursUsed === 6,
      );
      const over = await pageApi(sam, "/api/lp/external/hours", {
        offerId: offer.id,
        hours: offer.quote.hours,
      });
      expect(
        over.httpStatus === 409 && /new offer/.test(over.message ?? ""),
        `overage: ${JSON.stringify(over)}`,
      );
      await dana.goto(`${WEB}${danaThreadPath}`);
      await waitFor(
        "the banner at 6 hours",
        async () =>
          (await dana.getByTestId("lp-external-joined").innerText()).includes(
            `6 of ${offer.quote.hours} hours used`,
          ),
        45_000,
      );
      await shot(dana, "external-hours-banner");
    },
  );

  await step(
    "12 jobs board: publish, lp jobs search/show/apply, staff accept, she joins; others refused",
    async () => {
      const design = await pageApi(dana, "/api/lp/external/offers", {
        projectId,
        threadId: null,
        need: `Design a new logo and landing page look in Figma for ${PROJECT}, Dana's shop`,
        accept: true,
      });
      expect(
        design.httpStatus === 201 && design.offer.status === "accepted",
        `design offer: ${JSON.stringify(design).slice(0, 300)}`,
      );
      await sam.goto(`${WEB}/ops`);
      const card = sam.locator(`[data-testid="lp-ops-offer"][data-offer-id="${design.offer.id}"]`);
      await card.getByTestId("lp-ops-publish").click();
      await waitFor(
        "published",
        async () => (await opsInbox(sam)).find((o) => o.id === design.offer.id)?.published === true,
      );

      fatima = await newPage(browser);
      await signUp(fatima, "Fatima", email("fatima"));
      const fatimaEnv = await helperLogin(fatima, "fatima");
      const search = lp(fatimaEnv, ["jobs", "search", "--role", "designer"]);
      expect(
        search.code === 0 && search.text.includes(design.offer.id),
        `lp jobs search: ${search.text}`,
      );
      const show = lp(fatimaEnv, ["jobs", "show", design.offer.id]);
      expect(show.code === 0 && show.text.includes("Milestones:"), `lp jobs show: ${show.text}`);
      expect(
        !show.text.includes(PROJECT) && !show.text.includes("Dana"),
        `brief not redacted: ${show.text}`,
      );
      const apply = lp(fatimaEnv, [
        "jobs",
        "apply",
        design.offer.id,
        "--note",
        "I design logos and landing pages in Figma",
        "--hours",
        "6",
      ]);
      expect(apply.code === 0 && apply.text.includes("Applied"), `lp jobs apply: ${apply.text}`);

      const leeEnv = await helperLogin(lee, "lee");
      const refused = lp(leeEnv, ["jobs", "search"]);
      expect(
        refused.code !== 0 && refused.text.includes("Jobs are invite-only for now."),
        `Lee: ${refused.text}`,
      );

      await sam.reload();
      const applicant = sam
        .locator(`[data-testid="lp-ops-offer"][data-offer-id="${design.offer.id}"]`)
        .getByTestId("lp-ops-applicant");
      await applicant.waitFor({ timeout: 20_000 });
      await shot(sam, "external-ops-applicant");
      await applicant.getByTestId("lp-ops-accept-applicant").click();
      await waitFor(
        "Fatima active",
        async () =>
          (await opsInbox(sam)).find((o) => o.id === design.offer.id)?.status === "active",
      );
      const mine = lp(fatimaEnv, ["jobs", "mine"]);
      expect(
        mine.code === 0 && mine.text.includes(`you are in ${PROJECT}`),
        `lp jobs mine: ${mine.text}`,
      );
      // A project member reads its offers; anyone else gets 404.
      const inProject = await pageApi(fatima, `/api/lp/external/offers?projectId=${projectId}`);
      expect(
        inProject.httpStatus === 200,
        `Fatima is not in the project: ${JSON.stringify(inProject).slice(0, 200)}`,
      );
      const hers = inProject.offers.find((o) => o.id === design.offer.id);
      expect(
        hers?.joinedLine?.includes("vetted designer freelancer"),
        `Fatima's offer: ${JSON.stringify(hers?.joinedLine)}`,
      );
    },
  );

  await step("13 Dana completes Omar's work: his access ends", async () => {
    const done = await pageApi(dana, "/api/lp/ops/complete", { offerId: offer.id });
    expect(
      done.httpStatus === 200 && done.offer.status === "completed",
      `complete: ${JSON.stringify(done).slice(0, 300)}`,
    );
    const gone = await pageApi(omar, `/api/lp/external/offers?projectId=${projectId}`);
    expect(
      gone.httpStatus === 404,
      `Omar still has the project: ${JSON.stringify(gone).slice(0, 200)}`,
    );
    const list = await wsRpc(omar, "projects.listEntries", { cwd: projectRoot });
    expect(
      list.exit?._tag !== "Success",
      `Omar still lists files: ${JSON.stringify(list).slice(0, 200)}`,
    );
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
  const summary = {
    suite: "logicpacks-external.e2e",
    date: new Date().toISOString(),
    passed,
    failed: results.length - passed,
    total: results.length,
    steps: results,
  };
  if (resultsFile) NodeFS.writeFileSync(resultsFile, `${JSON.stringify(summary, null, 2)}\n`);
  if (failed) {
    for (const started of children)
      NodeFS.writeFileSync(NodePath.join(root, `${started.name}.log`), started.log);
    console.log(`logs and state in ${root}`);
  }
  if (!keep && !failed) NodeFS.rmSync(root, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}
