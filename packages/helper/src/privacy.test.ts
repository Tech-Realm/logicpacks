import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import type { SessionEvent } from "./events.ts";
import { isSensitivePath, REDACTED, redactSecrets, scrubEvent } from "./privacy.ts";
import { loadConfig } from "./store.ts";
import { syncTranscript } from "./sync.ts";

const tool = (
  name: string,
  input: string,
  output?: string,
  files?: Array<string>,
): SessionEvent => ({
  uid: "t",
  at: "2026-11-01T00:00:00.000Z",
  type: "tool",
  tool: {
    name,
    kind: "other",
    input,
    status: "completed",
    ...(output === undefined ? {} : { output }),
    ...(files === undefined ? {} : { files }),
  },
});

const off = { mcpDetails: false };

describe("redactSecrets", () => {
  it.each([
    ["an Anthropic key", "key sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz012345"],
    ["an OpenAI key", "OPENAI sk-proj-AbCdEfGhIjKlMnOpQrStUv"],
    ["a GitHub token", "git push https://x:ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com"],
    ["a Slack token", "token xoxb-123456789012-abcdefghijkl"],
    ["an AWS key id", "AKIAIOSFODNN7EXAMPLE in use"],
    [
      "a JWT",
      "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    ],
    ["a Stripe key", "sk_live_51HxYzAbCdEfGhIjKlMnOp"],
  ])("removes %s", (_, text) => {
    const out = redactSecrets(text);
    expect(out).toContain(REDACTED);
    expect(out).not.toMatch(/sk-ant|sk-proj-Ab|ghp_abc|xoxb-1|AKIAIOSF|eyJhbGci|sk_live_51/);
  });

  it("removes a PEM private key block", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nabc\n-----END RSA PRIVATE KEY-----";
    expect(redactSecrets(`before\n${pem}\nafter`)).toBe(`before\n${REDACTED}\nafter`);
  });

  it("removes secret-looking KEY=VALUE pairs and keeps the others", () => {
    const env = [
      "PORT=3000",
      "DATABASE_PASSWORD=hunter2",
      "API_KEY=abc123",
      "STRIPE_SECRET=whsec_1",
      "NODE_ENV=production",
      'config = { "token": "t0k3n", "name": "shop" }',
      "password: s3cret",
      "curl -H 'Authorization: Bearer abc.def'",
      "mysql --password hunter2 -u root",
      "TOKEN=${GITHUB_TOKEN}",
    ].join("\n");
    const out = redactSecrets(env);
    expect(out).toContain("PORT=3000");
    expect(out).toContain("NODE_ENV=production");
    expect(out).toContain(`DATABASE_PASSWORD=${REDACTED}`);
    expect(out).toContain(`API_KEY=${REDACTED}`);
    expect(out).toContain(`STRIPE_SECRET=${REDACTED}`);
    expect(out).toContain(`"token": "${REDACTED}"`);
    expect(out).toContain('"name": "shop"');
    expect(out).toContain(`password: ${REDACTED}`);
    expect(out).toContain(`Authorization: Bearer ${REDACTED}`);
    expect(out).toContain(`--password ${REDACTED}`);
    // A variable reference is not a secret.
    expect(out).toContain("TOKEN=${GITHUB_TOKEN}");
    expect(out).not.toMatch(/hunter2|abc123|whsec_1|t0k3n|s3cret|abc\.def/);
  });

  it("removes credentials from connection strings", () => {
    expect(redactSecrets("postgres://app:Sup3rS3cret@db.internal:5432/shop")).toBe(
      `postgres://app:${REDACTED}@db.internal:5432/shop`,
    );
    expect(redactSecrets("mongodb+srv://u:p4ss@cluster0.x.net/db")).toBe(
      `mongodb+srv://u:${REDACTED}@cluster0.x.net/db`,
    );
  });

  it("leaves ordinary code and output alone", () => {
    const code = "const total = items.reduce((sum, item) => sum + item.price, 0);\nexit code 0";
    expect(redactSecrets(code)).toBe(code);
  });
});

describe("scrubEvent", () => {
  it("streams only the name of an MCP call by default", () => {
    const event = tool(
      "mcp__whatsapp__send_message",
      '{"to":"+92 300 1234567","text":"price is 400"}',
      "sent to Ali",
    );
    expect(scrubEvent(event, off).tool).toEqual({
      name: "mcp: whatsapp.send_message",
      kind: "other",
      input: "",
      status: "completed",
    });
    const opted = scrubEvent(event, { mcpDetails: true }).tool!;
    expect(opted.name).toBe("mcp: whatsapp.send_message");
    expect(opted.input).toContain("price is 400");
    expect(opted.output).toBe("sent to Ali");
  });

  it("never streams the content of secret files", () => {
    for (const path of [
      "/repo/.env",
      "/repo/.env.local",
      "/repo/certs/server.pem",
      "/repo/tls.key",
      "/home/me/.ssh/config",
      "/home/me/.ssh/id_ed25519",
      "C:\\Users\\me\\.ssh\\id_rsa",
    ]) {
      expect(isSensitivePath(path)).toBe(true);
      const scrubbed = scrubEvent(tool("Read", path, "SECRET=1\nOTHER=2", [path]), off).tool!;
      expect(scrubbed.output).toBeUndefined();
      expect(scrubbed.input).toContain("content not shared");
    }
    const cat = scrubEvent(tool("Bash", "cat .env.production", "DB=postgres://a:b@c/d"), off).tool!;
    expect(cat.output).toBeUndefined();
    expect(isSensitivePath("/repo/src/environment.ts")).toBe(false);
    expect(isSensitivePath("/repo/keyboard.tsx")).toBe(false);
  });

  it("redacts built-in tool inputs and results and prompt text", () => {
    const bash = scrubEvent(
      tool("Bash", "curl -H 'Authorization: Bearer abc123' https://api.x", "token=zzz999 ok"),
      off,
    ).tool!;
    expect(bash.input).not.toContain("abc123");
    expect(bash.output).toBe(`token=${REDACTED} ok`);
    const said = scrubEvent(
      { uid: "u", at: "x", type: "user", text: "use key sk-ant-api03-AbCdEfGhIjKlMnOpQrSt" },
      off,
    );
    expect(said.text).toBe(`use key ${REDACTED}`);
  });
});

describe("what syncTranscript sends", () => {
  it("sends MCP calls as names only, redacted tools, and no secret file content", async () => {
    process.env.LP_HELPER_HOME = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lp-priv-"));
    const file = NodePath.join(NodeOS.tmpdir(), `lp-priv-${process.pid}.jsonl`);
    const record = (value: Record<string, unknown>) =>
      `${JSON.stringify({ sessionId: "s1", cwd: "/nonexistent/repo", timestamp: "2026-11-01T00:00:00.000Z", ...value })}\n`;
    const use = (id: string, name: string, input: unknown) =>
      record({
        type: "assistant",
        uuid: `a-${id}`,
        message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
      });
    const result = (id: string, content: string) =>
      record({
        type: "user",
        uuid: `r-${id}`,
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content }] },
      });
    NodeFS.writeFileSync(
      file,
      [
        use("m1", "mcp__whatsapp__send_message", { to: "Ali", text: "the price is 400" }),
        result("m1", "delivered to Ali at 10:02"),
        use("b1", "Bash", { command: "echo $X", description: "export API_KEY=abc123secret" }),
        result("b1", "password=hunter2"),
        use("r1", "Read", { file_path: "/nonexistent/repo/.env" }),
        result("r1", "STRIPE_KEY=sk_live_abcdefghijklmnop1234"),
      ].join(""),
    );
    const received: Array<string> = [];
    const server = NodeHttp.createServer((request, response) => {
      let data = "";
      request.on("data", (chunk) => {
        data += chunk;
      });
      request.on("end", () => {
        received.push(data);
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            linked: true,
            projectId: "p",
            threadId: "t",
            accepted: 1,
            duplicates: 0,
          }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as NodeNet.AddressInfo;
    try {
      const config = { ...loadConfig(), server: `http://127.0.0.1:${port}`, token: "t" };
      expect((await syncTranscript(file, "claude", config)).kind).toBe("sent");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      NodeFS.rmSync(file, { force: true });
    }
    const sent = received.join("\n");
    expect(sent).toContain("mcp: whatsapp.send_message");
    for (const secret of [
      "the price is 400",
      "delivered to Ali",
      "abc123secret",
      "hunter2",
      "sk_live_abc",
    ]) {
      expect(sent).not.toContain(secret);
    }
    expect(sent).toContain("content not shared");
  });
});
