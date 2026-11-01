import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { LOGICPACKS_PROJECT_FILE_NAME, type LogicPacksProjectFile } from "@logicpacks/contracts";
import { LogicPacksProjectFileFromJson } from "@logicpacks/shared/logicpacksProjectFile";

const decodeLogicPacksProjectFileJson = Schema.decodeEffect(LogicPacksProjectFileFromJson);

export class LogicPacksProjectFileLoadError extends Schema.TaggedError<LogicPacksProjectFileLoadError>()(
  "LogicPacksProjectFileLoadError",
  {
    operation: Schema.Literals(["read", "decode"]),
    workspaceRoot: Schema.String,
    filePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} ${LOGICPACKS_PROJECT_FILE_NAME} at ${this.filePath}.`;
  }
}

export class LogicPacksProjectFileLoader extends Context.Service<
  LogicPacksProjectFileLoader,
  {
    /** Never fails; missing/unreadable/invalid files return none, with warnings for invalid files. */
    readonly load: (workspaceRoot: string) => Effect.Effect<Option.Option<LogicPacksProjectFile>>;
  }
>()("logicpacks/project/LogicPacksProjectFileLoader") {}

const logLogicPacksProjectFileLoadError = (error: LogicPacksProjectFileLoadError) =>
  Effect.logWarning(error).pipe(
    Effect.annotateLogs({
      operation: error.operation,
      workspaceRoot: error.workspaceRoot,
      filePath: error.filePath,
      errorTag: error._tag,
    }),
  );

/** @public */
export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const load: LogicPacksProjectFileLoader["Service"]["load"] = Effect.fn(
    "LogicPacksProjectFileLoader.load",
  )(function* (workspaceRoot) {
    const filePath = path.join(workspaceRoot, LOGICPACKS_PROJECT_FILE_NAME);
    const raw = yield* fileSystem.readFileString(filePath).pipe(
      Effect.asSome,
      Effect.catchTags({
        PlatformError: (error) =>
          error.reason._tag === "NotFound"
            ? Effect.succeed(Option.none<string>())
            : logLogicPacksProjectFileLoadError(
                new LogicPacksProjectFileLoadError({
                  operation: "read",
                  workspaceRoot,
                  filePath,
                  cause: error,
                }),
              ).pipe(Effect.as(Option.none<string>())),
      }),
    );
    if (Option.isNone(raw)) {
      return Option.none<LogicPacksProjectFile>();
    }
    return yield* decodeLogicPacksProjectFileJson(raw.value).pipe(
      Effect.asSome,
      Effect.catchTags({
        SchemaError: (error) =>
          logLogicPacksProjectFileLoadError(
            new LogicPacksProjectFileLoadError({
              operation: "decode",
              workspaceRoot,
              filePath,
              cause: error,
            }),
          ).pipe(Effect.as(Option.none<LogicPacksProjectFile>())),
      }),
    );
  });

  return LogicPacksProjectFileLoader.of({ load });
});

export const layer = Layer.effect(LogicPacksProjectFileLoader, make);
