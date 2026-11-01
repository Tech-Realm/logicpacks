import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { withHelperHooks } from "./hooks.ts";
import { loadConfig, queuedFiles } from "./store.ts";
import { readNewLines, syncTranscript } from "./sync.ts";

const tempDir = () => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lp-helper-test-"));

const claudeRecord = (uuid: string, text: string) =>
  `${JSON.stringify({
    type: "user",
    uuid,
    sessionId: "sess-1",
    cwd: "/nonexistent/repo",
    timestamp: "2026-10-31T10:00:00.000Z",
    message: { role: "user", content: text },
  })}\n`;

/** A stand-in host that records ingest bodies and answers with `reply`. */
const startHost = async (reply: (body: { events: Array<{ uid: string }> }) => unknown) => {
  const received: Array<{ events: Array<{ uid: string }> }> = [];
  const server = NodeHttp.createServer((request, response) => {
    let data = "";
    request.on("data", (chunk) => {
      data += chunk;
    });
    request.on("end", () => {
      const body = JSON.parse(data || "{}");
      received.push(body);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(reply(body)));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as NodeNet.AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    received,
    [Symbol.asyncDispose]: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};

describe("readNewLines", () => {
  it("leaves a half-written last line for the next pass", () => {
    const file = NodePath.join(tempDir(), "t.jsonl");
    NodeFS.writeFileSync(file, '{"a":1}\n{"b":');
    const first = readNewLines(file, 0);
    expect(first.lines.map((line) => line.text)).toEqual(['{"a":1}']);
    NodeFS.appendFileSync(file, "2}\n");
    const second = readNewLines(file, first.nextOffset);
    expect(second.lines).toEqual([{ offset: 8, text: '{"b":2}' }]);
  });
});

describe("syncTranscript", () => {
  it("queues while the host is down, resends in order, and holds unmatched sessions in place", async () => {
    process.env.LP_HELPER_HOME = tempDir();
    const file = NodePath.join(tempDir(), "sess-1.jsonl");
    NodeFS.writeFileSync(file, claudeRecord("u1", "first"));
    const offline = { ...loadConfig(), server: "http://127.0.0.1:9", token: "t" };
    expect((await syncTranscript(file, "claude", offline)).kind).toBe("queued");
    expect(queuedFiles()).toHaveLength(1);

    NodeFS.appendFileSync(file, claudeRecord("u2", "second"));
    await using host = await startHost(() => ({
      linked: true,
      projectId: "p",
      threadId: "external:claude:sess-1",
      accepted: 1,
      duplicates: 0,
    }));
    const online = { ...offline, server: host.url };
    const sent = await syncTranscript(file, "claude", online);
    expect(sent).toEqual({ kind: "sent", events: 1, threadId: "external:claude:sess-1" });
    expect(host.received.map((body) => body.events.map((event) => event.uid))).toEqual([
      ["u1"],
      ["u2"],
    ]);
    expect(queuedFiles()).toHaveLength(0);

    const other = NodePath.join(tempDir(), "sess-2.jsonl");
    NodeFS.writeFileSync(other, claudeRecord("v1", "private"));
    await using noProject = await startHost(() => ({
      linked: false,
      reason: "no_project",
      message: "No project.",
    }));
    const unmatchedConfig = { ...offline, server: noProject.url };
    expect((await syncTranscript(other, "claude", unmatchedConfig, 0)).kind).toBe("unmatched");
    // Within the retry window nothing is sent; after it, the same events are offered again.
    expect((await syncTranscript(other, "claude", unmatchedConfig, 1000)).kind).toBe("unmatched");
    expect(noProject.received).toHaveLength(1);
    await syncTranscript(other, "claude", unmatchedConfig, 10 * 60_000);
    expect(noProject.received.map((body) => body.events[0]?.uid)).toEqual(["v1", "v1"]);
  });
});

describe("withHelperHooks", () => {
  it("adds the helper's hooks once and removes only its own", () => {
    const user = {
      hooks: { Stop: [{ hooks: [{ type: "command", command: "say done" }] }] },
      model: "opus",
    };
    const installed = withHelperHooks(withHelperHooks(user, "/h/bin/lp"), "/h/bin/lp");
    const stop = (installed.hooks as Record<string, Array<unknown>>).Stop;
    expect(stop).toHaveLength(2);
    expect(Object.keys(installed.hooks as object).sort()).toEqual([
      "PostToolUse",
      "SessionStart",
      "Stop",
      "UserPromptSubmit",
    ]);
    expect(withHelperHooks(installed, null)).toEqual(user);
  });
});
