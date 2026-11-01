#!/usr/bin/env node
// "Connect your agent" E2E against a local server: node packages/helper/e2e/connect.e2e.mjs [--keep]
// The built lp (dist/lp.mjs) in temp HOMEs, real git with bare remotes, and an app thread run by the
// scripted ACP agent over the real WebSocket RPC. Ana owns Shop and Docs, Omar joins with lp,
// Carol's project sits in another workspace so a cross-project ask there must be refused.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : (args[index + 1] ?? fallback);
};
const port = Number(option("--port", 3893));
const keep = args.includes("--keep");
const HOST = `http://127.0.0.1:${port}`;
const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const repo = NodePath.join(here, "../../..");
const serverDir = NodePath.join(repo, "apps/server");
const LP = NodePath.join(repo, "packages/helper/dist/lp.mjs");
const mockAgent = NodePath.join(repo, "apps/web/e2e/lp-ledger-mock-agent.mjs");
const tmpBase = process.env.LP_E2E_TMP ?? NodeOS.tmpdir();
const root = NodeFS.mkdtempSync(NodePath.join(tmpBase, "lp-connect-e2e-"));
const run = Date.now().toString(36).slice(-5);
const email = (name) => `${name}-${run}@example.com`;
const PASSWORD = "correct-horse-battery";
const mockLog = NodePath.join(root, "mock-agent.log");
const require = NodeModule.createRequire(import.meta.url);
const WebSocket = require(
  NodePath.join(
    repo,
    "node_modules/.pnpm",
    NodeFS.readdirSync(NodePath.join(repo, "node_modules/.pnpm")).find((name) =>
      name.startsWith("ws@8."),
    ),
    "node_modules/ws",
  ),
);

if (!NodeFS.existsSync(LP)) {
  console.error("Build the helper first: (cd packages/helper && vp pack)");
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sh = (command, commandArgs, options = {}) =>
  NodeChildProcess.execFileSync(command, commandArgs, { encoding: "utf8", ...options }).trim();
const git = (cwd, ...gitArgs) =>
  sh("git", ["-c", "user.name=E2E", "-c", "user.email=e2e@example.com", ...gitArgs], { cwd });

// ── Host ──
const home = NodePath.join(root, "host");
NodeFS.mkdirSync(NodePath.join(home, "userdata"), { recursive: true });
NodeFS.writeFileSync(
  NodePath.join(home, "userdata/settings.json"),
  JSON.stringify({
    providerInstances: {
      ledgerMock: {
        displayName: "Ledger mock",
        driver: "acpRegistry",
        config: { source: "local", commandPath: process.execPath, commandArgs: [mockAgent] },
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
        LOGICPACKS_SYNC_SECONDS: "3600",
        LOGICPACKS_TELEMETRY_ENABLED: "false",
        // Packs are a gated feature (access codes): unlocked for both people on this host.
        LOGICPACKS_FEATURES_PACKS: `${email("ana")},${email("omar")}`,
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

// ── Harness ──
const results = [];
let failed = false;
async function step(name, body) {
  const started = Date.now();
  if (failed) {
    results.push({ name, ok: false, ms: 0, error: "skipped after an earlier failure" });
    return;
  }
  try {
    const detail = await body();
    results.push({ name, ok: true, ms: Date.now() - started, detail });
    console.log(`  ok   ${name}${detail ? `: ${String(detail).slice(0, 200)}` : ""}`);
  } catch (error) {
    failed = true;
    results.push({ name, ok: false, ms: Date.now() - started, error: error.message });
    console.log(`  FAIL ${name}: ${error.message}`);
  }
}
const expect = (condition, message) => {
  if (!condition) throw new Error(message);
};

// ── People ──
class Person {
  constructor(name) {
    this.name = name;
    this.display = name[0].toUpperCase() + name.slice(1);
    this.email = email(name);
    this.home = NodePath.join(root, `home-${name}`);
    NodeFS.mkdirSync(this.home, { recursive: true });
    this.cookie = "";
  }
  env(extra = {}) {
    return {
      PATH: process.env.PATH,
      HOME: this.home,
      USERPROFILE: this.home,
      LP_HELPER_HOME: NodePath.join(this.home, ".logicpacks/helper"),
      LP_NO_OPEN: "1",
      LP_HARNESS: this.harness ?? "Terminal",
      TMPDIR: process.env.TMPDIR,
      ...extra,
    };
  }
  /** Runs the built `lp` as this person, in `cwd`. Returns stdout; with --json, the parsed value. */
  lp(cwd, ...lpArgs) {
    const result = NodeChildProcess.spawnSync(process.execPath, [LP, ...lpArgs], {
      cwd,
      env: this.env(),
      encoding: "utf8",
      timeout: 180_000,
    });
    const out = `${result.stdout ?? ""}`.trim();
    if (lpArgs.includes("--json")) {
      try {
        return { code: result.status, json: JSON.parse(out), out };
      } catch {
        return { code: result.status, json: null, out: `${out}\n${result.stderr}` };
      }
    }
    return { code: result.status, out: `${out}${result.stderr ? `\n${result.stderr}` : ""}` };
  }
  async api(path, body, method = body === undefined ? "GET" : "POST") {
    const response = await fetch(`${HOST}${path}`, {
      method,
      headers: { "content-type": "application/json", cookie: this.cookie },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const setCookie = response.headers.getSetCookie?.() ?? [];
    for (const entry of setCookie) this.cookie = entry.split(";")[0];
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: response.status, json, text };
  }
  async signUp() {
    const result = await this.api("/api/lp/auth/password", {
      mode: "signup",
      email: this.email,
      password: PASSWORD,
      displayName: this.display,
    });
    expect(result.status === 200, `signup ${this.name}: ${result.status} ${result.text}`);
    this.userId = result.json.user.userId;
  }
  /** lp login --start, the person approves the code in their signed-in session, lp login --finish. */
  async login() {
    const started = this.lp(this.home, "login", "--host", HOST, "--start", "--json");
    expect(started.code === 0 && started.json?.code, `login --start: ${started.out}`);
    const approved = await this.api("/api/lp/helper/pair/approve", { code: started.json.code });
    expect(approved.status === 200, `approve: ${approved.status} ${approved.text}`);
    const finished = this.lp(this.home, "login", "--host", HOST, "--finish", "--no-mcp", "--json");
    expect(finished.json?.ok, `login --finish: ${finished.out}`);
    this.token = JSON.parse(
      NodeFS.readFileSync(NodePath.join(this.home, ".logicpacks/helper/config.json"), "utf8"),
    ).token;
    return `${started.json.code} approved; ${finished.json.who}`;
  }
  async bearer(path, body) {
    const response = await fetch(`${HOST}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.token}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, json: await response.json().catch(() => null) };
  }
}

// ── WebSocket RPC (the app's own channel), for Ana's app thread ──
class Rpc {
  constructor(person) {
    this.person = person;
    this.pending = new Map();
    this.next = 1;
  }
  async open() {
    this.socket = new WebSocket(`ws://127.0.0.1:${port}/ws?orchestrationProtocol=2`, {
      headers: { cookie: this.person.cookie },
    });
    await new Promise((resolve, reject) => {
      this.socket.once("open", resolve);
      this.socket.once("error", reject);
    });
    this.socket.on("message", (raw) => {
      const message = JSON.parse(String(raw));
      if (message._tag === "Ping") this.socket.send(JSON.stringify({ _tag: "Pong" }));
      if (message._tag === "Exit") {
        const waiter = this.pending.get(message.requestId);
        if (waiter) {
          this.pending.delete(message.requestId);
          waiter(message.exit);
        }
      }
    });
  }
  call(tag, payload) {
    const id = String(this.next++);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${tag} timed out`)), 30_000);
      this.pending.set(id, (exit) => {
        clearTimeout(timer);
        if (exit._tag === "Success") resolve(exit.value);
        else reject(new Error(`${tag}: ${JSON.stringify(exit).slice(0, 600)}`));
      });
      this.socket.send(JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] }));
    });
  }
  close() {
    this.socket?.close();
  }
}

const uuid = () => NodeCrypto.randomUUID();

async function appTurn(rpc, threadId, text) {
  await rpc.call("orchestration.dispatchCommand", {
    type: "message.dispatch",
    commandId: uuid(),
    createdBy: "user",
    creationSource: "web",
    threadId,
    messageId: uuid(),
    text,
    attachments: [],
    dispatchMode: { type: "start_immediately" },
  });
  // The mock logs each turn; wait for the one with this text to be handled.
  const read = () =>
    (NodeFS.existsSync(mockLog) ? NodeFS.readFileSync(mockLog, "utf8") : "")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  for (let waited = 0; waited < 60_000; waited += 500) {
    if (read().some((entry) => entry.userText?.includes(text))) {
      // Tool calls are logged after the turn line; give them time, then read again.
      await sleep(2500);
      const lines = read();
      return lines.slice(lines.findIndex((entry) => entry.userText?.includes(text)));
    }
    await sleep(500);
  }
  throw new Error(`the app agent never ran "${text}"`);
}

// ── Repositories ──
function makeRepo(owner, name, files) {
  const bare = NodePath.join(root, "remotes", owner, `${name}.git`);
  NodeFS.mkdirSync(NodePath.dirname(bare), { recursive: true });
  sh("git", ["init", "--bare", "-q", "-b", "main", bare]);
  const work = NodePath.join(root, "work", `${owner}-${name}`);
  NodeFS.mkdirSync(work, { recursive: true });
  git(work, "init", "-q", "-b", "main");
  for (const [file, text] of Object.entries(files)) {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(work, file)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(work, file), text);
  }
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "start");
  git(work, "remote", "add", "origin", bare);
  return { bare, work };
}

const ana = new Person("ana");
const omar = new Person("omar");
const carol = new Person("carol");
ana.harness = "Claude Code";
omar.harness = "Cursor";
carol.harness = "Codex CLI";

const state = {};

async function main() {
  console.log(`E2E root ${root}`);
  server = startServer();
  await server.ready;
  console.log(`server ready on ${HOST}`);

  await step("setup.md is served by the host", async () => {
    const response = await fetch(`${HOST}/setup.md`);
    const text = await response.text();
    expect(response.status === 200, `status ${response.status}`);
    expect(response.headers.get("content-type")?.includes("markdown"), "content type");
    expect(text.includes("lp setup --agent") && text.includes("helper.ps1"), "content");
    return `${text.length} bytes`;
  });

  await step(
    "Ana signs up and logs in with lp login (device code approved through the API)",
    async () => {
      await ana.signUp();
      return ana.login();
    },
  );

  await step("lp whoami and lp setup --agent claude in Ana's temp HOME", async () => {
    const who = ana.lp(ana.home, "whoami", "--json");
    expect(who.json?.email === ana.email, who.out);
    const file = NodePath.join(ana.home, ".claude/CLAUDE.md");
    // First the diff and nothing written; --yes writes after the user's OK.
    const shown = ana.lp(ana.home, "setup", "--agent", "claude", "--json");
    expect(
      shown.json?.dryRun === true &&
        shown.json.changes?.[0]?.diff?.includes("+<!-- logicpacks:start -->"),
      shown.out,
    );
    expect(!NodeFS.existsSync(file), "nothing written without --yes");
    const setup = ana.lp(ana.home, "setup", "--agent", "claude", "--yes", "--json");
    expect(setup.json?.ok, setup.out);
    expect(
      NodeFS.readFileSync(file, "utf8").includes("<!-- logicpacks:start -->"),
      "block written",
    );
    return `${who.json.who}; block in ${file}`;
  });

  await step("Ana: lp share in a temp git repo with a bare remote", async () => {
    const shop = makeRepo("acme", "shop", {
      "src/app.ts": "export const port = 3000;\n",
      "README.md": "# Shop\n",
    });
    state.shop = shop;
    const shared = ana.lp(shop.work, "share", "--title", "Shop", "--json");
    expect(shared.json?.ok, shared.out);
    // The default link is this project's only, and says so.
    expect(
      shared.json.inviteScope === "project" &&
        shared.json.inviteLink?.includes("/lp/join/project?invite="),
      shared.out,
    );
    const printed = ana.lp(shop.work, "invite").out;
    expect(printed.includes("grants access to this project only"), printed);
    const workspace = ana.lp(shop.work, "invite", "--workspace", "--json");
    expect(
      workspace.json?.inviteScope === "workspace" &&
        workspace.json.inviteLink?.includes("/lp/join?invite="),
      workspace.out,
    );
    state.shopId = shared.json.projectId;
    state.inviteLink = shared.json.inviteLink;
    state.workspaceLink = workspace.json.inviteLink;
    state.anaShopThread = shared.json.threadId;
    return `project link ${state.inviteLink}; workspace link only with --workspace`;
  });

  await step("Ana: lp invite for someone without an account makes a project invite", async () => {
    const invited = ana.lp(state.shop.work, "invite", "friend@example.com", "--json");
    expect(
      invited.json?.invited?.email === "friend@example.com" &&
        invited.json.inviteScope === "project",
      invited.out,
    );
    const cancelled = ana.lp(state.shop.work, "revoke-invite", "friend@example.com", "--json");
    expect(cancelled.json?.revoked === "friend@example.com", cancelled.out);
    return "pending invite for this project, then cancelled";
  });

  await step("Omar signs up, logs in and joins with the invite link (lp join)", async () => {
    await omar.signUp();
    await omar.login();
    const joined = omar.lp(omar.home, "join", state.inviteLink, "--json");
    expect(joined.json?.ok && joined.json.scope === "project", joined.out);
    const projects = omar.lp(omar.home, "projects", "--json");
    expect(
      projects.json?.projects?.length === 1 && projects.json.projects[0].id === state.shopId,
      projects.out,
    );
    // The later cross-project steps need the workspace: Ana sent that link on purpose.
    const workspace = omar.lp(omar.home, "join", state.workspaceLink, "--json");
    expect(workspace.json?.ok, workspace.out);
    return `project link: Shop only; then workspace ${workspace.json.workspace.name}`;
  });

  await step("Ana: lp invite <omar's email> adds him to the project", async () => {
    const invited = ana.lp(state.shop.work, "invite", omar.email, "--json");
    expect(invited.json?.added?.email === omar.email, invited.out);
    const members = ana.lp(state.shop.work, "members", "--json");
    expect(members.json?.members?.length >= 2, members.out);
    return members.json.members.map((member) => member.user.displayName).join(", ");
  });

  await step("Omar clones the repo; lp agents and lp who from his folder", async () => {
    state.omarShop = NodePath.join(root, "work", "omar-shop");
    sh("git", ["clone", "-q", state.shop.bare, state.omarShop]);
    const agents = omar.lp(state.omarShop, "agents", "--task", "Wire the checkout API", "--json");
    expect(agents.json?.agents?.length >= 2, agents.out);
    state.omarThread = agents.json.you;
    const mine = agents.json.agents.find((agent) => agent.threadId === state.omarThread);
    expect(mine?.harness === "Cursor" && mine.person === "Omar", JSON.stringify(mine));
    const anaAgent = agents.json.agents.find((agent) => agent.person === "Ana");
    expect(anaAgent?.harness === "Claude Code", JSON.stringify(agents.json.agents));
    const who = omar.lp(state.omarShop, "who", "Ana");
    expect(who.code === 0 && /Ana/.test(who.out), who.out);
    return omar.lp(state.omarShop, "agents").out.replaceAll("\n", " / ");
  });

  await step(
    "Ana opens an app thread (scripted agent) in Shop over the WebSocket RPC",
    async () => {
      state.rpc = new Rpc(ana);
      await state.rpc.open();
      state.appThread = uuid();
      await state.rpc.call("orchestration.dispatchCommand", {
        type: "thread.create",
        commandId: uuid(),
        createdBy: "user",
        creationSource: "web",
        threadId: state.appThread,
        projectId: state.shopId,
        title: "Checkout",
        modelSelection: { instanceId: "ledgerMock", model: "ledger" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      const turn = await appTurn(state.rpc, state.appThread, "Plan the checkout page");
      return `thread ${state.appThread}; mock saw ${turn.length} log line(s)`;
    },
  );

  await step(
    "the app agent asks Omar's CLI agent; Omar answers with lp reply; the answer reaches the app thread",
    async () => {
      const turn = await appTurn(
        state.rpc,
        state.appThread,
        "tell Omar to confirm which port the API uses",
      );
      const sent = turn.find((entry) => entry.tool === "lp_project_send_to_thread");
      expect(sent && /Sent/.test(sent.out), `app agent send: ${JSON.stringify(sent)}`);
      const inbox = omar.lp(state.omarShop, "inbox", "--json");
      const ask = inbox.json?.items?.find((item) => item.kind === "ask" && /port/.test(item.text));
      expect(ask, `Omar's inbox: ${inbox.out}`);
      state.appAskId = ask.id;
      const printed = omar.lp(state.omarShop, "inbox").out;
      expect(printed.includes(`lp reply ${ask.id}`), printed);
      const replied = omar.lp(
        state.omarShop,
        "reply",
        ask.id,
        "The API listens on port 3000.",
        "--json",
      );
      expect(replied.json?.ok, replied.out);
      const thread = await ana.api(
        `/api/lp/ledger/thread?threadId=${encodeURIComponent(state.appThread)}`,
      );
      const reply = thread.json?.notices?.find((notice) => notice.replyTo === ask.id);
      expect(reply?.text.includes("port 3000"), `app thread notices: ${thread.text.slice(0, 600)}`);
      // And the app agent is handed it on its next turn.
      const next = await appTurn(state.rpc, state.appThread, "what is Omar working on");
      const handed = next.find((entry) => entry.ledger?.includes("port 3000"));
      expect(handed, "the reply was in the app agent's next <logicpacks_project>");
      const after = omar.lp(state.omarShop, "inbox", "--json");
      expect(!after.json.items.some((item) => item.id === ask.id), "answered ask left the inbox");
      return `ask ${ask.id} -> reply ${replied.json.id} in the app thread and its next turn`;
    },
  );

  await step(
    "Omar's CLI agent asks the app agent; its reply lands in Omar's lp inbox",
    async () => {
      const asked = omar.lp(
        state.omarShop,
        "ask",
        state.appThread,
        "Which branch should I base the API on?",
        "--json",
      );
      expect(asked.json?.ok && asked.json.toThreadId === state.appThread, asked.out);
      const byName = omar.lp(
        state.omarShop,
        "ask",
        "Ana",
        "Is the coupon field in scope?",
        "--json",
      );
      expect(byName.json?.ok, byName.out);
      await appTurn(
        state.rpc,
        state.appThread,
        "reply: Base it on main, and yes coupons are in scope.",
      );
      let reply;
      for (let waited = 0; waited < 20_000 && !reply; waited += 1000) {
        const inbox = omar.lp(state.omarShop, "inbox", "--json");
        reply = inbox.json?.items?.find((item) => item.kind === "reply" && /main/.test(item.text));
        if (!reply) await sleep(1000);
      }
      expect(reply, "no reply in Omar's inbox");
      expect(reply.fromThreadId === state.appThread, `reply came from ${reply.fromThreadId}`);
      const done = omar.lp(state.omarShop, "done", reply.id, "--json");
      expect(done.json?.dismissed === 1, done.out);
      return `by name went to ${byName.json.toThreadId === state.appThread ? "the app thread" : byName.json.toThreadId}; reply ${reply.id}`;
    },
  );

  await step("lp send (no reply expected) reaches Ana's inbox", async () => {
    const sent = omar.lp(state.omarShop, "send", "Ana", "FYI: I pushed the API stub.", "--json");
    expect(sent.json?.ok, sent.out);
    const inbox = ana.lp(state.shop.work, "inbox", "--json");
    expect(
      inbox.json?.items?.some((item) => item.text.includes("API stub")),
      inbox.out,
    );
    return sent.json.id;
  });

  await step("cross-project ask inside the workspace works (Shop -> Docs)", async () => {
    const docs = makeRepo("acme", "docs", { "index.md": "# Docs\n" });
    state.docs = docs;
    const shared = ana.lp(docs.work, "share", "--title", "Docs", "--json");
    expect(shared.json?.ok, shared.out);
    state.docsId = shared.json.projectId;
    const asked = omar.lp(
      state.omarShop,
      "ask",
      "Ana",
      "Can the docs mention the new API?",
      "--project",
      "Docs",
      "--json",
    );
    expect(asked.json?.ok, asked.out);
    const anaInbox = ana.lp(docs.work, "inbox", "--json");
    const item = anaInbox.json?.items?.find((entry) => entry.id === asked.json.id);
    expect(item?.projectTitle === "Docs" && /from Shop/.test(item.from), anaInbox.out);
    const replied = ana.lp(docs.work, "reply", item.id, "Yes, add a section.", "--json");
    expect(replied.json?.ok, replied.out);
    const omarInbox = omar.lp(state.omarShop, "inbox", "--json");
    expect(
      omarInbox.json?.items?.some((entry) => entry.replyTo === item.id),
      omarInbox.out,
    );
    return `${item.from} -> Ana in Docs; reply back in Omar's inbox`;
  });

  await step("a cross-project ask without access is refused (CLI and server)", async () => {
    await carol.signUp();
    await carol.login();
    const secret = makeRepo("carol", "secret", { "a.txt": "x\n" });
    const shared = carol.lp(secret.work, "share", "--title", "Secret", "--json");
    expect(shared.json?.ok, shared.out);
    const cli = omar.lp(state.omarShop, "ask", "Carol", "hi", "--project", "Secret", "--json");
    expect(cli.code !== 0 && /no access/i.test(cli.json?.error ?? cli.out), cli.out);
    const api = await omar.bearer("/api/lp/connect/send", {
      fromThreadId: state.omarThread,
      to: "Carol",
      text: "let me in",
      projectId: shared.json.projectId,
    });
    expect(api.status === 403, `server answered ${api.status} ${JSON.stringify(api.json)}`);
    // Writing from someone else's thread is refused too.
    const spoof = await omar.bearer("/api/lp/connect/send", {
      fromThreadId: state.appThread,
      to: "Ana",
      text: "spoof",
    });
    expect(spoof.status === 403, `spoof answered ${spoof.status}`);
    return `CLI: ${cli.json?.error}; server: 403 ${api.json?.message}`;
  });

  await step(
    "a conflict notice reaches the CLI agent's inbox (two agents editing src/app.ts)",
    async () => {
      await appTurn(state.rpc, state.appThread, "edit src/app.ts export const port = 4000;");
      const editing = omar.lp(state.omarShop, "editing", "src/app.ts", "--json");
      expect(editing.json?.ok, editing.out);
      let conflict;
      for (let waited = 0; waited < 15_000 && !conflict; waited += 1000) {
        const inbox = omar.lp(state.omarShop, "inbox", "--json");
        conflict = inbox.json?.items?.find((item) => item.kind === "conflict");
        if (!conflict) await sleep(1000);
      }
      expect(conflict, "no conflict in Omar's inbox");
      const printed = omar.lp(state.omarShop, "inbox").out;
      expect(printed.includes("conflict in src/app.ts"), printed);
      return `${conflict.id}: ${conflict.reason}`;
    },
  );

  await step("lp assist request (Request assistance) and lp assist list", async () => {
    const experts = ana.lp(state.shop.work, "assist", "experts", "--json");
    expect(experts.json?.experts?.length > 0, experts.out);
    const requested = ana.lp(
      state.shop.work,
      "assist",
      "request",
      "Review the checkout flow before launch",
      "--json",
    );
    expect(requested.json?.ok, requested.out);
    const list = ana.lp(state.shop.work, "assist", "list", "--json");
    expect(
      list.json?.requests?.some((request) => request.id === requested.json.request.id),
      list.out,
    );
    return `${requested.json.request.id} ${requested.json.request.status}`;
  });

  await step("lp packs save and list", async () => {
    const saved = ana.lp(state.shop.work, "packs", "save", "Shop context", "--json");
    expect(saved.json?.ok, saved.out);
    const list = ana.lp(state.shop.work, "packs", "list", "--json");
    expect(list.json?.packs?.length >= 1, list.out);
    return saved.json.pack.id;
  });

  await step("lp goals: plan, confirm, Omar's milestone, done, review, approve", async () => {
    const planned = ana.lp(
      state.shop.work,
      "goals",
      "plan",
      "Launch the pricing page",
      "Omar: write the pricing copy by friday",
      "--criteria",
      "three plans; a FAQ",
      "--json",
    );
    expect(planned.json?.goalId, planned.out);
    const goalId = planned.json.goalId;
    const draft = ana.lp(state.shop.work, "inbox", "--json");
    expect(
      draft.json?.items?.some((item) => item.kind === "goal" && item.id === goalId),
      draft.out,
    );
    const confirmed = ana.lp(state.shop.work, "goals", "confirm", goalId, "--json");
    expect(confirmed.json?.goal?.state === "active", confirmed.out);
    let milestone;
    for (let waited = 0; waited < 15_000 && !milestone; waited += 1000) {
      const inbox = omar.lp(state.omarShop, "inbox", "--json");
      milestone = inbox.json?.items?.find(
        (item) => item.kind === "milestone" && item.goalId === goalId,
      );
      if (!milestone) await sleep(1000);
    }
    expect(milestone, "no milestone in Omar's inbox");
    expect(/three plans/.test(milestone.text), milestone.text);
    const started = omar.lp(state.omarShop, "goals", "start", milestone.id);
    expect(started.code === 0, started.out);
    const done = omar.lp(
      state.omarShop,
      "goals",
      "done",
      milestone.id,
      "--note",
      "Copy is in pricing.md",
    );
    expect(done.code === 0 && /done/i.test(done.out), done.out);
    const review = ana.lp(state.shop.work, "goals", "review", "--json");
    const request = review.json?.items?.find(
      (item) => item.kind === "review" && item.goalId === goalId,
    );
    expect(request, review.out);
    const approved = ana.lp(state.shop.work, "goals", "decide", request.id, "approve", "--json");
    expect(approved.code === 0, approved.out);
    const shown = ana.lp(state.shop.work, "goals", "show", goalId, "--json");
    const status = shown.json?.goals?.[0]?.milestones?.[0]?.status;
    expect(status === "approved", `${status} ${shown.out}`);
    return `${goalId} -> ${milestone.id} approved`;
  });

  await step(
    "lp remove takes Omar's access away; lp revoke-invite turns the old link off",
    async () => {
      const planned = ana.lp(state.shop.work, "remove", "Omar", "--dry-run", "--json");
      expect(planned.json?.dryRun && planned.json.steps?.length >= 1, planned.out);
      const stillIn = omar.lp(omar.home, "projects", "--json");
      expect(
        stillIn.json?.projects?.some((project) => project.id === state.shopId),
        "dry run removed nothing",
      );
      const removed = ana.lp(state.shop.work, "remove", "Omar", "--json");
      expect(removed.json?.ok && removed.json.removed?.email === omar.email, removed.out);
      const after = omar.lp(omar.home, "projects", "--json");
      expect(!after.json?.projects?.some((project) => project.id === state.shopId), after.out);
      const asked = omar.lp(state.omarShop, "ask", "Ana", "still there?", "--json");
      expect(asked.json?.ok !== true, `Omar can no longer ask: ${asked.out}`);
      expect(
        removed.json.steps.some((text) => /project/.test(text)) &&
          removed.json.steps.some((text) => /workspace/.test(text)),
        `removed from both: ${removed.out}`,
      );
      const revoked = ana.lp(state.shop.work, "revoke-invite", "--json");
      expect(revoked.json?.ok && revoked.json.inviteLink !== state.inviteLink, revoked.out);
      const rejoin = omar.lp(omar.home, "join", state.inviteLink, "--json");
      expect(rejoin.json?.ok !== true, `old project link refused: ${rejoin.out}`);
      const reset = ana.lp(state.shop.work, "revoke-invite", "--workspace", "--json");
      expect(reset.json?.ok && reset.json.inviteLink !== state.workspaceLink, reset.out);
      const rejoinWorkspace = omar.lp(omar.home, "join", state.workspaceLink, "--json");
      expect(
        rejoinWorkspace.json?.ok !== true,
        `old workspace link refused: ${rejoinWorkspace.out}`,
      );
      return `${removed.json.steps.join("; ")}; new link ${revoked.json.inviteLink}`;
    },
  );

  await step("lp uninstall restores Ana's CLAUDE.md", async () => {
    const file = NodePath.join(ana.home, ".claude/CLAUDE.md");
    const planned = ana.lp(ana.home, "uninstall", "--agent", "claude", "--dry-run");
    expect(
      planned.out.includes("-<!-- logicpacks:start -->") && NodeFS.existsSync(file),
      planned.out,
    );
    ana.lp(ana.home, "uninstall", "--agent", "claude");
    expect(!NodeFS.existsSync(file), "the file lp setup created is gone");
    return "removed";
  });
}

try {
  await main();
} catch (error) {
  failed = true;
  console.log(`E2E crashed: ${error.stack ?? error}`);
} finally {
  state.rpc?.close();
  await stopServer();
  const passed = results.filter((result) => result.ok).length;
  console.log(`\n${passed}/${results.length} steps passed`);
  NodeFS.writeFileSync(NodePath.join(root, "results.json"), JSON.stringify(results, null, 2));
  if (failed && server) NodeFS.writeFileSync(NodePath.join(root, "server.log"), server.log);
  if (!keep && !failed) NodeFS.rmSync(root, { recursive: true, force: true });
  else console.log(`kept ${root}`);
  process.exit(failed ? 1 : 0);
}
