// @effect-diagnostics nodeBuiltinImport:off -- checks the generated runner with node itself.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterAll, describe, expect, it } from "@effect/vitest";

import { memberInstanceId } from "./memberProviders.ts";
import {
  memberSandboxEnabled,
  planMemberSpawn,
  projectGroupName,
  runnerSource,
  sandboxDigest,
  sandboxHome,
  sandboxInstanceConfig,
  sandboxUserName,
  scrubMemberEnv,
  wrapperSource,
  type SandboxRuntime,
} from "./memberSandbox.ts";

const base = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lp-sbx-")));
afterAll(() => NodeFS.rmSync(base, { recursive: true, force: true }));

const serviceEnv = {
  HOME: "/root",
  USER: "root",
  PATH: "/opt/lp-v2-tools/bin:/usr/bin",
  GH_TOKEN: "ghp_host",
  GITHUB_TOKEN: "ghp_host2",
  SSH_AUTH_SOCK: "/tmp/agent",
  GIT_ASKPASS: "/root/askpass",
  GIT_AUTHOR_NAME: "LogicPacks Cloud",
  AWS_SECRET_ACCESS_KEY: "aws",
  SOME_SERVICE_SECRET: "x",
  CLAUDE_CODE_OAUTH_TOKEN: "member-token",
  CLAUDE_CONFIG_DIR: "/srv/lp-v2/members/abc/.lp/claude",
  CODEX_HOME: "/srv/lp-v2/members/abc/.lp/codex",
  XDG_DATA_HOME: "/srv/lp-v2/members/abc/.lp/opencode",
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  IS_SANDBOX: "1",
  LOGICPACKS_TELEMETRY_ENABLED: "false",
};
const digest = sandboxDigest("ana");

describe("scrubMemberEnv", () => {
  const env = scrubMemberEnv(serviceEnv, {
    user: "lpm-x",
    home: "/srv/lp-v2/members/x",
    path: "/opt/lp-v2-tools/bin:/usr/bin:/bin",
  });

  it("drops host secrets and the root home", () => {
    for (const name of [
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "SSH_AUTH_SOCK",
      "GIT_ASKPASS",
      "AWS_SECRET_ACCESS_KEY",
      "SOME_SERVICE_SECRET",
      "GIT_AUTHOR_NAME",
    ]) {
      expect(env[name]).toBeUndefined();
    }
    expect(env.HOME).toBe("/srv/lp-v2/members/x");
    expect(env.USER).toBe("lpm-x");
    expect(env.LOGNAME).toBe("lpm-x");
    expect(env.TMPDIR).toBe("/srv/lp-v2/members/x/.tmp");
    expect(env.PATH).toBe("/opt/lp-v2-tools/bin:/usr/bin:/bin");
  });

  it("keeps what the provider needs: its own token and homes", () => {
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("member-token");
    expect(env.CLAUDE_CONFIG_DIR).toBe(serviceEnv.CLAUDE_CONFIG_DIR);
    expect(env.CODEX_HOME).toBe(serviceEnv.CODEX_HOME);
    expect(env.XDG_DATA_HOME).toBe(serviceEnv.XDG_DATA_HOME);
    expect(env.LANG).toBe("C.UTF-8");
    expect(env.LC_ALL).toBe("C.UTF-8");
  });

  it("lets git work in group-shared projects without host credentials", () => {
    expect(env.GIT_CONFIG_KEY_0).toBe("safe.directory");
    expect(env.GIT_CONFIG_KEY_1).toBe("credential.helper");
    expect(env.GIT_CONFIG_VALUE_1).toBe("");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
  });
});

describe("planMemberSpawn", () => {
  it("runs the CLI as lpm-<digest> with HOME at the member root, umask 007, scrubbed env", () => {
    const plan = planMemberSpawn({
      baseDir: "/srv/lp-v2",
      digest,
      kind: "opencode",
      binary: "/opt/lp-v2-tools/bin/opencode",
      args: ["serve", "--port", "0"],
      env: serviceEnv,
      toolsPath: "/opt/lp-v2-tools/bin:/usr/bin:/bin",
    });
    expect(plan.user).toBe(sandboxUserName(digest));
    expect(plan.user).toMatch(/^lpm-[0-9a-f]{16}$/);
    expect(plan.home).toBe(sandboxHome("/srv/lp-v2", digest));
    // The runner stays root to seal the login again; setpriv runs the CLI as the member.
    expect(plan.command).toBe("setpriv");
    expect(plan.args).toEqual([
      "--reuid",
      plan.user,
      "--regid",
      plan.user,
      "--init-groups",
      "--",
      "/opt/lp-v2-tools/bin/opencode",
      "serve",
      "--port",
      "0",
    ]);
    expect(plan.providerHome).toBe(`${plan.home}/.lp/opencode`);
    expect(plan.leaseDir).toBe(`/srv/lp-v2/sandbox/leases/${digest}/opencode`);
    expect(plan.umask).toBe(0o007);
    expect(plan.env.GH_TOKEN).toBeUndefined();
    expect(plan.env.HOME).toBe(plan.home);
  });

  it("refuses anything that is not a digest (no path tricks in the user name)", () => {
    expect(() =>
      planMemberSpawn({
        baseDir: "/srv",
        digest: "../root",
        kind: "claude",
        binary: "x",
        args: [],
        env: {},
        toolsPath: "",
      }),
    ).toThrow();
    expect(() =>
      planMemberSpawn({
        baseDir: "/srv",
        digest,
        kind: "../x",
        binary: "x",
        args: [],
        env: {},
        toolsPath: "",
      }),
    ).toThrow();
  });
});

describe("runner and wrapper", () => {
  it("the generated runner is valid JavaScript and refuses to run when not root", () => {
    const file = NodePath.join(base, "lp-member-run.mjs");
    NodeFS.writeFileSync(file, runnerSource("/usr/bin:/bin"));
    const check = NodeChildProcess.spawnSync(process.execPath, ["--check", file]);
    expect(check.status).toBe(0);
    if (process.getuid?.() !== 0) {
      const run = NodeChildProcess.spawnSync(
        process.execPath,
        [file, base, digest, "claude", "/usr/bin/id"],
        {
          encoding: "utf8",
        },
      );
      expect(run.status).toBe(126);
      expect(run.stderr).toContain("must start as root");
    }
  });

  it("the wrapper execs the runner with the member's digest and the real CLI", () => {
    const source = wrapperSource({
      nodePath: "/opt/node/bin/node",
      baseDir: "/srv/lp-v2",
      digest,
      kind: "claude",
      binary: "/opt/lp-v2-tools/bin/claude",
    });
    expect(source).toBe(
      `#!/bin/sh\nexec '/opt/node/bin/node' '/srv/lp-v2/sandbox/lp-member-run.mjs' '/srv/lp-v2' '${digest}' 'claude' '/opt/lp-v2-tools/bin/claude' "$@"\n`,
    );
  });
});

describe("sandboxInstanceConfig", () => {
  const runtime: SandboxRuntime = {
    baseDir: base,
    nodePath: process.execPath,
    toolsPath: "/usr/bin:/bin",
    binaries: { claude: "/opt/c", codex: "/opt/x", opencode: "/opt/o", gemini: "/opt/g" },
  };

  it("points a member's Claude at their wrapper and their own home", () => {
    const id = memberInstanceId("claude", "ana");
    const out = sandboxInstanceConfig(
      id,
      {
        driver: "claudeAgent",
        environment: [{ name: "CLAUDE_CODE_OAUTH_TOKEN", value: "t", sensitive: true }],
        config: {
          homePath: "/srv/lp-v2/userdata/logicpacks/members/ana/claude",
          binaryPath: "/opt/c",
        },
      },
      runtime,
    );
    const config = out.config as Record<string, string>;
    expect(config.binaryPath).toBe(NodePath.join(base, "sandbox", "bin", digest, "claude"));
    expect(config.homePath).toBe(NodePath.join(base, "members", digest, ".lp", "claude"));
    expect(NodeFS.readFileSync(config.binaryPath!, "utf8")).toContain(
      `'${digest}' 'claude' '/opt/c'`,
    );
    expect(out.environment).toEqual([
      { name: "CLAUDE_CODE_OAUTH_TOKEN", value: "t", sensitive: true },
    ]);
  });

  it("moves OpenCode's and Gemini's data homes into the member home", () => {
    const open = sandboxInstanceConfig(
      memberInstanceId("opencode", "ana"),
      {
        driver: "opencode",
        environment: [{ name: "XDG_DATA_HOME", value: "/old", sensitive: false }],
        config: {},
      },
      runtime,
    );
    const openEnv = open.environment as ReadonlyArray<{
      name: string;
      value: string;
      sensitive: boolean;
    }>;
    expect(openEnv[0]).toEqual({
      name: "XDG_DATA_HOME",
      value: NodePath.join(base, "members", digest, ".lp", "opencode"),
      sensitive: false,
    });
    // Every member's user can reach 127.0.0.1, so their OpenCode server needs a password.
    const password = openEnv.find((entry) => entry.name === "OPENCODE_SERVER_PASSWORD");
    expect(password?.sensitive).toBe(true);
    expect(password?.value.length).toBeGreaterThanOrEqual(24);
    const again = sandboxInstanceConfig(
      memberInstanceId("opencode", "ana"),
      { driver: "opencode", environment: [], config: {} },
      runtime,
    ).environment as ReadonlyArray<{ name: string; value: string }>;
    expect(again.find((entry) => entry.name === "OPENCODE_SERVER_PASSWORD")?.value).toBe(
      password?.value,
    );
    const other = sandboxInstanceConfig(
      memberInstanceId("opencode", "bo"),
      { driver: "opencode", environment: [], config: {} },
      runtime,
    ).environment as ReadonlyArray<{ name: string; value: string }>;
    expect(other.find((entry) => entry.name === "OPENCODE_SERVER_PASSWORD")?.value).not.toBe(
      password?.value,
    );
    const gemini = sandboxInstanceConfig(
      memberInstanceId("gemini", "ana"),
      { driver: "acp", environment: [], config: { commandPath: "/opt/g", commandArgs: ["--acp"] } },
      runtime,
    );
    expect((gemini.config as unknown as Record<string, string>).commandPath).toBe(
      NodePath.join(base, "sandbox", "bin", digest, "gemini"),
    );
  });

  it("leaves the operator's instances and a disabled sandbox alone", () => {
    const host = { driver: "claudeAgent", config: { binaryPath: "/usr/bin/claude" } };
    expect(sandboxInstanceConfig("claudeAgent", host, runtime)).toBe(host);
    const member = { driver: "claudeAgent", config: {} };
    expect(sandboxInstanceConfig(memberInstanceId("claude", "ana"), member, null)).toBe(member);
  });
});

describe("names and switches", () => {
  it("project groups are short stable names", () => {
    expect(projectGroupName("project-1")).toMatch(/^lp-p-[0-9a-f]{12}$/);
    expect(projectGroupName("project-1")).toBe(projectGroupName("project-1"));
  });

  it("is on only with LOGICPACKS_MEMBER_SANDBOX=user", () => {
    expect(memberSandboxEnabled({})).toBe(false);
    expect(memberSandboxEnabled({ LOGICPACKS_MEMBER_SANDBOX: "user" })).toBe(true);
  });
});
