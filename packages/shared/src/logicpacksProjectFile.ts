import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { LogicPacksProjectFile, LOGICPACKS_PROJECT_FILE_SCHEMA_URL } from "@logicpacks/contracts";

import { fromLenientJson } from "./schemaJson.ts";

export const LogicPacksProjectFileFromJson = fromLenientJson(LogicPacksProjectFile);

const decodeLogicPacksProjectFile = Schema.decodeExit(LogicPacksProjectFileFromJson);

export function parseLogicPacksProjectFile(contents: string): LogicPacksProjectFile | null {
  const decoded = decodeLogicPacksProjectFile(contents);
  return Exit.isSuccess(decoded) ? decoded.value : null;
}

export function buildLogicPacksProjectFileJsonSchema(): Record<string, unknown> {
  const document = Schema.toJsonSchemaDocument(LogicPacksProjectFile, {
    onExcessProperty: "error",
  });
  const jsonSchema: Record<string, unknown> = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: LOGICPACKS_PROJECT_FILE_SCHEMA_URL,
    ...document.schema,
  };
  if (document.definitions && Object.keys(document.definitions).length > 0) {
    jsonSchema.$defs = document.definitions;
  }
  return jsonSchema;
}
