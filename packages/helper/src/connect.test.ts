import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { callHost } from "./client.ts";
import {
  agentSessionId,
  type Context,
  detectHarness,
  emit,
  loginCommand,
  parseArgs,
  parseMilestone,
  setupBlockCommand,
  setupCommand,
  setupPromptCommand,
} from "./connect.ts";
import { globalBlockBody, renderSetupGuide, setupPrompt } from "./connectText.ts";
import {
  MARKDOWN_MARKERS,
  OWN_FILE_MARK,
  withMarkedBlock,
  withYamlRead,
  YAML_MARKERS,
} from "./globalBlock.ts";
import { findHarness, HARNESSES, resolveOsPath } from "./harnesses.ts";
import { formatAgents, formatInbox, type InboxItem, nextCommands } from "./inbox.ts";
import {
  beginFileSession,
  describeBackups,
  describeSession,
  endFileSession,
  unifiedDiff,
} from "./fileOps.ts";
import { runSetup, runUninstall } from "./setup.ts";
import type { HelperConfig } from "./store.ts";

const tempDir = () => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lp-connect-test-"));

describe("the marked block", () => {
  const originals = [
    "",
    "# Mine\n",
    "# Mine",
    "# Mine\n\n",
    "line one\r\nline two\r\n",
    "no newline at all, CRLF elsewhere\r\nend",
    "<!-- other:start -->\nkeep\n<!-- other:end -->\n",
  ];

  const cases = [MARKDOWN_MARKERS, YAML_MARKERS].flatMap((markers) =>
    originals.map((original) => ({ markers, original })),
  );

  it.each(cases)(
    "adds, is idempotent and removes byte for byte ($markers.start)",
    ({ markers, original }) => {
      const added = withMarkedBlock(original, "body line", markers);
      expect(added.startsWith(original)).toBe(true);
      expect(added).toContain(`${markers.start}\nbody line\n${markers.end}\n`);
      expect(withMarkedBlock(added, "body line", markers)).toBe(added);
      const updated = withMarkedBlock(added, "new body", markers);
      expect(updated).toContain("new body");
      expect(updated).not.toContain("body line");
      expect(withMarkedBlock(updated, null, markers)).toBe(original);
    },
  );

  it("keeps text the user added after the block", () => {
    const added = withMarkedBlock("top\n", "b", MARKDOWN_MARKERS);
    const edited = `${added}after\n`;
    expect(withMarkedBlock(edited, null, MARKDOWN_MARKERS)).toBe("top\nafter\n");
  });

  it("adds a read: entry to an Aider config and refuses a second read: key", () => {
    const original = "model: sonnet\nauto-commits: false\n";
    const added = withYamlRead(original, "/home/a/.logicpacks/rules/logicpacks.md");
    expect(added).toContain('read: ["/home/a/.logicpacks/rules/logicpacks.md"]');
    expect(withYamlRead(added, "/home/a/.logicpacks/rules/logicpacks.md")).toBe(added);
    expect(withYamlRead(added, null)).toBe(original);
    expect(() => withYamlRead("read: [CONVENTIONS.md]\n", "/x.md")).toThrow(/read: list/);
  });
});

describe("the harness registry", () => {
  const unix = { platform: "linux" as const, home: "/home/a", env: {} };
  const win = { platform: "win32" as const, home: "C:\\Users\\A B", env: {} };

  it("has an id, a name and docs for every harness, with unique ids", () => {
    expect(new Set(HARNESSES.map((harness) => harness.id)).size).toBe(HARNESSES.length);
    for (const harness of HARNESSES) {
      expect(harness.name.length).toBeGreaterThan(0);
      expect(harness.docs.length).toBeGreaterThan(0);
    }
  });

  it("resolves paths per OS, with spaces and environment overrides", () => {
    const claude = findHarness("claude-code")!;
    if (claude.global.kind !== "block") throw new Error("claude is a block target");
    expect(resolveOsPath(claude.global.path, unix)).toBe("/home/a/.claude/CLAUDE.md");
    expect(resolveOsPath(claude.global.path, win)).toBe("C:\\Users\\A B\\.claude\\CLAUDE.md");
    expect(
      resolveOsPath(claude.global.path, { ...unix, env: { CLAUDE_CONFIG_DIR: "/tmp/cc" } }),
    ).toBe("/tmp/cc/CLAUDE.md");
    const codex = findHarness("codex")!;
    if (codex.global.kind !== "block") throw new Error("codex is a block target");
    expect(resolveOsPath(codex.global.path, win)).toBe("C:\\Users\\A B\\.codex\\AGENTS.md");
    expect(resolveOsPath(codex.global.path, { ...unix, env: { CODEX_HOME: "/c/" } })).toBe(
      "/c/AGENTS.md",
    );
  });

  it("knows the aliases people use", () => {
    expect(findHarness("commandAI")?.id).toBe("command-code");
    expect(findHarness("GLM")?.id).toBe("zai");
    expect(findHarness("vscode")?.id).toBe("copilot");
    expect(findHarness("nope")).toBeNull();
  });
});

describe("lp setup and lp uninstall", () => {
  let home: string;
  let project: string;
  const saved = { ...process.env };

  beforeEach(() => {
    home = tempDir();
    project = NodePath.join(home, "my project");
    NodeFS.mkdirSync(project);
    process.env.LP_HELPER_HOME = NodePath.join(home, ".logicpacks", "helper");
  });
  afterEach(() => {
    process.env = { ...saved };
    NodeFS.rmSync(home, { recursive: true, force: true });
  });

  const setup = (agent: string, extra: { file?: string; project?: boolean } = {}) =>
    runSetup({ agent, cwd: project, home, platform: "linux", env: {}, ...extra });

  it("writes every harness's target, is idempotent, and uninstall restores every file byte for byte", () => {
    // Existing content in a few targets, to prove it survives.
    const existing: Record<string, string> = {
      [NodePath.join(home, ".claude/CLAUDE.md")]: "# My rules\r\nBe brief.",
      [NodePath.join(home, ".codex/AGENTS.md")]: "codex rules\n",
      [NodePath.join(home, ".aider.conf.yml")]: "model: sonnet\n",
      [NodePath.join(project, "AGENTS.md")]: "# Team\n\nUse pnpm.\n",
    };
    for (const [file, text] of Object.entries(existing)) {
      NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
      NodeFS.writeFileSync(file, text);
    }
    const written = new Set<string>();
    for (const harness of HARNESSES) {
      const result = setup(harness.id);
      for (const change of result.changes) {
        written.add(change.file);
        const text = NodeFS.readFileSync(change.file, "utf8");
        expect(
          text.includes(MARKDOWN_MARKERS.start) ||
            text.includes(OWN_FILE_MARK) ||
            text.includes(YAML_MARKERS.start),
        ).toBe(true);
      }
      if (harness.global.kind === "ui") expect(result.steps.length).toBeGreaterThan(0);
      // Twice changes nothing.
      expect(setup(harness.id).changes.every((change) => change.outcome === "unchanged")).toBe(
        true,
      );
    }
    expect(written.has(NodePath.join(home, ".claude/CLAUDE.md"))).toBe(true);
    expect(written.has(NodePath.join(home, ".gemini/GEMINI.md"))).toBe(true);
    expect(written.has(NodePath.join(home, "Documents/Cline/Rules/logicpacks.md"))).toBe(true);
    expect(written.has(NodePath.join(project, ".cursor/rules/logicpacks.mdc"))).toBe(true);
    const mdc = NodeFS.readFileSync(NodePath.join(project, ".cursor/rules/logicpacks.mdc"), "utf8");
    expect(mdc.startsWith("---\ndescription:")).toBe(true);
    expect(mdc).toContain("alwaysApply: true");
    expect(NodeFS.readFileSync(NodePath.join(home, ".aider.conf.yml"), "utf8")).toContain(
      "read: [",
    );

    runUninstall();
    for (const [file, text] of Object.entries(existing)) {
      expect(NodeFS.readFileSync(file, "utf8")).toBe(text);
    }
    for (const file of written) {
      if (!(file in existing)) expect(NodeFS.existsSync(file)).toBe(false);
    }
  });

  it("generic writes only the file it is given (a temp file standing in for Hermes)", () => {
    const file = NodePath.join(home, "hermes stand-in", "AGENTS.md");
    NodeFS.mkdirSync(NodePath.dirname(file));
    NodeFS.writeFileSync(file, "persona\n");
    const before = NodeFS.readdirSync(home, { recursive: true }).length;
    setup("generic", { file });
    expect(NodeFS.readFileSync(file, "utf8")).toContain(globalBlockBody());
    // Only that file changed (plus the helper's own state).
    const after = (NodeFS.readdirSync(home, { recursive: true }) as Array<string>).filter(
      (entry) => !entry.startsWith(".logicpacks") && !entry.includes(".lp-backup-"),
    );
    expect(after.length).toBeLessThanOrEqual(before);
    runUninstall("generic");
    expect(NodeFS.readFileSync(file, "utf8")).toBe("persona\n");
  });

  it("refuses to overwrite a rules file that is not ours", () => {
    const file = NodePath.join(home, ".roo/rules/logicpacks.md");
    NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
    NodeFS.writeFileSync(file, "someone else's\n");
    expect(() => setup("roo")).toThrow(/not LogicPacks/);
    expect(NodeFS.readFileSync(file, "utf8")).toBe("someone else's\n");
  });
});

describe("safe by default: dry run, backups, markers, parent folders", () => {
  let home: string;
  let project: string;
  const saved = { ...process.env };

  beforeEach(() => {
    home = tempDir();
    project = NodePath.join(home, "work", "shop");
    NodeFS.mkdirSync(project, { recursive: true });
    process.env.LP_HELPER_HOME = NodePath.join(home, ".logicpacks", "helper");
  });
  afterEach(() => {
    endFileSession();
    process.env = { ...saved };
    NodeFS.rmSync(home, { recursive: true, force: true });
  });

  const setup = (agent: string, extra: { file?: string; project?: boolean } = {}) =>
    runSetup({ agent, cwd: project, home, platform: "linux", env: {}, ...extra });

  const claudeFile = () => NodePath.join(home, ".claude", "CLAUDE.md");

  it("keeps every byte outside the markers, including the user's own rules sections", () => {
    const top = "# My rules\r\n\r\n## Style\r\n- Be brief.\r\n- No emoji.\r\n\r\n";
    const bottom =
      "\r\n## Work rules\r\nNever push to main.\r\n<!-- other-tool:start -->\r\nx\r\n<!-- other-tool:end -->\r\n";
    NodeFS.mkdirSync(NodePath.dirname(claudeFile()), { recursive: true });
    const withOld = `${top}${MARKDOWN_MARKERS.start}\nold body\n${MARKDOWN_MARKERS.end}${bottom}`;
    NodeFS.writeFileSync(claudeFile(), withOld);
    setup("claude");
    const after = NodeFS.readFileSync(claudeFile(), "utf8");
    const start = after.indexOf(MARKDOWN_MARKERS.start);
    const end = after.indexOf(MARKDOWN_MARKERS.end) + MARKDOWN_MARKERS.end.length;
    expect(after.slice(0, start)).toBe(top);
    expect(after.slice(end)).toBe(bottom);
    expect(after.slice(start, end)).toContain(globalBlockBody());
    // Appending to a file without a block keeps all of it as a prefix.
    const plain = `${top}${bottom}`;
    NodeFS.writeFileSync(claudeFile(), plain);
    setup("claude");
    expect(NodeFS.readFileSync(claudeFile(), "utf8").startsWith(plain)).toBe(true);
    runUninstall("claude");
    expect(NodeFS.readFileSync(claudeFile(), "utf8")).toBe(plain);
  });

  it.each([
    ["a lone start marker", `a\n${MARKDOWN_MARKERS.start}\nb\n`],
    ["a lone end marker", `a\n${MARKDOWN_MARKERS.end}\n`],
    [
      "two blocks",
      `${MARKDOWN_MARKERS.start}\n1\n${MARKDOWN_MARKERS.end}\n${MARKDOWN_MARKERS.start}\n2\n${MARKDOWN_MARKERS.end}\n`,
    ],
    ["end before start", `${MARKDOWN_MARKERS.end}\nx\n${MARKDOWN_MARKERS.start}\n`],
  ])("refuses to write a file with %s, and changes nothing", (_, text) => {
    NodeFS.mkdirSync(NodePath.dirname(claudeFile()), { recursive: true });
    NodeFS.writeFileSync(claudeFile(), text);
    expect(() => setup("claude")).toThrow(/unbalanced LogicPacks markers/);
    expect(NodeFS.readFileSync(claudeFile(), "utf8")).toBe(text);
    expect(NodeFS.readdirSync(NodePath.dirname(claudeFile()))).toEqual(["CLAUDE.md"]);
  });

  it("--dry-run prints the exact unified diff and writes nothing", () => {
    NodeFS.mkdirSync(NodePath.dirname(claudeFile()), { recursive: true });
    NodeFS.writeFileSync(claudeFile(), "# Mine\nkeep me\n");
    beginFileSession(true);
    setup("claude");
    const session = endFileSession()!;
    expect(NodeFS.readFileSync(claudeFile(), "utf8")).toBe("# Mine\nkeep me\n");
    expect(NodeFS.existsSync(NodePath.join(home, ".logicpacks", "helper", "setup.json"))).toBe(
      false,
    );
    const diff = describeSession(session);
    expect(diff).toContain(`--- ${claudeFile()}`);
    expect(diff).toContain(`+++ ${claudeFile()}`);
    expect(diff).toContain("@@ -1,2 +1,");
    expect(diff).toContain(" # Mine\n keep me\n+\n+<!-- logicpacks:start -->");
    expect(diff).toContain("+<!-- logicpacks:end -->");
    // A new file diffs against /dev/null.
    beginFileSession(true);
    setup("gemini");
    expect(describeSession(endFileSession()!)).toContain("--- /dev/null");
  });

  it("backs up each file before it changes and lists the backups", () => {
    NodeFS.mkdirSync(NodePath.dirname(claudeFile()), { recursive: true });
    NodeFS.writeFileSync(claudeFile(), "# Mine\n");
    beginFileSession(false, new Date(2026, 10, 1, 9, 5, 7));
    setup("claude");
    const session = endFileSession()!;
    const backup = `${claudeFile()}.lp-backup-20261101-090507`;
    expect(session.backups).toEqual([backup]);
    expect(NodeFS.readFileSync(backup, "utf8")).toBe("# Mine\n");
    expect(describeBackups(session)).toContain(backup);
    // A file that did not exist has nothing to back up.
    beginFileSession(false);
    setup("gemini");
    expect(endFileSession()!.backups).toEqual([]);
  });

  it("never writes an instructions file in a folder above the project", () => {
    // The project lives under a home folder whose .claude/CLAUDE.md is not this harness's file.
    const otherHome = NodePath.join(home, "work");
    const parentFile = NodePath.join(otherHome, ".claude", "CLAUDE.md");
    NodeFS.mkdirSync(NodePath.dirname(parentFile), { recursive: true });
    NodeFS.writeFileSync(parentFile, "real rules\n");
    expect(() => setup("claude", { file: parentFile })).toThrow(/folder above/);
    expect(() => setup("generic", { file: NodePath.join(otherHome, "AGENTS.md") })).toThrow(
      /folder above/,
    );
    expect(NodeFS.readFileSync(parentFile, "utf8")).toBe("real rules\n");
    // The resolved global file and files inside the project are fine.
    expect(() => setup("claude", { file: claudeFile() })).not.toThrow();
    expect(() =>
      setup("generic", { file: NodePath.join(project, "notes", "rules.md") }),
    ).not.toThrow();
  });

  it("lp setup without --yes shows the diff and writes nothing; --yes writes and lists backups", () => {
    NodeFS.mkdirSync(NodePath.dirname(claudeFile()), { recursive: true });
    NodeFS.writeFileSync(claudeFile(), "# Mine\n");
    let config = { device: "test" } as unknown as HelperConfig;
    const ctx = {
      cwd: project,
      home,
      env: {},
      loadConfig: () => config,
      saveConfig: (next: HelperConfig) => {
        config = next;
      },
    } as unknown as Context;
    const shown = setupCommand(ctx, parseArgs(["setup", "--agent", "claude"]));
    expect(shown.text).toContain("nothing written yet");
    expect(shown.text).toContain("+<!-- logicpacks:start -->");
    expect(shown.text).toContain("lp setup --agent claude --yes");
    expect(NodeFS.readFileSync(claudeFile(), "utf8")).toBe("# Mine\n");
    const applied = setupCommand(ctx, parseArgs(["setup", "--agent", "claude", "--yes"]));
    expect(applied.text).toContain("added the LogicPacks block to");
    expect(applied.text).toMatch(/CLAUDE\.md\.lp-backup-\d{8}-\d{6}/);
    expect(NodeFS.readFileSync(claudeFile(), "utf8")).toContain(MARKDOWN_MARKERS.start);
  });
});

describe("unified diff", () => {
  it("prints hunks with context like diff -u", () => {
    const before = ["a", "b", "c", "d", "e", "f", "g", "h"].join("\n") + "\n";
    const after = ["a", "b", "c", "D", "e", "f", "g", "h", "i"].join("\n") + "\n";
    expect(unifiedDiff({ file: "/x", before, after })).toBe(
      [
        "--- /x",
        "+++ /x",
        "@@ -1,8 +1,9 @@",
        " a",
        " b",
        " c",
        "-d",
        "+D",
        " e",
        " f",
        " g",
        " h",
        "+i",
      ].join("\n"),
    );
    expect(unifiedDiff({ file: "/x", before: "keep\n", after: null })).toBe(
      ["--- /x", "+++ /dev/null", "@@ -1,1 +0,0 @@", "-keep"].join("\n"),
    );
  });
});

describe("the block and the prompt", () => {
  it("keeps the global block short and maps the intents", () => {
    const lines = globalBlockBody().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(15);
    expect(lines.length).toBeLessThanOrEqual(25);
    const text = lines.join("\n");
    for (const command of [
      "lp share",
      "lp invite",
      "lp assist request",
      "lp goals plan",
      "lp who",
      "lp send",
      "lp ask",
      "lp reply",
      "lp inbox",
    ]) {
      expect(text).toContain(command);
    }
    expect(text).not.toMatch(/\u2014/);
  });

  it("has a 3 to 6 line prompt, and setup.md lists every harness", () => {
    for (const variant of ["new", "installed"] as const) {
      const lines = setupPrompt(variant).split("\n");
      expect(lines.length).toBeGreaterThanOrEqual(3);
      expect(lines.length).toBeLessThanOrEqual(6);
    }
    const guide = renderSetupGuide();
    for (const harness of HARNESSES) expect(guide).toContain(`\`${harness.id}\``);
    expect(guide).toContain("helper.sh");
    expect(guide).toContain("helper.ps1");
    expect(guide).not.toMatch(/\u2014/);
  });

  it("server's generated setup.md matches the helper's source", async () => {
    const generated = await import("../../../apps/server/src/logicpacks/connectSetup.generated.ts");
    expect(generated.SETUP_GUIDE_MARKDOWN).toBe(renderSetupGuide());
    expect(generated.SETUP_PROMPT).toBe(setupPrompt("new"));
  });
});

describe("argument parsing and --json", () => {
  it("parses commands, positionals, value flags and boolean flags", () => {
    const parsed = parseArgs(["ask", "Omar", "is the API done?", "--project", "Shop", "--json"]);
    expect(parsed.command).toBe("ask");
    expect(parsed.positionals).toEqual(["Omar", "is the API done?"]);
    expect(parsed.flags.get("project")).toBe("Shop");
    expect(parsed.flags.get("json")).toBe(true);
    expect(parseArgs(["inbox", "--json", "extra"]).positionals).toEqual(["extra"]);
    expect(parseArgs(["setup", "--agent", "claude", "--project"]).flags.get("project")).toBe(true);
    expect(parseArgs(["login", "--host=https://x"]).flags.get("host")).toBe("https://x");
    expect(parseArgs([]).command).toBe("help");
  });

  it("prints text, or JSON with --json", () => {
    const printed: Array<string> = [];
    const ctx = { print: (line: string) => printed.push(line) } as unknown as Context;
    emit(
      ctx,
      parseArgs(["setup-prompt", "--json"]),
      setupPromptCommand(parseArgs(["setup-prompt"])),
    );
    expect(JSON.parse(printed[0]!)).toEqual({ prompt: setupPrompt("new") });
    emit(ctx, parseArgs(["setup-block"]), setupBlockCommand());
    expect(printed[1]).toContain("<!-- logicpacks:start -->");
  });

  it("detects the harness and keeps one session id per folder", () => {
    const config = { harness: null } as HelperConfig;
    expect(detectHarness({ CLAUDECODE: "1" }, config)).toBe("Claude Code");
    expect(detectHarness({}, config, "cursor")).toBe("Cursor");
    expect(detectHarness({}, { harness: "Kiro" } as HelperConfig)).toBe("Kiro");
    expect(agentSessionId("Claude Code", "mac", "/a")).toBe(
      agentSessionId("Claude Code", "mac", "/a"),
    );
    expect(agentSessionId("Claude Code", "mac", "/a")).not.toBe(
      agentSessionId("Claude Code", "mac", "/b"),
    );
    expect(agentSessionId("Claude Code", "mac", "/a")).toMatch(/^claude-code-[0-9a-f]{12}$/);
  });
});

describe("inbox formatting", () => {
  const now = Date.parse("2026-11-01T12:00:00Z");
  const items: Array<InboxItem> = [
    {
      kind: "ask",
      id: "m-1",
      projectId: "p",
      projectTitle: "Shop",
      from: "Ana Lee",
      fromThreadId: "t1",
      toThreadId: "t2",
      replyTo: null,
      text: "Is the checkout API done?",
      atMs: now - 5 * 60_000,
    },
    {
      kind: "conflict",
      id: "c-1",
      projectId: "p",
      projectTitle: "Shop",
      files: ["src/cart.ts"],
      people: ["Ali"],
      reason: "both edited the cart total",
      threadId: "t2",
      atMs: now,
    },
    {
      kind: "negotiation",
      id: "neg-1",
      projectId: "p",
      projectTitle: "Shop",
      state: "awaiting_humans",
      files: ["src/cart.ts"],
      people: ["Ana", "Ali"],
      question: "Ali keeps the coupon field. Keep yours?",
      needsPosition: false,
      threadId: "t2",
      atMs: now,
    },
  ];

  it("prints an id, what it is and the next commands for each item", () => {
    const text = formatInbox(items, now);
    expect(text).toContain("3 items for you:");
    expect(text).toContain("[m-1] question from Ana Lee (Shop, 5m ago)");
    expect(text).toContain('lp reply m-1 "<your answer>"');
    expect(text).toContain("[c-1] conflict in src/cart.ts with Ali");
    expect(text).toContain("lp decide neg-1");
    expect(formatInbox([], now)).toBe("Inbox is empty.");
    expect(nextCommands(items[0]!)).toContain("lp who Ana");
  });

  it("turns Goals items into goals commands", () => {
    const goal = { goalId: "g-1", projectId: "p", projectTitle: "Shop", atMs: now };
    const milestone: InboxItem = {
      ...goal,
      kind: "milestone",
      id: "ms-1",
      person: "Ana Lee",
      text: "Build the footer.",
    };
    const review: InboxItem = {
      ...goal,
      kind: "review",
      id: "dr-1",
      person: "Omar",
      text: "Done.",
    };
    const draft: InboxItem = { ...goal, kind: "goal", id: "g-1", person: "Ana", text: "Draft." };
    const text = formatInbox([milestone, review, draft], now);
    expect(text).toContain("[ms-1] milestone for you from Ana Lee (Shop, just now)");
    expect(text).toContain('lp goals done ms-1 --note "<what you did>"');
    expect(text).toContain("lp goals decide dr-1 approve");
    expect(text).toContain("lp goals confirm g-1");
  });

  it("reads a milestone written as person: task by day", () => {
    expect(parseMilestone("Omar: build the footer by friday")).toEqual({
      assignee: "Omar",
      title: "build the footer",
      due: "friday",
    });
    expect(parseMilestone("Priya: write the tests")).toEqual({
      assignee: "Priya",
      title: "write the tests",
    });
    expect(parseMilestone("Ali: ship it by 2026-11-07.")?.due).toBe("2026-11-07");
    expect(parseMilestone("Ali: build it by hand")).toEqual({
      assignee: "Ali",
      title: "build it by hand",
    });
    expect(parseMilestone("no assignee here")).toBeNull();
  });

  it("lists agents with person, harness, task and thread", () => {
    const text = formatAgents(
      [
        {
          projectId: "p",
          projectTitle: "Shop",
          threadId: "external:agent:cursor-1",
          title: "Cursor session",
          person: "Omar",
          personId: "u2",
          harness: "Cursor",
          model: null,
          task: "fix the footer",
          status: "working",
          files: ["src/Footer.tsx"],
          lastActiveAtMs: now,
        },
      ],
      null,
      now,
    );
    expect(text).toContain(
      "Omar via Cursor, working, just now: fix the footer (files: src/Footer.tsx)",
    );
  });
});

describe("lp login (device code) against a local server", () => {
  let server: NodeHttp.Server;
  let base: string;
  let approved = false;
  const calls: Array<string> = [];

  beforeEach(async () => {
    approved = false;
    calls.length = 0;
    server = NodeHttp.createServer((request, response) => {
      calls.push(request.url ?? "");
      const send = (status: number, body: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      };
      if (request.url === "/api/lp/helper/pair/start") {
        return send(200, {
          code: "ABCD-1234",
          pollToken: "poll-1",
          approvePath: "/lp/helper?code=ABCD-1234",
        });
      }
      if (request.url === "/api/lp/helper/pair/poll") {
        return send(
          200,
          approved ? { status: "approved", token: "tok-1", who: "Ana" } : { status: "pending" },
        );
      }
      return send(404, { error: "not_found" });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as NodeNet.AddressInfo).port}`;
  });
  afterEach(() => server.close());

  const context = () => {
    let config: HelperConfig = {
      server: null,
      token: null,
      who: null,
      paused: false,
      unlinked: [],
      since: "2026-11-01T00:00:00.000Z",
      device: "test-mac",
    };
    const printed: Array<string> = [];
    const ctx: Context = {
      cwd: "/tmp",
      env: { LP_NO_OPEN: "1" },
      loadConfig: () => config,
      saveConfig: (next) => {
        config = next;
      },
      call: callHost,
      run: () => ({ ok: true, stdout: "", stderr: "" }),
      print: (line) => printed.push(line),
      sleep: async () => {
        approved = true;
      },
    };
    return { ctx, printed, config: () => config };
  };

  it("prints the link and code, waits for approval and stores the token", async () => {
    const { ctx, printed, config } = context();
    const result = await loginCommand(ctx, parseArgs(["login", "--host", base]));
    expect(printed[0]).toContain(`${base}/lp/helper?code=ABCD-1234`);
    expect(result.text).toBe(`Connected to ${base} as Ana.`);
    expect(config().token).toBe("tok-1");
    expect(config().server).toBe(base);
    expect(config().pending).toBeNull();
  });

  it("splits into --start and --finish for agents whose shell calls time out", async () => {
    const { ctx, config } = context();
    const started = await loginCommand(
      ctx,
      parseArgs(["login", "--host", base, "--start", "--json"]),
    );
    expect(started.json).toMatchObject({ status: "pending", code: "ABCD-1234" });
    expect(config().token).toBeNull();
    expect(config().pending?.pollToken).toBe("poll-1");
    // As setup.md says it: --finish without --host finishes on the host --start used.
    const finished = await loginCommand(ctx, parseArgs(["login", "--finish"]));
    expect(finished.json).toMatchObject({ ok: true, who: "Ana" });
    expect(config().server).toBe(base);
    // --finish reused the pending code instead of starting a new one.
    expect(calls.filter((call) => call === "/api/lp/helper/pair/start").length).toBe(1);
    const again = await loginCommand(ctx, parseArgs(["login", "--finish"]));
    expect(again.json).toMatchObject({ error: expect.stringMatching(/lp login --start first/) });
  });
});

describe("the web app's Connect your agent prompt", () => {
  it("is the same text as lp setup-prompt", async () => {
    const web = await import("../../../apps/web/src/logicpacks/connectPrompt.ts");
    expect(web.CONNECT_AGENT_PROMPT).toBe(setupPrompt("new"));
  });
});
