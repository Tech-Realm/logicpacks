import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  cloneFolderName,
  cloneProject,
  type HelperProject,
  pickProject,
  syncDelayText,
} from "./clone.ts";
import type { HelperConfig } from "./store.ts";

const made: Array<string> = [];
const tempDir = () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lp-clone-test-"));
  made.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of made.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
});

const project = (overrides: Partial<HelperProject>): HelperProject => ({
  projectId: "p-1",
  title: "Team site",
  cloneUrl: "https://github.com/acme/team-site.git",
  githubRepo: "acme/team-site",
  branch: "main",
  ...overrides,
});

const git = (cwd: string, ...args: Array<string>) =>
  NodeChildProcess.execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd,
    stdio: "pipe",
  }).toString();

/** A host that answers /api/lp/helper/projects with `projects`. */
const startHost = async (projects: ReadonlyArray<HelperProject>) => {
  const server = NodeHttp.createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.headers.authorization !== "Bearer tok") {
      response.statusCode = 401;
      response.end(JSON.stringify({ error: "unauthenticated" }));
      return;
    }
    response.end(JSON.stringify({ syncSeconds: 120, projects }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as NodeNet.AddressInfo;
  return { url: `http://127.0.0.1:${port}`, close: () => server.close() };
};

const configFor = (server: string): HelperConfig =>
  ({ server, token: "tok", unlinked: [] }) as unknown as HelperConfig;

describe("lp clone", () => {
  it("picks a project by id, repository or title", () => {
    const list = [
      project({}),
      project({ projectId: "p-2", title: "Docs", githubRepo: "acme/docs" }),
    ];
    expect(pickProject(list, "p-2")).toMatchObject({ title: "Docs" });
    expect(pickProject(list, "ACME/team-site")).toMatchObject({ projectId: "p-1" });
    expect(pickProject(list, " team site ")).toMatchObject({ projectId: "p-1" });
    expect(pickProject(list, "nope")).toMatchObject({
      error: expect.stringContaining("Docs  (p-2)"),
    });
    const twins = [project({}), project({ projectId: "p-3" })];
    expect(pickProject(twins, "Team site")).toMatchObject({
      error: expect.stringContaining("p-1, p-3"),
    });
  });

  it("names the folder after the repository or title", () => {
    expect(cloneFolderName(project({}))).toBe("team-site");
    expect(cloneFolderName(project({ githubRepo: null, title: "My App / v2" }))).toBe("My-App-v2");
  });

  it("describes the host pull delay", () => {
    expect(syncDelayText(120)).toBe("within 2 minutes");
    expect(syncDelayText(20)).toBe("within 20 seconds");
    expect(syncDelayText(0)).toBe("after the next sync");
  });

  it("clones the project's repository, and explains a project that is not synced", async () => {
    const root = tempDir();
    const bare = NodePath.join(root, "remote.git");
    git(root, "init", "-q", "--bare", "-b", "main", bare);
    const seed = NodePath.join(root, "seed");
    git(root, "clone", "-q", bare, seed);
    NodeFS.writeFileSync(NodePath.join(seed, "index.html"), "<h1>hi</h1>");
    git(seed, "add", ".");
    git(seed, "commit", "-qm", "seed");
    git(seed, "push", "-q", "origin", "HEAD:main");
    const host = await startHost([
      project({ cloneUrl: bare, githubRepo: null, title: "Site" }),
      project({ projectId: "p-9", title: "Starter", cloneUrl: null, githubRepo: null }),
    ]);
    try {
      const lines: Array<string> = [];
      const work = tempDir();
      const cloned = await cloneProject({
        config: configFor(host.url),
        wanted: "Site",
        folder: null,
        cwd: work,
        say: (line) => lines.push(line),
      });
      expect(cloned?.folder).toBe(NodePath.join(work, "Site"));
      expect(cloned?.syncSeconds).toBe(120);
      expect(NodeFS.readFileSync(NodePath.join(work, "Site", "index.html"), "utf8")).toBe(
        "<h1>hi</h1>",
      );

      const again = await cloneProject({
        config: configFor(host.url),
        wanted: "Site",
        folder: null,
        cwd: work,
        say: (line) => lines.push(line),
      });
      expect(again).toBeNull();
      expect(lines.at(-1)).toContain("not empty");

      const starter = await cloneProject({
        config: configFor(host.url),
        wanted: "Starter",
        folder: null,
        cwd: work,
        say: (line) => lines.push(line),
      });
      expect(starter).toBeNull();
      expect(lines.at(-1)).toContain("Press Sync");
    } finally {
      host.close();
    }
  });
});
