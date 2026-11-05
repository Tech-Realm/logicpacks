import { seatCanMutate, seatIn } from "./accessZones.logic";
import type { LpSession } from "./api";

/** Shown in place of the composer for a Read only member. */
export const LP_READONLY_BANNER_TEXT =
  "You have read-only access to this workspace. Ask an owner to let you edit.";

/**
 * Whether the signed-in member may only read where this project (or, with none, their current
 * workspace) lives. Mirrors the server: a Read only seat holds in all of a workspace's projects.
 * The host operator and a project shared on its own are never read only.
 */
export function isReadOnlyIn(session: LpSession | null, projectId: string | null): boolean {
  if (session === null || session.user == null) return false;
  // The server derives Read only from the member's access zones: use its answer when it sent one.
  const seat = seatIn(session, projectId);
  if (seat !== null) return !seatCanMutate(seat);
  if (projectId !== null) {
    const owning = session.workspaces.find((workspace) => workspace.projectIds.includes(projectId));
    return owning?.role === "viewer";
  }
  const current = session.workspaces.find(
    (workspace) => workspace.workspaceId === session.currentWorkspaceId,
  );
  return current?.role === "viewer";
}
