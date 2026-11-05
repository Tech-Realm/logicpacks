/**
 * Access zones: the ONE permission model for people who join a project on someone else's host.
 *
 * A seat is described by a few zone fields (AI, Files, Compute). Presets are named bundles of
 * field values; the old Read only role is the `readonly` preset. The registry below is data:
 * the server enforces from it and the web renders the Share dialog and the people list from it,
 * so a new zone is an entry here plus its enforcement, never a UI rewrite.
 *
 * Plain data and pure functions (no Effect), so server, web and tests share one definition.
 */

/** Agents a host can lend. Maps to driver kinds: claudeAgent, codex, opencode. */
export const ACCESS_AGENTS = ["claude", "codex", "opencode"] as const;
export type AccessAgent = (typeof ACCESS_AGENTS)[number];

export const AGENT_LABELS: Readonly<Record<AccessAgent, string>> = {
  claude: "Claude",
  codex: "Codex",
  opencode: "OpenCode",
};

/** The provider driver kind each lendable agent runs as. */
export const AGENT_DRIVERS: Readonly<Record<AccessAgent, string>> = {
  claude: "claudeAgent",
  codex: "codex",
  opencode: "opencode",
};

/** The lendable agent a provider driver kind (or instance id) is, or null for any other provider. */
export const agentForDriver = (driver: string): AccessAgent | null => {
  const lowered = driver.toLowerCase();
  if (lowered === "claudeagent" || lowered === "claude" || lowered.startsWith("claude")) {
    return "claude";
  }
  if (lowered === "codex" || lowered.startsWith("codex")) return "codex";
  if (lowered === "opencode" || lowered.startsWith("opencode")) return "opencode";
  return null;
};

export type ZoneFieldId =
  | "ai.agents"
  | "files.level"
  | "files.secrets"
  | "files.folders"
  | "compute.terminal"
  | "compute.mode"
  | "projects.create";

/** Every field's value is a short string so one wire shape, one column and one UI fit all. */
export type ZoneValues = Readonly<Record<ZoneFieldId, string>>;

export interface ZoneOption {
  readonly value: string;
  readonly label: string;
  readonly hint?: string;
}

export interface ZoneFieldDef {
  readonly id: ZoneFieldId;
  readonly label: string;
  /**
   * "choice": exactly one option. "multi": any subset of the options (values joined by comma).
   * "paths": folders the host types, one per line (empty: the whole project).
   */
  readonly kind: "choice" | "multi" | "paths";
  readonly options: ReadonlyArray<ZoneOption>;
  readonly help?: string;
}

export interface ZoneDef {
  readonly id: "ai" | "files" | "compute" | "projects";
  readonly label: string;
  readonly summary: string;
  /** What the zone really guarantees, and what it does not. Shown in the UI as is. */
  readonly guarantee: string;
  readonly fields: ReadonlyArray<ZoneFieldDef>;
}

export const ACCESS_ZONES: ReadonlyArray<ZoneDef> = [
  {
    id: "ai",
    label: "AI",
    summary: "Which of the host's agents this person may use. They run on the host's subscription.",
    guarantee:
      "Members use the host's own agent subscription, so their messages spend the host's plan. " +
      "They can always switch to their own login where they have one. Off means the host's agents " +
      "refuse their turns until the host allows a request.",
    fields: [
      {
        id: "ai.agents",
        label: "Host agents",
        kind: "multi",
        options: ACCESS_AGENTS.map((agent) => ({ value: agent, label: AGENT_LABELS[agent] })),
      },
    ],
  },
  {
    id: "files",
    label: "Files",
    summary: "What this person may read or change in the project.",
    guarantee:
      "Enforced on file, upload, git and sync requests. An agent they prompt reads the project to " +
      "answer, so secret files stay readable to an agent unless secrets are hidden for it too: " +
      "Claude is told not to open them, other agents are not restricted. Read only and Chat only " +
      "stop the agent's edit tools; an agent that may edit can still write any file in the project.",
    fields: [
      {
        id: "files.level",
        label: "Project files",
        kind: "choice",
        options: [
          { value: "none", label: "None" },
          { value: "read", label: "Read" },
          { value: "write", label: "Read and write" },
        ],
      },
      {
        id: "files.secrets",
        label: "Secret files (.env, keys)",
        kind: "choice",
        options: [
          { value: "hidden", label: "Hidden" },
          { value: "granted", label: "Allowed" },
        ],
      },
      {
        id: "files.folders",
        label: "Shared folders",
        kind: "paths",
        options: [],
        help:
          "One folder per line, inside the project or anywhere on this computer. Empty shares the whole project. " +
          "Enforced on the real path, so a symlink or .. cannot lead out.",
      },
    ],
  },
  {
    id: "compute",
    label: "Compute",
    summary: "Terminal, commands and dev servers on the host's computer.",
    guarantee:
      "Off blocks the terminal and the agent's shell tool. It cannot stop an agent you let edit " +
      "files from writing code that someone later runs. On a laptop host with no member sandbox, " +
      "Sandboxed (macOS) lets commands and the member's Claude run but read and write only the shared " +
      "folders (an OS limit, not a VM: same user, network on; Codex and other agents keep tool limits only). " +
      "Unrestricted is a shell as the host's user on their real computer; Sandboxed is not available on Windows hosts.",
    fields: [
      {
        id: "compute.terminal",
        label: "Terminal and commands",
        kind: "choice",
        options: [
          { value: "off", label: "Off" },
          { value: "on", label: "On" },
        ],
      },
      {
        id: "compute.mode",
        label: "How it runs",
        kind: "choice",
        options: [
          { value: "sandboxed", label: "Sandboxed", hint: "Terminal, commands and their agent can read and write only the shared folders (macOS)." },
          { value: "unrestricted", label: "Unrestricted", hint: "A shell as your user on your real computer." },
        ],
      },
    ],
  },
  {
    id: "projects",
    label: "Projects",
    summary: "Whether this person can create, rename, move and delete projects on this host.",
    guarantee:
      "Off refuses creating, renaming, moving and deleting projects on every server path (the " +
      "app, the API, lp and the agent's project tools). A project they create belongs to your " +
      "workspace on your computer, shows who made it and you can remove it. An agent that can " +
      "write files can still make a folder inside the folders it may write; it cannot register " +
      "that folder as a project.",
    fields: [
      {
        id: "projects.create",
        label: "Can create projects in this workspace",
        kind: "choice",
        options: [
          { value: "off", label: "Off" },
          { value: "on", label: "On" },
        ],
      },
    ],
  },
];

export const ZONE_FIELDS: ReadonlyArray<ZoneFieldDef> = ACCESS_ZONES.flatMap((zone) => zone.fields);

// ── Presets ────────────────────────────────────────────────────────────────

export type PresetId = "chat" | "edit" | "full" | "readonly";

export interface PresetDef {
  readonly id: PresetId;
  readonly label: string;
  readonly summary: string;
  readonly values: ZoneValues;
  /** The grant needs a blunt confirmation. */
  readonly warning?: string;
}

const ALL_AGENTS = ACCESS_AGENTS.join(",");

export const FULL_ACCESS_WARNING =
  "Full access gives this person a shell as the host's user. On a laptop host with no member " +
  "sandbox that is the host's real computer: every file, login and key that user can reach. " +
  "Only grant it to someone you trust with that machine.";

export const ACCESS_PRESETS: ReadonlyArray<PresetDef> = [
  {
    id: "chat",
    label: "Chat only",
    summary: "Talk to the host's agent. No file panel, no edits, no commands.",
    values: {
      "ai.agents": ALL_AGENTS,
      "files.level": "none",
      "files.secrets": "hidden",
      "files.folders": "",
      "compute.terminal": "off",
      "compute.mode": "sandboxed",
      "projects.create": "off",
    },
  },
  {
    id: "edit",
    label: "Can edit",
    summary: "Chat, read and change project files. No terminal, no secret files.",
    values: {
      "ai.agents": ALL_AGENTS,
      "files.level": "write",
      "files.secrets": "hidden",
      "files.folders": "",
      "compute.terminal": "off",
      "compute.mode": "sandboxed",
      "projects.create": "off",
    },
  },
  {
    id: "full",
    label: "Full access",
    summary: "Everything, including a terminal and secret files on the host.",
    values: {
      "ai.agents": ALL_AGENTS,
      "files.level": "write",
      "files.secrets": "granted",
      "files.folders": "",
      "compute.terminal": "on",
      "compute.mode": "unrestricted",
      "projects.create": "on",
    },
    warning: FULL_ACCESS_WARNING,
  },
  {
    id: "readonly",
    label: "Read only",
    summary: "Read files and watch. Cannot send, edit or run.",
    values: {
      "ai.agents": "",
      "files.level": "read",
      "files.secrets": "hidden",
      "files.folders": "",
      "compute.terminal": "off",
      "compute.mode": "sandboxed",
      "projects.create": "off",
    },
  },
];

export const DEFAULT_PRESET: PresetId = "edit";

export const presetDef = (id: PresetId): PresetDef =>
  ACCESS_PRESETS.find((preset) => preset.id === id) ?? ACCESS_PRESETS[1]!;

export const isPresetId = (value: unknown): value is PresetId =>
  typeof value === "string" && ACCESS_PRESETS.some((preset) => preset.id === value);

// ── Normalising and reading values ──────────────────────────────────────────

const parseAgents = (raw: unknown): ReadonlyArray<AccessAgent> => {
  if (typeof raw !== "string") return [];
  const named = new Set(raw.split(",").map((part) => part.trim()));
  return ACCESS_AGENTS.filter((agent) => named.has(agent));
};

/**
 * Always a complete, valid value set. Unknown or missing fields fall to the safest value (not
 * the preset's), so a damaged row never widens access. A terminal reaches every file the host
 * user can, so Compute On carries read-write files and secret files with it.
 */
export const normalizeZones = (raw: unknown): ZoneValues => {
  const input = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const agents = parseAgents(input["ai.agents"]);
  const rawLevel = input["files.level"];
  const level = rawLevel === "write" || rawLevel === "read" ? rawLevel : "none";
  const compute = input["compute.terminal"] === "on";
  const secrets = input["files.secrets"] === "granted" && level !== "none";
  return {
    "ai.agents": agents.join(","),
    "files.level": compute ? "write" : level,
    "files.secrets": compute || secrets ? "granted" : "hidden",
    "files.folders": parseFolders(input["files.folders"]).join("\n"),
    "compute.terminal": compute ? "on" : "off",
    // Sandboxed unless Unrestricted was chosen on purpose: a missing value never widens access.
    "compute.mode": compute && input["compute.mode"] === "unrestricted" ? "unrestricted" : "sandboxed",
    "projects.create": input["projects.create"] === "on" ? "on" : "off",
  };
};

/** The shared folders, one per line, trimmed and deduplicated; empty means the whole project. */
export const parseFolders = (raw: unknown): ReadonlyArray<string> =>
  typeof raw !== "string"
    ? []
    : [...new Set(raw.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0))].slice(0, 50);

export const zonesForPreset = (id: PresetId): ZoneValues => normalizeZones(presetDef(id).values);

/** The preset these values equal exactly, or "custom". */
export const presetOfZones = (values: ZoneValues): PresetId | "custom" => {
  const normalized = normalizeZones(values);
  for (const preset of ACCESS_PRESETS) {
    const candidate = normalizeZones(preset.values);
    if (ZONE_FIELDS.every((field) => candidate[field.id] === normalized[field.id])) {
      return preset.id;
    }
  }
  return "custom";
};

export const zoneAgents = (values: ZoneValues): ReadonlyArray<AccessAgent> =>
  parseAgents(values["ai.agents"]);

export const canUseAgent = (values: ZoneValues, agent: AccessAgent): boolean =>
  zoneAgents(values).includes(agent);
export const canUseAi = (values: ZoneValues): boolean => zoneAgents(values).length > 0;
export const canReadFiles = (values: ZoneValues): boolean => values["files.level"] !== "none";
export const canWriteFiles = (values: ZoneValues): boolean => values["files.level"] === "write";
export const canReadSecrets = (values: ZoneValues): boolean => values["files.secrets"] === "granted";
export const canCompute = (values: ZoneValues): boolean => values["compute.terminal"] === "on";
/** Compute is on without the sandbox: a shell as the host's user. */
export const isUnrestricted = (values: ZoneValues): boolean =>
  canCompute(values) && values["compute.mode"] === "unrestricted";
export const sharedFolders = (values: ZoneValues): ReadonlyArray<string> => parseFolders(values["files.folders"]);
export const canManageProjects = (values: ZoneValues): boolean => values["projects.create"] === "on";

/**
 * May this person change anything at all? When not, the seat is Read only: the `viewer` role of
 * old, derived from zones. Reads, subscriptions and marking threads seen stay open.
 */
export const canMutate = (values: ZoneValues): boolean =>
  canUseAi(values) || canWriteFiles(values) || canCompute(values);

/** What an agent run on someone's behalf may do. Derived from the same zones, never separate. */
export interface AgentLimits {
  /** Edit and write tools. */
  readonly edits: boolean;
  /** Shell and command tools. */
  readonly shell: boolean;
  /** Claude is told not to open secret files; other agents cannot be told. */
  readonly hideSecrets: boolean;
  /** The folders the agent's files are limited to (empty: the whole project). */
  readonly folders: ReadonlyArray<string>;
  /** Run the agent inside the OS sandbox (macOS): always unless Compute is Unrestricted. */
  readonly sandbox: boolean;
}

export const agentLimitsFor = (values: ZoneValues): AgentLimits => ({
  edits: canWriteFiles(values),
  shell: canCompute(values),
  hideSecrets: !canReadSecrets(values),
  folders: sharedFolders(values),
  sandbox: !isUnrestricted(values),
});

// ── Resolved access ─────────────────────────────────────────────────────────

/** Where a person's zones came from, strongest first. */
export type ZoneSource = "owner" | "seat" | "override" | "default" | "fallback";

export interface ResolvedZones {
  readonly preset: PresetId | "custom";
  readonly zones: ZoneValues;
  readonly source: ZoneSource;
}

/** Everything allowed: the project owner and the host operator. */
export const FULL_ZONES: ResolvedZones = {
  preset: "full",
  zones: zonesForPreset("full"),
  source: "owner",
};

export const resolvedFromValues = (values: unknown, source: ZoneSource): ResolvedZones => {
  const zones = normalizeZones(values);
  return { preset: presetOfZones(zones), zones, source };
};

/**
 * Who gets what. Precedence: owner (everything) > a Read only workspace seat > this person's
 * override on the project > the project's default (the share link's setting) > "Can edit".
 */
export const resolveZones = (input: {
  readonly isOwner: boolean;
  readonly viewerSeat: boolean;
  readonly override?: unknown;
  readonly projectDefault?: unknown;
}): ResolvedZones => {
  if (input.isOwner) return FULL_ZONES;
  if (input.viewerSeat) return resolvedFromValues(zonesForPreset("readonly"), "seat");
  if (input.override !== undefined && input.override !== null) {
    return resolvedFromValues(input.override, "override");
  }
  if (input.projectDefault !== undefined && input.projectDefault !== null) {
    return resolvedFromValues(input.projectDefault, "default");
  }
  return resolvedFromValues(zonesForPreset(DEFAULT_PRESET), "fallback");
};

/** A preset id or explicit values (Advanced) from a request body to normalized zones, else null. */
export const zonesFromInput = (input: {
  readonly preset?: unknown;
  readonly zones?: unknown;
}): ZoneValues | null => {
  if (isPresetId(input.preset)) return zonesForPreset(input.preset);
  if (input.zones !== null && typeof input.zones === "object") return normalizeZones(input.zones);
  return null;
};

/** Whether granting these values needs the blunt warning (a shell on the host). */
export const needsGrantWarning = (values: ZoneValues): boolean => isUnrestricted(values);

/** Words for the members' composer and refusals, one place. */
export const PROJECTS_OFF_MESSAGE =
  "Creating and changing projects is not on for you on this host. Ask the host to turn on Projects.";
export const NEW_WORKSPACE_MESSAGE = "New workspaces on your own computer are coming in the next update.";
export const AI_OFF_MESSAGE =
  "The host has not allowed you to use their agent here. Request it, or use your own login.";
export const COMPUTE_OFF_MESSAGE =
  "The terminal is off for you on this host. Ask the host to turn it on.";
export const FILES_OFF_MESSAGE = "Your access to this project does not include its files.";
export const FILES_READ_ONLY_MESSAGE =
  "You can read this project's files but not change them. Ask the host for edit access.";
export const SECRET_FILE_MESSAGE = "This file is hidden. Ask the host to allow secret files.";
