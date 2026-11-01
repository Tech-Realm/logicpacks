// @effect-diagnostics nodeBuiltinImport:off -- real git repositories in a temp folder.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterAll, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  type GitRunner,
  isSyncIntent,
  repositoryNameFor,
  resolveConflict,
  syncTick,
} from "./syncGit.ts";

const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lp-sync-git-"));
afterAll(() => NodeFS.rmSync(root, { recursive: true, force: true }));

const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

const runner =
  (cwd: string): GitRunner =>
  (args) =>
    Effect.sync(() => {
      const result = NodeChildProcess.spawnSync("git", [...args], {
        cwd,
        env: gitEnv,
        encoding: "utf8",
      });
      return { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
    });

const sh = (cwd: string, ...args: string[]) => {
  const result = NodeChildProcess.spawnSync("git", args, { cwd, env: gitEnv, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
};

/** A bare "GitHub" and two checkouts of it, like a laptop and the cloud host. */
const setup = (name: string) => {
  const remote = NodePath.join(root, name, "remote.git");
  NodeFS.mkdirSync(remote, { recursive: true });
  sh(remote, "init", "--bare", "-q", "-b", "main");
  const laptop = NodePath.join(root, name, "laptop");
  NodeFS.mkdirSync(laptop);
  sh(laptop, "init", "-q", "-b", "main");
  NodeFS.writeFileSync(NodePath.join(laptop, "README.md"), "hello\n");
  sh(laptop, "add", "-A");
  sh(laptop, "commit", "-q", "-m", "start");
  sh(laptop, "remote", "add", "origin", remote);
  sh(laptop, "push", "-q", "-u", "origin", "main");
  const cloud = NodePath.join(root, name, "cloud");
  sh(root, "clone", "-q", remote, cloud);
  return { remote, laptop, cloud };
};

const options = { busy: false, autoCommit: true, commitMessage: "LogicPacks: save work" };

describe("syncTick", () => {
  it.effect("saves and pushes local work, then the other checkout pulls it", () =>
    Effect.gen(function* () {
      const { laptop, cloud } = setup("push-pull");
      NodeFS.writeFileSync(NodePath.join(laptop, "page.html"), "<h1>hi</h1>\n");
      const pushed = yield* syncTick(runner(laptop), options);
      expect(pushed.state).toBe("synced");
      expect(pushed.committed).toBe(true);
      expect(pushed.pushed).toBe(1);

      const pulled = yield* syncTick(runner(cloud), options);
      expect(pulled.state).toBe("synced");
      expect(pulled.pulled).toBe(1);
      expect(NodeFS.readFileSync(NodePath.join(cloud, "page.html"), "utf8")).toContain("hi");
    }),
  );

  it.effect("rebases local commits over teammates' pushes", () =>
    Effect.gen(function* () {
      const { laptop, cloud } = setup("rebase");
      NodeFS.writeFileSync(NodePath.join(cloud, "cloud.txt"), "from cloud\n");
      yield* syncTick(runner(cloud), options);
      NodeFS.writeFileSync(NodePath.join(laptop, "laptop.txt"), "from laptop\n");
      const tick = yield* syncTick(runner(laptop), options);
      expect(tick.state).toBe("synced");
      expect(tick.pulled).toBe(1);
      expect(tick.pushed).toBe(1);
      expect(sh(laptop, "log", "--format=%s").split("\n")).toHaveLength(3);
    }),
  );

  it.effect("only fetches while an agent is mid-turn", () =>
    Effect.gen(function* () {
      const { laptop, cloud } = setup("busy");
      NodeFS.writeFileSync(NodePath.join(cloud, "cloud.txt"), "from cloud\n");
      yield* syncTick(runner(cloud), options);
      NodeFS.writeFileSync(NodePath.join(laptop, "draft.txt"), "half done\n");
      const tick = yield* syncTick(runner(laptop), { ...options, busy: true });
      expect(tick.state).toBe("busy");
      expect(tick.behind).toBe(1);
      expect(sh(laptop, "status", "--porcelain")).toContain("draft.txt");
      expect(NodeFS.existsSync(NodePath.join(laptop, "cloud.txt"))).toBe(false);
    }),
  );

  it.effect("reports a conflict without leaving the checkout mid-rebase, then resolves it", () =>
    Effect.gen(function* () {
      const { laptop, cloud, remote } = setup("conflict");
      NodeFS.writeFileSync(NodePath.join(cloud, "README.md"), "cloud version\n");
      yield* syncTick(runner(cloud), options);
      NodeFS.writeFileSync(NodePath.join(laptop, "README.md"), "laptop version\n");
      const tick = yield* syncTick(runner(laptop), options);
      expect(tick.state).toBe("conflict");
      expect(tick.conflictFiles).toEqual(["README.md"]);
      expect(sh(laptop, "status", "--porcelain")).toBe("");
      expect(NodeFS.existsSync(NodePath.join(laptop, ".git", "rebase-merge"))).toBe(false);

      // Still a conflict on the next pass, until someone settles it.
      expect((yield* syncTick(runner(laptop), options)).state).toBe("conflict");

      const resolved = yield* resolveConflict(runner(laptop), "mine", "merge");
      expect(resolved.ok).toBe(true);
      expect(NodeFS.readFileSync(NodePath.join(laptop, "README.md"), "utf8")).toBe(
        "laptop version\n",
      );
      expect(sh(remote, "show", "main:README.md")).toBe("laptop version");
      expect((yield* syncTick(runner(cloud), options)).state).toBe("synced");
      expect(NodeFS.readFileSync(NodePath.join(cloud, "README.md"), "utf8")).toBe(
        "laptop version\n",
      );
    }),
  );

  it.effect("keeps theirs when asked", () =>
    Effect.gen(function* () {
      const { laptop, cloud } = setup("theirs");
      NodeFS.writeFileSync(NodePath.join(cloud, "README.md"), "cloud version\n");
      yield* syncTick(runner(cloud), options);
      NodeFS.writeFileSync(NodePath.join(laptop, "README.md"), "laptop version\n");
      yield* syncTick(runner(laptop), options);
      const resolved = yield* resolveConflict(runner(laptop), "theirs", "merge");
      expect(resolved.ok).toBe(true);
      expect(NodeFS.readFileSync(NodePath.join(laptop, "README.md"), "utf8")).toBe(
        "cloud version\n",
      );
    }),
  );
});

describe("isSyncIntent", () => {
  it("hears a request to sync to the cloud", () => {
    expect(isSyncIntent("sync this to the cloud")).toBe(true);
    expect(isSyncIntent("Please publish the project to the cloud host")).toBe(true);
    expect(isSyncIntent("sync")).toBe(true);
    expect(isSyncIntent("Sync this project.")).toBe(true);
  });

  it("ignores everything else", () => {
    expect(isSyncIntent("don't sync this to the cloud yet")).toBe(false);
    expect(isSyncIntent("fix the sync bug in cloud.ts and the retry logic")).toBe(false);
    expect(isSyncIntent("add a login page")).toBe(false);
  });
});

describe("repositoryNameFor", () => {
  it("makes a GitHub-safe name", () => {
    expect(repositoryNameFor("Team Site!")).toBe("team-site");
    expect(repositoryNameFor("...")).toBe("logicpacks-project");
  });
});
