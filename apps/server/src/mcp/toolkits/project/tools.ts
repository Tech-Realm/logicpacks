import { McpAttachmentInput } from "../attachment/input.ts";
import {
  NonNegativeInt,
  ModelSelection,
  TrimmedNonEmptyString,
  ThreadId,
  RunId,
  OrchestrationV2DelegatedFrom,
  OrchestrationV2RunStatus,
  OrchestrationV2ThreadLaunchWorkspaceStrategy,
  RuntimeMode,
  ProviderInteractionMode,
  Project,
  ProjectCreatePayload,
  ProjectUpdatePayload,
  ProjectId,
  OrchestratorMcpClientRequestId,
  OrchestratorMcpEnvironmentTarget,
  OrchestratorMcpFailure,
  SourceControlCloneRepositoryInput,
  SourceControlCloneRepositoryResult,
} from "@logicpacks/contracts";
import * as FileSystem from "effect/FileSystem";
import * as DocumentText from "../../../provider/DocumentText.ts";
import * as ServerConfig from "../../../config.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as ThreadLaunchService from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as Crypto from "effect/Crypto";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as ProjectCloneTracker from "../../../project/ProjectCloneTracker.ts";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as SourceControlRepositoryService from "../../../sourceControl/SourceControlRepositoryService.ts";
import * as GitVcsDriver from "../../../vcs/GitVcsDriver.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { PresenceService } from "../../../logicpacks/PresenceService.ts";
import { ProjectLedger } from "../../../logicpacks/ProjectLedger.ts";
import { ProjectGoals } from "../../../logicpacks/ProjectGoals.ts";
import { GoalPlan } from "../../../logicpacks/goals.ts";

const shared = {
  success: Project,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ProjectService.ProjectService,
    Crypto.Crypto,
  ],
};
const ProjectListTool = Tool.make("lp_project_list", {
  ...shared,
  description: "List projects. Pages can shift.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    cursor: Schema.optional(NonNegativeInt),
    limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
  }),
  success: Schema.Struct({
    projects: Schema.Array(Project),
    nextCursor: Schema.NullOr(NonNegativeInt),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const ProjectReadTool = Tool.make("lp_project_read", {
  ...shared,
  description: "Read one project: workspace and saved scripts.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    projectId: ProjectId,
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const ProjectPresenceTool = Tool.make("lp_project_presence", {
  ...shared,
  description:
    "Who is in the project now: each person's and agent's file, line and activity. Check before editing; if someone is on your files, tell the user and coordinate.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    projectId: Schema.optional(ProjectId),
  }),
  success: Schema.Struct({ present: Schema.Array(Schema.String) }),
  dependencies: [...shared.dependencies, PresenceService],
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const LedgerAnswer = Schema.Struct({ answer: Schema.String });
const ledgerTool = {
  ...shared,
  success: LedgerAnswer,
  dependencies: [...shared.dependencies, ProjectLedger, ProjectGoals],
};
const StringList = Schema.Array(Schema.String).check(Schema.isMaxLength(30));
const ProjectThreadsTool = Tool.make("lp_project_threads", {
  ...ledgerTool,
  description:
    "The project ledger: every other thread here with its people, agent, goal, files and branch, plus recent decisions.",
  parameters: Tool.EmptyParams,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const ProjectWhoIsWorkingOnTool = Tool.make("lp_project_who_is_working_on", {
  ...ledgerTool,
  description:
    'Who is working on a person, file or topic in this project ("Ali", "src/checkout.tsx", "newsletter"). Use it for questions about teammates and before starting work.',
  parameters: Schema.Struct({ query: TrimmedNonEmptyString }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const ProjectConflictsTool = Tool.make("lp_project_conflicts", {
  ...ledgerTool,
  description: "Open conflicts in this project: files, whose work, why, and any negotiation.",
  parameters: Tool.EmptyParams,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const ProjectSendToThreadTool = Tool.make("lp_project_send_to_thread", {
  ...ledgerTool,
  description:
    "Message a teammate's thread (\"tell Ali to work on X\"): `to` is a person's name or a thread id. They see it at once; their agent gets it next turn. Answer a message with `replyTo`; replies return to the asker's thread.",
  parameters: Schema.Struct({
    to: Schema.optional(Schema.String),
    message: Schema.String.check(Schema.isMaxLength(4000)),
    replyTo: Schema.optional(Schema.String),
  }),
}).annotate(Tool.Destructive, false);
const ProjectProposeMergeTool = Tool.make("lp_project_propose_merge", {
  ...ledgerTool,
  description:
    "Negotiate a conflict with the other agents. action propose (default without negotiationId): start, for a conflictId or threadIds/people. action position: keep/change/drop lists, insist only for what your user needs. Agreed: the named agent merges on lp/merge-<id> and reports action merged (branch, summary) or failed.",
  parameters: Schema.Struct({
    action: Schema.optional(Schema.Literals(["propose", "position", "merged", "failed"])),
    negotiationId: Schema.optional(Schema.String),
    conflictId: Schema.optional(Schema.String),
    threadIds: Schema.optional(StringList),
    people: Schema.optional(StringList),
    keep: Schema.optional(StringList),
    change: Schema.optional(StringList),
    drop: Schema.optional(StringList),
    insist: Schema.optional(Schema.Boolean),
    note: Schema.optional(Schema.String),
    branch: Schema.optional(Schema.String),
    summary: Schema.optional(Schema.String),
  }),
}).annotate(Tool.Destructive, false);
const ProjectNoteTool = Tool.make("lp_project_note", {
  ...ledgerTool,
  description:
    "Tell the project ledger your current goal, or record a decision teammates should know.",
  parameters: Schema.Struct({
    goal: Schema.optional(Schema.String),
    decision: Schema.optional(Schema.String),
  }),
}).annotate(Tool.Destructive, false);
const ProjectPacksTool = Tool.make("lp_project_packs", {
  ...ledgerTool,
  description:
    "Packs saved in this project carry context between threads and apps: ledger summary, decisions, file and app references (Blender objects, Resolve markers), workflow steps. No query lists them; query = a pack id reads one in full. Read a pack when a message says to use it.",
  parameters: Schema.Struct({ query: Schema.optional(Schema.String) }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const ProjectGoalsTool = Tool.make("lp_project_goals", {
  ...ledgerTool,
  description:
    "Goals (Beta) in this project: drafts and active goals with each milestone's assignee, criteria, scope, due date and status, plus the people you can assign. goalId reads one goal.",
  parameters: Schema.Struct({ goalId: Schema.optional(Schema.String) }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const ProjectGoalPlanTool = Tool.make("lp_project_goal_plan", {
  ...ledgerTool,
  description:
    'Draft a goal when your user asks teammates or experts to do work ("ask Omar to do X and Y, and Priya to do Z by Friday"). One milestone per assignee task: title, assignee (a name from lp_project_goals), acceptance criteria, scope (paths it may touch, paths to avoid, branch, newDependencies, notes like "do not change the API") and due (YYYY-MM-DD or a weekday). Nothing is sent: your user reviews and confirms the draft in Goals. Pass goalId to revise your draft.',
  parameters: Schema.Struct({
    title: Schema.String,
    outcome: Schema.optional(Schema.String),
    milestones: GoalPlan.fields.milestones,
    goalId: Schema.optional(Schema.String),
  }),
}).annotate(Tool.Destructive, false);
const ProjectGoalUpdateTool = Tool.make("lp_project_goal_update", {
  ...ledgerTool,
  description:
    "Report on the goal milestone assigned to this thread: status in_progress, blocked, or done. With done, add a note and each acceptance criterion with met true/false and evidence; the goal's owner reviews it.",
  parameters: Schema.Struct({
    milestoneId: Schema.String,
    status: Schema.Literals(["in_progress", "blocked", "done"]),
    note: Schema.optional(Schema.String),
    criteria: Schema.optional(
      Schema.Array(
        Schema.Struct({
          criterion: Schema.String,
          met: Schema.Boolean,
          evidence: Schema.optional(Schema.String),
        }),
      ).check(Schema.isMaxLength(12)),
    ),
  }),
}).annotate(Tool.Destructive, false);
const ProjectCreateTool = Tool.make("lp_project_create", {
  ...shared,
  description:
    "Register a project folder. `createWorkspaceRootIfMissing` creates it; a registered folder is rejected. No `workspaceRoot`: makes a git repo from `title` with README, icon, first commit (`commitError` on failure; project still exists). Clone first with `lp_project_clone` if needed.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    ...ProjectCreatePayload.fields,
    workspaceRoot: Schema.optional(ProjectCreatePayload.fields.workspaceRoot),
  }),
  success: Schema.Struct({ ...Project.fields, commitError: Schema.optional(Schema.String) }),
  dependencies: [...shared.dependencies, ManagedProjectFolders.ManagedProjectFolders],
}).annotate(Tool.Destructive, true);
const ProjectUpdateTool = Tool.make("lp_project_update", {
  ...shared,
  description: "Update one project's settings. Omitted fields are unchanged.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    projectId: ProjectId,
    ...ProjectUpdatePayload.fields,
  }),
}).annotate(Tool.Destructive, true);
const ProjectDeleteTool = Tool.make("lp_project_delete", {
  ...shared,
  description: "Delete one project. Nonempty needs `force: true`. Folder on disk stays.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    projectId: ProjectId,
    force: Schema.optionalKey(Schema.Boolean),
  }),
  dependencies: [...shared.dependencies, ProjectCloneTracker.ProjectCloneTracker],
}).annotate(Tool.Destructive, true);
const ProjectCloneTool = Tool.make("lp_project_clone", {
  ...shared,
  description:
    "Clone a repository (`destinationPath` new or empty). Register after with `lp_project_create`, with the same `environmentId`.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    ...SourceControlCloneRepositoryInput.fields,
  }),
  success: SourceControlCloneRepositoryResult,
  dependencies: [
    ...shared.dependencies,
    SourceControlRepositoryService.SourceControlRepositoryService,
  ],
})
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);
const ThreadLaunchTool = Tool.make("lp_thread_launch", {
  ...shared,
  description:
    "Create one new top-level thread, bound to its workspace before the agent starts. Task in `message`. Omit `projectId`, model and modes to inherit yours (outside a thread, pass `projectId` or `scratch`); modes cannot exceed yours. After an error or lost reply, retry with the same `clientRequestId`. Follow it with `lp_thread_read` or `lp_thread_wait`. Mention it with its `link`.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    projectId: Schema.optional(ProjectId),
    scratch: Schema.optional(
      Schema.Boolean.annotate({
        description:
          "No project: a new Scratch folder. Not with `projectId` or `workspaceStrategy`.",
      }),
    ),
    title: TrimmedNonEmptyString,
    modelSelection: Schema.optional(ModelSelection),
    runtimeMode: Schema.optional(RuntimeMode),
    interactionMode: Schema.optional(ProviderInteractionMode),
    workspaceStrategy: Schema.optional(
      OrchestrationV2ThreadLaunchWorkspaceStrategy.annotate({
        description:
          "'worktree': new checkout from `baseRef`. 'existing_worktree': bind `worktreePath`, a project worktree. 'root': project checkout, the default, not your worktree. Stack: parent branch as `baseRef`, `startFromOrigin: false`. Uncommitted edits are not copied.",
      }),
    ),
    message: Schema.optional(
      Schema.String.check(Schema.isMaxLength(120000)).annotate({
        description: "First prompt. Omit it and `attachments` for idle.",
      }),
    ),
    attachments: Schema.optional(Schema.Array(McpAttachmentInput).check(Schema.isMaxLength(8))),
    clientRequestId: Schema.optional(OrchestratorMcpClientRequestId),
    /** Set by a linked environment launching its agent's delegated task here; ignored otherwise. */
    delegatedFrom: Schema.optional(OrchestrationV2DelegatedFrom),
  }),
  success: Schema.Struct({
    threadId: ThreadId,
    link: Schema.optional(Schema.String),
    projectId: ProjectId,
    modelSelection: ModelSelection,
    runId: Schema.NullOr(RunId),
    status: Schema.NullOr(OrchestrationV2RunStatus),
  }),
  dependencies: [
    ...shared.dependencies,
    ThreadLaunchService.ThreadLaunchService,
    ManagedProjectFolders.ManagedProjectFolders,
    GitVcsDriver.GitVcsDriver,
    FileSystem.FileSystem,
    ServerConfig.ServerConfig,
    ServerSettings.ServerSettingsService,
    ProviderRegistry.ProviderRegistry,
    DocumentText.DocumentText,
  ],
})
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

export const ProjectToolkit = Toolkit.make(
  ThreadLaunchTool,
  ProjectListTool,
  ProjectReadTool,
  ProjectPresenceTool,
  ProjectThreadsTool,
  ProjectWhoIsWorkingOnTool,
  ProjectConflictsTool,
  ProjectSendToThreadTool,
  ProjectProposeMergeTool,
  ProjectNoteTool,
  ProjectPacksTool,
  ProjectGoalsTool,
  ProjectGoalPlanTool,
  ProjectGoalUpdateTool,
  ProjectCreateTool,
  ProjectUpdateTool,
  ProjectDeleteTool,
  ProjectCloneTool,
);
