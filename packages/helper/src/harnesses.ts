/**
 * Where each agent harness keeps its instructions, for `lp setup`, `lp uninstall` and setup.md.
 * Paths were checked against each tool's docs (URL per entry, 2026-11-01); "unverified" says so.
 * Kinds: `block` (marked block in a shared file), `file` (our own rules file), `yaml-read`
 * (Aider's `read:`), `ui` (no global file: project file plus printed settings steps).
 */

export type Platform = "darwin" | "linux" | "win32";

/** A path per OS. `~` is the home folder; `$VAR|fallback` uses the variable when set. */
export interface OsPaths {
  readonly unix: string;
  readonly windows?: string;
}

export type FileFormat = "markdown" | "mdc" | "yaml";

export type GlobalTarget =
  | { readonly kind: "block"; readonly path: OsPaths }
  | {
      readonly kind: "file";
      readonly path: OsPaths;
      /** Front matter the tool needs for an always-on rule. */
      readonly frontmatter?: string;
    }
  | { readonly kind: "yaml-read"; readonly config: OsPaths; readonly rules: OsPaths }
  | { readonly kind: "ui"; readonly steps: ReadonlyArray<string> };

export interface ProjectTarget {
  readonly kind: "block" | "file";
  /** Relative to the project folder. */
  readonly path: string;
  readonly frontmatter?: string;
}

export interface Harness {
  readonly id: string;
  readonly name: string;
  readonly global: GlobalTarget;
  readonly project: ProjectTarget | null;
  readonly format: FileFormat;
  /** Its agent runs shell commands, so it can call `lp` itself. */
  readonly shell: boolean;
  readonly mcp: boolean;
  /** Where its MCP servers are configured, when the docs say. */
  readonly mcpConfig?: string;
  readonly docs: ReadonlyArray<string>;
  readonly notes?: string;
  /** Not a harness of its own: use this one's files. */
  readonly via?: string;
}

const AGENTS_MD: ProjectTarget = { kind: "block", path: "AGENTS.md" };

export const LOGICPACKS_RULE_FILE = "logicpacks.md";

export const HARNESSES: ReadonlyArray<Harness> = [
  {
    // https://code.claude.com/docs/en/memory , https://code.claude.com/docs/en/mcp
    id: "claude",
    name: "Claude Code",
    global: {
      kind: "block",
      path: { unix: "$CLAUDE_CONFIG_DIR|~/.claude/CLAUDE.md", windows: "~\\.claude\\CLAUDE.md" },
    },
    project: { kind: "block", path: "CLAUDE.md" },
    format: "markdown",
    shell: true,
    mcp: true,
    mcpConfig: "~/.claude.json (user scope) or .mcp.json (project)",
    docs: ["https://code.claude.com/docs/en/memory", "https://code.claude.com/docs/en/mcp"],
  },
  {
    // https://learn.chatgpt.com/docs/agent-configuration/agents-md
    id: "codex",
    name: "Codex CLI",
    global: { kind: "block", path: { unix: "$CODEX_HOME|~/.codex/AGENTS.md" } },
    project: AGENTS_MD,
    format: "markdown",
    shell: true,
    mcp: true,
    mcpConfig: "~/.codex/config.toml [mcp_servers.<name>]",
    docs: [
      "https://learn.chatgpt.com/docs/agent-configuration/agents-md",
      "https://learn.chatgpt.com/docs/extend/mcp?surface=cli",
    ],
    notes: "An AGENTS.override.md next to it wins over AGENTS.md; LogicPacks writes AGENTS.md.",
  },
  {
    // https://opencode.ai/docs/rules/
    id: "opencode",
    name: "OpenCode",
    global: { kind: "block", path: { unix: "~/.config/opencode/AGENTS.md" } },
    project: AGENTS_MD,
    format: "markdown",
    shell: true,
    mcp: true,
    mcpConfig: "the `mcp` key in opencode.json",
    docs: ["https://opencode.ai/docs/rules/"],
  },
  {
    // https://geminicli.com/docs/cli/gemini-md/
    id: "gemini",
    name: "Gemini CLI",
    global: { kind: "block", path: { unix: "~/.gemini/GEMINI.md" } },
    project: { kind: "block", path: "GEMINI.md" },
    format: "markdown",
    shell: true,
    mcp: true,
    mcpConfig: "mcpServers in ~/.gemini/settings.json",
    docs: [
      "https://geminicli.com/docs/cli/gemini-md/",
      "https://geminicli.com/docs/tools/mcp-server/",
    ],
  },
  {
    // https://commandcode.ai/docs/memory
    id: "command-code",
    name: "Command Code",
    global: { kind: "block", path: { unix: "~/.commandcode/AGENTS.md" } },
    project: AGENTS_MD,
    format: "markdown",
    shell: true,
    mcp: true,
    mcpConfig: "~/.commandcode/mcp.json",
    docs: ["https://commandcode.ai/docs/memory", "https://commandcode.ai/docs/mcp"],
    notes: "commandcode.ai, CLI `cmd` (npm i -g command-code).",
  },
  {
    // https://docs.z.ai/devpack/overview
    id: "zai",
    name: "Z.ai GLM Coding Plan",
    via: "claude",
    global: {
      kind: "block",
      path: { unix: "$CLAUDE_CONFIG_DIR|~/.claude/CLAUDE.md", windows: "~\\.claude\\CLAUDE.md" },
    },
    project: { kind: "block", path: "CLAUDE.md" },
    format: "markdown",
    shell: true,
    mcp: true,
    docs: ["https://docs.z.ai/devpack/overview"],
    notes:
      "A model plan, not a harness: it runs inside Claude Code (or OpenCode, Cline, Codex...). Set up the harness you run GLM in; this target is Claude Code's.",
  },
  {
    // https://cursor.com/docs/context/rules , https://cursor.com/docs/context/mcp
    id: "cursor",
    name: "Cursor",
    global: {
      kind: "ui",
      steps: [
        "Open Cursor Settings, then Rules (Customize > Rules).",
        "Under User Rules, add a rule and paste the LogicPacks block (lp setup-block prints it).",
      ],
    },
    project: {
      kind: "file",
      path: ".cursor/rules/logicpacks.mdc",
      frontmatter:
        "---\ndescription: LogicPacks team collaboration through the lp CLI\nalwaysApply: true\n---\n",
    },
    format: "mdc",
    shell: true,
    mcp: true,
    mcpConfig: "~/.cursor/mcp.json",
    docs: ["https://cursor.com/docs/context/rules", "https://cursor.com/docs/context/mcp"],
    notes: "User Rules live in the app only. Cursor also reads a root AGENTS.md.",
  },
  {
    // https://code.visualstudio.com/docs/copilot/customization/custom-instructions
    id: "copilot",
    name: "VS Code + GitHub Copilot",
    global: { kind: "block", path: { unix: "~/.copilot/copilot-instructions.md" } },
    project: { kind: "block", path: ".github/copilot-instructions.md" },
    format: "markdown",
    shell: true,
    mcp: true,
    mcpConfig: ".vscode/mcp.json (unverified)",
    docs: ["https://code.visualstudio.com/docs/copilot/customization/custom-instructions"],
    notes:
      "Personal *.instructions.md files go in ~/.copilot/instructions; AGENTS.md is read too (chat.useAgentsMdFile).",
  },
  {
    // https://docs.devin.ai/desktop/cascade/memories (docs.windsurf.com redirects here)
    id: "windsurf",
    name: "Windsurf",
    global: { kind: "block", path: { unix: "~/.devin/global_rules.md" } },
    project: AGENTS_MD,
    format: "markdown",
    shell: true,
    mcp: true,
    docs: ["https://docs.devin.ai/desktop/cascade/memories"],
    notes:
      "Older installs read ~/.codeium/windsurf/memories/global_rules.md; pass --file for that one.",
  },
  {
    // https://docs.cline.bot/customization/cline-rules
    id: "cline",
    name: "Cline",
    global: {
      kind: "file",
      path: {
        unix: `~/Documents/Cline/Rules/${LOGICPACKS_RULE_FILE}`,
        windows: `~\\Documents\\Cline\\Rules\\${LOGICPACKS_RULE_FILE}`,
      },
    },
    project: { kind: "file", path: `.clinerules/${LOGICPACKS_RULE_FILE}` },
    format: "markdown",
    shell: true,
    mcp: true,
    docs: ["https://docs.cline.bot/customization/cline-rules"],
  },
  {
    // https://roocodeinc.github.io/Roo-Code/features/custom-instructions
    id: "roo",
    name: "Roo Code",
    global: {
      kind: "file",
      path: {
        unix: `~/.roo/rules/${LOGICPACKS_RULE_FILE}`,
        windows: `~\\.roo\\rules\\${LOGICPACKS_RULE_FILE}`,
      },
    },
    project: { kind: "file", path: `.roo/rules/${LOGICPACKS_RULE_FILE}` },
    format: "markdown",
    shell: true,
    mcp: true,
    docs: ["https://roocodeinc.github.io/Roo-Code/features/custom-instructions"],
  },
  {
    // https://kilo.ai/docs/customize/custom-rules
    id: "kilo",
    name: "Kilo Code",
    global: {
      kind: "ui",
      steps: [
        "Open ~/.config/kilo/kilo.jsonc (Kilo Code settings).",
        `Add the rules file to "instructions", e.g. "instructions": ["~/.logicpacks/rules/${LOGICPACKS_RULE_FILE}"] (lp setup --agent kilo writes that file).`,
      ],
    },
    project: { kind: "file", path: `.kilo/rules/${LOGICPACKS_RULE_FILE}` },
    format: "markdown",
    shell: true,
    mcp: true,
    docs: ["https://kilo.ai/docs/customize/custom-rules"],
    notes: "Global rules are listed in kilo.jsonc `instructions`; LogicPacks does not edit JSONC.",
  },
  {
    // https://github.com/zed-industries/zed/blob/main/docs/src/ai/rules.md
    id: "zed",
    name: "Zed",
    global: {
      kind: "block",
      path: { unix: "~/.config/zed/AGENTS.md", windows: "~\\AppData\\Roaming\\Zed\\AGENTS.md" },
    },
    project: { kind: "block", path: ".rules" },
    format: "markdown",
    shell: true,
    mcp: true,
    docs: ["https://github.com/zed-industries/zed/blob/main/docs/src/ai/rules.md"],
  },
  {
    // https://docs.continue.dev/customize/deep-dives/rules
    id: "continue",
    name: "Continue",
    global: {
      kind: "ui",
      steps: [
        "Continue's docs name no global rules file; LogicPacks writes .continue/rules/logicpacks.md in this project.",
        "For every project, add the block as a rule in your Continue config (Hub or config.yaml `rules:`).",
      ],
    },
    project: {
      kind: "file",
      path: `.continue/rules/${LOGICPACKS_RULE_FILE}`,
      frontmatter: "---\nname: LogicPacks\nalwaysApply: true\n---\n",
    },
    format: "markdown",
    shell: true,
    mcp: true,
    docs: ["https://docs.continue.dev/customize/deep-dives/rules"],
  },
  {
    // https://aider.chat/docs/usage/conventions.html , https://aider.chat/docs/config/aider_conf.html
    id: "aider",
    name: "Aider",
    global: {
      kind: "yaml-read",
      config: { unix: "~/.aider.conf.yml" },
      rules: { unix: `~/.logicpacks/rules/${LOGICPACKS_RULE_FILE}` },
    },
    project: { kind: "block", path: "CONVENTIONS.md" },
    format: "yaml",
    shell: false,
    mcp: false,
    docs: [
      "https://aider.chat/docs/usage/conventions.html",
      "https://aider.chat/docs/config/aider_conf.html",
    ],
    notes:
      "Aider is not an agent loop: it asks you before running a command. Run the lp commands it suggests yourself.",
  },
  {
    // https://ampcode.com/manual
    id: "amp",
    name: "Amp",
    global: { kind: "block", path: { unix: "~/.config/amp/AGENTS.md" } },
    project: AGENTS_MD,
    format: "markdown",
    shell: true,
    mcp: true,
    mcpConfig: "amp.mcpServers in settings.json",
    docs: ["https://ampcode.com/manual"],
  },
  {
    // https://docs.warp.dev/knowledge-and-collaboration/rules
    id: "warp",
    name: "Warp",
    global: {
      kind: "ui",
      steps: [
        "In Warp, open Warp Drive > Personal > Rules (or Settings > AI > Knowledge > Manage Rules).",
        "Add a Global rule and paste the LogicPacks block (lp setup-block prints it).",
      ],
    },
    project: AGENTS_MD,
    format: "markdown",
    shell: true,
    mcp: true,
    docs: ["https://docs.warp.dev/knowledge-and-collaboration/rules"],
  },
  {
    // https://kiro.dev/docs/steering/ , https://kiro.dev/docs/mcp/configuration/
    id: "kiro",
    name: "Kiro",
    global: {
      kind: "file",
      path: { unix: `~/.kiro/steering/${LOGICPACKS_RULE_FILE}` },
      frontmatter: "---\ninclusion: always\n---\n",
    },
    project: {
      kind: "file",
      path: `.kiro/steering/${LOGICPACKS_RULE_FILE}`,
      frontmatter: "---\ninclusion: always\n---\n",
    },
    format: "markdown",
    shell: true,
    mcp: true,
    mcpConfig: "~/.kiro/settings/mcp.json",
    docs: ["https://kiro.dev/docs/steering/", "https://kiro.dev/docs/mcp/configuration/"],
  },
  {
    // https://goose-docs.ai/docs/guides/context-engineering/using-goosehints/
    id: "goose",
    name: "Goose",
    global: { kind: "block", path: { unix: "~/.config/goose/.goosehints" } },
    project: { kind: "block", path: ".goosehints" },
    format: "markdown",
    shell: true,
    mcp: true,
    docs: ["https://goose-docs.ai/docs/guides/context-engineering/using-goosehints/"],
    notes: "Hints need the Developer extension, which is also what runs shell commands.",
  },
  {
    // https://github.com/QwenLM/qwen-code/blob/main/docs/users/features/memory.md
    id: "qwen",
    name: "Qwen Code",
    global: { kind: "block", path: { unix: "~/.qwen/QWEN.md" } },
    project: { kind: "block", path: "QWEN.md" },
    format: "markdown",
    shell: true,
    mcp: true,
    mcpConfig: "mcpServers in ~/.qwen/settings.json",
    docs: ["https://github.com/QwenLM/qwen-code/blob/main/docs/users/features/memory.md"],
  },
  {
    // https://github.com/charmbracelet/crush
    id: "crush",
    name: "Crush",
    global: { kind: "block", path: { unix: "~/.config/crush/CRUSH.md" } },
    project: AGENTS_MD,
    format: "markdown",
    shell: true,
    mcp: true,
    mcpConfig: "the `mcp` key in crush.json",
    docs: ["https://github.com/charmbracelet/crush"],
  },
  {
    // https://docs.factory.com/cli/configuration/agents-md
    id: "droid",
    name: "Factory Droid",
    global: { kind: "block", path: { unix: "~/.factory/AGENTS.md" } },
    project: AGENTS_MD,
    format: "markdown",
    shell: true,
    mcp: true,
    docs: ["https://docs.factory.com/cli/configuration/agents-md"],
    notes: "The docs say Droid looks in ~/.factory/; the exact global file name is unverified.",
  },
  {
    // https://junie.jetbrains.com/docs/guidelines-and-memory.html
    id: "junie",
    name: "JetBrains Junie",
    global: {
      kind: "block",
      path: { unix: "~/.junie/AGENTS.md", windows: "~\\.junie\\AGENTS.md" },
    },
    project: { kind: "block", path: ".junie/AGENTS.md" },
    format: "markdown",
    shell: true,
    mcp: true,
    mcpConfig: "~/.junie/mcp/mcp.json",
    docs: [
      "https://junie.jetbrains.com/docs/guidelines-and-memory.html",
      "https://junie.jetbrains.com/docs/junie-cli-mcp-configuration.html",
    ],
    notes: "Older projects use .junie/guidelines.md, which Junie still reads.",
  },
  {
    // https://hermes-agent.nousresearch.com/docs/user-guide/features/context-files
    id: "hermes",
    name: "Hermes Agent",
    global: {
      kind: "ui",
      steps: [
        "Hermes has no global instructions file (~/.hermes/SOUL.md is persona only).",
        "LogicPacks writes the block into this project's AGENTS.md, which Hermes reads.",
      ],
    },
    project: AGENTS_MD,
    format: "markdown",
    shell: true,
    mcp: true,
    docs: ["https://hermes-agent.nousresearch.com/docs/user-guide/features/context-files"],
  },
  {
    id: "generic",
    name: "Any other agent",
    global: {
      kind: "ui",
      steps: [
        "Pass the file your agent reads its instructions from: lp setup --agent generic --file <path>.",
        "Without --file, LogicPacks writes this project's AGENTS.md, which most agents read.",
      ],
    },
    project: AGENTS_MD,
    format: "markdown",
    shell: true,
    mcp: true,
    docs: ["https://agents.md"],
  },
];

const ALIASES: Record<string, string> = {
  "claude-code": "claude",
  "codex-cli": "codex",
  "gemini-cli": "gemini",
  commandcode: "command-code",
  commandai: "command-code",
  "z.ai": "zai",
  glm: "zai",
  "vscode-copilot": "copilot",
  vscode: "copilot",
  "github-copilot": "copilot",
  "roo-code": "roo",
  "kilo-code": "kilo",
  "factory-droid": "droid",
  factory: "droid",
  "qwen-code": "qwen",
  "hermes-agent": "hermes",
  other: "generic",
  custom: "generic",
};

export const findHarness = (id: string): Harness | null => {
  const key = id.trim().toLowerCase();
  const resolved = ALIASES[key] ?? key;
  return HARNESSES.find((harness) => harness.id === resolved) ?? null;
};

/** `~`, `$VAR|fallback` and the OS separator, for `platform`. */
export const resolveOsPath = (
  paths: OsPaths,
  options: {
    readonly platform: Platform;
    readonly home: string;
    readonly env: Readonly<Record<string, string | undefined>>;
  },
): string => {
  const windows = options.platform === "win32";
  const raw = windows && paths.windows !== undefined ? paths.windows : paths.unix;
  const sep = windows ? "\\" : "/";
  const variable = /^\$([A-Z_]+)\|(.*)$/.exec(raw);
  if (variable !== null) {
    const value = options.env[variable[1]!];
    const rest = variable[2]!;
    if (value) {
      // `$CODEX_HOME|~/.codex/AGENTS.md`: the variable replaces the folder; keep the file name.
      const fileName = rest.split(/[\\/]/).at(-1)!;
      return `${value.replace(/[\\/]+$/, "")}${sep}${fileName}`;
    }
    return resolveOsPath({ unix: rest, ...(paths.windows ? { windows: rest } : {}) }, options);
  }
  const expanded =
    raw === "~" || raw.startsWith("~/") || raw.startsWith("~\\")
      ? `${options.home}${raw.slice(1)}`
      : raw;
  return windows ? expanded.replaceAll("/", "\\") : expanded;
};

/** Human-readable global location for setup.md: the macOS/Linux path, plus Windows when known. */
export const describeGlobal = (harness: Harness) => {
  const target = harness.global;
  switch (target.kind) {
    case "block":
    case "file":
      return target.path.unix.replace(/^\$[A-Z_]+\|/, "");
    case "yaml-read":
      return `${target.config.unix} (read: ${target.rules.unix})`;
    case "ui":
      return "settings UI only";
  }
};
