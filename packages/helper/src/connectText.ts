import { describeGlobal, HARNESSES, type Harness } from "./harnesses.ts";

/**
 * The words an outside agent gets: the short block for its global instructions, the
 * prompt a person pastes into any agent, and setup.md. One source for the CLI, the
 * server's /setup.md and the landing page.
 */

export const SETUP_URL = "https://logicpacks.io/setup.md";
export const HELPER_INSTALL = "curl -fsSL https://logicpacks.io/helper.sh | bash";
export const HELPER_INSTALL_WINDOWS = "irm https://logicpacks.io/helper.ps1 | iex";
/** The app and the helper together (macOS app + lp; Linux: lp only). */
export const APP_INSTALL = "curl -fsSL https://logicpacks.io/install.sh | bash";
export const APP_INSTALL_WINDOWS = "irm https://logicpacks.io/install.ps1 | iex";
export const DEFAULT_HOST = "https://app.logicpacks.io";

/** The global block: intents to `lp` commands. Kept short on purpose (about 20 lines). */
export const globalBlockBody = (projectTitle: string | null = null) =>
  [
    `## LogicPacks${projectTitle ? `: ${projectTitle}` : ""}`,
    `Team work runs through the \`lp\` command (add \`--json\` to parse its output). If \`lp\` is the printer command (macOS, Linux), call \`~/.local/bin/lp\`; in Windows PowerShell 5.1 type \`lp.exe\` (\`lp\` is an Out-Printer alias there). If it is missing, follow ${SETUP_URL}.`,
    "- At the start of a session and after long tasks, run `lp inbox` and tell the user what is new (messages, questions from other agents, conflicts, drift, review requests).",
    '- "share this project" / "create a shared session" -> `lp share`, then give the user the invite link.',
    '- "add my friend X" / "invite X" -> `lp invite <email or name>` (this project only; `--workspace` for every project); "remove X" -> `lp remove <person>`; "turn off the invite link" -> `lp revoke-invite`.',
    '- "what is X working on" -> `lp who X`; "who is working right now" -> `lp agents` (`--workspace` for every project).',
    '- "tell X ..." -> `lp send X "<message>"`.',
    '- To coordinate with a teammate\'s agent, use `lp ask <person> "<question>"` and `lp reply <id> "<answer>"`; check `lp inbox` for questions from other agents and answer them.',
    '- "set goals" / "ask X to do Y by Friday" -> `lp goals plan "<goal>" "<person>: <task> by <day>" ...`; your user confirms with `lp goals confirm <id>`. Milestones for you arrive in `lp inbox`: `lp goals start|done <id>`.',
    "- Before you edit shared files, run `lp who <file or topic>`; if a teammate is on it, tell the user first.",
    "- On a conflict or negotiation in `lp inbox`, answer with `lp reply <id>`; when it needs a person, ask the user, then `lp decide <id> mine|theirs|both`.",
    "- If you cannot run shell commands, ask the user to run the `lp` command, or use the `logicpacks` MCP tools if they are set up.",
    `- Everything else: \`lp help agents\` or ${SETUP_URL}. \`lp uninstall\` removes this block.`,
  ].join("\n");

/** What a person pastes into any agent. */
export const setupPrompt = (variant: "new" | "installed" = "new") =>
  variant === "new"
    ? [
        `Set up LogicPacks for me: read ${SETUP_URL} and follow it.`,
        "Install the helper, connect it to the LogicPacks app on this computer, and add the LogicPacks block to your global instructions.",
        "Show me what you'll change first and wait for my OK before you write anything.",
        "Then share this project and give me an invite link.",
      ].join("\n")
    : [
        "LogicPacks is already set up here (the lp command is installed).",
        "Add this project to LogicPacks with lp share and give me the invite link.",
        `If anything is missing, read ${SETUP_URL} and follow it.`,
      ].join("\n");

export interface CommandHelp {
  readonly usage: string;
  readonly does: string;
  /** Listed only for accounts that have this access-code feature (never in setup.md). */
  readonly feature?: "talent";
}

/** Every command an agent may run, in the order setup.md and `lp help agents` list them. */
export const AGENT_COMMANDS: ReadonlyArray<CommandHelp> = [
  {
    usage: "lp login [--cloud | --host <url>] [--start | --finish]",
    does: "connect to the LogicPacks app on this computer (no browser step); --cloud or --host <url> sign in to a hosted one with a device code",
  },
  { usage: "lp whoami", does: "who you are signed in as, and on which host" },
  { usage: "lp projects", does: "the projects you can open" },
  {
    usage: "lp share [--title <name>] [--workspace]",
    does: "share this folder: push it to its git remote (GitHub) and register it on the host; prints an invite link",
  },
  {
    usage: "lp invite [<email|name>] [--workspace]",
    does: "add someone to this project, or print the invite link to send them",
  },
  { usage: "lp join <invite link>", does: "accept an invite link from a teammate" },
  { usage: "lp members", does: "who is in this project" },
  { usage: "lp who [person|file|topic]", does: "who is working on what in this project" },
  {
    usage: "lp agents [--workspace]",
    does: "active agents and sessions: person, harness, thread, current task",
  },
  { usage: 'lp send <person> "<message>"', does: "message a teammate's thread; no reply expected" },
  {
    usage: 'lp ask <person> "<question>" [--project <id|name>]',
    does: "ask a teammate's agent; the reply comes back to your lp inbox",
  },
  {
    usage: 'lp reply <id> "<text>"',
    does: "answer a message, question or negotiation from lp inbox",
  },
  {
    usage: "lp decide <negotiation id> accept|mine|theirs|both",
    does: "record your user's decision on a merge negotiation",
  },
  {
    usage: "lp inbox [--follow] [--all]",
    does: "messages, questions, conflicts, negotiations, drift and review requests for you",
  },
  {
    usage: "lp editing <file...>",
    does: "tell teammates which files you are changing (lp who shows it; overlaps raise a notice)",
  },
  { usage: "lp done <id>", does: "dismiss an inbox item you handled" },
  {
    usage: 'lp assist request "<brief>" [--expert <id>]',
    does: "Request assistance: bring in an expert (beta)",
    feature: "talent",
  },
  {
    usage: "lp assist experts | list | end <request id>",
    does: "the expert catalog, this project's requests, end a request",
    feature: "talent",
  },
  {
    usage: 'lp goals plan "<goal>" "<person>: <task> [by <day>]"...',
    does: "draft a goal with milestones for people or experts (beta); nothing is sent yet",
  },
  {
    usage: "lp goals list | show <id> | confirm <goal> | cancel <goal>",
    does: "see goals; confirm a draft (sends the milestones) once your user agrees",
  },
  {
    usage: 'lp goals start|blocked|done <milestone> [--note "<text>"]',
    does: "report on a milestone assigned to you",
  },
  {
    usage: "lp goals review | decide <id> <action> [--note]",
    does: "drift and review requests waiting for your user, and their decision",
  },
  {
    usage: "lp remove <person> [--project-only] [--dry-run]",
    does: "take someone's access away (this project and its workspace)",
  },
  {
    usage: "lp revoke-invite [<email>] [--off] [--workspace]",
    does: "turn off this project's invite link (and print a new one), or cancel one person's invite",
  },
  {
    usage: "lp stream --status | --mcp-details on|off",
    does: "what this folder's sessions send to the project; MCP details are off by default",
  },
  {
    usage: "lp setup --agent <id> [--file <path>] [--project] [--yes]",
    does: "show the diff for the LogicPacks block; --yes writes it (with a backup)",
  },
  { usage: "lp setup-prompt [--installed]", does: "print the prompt to paste into any agent" },
  {
    usage: "lp install [--dry-run | --yes]",
    does: "optional: Claude Code hooks, background watcher, MCP for Claude Code and Codex",
  },
  {
    usage: "lp pause | lp resume | lp unlink | lp link",
    does: "stop streaming sessions (everything, or just this folder) and turn it back on",
  },
  { usage: "lp status | lp watch", does: "connection and queue; the background session streamer" },
  { usage: "lp mcp", does: "the optional MCP server (stdio)" },
  {
    usage: "lp uninstall [--dry-run] [--agent <id>]",
    does: "remove every LogicPacks block, rules file, hook and MCP registration",
  },
];

const pad = (text: string, width: number) => text.padEnd(width);

export const agentsHelp = (features: ReadonlyArray<string> = []) => {
  const commands = AGENT_COMMANDS.filter(
    (command) => command.feature === undefined || features.includes(command.feature),
  );
  const width = Math.max(...commands.map((command) => command.usage.length)) + 2;
  return [
    "LogicPacks for agents. Every command prints readable text; add --json for machine output.",
    "",
    ...commands.map((command) => `  ${pad(command.usage, width)}${command.does}`),
    "",
    `Setup guide: ${SETUP_URL}`,
  ].join("\n");
};

/** Every file the helper may create or change, per OS; only `lp install` and `lp setup` change agent files. */
export const INSTALLED_FILES = {
  helper: {
    macosLinux: [
      "~/.logicpacks/helper/bin/lp (the CLI: one standalone executable, no Node needed)",
      "~/.local/bin/lp (a symlink to it)",
      "~/.logicpacks/helper/config.json (host, token, device name; mode 600), setup.json (what lp setup wrote), queue/ (sessions waiting to upload)",
    ],
    windows: [
      "%USERPROFILE%\\.logicpacks\\helper\\bin\\lp.exe (the CLI: one standalone executable, no Node needed), plus bin\\lp.cmd (cmd) and bin\\lp (Git Bash) that start it",
      "the user PATH gains %USERPROFILE%\\.logicpacks\\helper\\bin",
      "%USERPROFILE%\\.logicpacks\\helper\\config.json, setup.json, queue\\",
    ],
  },
  setup:
    "lp setup --agent <id>: one marked block in that harness's global instructions file (see the table), or one rules file of its own (Cline, Roo, Kiro, Cursor .mdc); with --project or for UI-only harnesses, the project's file (for example AGENTS.md)",
  install: {
    macosLinux: [
      "~/.claude/settings.json: hooks SessionStart, UserPromptSubmit, PostToolUse, Stop that run `lp hook <event>` (marked # logicpacks-helper)",
      "~/.claude.json: mcpServers.logicpacks (stdio: lp mcp --source claude)",
      "~/.codex/config.toml: [mcp_servers.logicpacks] table",
      "macOS: ~/Library/LaunchAgents/io.logicpacks.helper.plist (runs lp watch); Linux: ~/.config/systemd/user/logicpacks-helper.service",
    ],
    windows: [
      "%USERPROFILE%\\.claude\\settings.json hooks and %USERPROFILE%\\.claude.json MCP entry, as on macOS",
      "%USERPROFILE%\\.codex\\config.toml [mcp_servers.logicpacks]",
      "%APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\logicpacks-helper.vbs (runs lp watch hidden)",
    ],
  },
  backups: "<file>.lp-backup-<YYYYMMDD-HHMMSS> next to each file before it changes",
} as const;

const setupLine = (harness: Harness) => {
  const global = describeGlobal(harness);
  const project = harness.project?.path ?? "none";
  return `| ${harness.name} | \`${harness.id}\` | ${global === "settings UI only" ? global : `\`${global}\``} | \`${project}\` | ${harness.shell ? "yes" : "asks you"} | ${harness.mcp ? "yes" : "no"} |`;
};

/** setup.md: the agent-facing guide served at logicpacks.io/setup.md and <host>/setup.md. */
export const renderSetupGuide = () =>
  [
    "# Set up LogicPacks in your agent",
    "",
    "You are an AI agent and your user asked you to set up LogicPacks. Follow these steps in order. Run the commands yourself when you can run shell commands; otherwise show each one to your user and ask them to run it.",
    "",
    "LogicPacks lets your user share a project with teammates, see who is working on what, message teammates and their agents, plan goals and bring in experts. You use it through one small command line tool, `lp`.",
    "",
    "## 1. Install the helper",
    "",
    "Pick the line for the operating system you run on.",
    "",
    "macOS and Linux (bash or zsh):",
    "",
    "```sh",
    `lp help 2>/dev/null | grep -q LogicPacks || ${HELPER_INSTALL}`,
    "```",
    "",
    "Windows (PowerShell):",
    "",
    "```powershell",
    `if (-not (Get-Command lp.exe -ErrorAction SilentlyContinue)) { ${HELPER_INSTALL_WINDOWS} }`,
    "```",
    "",
    "The helper is one standalone executable: it needs no Node.js, npm or anything else. The installer downloads the build for your system (macOS Apple silicon or Intel, Linux x64, Windows x64), checks its SHA-256 against https://downloads.logicpacks.io/helper/latest.json, puts `lp` in `~/.local/bin` on macOS and Linux and `lp.exe` in `%USERPROFILE%\\.logicpacks\\helper\\bin` on Windows, and adds that folder to your PATH. The LogicPacks Windows app installs the same `lp.exe` in the same place, so if your user installed the app, `lp` is already there. macOS and many Linux systems also have a printer command named `lp` (`/usr/bin/lp`): if it comes first on your PATH, call `~/.local/bin/lp` (or put `~/.local/bin` first). In Windows PowerShell 5.1, `lp` is a built-in alias for Out-Printer, so type `lp.exe` there (for example `lp.exe login`); Git Bash, cmd and PowerShell 7 take plain `lp`. If `lp` is not found right after installing, open a new shell or call it by its full path: `~/.local/bin/lp` or `%USERPROFILE%\\.logicpacks\\helper\\bin\\lp.exe`.",
    "",
    "Installing only puts the `lp` command in place. It changes no agent's settings: that happens in step 3, and only after your user has seen the diff.",
    "",
    "## 2. Connect to the LogicPacks app",
    "",
    "Check first: `lp whoami`. If it says LogicPacks is not connected:",
    "",
    "```sh",
    "lp login",
    "```",
    "",
    "This connects the helper to the LogicPacks app running on this computer, with no browser step and no account. If it says the app is not running, ask your user to open the LogicPacks app, then run `lp login` again. If the app is not installed, install it with one line (it also installs `lp`): `" +
      APP_INSTALL +
      "` on macOS, or `" +
      APP_INSTALL_WINDOWS +
      "` in Windows PowerShell; or download it from https://logicpacks.io/download. LogicPacks cloud is coming soon; until then everything runs through the app on this computer.",
    "",
    "Teams that run their own host add `--host https://their-host`. That path asks your user to approve a device code in a browser: run `lp login --host <url> --start`, show your user the link and code, then `lp login --host <url> --finish` once they approve.",
    "",
    "## 3. Add the LogicPacks block to your global instructions",
    "",
    "First show your user exactly what will change, then write it only after they say yes:",
    "",
    "```sh",
    "lp setup --agent <id>          # prints the unified diff, writes nothing",
    "lp setup --agent <id> --yes    # after your user approves: writes it",
    "```",
    "",
    "Show your user the whole diff from the first command and ask for approval. Do not run `--yes` until they agree. `--dry-run` also shows the diff and never writes.",
    "",
    "What `lp setup` guarantees:",
    "- It only inserts or replaces the text between `<!-- logicpacks:start -->` and `<!-- logicpacks:end -->`. Every other line of the file stays byte for byte the same, and running it twice changes nothing.",
    "- Before it changes a file it copies it to `<file>.lp-backup-<YYYYMMDD-HHMMSS>` and prints that path.",
    "- If the file has a lone or doubled LogicPacks marker, it refuses and changes nothing.",
    "- It writes the global file it resolves for your harness (the table below). Leave out `--file` unless your harness is not in the table, and never point it at an instructions file in a folder above the project (such as a parent folder's `.claude/CLAUDE.md`): `lp setup` refuses those.",
    "",
    "| Harness | id | Global instructions | Project file | Runs `lp` itself | MCP |",
    "|---|---|---|---|---|---|",
    ...HARNESSES.map(setupLine),
    "",
    "Notes:",
    ...HARNESSES.filter((harness) => harness.global.kind === "ui" || harness.notes).map(
      (harness) => {
        const steps = harness.global.kind === "ui" ? harness.global.steps.join(" ") : "";
        return `- **${harness.name}**: ${[steps, harness.notes ?? ""].filter(Boolean).join(" ")}`;
      },
    ),
    "- Any other harness: `lp setup --agent generic --file <the file you read instructions from>`. If you would rather edit the file yourself, `lp setup-block` prints the block; paste it with its markers.",
    "- To also write the project file (for example `AGENTS.md`), add `--project`.",
    "",
    "The block is:",
    "",
    "```markdown",
    "<!-- logicpacks:start -->",
    globalBlockBody(),
    "<!-- logicpacks:end -->",
    "```",
    "",
    "## 4. Share the project",
    "",
    "If your user asked you to share the project they are in:",
    "",
    "```sh",
    "lp share",
    "```",
    "",
    "It pushes the folder to its git remote (it creates a private GitHub repository with `gh` when there is none), registers it on the LogicPacks host and prints an invite link. The link grants access to this project only; tell your user that, and give them the link. To add a teammate by email: `lp invite friend@example.com` (also this project only). `lp invite --workspace` gives a link to every project in the workspace: use it only when your user asks for that.",
    "",
    "## 5. Every session from now on",
    "",
    "- Run `lp inbox` at the start of a session and after long tasks. Tell your user about anything new. Each item lists the commands to act on it.",
    "- Map your user's requests to commands with the block above. The full list:",
    "",
    "```text",
    agentsHelp(),
    "```",
    "",
    "## Optional: MCP",
    "",
    "Only if your user asks for it. Show the diff first with `lp install --dry-run`, then `lp install --yes` after they approve (each changed file is backed up first).",
    "",
    'If your user wants MCP tools as well, `lp install` registers the `logicpacks` MCP server (`lp mcp`, stdio) with Claude Code and Codex (and adds the Claude Code session hooks and the background watcher that stream sessions into the project). Other harnesses can add it by hand: command `lp`, args `["mcp"]`. The tools are a small subset of the CLI (who is working on what, send, ask, reply, conflicts, notes). The CLI is the main way.',
    "",
    "## What streams to the project",
    "",
    "Only after `lp install --yes`, Claude Code and Codex sessions in a folder that belongs to a project stream into it, so teammates see what the agents are doing:",
    "",
    "- prompts and replies, with secrets redacted (API keys and tokens such as sk-, ghp_, xox, AKIA, JWTs, private key blocks, password= and token= pairs, secret-looking KEY=VALUE lines, credentials in connection strings);",
    "- built-in tool calls (commands, edits, reads, searches): up to 300 characters of input and 1,500 of result, redacted the same way;",
    '- MCP tool calls as names only, such as "mcp: whatsapp.send", with no input or result. `lp stream --mcp-details on` in a folder includes them (still redacted);',
    "- never the content of .env*, *.pem, *.key, id_* or ~/.ssh files.",
    "",
    "`lp stream --status` shows what the current folder sends. `lp unlink` keeps one folder private, `lp pause` stops all streaming on this computer, `lp resume` and `lp link` turn it back on.",
    "",
    "## What gets installed where",
    "",
    "The helper (step 1), macOS and Linux:",
    ...INSTALLED_FILES.helper.macosLinux.map((line) => `- ${line}`),
    "",
    "The helper (step 1), Windows:",
    ...INSTALLED_FILES.helper.windows.map((line) => `- ${line}`),
    "",
    `Step 3: ${INSTALLED_FILES.setup}.`,
    "",
    "Only with `lp install --yes`, macOS and Linux:",
    ...INSTALLED_FILES.install.macosLinux.map((line) => `- ${line}`),
    "",
    "Only with `lp install --yes`, Windows:",
    ...INSTALLED_FILES.install.windows.map((line) => `- ${line}`),
    "",
    `Backups: ${INSTALLED_FILES.backups}.`,
    "",
    "## Removing access and uninstalling",
    "",
    "- `lp remove <person>` takes someone's access away (this project and its workspace; `--project-only` for just the project). `--dry-run` says what it would do.",
    "- `lp revoke-invite` turns off the current invite link and prints a new one.",
    "",
    "```sh",
    "lp uninstall --dry-run   # the exact diff, writes nothing",
    "lp uninstall",
    "```",
    "",
    "It removes every LogicPacks block and rules file `lp setup` wrote, the Claude Code hooks, the background watcher and the MCP registrations, and leaves the rest of each file exactly as it was. `lp logout` forgets the token.",
    "",
  ].join("\n");
