// @effect-diagnostics-next-line nodeBuiltinImport:off -- gh is a plain subprocess; no Effect wrapper exists for it.
import * as NodeChildProcess from "node:child_process";
import { FeatureAccess } from "./FeatureAccess.ts";

import {
  LP_HOST_PARTICIPANT_ID,
  type ProjectId,
  SourceControlProviderKind,
  type ThreadId,
} from "@logicpacks/contracts";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import { HttpClient, HttpClientRequest } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SourceControlRepositoryService from "../sourceControl/SourceControlRepositoryService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { LogicPacksAccess } from "./LogicPacksAccess.ts";
import { readMemberConnection } from "./MemberOAuth.ts";
import { githubCreateRepository, githubTokenGitEnv } from "./oauthProviders.ts";
import { type ActivityKind, LogicPacksUsage } from "./LogicPacksUsage.ts";
import {
  commitAll,
  type ConflictStrategy,
  currentBranch,
  type GitRunner,
  hasCommits,
  identityArgs,
  isRepository,
  remoteUrl as readRemoteUrl,
  repositoryNameFor,
  resolveConflict,
  SYNC_REMOTE,
  syncTick,
  type TickResult,
} from "./syncGit.ts";

/**
 * LogicPacks sync: a project moves from "only on this machine" to a GitHub
 * remote plus a checkout on the cloud host, and every checkout keeps pushing
 * its work and pulling everyone else's. The same engine runs on a laptop and on
 * the cloud host, so the host keeps syncing while the laptop is off.
 */

export type SyncState = "not_synced" | "syncing" | "synced" | "conflict" | "error";

export interface ProjectSyncStatus {
  readonly projectId: string;
  readonly state: SyncState;
  readonly remoteUrl: string | null;
  readonly branch: string | null;
  /** The cloud host this checkout registered with; null on the cloud host itself. */
  readonly cloudUrl: string | null;
  readonly cloudProjectId: string | null;
  readonly ahead: number;
  readonly behind: number;
  readonly conflictFiles: ReadonlyArray<string>;
  readonly theirsAuthor: string | null;
  /** What is happening or what went wrong, in a sentence for the UI. */
  readonly message: string | null;
  readonly lastSyncedAt: string | null;
}

export interface CloudHostInfo {
  /** This server is the team's cloud host: projects synced here are on the cloud. */
  readonly isCloudHost: boolean;
  readonly url: string;
  readonly connected: boolean;
  readonly account: string | null;
}

export class LogicPacksSyncError extends Schema.TaggedError<LogicPacksSyncError>()(
  "LogicPacksSyncError",
  {
    reason: Schema.Literals([
      "unknown_project",
      "connect_cloud",
      "cloud_rejected",
      "not_synced",
      "no_conflict",
      "busy",
      "failed",
    ]),
    message: Schema.String,
  },
) {}

export const DEFAULT_CLOUD_URL = "https://app.logicpacks.io";
const CLOUD_SECRET = "logicpacks-cloud-session";

export class LogicPacksSync extends Context.Service<
  LogicPacksSync,
  {
    readonly isCloudHost: boolean;
    /** How often the engine saves, pulls and pushes synced projects (LOGICPACKS_SYNC_SECONDS; 0 = off). */
    readonly syncSeconds: number;
    /** Synchronous so list routes can decorate projects without waiting on git. */
    readonly status: (projectIds: ReadonlyArray<string>) => ReadonlyArray<ProjectSyncStatus>;
    /** Starts the Sync flow in the background and returns its first status. */
    readonly start: (input: {
      readonly projectId: string;
      readonly actorUserId: string | null;
    }) => Effect.Effect<ProjectSyncStatus, LogicPacksSyncError>;
    /** Runs one sync pass now (after a turn, or from the Sync now button). */
    readonly syncNow: (projectId: string) => Effect.Effect<ProjectSyncStatus, LogicPacksSyncError>;
    readonly resolve: (input: {
      readonly projectId: string;
      readonly strategy: ConflictStrategy;
      /** Who settled it, for their achievements; null or absent is the host. */
      readonly actorUserId?: string | null | undefined;
    }) => Effect.Effect<ProjectSyncStatus, LogicPacksSyncError>;
    readonly cloud: () => Effect.Effect<CloudHostInfo>;
    readonly connectCloud: (input: {
      readonly url: string;
      readonly mode: "signup" | "login";
      readonly email: string;
      readonly password: string;
      readonly displayName?: string | undefined;
    }) => Effect.Effect<CloudHostInfo, LogicPacksSyncError>;
    readonly disconnectCloud: () => Effect.Effect<CloudHostInfo>;
    /** The GitHub account this host clones and pushes as, so owners can add it to private repos. */
    readonly githubLogin: () => Effect.Effect<string | null>;
  }
>()("logicpacks/logicpacks/LogicPacksSync") {}

const fail = (reason: LogicPacksSyncError["reason"], message: string) =>
  Effect.fail(new LogicPacksSyncError({ reason, message }));

/** `gh` with arguments, never through a shell. Resolves whatever happens. */
const runGh = (args: ReadonlyArray<string>, cwd?: string) =>
  Effect.callback<{ readonly code: number; readonly stdout: string; readonly stderr: string }>(
    (resume) => {
      NodeChildProcess.execFile(
        "gh",
        [...args],
        { cwd, timeout: 60_000, env: { ...process.env, GH_PROMPT_DISABLED: "1" } },
        (error, stdout, stderr) => {
          const code =
            error === null ? 0 : typeof error.code === "number" ? error.code : error.code ? 1 : 1;
          resume(Effect.succeed({ code, stdout: String(stdout), stderr: String(stderr) }));
        },
      );
    },
  );

/** `owner/repo` of a GitHub remote, or null for anything else. */
export const githubRepository = (remote: string): string | null => {
  const match = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(remote.trim());
  return match ? `${match[1]}/${match[2]}` : null;
};

const normalizeCloudUrl = (raw: string): string | null => {
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin;
  } catch {
    return null;
  }
};

interface CloudRow {
  readonly url: string;
  readonly account: string | null;
}

interface LinkRow {
  readonly project_id: string;
  readonly cloud_url: string | null;
  readonly cloud_project_id: string | null;
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const gitDriver = yield* GitVcsDriver.GitVcsDriver;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const access = yield* LogicPacksAccess;
  const usage = yield* Effect.serviceOption(LogicPacksUsage);
  /** Feeds achievements (first sync, conflicts resolved); never fails a sync. */
  const recordUsage = (
    actorUserId: string | null | undefined,
    kind: ActivityKind,
    subject: string,
    projectId: string,
  ) =>
    usage._tag === "None"
      ? Effect.void
      : usage.value
          .recordActivity({
            participantId: actorUserId ?? LP_HOST_PARTICIPANT_ID,
            kind,
            subject,
            projectId,
          })
          .pipe(
            Effect.catch((error) => Effect.logWarning("Could not record sync activity", { error })),
            Effect.asVoid,
          );
  const repositories = yield* SourceControlRepositoryService.SourceControlRepositoryService;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const httpClient = yield* HttpClient.HttpClient;

  const isCloudHost = yield* Config.Boolean("LOGICPACKS_CLOUD_HOST").pipe(
    Config.withDefault(false),
    Effect.orElseSucceed(() => false),
  );
  const envCloudUrl = yield* Config.String("LOGICPACKS_CLOUD_URL").pipe(
    Config.withDefault(DEFAULT_CLOUD_URL),
    Effect.orElseSucceed(() => DEFAULT_CLOUD_URL),
  );
  const autoCommit = yield* Config.Boolean("LOGICPACKS_SYNC_AUTOCOMMIT").pipe(
    Config.withDefault(true),
    Effect.orElseSucceed(() => true),
  );
  // Tests stand a folder of bare repositories in for GitHub.
  const remoteRoot = yield* Config.String("LOGICPACKS_SYNC_REMOTE_ROOT").pipe(
    Config.withDefault(""),
    Effect.orElseSucceed(() => ""),
  );
  const hostLabel = isCloudHost ? "the cloud host" : "this computer";

  yield* Effect.all(
    [
      sql`
        CREATE TABLE IF NOT EXISTS logicpacks_cloud_host (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          url TEXT NOT NULL,
          account TEXT,
          connected_at TEXT NOT NULL
        )
      `,
      sql`
        CREATE TABLE IF NOT EXISTS logicpacks_sync_links (
          project_id TEXT PRIMARY KEY,
          cloud_url TEXT,
          cloud_project_id TEXT,
          linked_at TEXT NOT NULL
        )
      `,
    ],
    { discard: true },
  ).pipe(Effect.orDie);

  const links = new Map<string, { cloudUrl: string | null; cloudProjectId: string | null }>();
  for (const row of yield* sql<LinkRow>`
    SELECT project_id, cloud_url, cloud_project_id FROM logicpacks_sync_links
  `.pipe(Effect.orDie)) {
    links.set(row.project_id, { cloudUrl: row.cloud_url, cloudProjectId: row.cloud_project_id });
  }
  const remotes = new Map<string, string>();
  for (const row of yield* sql<{ readonly project_id: string; readonly remote_url: string }>`
    SELECT project_id, remote_url FROM logicpacks_synced_projects
  `.pipe(Effect.orDie)) {
    remotes.set(row.project_id, row.remote_url);
  }

  // The live part of each project's status; rebuilt by the first tick after a restart.
  const live = new Map<
    string,
    Omit<ProjectSyncStatus, "projectId" | "cloudUrl" | "cloudProjectId" | "remoteUrl">
  >();
  const locks = new Map<string, Semaphore.Semaphore>();
  const lockFor = (projectId: string) => {
    let lock = locks.get(projectId);
    if (lock === undefined) {
      lock = Semaphore.makeUnsafe(1);
      locks.set(projectId, lock);
    }
    return lock;
  };
  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const statusOf = (projectId: string): ProjectSyncStatus => {
    const link = links.get(projectId);
    const synced = access.isSynced(projectId);
    const current = live.get(projectId);
    return {
      projectId,
      remoteUrl: remotes.get(projectId) ?? null,
      cloudUrl: link?.cloudUrl ?? null,
      cloudProjectId: link?.cloudProjectId ?? null,
      state: current?.state ?? (synced ? "synced" : "not_synced"),
      branch: current?.branch ?? null,
      ahead: current?.ahead ?? 0,
      behind: current?.behind ?? 0,
      conflictFiles: current?.conflictFiles ?? [],
      theirsAuthor: current?.theirsAuthor ?? null,
      message: current?.message ?? null,
      lastSyncedAt: current?.lastSyncedAt ?? null,
    };
  };

  const setLive = (projectId: string, patch: Partial<ProjectSyncStatus>) => {
    const previous = statusOf(projectId);
    live.set(projectId, {
      state: patch.state ?? previous.state,
      branch: patch.branch !== undefined ? patch.branch : previous.branch,
      ahead: patch.ahead ?? previous.ahead,
      behind: patch.behind ?? previous.behind,
      conflictFiles: patch.conflictFiles ?? previous.conflictFiles,
      theirsAuthor: patch.theirsAuthor !== undefined ? patch.theirsAuthor : previous.theirsAuthor,
      message: patch.message !== undefined ? patch.message : previous.message,
      lastSyncedAt: patch.lastSyncedAt !== undefined ? patch.lastSyncedAt : previous.lastSyncedAt,
    });
  };

  const runnerFor =
    (cwd: string, env?: Record<string, string>): GitRunner =>
    (args) =>
      gitDriver
        .execute({
          operation: "logicpacks.sync",
          cwd,
          args,
          allowNonZeroExit: true,
          timeoutMs: 120_000,
          ...(env === undefined ? {} : { env }),
        })
        .pipe(
          Effect.map((result) => ({
            code: Number(result.exitCode),
            stdout: result.stdout,
            stderr: result.stderr,
          })),
          Effect.catch((error) =>
            Effect.succeed({ code: 1, stdout: "", stderr: String(error.message ?? error) }),
          ),
        );

  /** A member's own GitHub token, looked up by that member's id only. */
  const memberGithubToken = (userId: string | null) =>
    userId === null
      ? Effect.succeed(null)
      : readMemberConnection(secrets, userId, "github").pipe(
          Effect.map((stored) => stored?.accessToken ?? null),
        );

  /**
   * Git for a synced project: as the member who synced it when their GitHub is still
   * connected, otherwise as the host's own account, as before.
   */
  const projectGit = Effect.fn("LogicPacksSync.projectGit")(function* (
    projectId: string,
    root: string,
  ) {
    const token = yield* memberGithubToken(access.syncPusher(projectId));
    return runnerFor(root, token === null ? undefined : githubTokenGitEnv(token));
  });

  const projectRoot = Effect.fn("LogicPacksSync.projectRoot")(function* (projectId: string) {
    const shell = yield* projects
      .getShell(projectId as ProjectId)
      .pipe(Effect.orElseSucceed(() => Option.none()));
    if (Option.isNone(shell)) return yield* fail("unknown_project", "That project is gone.");
    return { root: shell.value.workspaceRoot, title: shell.value.title };
  });

  /** An agent is mid-turn in the project: the syncer must not move its files. */
  const projectBusy = Effect.fn("LogicPacksSync.projectBusy")(function* (projectId: string) {
    const index = yield* threads.listActiveShellIndex().pipe(Effect.orElseSucceed(() => []));
    for (const entry of index) {
      if (entry.projectId !== projectId || !entry.mayBeLive) continue;
      const shell = yield* threads
        .getThreadShell(entry.id as ThreadId)
        .pipe(Effect.orElseSucceed(() => null));
      // Worktree threads work in their own checkout, not the project's.
      if (shell?.activeRunId != null && shell.worktreePath == null) return true;
    }
    return false;
  });

  // ── Cloud host connection ────────────────────────────────────────────────

  const readCloudRow =
    sql<CloudRow>`SELECT url, account FROM logicpacks_cloud_host WHERE id = 1`.pipe(
      Effect.map((rows) => rows[0] ?? null),
      Effect.orElseSucceed(() => null),
    );
  const cloudCookie = secrets.get(CLOUD_SECRET).pipe(
    Effect.map((value) => (Option.isSome(value) ? new TextDecoder().decode(value.value) : null)),
    Effect.orElseSucceed(() => null),
  );

  const cloud = Effect.fn("LogicPacksSync.cloud")(function* () {
    const row = yield* readCloudRow;
    const cookie = yield* cloudCookie;
    return {
      isCloudHost,
      url: row?.url ?? envCloudUrl,
      connected: row !== null && cookie !== null,
      account: row?.account ?? null,
    } satisfies CloudHostInfo;
  });

  const failed = (message: string) => new LogicPacksSyncError({ reason: "failed", message });
  const messageOf = (payload: Record<string, unknown>, status: number) =>
    typeof payload["message"] === "string" ? payload["message"] : `The cloud host said ${status}.`;
  const sendJson = Effect.fn("LogicPacksSync.sendJson")(function* (
    url: string,
    options: { readonly body?: unknown; readonly cookie?: string },
  ) {
    const features = yield* Effect.serviceOption(FeatureAccess);
    // The laptop's access grant goes along, so its cloud account gets cloud sync too.
    const grant = features._tag === "Some" && !isCloudHost ? features.value.hostGrantToken() : null;
    const base = (
      options.body === undefined ? HttpClientRequest.get(url) : HttpClientRequest.post(url)
    ).pipe(
      grant === null
        ? (request) => request
        : HttpClientRequest.setHeader("x-lp-feature-grant", grant),
    );
    const request = base.pipe(
      options.cookie === undefined
        ? (request: HttpClientRequest.HttpClientRequest) => request
        : HttpClientRequest.setHeader("cookie", options.cookie),
      options.body === undefined
        ? (request: HttpClientRequest.HttpClientRequest) => request
        : HttpClientRequest.bodyJsonUnsafe(options.body),
    );
    const response = yield* httpClient.execute(request).pipe(
      Effect.timeout(Duration.minutes(5)),
      Effect.mapError(() => failed(`Could not reach the cloud host at ${new URL(url).origin}.`)),
    );
    const payload = yield* response.json.pipe(
      Effect.map((value) =>
        value !== null && typeof value === "object" && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : {},
      ),
      Effect.orElseSucceed((): Record<string, unknown> => ({})),
    );
    return { response, payload };
  });

  const cloudFetch = Effect.fn("LogicPacksSync.cloudFetch")(function* (
    route: string,
    body?: unknown,
  ) {
    const info = yield* cloud();
    const cookie = yield* cloudCookie;
    if (!info.connected || cookie === null) {
      return yield* fail("connect_cloud", "Connect a cloud host first.");
    }
    const { response, payload } = yield* sendJson(`${info.url}${route}`, { body, cookie });
    if (response.status === 401) {
      return yield* fail("connect_cloud", "The cloud host signed you out. Connect it again.");
    }
    if (response.status < 200 || response.status >= 300) {
      return yield* fail("cloud_rejected", messageOf(payload, response.status));
    }
    return payload;
  });

  const connectCloud = Effect.fn("LogicPacksSync.connectCloud")(function* (input: {
    readonly url: string;
    readonly mode: "signup" | "login";
    readonly email: string;
    readonly password: string;
    readonly displayName?: string | undefined;
  }) {
    const url = normalizeCloudUrl(input.url);
    if (url === null) {
      return yield* fail(
        "failed",
        "Enter the cloud host's address, like https://app.logicpacks.io.",
      );
    }
    const { response, payload } = yield* sendJson(`${url}/api/lp/auth/password`, {
      body: {
        mode: input.mode,
        email: input.email,
        password: input.password,
        ...(input.displayName ? { displayName: input.displayName } : {}),
      },
    });
    if (response.status < 200 || response.status >= 300) {
      return yield* fail("cloud_rejected", messageOf(payload, response.status));
    }
    const session = Object.values(response.cookies.cookies)[0];
    if (session === undefined)
      return yield* fail("failed", "The cloud host did not start a session.");
    const cookie = `${session.name}=${session.valueEncoded}`;
    yield* secrets
      .set(CLOUD_SECRET, new TextEncoder().encode(cookie))
      .pipe(Effect.mapError(() => failed("Could not save the cloud login.")));
    const at = yield* now;
    const user = payload["user"] as { readonly email?: unknown } | undefined;
    const account = typeof user?.email === "string" ? user.email : input.email;
    yield* sql`
      INSERT INTO logicpacks_cloud_host (id, url, account, connected_at)
      VALUES (1, ${url}, ${account}, ${at})
      ON CONFLICT (id) DO UPDATE SET url = excluded.url, account = excluded.account,
        connected_at = excluded.connected_at
    `.pipe(Effect.orDie);
    return yield* cloud();
  });

  const disconnectCloud = Effect.fn("LogicPacksSync.disconnectCloud")(function* () {
    yield* secrets.remove(CLOUD_SECRET).pipe(Effect.ignore);
    yield* sql`DELETE FROM logicpacks_cloud_host WHERE id = 1`.pipe(Effect.ignore);
    return yield* cloud();
  });

  let cachedLogin: string | null | undefined;
  const githubLogin = Effect.fn("LogicPacksSync.githubLogin")(function* () {
    if (cachedLogin !== undefined) return cachedLogin;
    const result = yield* runGh(["api", "user", "--jq", ".login"]);
    cachedLogin = result.code === 0 ? result.stdout.trim() || null : null;
    return cachedLogin;
  });

  // ── The Sync flow ────────────────────────────────────────────────────────

  /** A new private repository for a project with no remote: on GitHub, or a bare repo in tests. */
  const createRemote = Effect.fn("LogicPacksSync.createRemote")(function* (
    git: GitRunner,
    root: string,
    title: string,
    memberToken: string | null,
  ) {
    const name = repositoryNameFor(title);
    if (remoteRoot.length > 0) {
      const bare = path.join(remoteRoot, "lp", `${name}.git`);
      const target = (yield* fileSystem.exists(bare).pipe(Effect.orElseSucceed(() => false)))
        ? path.join(
            remoteRoot,
            "lp",
            `${name}-${(yield* Clock.currentTimeMillis).toString(36)}.git`,
          )
        : bare;
      yield* fileSystem.makeDirectory(target, { recursive: true }).pipe(Effect.orDie);
      const init = yield* runnerFor(target)(["init", "--bare", "--quiet", "-b", "main"]);
      if (init.code !== 0) return yield* fail("failed", init.stderr.trim() || "git init failed.");
      yield* git(["remote", "add", SYNC_REMOTE, target]);
      return target;
    }
    if (memberToken !== null) {
      // Under the member's own GitHub account, with their token: the host's gh is not involved.
      const createAs = (repository: string) =>
        githubCreateRepository(memberToken, repository).pipe(
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.mapError(
            (error) =>
              new LogicPacksSyncError({
                reason: "failed",
                message: `Could not create the GitHub repository: ${error.message}`,
              }),
          ),
        );
      let created = yield* createAs(name);
      if (created.kind === "exists") {
        created = yield* createAs(
          `${name}-${(yield* Clock.currentTimeMillis).toString(36).slice(-4)}`,
        );
      }
      if (created.kind === "exists") {
        return yield* fail("failed", "A repository with that name already exists on GitHub.");
      }
      yield* git(["remote", "add", SYNC_REMOTE, created.cloneUrl]);
      return created.cloneUrl;
    }
    // Push the way this machine's gh pushes: an SSH remote fails where only HTTPS is set up.
    const configured = yield* runGh(["config", "get", "git_protocol"]);
    const protocol = configured.stdout.trim() === "ssh" ? "ssh" : "https";
    const publish = (repository: string) =>
      repositories.publishRepository({
        cwd: root,
        provider: SourceControlProviderKind.make("github"),
        repository,
        visibility: "private",
        remoteName: SYNC_REMOTE,
        protocol,
      });
    const failed = (message: string) =>
      new LogicPacksSyncError({
        reason: "failed",
        message: `Could not create the GitHub repository: ${message}. Is gh signed in (gh auth login)?`,
      });
    const suffix = (yield* Clock.currentTimeMillis).toString(36).slice(-4);
    return yield* publish(name).pipe(
      Effect.map((published) => published.remoteUrl),
      Effect.catch((error) =>
        Effect.gen(function* () {
          // Created, but the push failed: keep that repository; the Sync push reports why.
          const created = yield* readRemoteUrl(git);
          if (created !== null) return created;
          if (!/already exists|name already/i.test(error.message)) {
            return yield* failed(error.message);
          }
          return yield* publish(`${name}-${suffix}`).pipe(
            Effect.map((published) => published.remoteUrl),
            Effect.mapError((retry) => failed(retry.message)),
          );
        }),
      ),
    );
  });

  /** The owner's repo must let the cloud host's GitHub account clone and push it. */
  const inviteHostAccount = Effect.fn("LogicPacksSync.inviteHostAccount")(function* (
    remote: string,
  ) {
    const repository = githubRepository(remote);
    if (repository === null) return;
    const host = yield* cloudFetch("/api/lp/sync/host").pipe(
      Effect.orElseSucceed((): Record<string, unknown> => ({})),
    );
    const login = typeof host["githubLogin"] === "string" ? host["githubLogin"] : null;
    if (login === null || login === (yield* githubLogin())) return;
    const result = yield* runGh([
      "api",
      "-X",
      "PUT",
      `repos/${repository}/collaborators/${login}`,
      "-f",
      "permission=push",
    ]);
    if (result.code !== 0) {
      yield* Effect.logWarning("Could not add the cloud host to the repository", {
        repository,
        login,
        stderr: result.stderr,
      });
    }
  });

  const saveLink = Effect.fn("LogicPacksSync.saveLink")(function* (
    projectId: string,
    cloudUrl: string | null,
    cloudProjectId: string | null,
  ) {
    const at = yield* now;
    yield* sql`
      INSERT INTO logicpacks_sync_links (project_id, cloud_url, cloud_project_id, linked_at)
      VALUES (${projectId}, ${cloudUrl}, ${cloudProjectId}, ${at})
      ON CONFLICT (project_id) DO UPDATE SET cloud_url = excluded.cloud_url,
        cloud_project_id = excluded.cloud_project_id, linked_at = excluded.linked_at
    `.pipe(Effect.orDie);
    links.set(projectId, { cloudUrl, cloudProjectId });
  });

  const markSynced = (projectId: string, remote: string) =>
    access.markSynced(projectId, remote).pipe(
      Effect.tap(() => Effect.sync(() => remotes.set(projectId, remote))),
      Effect.mapError(
        () => new LogicPacksSyncError({ reason: "failed", message: "Could not record the sync." }),
      ),
    );

  const syncFile = (remote: string, branch: string, cloudUrl: string | null) =>
    `${JSON.stringify(
      {
        version: 1,
        remote,
        branch,
        cloudHost: cloudUrl,
        agents:
          "This project is synced by LogicPacks. Where LogicPacks runs the checkout (its desktop app or the cloud host) it already fetches, rebases and pushes it, so do not start your own sync loop there. In your own clone or worktree outside LogicPacks, keep one background monitor for your session that fetches origin every few minutes, rebases your branch onto it (merge if already pushed), pushes when your tree is clean, and tells the user about any conflict it cannot settle.",
      },
      null,
      2,
    )}\n`;

  const runFlow = Effect.fn("LogicPacksSync.runFlow")(function* (
    projectId: string,
    actorUserId: string | null,
  ) {
    const { root, title } = yield* projectRoot(projectId);
    // A member with GitHub connected syncs as themselves, now and on every later pass.
    const memberToken = yield* memberGithubToken(actorUserId);
    if (memberToken !== null && actorUserId !== null) {
      yield* access
        .setSyncPusher(projectId, actorUserId)
        .pipe(Effect.mapError(() => failed("Could not record who syncs this project.")));
    }
    const git = runnerFor(root, memberToken === null ? undefined : githubTokenGitEnv(memberToken));
    const step = (message: string) =>
      Effect.sync(() => setLive(projectId, { state: "syncing", message }));

    yield* step("Preparing the repository");
    if (!(yield* isRepository(git))) {
      const init = yield* git(["init", "--quiet", "-b", "main"]);
      if (init.code !== 0) return yield* fail("failed", init.stderr.trim() || "git init failed.");
    }
    if (!(yield* hasCommits(git))) {
      yield* commitAll(git, `Start ${title}`);
      if (!(yield* hasCommits(git))) {
        // An empty folder still needs a first commit to push.
        const identity = yield* identityArgs(git);
        yield* git([
          ...identity,
          "commit",
          "--allow-empty",
          "--no-verify",
          "-q",
          "-m",
          `Start ${title}`,
        ]);
      }
    } else {
      yield* commitAll(git, `Save work before syncing ${title}`);
    }
    const branch = (yield* currentBranch(git)) ?? "main";

    let remote = yield* readRemoteUrl(git);
    if (remote === null) {
      yield* step(
        remoteRoot.length > 0 ? "Creating the repository" : "Creating a private GitHub repository",
      );
      remote = yield* createRemote(git, root, title, memberToken);
    }

    const info = yield* cloud();
    const cloudUrl = isCloudHost ? null : info.url;
    const syncPath = path.join(root, ".logicpacks", "sync.json");
    const wanted = syncFile(remote, branch, cloudUrl);
    const existing = yield* fileSystem
      .readFileString(syncPath)
      .pipe(Effect.orElseSucceed(() => ""));
    if (existing !== wanted) {
      yield* fileSystem
        .makeDirectory(path.dirname(syncPath), { recursive: true })
        .pipe(Effect.orDie);
      yield* fileSystem.writeFileString(syncPath, wanted).pipe(Effect.orDie);
      const identity = yield* identityArgs(git);
      yield* git(["add", "--", ".logicpacks/sync.json"]);
      yield* git([
        ...identity,
        "commit",
        "--no-verify",
        "-q",
        "-m",
        "Sync this project with LogicPacks",
        "--",
        ".logicpacks/sync.json",
      ]);
    }

    yield* step("Pushing to the repository");
    const push = yield* git(["push", "--quiet", "-u", SYNC_REMOTE, `HEAD:refs/heads/${branch}`]);
    if (push.code !== 0) {
      // Someone pushed first (the repo already existed): one sync pass rebases and pushes.
      const tick = yield* syncTick(git, {
        busy: false,
        autoCommit,
        commitMessage: `LogicPacks: save work on ${hostLabel}`,
      });
      if (tick.state !== "synced") {
        return yield* fail("failed", tick.message ?? push.stderr.trim() ?? "Push failed.");
      }
    }
    yield* markSynced(projectId, remote);
    yield* recordUsage(actorUserId, "project.synced", projectId, projectId);

    if (isCloudHost) {
      yield* saveLink(projectId, null, projectId);
    } else {
      if (!info.connected) {
        return yield* fail(
          "connect_cloud",
          "Pushed. Connect a cloud host to share it and keep it running.",
        );
      }
      yield* step("Adding it to the cloud host");
      yield* inviteHostAccount(remote);
      const registered = yield* cloudFetch("/api/lp/sync/import", { remoteUrl: remote, title });
      const cloudProjectId = typeof registered.projectId === "string" ? registered.projectId : null;
      yield* saveLink(projectId, info.url, cloudProjectId);
    }
    setLive(projectId, {
      state: "synced",
      branch,
      ahead: 0,
      behind: 0,
      conflictFiles: [],
      message: null,
      lastSyncedAt: yield* now,
    });
  });

  // Flows outlive the request that started them, but not the server.
  const flowScope = yield* Scope.make("parallel");
  yield* Effect.addFinalizer(() => Scope.close(flowScope, Exit.void));
  const running = new Set<string>();

  const start = Effect.fn("LogicPacksSync.start")(function* (input: {
    readonly projectId: string;
    readonly actorUserId: string | null;
  }) {
    yield* projectRoot(input.projectId);
    if (!isCloudHost && !(yield* cloud()).connected && !access.isSynced(input.projectId)) {
      // A chat request has no dialog to open; the banner says what is missing.
      setLive(input.projectId, {
        message: "Connect a cloud host to sync. Press Sync to set it up.",
      });
      return yield* fail("connect_cloud", "Connect a cloud host first.");
    }
    if (running.has(input.projectId)) return statusOf(input.projectId);
    running.add(input.projectId);
    setLive(input.projectId, { state: "syncing", message: "Starting", conflictFiles: [] });
    yield* lockFor(input.projectId)
      .withPermits(1)(runFlow(input.projectId, input.actorUserId))
      .pipe(
        Effect.catch((error) =>
          Effect.sync(() =>
            setLive(input.projectId, {
              state:
                error.reason === "connect_cloud" && access.isSynced(input.projectId)
                  ? "synced"
                  : "error",
              message: error.message,
            }),
          ),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("Sync failed", { cause }).pipe(
            Effect.andThen(
              Effect.sync(() =>
                setLive(input.projectId, { state: "error", message: "Sync failed." }),
              ),
            ),
          ),
        ),
        Effect.ensuring(Effect.sync(() => running.delete(input.projectId))),
        Effect.forkIn(flowScope),
      );
    return statusOf(input.projectId);
  });

  const applyTick = (projectId: string, tick: TickResult, at: string) => {
    if (tick.state === "busy") {
      setLive(projectId, {
        branch: tick.branch,
        behind: tick.behind,
        ahead: tick.ahead,
        message: "An agent is working here. Syncing after its turn.",
      });
      return;
    }
    setLive(projectId, {
      state: tick.state === "synced" ? "synced" : tick.state,
      branch: tick.branch,
      ahead: tick.ahead,
      behind: tick.behind,
      conflictFiles: tick.conflictFiles,
      theirsAuthor: tick.theirsAuthor,
      message: tick.message,
      ...(tick.state === "synced" ? { lastSyncedAt: at } : {}),
    });
  };

  const tickProject = Effect.fn("LogicPacksSync.tickProject")(function* (projectId: string) {
    if (running.has(projectId)) return;
    const { root } = yield* projectRoot(projectId);
    const git = yield* projectGit(projectId, root);
    const tick = yield* lockFor(projectId).withPermits(1)(
      syncTick(git, {
        busy: projectBusy(projectId),
        autoCommit,
        commitMessage: `LogicPacks: save work on ${hostLabel}`,
      }),
    );
    applyTick(projectId, tick, yield* now);
    if (tick.pulled > 0 || tick.pushed > 0 || tick.state === "conflict") {
      yield* Effect.logInfo("LogicPacks sync pass", {
        projectId,
        state: tick.state,
        pulled: tick.pulled,
        pushed: tick.pushed,
        conflictFiles: tick.conflictFiles,
      });
    }
  });

  const syncNow = Effect.fn("LogicPacksSync.syncNow")(function* (projectId: string) {
    if (!access.isSynced(projectId)) return yield* fail("not_synced", "Sync this project first.");
    yield* tickProject(projectId);
    return statusOf(projectId);
  });

  const resolve = Effect.fn("LogicPacksSync.resolve")(function* (input: {
    readonly projectId: string;
    readonly strategy: ConflictStrategy;
    readonly actorUserId?: string | null | undefined;
  }) {
    if (!access.isSynced(input.projectId))
      return yield* fail("not_synced", "Sync this project first.");
    if (statusOf(input.projectId).state !== "conflict") {
      return yield* fail("no_conflict", "There is no conflict to resolve.");
    }
    if (yield* projectBusy(input.projectId)) {
      return yield* fail("busy", "An agent is working in this project. Try again after its turn.");
    }
    const { root } = yield* projectRoot(input.projectId);
    const git = yield* projectGit(input.projectId, root);
    const result = yield* lockFor(input.projectId).withPermits(1)(
      resolveConflict(
        git,
        input.strategy,
        input.strategy === "mine"
          ? "Merge teammates' changes, keeping this checkout's version of conflicts"
          : "Merge teammates' changes, keeping their version of conflicts",
      ),
    );
    if (!result.ok)
      return yield* fail("failed", result.message ?? "Could not resolve the conflict.");
    const resolvedAt = yield* now;
    setLive(input.projectId, {
      state: "synced",
      conflictFiles: [],
      theirsAuthor: null,
      message: null,
      ahead: 0,
      behind: 0,
      lastSyncedAt: resolvedAt,
    });
    // One activity per settled conflict, so each one counts toward the peacemaker badges.
    yield* recordUsage(
      input.actorUserId,
      "conflict.resolved",
      `${input.projectId}@${resolvedAt}`,
      input.projectId,
    );
    return statusOf(input.projectId);
  });

  // ── The engine ───────────────────────────────────────────────────────────

  const seconds = yield* Config.Int("LOGICPACKS_SYNC_SECONDS").pipe(
    Config.withDefault(20),
    Effect.orElseSucceed(() => 20),
  );
  if (seconds > 0) {
    const pass = Effect.gen(function* () {
      const ids = Array.from(access.syncedProjectIds());
      yield* Effect.forEach(
        ids,
        (projectId) =>
          tickProject(projectId).pipe(
            Effect.catchCause((cause) =>
              Effect.logDebug("Sync pass skipped", { projectId, cause }),
            ),
          ),
        { concurrency: 2, discard: true },
      );
    });
    yield* pass.pipe(
      Effect.andThen(Effect.sleep(Duration.seconds(seconds))),
      Effect.forever,
      Effect.forkIn(flowScope),
    );
  }

  return LogicPacksSync.of({
    isCloudHost,
    syncSeconds: seconds,
    status: (projectIds) => projectIds.map(statusOf),
    start,
    syncNow,
    resolve,
    cloud,
    connectCloud,
    disconnectCloud,
    githubLogin,
  });
});

/** On a cloud host: accept the owner's invitation to their private repository before cloning it. */
export const acceptRepositoryInvitation = Effect.fn("logicpacks.acceptRepositoryInvitation")(
  function* (remote: string) {
    const repository = githubRepository(remote);
    if (repository === null) return;
    const listed = yield* runGh([
      "api",
      "user/repository_invitations",
      "--jq",
      `.[] | select(.repository.full_name == "${repository}") | .id`,
    ]);
    for (const id of listed.stdout.split("\n").map((line) => line.trim())) {
      if (!/^\d+$/.test(id)) continue;
      yield* runGh(["api", "-X", "PATCH", `user/repository_invitations/${id}`]);
    }
  },
);

export const layer = Layer.effect(LogicPacksSync, make).pipe(
  Layer.provide(ServerSecretStore.layer),
);
