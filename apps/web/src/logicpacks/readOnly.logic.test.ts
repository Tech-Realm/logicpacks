import { describe, expect, it } from "vite-plus/test";

import type { LpSession, LpWorkspace } from "./api";
import { isReadOnlyIn, LP_READONLY_BANNER_TEXT } from "./readOnly.logic";

const workspace = (
  workspaceId: string,
  role: LpWorkspace["role"],
  projectIds: ReadonlyArray<string>,
): LpWorkspace => ({ workspaceId, name: workspaceId, role, memberCount: 2, projectIds });

const session = (
  workspaces: ReadonlyArray<LpWorkspace>,
  currentWorkspaceId: string | null,
  member = true,
) =>
  ({
    user: member ? { userId: "bo", email: "bo@x", displayName: "Bo" } : null,
    workspaces,
    currentWorkspaceId,
  }) as unknown as LpSession;

describe("isReadOnlyIn", () => {
  const ws = [workspace("w1", "viewer", ["p1"]), workspace("w2", "member", ["p2"])];

  it("is read only in every project of a viewer workspace, and only there", () => {
    expect(isReadOnlyIn(session(ws, "w2"), "p1")).toBe(true);
    expect(isReadOnlyIn(session(ws, "w1"), "p2")).toBe(false);
  });

  it("follows the current workspace when no project is named", () => {
    expect(isReadOnlyIn(session(ws, "w1"), null)).toBe(true);
    expect(isReadOnlyIn(session(ws, "w2"), null)).toBe(false);
    expect(isReadOnlyIn(session(ws, null), null)).toBe(false);
  });

  it("never applies to the host operator, a signed-out view or an unlisted project", () => {
    expect(isReadOnlyIn(session(ws, "w1", false), "p1")).toBe(false);
    expect(isReadOnlyIn(null, "p1")).toBe(false);
    expect(isReadOnlyIn(session(ws, "w1"), "shared-on-its-own")).toBe(false);
  });

  it("owners and members can edit", () => {
    expect(isReadOnlyIn(session([workspace("w", "owner", ["p"])], "w"), "p")).toBe(false);
  });

  it("uses the agreed banner text", () => {
    expect(LP_READONLY_BANNER_TEXT).toBe(
      "You have read-only access to this workspace. Ask an owner to let you edit.",
    );
  });
});
