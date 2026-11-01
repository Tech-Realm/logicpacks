import {
  EnvironmentAuthorizationError,
  type OrchestrationV2ShellStreamItem,
  type ProjectId,
  type ThreadId,
} from "@logicpacks/contracts";
import { FeatureAccess } from "./FeatureAccess.ts";
import { lockedMessage, memberHasCloud } from "./featureHttp.ts";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

import * as ServerConfig from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { requiredScopeForRpcMethod } from "../auth/RpcAuthorization.ts";
import { ExpertsService } from "./ExpertsService.ts";
import {
  externalInstanceAllowed,
  filterSecretEntries,
  guardedFilePath,
  isSecretPath,
  redactDeep,
  relativeToRoot,
  SECRET_FILTERED_METHODS,
  SECRET_GUARDED_METHODS,
  secretPatterns,
  THREAD_CONTENT_METHODS,
} from "./externalTeam.ts";
import { ExternalTeamService } from "./ExternalTeamService.ts";
import { LogicPacksAccess } from "./LogicPacksAccess.ts";
import { LogicPacksSync } from "./LogicPacksSync.ts";
import {
  ensureMemberRoot,
  firstJailViolation,
  makeMemberJail,
  MEMBER_DENIED_METHODS,
  MEMBER_TERMINAL_METHODS,
  usesTildeOutsideHomeMethods,
  worktreeProjectRoot,
} from "./memberJail.ts";
import { syncMemberSandbox } from "./memberSandbox.ts";
import { isSyncIntent } from "./syncGit.ts";
import { revealClaimedProject } from "./reveal.ts";
import {
  decideInstanceUse,
  isOwnMemberInstance,
  providersForMember,
  selectedInstanceId,
  threadRunWithoutSelection,
} from "./memberProviders.ts";
import {
  createdProjectId,
  filterListResultForMember,
  filterShellItemForMember,
  MEMBER_FILTERED_LIST_METHODS,
  memberUserIdFromSubject,
  pathIsWithin,
  requiresOwner,
  rpcTargets,
} from "./projectAccess.ts";

/**
 * Keeps a member's RPCs inside the projects shared with them. The operator's
 * sessions get no fence and behave exactly as upstream.
 */
export interface MemberFence {
  /** Null for the host operator, whose fence only follows their current workspace. */
  readonly userId: string | null;
  /** The member's `~` (their member root); null for the operator, who keeps the host's. */
  readonly homeDirectory: string | null;
  /** Access, not the current workspace view: the operator sees every project. */
  readonly canSeeProject: (projectId: string) => boolean;
  readonly check: (
    method: string,
    payload: unknown,
  ) => Effect.Effect<void, EnvironmentAuthorizationError>;
  readonly afterSuccess: (method: string, payload: unknown, result: unknown) => Effect.Effect<void>;
  readonly mapResult: (method: string, result: unknown, payload?: unknown) => unknown;
  /**
   * For a vetted freelancer in the thread's project: a function that redacts pasted secrets
   * from the thread's stream items. Null for everyone else.
   */
  readonly threadRedactor: (threadId: string) => Effect.Effect<(<A>(item: A) => A) | null>;
  readonly filterShellItem: (
    item: OrchestrationV2ShellStreamItem,
  ) => OrchestrationV2ShellStreamItem | null;
  /** The provider logins this session may run turns on. */
  readonly filterProviders: <P extends { readonly instanceId: string }>(
    providers: ReadonlyArray<P>,
  ) => ReadonlyArray<P>;
}

const denied = (method: string, message: string) => {
  let requiredScope;
  try {
    requiredScope = requiredScopeForRpcMethod(method);
  } catch {
    requiredScope = "orchestration:read" as const;
  }
  return Effect.fail(new EnvironmentAuthorizationError({ message, requiredScope }));
};

/** A project someone creates lands in the workspace they are looking at. */
const attachToCurrentWorkspace = (
  access: LogicPacksAccess["Service"],
  actorUserId: string | null,
  projectId: string,
) => {
  const workspaceId = access.currentWorkspaceId(actorUserId);
  const attach =
    workspaceId === null
      ? Effect.void
      : access
          .attachProject(projectId, workspaceId)
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning("Could not add project to workspace", { error }),
            ),
          );
  return attach.pipe(Effect.andThen(revealClaimedProject(projectId)));
};

/** "Sync this to the cloud" said in a project's chat runs the same flow as the Sync button. */
const startSyncOnIntent =
  (
    sync: LogicPacksSync["Service"] | null,
    threads: ThreadManagementService.ThreadManagementService["Service"],
    actorUserId: string | null,
  ) =>
  (method: string, payload: unknown): Effect.Effect<void> => {
    if (sync === null) return Effect.void;
    const said = syncIntentTarget(method, payload);
    if (said === null) return Effect.void;
    const projectId: Effect.Effect<string | null> =
      said.projectId !== null
        ? Effect.succeed(said.projectId)
        : threads.getThreadShell(said.threadId as ThreadId).pipe(
            Effect.map((shell): string | null => shell?.projectId ?? null),
            Effect.orElseSucceed(() => null),
          );
    return projectId.pipe(
      Effect.flatMap((id) =>
        id === null ? Effect.void : sync.start({ projectId: id, actorUserId }),
      ),
      Effect.catchCause((cause) => Effect.logInfo("Chat sync request not started", { cause })),
      Effect.asVoid,
    );
  };

/** A message asking to sync: a new thread's first message, or one sent to an existing thread. */
export const syncIntentTarget = (
  method: string,
  payload: unknown,
): { readonly projectId: string | null; readonly threadId: string } | null => {
  if (payload === null || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  if (method === "orchestration.launchThread") {
    const initial = record["initialMessage"] as { readonly text?: unknown } | undefined;
    const projectId = record["projectId"];
    return typeof initial?.text === "string" &&
      typeof projectId === "string" &&
      isSyncIntent(initial.text)
      ? { projectId, threadId: "" }
      : null;
  }
  if (method !== "orchestration.dispatchCommand" || record["type"] !== "message.dispatch") {
    return null;
  }
  const text = record["text"];
  const threadId = record["threadId"];
  return typeof text === "string" && typeof threadId === "string" && isSyncIntent(text)
    ? { projectId: null, threadId }
    : null;
};

/**
 * The operator is never fenced in, but still works in a current workspace:
 * what they create joins it, and their lists follow it once they pick one.
 */
const makeOperatorFence = (
  access: LogicPacksAccess["Service"],
  onIntent: (method: string, payload: unknown) => Effect.Effect<void>,
): MemberFence => {
  const inView = (projectId: string) => access.inView(null, projectId);
  return {
    userId: null,
    homeDirectory: null,
    canSeeProject: () => true,
    check: () => Effect.void,
    afterSuccess: (method, payload, result) => {
      const projectId = createdProjectId(method, payload, result);
      return (
        projectId === null ? Effect.void : attachToCurrentWorkspace(access, null, projectId)
      ).pipe(Effect.andThen(onIntent(method, payload)));
    },
    mapResult: (method, result) =>
      MEMBER_FILTERED_LIST_METHODS.has(method) && access.currentWorkspaceId(null) !== null
        ? filterListResultForMember(result, inView)
        : result,
    threadRedactor: () => Effect.succeed(null),
    filterShellItem: (item) =>
      access.currentWorkspaceId(null) === null ? item : filterShellItemForMember(item, inView),
    filterProviders: (providers) => providers,
  };
};

export const makeMemberFence = Effect.fn("logicpacks.makeMemberFence")(function* (subject: string) {
  const userId = memberUserIdFromSubject(subject);
  const accessOption = yield* Effect.serviceOption(LogicPacksAccess);
  if (accessOption._tag === "None") return null;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const syncOption = yield* Effect.serviceOption(LogicPacksSync);
  const onIntent = startSyncOnIntent(
    syncOption._tag === "Some" ? syncOption.value : null,
    threads,
    userId,
  );
  if (userId === null) return makeOperatorFence(accessOption.value, onIntent);
  const access = accessOption.value;
  const expertsOption = yield* Effect.serviceOption(ExpertsService);
  const grants = expertsOption._tag === "Some" ? expertsOption.value : null;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const config = yield* ServerConfig.ServerConfig;
  // Off only when the operator chooses to lend their own provider logins to every member.
  const membersMustUseOwn = yield* Config.Boolean("LOGICPACKS_MEMBERS_OWN_PROVIDERS").pipe(
    Config.withDefault(true),
    Effect.orElseSucceed(() => true),
  );

  const memberRoot = ensureMemberRoot(config.baseDir, userId);

  // External team: a vetted freelancer sees no secret files in the projects they were
  // assigned to, gets pasted secrets redacted, and runs on their own AI login there.
  const teamOption = yield* Effect.serviceOption(ExternalTeamService);
  const team = teamOption._tag === "Some" ? teamOption.value : null;
  const me = yield* access.getUser(userId).pipe(Effect.orElseSucceed(() => null));
  const externalUser = { userId, email: me?.email ?? null };
  const patterns = secretPatterns(process.env.LOGICPACKS_EXTERNAL_SECRET_PATTERNS);
  const externalOffer = (projectId: string | null) =>
    team === null || projectId === null ? undefined : team.externalAccess(externalUser, projectId);
  /** The project a working directory belongs to, from the last visible list the check read. */
  let lastVisible: ReadonlyArray<{ readonly id: string; readonly root: string }> = [];
  const projectForCwd = (cwd: string) => {
    const direct = lastVisible.find((project) => pathIsWithin(project.root, cwd));
    if (direct !== undefined) return direct;
    const root = worktreeProjectRoot(cwd, config.worktreesDir);
    return root === null ? undefined : lastVisible.find((project) => project.root === root);
  };
  // A thread's terminal is shared by everyone in the thread and runs as the host, so members
  // get none until terminals are owned per member.
  const terminalsAllowed = false;

  const canSee = (projectId: string) => access.roleOf(userId, projectId) !== null;
  // Lists and the live sidebar follow the current workspace; commands only need access.
  const inView = (projectId: string) => access.inView(userId, projectId);

  const threadProject = (threadId: string) =>
    threads.getThreadShell(threadId as ThreadId).pipe(
      Effect.map((shell) => shell?.projectId ?? null),
      Effect.orElseSucceed(() => null),
    );

  const visibleProjects = Effect.gen(function* () {
    const ids = Array.from(access.visibleProjectIds(userId)) as Array<ProjectId>;
    if (ids.length === 0) return [];
    const shells = yield* projects
      .listShells({ projectIds: ids })
      .pipe(Effect.orElseSucceed(() => []));
    return shells.map((shell) => ({ id: String(shell.id), root: shell.workspaceRoot }));
  });

  // A new thread with no model named runs on the host default, which is the operator's.
  const effectiveInstanceId = Effect.fn("logicpacks.memberFence.effectiveInstanceId")(function* (
    payload: unknown,
  ) {
    const selected = selectedInstanceId(payload);
    if (selected !== null) return selected;
    const threadId = threadRunWithoutSelection(payload);
    if (threadId === null) return null;
    const shell = yield* threads
      .getThreadShell(threadId as ThreadId)
      .pipe(Effect.orElseSucceed(() => null));
    return shell?.modelSelection.instanceId ?? "host-default";
  });

  /** The project a command runs in: named directly, or through its thread. */
  const commandProject = Effect.fn("logicpacks.memberFence.commandProject")(function* (
    payload: unknown,
  ) {
    const targets = rpcTargets(payload);
    const direct = targets.projectIds[0];
    if (direct !== undefined) return direct;
    for (const threadId of targets.threadIds) {
      const projectId = yield* threadProject(threadId);
      if (projectId !== null) return projectId;
    }
    return null;
  });

  const check = Effect.fn("logicpacks.memberFence.check")(function* (
    method: string,
    payload: unknown,
  ) {
    if (MEMBER_DENIED_METHODS.has(method)) {
      return yield* denied(method, "This is not available to members of a shared host.");
    }
    if (MEMBER_TERMINAL_METHODS.has(method) && !terminalsAllowed) {
      return yield* denied(method, "Terminals are not available to members on this host yet.");
    }
    if (usesTildeOutsideHomeMethods(method, payload)) {
      return yield* denied(method, "Use the full folder path here.");
    }
    // Every path a member names must sit in their own space or a project shared with them.
    const visible = yield* visibleProjects;
    lastVisible = visible;
    if (team !== null && SECRET_GUARDED_METHODS.has(method)) {
      const target = guardedFilePath(payload);
      const project = target === null ? undefined : projectForCwd(target.cwd);
      if (target !== null && project !== undefined && externalOffer(project.id) !== undefined) {
        const relative = relativeToRoot(target.cwd, target.path) ?? target.path;
        if (isSecretPath(relative, patterns)) {
          return yield* denied(
            method,
            "This file is hidden from vetted freelancers in this project.",
          );
        }
      }
    }
    // Under the sandbox their Unix user follows the same access (project groups).
    syncMemberSandbox(userId, visible, config.worktreesDir);
    const jail = makeMemberJail({
      memberRoot,
      projectRoots: visible.map((project) => project.root),
      worktreesDir: config.worktreesDir,
    });
    if (firstJailViolation(jail, payload) !== null) {
      return yield* denied(
        method,
        "That folder is outside your space and the projects shared with you.",
      );
    }
    // A new project has no access row yet; it becomes the member's in afterSuccess. Its root
    // must not reach into a project somebody else has not shared.
    if (createdProjectId(method, payload, { id: "pending" }) !== null) {
      // On the LogicPacks cloud, new projects are part of cloud sync (coming soon without it).
      const features = yield* Effect.serviceOption(FeatureAccess);
      if (
        features._tag === "Some" &&
        features.value.isCloudHost &&
        !(yield* memberHasCloud({ userId, email: me?.email ?? null }))
      ) {
        return yield* denied(method, lockedMessage("cloud"));
      }
      const root = (payload as { readonly workspaceRoot?: unknown }).workspaceRoot;
      if (typeof root !== "string") return;
      const others = yield* projects.listShells().pipe(Effect.orElseSucceed(() => []));
      const overlaps = others.some(
        (project) =>
          !canSee(project.id) &&
          (pathIsWithin(project.workspaceRoot, root) || pathIsWithin(root, project.workspaceRoot)),
      );
      return overlaps
        ? yield* denied(method, "That folder belongs to a project that is not shared with you.")
        : undefined;
    }
    const instanceId = yield* effectiveInstanceId(payload);
    if (instanceId !== null && team !== null) {
      // A freelancer brings their own AI: the customer's (or host's) login only with the
      // customer's explicit OK on the offer.
      const offer = externalOffer(yield* commandProject(payload));
      if (
        offer !== undefined &&
        !externalInstanceAllowed({
          ownInstance: isOwnMemberInstance(instanceId, userId),
          allowSharedLogin: offer.allowSharedLogin,
        })
      ) {
        return yield* denied(
          method,
          "Vetted freelancers run on their own AI login here. Connect yours from your avatar menu.",
        );
      }
    }
    if (instanceId !== null) {
      // A grant is for one project: the one this command's thread or project is in.
      const granted =
        grants === null || !grants.grantedInstanceIds(userId).has(instanceId)
          ? false
          : grants.allows(userId, instanceId, yield* commandProject(payload));
      const decision = decideInstanceUse({ instanceId, userId, membersMustUseOwn, granted });
      if (decision === "someone_elses") {
        return yield* denied(method, "That provider login belongs to another member.");
      }
      if (decision === "needs_own_login") {
        return yield* denied(
          method,
          "This host runs agents on your own Claude account. Connect Claude from your avatar menu first.",
        );
      }
    }
    const targets = rpcTargets(payload);
    for (const projectId of targets.projectIds) {
      if (!canSee(projectId)) {
        return yield* denied(method, "This project is not shared with you.");
      }
      if (requiresOwner(method, payload) && access.roleOf(userId, projectId) !== "owner") {
        return yield* denied(method, "Only the project owner can delete it.");
      }
    }
    for (const threadId of targets.threadIds) {
      const projectId = yield* threadProject(threadId);
      // A thread id that does not exist yet (thread.create) is checked through its projectId.
      if (projectId !== null && !canSee(projectId)) {
        return yield* denied(
          method,
          "This thread belongs to a project that is not shared with you.",
        );
      }
    }
  });

  const afterSuccess = (method: string, payload: unknown, result: unknown) => {
    const projectId = createdProjectId(method, payload, result);
    return (
      projectId === null
        ? Effect.void
        : access.recordOwner(projectId, userId).pipe(
            Effect.catch((error) => Effect.logWarning("Could not record project owner", { error })),
            Effect.andThen(attachToCurrentWorkspace(access, userId, projectId)),
          )
    ).pipe(Effect.andThen(onIntent(method, payload)));
  };

  return {
    userId,
    homeDirectory: memberRoot,
    canSeeProject: canSee,
    check,
    afterSuccess,
    mapResult: (method, result, payload) => {
      const listed = MEMBER_FILTERED_LIST_METHODS.has(method)
        ? filterListResultForMember(result, inView)
        : result;
      if (team === null) return listed;
      // Thread content anywhere for someone working as a vetted freelancer: pasted secrets redacted.
      if (THREAD_CONTENT_METHODS.has(method))
        return team.isExternalAnywhere(externalUser) ? redactDeep(listed) : listed;
      if (!SECRET_FILTERED_METHODS.has(method)) return listed;
      const cwd = (payload as { readonly cwd?: unknown } | undefined)?.cwd;
      const project = typeof cwd === "string" ? projectForCwd(cwd) : undefined;
      return project !== undefined && externalOffer(project.id) !== undefined
        ? filterSecretEntries(method, listed, patterns)
        : listed;
    },
    threadRedactor: (threadId) =>
      threadProject(threadId).pipe(
        Effect.map((projectId) =>
          externalOffer(projectId) === undefined ? null : <A>(item: A): A => redactDeep(item),
        ),
      ),
    filterShellItem: (item) => {
      const visible = filterShellItemForMember(item, inView);
      // Thread titles and previews in the sidebar: pasted secrets redacted for vetted freelancers.
      return visible !== null && team !== null && team.isExternalAnywhere(externalUser)
        ? redactDeep(visible)
        : visible;
    },
    filterProviders: (providers) =>
      providersForMember(providers, {
        userId,
        membersMustUseOwn,
        grantedInstanceIds: grants?.grantedInstanceIds(userId),
      }),
  } satisfies MemberFence;
});
