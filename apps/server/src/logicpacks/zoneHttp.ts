// @effect-diagnostics nodeBuiltinImport:off -- joins a project root and a relative path before the real-path check.
import * as Effect from "effect/Effect";

import * as NodePath from "node:path";

import {
  canReadSecrets,
  NEW_WORKSPACE_MESSAGE,
  PROJECTS_OFF_MESSAGE,
  sharedFolders,
} from "@logicpacks/contracts";

import { isSecretPath, secretPatterns } from "./externalTeam.ts";
import { LogicPacksAccess } from "./LogicPacksAccess.ts";
import { json } from "./http.ts";
import { folderAllows, resolveSharedFolders } from "./memberJail.ts";
import { refusalFor, type ZoneNeed } from "./zoneGate.ts";

/**
 * The HTTP side of the access zones: a 403 `zone_off` for a member whose zones do not include
 * what the route does, in the project it acts on. The host operator and tokens that are not a
 * member (the local helper) are never refused. Read only is separate (`refuseIfReadOnly`) and is
 * itself derived from the zones.
 */
export const refuseIfZone = Effect.fn("logicpacks.refuseIfZone")(function* (
  caller: { readonly kind: string; readonly userId?: string },
  projectId: string | null,
  needs: ReadonlyArray<ZoneNeed>,
) {
  if (caller.kind !== "member" || caller.userId === undefined) return null;
  const access = yield* LogicPacksAccess;
  const message = refusalFor(access.zonesOf(caller.userId, projectId).zones, needs);
  return message === null ? null : json({ error: "zone_off", needs, message }, 403);
});

/**
 * For a member whose secret files are hidden in this project, a test that says which project
 * paths to hide (the same patterns as the external team's); null when they may see them all.
 */
export const hiddenSecretTest = Effect.fn("logicpacks.hiddenSecretTest")(function* (
  caller: { readonly kind: string; readonly userId?: string },
  projectId: string | null,
) {
  if (caller.kind !== "member" || caller.userId === undefined) return null;
  const access = yield* LogicPacksAccess;
  if (canReadSecrets(access.zonesOf(caller.userId, projectId).zones)) return null;
  const patterns = secretPatterns(process.env.LOGICPACKS_EXTERNAL_SECRET_PATTERNS);
  return (relative: string) => isSecretPath(relative, patterns);
});

/**
 * Making a project or a workspace on this host: a 403 for a member without the Projects zone
 * (cloud hosts and accounts that predate the zone are not refused). The host operator is never
 * refused. A new workspace is not offered at all yet, with its own words.
 */
export const refuseIfProjectsOff = Effect.fn("logicpacks.refuseIfProjectsOff")(function* (
  caller: { readonly kind: string; readonly userId?: string },
  what: "project" | "workspace" = "project",
) {
  if (caller.kind !== "member" || caller.userId === undefined) return null;
  const access = yield* LogicPacksAccess;
  if (access.canCreateProjects(caller.userId)) return null;
  return json(
    {
      error: "zone_off",
      zone: "projects",
      message: what === "workspace" ? NEW_WORKSPACE_MESSAGE : PROJECTS_OFF_MESSAGE,
    },
    403,
  );
});

export const FOLDERS_ONLY_MESSAGE =
  "The host shared only some folders of this project, so it cannot be cloned or synced as a whole.";
export const OUTSIDE_FOLDERS_MESSAGE =
  "That is outside the folders the host shared with you.";

/**
 * For a member whose Files zone shares only some folders of the project: a test that is true for
 * the project-relative paths they may touch (checked on the REAL path, so a symlink or `..` cannot
 * lead out). Null when they have the whole project (or are the host).
 */
export const sharedFolderTest = Effect.fn("logicpacks.sharedFolderTest")(function* (
  caller: { readonly kind: string; readonly userId?: string },
  projectId: string | null,
  root: string,
) {
  if (caller.kind !== "member" || caller.userId === undefined) return null;
  const access = yield* LogicPacksAccess;
  const entries = sharedFolders(access.zonesOf(caller.userId, projectId).zones);
  if (entries.length === 0) return null;
  const { folders } = resolveSharedFolders(root, entries);
  return (relative: string) => folderAllows(folders, NodePath.join(root, relative));
});

/** Whole-repository routes (clone, sync) are closed to a member who was given only some folders. */
export const refuseIfFolderLimited = Effect.fn("logicpacks.refuseIfFolderLimited")(function* (
  caller: { readonly kind: string; readonly userId?: string },
  projectId: string | null,
) {
  if (caller.kind !== "member" || caller.userId === undefined) return null;
  const access = yield* LogicPacksAccess;
  if (sharedFolders(access.zonesOf(caller.userId, projectId).zones).length === 0) return null;
  return json({ error: "zone_off", zone: "files", message: FOLDERS_ONLY_MESSAGE }, 403);
});
