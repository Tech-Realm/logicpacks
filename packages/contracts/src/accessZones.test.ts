import { describe, expect, it } from "vite-plus/test";

import {
  ACCESS_PRESETS,
  ACCESS_ZONES,
  agentForDriver,
  agentLimitsFor,
  canCompute,
  isUnrestricted,
  sharedFolders,
  canManageProjects,
  canMutate,
  canReadFiles,
  canReadSecrets,
  canUseAgent,
  canUseAi,
  canWriteFiles,
  DEFAULT_PRESET,
  FULL_ZONES,
  needsGrantWarning,
  normalizeZones,
  presetOfZones,
  resolveZones,
  zonesForPreset,
  zonesFromInput,
  ZONE_FIELDS,
} from "./accessZones.ts";

describe("access zone registry", () => {
  it("every preset covers every registered field with a registered option", () => {
    for (const preset of ACCESS_PRESETS) {
      for (const field of ZONE_FIELDS) {
        const value = preset.values[field.id];
        expect(value, `${preset.id}.${field.id}`).toBeDefined();
        if (field.kind === "choice") {
          expect(field.options.map((option) => option.value)).toContain(value);
        } else {
          for (const part of value.split(",").filter(Boolean)) {
            expect(field.options.map((option) => option.value)).toContain(part);
          }
        }
      }
    }
    expect(ACCESS_ZONES.map((zone) => zone.id)).toEqual(["ai", "files", "compute", "projects"]);
    expect(ACCESS_ZONES.every((zone) => zone.guarantee.length > 20)).toBe(true);
  });

  it("states the compute limit plainly", () => {
    const compute = ACCESS_ZONES.find((zone) => zone.id === "compute")!;
    expect(compute.guarantee).toContain(
      "Off blocks the terminal and the agent's shell tool. It cannot stop an agent you let edit files from writing code that someone later runs.",
    );
  });
});

describe("presets resolve to zones", () => {
  it("Chat only: AI, no files, no compute", () => {
    const z = zonesForPreset("chat");
    expect(canUseAi(z)).toBe(true);
    expect(canReadFiles(z)).toBe(false);
    expect(canCompute(z)).toBe(false);
    expect(canMutate(z)).toBe(true);
    expect(agentLimitsFor(z)).toEqual({ edits: false, shell: false, hideSecrets: true, folders: [], sandbox: true });
  });

  it("Can edit is the default: AI on, files read-write, no secrets, no compute", () => {
    expect(DEFAULT_PRESET).toBe("edit");
    const z = zonesForPreset("edit");
    expect(canUseAgent(z, "claude")).toBe(true);
    expect(canWriteFiles(z)).toBe(true);
    expect(canReadSecrets(z)).toBe(false);
    expect(canCompute(z)).toBe(false);
    expect(agentLimitsFor(z)).toEqual({ edits: true, shell: false, hideSecrets: true, folders: [], sandbox: true });
  });

  it("Full access needs the warning and carries secrets and compute", () => {
    const z = zonesForPreset("full");
    expect(canCompute(z) && canReadSecrets(z) && canWriteFiles(z)).toBe(true);
    expect(needsGrantWarning(z)).toBe(true);
    expect(needsGrantWarning(zonesForPreset("edit"))).toBe(false);
  });

  it("Read only is the old viewer: reads, cannot mutate", () => {
    const z = zonesForPreset("readonly");
    expect(canReadFiles(z)).toBe(true);
    expect(canUseAi(z)).toBe(false);
    expect(canMutate(z)).toBe(false);
  });

  it("round-trips presets and reports custom for anything else", () => {
    for (const preset of ACCESS_PRESETS) {
      expect(presetOfZones(zonesForPreset(preset.id))).toBe(preset.id);
    }
    expect(presetOfZones(normalizeZones({ ...zonesForPreset("edit"), "ai.agents": "claude" }))).toBe(
      "custom",
    );
  });
});

describe("normalizeZones", () => {
  it("falls to the safest value for damaged input", () => {
    const z = normalizeZones({ "files.level": "root", "ai.agents": "claude,evil", junk: 1 });
    expect(z).toEqual({
      "ai.agents": "claude",
      "files.level": "none",
      "files.secrets": "hidden",
      "files.folders": "",
      "compute.terminal": "off",
      "compute.mode": "sandboxed",
      "projects.create": "off",
    });
    expect(normalizeZones(null)["files.level"]).toBe("none");
    expect(canMutate(normalizeZones(undefined))).toBe(false);
  });

  it("compute carries read-write files and secrets (a shell reaches both)", () => {
    const z = normalizeZones({ "compute.terminal": "on", "files.level": "none" });
    expect(z["files.level"]).toBe("write");
    expect(z["files.secrets"]).toBe("granted");
  });

  it("secret files need file access at all", () => {
    expect(normalizeZones({ "files.level": "none", "files.secrets": "granted" })["files.secrets"]).toBe(
      "hidden",
    );
  });
});

describe("folders and the compute mode", () => {
  it("Full access is Unrestricted and needs the warning; Sandboxed compute does not", () => {
    expect(isUnrestricted(zonesForPreset("full"))).toBe(true);
    const sandboxed = normalizeZones({ ...zonesForPreset("full"), "compute.mode": "sandboxed" });
    expect(canCompute(sandboxed)).toBe(true);
    expect(isUnrestricted(sandboxed)).toBe(false);
    expect(needsGrantWarning(sandboxed)).toBe(false);
    expect(needsGrantWarning(zonesForPreset("full"))).toBe(true);
    expect(agentLimitsFor(sandboxed).sandbox).toBe(true);
    expect(agentLimitsFor(zonesForPreset("full")).sandbox).toBe(false);
  });
  it("a missing mode is Sandboxed, never Unrestricted", () => {
    expect(normalizeZones({ "compute.terminal": "on" })["compute.mode"]).toBe("sandboxed");
    expect(normalizeZones({ "compute.terminal": "off", "compute.mode": "unrestricted" })["compute.mode"]).toBe("sandboxed");
  });
  it("shared folders are one per line, trimmed, and empty means the whole project", () => {
    expect(sharedFolders(normalizeZones({ "files.folders": " docs \n\nsrc/app\ndocs\n/Users/x/other " }))).toEqual(["docs", "src/app", "/Users/x/other"]);
    expect(sharedFolders(zonesForPreset("edit"))).toEqual([]);
  });
});

describe("projects zone", () => {
  it("is off for Chat only, Can edit and Read only, on for Full access", () => {
    expect(canManageProjects(zonesForPreset("chat"))).toBe(false);
    expect(canManageProjects(zonesForPreset("edit"))).toBe(false);
    expect(canManageProjects(zonesForPreset("readonly"))).toBe(false);
    expect(canManageProjects(zonesForPreset("full"))).toBe(true);
  });
  it("a missing value is off (safe) and does not change the preset otherwise", () => {
    const { "projects.create": _drop, ...rest } = zonesForPreset("edit");
    expect(normalizeZones(rest)["projects.create"]).toBe("off");
    expect(presetOfZones(normalizeZones(rest))).toBe("edit");
  });
});

describe("resolveZones precedence", () => {
  const edit = zonesForPreset("edit");
  const chat = zonesForPreset("chat");
  it("owner beats everything", () => {
    expect(resolveZones({ isOwner: true, viewerSeat: true, override: chat })).toEqual(FULL_ZONES);
  });
  it("a Read only workspace seat beats an override and the default (viewer equivalence)", () => {
    const resolved = resolveZones({ isOwner: false, viewerSeat: true, override: edit });
    expect(resolved.preset).toBe("readonly");
    expect(resolved.source).toBe("seat");
    expect(canMutate(resolved.zones)).toBe(false);
  });
  it("a per-member override beats the share link default", () => {
    const resolved = resolveZones({ isOwner: false, viewerSeat: false, override: chat, projectDefault: edit });
    expect(resolved.preset).toBe("chat");
    expect(resolved.source).toBe("override");
  });
  it("the share link default applies when there is no override", () => {
    const resolved = resolveZones({ isOwner: false, viewerSeat: false, projectDefault: zonesForPreset("full") });
    expect(resolved.preset).toBe("full");
    expect(resolved.source).toBe("default");
  });
  it("falls back to Can edit with nothing set", () => {
    const resolved = resolveZones({ isOwner: false, viewerSeat: false });
    expect(resolved.preset).toBe("edit");
    expect(resolved.source).toBe("fallback");
  });
});

describe("input and drivers", () => {
  it("accepts a preset id or explicit values, nothing else", () => {
    expect(zonesFromInput({ preset: "chat" })).toEqual(zonesForPreset("chat"));
    expect(zonesFromInput({ zones: { "compute.terminal": "on" } })?.["compute.terminal"]).toBe("on");
    expect(zonesFromInput({ preset: "nope" })).toBeNull();
    expect(zonesFromInput({})).toBeNull();
  });
  it("maps driver kinds and instance ids to the lendable agents", () => {
    expect(agentForDriver("claudeAgent")).toBe("claude");
    expect(agentForDriver("claude-lp-0123456789abcdef")).toBe("claude");
    expect(agentForDriver("codex")).toBe("codex");
    expect(agentForDriver("opencode")).toBe("opencode");
    expect(agentForDriver("cursor")).toBeNull();
  });
});
