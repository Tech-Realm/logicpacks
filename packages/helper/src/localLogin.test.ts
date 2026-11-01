import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { callHost } from "./client.ts";
import { type Context, loginCommand, parseArgs, setupPromptCommand } from "./connect.ts";
import { renderSetupGuide, setupPrompt } from "./connectText.ts";
import { discoverLocalHost, isLocalOrigin, NOT_CONNECTED, OPEN_THE_APP } from "./localHost.ts";
import type { HelperConfig } from "./store.ts";

const KEY = "local-key-0123456789abcdef0123456789abcdef";

describe("lp login connects to the LogicPacks app on this computer", () => {
  let server: NodeHttp.Server;
  let origin: string;
  let home: string;
  const seen: Array<{ method: string; url: string; body: string }> = [];

  const writeRuntime = (pid: number, runtimeOrigin = origin) => {
    const stateDir = NodePath.join(home, ".logicpacks", "userdata");
    NodeFS.mkdirSync(stateDir, { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(stateDir, "server-runtime.json"),
      JSON.stringify({ version: 1, pid, origin: runtimeOrigin, port: 1 }),
    );
    NodeFS.writeFileSync(NodePath.join(stateDir, "helper-local.key"), `${KEY}\n`);
  };

  beforeEach(async () => {
    seen.length = 0;
    home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lp-local-login-"));
    server = NodeHttp.createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => (body += String(chunk)));
      request.on("end", () => {
        seen.push({ method: request.method ?? "", url: request.url ?? "", body });
        const send = (status: number, payload: unknown) => {
          response.writeHead(status, { "content-type": "application/json" });
          response.end(JSON.stringify(payload));
        };
        if (request.url === "/api/lp/helper/pair/local" && request.method === "GET") {
          return send(200, { local: true });
        }
        if (request.url === "/api/lp/helper/pair/local") {
          return (JSON.parse(body) as { key: string }).key === KEY
            ? send(200, { token: "local-token", who: "the host owner" })
            : send(403, { error: "forbidden" });
        }
        return send(404, { error: "not_found" });
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as NodeNet.AddressInfo).port}`;
  });
  afterEach(() => {
    server.close();
    NodeFS.rmSync(home, { recursive: true, force: true });
  });

  const context = () => {
    let config: HelperConfig = {
      server: null,
      token: null,
      who: null,
      paused: false,
      unlinked: [],
      since: "2026-11-01T00:00:00.000Z",
      device: "test-mac",
    };
    const ctx: Context = {
      cwd: "/tmp",
      home,
      env: { LP_NO_OPEN: "1" },
      loadConfig: () => config,
      saveConfig: (next) => {
        config = next;
      },
      call: callHost,
      run: () => ({ ok: true, stdout: "", stderr: "" }),
      print: () => undefined,
      sleep: async () => undefined,
    };
    return { ctx, config: () => config };
  };

  it("pairs with the running app by its key file, with no browser step and no cloud", async () => {
    writeRuntime(process.pid);
    const { ctx, config } = context();
    const result = await loginCommand(ctx, parseArgs(["login"]));
    expect(result.exitCode).toBeUndefined();
    expect(result.text).toContain("LogicPacks app on this computer");
    expect(config().server).toBe(origin);
    expect(config().token).toBe("local-token");
    expect(seen.map((call) => call.url)).not.toContain("/api/lp/helper/pair/start");
  });

  it("says to open the Mac app, and that cloud is coming soon, when no app is running", async () => {
    const { ctx, config } = context();
    const result = await loginCommand(ctx, parseArgs(["login"]));
    expect(result.exitCode).toBe(1);
    expect(result.text).toBe(OPEN_THE_APP);
    expect(result.text).toMatch(/Open the LogicPacks Mac app/);
    expect(result.text).toMatch(/cloud is coming soon/i);
    expect(result.text).not.toMatch(/Run lp login\b(?! again)/);
    expect(config().server).toBeNull();
  });

  it("ignores a runtime file whose process is gone", async () => {
    writeRuntime(2_000_000_000);
    expect(discoverLocalHost({}, home)).toBeNull();
  });

  it("only trusts loopback origins", async () => {
    writeRuntime(process.pid, "http://example.com:3773");
    expect(discoverLocalHost({}, home)).toBeNull();
    expect(isLocalOrigin("http://127.0.0.1:3773")).toBe(true);
    expect(isLocalOrigin("https://app.logicpacks.io")).toBe(false);
  });

  it("the not-connected text points at the app, not at a login that cannot finish", () => {
    expect(NOT_CONNECTED).toContain("Open the LogicPacks Mac app");
    expect(NOT_CONNECTED).toMatch(/coming soon/);
  });
});

describe("the setup prompt and setup.md", () => {
  it("do not ask for a login or mention access codes", () => {
    for (const text of [setupPrompt("new"), setupPrompt("installed"), renderSetupGuide()]) {
      expect(text).not.toMatch(/log me in/i);
      expect(text).not.toMatch(/access code/i);
    }
    expect(setupPrompt("new")).toMatch(/connect it to the LogicPacks app on this computer/);
    expect(renderSetupGuide()).toMatch(/## 2\. Connect to the LogicPacks app/);
    expect(renderSetupGuide()).toMatch(/open the LogicPacks Mac app/);
    expect(setupPromptCommand).toBeDefined();
  });
});
