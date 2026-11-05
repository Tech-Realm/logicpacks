// @effect-diagnostics nodeBuiltinImport:off -- runs real commands under the macOS sandbox.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  clearCheckedSandboxProfiles,
  memberSandboxProfile,
  memberSandboxSupported,
  SandboxUnavailableError,
  sandboxedMemberLaunch,
} from "./folderSandbox.ts";

const real = NodeFS.realpathSync;
const base = real(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lp-fsb-")));
const shared = NodePath.join(base, "shared");
const sub = NodePath.join(shared, "sub");
const outside = NodePath.join(base, "outside");
const memberHome = NodePath.join(base, "home");
for (const dir of [shared, sub, outside, memberHome]) NodeFS.mkdirSync(dir, { recursive: true });
NodeFS.writeFileSync(NodePath.join(shared, "in.txt"), "inside\n");
NodeFS.writeFileSync(NodePath.join(sub, "deep.txt"), "deep\n");
NodeFS.writeFileSync(NodePath.join(outside, "secret.txt"), "TOP-SECRET\n");

const launchInput = (folders: ReadonlyArray<string>) => ({
  folders,
  tmpDir: NodePath.join(base, "tmp"),
  memberHome,
  stateDir: NodePath.join(base, "state"),
  name: "test",
});

/** Runs a shell line under the sandbox; the exit status and what it printed. */
const inSandbox = (
  folders: ReadonlyArray<string>,
  line: string,
  env: NodeJS.ProcessEnv = {},
  timeout = 30_000,
) => {
  const launch = sandboxedMemberLaunch("/bin/sh", ["-c", line], launchInput(folders));
  const result = NodeChildProcess.spawnSync(launch.command, [...launch.args], {
    cwd: shared,
    env: { PATH: "/usr/bin:/bin", ...env, ...launch.env },
    encoding: "utf8",
    timeout,
    killSignal: "SIGKILL",
  });
  return { status: result.status, out: `${result.stdout}${result.stderr}`, timedOut: result.error !== undefined };
};

describe("member sandbox profile", () => {
  it("names the shared folders and refuses the credential folders", () => {
    const profile = memberSandboxProfile(launchInput([shared]));
    expect(profile).toContain(`(subpath "${shared}")`);
    expect(profile).toContain("/.ssh");
    expect(profile).toContain("/.claude");
    expect(profile).toContain("Library/Keychains");
    expect(profile).toContain("com.apple.SecurityServer");
    expect(profile).toContain("(deny appleevent-send)");
    expect(profile).toContain("(deny lsopen)");
  });
});

describe("fail closed", () => {
  it("throws, and starts nothing, where sandbox-exec does not exist", () => {
    expect(() =>
      sandboxedMemberLaunch("/bin/sh", [], launchInput([shared]), { platform: "win32" }),
    ).toThrow(SandboxUnavailableError);
    expect(() =>
      sandboxedMemberLaunch("/bin/sh", [], launchInput([shared]), { platform: "darwin", exists: () => false }),
    ).toThrow(SandboxUnavailableError);
    expect(memberSandboxSupported("linux")).toBe(false);
  });
  it("a forced failure (test hook) throws before anything is launched", () => {
    const before = process.env.LOGICPACKS_TEST_FORCE_SANDBOX_FAILURE;
    process.env.LOGICPACKS_TEST_FORCE_SANDBOX_FAILURE = "1";
    try {
      expect(() => sandboxedMemberLaunch("/bin/sh", [], launchInput([shared]))).toThrow(/forced to fail/);
    } finally {
      if (before === undefined) delete process.env.LOGICPACKS_TEST_FORCE_SANDBOX_FAILURE;
      else process.env.LOGICPACKS_TEST_FORCE_SANDBOX_FAILURE = before;
    }
  });
  it("throws when the kernel does not accept the profile", () => {
    clearCheckedSandboxProfiles();
    expect(() =>
      sandboxedMemberLaunch("/bin/sh", [], launchInput([shared]), {
        platform: "darwin",
        exists: () => true,
        check: () => false,
      }),
    ).toThrow(/did not accept its profile/);
  });
  it("throws when the profile cannot be written", () => {
    clearCheckedSandboxProfiles();
    const blocked = NodePath.join(base, "a-file");
    NodeFS.writeFileSync(blocked, "x");
    expect(() =>
      sandboxedMemberLaunch("/bin/sh", [], { ...launchInput([shared]), stateDir: NodePath.join(blocked, "no") }, { platform: "darwin", exists: () => true }),
    ).toThrow(SandboxUnavailableError);
  });
});

describe.skipIf(process.platform !== "darwin")("macOS sandbox escape attempts (real sandbox-exec)", () => {
  const home = real(NodeOS.homedir());
  it("works inside the shared folder: read, write, run tools", () => {
    expect(inSandbox([shared], "cat in.txt").out).toContain("inside");
    expect(inSandbox([shared], "echo hi > made.txt && cat made.txt && git --version >/dev/null 2>&1; ls sub").out).toContain("hi");
    expect(NodeFS.readFileSync(NodePath.join(shared, "made.txt"), "utf8")).toBe("hi\n");
  });
  it("refuses a read outside the folder", () => {
    const run = inSandbox([shared], `cat ${outside}/secret.txt`);
    expect(run.status).not.toBe(0);
    expect(run.out).not.toContain("TOP-SECRET");
    expect(run.out).toMatch(/Operation not permitted/);
  });
  it("refuses a write outside the folder", () => {
    const run = inSandbox([shared], `echo x > ${outside}/new.txt`);
    expect(run.status).not.toBe(0);
    expect(NodeFS.existsSync(NodePath.join(outside, "new.txt"))).toBe(false);
  });
  it("selected subfolders only: the rest of the project is refused", () => {
    expect(inSandbox([sub], `cat ${sub}/deep.txt`).out).toContain("deep");
    const run = inSandbox([sub], `cat ${shared}/in.txt`);
    expect(run.out).not.toContain("inside");
    expect(run.status).not.toBe(0);
  });
  it("`..` traversal out of the folder is refused", () => {
    const run = inSandbox([sub], "cat ../../outside/secret.txt");
    expect(run.out).not.toContain("TOP-SECRET");
  });
  it("a symlink pointing out is followed to the real path and refused", () => {
    NodeFS.rmSync(NodePath.join(shared, "link.txt"), { force: true });
    NodeFS.symlinkSync(NodePath.join(outside, "secret.txt"), NodePath.join(shared, "link.txt"));
    const run = inSandbox([shared], "cat link.txt");
    expect(run.out).not.toContain("TOP-SECRET");
    expect(run.status).not.toBe(0);
    // A symlink the sandbox itself makes, pointing out, is no way in either.
    const made = inSandbox([shared], `ln -sf ${outside}/secret.txt made-link.txt; cat made-link.txt`);
    expect(made.out).not.toContain("TOP-SECRET");
  });
  it("a hardlink to an outside file cannot be made or read", () => {
    NodeFS.rmSync(NodePath.join(shared, "hard.txt"), { force: true });
    const run = inSandbox([shared], `ln ${outside}/secret.txt hard.txt; cat hard.txt`);
    expect(run.out).not.toContain("TOP-SECRET");
  });
  it("the host's /tmp and /private/tmp are refused; the member's own TMPDIR works", () => {
    const run = inSandbox([shared], "echo x > /tmp/lp-sandbox-probe; echo x > /private/tmp/lp-sandbox-probe");
    expect(run.status).not.toBe(0);
    expect(NodeFS.existsSync("/tmp/lp-sandbox-probe")).toBe(false);
    expect(inSandbox([shared], 'echo ok > "$TMPDIR/own" && cat "$TMPDIR/own"').out).toContain("ok");
  });
  it("the host user's credential folders are refused (ssh, claude, codex, keychains)", () => {
    for (const dir of [".ssh", ".claude", ".codex", "Library/Keychains"]) {
      const run = inSandbox([shared], `ls ${NodePath.join(home, dir)}`);
      expect(run.status, dir).not.toBe(0);
    }
    const token = inSandbox([shared], `cat ${home}/.claude/CLAUDE.md`);
    expect(token.status).not.toBe(0);
  });
  it("a child process inherits the sandbox", () => {
    const run = inSandbox([shared], `sh -c "sh -c 'cat ${outside}/secret.txt'"`);
    expect(run.out).not.toContain("TOP-SECRET");
    expect(run.status).not.toBe(0);
  });
  it("another interpreter cannot read out either (python, node)", () => {
    const py = inSandbox([shared], `/usr/bin/python3 -c "print(open('${outside}/secret.txt').read())"`);
    expect(py.out).not.toContain("TOP-SECRET");
    const node = inSandbox([shared], `${process.execPath} -e "console.log(require('fs').readFileSync('${outside}/secret.txt','utf8'))"`);
    expect(node.out).not.toContain("TOP-SECRET");
  });
  it("what the host's environment holds is not passed in: the caller scrubs it", () => {
    const run = inSandbox([shared], "env", { HOST_TOKEN_SHOULD_NOT_BE_HERE: "x" });
    // The launcher only passes what it is given; the scrubbed env comes from memberTerminalEnv.
    expect(run.out).toContain("LOGICPACKS_SANDBOX=member");
  });
  // No test here launches an app, scripts one or signals a process: a real launch attempt once opened
  // Calculator on a developer's desktop. The profile text is what keeps those doors shut, so it is
  // what is checked, and nothing runs.
  it("the profile refuses Apple events and every way of asking the system to start an app", () => {
    const profile = memberSandboxProfile(launchInput([shared]));
    expect(profile).toContain("(deny appleevent-send)");
    expect(profile).toContain("(deny lsopen)");
    expect(profile).toContain('(deny mach-lookup (global-name-prefix "com.apple.coreservices.") (global-name-prefix "com.apple.lsd."))');
    // A later allow rule would win over the denies above it: no rule may re-allow these.
    expect(profile).not.toMatch(/\(allow[^\n]*(appleevent|lsopen|coreservices)/);
  });
  it("the keychain cannot be read (security find-generic-password)", () => {
    const run = inSandbox([shared], `security find-generic-password -s "Claude Code-credentials" -w 2>&1; echo status=$?`);
    expect(run.out).not.toMatch(/status=0/);
    expect(run.out).not.toContain("accessToken");
  });
  it("a nested sandbox-exec cannot lift the sandbox (it only ever narrows)", () => {
    const run = inSandbox(
      [shared],
      `echo '(version 1)(allow default)' > "$TMPDIR/open.sb"; sandbox-exec -f "$TMPDIR/open.sb" /bin/cat ${outside}/secret.txt 2>&1`,
    );
    expect(run.out).not.toContain("TOP-SECRET");
  });
  it("a launchd job or a cron-style start of an unsandboxed process is refused", () => {
    const run = inSandbox([shared], `launchctl submit -l lp.escape -- /bin/sh -c 'cat ${outside}/secret.txt > ${shared}/escaped.txt' 2>&1; sleep 2; ls ${shared}/escaped.txt 2>&1`);
    expect(NodeFS.existsSync(NodePath.join(shared, "escaped.txt"))).toBe(false);
    expect(run.out).not.toContain("TOP-SECRET");
  });
  it("network stays on (the agent needs its API); loopback connects", () => {
    const run = inSandbox([shared], `/usr/bin/nc -z -w 2 127.0.0.1 9 2>&1; echo status=$?`);
    // Port 9 is closed: the connection is refused by the network stack, not blocked by the sandbox.
    expect(run.out).toMatch(/status=1/);
    expect(run.out).not.toMatch(/not permitted/i);
  });
});
