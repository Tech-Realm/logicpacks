import { CommandId, ProjectId } from "@logicpacks/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SourceControlRepositoryService from "../sourceControl/SourceControlRepositoryService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { LogicPacksAccess } from "./LogicPacksAccess.ts";
import { MemberOAuth } from "./MemberOAuth.ts";
import { githubTokenGitEnv } from "./oauthProviders.ts";
import { acceptRepositoryInvitation } from "./LogicPacksSync.ts";
import { revealClaimedProject } from "./reveal.ts";

/**
 * Where a synced repository lives on the cloud host, from its remote URL:
 * `git@github.com:acme/app.git` and `https://github.com/acme/app` both land in
 * `acme-app`, so every member who syncs the same repository finds one project.
 */
export const syncFolderName = (remoteUrl: string): string | null => {
  const trimmed = remoteUrl
    .trim()
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");
  const match = /[:/]([^/:\s]+)\/([^/:\s]+)$/.exec(trimmed);
  const owner = match?.[1];
  const repo = match?.[2];
  if (!owner || !repo || [owner, repo].some((part) => part === "." || part === "..")) return null;
  const slug = `${owner}-${repo}`.toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
  return slug.startsWith(".") ? null : slug.slice(0, 100);
};

export type SyncImportResult =
  | {
      readonly kind: "imported" | "existing";
      readonly projectId: string;
      readonly workspaceRoot: string;
    }
  | { readonly kind: "invalid_remote" }
  | { readonly kind: "not_shared"; readonly projectId: string };

const cloneAsMember = Effect.fn("logicpacks.cloneAsMember")(function* (
  remoteUrl: string,
  destination: string,
  token: string,
) {
  const path = yield* Path.Path;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const fileSystem = yield* FileSystem.FileSystem;
  yield* fileSystem.makeDirectory(path.dirname(destination), { recursive: true });
  yield* git.execute({
    operation: "logicpacks.sync.cloneAsMember",
    cwd: path.dirname(destination),
    args: ["clone", "--quiet", "--", remoteUrl, path.basename(destination)],
    env: githubTokenGitEnv(token),
    timeoutMs: 10 * 60_000,
  });
  return destination;
});

/**
 * The cloud half of Sync: clone what a laptop pushed, follow its upstream
 * (autoPull), make the caller owner and share it. Repeating it for the same
 * remote returns the existing project.
 */
export const importSyncedProject = Effect.fn("logicpacks.importSyncedProject")(function* (input: {
  readonly remoteUrl: string;
  readonly title?: string | undefined;
  readonly callerUserId: string | null;
  readonly shareWith: ReadonlyArray<string>;
}) {
  const folder = syncFolderName(input.remoteUrl);
  if (folder === null) return { kind: "invalid_remote" } as SyncImportResult;
  const path = yield* Path.Path;
  const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
  const projects = yield* ProjectService.ProjectService;
  const repositories = yield* SourceControlRepositoryService.SourceControlRepositoryService;
  const access = yield* LogicPacksAccess;
  const crypto = yield* Crypto.Crypto;
  const settings = yield* ServerSettings.ServerSettingsService;
  const destination = path.join(folders.namedProjectsRoot, folder);

  const fileSystem = yield* FileSystem.FileSystem;
  const folderExists = yield* fileSystem
    .exists(destination)
    .pipe(Effect.orElseSucceed(() => false));
  const existing = folderExists
    ? yield* projects.getByWorkspaceRoot(destination)
    : Option.none<{ readonly id: ProjectId }>();
  if (Option.isSome(existing)) {
    const projectId = existing.value.id;
    if (input.callerUserId !== null && access.roleOf(input.callerUserId, projectId) === null) {
      return { kind: "not_shared", projectId } as SyncImportResult;
    }
    if (!access.isSynced(projectId)) yield* access.markSynced(projectId, input.remoteUrl);
    return { kind: "existing", projectId, workspaceRoot: destination } as SyncImportResult;
  }

  // A member with GitHub connected clones (and later pushes) with their own token, so their
  // private repositories need no invite to the host's account. Only HTTPS remotes take it.
  const oauth = yield* Effect.serviceOption(MemberOAuth);
  const memberToken =
    input.callerUserId !== null &&
    oauth._tag === "Some" &&
    /^https:\/\/github\.com\//i.test(input.remoteUrl.trim())
      ? yield* oauth.value.connectionToken(input.callerUserId, "github")
      : null;
  // A private repository is cloned as this host's GitHub account, which Sync invited.
  if (!folderExists && memberToken === null) yield* acceptRepositoryInvitation(input.remoteUrl);
  // A folder left by an earlier clone whose project was removed is reused, not cloned over.
  const workspaceRoot = folderExists
    ? destination
    : memberToken !== null
      ? yield* cloneAsMember(input.remoteUrl.trim(), destination, memberToken)
      : (yield* repositories.cloneRepository({
          remoteUrl: input.remoteUrl,
          destinationPath: destination,
        })).cwd;
  const projectId = ProjectId.make(yield* crypto.randomUUIDv4());
  yield* projects.create({
    commandId: CommandId.make(yield* crypto.randomUUIDv4()),
    projectId,
    title: input.title?.trim() || folder,
    workspaceRoot,
  });
  // The host checkout follows GitHub: LogicPacksSync's engine pulls and pushes it continuously.
  yield* settings.updateSettings({
    projectSettingsOverrides: { [projectId]: { defaultAutoPull: true } },
  });
  yield* access.markSynced(projectId, input.remoteUrl);
  if (input.callerUserId !== null) {
    yield* access.recordOwner(projectId, input.callerUserId);
    if (memberToken !== null) yield* access.setSyncPusher(projectId, input.callerUserId);
  }
  const workspaceId = access.currentWorkspaceId(input.callerUserId);
  if (workspaceId !== null) yield* access.attachProject(projectId, workspaceId);
  yield* revealClaimedProject(projectId);
  for (const teammate of input.shareWith) {
    yield* access
      .addMember({ projectId, actorUserId: input.callerUserId, user: teammate })
      .pipe(
        Effect.catch((error) => Effect.logWarning("Sync could not share", { teammate, error })),
      );
  }
  return { kind: "imported", projectId, workspaceRoot } as SyncImportResult;
});
