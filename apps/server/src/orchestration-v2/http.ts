import {
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
  type OrchestrationProjectShell,
} from "@logicpacks/contracts";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as SqlClient from "effect/sql/SqlClient";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  failEnvironmentInvalidRequest,
  failEnvironmentNotFound,
  requireEnvironmentScope,
} from "../auth/http.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { traceLocalHandlerWork } from "../cloud/traceRelayRequest.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import {
  buildBoundedThreadProjection,
  decodeThreadHistoryCursor,
  InvalidThreadHistoryCursorError,
  THREAD_HISTORY_SNAPSHOT_ROW_LIMIT,
  THREAD_HISTORY_PAGE_POLICY,
  OLDER_THREAD_USER_TURN_LIMIT,
} from "./threadHistoryPaging.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ProjectStore from "./ProjectStore.ts";
import { loadSubscriberShellSnapshot } from "./ShellStream.ts";
import { boundedSnapshotResponseFields } from "./ThreadStream.ts";
import { projectThreadProjectionForWire } from "./WireProjection.ts";
import { LogicPacksAccess } from "../logicpacks/LogicPacksAccess.ts";
import { filterShellItemForMember, memberUserIdFromSubject } from "../logicpacks/projectAccess.ts";
import { redactDeep } from "../logicpacks/externalTeam.ts";
import { ExternalTeamService } from "../logicpacks/ExternalTeamService.ts";

const isThreadTranscriptTooLargeError = Schema.is(
  ThreadManagementService.ThreadTranscriptTooLargeError,
);

function isThreadNotFound(error: unknown): boolean {
  return (
    Predicate.hasProperty(error, "cause") &&
    Predicate.hasProperty(error.cause, "_tag") &&
    error.cause._tag === "ProjectionStoreThreadNotFoundError"
  );
}

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "orchestration",
  Effect.fnUntraced(function* (handlers) {
    const sql = yield* SqlClient.SqlClient;
    const environment = yield* ServerEnvironment.ServerEnvironmentIdentity;
    const threadManagement = yield* ThreadManagementService.ThreadManagementService;
    const applicationEvents = yield* OrchestrationEventStore.OrchestrationEventStore;
    const projectStore = yield* ProjectStore.ProjectStoreV2;
    const projectEnrichment = yield* ProjectEnrichmentService.ProjectEnrichmentService;

    const enrichProjectShells = Effect.fn("http.orchestration.enrichProjectShells")(
      (projects: ReadonlyArray<OrchestrationProjectShell>) =>
        Effect.forEach(
          projects,
          (project) =>
            // Use available enrichment only; git probes can take a minute and exceed shell-snapshot budgets.
            projectEnrichment.getAvailable(project.workspaceRoot).pipe(
              Effect.map((enrichment) => ({
                ...project,
                repositoryIdentity: enrichment.repositoryIdentity,
              })),
            ),
          { concurrency: 16 },
        ),
    );

    const loadShellSnapshot = Effect.fn("http.orchestration.loadShellSnapshot")(
      function* (options: {
        readonly omitIdleSubagents: boolean;
        readonly omitOlderSettled: boolean;
      }) {
        const { snapshot } = yield* loadSubscriberShellSnapshot({
          sql,
          listShellIndex: threadManagement.listActiveShellIndex(),
          readThreads: (threadIds) =>
            threadManagement.readShellSnapshot({
              location: "active",
              ...(threadIds === undefined ? {} : { threadIds }),
            }),
          listProjects: projectStore.listShells(),
          latestSequence: applicationEvents.latestApplicationSequence,
          options,
        });
        const projects = yield* enrichProjectShells(snapshot.projects);
        return { ...snapshot, projects };
      },
    );

    // LogicPacks: members read only the projects and threads shared with them.
    const access = yield* Effect.serviceOption(LogicPacksAccess);
    const memberCanSee = (subject: string) => {
      const userId = memberUserIdFromSubject(subject);
      if (userId === null) return null;
      // A member session on a server without the access service sees nothing.
      return (projectId: string) =>
        access._tag === "Some" && access.value.roleOf(userId, projectId) !== null;
    };
    /** What the sidebar lists: the caller's current workspace (null = everything). */
    const viewFilter = (subject: string) => {
      const userId = memberUserIdFromSubject(subject);
      if (access._tag === "None") return userId === null ? null : () => false;
      if (userId === null && access.value.currentWorkspaceId(null) === null) return null;
      return (projectId: string) => access.value.inView(userId, projectId);
    };
    // LogicPacks: a vetted freelancer gets pasted secrets redacted in the customer's threads.
    const externalTeam = yield* Effect.serviceOption(ExternalTeamService);
    const externalUserOf = Effect.fn("http.orchestration.externalUserOf")(function* (
      subject: string,
    ) {
      const userId = memberUserIdFromSubject(subject);
      if (userId === null || externalTeam._tag === "None" || access._tag === "None") return null;
      const user = yield* access.value.getUser(userId).pipe(Effect.orElseSucceed(() => null));
      return { userId, email: user?.email ?? null };
    });
    type Redactor = (<A>(value: A) => A) | null;
    /** Null when the caller may not read the thread's project; else its redactor (null = none). */
    const requireThreadReadable = Effect.fn("http.orchestration.requireThreadReadable")(function* (
      subject: string,
      threadId: Parameters<typeof threadManagement.getThreadShell>[0],
    ) {
      const canSee = memberCanSee(subject);
      if (canSee === null) return null as Redactor;
      const shell = yield* threadManagement
        .getThreadShell(threadId)
        .pipe(Effect.orElseSucceed(() => null));
      if (shell === null || !canSee(shell.projectId)) {
        return yield* failEnvironmentNotFound("thread_not_found");
      }
      const external = yield* externalUserOf(subject);
      return (
        external !== null &&
        externalTeam._tag === "Some" &&
        externalTeam.value.externalAccess(external, shell.projectId) !== undefined
          ? <A>(value: A): A => redactDeep(value)
          : null
      ) as Redactor;
    });
    const redacted = <A>(redact: Redactor, value: A): A =>
      redact === null ? value : redact(value);

    const loadThreadSnapshot = Effect.fn("http.orchestration.loadThreadSnapshot")(function* (
      threadId: Parameters<typeof threadManagement.getThreadSnapshot>[0],
      failureReason:
        | "orchestration_thread_snapshot_failed"
        | "orchestration_thread_bounded_snapshot_failed"
        | "orchestration_thread_history_failed",
    ) {
      return yield* threadManagement.getThreadSnapshot(threadId).pipe(
        Effect.map((snapshot) => ({
          ...snapshot,
          projection: projectThreadProjectionForWire(snapshot.projection),
        })),
        Effect.catch(
          Effect.fnUntraced(function* (error) {
            if (isThreadNotFound(error)) {
              return yield* failEnvironmentNotFound("thread_not_found");
            }
            return yield* failEnvironmentInternal(failureReason, error);
          }),
        ),
      );
    });

    const loadThreadSnapshotWindow = Effect.fn("http.orchestration.loadThreadSnapshotWindow")(
      function* (
        threadId: Parameters<typeof threadManagement.getThreadSnapshot>[0],
        anchorItemId?: Parameters<
          typeof threadManagement.getThreadSnapshotWindow
        >[1]["anchorItemId"],
        anchorThreadId?: Parameters<
          typeof threadManagement.getThreadSnapshotWindow
        >[1]["anchorThreadId"],
        deferWork = false,
      ) {
        return yield* threadManagement
          .getThreadSnapshotWindow(threadId, {
            rowLimit: THREAD_HISTORY_SNAPSHOT_ROW_LIMIT,
            deferWork,
            userTurnLimit:
              anchorItemId === undefined
                ? THREAD_HISTORY_PAGE_POLICY.maxUserTurns
                : OLDER_THREAD_USER_TURN_LIMIT,
            ...(anchorItemId === undefined ? {} : { anchorItemId }),
            ...(anchorThreadId === undefined ? {} : { anchorThreadId }),
          })
          .pipe(
            Effect.map((snapshot) => ({
              ...snapshot,
              projection: projectThreadProjectionForWire(snapshot.projection),
            })),
            Effect.catch(
              Effect.fnUntraced(function* (error) {
                if (isThreadNotFound(error)) {
                  return yield* failEnvironmentNotFound("thread_not_found");
                }
                return yield* failEnvironmentInternal("orchestration_thread_history_failed", error);
              }),
            ),
          );
      },
    );

    return handlers
      .handle(
        "shellSnapshot",
        Effect.fn("environment.orchestration.shellSnapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const principal = yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          const snapshot = yield* loadShellSnapshot({
            omitIdleSubagents: args.query.omitIdleSubagents === "1",
            omitOlderSettled: args.query.omitOlderSettled === "1",
          }).pipe(
            traceLocalHandlerWork,
            Effect.catch((cause) =>
              failEnvironmentInternal("orchestration_snapshot_failed", cause),
            ),
          );
          const memberCanRead = memberCanSee(principal.subject);
          const inView = viewFilter(principal.subject);
          if (inView === null) return snapshot;
          const canSee = (projectId: string) =>
            (memberCanRead === null || memberCanRead(projectId)) && inView(projectId);
          const filtered = filterShellItemForMember({ kind: "snapshot", snapshot }, canSee);
          const visible =
            filtered?.kind === "snapshot" ? { ...snapshot, ...filtered.snapshot } : snapshot;
          const external = yield* externalUserOf(principal.subject);
          return external !== null &&
            externalTeam._tag === "Some" &&
            externalTeam.value.isExternalAnywhere(external)
            ? redactDeep(visible)
            : visible;
        }),
      )
      .handle(
        "threadSnapshot",
        Effect.fn("environment.orchestration.threadSnapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const principal = yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          const redact = yield* requireThreadReadable(principal.subject, args.params.threadId);
          const snapshot = yield* loadThreadSnapshot(
            args.params.threadId,
            "orchestration_thread_snapshot_failed",
          ).pipe(traceLocalHandlerWork);
          return redacted(redact, {
            snapshotSequence: snapshot.snapshotSequence,
            projection: snapshot.projection,
          });
        }),
      )
      .handle(
        "threadTranscript",
        Effect.fn("environment.orchestration.threadTranscript")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const principal = yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          const redact = yield* requireThreadReadable(principal.subject, args.params.threadId);
          return yield* threadManagement.getThreadTranscript(args.params.threadId).pipe(
            Effect.provideService(ServerEnvironment.ServerEnvironmentIdentity, environment),
            Effect.map((transcript) => redacted(redact, transcript)),
            traceLocalHandlerWork,
            Effect.catch(
              Effect.fnUntraced(function* (error) {
                if (isThreadTranscriptTooLargeError(error)) {
                  return yield* failEnvironmentInvalidRequest("thread_transcript_too_large");
                }
                if (isThreadNotFound(error)) {
                  return yield* failEnvironmentNotFound("thread_not_found");
                }
                return yield* failEnvironmentInternal(
                  "orchestration_thread_snapshot_failed",
                  error,
                );
              }),
            ),
          );
        }),
      )
      .handle(
        "threadBoundedSnapshot",
        Effect.fn("environment.orchestration.threadBoundedSnapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const principal = yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          const redact = yield* requireThreadReadable(principal.subject, args.params.threadId);
          const snapshot = yield* loadThreadSnapshotWindow(
            args.params.threadId,
            undefined,
            undefined,
            args.query.deferWork === "1",
          ).pipe(traceLocalHandlerWork);
          const bounded = buildBoundedThreadProjection({
            projection: snapshot.projection,
            snapshotSequence: snapshot.snapshotSequence,
          });
          // Redacted responses use the plain format: compaction relies on shared object identity.
          return redacted(redact, {
            snapshotSequence: snapshot.snapshotSequence,
            ...boundedSnapshotResponseFields({
              bounded,
              compactTurnItems: redact === null && args.query.compactTurnItems === "1",
              dedupeBodies: redact === null && args.query.dedupeBodies === "1",
              compactIds: redact === null && args.query.compactIds === "1",
            }),
          });
        }),
      )
      .handle(
        "threadHistoryPage",
        Effect.fn("environment.orchestration.threadHistoryPage")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const principal = yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          const redact = yield* requireThreadReadable(principal.subject, args.params.threadId);
          const decoded = yield* Effect.try(() =>
            decodeThreadHistoryCursor(args.query.cursor),
          ).pipe(Effect.result);
          if (Result.isFailure(decoded)) {
            const cause = decoded.failure.cause;
            if (cause instanceof InvalidThreadHistoryCursorError)
              return yield* failEnvironmentInvalidRequest("invalid_history_cursor");
            return yield* failEnvironmentInternal("orchestration_thread_history_failed", cause);
          }
          return yield* threadManagement
            .getThreadHistoryPage(
              args.params.threadId,
              args.query.cursor,
              args.query.throughEntryId,
              args.query.view === "conversation",
              args.query.view === "work"
                ? "work"
                : args.query.deferWork === "1"
                  ? "deferred"
                  : undefined,
            )
            .pipe(
              Effect.map((page) =>
                redacted(
                  redact,
                  args.query.compactIds === "1" && redact === null
                    ? { ...page, idTable: true as const }
                    : page,
                ),
              ),
              traceLocalHandlerWork,
              Effect.catch(
                Effect.fnUntraced(function* (cause) {
                  if (isThreadNotFound(cause))
                    return yield* failEnvironmentNotFound("thread_not_found");
                  return yield* failEnvironmentInternal(
                    "orchestration_thread_history_failed",
                    cause,
                  );
                }),
              ),
            );
        }),
      );
  }),
);
