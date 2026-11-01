import { describe, expect, it } from "@effect/vitest";

import {
  createdProjectId,
  cwdIsReachable,
  filterListResultForMember,
  filterShellItemForMember,
  memberSubject,
  memberUserIdFromSubject,
  normalizeUserReference,
  requiresOwner,
  rpcTargets,
} from "./projectAccess.ts";

describe("member subjects", () => {
  it("round-trips a member and leaves operator subjects alone", () => {
    expect(memberUserIdFromSubject(memberSubject("u1"))).toBe("u1");
    expect(memberUserIdFromSubject("browser")).toBeNull();
    expect(memberUserIdFromSubject("lp-user:")).toBeNull();
  });

  it("names teammates by email or quick-login name", () => {
    expect(normalizeUserReference("Bea")).toBe("bea@logicpacks.internal");
    expect(normalizeUserReference(" Noor@Example.com ")).toBe("noor@example.com");
    expect(normalizeUserReference("not a name")).toBeNull();
  });
});

describe("rpc fence inputs", () => {
  it("reads every thread id a command can name", () => {
    expect(
      rpcTargets({ type: "thread.fork", sourceThreadId: "a", targetThreadId: "b", projectId: "p" }),
    ).toEqual({ projectIds: ["p"], threadIds: ["a", "b"], cwds: [] });
    expect(rpcTargets(null)).toEqual({ projectIds: [], threadIds: [], cwds: [] });
    expect(rpcTargets({ remoteUrl: "x", destinationPath: "/srv/x" }).cwds).toEqual(["/srv/x"]);
  });

  it("treats only creation results as new projects", () => {
    expect(createdProjectId("projects.mutate", { type: "project.create" }, { id: "p1" })).toBe(
      "p1",
    );
    expect(createdProjectId("projects.mutate", { type: "project.update" }, { id: "p1" })).toBe(
      null,
    );
    expect(createdProjectId("projects.createNew", {}, { projectId: "p2" })).toBe("p2");
    expect(createdProjectId("orchestration.dispatchCommand", {}, { projectId: "p3" })).toBe(null);
  });

  it("keeps deletion with the owner", () => {
    expect(requiresOwner("projects.mutate", { type: "project.delete" })).toBe(true);
    expect(requiresOwner("projects.mutate", { type: "project.update" })).toBe(false);
  });

  it("reaches folders inside visible projects and worktrees only", () => {
    const roots = ["/srv/projects/app"];
    expect(cwdIsReachable("/srv/projects/app/src", roots, "/logicpacks/worktrees")).toBe(true);
    expect(cwdIsReachable("/srv/projects/app", roots, "/logicpacks/worktrees")).toBe(true);
    expect(cwdIsReachable("/srv/projects/app-secret", roots, "/logicpacks/worktrees")).toBe(false);
    expect(cwdIsReachable("/logicpacks/worktrees/x", roots, "/logicpacks/worktrees")).toBe(true);
    expect(cwdIsReachable("/etc", roots, "/logicpacks/worktrees")).toBe(false);
  });
});

describe("shell stream filtering", () => {
  const canSee = (projectId: string) => projectId === "mine";
  const project = (id: string) => ({ id }) as never;
  const thread = (id: string, projectId: string) => ({ id, projectId }) as never;

  it("drops projects and threads that are not shared", () => {
    const filtered = filterShellItemForMember(
      {
        kind: "snapshot",
        snapshot: {
          schemaVersion: 1,
          snapshotSequence: 3,
          projects: [project("mine"), project("theirs")],
          threads: [thread("t1", "mine"), thread("t2", "theirs")],
          archivedThreads: [thread("logicpacks", "theirs")],
        },
      },
      canSee,
    );
    expect(filtered).toMatchObject({
      snapshot: {
        projects: [{ id: "mine" }],
        threads: [{ id: "t1" }],
        archivedThreads: [],
      },
    });
    expect(
      filterShellItemForMember(
        { kind: "thread.updated", sequence: 4, location: "active", thread: thread("t2", "theirs") },
        canSee,
      ),
    ).toBeNull();
    expect(
      filterShellItemForMember(
        { kind: "project.removed", sequence: 5, projectId: "x" as never },
        canSee,
      ),
    ).not.toBeNull();
  });
});

describe("list results", () => {
  it("keeps only rows of visible projects", () => {
    const canSee = (projectId: string) => projectId === "mine";
    expect(
      filterListResultForMember(
        {
          snapshotSequence: 1,
          projects: [{ id: "mine" }, { id: "theirs" }],
          threads: [{ projectId: "mine" }, { projectId: "theirs" }],
          matches: [{ projectId: "theirs", snippet: "secret" }],
          counts: [{ projectId: "theirs", count: 3 }],
        },
        canSee,
      ),
    ).toEqual({
      snapshotSequence: 1,
      projects: [{ id: "mine" }],
      threads: [{ projectId: "mine" }],
      matches: [],
      counts: [],
    });
  });
});
