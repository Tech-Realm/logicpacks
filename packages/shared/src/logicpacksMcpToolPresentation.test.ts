import { describe, expect, it } from "vite-plus/test";

import {
  LOGICPACKS_MCP_TOOL_NAMES,
  resolveLogicPacksMcpSummaryAction,
  resolveLogicPacksMcpToolDefinition,
  resolveLogicPacksMcpToolPresentation,
} from "./logicpacksMcpToolPresentation.ts";

describe("resolveLogicPacksMcpToolPresentation", () => {
  it("recognizes every LogicPacks tool across provider prefixes and completion suffixes", () => {
    for (const tool of LOGICPACKS_MCP_TOOL_NAMES) {
      const presentation = resolveLogicPacksMcpToolPresentation(tool);
      for (const prefix of [
        "mcp__logicpacks__",
        "logicpacks/",
        "logicpacks:",
        "mcp_logicpacks_",
        "LogicPacks ",
        "logicpacks · ",
      ]) {
        expect(resolveLogicPacksMcpToolPresentation(`${prefix}${tool} completed`), tool).toEqual(
          presentation,
        );
      }
      expect(resolveLogicPacksMcpToolPresentation(`mcp__another-server__${tool}`), tool).toBeNull();
    }
  });

  it("matches OpenCode 2's per-thread server names, whose thread ids hold underscores", () => {
    expect(
      resolveLogicPacksMcpToolPresentation("logicpacks-thread_opencode2-adapter_delegate_task")
        ?.displayName,
    ).toBe("Delegate a child task");
    expect(
      resolveLogicPacksMcpToolPresentation("logicpacks-thread_opencode2-adapter_not_a_tool"),
    ).toBeNull();
  });
});

describe("resolveLogicPacksMcpToolDefinition", () => {
  it("labels an action tool call as the action it ran", () => {
    expect(
      resolveLogicPacksMcpToolDefinition("mcp__logicpacks__preview_act", { action: "type" })
        ?.labels,
    ).toEqual(resolveLogicPacksMcpToolDefinition("preview_type")?.labels);
    expect(
      resolveLogicPacksMcpToolDefinition("lp_thread_transfer", { action: "fork" })?.displayName,
    ).toBe(resolveLogicPacksMcpToolDefinition("lp_thread_fork")?.displayName);
    expect(
      resolveLogicPacksMcpToolDefinition("preview_act", { action: "unknown" })?.labels[2],
    ).toBe("Used");
  });
});

describe("resolveLogicPacksMcpSummaryAction", () => {
  it("summarizes an action tool by the action each call ran", () => {
    expect(resolveLogicPacksMcpSummaryAction("mcp__logicpacks__lp_queue", { action: "list" })).toBe(
      "queue-list",
    );
    expect(resolveLogicPacksMcpSummaryAction("lp_queue", { action: "edit" })).toBe("queue-edit");
    expect(resolveLogicPacksMcpSummaryAction("lp_thread_transfer", { action: "status" })).toBe(
      "thread-transfers",
    );
    expect(resolveLogicPacksMcpSummaryAction("lp_thread_configure", {})).toBe(
      "thread-configuration",
    );
    expect(resolveLogicPacksMcpSummaryAction("schedule_task", { scheduledTaskId: "task-1" })).toBe(
      "schedule-update",
    );
    expect(resolveLogicPacksMcpSummaryAction("delegate_task", { task: "x" })).toBe("delegate");
  });
});
