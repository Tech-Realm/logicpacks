import {
  CommandId,
  MessageId,
  ThreadId,
  OrchestratorMcpFailure,
  ProjectId,
} from "@logicpacks/contracts";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as ThreadLaunch from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadMessageIntake from "../../../orchestration-v2/ThreadMessageIntake.ts";
import * as Claims from "../../../orchestration-v2/AttachmentClaims.ts";
import * as Project from "../../../project/ProjectService.ts";
import * as ProjectCloneTracker from "../../../project/ProjectCloneTracker.ts";
import { mutateProjectWithClone } from "../../../project/ProjectMutation.ts";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import * as Repositories from "../../../sourceControl/SourceControlRepositoryService.ts";
import * as GitVcsDriver from "../../../vcs/GitVcsDriver.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as DateTime from "effect/DateTime";
import { resolveNewThreadModelSelection } from "@logicpacks/shared/usageLimits";
import { resolveProjectSettings } from "@logicpacks/shared/projectSettings";
import { resolveRuntimeMode } from "../../delegatedTaskModes.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { newCommandId, readCaller, resolveProjectId, unavailable } from "../../threadAccess.ts";
import { ProjectToolkit } from "./tools.ts";
import { agentPresenceKey, describePresence } from "../../../logicpacks/presence.ts";
import { PresenceService } from "../../../logicpacks/PresenceService.ts";
import { ProjectLedger } from "../../../logicpacks/ProjectLedger.ts";
import { runLedgerTool, type LedgerToolArgs } from "../../../logicpacks/ledgerHttp.ts";
import { packsReader, type PacksReader } from "../../../logicpacks/packsHttp.ts";

function projectFailure(error: Project.ProjectServiceError) {
  if (error._tag === "ProjectOperationError") return unavailable();
  const message =
    error._tag === "ProjectNotFoundError"
      ? "The project was not found."
      : error._tag === "ProjectConflictError"
        ? "The workspace is already registered to a project."
        : "The project is not empty; force=true is required to delete it.";
  return new OrchestratorMcpFailure({ code: "invalid_request", message });
}

/** Require project worktrees so launches cannot target arbitrary host directories. */
const assertProjectWorktree = Effect.fn("mcp.assertProjectWorktree")(function* (
  workspaceRoot: string,
  worktreePath: string,
) {
  const git = yield* GitVcsDriver.GitVcsDriver;
  const fileSystem = yield* FileSystem.FileSystem;
  const real = (path: string) => fileSystem.realPath(path).pipe(Effect.orElseSucceed(() => path));
  const worktrees = yield* git.listWorktreePaths(workspaceRoot).pipe(
    Effect.flatMap((paths) => Effect.forEach(paths, real)),
    Effect.orElseSucceed((): ReadonlyArray<string> => []),
  );
  if (!worktrees.includes(yield* real(worktreePath)))
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message:
        "worktreePath must be one of the project's git worktrees. lp_worktree_list shows them.",
    });
});

/** A fixed-length id, so a long key fits in the scratch folder name derived from it. */
const launchCommandId = Effect.fn("mcp.launchCommandId")(function* (
  namespace: string,
  key: string,
) {
  const crypto = yield* Crypto.Crypto;
  // @effect-diagnostics-next-line preferSchemaOverJson:off - a JSON pair keeps the caller apart from the key.
  const bytes = new TextEncoder().encode(JSON.stringify([namespace, key]));
  const digest = yield* crypto.digest("SHA-256", bytes).pipe(Effect.mapError(unavailable));
  return CommandId.make(`mcp:launch:${Hex.encode(digest)}`);
});

const access = Effect.gen(function* () {
  yield* readCaller();
  return yield* Project.ProjectService;
});
/** A ledger tool, run as the calling thread's agent in its own project. */
const ledgerCall = Effect.fn("mcp.ledgerCall")(function* (
  tool: Parameters<typeof runLedgerTool>[0]["tool"],
  args: LedgerToolArgs,
  readPacks?: PacksReader,
) {
  const context = yield* readCaller();
  if (context.caller === undefined)
    return yield* new OrchestratorMcpFailure({
      code: "target_required",
      message: "The project ledger tools run inside a LogicPacks thread.",
    });
  const ledger = yield* ProjectLedger;
  const view = yield* ledger.view(context.caller.projectId);
  const own = view.threads.find((thread) => thread.threadId === context.caller!.id);
  const answer = yield* runLedgerTool({
    projectId: context.caller.projectId,
    threadId: context.caller.id,
    name: own?.agent?.name ?? "An agent",
    tool,
    args,
    ...(readPacks === undefined ? {} : { readPacks }),
  }).pipe(
    Effect.mapError(
      (error) =>
        new OrchestratorMcpFailure({
          code: "invalid_request",
          message: error.message,
        }),
    ),
  );
  return { answer };
});

export const layer = McpToolAccess.toLayer(
  ProjectToolkit,
  Effect.gen(function* () {
    const readPacks = yield* packsReader;
    return {
      lp_thread_launch: McpToolAccess.startsThreads(
        (input) => input,
        (input, { runtimeMode, interactionMode, linkOrigin }) =>
          Effect.gen(function* () {
            const scope = yield* McpInvocationContext.McpInvocationContext;
            const context = yield* readCaller();
            const { caller } = context;
            // A retry with the same key replays the first launch: the ids derive
            // from the caller and the key, and the launch service replays a
            // command it already accepted.
            const commandId =
              input.clientRequestId === undefined
                ? yield* newCommandId()
                : yield* launchCommandId(scope.requestNamespace, input.clientRequestId);
            const threadId = ThreadId.make(commandId);
            const messageId = MessageId.make(commandId);
            const attachments = input.attachments ?? [];
            if (attachments.some((attachment) => !Claims.attachmentIsPendingUpload(attachment)))
              return yield* new OrchestratorMcpFailure({
                code: "invalid_request",
                message: "A new thread accepts only pending attachment uploads.",
              });
            if (
              input.scratch === true &&
              (input.projectId !== undefined || input.workspaceStrategy !== undefined)
            )
              return yield* new OrchestratorMcpFailure({
                code: "invalid_request",
                message:
                  "scratch:true picks its own project and folder; omit projectId and workspaceStrategy.",
              });
            const projectId =
              input.scratch === true
                ? (yield* ManagedProjectFolders.ManagedProjectFolders.pipe(
                    Effect.flatMap((folders) => folders.ensureScratchProject),
                    Effect.mapError(
                      (error) =>
                        new OrchestratorMcpFailure({
                          code: "orchestration_error",
                          message: error.message,
                        }),
                    ),
                  )).projectId
                : yield* resolveProjectId(context, input.projectId);
            const readProject = Project.ProjectService.pipe(
              Effect.flatMap((projects) => projects.getById(projectId)),
              Effect.mapError(unavailable),
              Effect.map(Option.getOrUndefined),
            );
            // A retry of an accepted launch replays it: it keeps the model it started
            // with and skips the checks only a new launch needs, which the project
            // may no longer pass, such as a base branch deleted since.
            const launched =
              input.clientRequestId === undefined
                ? null
                : yield* context.threads
                    .getThreadShell(threadId)
                    .pipe(Effect.mapError(unavailable));
            const launchedModel =
              launched === null || launched.deletedAt !== null
                ? undefined
                : launched.modelSelection;
            const replaying = launchedModel !== undefined;
            if (!replaying && input.workspaceStrategy?.type === "existing_worktree") {
              const project = yield* readProject;
              if (project === undefined)
                return yield* new OrchestratorMcpFailure({
                  code: "invalid_request",
                  message: "The project was not found.",
                });
              yield* assertProjectWorktree(
                project.workspaceRoot,
                input.workspaceStrategy.worktreePath,
              );
            }
            // Reject unresolved base refs before accepting a launch; worktree provisioning happens later.
            const strategy = input.workspaceStrategy;
            if (!replaying && strategy?.type === "worktree")
              yield* ThreadLaunch.ThreadLaunchService.pipe(
                Effect.flatMap((launches) =>
                  launches.checkWorktreeBase({ projectId, workspaceStrategy: strategy }),
                ),
                Effect.mapError(
                  (error) =>
                    new OrchestratorMcpFailure({
                      code: "invalid_request",
                      message: `${error.message} No thread was created. Pass a branch, tag, or commit that exists there${
                        strategy.startFromOrigin === true
                          ? "; the project has no usable remote to fetch it from."
                          : ", or set startFromOrigin:true if it exists only on a remote."
                      }`,
                    }),
                ),
              );
            // A caller outside a thread has nothing to inherit, so it starts with the
            // project's effective defaults, as the composer does. Its mode stays
            // within the ceiling it was approved with.
            const projectDefaults =
              caller === undefined && !replaying
                ? yield* ServerSettings.ServerSettingsService.pipe(
                    Effect.flatMap((settings) => settings.getSettings),
                    Effect.mapError(unavailable),
                    Effect.flatMap((settings) =>
                      Effect.map(
                        readProject,
                        (project) => resolveProjectSettings(settings, projectId, project).settings,
                      ),
                    ),
                  )
                : undefined;
            const modelSelection =
              input.modelSelection ??
              launchedModel ??
              caller?.modelSelection ??
              (projectDefaults
                ? resolveNewThreadModelSelection({
                    defaultSelection: projectDefaults.defaultModelSelection,
                    fallbackSelection: projectDefaults.fallbackModelSelection,
                    providers: yield* ProviderRegistry.ProviderRegistry.pipe(
                      Effect.flatMap((registry) => registry.getProviders),
                    ),
                    settings: projectDefaults,
                    projectId,
                    now: DateTime.toEpochMillis(yield* DateTime.now),
                  }).selection
                : null) ??
              undefined;
            if (modelSelection === undefined)
              return yield* new OrchestratorMcpFailure({
                code: "invalid_request",
                message:
                  "Pass modelSelection: the project has no default model. orchestrator_capabilities lists providers and models.",
              });
            let startedRuntimeMode =
              projectDefaults !== undefined && input.runtimeMode === undefined
                ? yield* resolveRuntimeMode(runtimeMode, projectDefaults.defaultRuntimeMode).pipe(
                    Effect.orElseSucceed(() => runtimeMode),
                  )
                : runtimeMode;
            if (!replaying) {
              const providers = yield* (yield* ProviderRegistry.ProviderRegistry).getProviders;
              startedRuntimeMode = yield* resolveRuntimeMode(
                startedRuntimeMode,
                input.runtimeMode,
                {
                  modelSelection,
                  supportedRuntimeModes: providers.find(
                    (provider) => provider.instanceId === modelSelection.instanceId,
                  )?.supportedRuntimeModes,
                },
              );
            }
            const result = yield* ThreadMessageIntake.launchThread({
              commandId,
              threadId,
              projectId,
              title: input.title,
              modelSelection,
              runtimeMode: startedRuntimeMode,
              interactionMode,
              workspaceStrategy: input.workspaceStrategy ?? { type: "root" },
              ...(input.message === undefined && attachments.length === 0
                ? {}
                : {
                    initialMessage: {
                      messageId,
                      ...(caller === undefined ? {} : { senderThreadId: caller.id }),
                      text: input.message ?? "",
                      attachments,
                    },
                  }),
              createdBy: "agent",
              creationSource: "mcp",
              ...(linkOrigin === undefined ? {} : { linkOrigin }),
              // Kept only alongside linkOrigin: thread.create drops it otherwise.
              ...(input.delegatedFrom === undefined ? {} : { delegatedFrom: input.delegatedFrom }),
            }).pipe(
              Effect.mapError((error) => {
                if (error._tag === "AttachmentClaimError") {
                  return new OrchestratorMcpFailure({
                    code: "orchestration_error",
                    message: error.message,
                  });
                }
                if (error._tag === "ThreadManagementProviderInstanceDisabledError") {
                  return new OrchestratorMcpFailure({
                    code: "invalid_request",
                    message: error.message,
                  });
                }
                return unavailable();
              }),
            );
            const thread = result.projection.thread;
            const run = result.projection.runs.find((run) => run.userMessageId === messageId);
            return {
              threadId: thread.id,
              link: McpInvocationContext.threadLinkFor(scope, thread.id),
              projectId: thread.projectId,
              modelSelection: thread.modelSelection,
              runId: run?.id ?? null,
              status: run?.status ?? null,
            };
          }),
        // The launched thread carries the caller's link, if it has one.
        "stamped",
      ),
      lp_project_list: McpToolAccess.reads((input) =>
        Effect.gen(function* () {
          const projects = yield* access;
          // Identities are resolved: linked environments find this side's project by repository.
          return yield* projects
            .listPage({ cursor: input.cursor ?? 0, limit: input.limit ?? 20 })
            .pipe(Effect.mapError(unavailable));
        }),
      ),
      lp_project_read: McpToolAccess.reads((input) =>
        Effect.gen(function* () {
          const projects = yield* access;
          const result = yield* projects
            .getById(input.projectId)
            .pipe(Effect.mapError(unavailable));
          if (Option.isNone(result))
            return yield* new OrchestratorMcpFailure({
              code: "invalid_request",
              message: "The project was not found.",
            });
          return result.value;
        }),
      ),
      lp_project_presence: McpToolAccess.reads((input) =>
        Effect.gen(function* () {
          const context = yield* readCaller();
          const projectId = yield* resolveProjectId(context, input.projectId);
          const presence = yield* PresenceService;
          const own = context.caller === undefined ? null : agentPresenceKey(context.caller.id);
          const entries = yield* presence.list(
            (entry) => entry.projectId === projectId && entry.key !== own,
          );
          const nowMs = yield* Clock.currentTimeMillis;
          return { present: entries.map((entry) => describePresence(entry, nowMs)) };
        }),
      ),
      lp_project_threads: McpToolAccess.readsAsCaller(() => ledgerCall("threads", {})),
      lp_project_who_is_working_on: McpToolAccess.readsAsCaller((input) =>
        ledgerCall("who_is_working_on", { query: input.query }),
      ),
      lp_project_conflicts: McpToolAccess.readsAsCaller(() => ledgerCall("conflicts", {})),
      lp_project_send_to_thread: McpToolAccess.actsAsCaller((input) =>
        ledgerCall("send_to_thread", {
          message: input.message,
          ...(input.to === undefined ? {} : { to: input.to }),
          ...(input.replyTo === undefined ? {} : { replyTo: input.replyTo }),
        }),
      ),
      lp_project_propose_merge: McpToolAccess.actsAsCaller((input) =>
        ledgerCall(
          "propose_merge",
          Object.fromEntries(
            Object.entries(input).filter(([, value]) => value !== undefined),
          ) as LedgerToolArgs,
        ),
      ),
      lp_project_note: McpToolAccess.actsAsCaller((input) =>
        ledgerCall("note", {
          ...(input.goal === undefined ? {} : { goal: input.goal }),
          ...(input.decision === undefined ? {} : { decision: input.decision }),
        }),
      ),
      lp_project_packs: McpToolAccess.readsAsCaller((input) =>
        ledgerCall("packs", input.query === undefined ? {} : { query: input.query }, readPacks),
      ),
      lp_project_goals: McpToolAccess.readsAsCaller((input) =>
        ledgerCall("goals", input.goalId === undefined ? {} : { goalId: input.goalId }),
      ),
      lp_project_goal_plan: McpToolAccess.actsAsCaller((input) =>
        ledgerCall("goal_plan", {
          title: input.title,
          milestones: input.milestones,
          ...(input.outcome === undefined ? {} : { outcome: input.outcome }),
          ...(input.goalId === undefined ? {} : { goalId: input.goalId }),
        }),
      ),
      lp_project_goal_update: McpToolAccess.actsAsCaller((input) =>
        ledgerCall("goal_update", {
          milestoneId: input.milestoneId,
          status: input.status,
          ...(input.note === undefined ? {} : { note: input.note }),
          ...(input.criteria === undefined
            ? {}
            : {
                criteria: input.criteria.map((entry) => ({
                  criterion: entry.criterion,
                  met: entry.met,
                  ...(entry.evidence === undefined ? {} : { evidence: entry.evidence }),
                })),
              }),
        }),
      ),
      lp_project_create: McpToolAccess.writesEnvironment(
        ({ workspaceRoot, ...input }) =>
          Effect.gen(function* () {
            const projects = yield* Project.ProjectService;
            if (workspaceRoot === undefined) {
              // Only updates record model defaults; reject defaults that creation would silently drop.
              if (
                input.scripts !== undefined ||
                input.createWorkspaceRootIfMissing !== undefined ||
                input.defaultModelSelection !== undefined
              )
                return yield* new OrchestratorMcpFailure({
                  code: "invalid_request",
                  message:
                    "A project started from its title takes only a title; set scripts or defaultModelSelection afterwards with lp_project_update.",
                });
              const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
              const created = yield* folders.createNamedProject({ name: input.title }).pipe(
                Effect.mapError(
                  (error) =>
                    new OrchestratorMcpFailure({
                      code: "orchestration_error",
                      message: error.message,
                    }),
                ),
              );
              const project = yield* projects.getById(created.projectId).pipe(
                Effect.mapError(unavailable),
                Effect.flatMap(
                  Option.match({
                    onNone: () => Effect.fail(unavailable()),
                    onSome: Effect.succeed,
                  }),
                ),
              );
              return {
                ...project,
                ...(created.commitError === undefined ? {} : { commitError: created.commitError }),
              };
            }
            const commandId = yield* newCommandId();
            return yield* projects
              .create({ ...input, workspaceRoot, commandId, projectId: ProjectId.make(commandId) })
              .pipe(Effect.mapError(projectFailure));
          }),
        // Linked work may bring the repository it works in; an existing
        // registered workspace is still refused.
        { linkedCallers: "allowed" },
      ),
      lp_project_update: McpToolAccess.writesEnvironment((input) =>
        Effect.gen(function* () {
          const projects = yield* Project.ProjectService;
          return yield* projects
            .update({ ...input, commandId: yield* newCommandId() })
            .pipe(Effect.mapError(projectFailure));
        }),
      ),
      lp_project_delete: McpToolAccess.writesEnvironment((input) =>
        Effect.gen(function* () {
          const projects = yield* Project.ProjectService;
          const clones = yield* ProjectCloneTracker.ProjectCloneTracker;
          return yield* mutateProjectWithClone(projects, clones, {
            ...input,
            type: "project.delete",
            commandId: yield* newCommandId(),
          }).pipe(Effect.mapError(projectFailure));
        }),
      ),
      lp_project_clone: McpToolAccess.writesEnvironment(
        (input) =>
          Effect.gen(function* () {
            const repositories = yield* Repositories.SourceControlRepositoryService;
            return yield* repositories.cloneRepository(input).pipe(
              Effect.mapError(
                (error) =>
                  new OrchestratorMcpFailure({
                    code: "orchestration_error",
                    message: error.detail,
                  }),
              ),
            );
          }),
        // An existing destination is never adopted.
        { linkedCallers: "allowed" },
      ),
    };
  }),
);
