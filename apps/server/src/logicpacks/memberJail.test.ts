// @effect-diagnostics nodeBuiltinImport:off -- the jail is checked against a real filesystem.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterAll, describe, expect, it } from "@effect/vitest";

import { parseSignupMode } from "./http.ts";
import {
  collectPayloadPaths,
  ensureMemberRoot,
  firstJailViolation,
  jailAllows,
  makeMemberJail,
  MEMBER_DENIED_METHODS,
  MEMBER_TERMINAL_METHODS,
  memberRootDir,
  resolveMemberPath,
  usesTildeOutsideHomeMethods,
} from "./memberJail.ts";

const base = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lp-jail-")));
afterAll(() => NodeFS.rmSync(base, { recursive: true, force: true }));

const ana = ensureMemberRoot(base, "ana");
const bo = ensureMemberRoot(base, "bo");
const userdata = NodePath.join(base, "userdata");
const shared = NodePath.join(base, "projects", "shared");
const secret = NodePath.join(base, "projects", "secret");
const worktrees = NodePath.join(base, "worktrees");
for (const dir of [userdata, shared, secret, worktrees]) NodeFS.mkdirSync(dir, { recursive: true });
NodeFS.writeFileSync(NodePath.join(userdata, "state.sqlite"), "");

/** A git worktree as GitVcsDriver lays it out: `<worktrees>/<repo>/<branch>/.git` -> gitdir. */
const fakeWorktree = (project: string, branch: string) => {
  const dir = NodePath.join(worktrees, NodePath.basename(project), branch);
  NodeFS.mkdirSync(dir, { recursive: true });
  NodeFS.mkdirSync(NodePath.join(project, ".git", "worktrees", branch), { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(dir, ".git"),
    `gitdir: ${NodePath.join(project, ".git", "worktrees", branch)}\n`,
  );
  return dir;
};
const sharedWorktree = fakeWorktree(shared, "feature");
const secretWorktree = fakeWorktree(secret, "main");

const jail = makeMemberJail({ memberRoot: ana, projectRoots: [shared], worktreesDir: worktrees });

describe("member root", () => {
  it("lives under <base>/members/<digest>, 0700", () => {
    expect(ana).toBe(memberRootDir(base, "ana"));
    expect(NodePath.dirname(ana)).toBe(NodePath.join(base, "members"));
    expect(NodePath.basename(ana)).toMatch(/^[0-9a-f]{16}$/);
    expect(NodeFS.statSync(ana).mode & 0o777).toBe(0o700);
  });

  it("never lets an id shape the path", () => {
    expect(NodePath.basename(memberRootDir(base, "../../root"))).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("resolveMemberPath", () => {
  it("resolves ~ to the member root", () => {
    expect(resolveMemberPath("~", null, ana)).toBe(ana);
    expect(resolveMemberPath("~/", null, ana)).toBe(ana);
    expect(resolveMemberPath("~/app/src", null, ana)).toBe(NodePath.join(ana, "app", "src"));
  });

  it("refuses .. segments, ~user, Windows and network paths", () => {
    expect(resolveMemberPath("~/../../", null, ana)).toBeNull();
    expect(resolveMemberPath("../../etc", "/srv", ana)).toBeNull();
    expect(resolveMemberPath(`${ana}/../bo`, null, ana)).toBeNull();
    expect(resolveMemberPath("~root/.ssh", null, ana)).toBeNull();
    expect(resolveMemberPath("C:\\Windows", null, ana)).toBeNull();
    expect(resolveMemberPath("\\\\host\\share", null, ana)).toBeNull();
  });

  it("anchors relative values to their cwd", () => {
    expect(resolveMemberPath("src/a.ts", shared, ana)).toBe(NodePath.join(shared, "src", "a.ts"));
    expect(resolveMemberPath("src/a.ts", "~/app", ana)).toBe(NodePath.join(ana, "app/src/a.ts"));
    expect(resolveMemberPath("src/a.ts", null, ana)).toBe("unanchored");
  });
});

describe("jailAllows", () => {
  it("lets a member into their root and the projects shared with them", () => {
    expect(jailAllows(jail, ana)).toBe(true);
    expect(jailAllows(jail, NodePath.join(ana, "new", "deep"))).toBe(true);
    expect(jailAllows(jail, shared)).toBe(true);
    expect(jailAllows(jail, NodePath.join(shared, "src"))).toBe(true);
  });

  it("keeps them out of the host, the state dir, other members and unshared projects", () => {
    expect(jailAllows(jail, "/root")).toBe(false);
    expect(jailAllows(jail, "/root/.secrets/claude-oauth-token")).toBe(false);
    expect(jailAllows(jail, "/")).toBe(false);
    expect(jailAllows(jail, userdata)).toBe(false);
    expect(jailAllows(jail, NodePath.join(base, "members"))).toBe(false);
    expect(jailAllows(jail, bo)).toBe(false);
    expect(jailAllows(jail, `${ana}-evil`)).toBe(false);
    expect(jailAllows(jail, secret)).toBe(false);
  });

  it("follows symlinks before deciding", () => {
    NodeFS.symlinkSync(userdata, NodePath.join(ana, "escape"));
    NodeFS.symlinkSync(shared, NodePath.join(ana, "linked-project"));
    expect(jailAllows(jail, NodePath.join(ana, "escape"))).toBe(false);
    expect(jailAllows(jail, NodePath.join(ana, "escape", "state.sqlite"))).toBe(false);
    expect(jailAllows(jail, NodePath.join(ana, "escape", "not-yet", "x"))).toBe(false);
    expect(jailAllows(jail, NodePath.join(ana, "linked-project"))).toBe(true);
  });

  it("allows worktrees of shared projects only", () => {
    expect(jailAllows(jail, sharedWorktree)).toBe(true);
    expect(jailAllows(jail, NodePath.join(sharedWorktree, "src"))).toBe(true);
    expect(jailAllows(jail, secretWorktree)).toBe(false);
    expect(jailAllows(jail, worktrees)).toBe(false);
  });
});

describe("payload checks", () => {
  it("finds the paths in the RPCs that touch the filesystem", () => {
    expect(collectPayloadPaths({ partialPath: "~/", cwd: shared }).map((p) => p.value)).toEqual([
      "~/",
      shared,
    ]);
    expect(
      collectPayloadPaths({ cwd: shared, relativePath: "a.ts", contents: "/root" }).map((p) => [
        p.value,
        p.base,
      ]),
    ).toEqual([
      [shared, null],
      ["a.ts", shared],
    ]);
    expect(collectPayloadPaths({ paths: ["/a", "/b"] }).map((p) => p.value)).toEqual(["/a", "/b"]);
    expect(
      collectPayloadPaths({ resource: { _tag: "media-file", path: "/root/.ssh/id_rsa" } }).map(
        (p) => p.value,
      ),
    ).toEqual(["/root/.ssh/id_rsa"]);
    // Chat text is never read as a path.
    expect(collectPayloadPaths({ type: "message.dispatch", text: "cat /root/x" })).toEqual([]);
  });

  it("browse: ~/ is fine, /root, the state dir and ../../ are not", () => {
    expect(firstJailViolation(jail, { partialPath: "~/" })).toBeNull();
    expect(firstJailViolation(jail, { partialPath: "~/pro" })).toBeNull();
    expect(firstJailViolation(jail, { partialPath: "/root/" })).not.toBeNull();
    expect(firstJailViolation(jail, { partialPath: `${userdata}/` })).not.toBeNull();
    expect(firstJailViolation(jail, { partialPath: "~/../../" })).not.toBeNull();
    expect(firstJailViolation(jail, { partialPath: "./../../", cwd: shared })).not.toBeNull();
    expect(firstJailViolation(jail, { partialPath: "/" })).not.toBeNull();
  });

  it("file reads and writes stay inside", () => {
    expect(firstJailViolation(jail, { cwd: shared, relativePath: "src/a.ts" })).toBeNull();
    expect(firstJailViolation(jail, { cwd: shared, relativePath: "../secret/a" })).not.toBeNull();
    expect(firstJailViolation(jail, { cwd: secret, relativePath: "a" })).not.toBeNull();
    expect(
      firstJailViolation(jail, { paths: [NodePath.join(ana, "x"), "/etc/passwd"] }),
    ).not.toBeNull();
  });

  it("project create, clone and attachments are jailed too", () => {
    expect(
      firstJailViolation(jail, { type: "project.create", workspaceRoot: NodePath.join(ana, "a") }),
    ).toBeNull();
    expect(
      firstJailViolation(jail, { type: "project.create", workspaceRoot: "/root" }),
    ).not.toBeNull();
    expect(firstJailViolation(jail, { destinationPath: "/root/vpoblender" })).not.toBeNull();
    expect(
      firstJailViolation(jail, { resource: { _tag: "media-file", path: "/root/.ssh/id_rsa" } }),
    ).not.toBeNull();
    expect(firstJailViolation(jail, { cwd: "/root", worktreePath: null })).not.toBeNull();
  });

  it("only browse and metadata may use ~ (their handlers see the member's home)", () => {
    expect(usesTildeOutsideHomeMethods("filesystem.browse", { partialPath: "~/" })).toBe(false);
    expect(usesTildeOutsideHomeMethods("projects.mutate", { workspaceRoot: "~/app" })).toBe(true);
    expect(usesTildeOutsideHomeMethods("projects.readFile", { cwd: shared })).toBe(false);
  });

  it("host-only RPCs and terminals are listed", () => {
    expect(MEMBER_DENIED_METHODS.has("shell.openInEditor")).toBe(true);
    expect(MEMBER_DENIED_METHODS.has("agentSessions.scan")).toBe(true);
    expect(MEMBER_TERMINAL_METHODS.has("terminal.open")).toBe(true);
    expect(MEMBER_TERMINAL_METHODS.has("terminal.write")).toBe(true);
  });
});

describe("parseSignupMode", () => {
  it("defaults to open and treats unknown values as invite", () => {
    expect(parseSignupMode(undefined)).toBe("open");
    expect(parseSignupMode("")).toBe("open");
    expect(parseSignupMode("OPEN")).toBe("open");
    expect(parseSignupMode("invite")).toBe("invite");
    expect(parseSignupMode("closed")).toBe("closed");
    expect(parseSignupMode("nope")).toBe("invite");
  });
});
