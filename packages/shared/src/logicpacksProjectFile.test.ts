import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  parseLogicPacksProjectFile,
  LogicPacksProjectFileFromJson,
} from "./logicpacksProjectFile.ts";

const decodeJson = Schema.decodeUnknownSync(LogicPacksProjectFileFromJson);

describe("LogicPacksProjectFileFromJson", () => {
  it("decodes lenient JSONC with comments and trailing commas", () => {
    const decoded = decodeJson(`{
      // team scripts
      "iconPath": "assets/logo.svg",
      "scripts": [
        { "name": "Dev", "command": "pnpm dev", },
      ],
    }`);

    expect(decoded.iconPath).toBe("assets/logo.svg");
    expect(decoded.scripts?.[0]).toEqual({ name: "Dev", command: "pnpm dev" });
  });
});

describe("parseLogicPacksProjectFile", () => {
  it("reads project defaults from JSONC with a URL in a block comment", () => {
    expect(
      parseLogicPacksProjectFile(`{
        /* See https://logicpacks.io/schema/logicpacks.json */
        "defaultThreadEnvMode": "worktree"
      }`),
    ).toEqual({ defaultThreadEnvMode: "worktree" });
  });
});
