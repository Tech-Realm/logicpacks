import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

import { describe, expect, it } from "vite-plus/test";

import { agentsBlockBody, withAgentsBlock, withClaudeMcp, withCodexMcp } from "./agents.ts";

const tempDir = () => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lp-agents-test-"));
const CLI = NodePath.join(import.meta.dirname, "cli.ts");

/** A config.toml like the one on a Mac with Codex Computer Use: `notify` and other servers set. */
const CODEX_CONFIG = `model = "gpt-5.5"
notify = ["/Applications/Codex.app/Contents/Resources/computer-use-notify", "--json"]
approval_policy = "on-request"

# my servers
[mcp_servers.playwright]
command = "npx"
args = ["@playwright/mcp@latest"]

[mcp_servers.playwright.env]
DEBUG = "1"

[profiles.fast]
model = "gpt-5.5-mini"
`;

const launch = {
  command: "/Users/x/.logicpacks/helper/bin/lp",
  args: ["mcp", "--source", "codex"],
};

describe("withCodexMcp", () => {
  it("adds one table and removes it byte for byte", () => {
    const added = withCodexMcp(CODEX_CONFIG, launch);
    expect(added.startsWith(CODEX_CONFIG)).toBe(true);
    expect(added).toContain("[mcp_servers.logicpacks]\n");
    expect(added).toContain('command = "/Users/x/.logicpacks/helper/bin/lp"');
    expect(added).toContain('args = ["mcp", "--source", "codex"]');
    expect(withCodexMcp(added, launch)).toBe(added);
    expect(withCodexMcp(added, null)).toBe(CODEX_CONFIG);
  });

  it("updates its table in place when other tables follow it", () => {
    const withOurs = `${withCodexMcp(CODEX_CONFIG, launch)}\n[mcp_servers.later]\ncommand = "later"\n`;
    const moved = withCodexMcp(withOurs, { command: "/opt/lp", args: ["mcp"] });
    expect(moved).toContain('command = "/opt/lp"');
    expect(moved).not.toContain("/Users/x/.logicpacks");
    expect(moved).toContain('[mcp_servers.later]\ncommand = "later"\n');
    expect(moved).toContain("notify = [");
    const removed = withCodexMcp(moved, null);
    expect(removed).toBe(`${CODEX_CONFIG}\n[mcp_servers.later]\ncommand = "later"\n`);
  });

  it("handles an empty or missing file and leaves other definitions alone", () => {
    const fresh = withCodexMcp("", launch);
    expect(fresh.startsWith("[mcp_servers.logicpacks]\n")).toBe(true);
    expect(withCodexMcp(fresh, null)).toBe("");
    expect(withCodexMcp(CODEX_CONFIG, null)).toBe(CODEX_CONFIG);
    expect(() => withCodexMcp('[mcp_servers]\nlogicpacks = { command = "x" }\n', launch)).toThrow(
      /another form/,
    );
  });
});

describe("withClaudeMcp", () => {
  it("adds and removes only its own server", () => {
    const settings = { theme: "dark", mcpServers: { other: { command: "x" } } };
    const added = withClaudeMcp(settings, launch);
    expect(added.mcpServers).toEqual({
      other: { command: "x" },
      logicpacks: { type: "stdio", command: launch.command, args: launch.args, env: {} },
    });
    expect(withClaudeMcp(added, null)).toEqual(settings);
    expect(withClaudeMcp({ theme: "dark" }, null)).toEqual({ theme: "dark" });
  });
});

describe("withAgentsBlock", () => {
  it("writes only between the markers", () => {
    const original = "# Team rules\n\nUse tabs.\n";
    const body = agentsBlockBody("Shop");
    const added = withAgentsBlock(original, body);
    expect(added.startsWith(original)).toBe(true);
    expect(added).toContain("<!-- logicpacks:start -->\n## LogicPacks: Shop\n");
    expect(withAgentsBlock(added, body)).toBe(added);
    // A teammate edits around the block; an update keeps their edits.
    const edited = `${added}\nMore rules after.\n`.replace("Use tabs.", "Use spaces.");
    const updated = withAgentsBlock(edited, agentsBlockBody("Shop v2"));
    expect(updated).toContain("Use spaces.");
    expect(updated).toContain("More rules after.");
    expect(updated).toContain("## LogicPacks: Shop v2");
    expect(updated).not.toContain("## LogicPacks: Shop\n");
    expect(withAgentsBlock(added, null)).toBe(original);
    expect(withAgentsBlock(withAgentsBlock("", body), null)).toBe("");
  });
});

const run = (args: ReadonlyArray<string>, env: Record<string, string>) =>
  NodeChildProcess.execFileSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });

describe("lp install / uninstall", () => {
  it("registers the MCP server for Codex and Claude Code and preserves every other byte", () => {
    const home = tempDir();
    const codexHome = NodePath.join(home, ".codex");
    const claudeDir = NodePath.join(home, ".claude");
    NodeFS.mkdirSync(codexHome, { recursive: true });
    NodeFS.mkdirSync(claudeDir, { recursive: true });
    const codexFile = NodePath.join(codexHome, "config.toml");
    NodeFS.writeFileSync(codexFile, CODEX_CONFIG);
    const claudeFile = NodePath.join(claudeDir, ".claude.json");
    const claudeOriginal = `${JSON.stringify({ numStartups: 3, mcpServers: { mine: { command: "m" } } }, null, 2)}\n`;
    NodeFS.writeFileSync(claudeFile, claudeOriginal);
    const env = {
      HOME: home,
      CODEX_HOME: codexHome,
      CLAUDE_CONFIG_DIR: claudeDir,
      LP_HELPER_HOME: NodePath.join(home, "helper"),
    };
    // Without --yes (no terminal) and with --dry-run: the exact diff, nothing written.
    for (const args of [["install"], ["install", "--dry-run", "--yes"]]) {
      const shown = run([...args, "--no-hooks", "--no-watcher"], env);
      expect(shown).toContain("Nothing written yet");
      expect(shown).toContain(`+++ ${codexFile}`);
      expect(shown).toContain("+[mcp_servers.logicpacks]");
      expect(NodeFS.readFileSync(codexFile, "utf8")).toBe(CODEX_CONFIG);
      expect(NodeFS.readFileSync(claudeFile, "utf8")).toBe(claudeOriginal);
    }
    const installed = run(["install", "--yes", "--no-hooks", "--no-watcher"], env);
    expect(installed).toContain("Codex MCP server: registered in");
    expect(installed).toContain("Backups of the files changed:");
    const backups = NodeFS.readdirSync(codexHome).filter((name) => name.includes(".lp-backup-"));
    expect(backups.length).toBe(1);
    expect(NodeFS.readFileSync(NodePath.join(codexHome, backups[0]!), "utf8")).toBe(CODEX_CONFIG);
    const toml = NodeFS.readFileSync(codexFile, "utf8");
    expect(toml.startsWith(CODEX_CONFIG)).toBe(true);
    expect(toml).toContain('args = ["');
    expect(toml).toContain('"mcp", "--source", "codex"]');
    const claude = JSON.parse(NodeFS.readFileSync(claudeFile, "utf8"));
    expect(claude.numStartups).toBe(3);
    expect(claude.mcpServers.mine).toEqual({ command: "m" });
    expect(claude.mcpServers.logicpacks.args.slice(-3)).toEqual(["mcp", "--source", "claude"]);
    // Twice is the same as once.
    run(["install", "--yes", "--no-hooks", "--no-watcher"], env);
    expect(NodeFS.readFileSync(codexFile, "utf8")).toBe(toml);
    const planned = run(["uninstall", "--dry-run", "--no-hooks", "--no-watcher"], env);
    expect(planned).toContain("-[mcp_servers.logicpacks]");
    expect(NodeFS.readFileSync(codexFile, "utf8")).toBe(toml);
    run(["uninstall", "--no-hooks", "--no-watcher"], env);
    expect(NodeFS.readFileSync(codexFile, "utf8")).toBe(CODEX_CONFIG);
    expect(JSON.parse(NodeFS.readFileSync(claudeFile, "utf8"))).toEqual(JSON.parse(claudeOriginal));
  });
});

/** A stand-in host for the ledger route. */
const startHost = async () => {
  const received: Array<Record<string, unknown>> = [];
  const server = NodeHttp.createServer((request, response) => {
    let data = "";
    request.on("data", (chunk) => {
      data += chunk;
    });
    request.on("end", () => {
      const body = JSON.parse(data || "{}");
      received.push({ ...body, authorization: request.headers.authorization, url: request.url });
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          text: `Ali in "Checkout" [thread t-ali] is working on ${body.args?.query}.`,
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as NodeNet.AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    received,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};

describe("lp mcp", () => {
  it("answers initialize, tools/list and a who_is_working_on call over stdio", async () => {
    const host = await startHost();
    const home = tempDir();
    const helperHome = NodePath.join(home, "helper");
    NodeFS.mkdirSync(helperHome, { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(helperHome, "config.json"),
      JSON.stringify({ server: host.url, token: "lph_test", unlinked: [] }),
    );
    const repo = NodePath.join(home, "repo");
    NodeFS.mkdirSync(repo);
    NodeChildProcess.execFileSync("git", ["init", "-q", repo]);
    NodeChildProcess.execFileSync("git", [
      "-C",
      repo,
      "remote",
      "add",
      "origin",
      "https://github.com/acme/shop.git",
    ]);
    const child = NodeChildProcess.spawn(
      process.execPath,
      [CLI, "mcp", "--source", "codex", "--no-agents-md"],
      { cwd: repo, env: { ...process.env, HOME: home, LP_HELPER_HOME: helperHome } },
    );
    const replies = NodeReadline.createInterface({ input: child.stdout });
    const iterator = replies[Symbol.asyncIterator]();
    const call = async (message: Record<string, unknown>) => {
      child.stdin.write(`${JSON.stringify(message)}\n`);
      const next = await iterator.next();
      return JSON.parse(String(next.value));
    };
    try {
      const init = await call({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t" } },
      });
      expect(init.result.serverInfo.name).toBe("logicpacks");
      expect(init.result.protocolVersion).toBe("2025-06-18");
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
      );
      const tools = await call({ jsonrpc: "2.0", id: 2, method: "tools/list" });
      expect(tools.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
        "threads",
        "who_is_working_on",
        "conflicts",
        "send_to_thread",
        "propose_merge",
        "note",
        "ask",
        "reply",
        "inbox",
        "goals",
        "goal_plan",
        "goal_update",
        "jobs_search",
        "jobs_show",
        "jobs_apply",
      ]);
      const answer = await call({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "who_is_working_on", arguments: { query: "src/cart.ts" } },
      });
      expect(answer.result.isError).toBe(false);
      expect(answer.result.content[0].text).toContain("Ali");
      const sent = host.received[0]!;
      expect(sent.url).toBe("/api/lp/helper/ledger");
      expect(sent.authorization).toBe("Bearer lph_test");
      expect(sent.tool).toBe("who_is_working_on");
      expect(sent.args).toEqual({ query: "src/cart.ts" });
      expect(sent.gitRemote).toBe("https://github.com/acme/shop.git");
      expect(NodeFS.realpathSync(String(sent.gitRoot))).toBe(NodeFS.realpathSync(repo));
      const unknown = await call({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "rm_rf", arguments: {} },
      });
      expect(unknown.error.code).toBe(-32602);
    } finally {
      child.kill();
      await host.close();
    }
  });
});
