import {
  canReadFiles,
  SECRET_FILE_MESSAGE,
  sharedFolders,
  type ProjectId,
} from "@logicpacks/contracts";
import { refuseIfReadOnly } from "./readOnly.ts";
import {
  hiddenSecretTest,
  OUTSIDE_FOLDERS_MESSAGE,
  refuseIfFolderLimited,
  refuseIfZone,
  sharedFolderTest,
} from "./zoneHttp.ts";
import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { resolveHelperCaller } from "./helperHttp.ts";
import { json, queryParam, resolveCaller } from "./http.ts";
import { LogicPacksAccess } from "./LogicPacksAccess.ts";
import { LogicPacksSync } from "./LogicPacksSync.ts";
import {
  githubRepoOf,
  originRemote,
  ProjectFileError,
  publicCloneUrl,
  type UploadConflict,
  uploadMaxBytes,
  writeProjectUpload,
  zipFolderName,
  zipMaxBytes,
  zipProject,
} from "./projectFiles.ts";

/**
 * Getting a project's files in and out on the web: uploads into the working copy, a zip of it,
 * and what a computer needs to clone it. Members only reach projects shared with them; the
 * sync engine commits and pushes uploads like any other change in the checkout.
 */

const fileErrorStatus: Record<ProjectFileError["reason"], number> = {
  invalid_path: 400,
  outside_project: 403,
  too_large: 413,
  exists: 409,
  not_a_folder: 409,
};

const fileErrorResponse = (error: unknown) =>
  error instanceof ProjectFileError
    ? json({ error: error.reason, message: error.message }, fileErrorStatus[error.reason])
    : json({ error: "failed", message: error instanceof Error ? error.message : "Failed." }, 500);

/** The project's checkout on this host, when the caller may use it. */
const projectFor = Effect.fn("logicpacks.files.projectFor")(function* (projectId: string) {
  const caller = yield* resolveCaller;
  if (caller.kind === "anonymous") {
    return { ok: false as const, response: json({ error: "unauthenticated" }, 401) };
  }
  const access = yield* LogicPacksAccess;
  if (caller.kind === "member" && access.roleOf(caller.userId, projectId) === null) {
    return { ok: false as const, response: json({ error: "not_found" }, 404) };
  }
  const store = yield* ProjectStore.ProjectStoreV2;
  const shell = yield* store
    .getShell(projectId as ProjectId)
    .pipe(Effect.orElseSucceed(() => Option.none()));
  if (Option.isNone(shell)) {
    return { ok: false as const, response: json({ error: "not_found" }, 404) };
  }
  return {
    ok: true as const,
    caller,
    root: shell.value.workspaceRoot,
    title: shell.value.title,
  };
});

const conflictOf = (value: string): UploadConflict =>
  value === "replace" || value === "keep-both" ? value : "fail";

/** One file per request: the body is the file's bytes, `path` its project-relative name. */
const uploadRoute = HttpRouter.add(
  "POST",
  "/api/lp/projects/upload",
  Effect.gen(function* () {
    const uploadProjectId = yield* queryParam("projectId");
    const project = yield* projectFor(uploadProjectId);
    if (!project.ok) return project.response;
    const readOnly = yield* refuseIfReadOnly(project.caller, uploadProjectId);
    if (readOnly !== null) return readOnly;
    const zoneOff = yield* refuseIfZone(project.caller, uploadProjectId, ["files.write"]);
    if (zoneOff !== null) return zoneOff;
    const maxBytes = uploadMaxBytes();
    const request = yield* HttpServerRequest.HttpServerRequest;
    const declared = Number(request.headers["content-length"] ?? "0");
    if (Number.isFinite(declared) && declared > maxBytes) {
      return fileErrorResponse(
        new ProjectFileError(
          "too_large",
          `Files over ${Math.round(maxBytes / 1024 / 1024)} MB cannot be uploaded.`,
        ),
      );
    }
    const body = yield* request.arrayBuffer.pipe(
      Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(maxBytes)),
      Effect.option,
    );
    if (Option.isNone(body)) {
      return fileErrorResponse(
        new ProjectFileError(
          "too_large",
          `Files over ${Math.round(maxBytes / 1024 / 1024)} MB cannot be uploaded.`,
        ),
      );
    }
    const folder = yield* queryParam("folder");
    const path = yield* queryParam("path");
    const conflict = conflictOf(yield* queryParam("conflict"));
    // Secret files stay hidden unless the host granted them, for writes too.
    const hidden = yield* hiddenSecretTest(project.caller, uploadProjectId);
    if (hidden !== null && hidden([folder, path].filter(Boolean).join("/"))) {
      return json({ error: "zone_off", message: SECRET_FILE_MESSAGE }, 403);
    }
    const inFolders = yield* sharedFolderTest(project.caller, uploadProjectId, project.root);
    if (inFolders !== null && !inFolders([folder, path].filter(Boolean).join("/"))) {
      return json({ error: "zone_off", message: OUTSIDE_FOLDERS_MESSAGE }, 403);
    }
    return yield* Effect.sync(() => {
      try {
        return json(
          writeProjectUpload({
            root: project.root,
            folder,
            path,
            bytes: new Uint8Array(body.value),
            conflict,
            maxBytes,
          }),
        );
      } catch (error) {
        return fileErrorResponse(error);
      }
    });
  }),
);

/** The current working copy (tracked plus untracked, not ignored) as a zip. */
const zipRoute = HttpRouter.add(
  "GET",
  "/api/lp/projects/zip",
  Effect.gen(function* () {
    const zipProjectId = yield* queryParam("projectId");
    const project = yield* projectFor(zipProjectId);
    if (!project.ok) return project.response;
    const zoneOff = yield* refuseIfZone(project.caller, zipProjectId, ["files.read"]);
    if (zoneOff !== null) return zoneOff;
    const hiddenSecret = yield* hiddenSecretTest(project.caller, zipProjectId);
    const inFolders = yield* sharedFolderTest(project.caller, zipProjectId, project.root);
    const hidden =
      hiddenSecret === null && inFolders === null
        ? null
        : (relative: string) =>
            (hiddenSecret?.(relative) ?? false) || (inFolders !== null && !inFolders(relative));
    const folderName = zipFolderName(project.title);
    return yield* Effect.sync(() => {
      try {
        const zip = zipProject({
          root: project.root,
          folderName,
          maxBytes: zipMaxBytes(),
          exclude: hidden ?? undefined,
        });
        return HttpServerResponse.uint8Array(zip, {
          headers: {
            "content-type": "application/zip",
            "content-disposition": `attachment; filename="${folderName}.zip"`,
            "cache-control": "no-store",
          },
        });
      } catch (error) {
        return fileErrorResponse(error);
      }
    });
  }),
);

/** What "Get it on your computer" shows: the repository to clone and how fast changes arrive. */
const localRoute = HttpRouter.add(
  "GET",
  "/api/lp/projects/local",
  Effect.gen(function* () {
    const projectId = yield* queryParam("projectId");
    const project = yield* projectFor(projectId);
    if (!project.ok) return project.response;
    const zoneOff = yield* refuseIfZone(project.caller, projectId, ["files.read"]);
    if (zoneOff !== null) return zoneOff;
    const limited = yield* refuseIfFolderLimited(project.caller, projectId);
    if (limited !== null) return limited;
    const sync = yield* LogicPacksSync;
    const status = sync.status([projectId])[0];
    const remote = status?.remoteUrl ?? null;
    return json({
      projectId,
      title: project.title,
      synced: status !== undefined && status.state !== "not_synced" && remote !== null,
      cloneUrl: publicCloneUrl(remote ?? originRemote(project.root)),
      githubRepo: githubRepoOf(remote ?? originRemote(project.root)),
      branch: status?.branch ?? null,
      cloudHost: sync.isCloudHost,
      syncSeconds: sync.syncSeconds,
      uploadMaxBytes: uploadMaxBytes(),
    });
  }),
);

/** `lp clone`: the projects this helper's person can reach, with the repository to clone. */
const helperProjectsRoute = HttpRouter.add(
  "GET",
  "/api/lp/helper/projects",
  Effect.gen(function* () {
    const caller = yield* resolveHelperCaller;
    if (caller === null) {
      return json(
        { error: "unauthenticated", message: "Run lp login to connect this computer." },
        401,
      );
    }
    const access = yield* LogicPacksAccess;
    const sync = yield* LogicPacksSync;
    const store = yield* ProjectStore.ProjectStoreV2;
    const shells = yield* store.listShells().pipe(Effect.orElseSucceed(() => []));
    const visible = caller.kind === "member" ? access.visibleProjectIds(caller.userId) : null;
    // Only projects whose files this person may read: `lp clone` hands out the repository.
    const listed = shells.filter(
      (shell) =>
        (visible === null || visible.has(shell.id as string)) &&
        (caller.kind !== "member" ||
          (canReadFiles(access.zonesOf(caller.userId, shell.id as string).zones) &&
            sharedFolders(access.zonesOf(caller.userId, shell.id as string).zones).length === 0)),
    );
    const statuses = sync.status(listed.map((shell) => shell.id as string));
    return json({
      syncSeconds: sync.syncSeconds,
      projects: listed.map((shell, index) => {
        const remote = statuses[index]?.remoteUrl ?? originRemote(shell.workspaceRoot);
        return {
          projectId: shell.id,
          title: shell.title,
          cloneUrl: publicCloneUrl(remote),
          githubRepo: githubRepoOf(remote),
          branch: statuses[index]?.branch ?? null,
        };
      }),
    });
  }),
);

export const layer = Layer.mergeAll(uploadRoute, zipRoute, localRoute, helperProjectsRoute);
