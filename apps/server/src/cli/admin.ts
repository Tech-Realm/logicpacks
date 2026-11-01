import { CommandId, ProjectId, ProviderInstanceId } from "@logicpacks/contracts";
import * as Console from "effect/Console";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import { Argument, Command, Flag, GlobalFlag } from "effect/cli";
import * as CliError from "effect/cli/CliError";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ExpertsService from "../logicpacks/ExpertsService.ts";
import * as ExternalTeamService from "../logicpacks/ExternalTeamService.ts";
import * as LogicPacksAccess from "../logicpacks/LogicPacksAccess.ts";
import {
  deleteAllMembers,
  deleteMember,
  formatMemberDeletion,
  hostFailure,
  type MemberDeletionHost,
} from "../logicpacks/deleteMember.ts";
import { canManageSandboxUsers, systemSandboxOs } from "../logicpacks/memberSandbox.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerOwnership from "../serverOwnership.ts";
import { clearPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import * as ServerSettings from "../serverSettings.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";
import { layerProjectCliRuntime } from "./project.ts";

class AdminUsageError extends CliError.UserError {}

const deleteUserCommand = Command.make("delete-user", {
  ...projectLocationFlags,
  email: Argument.String("email").pipe(
    Argument.withDescription("The member's email."),
    Argument.optional,
  ),
  userId: Flag.String("user-id").pipe(
    Flag.withDescription(
      "Delete by user id instead; also cleans up leftovers (files, Unix user, secrets) of an account row already gone.",
    ),
    Flag.optional,
  ),
  allMembers: Flag.Boolean("all-members").pipe(
    Flag.withDescription("Delete every member except staff and --keep emails."),
    Flag.withDefault(false),
  ),
  keep: Flag.String("keep").pipe(
    Flag.withDescription("An email never to delete (repeatable), on top of staff."),
    Flag.atLeast(0),
  ),
  dryRun: Flag.Boolean("dry-run").pipe(
    Flag.withDescription("Print what would be deleted and change nothing."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription(
    "Delete member accounts everywhere: rows, sessions, their own workspaces and projects, logins, secrets, sandbox user. Run with the service stopped.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const targets =
        (flags.allMembers ? 1 : 0) +
        (Option.isSome(flags.email) ? 1 : 0) +
        (Option.isSome(flags.userId) ? 1 : 0);
      if (targets !== 1) {
        return yield* new AdminUsageError({
          cause: "Name exactly one of: <email>, --user-id <id>, --all-members.",
        });
      }
      const logLevel = yield* GlobalFlag.LogLevel;
      const config = yield* resolveCliAuthConfig(flags, logLevel, { quietLogs: true });

      // Never write behind a running server: this takes the same lock the server holds.
      yield* ServerOwnership.acquireServerOwnership(config.serverRuntimeStatePath).pipe(
        Effect.provide(ProcessRunner.layer),
      );
      yield* clearPersistedServerRuntimeState(config.serverRuntimeStatePath);

      const layer = Layer.mergeAll(
        LogicPacksAccess.layer,
        ExpertsService.layer,
        ExternalTeamService.layer,
        ServerSecretStore.layer,
      ).pipe(
        Layer.provideMerge(layerProjectCliRuntime),
        Layer.provide(ServerConfig.layer(config)),
        Layer.provide(Layer.succeed(References.MinimumLogLevel, "Error")),
      );

      yield* Effect.gen(function* () {
        const projects = yield* ProjectService.ProjectService;
        const settings = yield* ServerSettings.ServerSettingsService;
        const secrets = yield* ServerSecretStore.ServerSecretStore;
        const crypto = yield* Crypto.Crypto;
        const host: MemberDeletionHost = {
          baseDir: config.baseDir,
          stateDir: config.stateDir,
          secretsDir: config.secretsDir,
          worktreesDir: config.worktreesDir,
          getProject: (projectId) =>
            projects.getById(ProjectId.make(projectId)).pipe(
              Effect.map((found) =>
                Option.isSome(found) && found.value.deletedAt === null
                  ? { title: found.value.title, workspaceRoot: found.value.workspaceRoot }
                  : null,
              ),
              Effect.mapError(hostFailure(`reading project ${projectId}`)),
            ),
          deleteProject: Effect.fn("admin.deleteProject")(
            function* (projectId: string) {
              const commandId = CommandId.make(yield* crypto.randomUUIDv4());
              yield* projects.delete({
                commandId,
                projectId: ProjectId.make(projectId),
                force: true,
              });
            },
            Effect.mapError(hostFailure("deleting a project")),
          ),
          providerInstanceIds: settings.getSettings.pipe(
            Effect.map((current) => Object.keys(current.providerInstances ?? {})),
            Effect.mapError(hostFailure("reading settings.json")),
          ),
          removeProviderInstance: (instanceId) =>
            settings
              .updateProviderInstance({
                operation: "remove",
                instanceId: ProviderInstanceId.make(instanceId),
              } as Parameters<typeof settings.updateProviderInstance>[0])
              .pipe(Effect.asVoid, Effect.mapError(hostFailure(`removing ${instanceId}`))),
          removeSecret: (name) =>
            secrets.remove(name).pipe(Effect.mapError(hostFailure(`removing secret ${name}`))),
          os: systemSandboxOs,
          manageUnixUsers: canManageSandboxUsers(process.env, systemSandboxOs),
          protectedEmails: flags.keep,
        };

        if (flags.allMembers) {
          const result = yield* deleteAllMembers(host, { dryRun: flags.dryRun });
          for (const report of result.reports)
            yield* Console.log(formatMemberDeletion(report) + "\n");
          if (result.spared.length > 0) {
            yield* Console.log(`kept (staff or --keep): ${result.spared.join(", ")}`);
          }
          yield* Console.log(
            `${flags.dryRun ? "[dry run] would delete" : "deleted"} ${result.reports.length} member(s); ` +
              `${result.reports.filter((report) => report.failed.length > 0).length} with failures.`,
          );
          if (result.reports.some((report) => report.failed.length > 0)) process.exitCode = 1;
          return;
        }
        const report = yield* deleteMember(
          host,
          Option.isSome(flags.email)
            ? { email: flags.email.value }
            : { userId: Option.getOrThrow(flags.userId) },
          { dryRun: flags.dryRun },
        );
        yield* Console.log(formatMemberDeletion(report));
        if (report.failed.length > 0) process.exitCode = 1;
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped),
  ),
);

export const adminCommand = Command.make("admin").pipe(
  Command.withDescription("Host administration (run with the service stopped)."),
  Command.withSubcommands([deleteUserCommand]),
);
