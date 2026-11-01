import { assert, describe, it } from "@effect/vitest";

import {
  LOGICPACKS_DEVICE_TOOL_INSTRUCTIONS,
  LOGICPACKS_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH,
  LOGICPACKS_ORCHESTRATION_INSTRUCTIONS,
  lpAcpPromptWithInstructions,
  lpOrchestrationPrompt,
  lpOrchestrationSystemPrompt,
} from "./orchestrationInstructions.ts";

describe("LogicPacks device instructions", () => {
  it("route device work through device_open and give Claude the line that loads the tools", () => {
    for (const intent of ["`device_list`", "`device_open`", "`agent-device`", "ssh", "`hostId`"]) {
      assert.include(LOGICPACKS_DEVICE_TOOL_INSTRUCTIONS, intent);
    }
    assert.notInclude(LOGICPACKS_DEVICE_TOOL_INSTRUCTIONS, "ToolSearch");
    const loadLine =
      " Load them with ToolSearch `select:mcp__logicpacks__device_list,mcp__logicpacks__device_open,mcp__logicpacks__device_screenshot,mcp__logicpacks__device_close`.";
    assert.include(LOGICPACKS_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH, loadLine);
    assert.equal(
      LOGICPACKS_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH.replace(loadLine, ""),
      LOGICPACKS_DEVICE_TOOL_INSTRUCTIONS,
    );
  });

  it("open the app before the returned command's snapshots, screenshots and input", () => {
    assert.include(
      LOGICPACKS_DEVICE_TOOL_INSTRUCTIONS,
      "its snapshots, screenshots and input need `open <app>` first,",
    );
  });

  it("keep the failure rule from taking over or closing a session another thread holds", () => {
    // agent-device's DEVICE_IN_USE advice is to rerun with the owner's --session or close it first.
    assert.include(
      LOGICPACKS_DEVICE_TOOL_INSTRUCTIONS,
      "follow its advice once, but never reuse or close another session; if it still fails,",
    );
  });

  it("reach OpenCode and Cursor only when the session holds device access", () => {
    assert.include(lpOrchestrationSystemPrompt(true, true), LOGICPACKS_DEVICE_TOOL_INSTRUCTIONS);
    assert.notInclude(lpOrchestrationSystemPrompt(true, false), "## LogicPacks devices");
    assert.isUndefined(lpOrchestrationSystemPrompt(false, true));

    const firstRun = (hasDeviceTools: boolean) =>
      lpOrchestrationPrompt({
        prompt: "Check the login screen.",
        hasLogicPacksMcp: true,
        hasDeviceTools,
        orchestrationDelivered: false,
        deviceInstructionsDelivered: false,
      });
    assert.include(firstRun(true), LOGICPACKS_DEVICE_TOOL_INSTRUCTIONS);
    assert.notInclude(firstRun(false), "## LogicPacks devices");

    const laterRun = (deviceInstructionsDelivered: boolean) =>
      lpOrchestrationPrompt({
        prompt: "Check the login screen.",
        hasLogicPacksMcp: true,
        hasDeviceTools: true,
        orchestrationDelivered: true,
        deviceInstructionsDelivered,
      });
    assert.include(laterRun(false), LOGICPACKS_DEVICE_TOOL_INSTRUCTIONS);
    assert.notInclude(laterRun(false), LOGICPACKS_ORCHESTRATION_INSTRUCTIONS.trim());
    assert.equal(laterRun(true), "Check the login screen.");
  });

  it("reach ACP agents again when device access changes mid-thread", () => {
    const state = {
      interactionMode: "default",
      hasLogicPacksMcp: true,
      hasDeviceTools: false,
    } as const;
    const withDevices = lpAcpPromptWithInstructions({
      prompt: "Check the login screen.",
      state: { ...state, hasDeviceTools: true },
      previousState: state,
    });
    assert.include(withDevices, LOGICPACKS_DEVICE_TOOL_INSTRUCTIONS);
    assert.equal(
      lpAcpPromptWithInstructions({ prompt: "Again.", state, previousState: state }),
      "Again.",
    );
    assert.notInclude(
      lpAcpPromptWithInstructions({ prompt: "Hi.", state }),
      "## LogicPacks devices",
    );
  });
});
