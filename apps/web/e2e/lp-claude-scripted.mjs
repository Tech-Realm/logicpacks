#!/usr/bin/env node
// Scripted `claude` CLI for E2Es: `--version`, `setup-token`, and the SDK's stream-json mode,
// which answers each prompt with the login it runs under (token tail and CLAUDE_CONFIG_DIR).
// Every SDK start and turn is appended to $LP_CLAUDE_SCRIPTED_LOG, so a test can prove which
// member's login a turn ran on, or that no turn ran.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeReadline from "node:readline";

const args = process.argv.slice(2);
const run = process.env.LP_E2E_RUN ?? "e2e";

if (args.includes("--version") || args[0] === "-v") {
  // Recent enough that the picker lists current models instead of "Legacy models".
  console.log("2.1.300 (Claude Code)");
  process.exit(0);
}

if (args[0] === "setup-token") {
  process.stdout.write(
    `Browser didn't open? Use the url below to sign in:\n\nhttps://claude.ai/oauth/authorize?code=true&client_id=e2e&state=e2e-${run}\n\nPaste code here if prompted > `,
  );
  let input = "";
  process.stdin.on("data", (chunk) => {
    input += chunk;
    if (!input.includes("\r") && !input.includes("\n")) return;
    process.stdout.write(
      `\nLogin successful\nYour OAuth token: sk-ant-oat01-E2E_${run}_fakeToken\nStore this token securely.\n`,
    );
    setTimeout(() => process.exit(0), 200);
  });
} else if (!args.includes("stream-json")) {
  console.log("claude stand-in: unsupported invocation", JSON.stringify(args));
  process.exit(1);
} else {
  const sessionId = NodeCrypto.randomUUID();
  const token = process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "";
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? "";
  const login = `token=${token.length > 0 ? token.slice(-28) : "none"} config=${configDir}`;
  const log = process.env.LP_CLAUDE_SCRIPTED_LOG;
  const record = (line) => {
    if (log) NodeFS.appendFileSync(log, `${JSON.stringify({ at: Date.now(), ...line })}\n`);
  };
  record({ event: "start", login, cwd: process.cwd() });
  const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
  const usage = {
    input_tokens: 12,
    output_tokens: 8,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
  let initialized = false;
  const reader = NodeReadline.createInterface({ input: process.stdin });
  reader.on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.type === "control_request") {
      const subtype = message.request?.subtype;
      const response =
        subtype === "initialize"
          ? {
              commands: [],
              agents: [],
              models: [
                { value: "default", displayName: "Default", description: "Scripted" },
                { value: "claude-sonnet-4-5", displayName: "Sonnet", description: "Scripted" },
              ],
              account: { email: "e2e@example.com", subscriptionType: "max" },
              output_style: "default",
              available_output_styles: ["default"],
            }
          : subtype === "mcp_set_servers"
            ? { added: Object.keys(message.request.servers ?? {}), removed: [], errors: {} }
            : {};
      send({
        type: "control_response",
        response: { subtype: "success", request_id: message.request_id, response },
      });
      return;
    }
    if (message.type !== "user") return;
    if (!initialized) {
      initialized = true;
      send({
        type: "system",
        subtype: "init",
        session_id: sessionId,
        uuid: NodeCrypto.randomUUID(),
        cwd: process.cwd(),
        model: "claude-sonnet-4-5",
        tools: [],
        mcp_servers: [],
        permissionMode: "bypassPermissions",
        slash_commands: [],
        apiKeySource: "none",
        output_style: "default",
      });
    }
    const content = message.message?.content;
    const prompt =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content
              .filter((part) => part?.type === "text")
              .map((part) => part.text)
              .join("\n")
          : "";
    record({ event: "turn", login, prompt: prompt.slice(-200) });
    const text = `GRANTED LOGIN ${login}`;
    send({
      type: "assistant",
      session_id: sessionId,
      parent_tool_use_id: null,
      uuid: NodeCrypto.randomUUID(),
      message: {
        id: `msg_${NodeCrypto.randomUUID()}`,
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-5",
        content: [{ type: "text", text }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage,
      },
    });
    send({
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 20,
      duration_api_ms: 10,
      num_turns: 1,
      result: text,
      session_id: sessionId,
      total_cost_usd: 0,
      usage,
      permission_denials: [],
      uuid: NodeCrypto.randomUUID(),
    });
  });
  reader.on("close", () => process.exit(0));
}
