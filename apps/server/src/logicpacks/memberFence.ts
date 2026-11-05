// @effect-diagnostics nodeBuiltinImport:off -- builds the sandbox profile folder path.
import * as NodePath from "node:path";
import {
  ACCESS_AGENTS,
  AGENT_LABELS,
  DEFAULT_MODEL_BY_PROVIDER,
  agentForDriver,
  canCompute,
  canManageProjects,
  isUnrestricted,
  sharedFolders,
  canReadSecrets,
  canUseAgent,
  EnvironmentAuthorizationError,
  type OrchestrationV2ShellStreamItem,
  type ProjectId,
  PROJECTS_OFF_MESSAGE,
  SECRET_FILE_MESSAGE,
  type TerminalMetadataStreamEvent,
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
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import { READ_ONLY_MESSAGE, viewerMayCall } from "./readOnlyRpc.ts";
import {
  captureFirstCommand,
  forgetTerminal,
  ownerOfTerminal,
  registerTerminal,
  terminalRef,
  terminalsOf,
} from "./memberTerminalRegistry.ts";
import { registerMemberMessage } from "./runLimits.ts";
import { aiOffMessage, refusalFor, rpcNeeds, TERMINAL_METHODS } from "./zoneGate.ts";
import { OUTSIDE_FOLDERS_MESSAGE } from "./zoneHttp.ts";
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
  collectPayloadPaths,
  ensureMemberRoot,
  firstJailViolation,
  folderAllows,
  makeMemberJail,
  resolveMemberPath,
  resolveSharedFolders,
  MEMBER_DENIED_METHODS,
  usesTildeOutsideHomeMethods,
  worktreeProjectRoot,
} from "./memberJail.ts";
import { dispatchedMessage, messageAuthorStore } from "./messageAuthors.ts";
import { syncMemberSandbox } from "./memberSandbox.ts";
import { isSyncIntent } from "./syncGit.ts";
import { revealClaimedProject } from "./reveal.ts";
import {
  decideInstanceUse,
  isMemberInstanceId,
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
  /** Terminal metadata: a member sees only the terminals they opened. Null drops the event. */
  readonly filterTerminalEvent: (
    event: TerminalMetadataStreamEvent,
  ) => TerminalMetadataStreamEvent | null;
  /**
   * The settings a member's client gets: the default model is the host's Claude when their AI
   * zone lends it (their own Claude otherwise), never whatever the host happens to default to.
   */
  readonly withMemberDefaults: <S extends { readonly defaultModelSelection?: unknown }>(
    settings: S,
    providers: ReadonlyArray<{
      readonly instanceId: string;
      readonly driver: string;
      readonly enabled?: boolean;
      readonly installed?: boolean;
      readonly models?: ReadonlyArray<{ readonly slug: string }>;
    }>,
  ) => S;
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
  const workspaceId = access.creationWorkspaceId(actorUserId);
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

/** Remembers who sent a dispatched user message (null = host owner). */
const recordAuthor = (
  stateDir: string | null,
  userId: string | null,
  method: string,
  payload: unknown,
  result: unknown,
): Effect.Effect<void> =>
  Effect.sync(() => {
    if (stateDir === null) return;
    const sent = dispatchedMessage(method, payload, result);
    if (sent !== null) messageAuthorStore(stateDir).record(sent.threadId, sent.messageId, userId);
  });

/**
 * The operator is never fenced in, but still works in a current workspace:
 * what they create joins it, and their lists follow it once they pick one.
 */
const makeOperatorFence = (
  access: LogicPacksAccess["Service"],
  onIntent: (method: string, payload: unknown) => Effect.Effect<void>,
  stateDir: string | null,
): MemberFence => {
  const inView = (projectId: string) => access.inView(null, projectId);
  return {
    userId: null,
    homeDirectory: null,
    canSeeProject: () => true,
    // The host's own terminals are registered so a member can never attach to one by id.
    check: (method, payload) =>
      Effect.sync(() => {
        if (method !== "terminal.open" && method !== "terminal.attach") return;
        const ref = terminalRef(payload);
        if (ref?.terminalId != null) {
          registerTerminal({
            userId: null,
            projectId: null,
            threadId: ref.threadId,
            terminalId: ref.terminalId,
          });
        }
      }),
    afterSuccess: (method, payload, result) => {
      const projectId = createdProjectId(method, payload, result);
      return (
        projectId === null ? Effect.void : attachToCurrentWorkspace(access, null, projectId)
      ).pipe(
        Effect.andThen(recordAuthor(stateDir, null, method, payload, result)),
        Effect.andThen(onIntent(method, payload)),
      );
    },
    mapResult: (method, result) =>
      MEMBER_FILTERED_LIST_METHODS.has(method) && access.currentWorkspaceId(null) !== null
        ? filterListResultForMember(result, inView)
        : result,
    threadRedactor: () => Effect.succeed(null),
    filterShellItem: (item) =>
      access.currentWorkspaceId(null) === null ? item : filterShellItemForMember(item, inView),
    filterTerminalEvent: (event) => event,
    withMemberDefaults: (settings) => settings,
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
  if (userId === null) {
    const operatorConfig = yield* Effect.serviceOption(ServerConfig.ServerConfig);
    return makeOperatorFence(
      accessOption.value,
      onIntent,
      operatorConfig._tag === "Some" ? operatorConfig.value.stateDir : null,
    );
  }
  const access = accessOption.value;
  const expertsOption = yield* Effect.serviceOption(ExpertsService);
  const grants = expertsOption._tag === "Some" ? expertsOption.value : null;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const config = yield* ServerConfig.ServerConfig;
  const stateDir = config.stateDir;
  const instanceRegistry = yield* Effect.serviceOption(
    ProviderInstanceRegistry.ProviderInstanceRegistry,
  );
  // Off only when the operator chooses to lend their own provider logins to every member.
  // On a laptop host (the desktop app) members have no way to connect their own login without a
  // cloud code, so they run on the agents installed on the host's machine, which is the point of
  // host-based sharing. Cloud hosts keep requiring each member's own login.
  const onCloudHost = /^(1|true|yes|on)$/i.test((process.env.LOGICPACKS_CLOUD_HOST ?? "").trim());
  const membersMustUseOwn = yield* Config.Boolean("LOGICPACKS_MEMBERS_OWN_PROVIDERS").pipe(
    Config.withDefault(onCloudHost),
    Effect.orElseSucceed(() => onCloudHost),
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
    // worktreeProjectRoot returns a real path: compare the way the host does (Windows: case, slashes).
    return root === null
      ? undefined
      : lastVisible.find(
          (project) => pathIsWithin(project.root, root) && pathIsWithin(root, project.root),
        );
  };
  const canSee = (projectId: string) => access.roleOf(userId, projectId) !== null;
  // Lists and the live sidebar follow the current workspace; commands only need access.
  const inView = (projectId: string) => access.inView(userId, projectId);

  const threadProject = (threadId: string) =>
    threads.getThreadShell(threadId as ThreadId).pipe(
      Effect.map((shell) => shell?.projectId ?? null),
      Effect.orElseSucceed(() => null),
    );

  /** Which lendable agent a provider instance is: by driver when the registry knows it. */
  const agentOfInstance = Effect.fn("logicpacks.memberFence.agentOfInstance")(function* (
    instanceId: string,
  ) {
    const fromId = agentForDriver(instanceId);
    if (fromId !== null && /^(claude|codex|opencode)-lp-/.test(instanceId)) return fromId;
    if (instanceRegistry._tag === "Some") {
      const instance = yield* instanceRegistry.value
        .getInstance(instanceId as never)
        .pipe(Effect.orElseSucceed(() => undefined));
      const driver = (instance as { readonly driverKind?: string } | undefined)?.driverKind;
      if (driver !== undefined) return agentForDriver(driver);
    }
    return fromId;
  });

  /** The projects a call acts in: named directly, through its thread, or by the paths it names. */
  const zoneProjects = Effect.fn("logicpacks.memberFence.zoneProjects")(function* (
    payload: unknown,
  ) {
    const found = new Set<string>();
    const targets = rpcTargets(payload);
    for (const projectId of targets.projectIds) found.add(projectId);
    for (const threadId of targets.threadIds) {
      const projectId = yield* threadProject(threadId);
      if (projectId !== null) found.add(projectId);
    }
    for (const path of collectPayloadPaths(payload)) {
      const project = projectForCwd(path.base ?? path.value);
      if (project !== undefined) found.add(project.id);
    }
    return [...found];
  });

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
    // A Read only seat: reads and subscriptions pass, every change is refused where it lands.
    // Making a project is judged for the person on this host, before any path is looked at.
    if (rpcNeeds(method, payload).includes("projects.create") && !access.canCreateProjects(userId)) {
      return yield* denied(method, PROJECTS_OFF_MESSAGE);
    }
    if (rpcNeeds(method, payload).includes("projects.manage")) {
      for (const projectId of rpcTargets(payload).projectIds) {
        if (!canManageProjects(access.zonesOf(userId, projectId).zones)) {
          return yield* denied(method, PROJECTS_OFF_MESSAGE);
        }
      }
    }
    // The visible projects first: paths in a payload are matched to their project by them.
    const visible = yield* visibleProjects;
    lastVisible = visible;
    if (!viewerMayCall(method, payload)) {
      const named = rpcTargets(payload);
      const projectIds: Array<string | null> = [...named.projectIds];
      for (const threadId of named.threadIds) projectIds.push(yield* threadProject(threadId));
      // A file call names its project by its folder.
      for (const projectId of yield* zoneProjects(payload)) projectIds.push(projectId);
      const landing = projectIds.length === 0 ? [null] : projectIds;
      if (landing.some((projectId) => access.isReadOnly(userId, projectId))) {
        return yield* denied(method, READ_ONLY_MESSAGE);
      }
    }
    if (usesTildeOutsideHomeMethods(method, payload)) {
      return yield* denied(method, "Use the full folder path here.");
    }
    // Every path a member names must sit in their own space or a project shared with them.
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
    // Other folders the host chose to share with this person (absolute, outside the project).
    const extraFolders = visible.flatMap((project) => {
      const entries = sharedFolders(access.zonesOf(userId, project.id).zones);
      if (entries.length === 0) return [];
      return resolveSharedFolders(project.root, entries).folders.filter(
        (folder) => !pathIsWithin(project.root, folder),
      );
    });
    const jail = makeMemberJail({
      memberRoot,
      projectRoots: [...visible.map((project) => project.root), ...extraFolders],
      worktreesDir: config.worktreesDir,
    });
    if (firstJailViolation(jail, payload) !== null) {
      return yield* denied(
        method,
        "That folder is outside your space and the projects shared with you.",
      );
    }
    // Access zones: what the call needs (files, compute) must be in the member's zones for the
    // project it acts in. Read only was refused above; this is the rest of the one model.
    const allNeeds = rpcNeeds(method, payload);
    // Making a project is judged for the person on this host, not by one project's zones.
    if (allNeeds.includes("projects.create") && !access.canCreateProjects(userId)) {
      return yield* denied(method, PROJECTS_OFF_MESSAGE);
    }
    const needs = allNeeds.filter((need) => need !== "projects.create");
    if (needs.length > 0) {
      const projectIds = yield* zoneProjects(payload);
      const scope: ReadonlyArray<string | null> =
        projectIds.length > 0
          ? projectIds
          : needs.includes("compute")
            ? [null]
            : [];
      for (const projectId of scope) {
        const refusal = refusalFor(access.zonesOf(userId, projectId).zones, needs);
        if (refusal !== null) return yield* denied(method, refusal);
      }
    }
    // Files zone folders: when the host shared only some folders, every file path a file call
    // names must sit in them. Checked on the REAL path, so a symlink or a worktree cannot lead out.
    if (needs.includes("files.read") || needs.includes("files.write")) {
      const entries = collectPayloadPaths(payload);
      const isBase = (key: string) => key === "cwd" || key === "workspaceRoot" || key === "worktreePath";
      const targets = entries.some((entry) => !isBase(entry.key))
        ? entries.filter((entry) => !isBase(entry.key))
        : entries;
      for (const entry of targets) {
        const resolved = resolveMemberPath(entry.value, entry.base, memberRoot);
        if (typeof resolved !== "string") continue;
        const project = projectForCwd(resolved);
        if (project === undefined) continue;
        const entriesOfZone = sharedFolders(access.zonesOf(userId, project.id).zones);
        if (entriesOfZone.length === 0) continue;
        const { folders } = resolveSharedFolders(project.root, entriesOfZone);
        // A worktree of the project holds the same files: judge the path in the project itself.
        const worktree = worktreeProjectRoot(resolved, config.worktreesDir);
        let judged = resolved;
        if (worktree !== null && !pathIsWithin(project.root, resolved)) {
          const parts = NodePath.relative(config.worktreesDir, resolved).split(NodePath.sep).slice(2);
          judged = NodePath.join(project.root, ...parts);
        }
        if (!folderAllows(folders, judged)) return yield* denied(method, OUTSIDE_FOLDERS_MESSAGE);
      }
    }
    // Secret files stay hidden from a member unless the host granted them (always for vetted
    // freelancers, who are handled below as before).
    if (SECRET_GUARDED_METHODS.has(method)) {
      const target = guardedFilePath(payload);
      const project = target === null ? undefined : projectForCwd(target.cwd);
      if (
        target !== null &&
        project !== undefined &&
        !canReadSecrets(access.zonesOf(userId, project.id).zones)
      ) {
        const relative = relativeToRoot(target.cwd, target.path) ?? target.path;
        if (isSecretPath(relative, patterns)) return yield* denied(method, SECRET_FILE_MESSAGE);
      }
    }
    // Terminals belong to the member who opened them, and only while Compute stays on.
    if (TERMINAL_METHODS.has(method) && method !== "subscribeTerminalMetadata") {
      const ref = terminalRef(payload);
      if (ref === null) return yield* denied(method, "Name the terminal.");
      const owner = ref.terminalId === null ? undefined : ownerOfTerminal(ref.threadId, ref.terminalId);
      const opens = method === "terminal.open" || method === "terminal.attach";
      if (ref.terminalId === null) {
        // A thread-wide close would also close terminals that are not theirs.
        if (terminalsOf(userId).length === 0 || method !== "terminal.close") {
          return yield* denied(method, "Name the terminal.");
        }
      } else if (owner !== undefined && owner.userId !== userId) {
        return yield* denied(method, "That terminal belongs to someone else. Open a new one.");
      } else if (owner === undefined && !opens) {
        return yield* denied(method, "That terminal is not yours.");
      }
      const projectId = (yield* threadProject(ref.threadId)) ?? (yield* zoneProjects(payload))[0] ?? null;
      if (ref.terminalId !== null && opens && owner === undefined) {
        const projectRoot = lastVisible.find((project) => project.id === projectId)?.root;
        const zones = access.zonesOf(userId, projectId).zones;
        const unrestricted = isUnrestricted(zones);
        const shared =
          projectRoot === undefined
            ? { folders: [] as ReadonlyArray<string> }
            : resolveSharedFolders(projectRoot, sharedFolders(zones));
        registerTerminal({
          userId,
          projectId,
          threadId: ref.threadId,
          terminalId: ref.terminalId,
          folders: shared.folders,
          mode: unrestricted ? "unrestricted" : "sandboxed",
          memberHome: memberRoot,
          stateDir: NodePath.join(config.baseDir, "sandbox-profiles"),
        });
        yield* access.logAccess({
          projectId,
          userId,
          kind: "terminal.open",
          detail: unrestricted
            ? `Opened terminal ${ref.terminalId} (Unrestricted: a shell as the host's user).`
            : `Opened terminal ${ref.terminalId} (Sandboxed: reads and writes only ${
                sharedFolders(zones).length === 0 ? "the project" : "the shared folders"
              } and their own home; refused to start if the sandbox cannot be applied).`,
        });
      }
      if (method === "terminal.write" && owner !== undefined && owner.userId === userId) {
        const data = (payload as { readonly data?: unknown }).data;
        const first = typeof data === "string" ? captureFirstCommand(owner, data) : null;
        if (first !== null) {
          yield* access.logAccess({
            projectId: owner.projectId,
            userId,
            kind: "terminal.command",
            detail: `First command in ${owner.terminalId}: ${first}`,
          });
        }
      }
      if (method === "terminal.close") {
        yield* access.logAccess({
          projectId,
          userId,
          kind: "terminal.close",
          detail: `Closed terminal ${ref.terminalId ?? "(all in thread)"}.`,
        });
        forgetTerminal(ref.threadId, ref.terminalId);
      }
    }
    // Remember who sent a message before it starts a run, so the run keeps to their zones.
    if (method === "orchestration.dispatchCommand" || method === "orchestration.launchThread") {
      const record = payload as Record<string, unknown>;
      const messageId =
        method === "orchestration.dispatchCommand"
          ? record["messageId"]
          : (record["initialMessage"] as { readonly messageId?: unknown } | undefined)?.messageId;
      const threadId = record["threadId"];
      const startsRun =
        method === "orchestration.launchThread"
          ? record["initialMessage"] !== undefined
          : record["type"] === "message.dispatch";
      if (startsRun && typeof messageId !== "string") {
        // Without an id the run could not be tied back to this member's zones.
        return yield* denied(method, "Update the app: this message has no id.");
      }
      if (typeof messageId === "string") {
        const senderProject = (yield* commandProject(payload)) ?? null;
        const senderRoot = lastVisible.find((project) => project.id === senderProject)?.root;
        registerMemberMessage(typeof threadId === "string" ? threadId : "", messageId, {
          userId,
          projectId: senderProject,
          confine:
            senderRoot === undefined
              ? undefined
              : {
                  projectRoot: senderRoot,
                  worktreesDir: config.worktreesDir,
                  memberHome: memberRoot,
                  stateDir: NodePath.join(config.baseDir, "sandbox-profiles"),
                },
        });
      }
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
      // The host's own agents are lent by the AI zone of the project this runs in.
      const agent = yield* agentOfInstance(instanceId);
      const aiZones = access.zonesOf(userId, (yield* commandProject(payload)) ?? null).zones;
      const hostAgentAllowed =
        agent === null
          ? // Other providers (Cursor, Pi, ACP agents) are lent only with every agent allowed.
            ACCESS_AGENTS.every((candidate) => canUseAgent(aiZones, candidate))
          : canUseAgent(aiZones, agent);
      const decision = decideInstanceUse({
        instanceId,
        userId,
        membersMustUseOwn,
        granted,
        hostAgentAllowed,
      });
      if (decision === "ai_off") {
        return yield* denied(method, aiOffMessage(agent === null ? null : `${AGENT_LABELS[agent]}`));
      }
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
    ).pipe(
      Effect.andThen(recordAuthor(stateDir, userId, method, payload, result)),
      Effect.andThen(onIntent(method, payload)),
    );
  };

  return {
    userId,
    homeDirectory: memberRoot,
    canSeeProject: canSee,
    check,
    afterSuccess,
    mapResult: (method, result, payload) => {
      const listed0 = MEMBER_FILTERED_LIST_METHODS.has(method)
        ? filterListResultForMember(result, inView)
        : result;
      // File lists drop secret files for a member who was not granted them.
      const cwd0 = (payload as { readonly cwd?: unknown } | undefined)?.cwd;
      const project0 = typeof cwd0 === "string" ? projectForCwd(cwd0) : undefined;
      const listed =
        SECRET_FILTERED_METHODS.has(method) &&
        project0 !== undefined &&
        !canReadSecrets(access.zonesOf(userId, project0.id).zones)
          ? filterSecretEntries(method, listed0, patterns)
          : listed0;
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
    withMemberDefaults: (settings, providers) => {
      // A host default that is not one of the named agents (a custom ACP agent the host chose on
      // purpose) is left alone: only Claude, Codex and OpenCode defaults are replaced.
      const hostDefault = (settings.defaultModelSelection as { readonly instanceId?: unknown } | undefined)
        ?.instanceId;
      const hostDefaultProvider = providers.find((provider) => provider.instanceId === hostDefault);
      if (hostDefaultProvider !== undefined && agentForDriver(hostDefaultProvider.driver) === null) {
        return settings;
      }
      const claude = providers.filter(
        (provider) =>
          agentForDriver(provider.driver) === "claude" &&
          provider.enabled !== false &&
          provider.installed !== false,
      );
      const own = claude.find((provider) => isOwnMemberInstance(provider.instanceId, userId));
      const host = claude.find((provider) => !isMemberInstanceId(provider.instanceId));
      const lent =
        host !== undefined &&
        !membersMustUseOwn &&
        Array.from(access.visibleProjectIds(userId)).some((projectId) =>
          canUseAgent(access.zonesOf(userId, projectId).zones, "claude"),
        );
      // Host's Claude when lent, else their own, else leave the host's default alone.
      const pick = lent ? host : own;
      if (pick === undefined) return settings;
      const model =
        pick.models?.find((candidate) => candidate.slug === DEFAULT_MODEL_BY_PROVIDER["claudeAgent" as never])
          ?.slug ?? pick.models?.[0]?.slug;
      if (model === undefined) return settings;
      return { ...settings, defaultModelSelection: { instanceId: pick.instanceId, model } };
    },
    filterTerminalEvent: (event) => {
      const mine = (threadId: string, terminalId: string) =>
        ownerOfTerminal(threadId, terminalId)?.userId === userId;
      if (event.type === "snapshot") {
        return {
          ...event,
          terminals: event.terminals.filter((terminal) =>
            mine(terminal.threadId, terminal.terminalId),
          ),
        };
      }
      if (event.type === "upsert") {
        return mine(event.terminal.threadId, event.terminal.terminalId) ? event : null;
      }
      return mine(event.threadId, event.terminalId) ? event : null;
    },
    filterProviders: (providers) =>
      providersForMember(providers, {
        userId,
        membersMustUseOwn,
        grantedInstanceIds: grants?.grantedInstanceIds(userId),
      }),
  } satisfies MemberFence;
});
