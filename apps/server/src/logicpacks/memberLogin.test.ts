// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";

import {
  classifyAnswer,
  ensureMemberProviderHome,
  findClaudeToken,
  geminiCredsPath,
  isCodexHomeConnected,
  isGeminiHomeConnected,
  isLoginHomeConnected,
  isOpenCodeHomeConnected,
  memberDirSegment,
  openCodeAuthPath,
  memberProviderHome,
  MemberLogins,
  parseLoginOutput,
  publicRun,
  readableOutput,
  redactSecrets,
  stripAnsi,
  unwrapUrls,
  type LoginSpawner,
} from "./memberLogin.ts";
import { isMemberInstanceId, isOwnMemberInstance, memberInstanceId } from "./memberProviders.ts";

// Ported from v1's providerAuth store and http tests (main:apps/server/src/providerAuth).

let stateDir: string;
beforeEach(() => {
  stateDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lp-member-login-"));
});
afterEach(() => {
  NodeFS.rmSync(stateDir, { recursive: true, force: true });
});

describe("where a member's login lives", () => {
  it("gives each person and provider a directory of their own", () => {
    const ana = memberProviderHome(stateDir, "ana", "codex");
    const ali = memberProviderHome(stateDir, "ali", "codex");
    expect(ana).not.toBe(ali);
    expect(memberProviderHome(stateDir, "ana", "claude")).not.toBe(ana);
    expect(ana.startsWith(NodePath.join(stateDir, "logicpacks", "members"))).toBe(true);
  });

  it("never lets a user id walk out of the members directory", () => {
    for (const hostile of ["../../etc", "a/b", "..", "", "x".repeat(400)]) {
      const segment = memberDirSegment(hostile);
      expect(segment, hostile).toMatch(/^u-[0-9a-f]{32}$/);
      const home = memberProviderHome(stateDir, hostile, "claude");
      expect(NodePath.relative(NodePath.join(stateDir, "logicpacks", "members"), home)).not.toMatch(
        /^\.\./,
      );
    }
    expect(memberDirSegment("user-1234_ab")).toBe("user-1234_ab");
  });

  it("creates the home private to this process", () => {
    const home = ensureMemberProviderHome(stateDir, "ana", "codex");
    expect(NodeFS.statSync(home).mode & 0o777).toBe(0o700);
  });

  it("reports Codex connected only once its auth.json holds a credential", () => {
    const home = ensureMemberProviderHome(stateDir, "ana", "codex");
    expect(isCodexHomeConnected(home)).toBe(false);
    NodeFS.writeFileSync(NodePath.join(home, "auth.json"), "{not json");
    expect(isCodexHomeConnected(home)).toBe(false);
    NodeFS.writeFileSync(
      NodePath.join(home, "auth.json"),
      JSON.stringify({ tokens: { id_token: "x" } }),
    );
    expect(isCodexHomeConnected(home)).toBe(true);
    // Another member's home is untouched by it.
    expect(isCodexHomeConnected(ensureMemberProviderHome(stateDir, "ali", "codex"))).toBe(false);
  });

  it("names one instance per member per provider, recognisable as a member's", () => {
    const ids = (["claude", "codex", "opencode", "gemini"] as const).map((kind) =>
      memberInstanceId(kind, "ana"),
    );
    expect(new Set(ids).size).toBe(4);
    for (const id of ids) {
      expect(isMemberInstanceId(id)).toBe(true);
      expect(isOwnMemberInstance(id, "ana")).toBe(true);
      expect(isOwnMemberInstance(id, "ali")).toBe(false);
    }
    expect(isMemberInstanceId("claudeAgent")).toBe(false);
  });
});

describe("reading the CLI's terminal", () => {
  it("rejoins a link the terminal wrapped and prefers the whole of it", () => {
    const raw =
      "Open this:\nhttps://claude.ai/oauth/authorize?code=true&client_id=abc\n&redirect_uri=x\nthen paste";
    expect(unwrapUrls(raw)).toContain("client_id=abc&redirect_uri=x");
    expect(parseLoginOutput(raw).url).toBe(
      "https://claude.ai/oauth/authorize?code=true&client_id=abc&redirect_uri=x",
    );
  });

  it("finds Codex's device code and strips colour codes", () => {
    const raw =
      "\u001b[1mGo to\u001b[0m https://auth.openai.com/codex/device\nEnter code \u001b[94mU8X6-IJJIR\u001b[0m";
    expect(stripAnsi(raw)).toBe(
      "Go to https://auth.openai.com/codex/device\nEnter code U8X6-IJJIR",
    );
    expect(parseLoginOutput(raw, false)).toEqual({
      url: "https://auth.openai.com/codex/device",
      code: "U8X6-IJJIR",
    });
  });

  it("never shows a token, and captures it without the sentence after it", () => {
    const raw = "Your token: sk-ant-oat01-AbC_d-123   \nStore this token securely.";
    expect(findClaudeToken(raw)).toBe("sk-ant-oat01-AbC_d-123");
    expect(redactSecrets(raw)).not.toContain("sk-ant");
    expect(readableOutput(raw)).toBe("Your token: «token hidden»\nStore this token securely.");
    expect(redactSecrets("key sk-proj-aaaaaaaaaaaaaaaaaaaaaaaa")).toBe("key «token hidden»");
  });

  it("tells success from failure in what the interface says", () => {
    expect(classifyAnswer("Login successful")).toBe("accepted");
    expect(classifyAnswer("Invalid code, try again")).toBe("failed");
    expect(classifyAnswer("waiting")).toBe("unknown");
  });
});

/** A spawner that plays a script instead of running a CLI. */
const fakeSpawner = () => {
  const started: Array<{
    mode: string;
    command: string;
    args: ReadonlyArray<string>;
    env: Record<string, string>;
    cwd: string | undefined;
    typed: string[];
    killed: boolean;
    emit: (text: string) => void;
    exit: (code: number) => void;
  }> = [];
  const make =
    (mode: string): LoginSpawner["pty"] =>
    (command, args, env, on, cwd) => {
      const entry = {
        mode,
        command,
        args,
        env,
        cwd,
        typed: [] as string[],
        killed: false,
        emit: on.data,
        exit: (code: number) => on.exit(code),
      };
      started.push(entry);
      return {
        write: (text) => {
          entry.typed.push(text);
          if (text === "\r") on.data("\nToken created: sk-ant-oat01-SECRET\nLogin successful\n");
        },
        kill: () => {
          entry.killed = true;
          on.exit(null);
        },
      };
    };
  return { spawner: { pty: make("pty"), pipe: make("pipe") } satisfies LoginSpawner, started };
};

describe("one login at a time per person per provider", () => {
  it("runs Claude's setup-token in a terminal in the member's own config dir", async () => {
    const { spawner, started } = fakeSpawner();
    const logins = new MemberLogins(
      stateDir,
      spawner,
      { claude: "/opt/claude", codex: "codex" },
      { pollMs: 1, typeMs: 1 },
    );
    const run = logins.start("ana", "claude");
    expect(started[0]).toMatchObject({
      mode: "pty",
      command: "/opt/claude",
      args: ["setup-token"],
    });
    expect(started[0]?.env.CLAUDE_CONFIG_DIR).toBe(memberProviderHome(stateDir, "ana", "claude"));
    started[0]!.emit("Visit https://claude.ai/oauth/authorize?x=1 and paste the code:");
    await logins.waitForPrompt(run, 3);
    expect(publicRun(run)).toMatchObject({
      url: "https://claude.ai/oauth/authorize?x=1",
      wantsCode: true,
    });
    const before = run.output;
    await logins.typeCode(run, "code#state");
    expect(started[0]!.typed.join("")).toBe("code#state\r");
    expect(await logins.waitForAnswer(run, before, 3)).toBe("accepted");
    expect(findClaudeToken(run.output)).toBe("sk-ant-oat01-SECRET");
    expect(publicRun(run).output).not.toContain("SECRET");
  });

  it("runs Codex's device login in a pipe with the member's CODEX_HOME", () => {
    const { spawner, started } = fakeSpawner();
    const logins = new MemberLogins(stateDir, spawner);
    const run = logins.start("ana", "codex");
    expect(started[0]).toMatchObject({
      mode: "pipe",
      command: "codex",
      args: ["login", "--device-auth"],
    });
    expect(started[0]?.env.CODEX_HOME).toBe(run.home);
    started[0]!.emit("Open https://auth.openai.com/codex/device\nCode: AB12-CDE34\n");
    expect(publicRun(run)).toMatchObject({ code: "AB12-CDE34", wantsCode: false });
  });

  it("abandons a person's earlier login and never touches someone else's", () => {
    const { spawner, started } = fakeSpawner();
    const logins = new MemberLogins(stateDir, spawner);
    const first = logins.start("ana", "codex");
    const other = logins.start("ali", "codex");
    const second = logins.start("ana", "codex");
    expect(started[0]?.killed).toBe(true);
    expect(started[1]?.killed).toBe(false);
    expect(second.loginId).not.toBe(first.loginId);
    expect(logins.current("ana", "codex")).toBe(second);
    expect(logins.current("ali", "codex")).toBe(other);
    expect(logins.cancel("ana", "codex")).toBe(true);
    expect(logins.current("ana", "codex")).toBeUndefined();
    expect(logins.current("ali", "codex")).toBe(other);
  });
});

// Output shapes below were captured from the real CLIs on 2026-11-01
// (Gemini CLI 0.66.0, OpenCode 1.19.5) under node-pty at 1000 columns.
describe("Gemini CLI and OpenCode logins", () => {
  it("signs Gemini in with Google: interactive CLI, NO_BROWSER, member's GEMINI_CLI_HOME", async () => {
    const { spawner, started } = fakeSpawner();
    const logins = new MemberLogins(
      stateDir,
      spawner,
      { gemini: "/opt/gemini" },
      {
        pollMs: 1,
        typeMs: 1,
      },
    );
    const run = logins.start("ana", "gemini");
    expect(started[0]).toMatchObject({ mode: "pty", command: "/opt/gemini", args: [] });
    expect(started[0]?.env).toMatchObject({ GEMINI_CLI_HOME: run.home, NO_BROWSER: "true" });
    expect(started[0]?.cwd).toBe(run.home);
    // The CLI goes straight to Google login rather than its auth picker.
    const settings = JSON.parse(
      NodeFS.readFileSync(NodePath.join(run.home, ".gemini", "settings.json"), "utf8"),
    );
    expect(settings.security.auth.selectedType).toBe("oauth-personal");
    started[0]!.emit(
      "Please visit the following URL to authorize the application:\r\n\r\nhttps://accounts.google.com/o/oauth2/v2/auth?redirect_uri=https%3A%2F%2Fcodeassist.google.com%2Fauthcode&response_type=code&client_id=681255809395-x.apps.googleusercontent.com\r\n\r\nEnter the authorization code: ",
    );
    await logins.waitForPrompt(run, 3);
    expect(publicRun(run)).toMatchObject({
      url: "https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=https%3A%2F%2Fcodeassist.google.com%2Fauthcode&response_type=code&client_id=681255809395-x.apps.googleusercontent.com",
      wantsCode: true,
    });
    expect(isLoginHomeConnected("gemini", run.home)).toBe(false);
    // The CLI caches the credentials once the code is exchanged.
    NodeFS.writeFileSync(geminiCredsPath(run.home), JSON.stringify({ refresh_token: "r" }));
    expect(await logins.waitForConnected(run, 3)).toBe(true);
  });

  it("keeps other Gemini settings when it chooses Google login", () => {
    const home = ensureMemberProviderHome(stateDir, "ana", "gemini");
    NodeFS.mkdirSync(NodePath.join(home, ".gemini"));
    NodeFS.writeFileSync(
      NodePath.join(home, ".gemini", "settings.json"),
      JSON.stringify({
        ui: { theme: "x" },
        security: { auth: { selectedType: "gemini-api-key" } },
      }),
    );
    const { spawner } = fakeSpawner();
    new MemberLogins(stateDir, spawner).start("ana", "gemini");
    const settings = JSON.parse(
      NodeFS.readFileSync(NodePath.join(home, ".gemini", "settings.json"), "utf8"),
    );
    expect(settings).toEqual({
      ui: { theme: "x" },
      security: { auth: { selectedType: "oauth-personal" } },
    });
  });

  it("runs OpenCode's GitHub Copilot device login and answers the deployment picker", async () => {
    const { spawner, started } = fakeSpawner();
    const logins = new MemberLogins(
      stateDir,
      spawner,
      { opencode: "/opt/opencode" },
      {
        pollMs: 1,
        typeMs: 1,
      },
    );
    const run = logins.start("ana", "opencode");
    expect(started[0]).toMatchObject({
      mode: "pty",
      command: "/opt/opencode",
      args: ["auth", "login", "-p", "github-copilot"],
    });
    expect(started[0]?.env.XDG_DATA_HOME).toBe(run.home);
    started[0]!.emit(
      "┌  Add credential\r\n│\r\n◆  Select GitHub deployment type\r\n│  ● GitHub.com (Public)\r\n",
    );
    expect(started[0]!.typed).toEqual(["\r"]);
    started[0]!.emit(
      "●  Go to: https://github.com/login/device\r\n│\r\n●  Enter code: 60A5-8A01\r\n│\r\n◒  Waiting for authorization",
    );
    await logins.waitForPrompt(run, 3);
    // The box-drawing border on the next line is not glued onto the link.
    expect(publicRun(run)).toMatchObject({
      url: "https://github.com/login/device",
      code: "60A5-8A01",
      wantsCode: false,
    });
    NodeFS.mkdirSync(NodePath.join(run.home, "opencode"), { recursive: true });
    NodeFS.writeFileSync(
      openCodeAuthPath(run.home),
      JSON.stringify({ "github-copilot": { type: "oauth", refresh: "r" } }),
    );
    expect(isOpenCodeHomeConnected(run.home)).toBe(true);
  });

  it("signs OpenCode in to ChatGPT headless when asked", () => {
    const { spawner, started } = fakeSpawner();
    const run = new MemberLogins(stateDir, spawner).start("ana", "opencode", { via: "chatgpt" });
    expect(started[0]?.args).toEqual([
      "auth",
      "login",
      "-p",
      "openai",
      "-m",
      "ChatGPT Pro/Plus (headless)",
    ]);
    started[0]!.emit(
      "●  Go to: https://auth.openai.com/codex/device\r\n│\r\n●  Enter code: SDF2-77XDH\r\n",
    );
    expect(publicRun(run)).toMatchObject({
      url: "https://auth.openai.com/codex/device",
      code: "SDF2-77XDH",
    });
    expect(started[0]!.typed).toEqual([]);
  });

  it("only counts a credential the CLI really wrote", () => {
    const home = ensureMemberProviderHome(stateDir, "ana", "gemini");
    expect(isGeminiHomeConnected(home)).toBe(false);
    NodeFS.mkdirSync(NodePath.join(home, ".gemini"), { recursive: true });
    NodeFS.writeFileSync(geminiCredsPath(home), "{}");
    expect(isGeminiHomeConnected(home)).toBe(false);
    NodeFS.writeFileSync(geminiCredsPath(home), "not json");
    expect(isGeminiHomeConnected(home)).toBe(false);
    const oc = ensureMemberProviderHome(stateDir, "ana", "opencode");
    expect(isOpenCodeHomeConnected(oc)).toBe(false);
    NodeFS.mkdirSync(NodePath.join(oc, "opencode"), { recursive: true });
    NodeFS.writeFileSync(openCodeAuthPath(oc), "{}");
    expect(isOpenCodeHomeConnected(oc)).toBe(false);
    expect(isLoginHomeConnected("claude", oc)).toBe(false);
  });
});
