import {
  LOGICPACKS_PROJECT_FILE_NAME,
  type EnvironmentId,
  type LogicPacksProjectFile,
  type LogicPacksProjectFileScript,
} from "@logicpacks/contracts";
import { parseLogicPacksProjectFile } from "@logicpacks/shared/logicpacksProjectFile";

import { useProjectFileQuery } from "~/components/files/projectFilesQueryState";

const NO_SCRIPTS: ReadonlyArray<LogicPacksProjectFileScript> = [];

export interface LogicPacksProjectFileState {
  status: "loading" | "missing" | "invalid" | "valid";
  file: LogicPacksProjectFile | null;
  scripts: ReadonlyArray<LogicPacksProjectFileScript>;
}

export function useLogicPacksProjectFileState(
  environmentId: EnvironmentId,
  cwd: string | null,
): LogicPacksProjectFileState {
  const query = useProjectFileQuery(
    environmentId,
    cwd ?? "",
    LOGICPACKS_PROJECT_FILE_NAME,
    cwd !== null,
  );
  const contents = query.data && !query.data.truncated ? query.data.contents : null;
  const isPending = query.isPending;
  if (contents === null) {
    return {
      status: isPending ? "loading" : "missing",
      file: null,
      scripts: NO_SCRIPTS,
    } as const;
  }
  const file = parseLogicPacksProjectFile(contents);
  if (file === null) {
    return { status: "invalid", file: null, scripts: NO_SCRIPTS } as const;
  }
  return { status: "valid", file, scripts: file.scripts ?? NO_SCRIPTS } as const;
}

export function useLogicPacksProjectFileScripts(
  environmentId: EnvironmentId,
  cwd: string | null,
): ReadonlyArray<LogicPacksProjectFileScript> {
  return useLogicPacksProjectFileState(environmentId, cwd).scripts;
}
