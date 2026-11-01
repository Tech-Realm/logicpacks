import {
  LOGICPACKS_PROJECT_FILE_NAME,
  type EnvironmentId,
  type LogicPacksProjectFile,
} from "@logicpacks/contracts";
import { parseLogicPacksProjectFile } from "@logicpacks/shared/logicpacksProjectFile";
import { executeAtomQuery } from "@logicpacks/client-runtime/state/runtime";

import {
  getProjectFileQueryAtom,
  resolveProjectFileQueryData,
} from "~/components/files/projectFilesQueryState";
import { appAtomRegistry } from "~/rpc/atomRegistry";

export async function readLogicPacksProjectFile(
  environmentId: EnvironmentId,
  workspaceRoot: string,
): Promise<LogicPacksProjectFile | null> {
  const result = await executeAtomQuery(
    appAtomRegistry,
    getProjectFileQueryAtom(environmentId, workspaceRoot, LOGICPACKS_PROJECT_FILE_NAME),
    { reportDefect: false, reportFailure: false },
  );
  const data = resolveProjectFileQueryData(
    environmentId,
    workspaceRoot,
    LOGICPACKS_PROJECT_FILE_NAME,
    result._tag === "Success" ? result.value : null,
  );
  if (data === null || data.exists === false || data.truncated) return null;
  return parseLogicPacksProjectFile(data.contents);
}
