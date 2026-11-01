#!/usr/bin/env node
// OpenCode and Gemini CLI for real, through LogicPacks' own routes:
//   node apps/web/e2e/logicpacks-agents-real.e2e.mjs [--port 3871] [--web-port 5806] [--no-turn] [--keep]
// Needs `opencode` (npm opencode-ai) and `gemini` (npm @google/gemini-cli) on PATH. No stand-ins:
// every login below is the installed CLI's own, run by the server in the member's own home.
//   1 a member signs up; the host reports all four agents installed
//   2 Gemini CLI: "Log in with Google" hands back Google's real sign-in link (Google serves its
//     sign-in page for it; a forged client id gets invalid_client), and a wrong code pasted back
//     is refused by Google's token exchange, leaving the member not connected
//   3 OpenCode: the GitHub Copilot device login hands back github.com/login/device and a code
//   4 OpenCode: the ChatGPT device login hands back auth.openai.com/codex/device and a code
//   5 OpenCode with no login: the member connects the free models
//   6 a real turn: the member's thread runs on their OpenCode instance with a free model and
//     the model's reply comes back into the thread (skipped with --no-turn)
// Completing a Google, GitHub or ChatGPT sign-in needs a person; that part is not automated.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const require = NodeModule.createRequire(import.meta.url);

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : (args[index + 1] ?? fallback);
};
const port = Number(option("--port", 3871));
const webPort = Number(option("--web-port", 5806));
const keep = args.includes("--keep");
const withTurn = !args.includes("--no-turn");
const BASE = `http://127.0.0.1:${port}`;
const WEB = `http://127.0.0.1:${webPort}`;
const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const repo = NodePath.join(here, "../../..");
const serverDir = NodePath.join(repo, "apps/server");
const webDir = NodePath.join(repo, "apps/web");
const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lp-agents-real-"));
const run = Date.now().toString(36).slice(-6);
const PASSWORD = "correct-horse-battery";
const EMAIL = `oli-${run}@example.com`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const which = (command) => {
  try {
    return NodeChildProcess.execFileSync("/usr/bin/which", [command], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
};
const geminiBin = which("gemini");
const openCodeBin = which("opencode");
if (geminiBin === null || openCodeBin === null) {
  console.error("Install the CLIs first: npm install -g opencode-ai @google/gemini-cli");
  process.exit(2);
}

// ── Processes ───────────────────────────────────────────────────────────────
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
let failed = false;
async function step(name, body) {
  const started = Date.now();
  if (failed) {
    results.push({ name, ok: false, ms: 0, error: "skipped after an earlier failure" });
    return;
  }
  try {
    const note = await body();
    results.push({ name, ok: true, ms: Date.now() - started, note });
    console.log(`PASS ${name}${note ? `\n     ${note}` : ""}`);
  } catch (error) {
    failed = true;
    results.push({
      name,
      ok: false,
      ms: Date.now() - started,
      error: String(error?.message ?? error),
    });
    console.log(`FAIL ${name}\n     ${String(error?.message ?? error).split("\n")[0]}`);
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

let cookie = "";
async function api(path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const setCookie = response.headers.getSetCookie?.() ?? [];
  if (setCookie.length > 0) cookie = setCookie.map((value) => value.split(";")[0]).join("; ");
  return { httpStatus: response.status, ...(await response.json().catch(() => ({}))) };
}
/** Follows nothing: what the provider's own server says about the link. */
const probe = async (url) => {
  const response = await fetch(url, { redirect: "manual" });
  return { status: response.status, location: response.headers.get("location") ?? "" };
};

let browser;
let lastPage;
try {
  const home = NodePath.join(root, "host");
  NodeFS.mkdirSync(NodePath.join(home, "userdata"), { recursive: true });
  const env = {
    ...process.env,
    LOGICPACKS_CLOUD_HOST: "true",
    LOGICPACKS_SYNC_SECONDS: "0",
    LOGICPACKS_MEMBER_GEMINI_BINARY: geminiBin,
    LOGICPACKS_MEMBER_OPENCODE_BINARY: openCodeBin,
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
  await server.ready;

  await step("1 a member signs up; the host has all four agents installed", async () => {
    const signedUp = await api("/api/lp/auth/password", {
      mode: "signup",
      email: EMAIL,
      password: PASSWORD,
      displayName: "Oli",
    });
    expect(signedUp.httpStatus === 200, `sign up: ${JSON.stringify(signedUp)}`);
    const status = await api("/api/lp/providers/status");
    expect(status.scope === "member", `scope ${status.scope}`);
    const byKind = Object.fromEntries(status.providers.map((entry) => [entry.kind, entry]));
    for (const kind of ["opencode", "gemini"]) {
      expect(
        byKind[kind]?.installed === true,
        `${kind} not installed: ${JSON.stringify(byKind[kind])}`,
      );
      expect(byKind[kind]?.connected === false, `${kind} already connected`);
    }
    expect(byKind.opencode.methods.includes("free"), "OpenCode offers no free mode");
    expect(byKind.gemini.methods.includes("browser"), "Gemini offers no browser login");
    return `methods: opencode=${byKind.opencode.methods} gemini=${byKind.gemini.methods}`;
  });

  await step(
    "2 Gemini CLI: Google's real sign-in link; a wrong code is refused by Google",
    async () => {
      const started = await api("/api/lp/providers/login/start", { provider: "gemini" });
      expect(started.httpStatus === 200, JSON.stringify(started));
      expect(started.wantsCode === true, "Gemini should want a code back");
      const url = new URL(started.url);
      expect(url.origin === "https://accounts.google.com", `link: ${started.url}`);
      expect(
        url.searchParams.get("redirect_uri") === "https://codeassist.google.com/authcode",
        "redirect",
      );
      const clientId = url.searchParams.get("client_id") ?? "";
      expect(clientId.endsWith(".apps.googleusercontent.com"), `client ${clientId}`);
      const real = await probe(started.url);
      expect(
        real.status === 302 &&
          real.location.includes("/signin/") &&
          !real.location.includes("/oauth/error"),
        `Google did not serve sign-in: ${real.status} ${real.location.slice(0, 120)}`,
      );
      const forged = await probe(started.url.replace(clientId, `1${clientId}`));
      expect(
        forged.location.includes("/oauth/error"),
        "Google accepted a forged client id; probe is not meaningful",
      );
      const answered = await api("/api/lp/providers/login/code", {
        provider: "gemini",
        code: `4/0-e2e-not-a-real-code-${run}`,
        loginId: started.loginId,
      });
      expect(
        answered.connected === false,
        `connected with a fake code: ${JSON.stringify(answered)}`,
      );
      expect(
        /fail|error|invalid/i.test(answered.output ?? ""),
        `no refusal shown: ${answered.output}`,
      );
      const status = await api("/api/lp/providers/status");
      expect(
        !status.providers.find((entry) => entry.kind === "gemini").connected,
        "Gemini marked connected",
      );
      await api("/api/lp/providers/login/cancel", { provider: "gemini" });
      return `Google: ${(answered.output ?? "")
        .split("\n")
        .find((line) => /fail|error|invalid/i.test(line))
        ?.trim()
        .slice(0, 140)}`;
    },
  );

  for (const [index, via, origin, path] of [
    [3, "copilot", "https://github.com", "/login/device"],
    [4, "chatgpt", "https://auth.openai.com", "/codex/device"],
  ]) {
    await step(
      `${index} OpenCode: the ${via} device login hands back a real link and code`,
      async () => {
        const started = await api("/api/lp/providers/login/start", { provider: "opencode", via });
        expect(started.httpStatus === 200, JSON.stringify(started));
        const url = new URL(started.url);
        expect(url.origin === origin && url.pathname === path, `link: ${started.url}`);
        expect(/^[A-Z0-9]{4}-[A-Z0-9]{4,6}$/.test(started.code ?? ""), `code: ${started.code}`);
        const page = await probe(started.url);
        expect(page.status < 500, `${origin} answered ${page.status}`);
        const status = await api("/api/lp/providers/login/status?provider=opencode");
        expect(status.running === true && status.connected === false, JSON.stringify(status));
        await api("/api/lp/providers/login/cancel", { provider: "opencode" });
        return `${started.url} code ${started.code} (HTTP ${page.status})`;
      },
    );
  }

  await step("5 OpenCode with no login: the member connects the free models", async () => {
    const connected = await api("/api/lp/providers/free", { provider: "opencode" });
    expect(connected.connected === true, JSON.stringify(connected));
    const status = await api("/api/lp/providers/status");
    const openCode = status.providers.find((entry) => entry.kind === "opencode");
    expect(openCode.connected, "OpenCode not connected");
    const settings = JSON.parse(
      NodeFS.readFileSync(NodePath.join(home, "userdata/settings.json"), "utf8"),
    );
    const instance = settings.providerInstances?.[openCode.instanceId];
    expect(instance?.driver === "opencode", `instance: ${JSON.stringify(instance)}`);
    expect(
      instance.environment?.some(
        (entry) => entry.name === "XDG_DATA_HOME" && entry.value.includes("/members/"),
      ),
      "OpenCode is not pointed at the member's home",
    );
    return openCode.instanceId;
  });

  if (withTurn) {
    const { chromium } = require("playwright");
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
    await web.ready;
    browser = await chromium.launch({ headless: true });

    await step(
      "6 a real OpenCode turn on the member's free model comes back into the thread",
      async () => {
        const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
        const [name, value] = cookie.split(";")[0].split("=");
        await context.addCookies([{ name, value, url: WEB }]);
        const page = await context.newPage();
        lastPage = page;
        const created = await page.goto(`${WEB}/`).then(() =>
          page.evaluate(async () => {
            const response = await fetch("/api/lp/projects/new", {
              method: "POST",
              credentials: "include",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ kind: "empty", name: "Free turn" }),
            });
            return response.json();
          }),
        );
        expect(created.projectId || created.project, `project: ${JSON.stringify(created)}`);
        await page.goto(`${WEB}/`);
        const heading = page.locator("main h1 button, main h2 button").first();
        await heading.waitFor({ timeout: 60_000 });
        if ((await heading.innerText()).trim() !== "Free turn") {
          await heading.click();
          await page.locator('[role="listbox"]').getByText("Free turn", { exact: true }).click();
        }
        // Pick the member's OpenCode and a free model in the composer's model picker.
        const picker = page.locator('[data-chat-provider-model-picker="true"]').first();
        await picker.waitFor({ timeout: 30_000 });
        await picker.click();
        await page.locator('input[placeholder="Search models..."]').fill("pickle");
        await page
          .getByText(/big pickle/i)
          .first()
          .click({ timeout: 90_000 });
        await sleep(500);
        const chosen = await picker.innerText();
        expect(/pickle/i.test(chosen), `model picker shows ${chosen}`);
        const composer = page.locator('[contenteditable="true"]').first();
        await composer.click();
        const prompt = `Reply with exactly the word PICKLE${run.toUpperCase()} and nothing else.`;
        await page.keyboard.type(prompt);
        await page.keyboard.press("Enter");
        const needle = `PICKLE${run.toUpperCase()}`;
        const text = await waitFor(
          "the model's reply",
          async () => {
            const body = await page.locator("main").innerText();
            const rest = body.split(prompt).join("");
            return !/Working for|Thinking/.test(body) && rest.includes(needle) ? rest : null;
          },
          180_000,
        );
        await page.screenshot({ path: NodePath.join(root, "opencode-turn.png") });
        return `reply contains ${needle}; screenshot ${NodePath.join(root, "opencode-turn.png")} (${text.length} chars)`;
      },
    );
  }
} catch (error) {
  failed = true;
  console.log(`ERROR ${String(error?.stack ?? error)}`);
} finally {
  if (failed)
    await lastPage?.screenshot({ path: NodePath.join(root, "fail.png") }).catch(() => undefined);
  await browser?.close().catch(() => undefined);
  await stopAll();
  for (const started of children)
    NodeFS.writeFileSync(NodePath.join(root, `${started.name}.log`), started.log);
  console.log("\nSTEP RESULTS");
  for (const result of results) {
    console.log(
      `${result.ok ? "PASS" : "FAIL"}  ${result.name}  (${result.ms} ms)${result.error ? `\n      ${result.error}` : ""}`,
    );
  }
  console.log(
    `\n${results.filter((result) => result.ok).length}/${results.length} passed; artifacts in ${root}`,
  );
  if (!keep && !failed) NodeFS.rmSync(root, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}
