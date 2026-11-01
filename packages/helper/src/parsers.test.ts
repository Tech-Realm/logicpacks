import { describe, expect, it } from "vite-plus/test";

import { parseClaudeLines } from "./claude.ts";
import { parseCodexLines } from "./codex.ts";
import { emptyParserState, type TranscriptLine } from "./events.ts";

const lines = (...records: ReadonlyArray<unknown>): Array<TranscriptLine> =>
  records.map((record, index) => ({ offset: index * 100, text: JSON.stringify(record) }));

describe("parseClaudeLines", () => {
  it("streams prompts, replies and tool calls, finishing a tool call from a later chunk", () => {
    const state = emptyParserState();
    const base = {
      sessionId: "s-1",
      cwd: "/repo",
      gitBranch: "main",
      timestamp: "2026-10-31T10:00:00.000Z",
    };
    const first = parseClaudeLines(
      lines(
        { ...base, type: "user", uuid: "u1", message: { role: "user", content: "Fix the build" } },
        {
          ...base,
          type: "user",
          uuid: "u0",
          message: { role: "user", content: "<command-name>/clear</command-name>" },
        },
        {
          ...base,
          type: "user",
          uuid: "m1",
          isMeta: true,
          message: { role: "user", content: "caveat" },
        },
        {
          ...base,
          type: "assistant",
          uuid: "side",
          isSidechain: true,
          message: { content: [{ type: "text", text: "subagent" }] },
        },
        {
          ...base,
          type: "assistant",
          uuid: "a1",
          message: {
            model: "claude-opus-5-5",
            content: [
              { type: "text", text: "Running the tests." },
              { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "npm test" } },
              { type: "tool_use", id: "toolu_2", name: "Edit", input: { file_path: "/repo/a.ts" } },
            ],
          },
        },
      ),
      state,
    );
    expect(first.map((event) => [event.uid, event.type, event.tool?.status])).toEqual([
      ["u1", "user", undefined],
      ["a1", "assistant", undefined],
      ["toolu_1", "tool", "running"],
      ["toolu_2", "tool", "running"],
    ]);
    expect(state.meta).toEqual({
      sessionId: "s-1",
      cwd: "/repo",
      model: "claude-opus-5-5",
      branch: "main",
    });

    const second = parseClaudeLines(
      lines({
        ...base,
        type: "user",
        uuid: "r1",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_1", content: "1 failing", is_error: true },
            {
              type: "tool_result",
              tool_use_id: "toolu_2",
              content: [{ type: "text", text: "ok" }],
            },
          ],
        },
      }),
      state,
    );
    expect(second.map((event) => event.tool)).toEqual([
      {
        name: "Bash",
        kind: "command",
        input: "npm test",
        files: [],
        status: "failed",
        output: "1 failing",
      },
      {
        name: "Edit",
        kind: "file_change",
        input: "/repo/a.ts",
        files: ["/repo/a.ts"],
        status: "completed",
        output: "ok",
      },
    ]);
    expect(state.pendingTools).toEqual({});
  });
});

describe("parseCodexLines", () => {
  const at = "2026-10-31T10:00:00.000Z";
  const item = (value: Record<string, unknown>) => ({
    timestamp: at,
    type: "event_msg",
    payload: { type: "item_completed", item: value },
  });

  it("reads current Codex item records and ignores legacy copies once it has seen them", () => {
    const state = emptyParserState();
    const events = parseCodexLines(
      lines(
        { timestamp: at, type: "session_meta", payload: { id: "019a-codex", cwd: "/repo" } },
        { timestamp: at, type: "turn_context", payload: { model: "gpt-6-astra", cwd: "/repo" } },
        {
          timestamp: at,
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "<environment_context>x</environment_context>" }],
          },
        },
        item({ type: "UserMessage", id: "um1", content: [{ type: "text", text: "Add a test" }] }),
        {
          timestamp: at,
          type: "event_msg",
          payload: { type: "user_message", message: "Add a test" },
        },
        item({ type: "Reasoning", id: "rs1" }),
        item({
          type: "CommandExecution",
          id: "exec-1",
          command: ["/bin/zsh", "-lc", "npm test"],
          aggregated_output: "boom",
          exit_code: 1,
        }),
        item({
          type: "FileChange",
          id: "exec-2",
          changes: { "/repo/a.test.ts": { type: "add" } },
          status: "completed",
        }),
        item({ type: "AgentMessage", id: "msg1", content: [{ type: "Text", text: "Added it." }] }),
      ),
      state,
    );
    expect(
      events.map((event) => [
        event.uid,
        event.type,
        event.text ?? event.tool?.input,
        event.tool?.status,
      ]),
    ).toEqual([
      ["um1", "user", "Add a test", undefined],
      ["exec-1", "tool", "npm test", "failed"],
      ["exec-2", "tool", "/repo/a.test.ts", "completed"],
      ["msg1", "assistant", "Added it.", undefined],
    ]);
    expect(state.meta.sessionId).toBe("019a-codex");
    expect(state.meta.model).toBe("gpt-6-astra");
  });

  it("reads older Codex event records", () => {
    const state = emptyParserState();
    const events = parseCodexLines(
      lines(
        { timestamp: at, type: "event_msg", payload: { type: "user_message", message: "hello" } },
        {
          timestamp: at,
          type: "event_msg",
          payload: {
            type: "exec_command_end",
            call_id: "c1",
            command: ["bash", "-lc", "ls"],
            exit_code: 0,
            stdout: "a",
          },
        },
        { timestamp: at, type: "event_msg", payload: { type: "agent_message", message: "done" } },
      ),
      state,
    );
    expect(events.map((event) => [event.uid, event.type])).toEqual([
      ["line:0", "user"],
      ["c1", "tool"],
      ["line:200", "assistant"],
    ]);
  });
});
