import { zonesForPreset } from "@logicpacks/contracts";
import { describe, expect, it } from "vite-plus/test";

import { composerAccess, isOwnLoginInstance } from "./accessZones.logic";
import type { LpSeat, LpSession } from "./api";
import { isReadOnlyIn } from "./readOnly.logic";

const seat = (preset: "chat" | "edit" | "full" | "readonly", zones = zonesForPreset(preset)): LpSeat => ({
  preset,
  zones,
  source: "override",
});
const session = (access: Record<string, LpSeat>) =>
  ({
    user: { userId: "bo", email: "bo@x", displayName: "Bo" },
    workspaces: [],
    currentWorkspaceId: null,
    access,
  }) as unknown as LpSession;

describe("composerAccess", () => {
  const claude = { instanceId: "claudeAgent", driver: "claudeAgent" };
  it("says plainly whose Claude runs the message", () => {
    expect(composerAccess(session({ p: seat("edit") }), "p", claude)).toEqual({
      kind: "host",
      text: "Using host's Claude",
    });
  });
  it("names the agent: Codex", () => {
    expect(composerAccess(session({ p: seat("edit") }), "p", { instanceId: "codex", driver: "codex" })).toEqual({
      kind: "host",
      text: "Using host's Codex",
    });
  });
  it("offers the request when the AI zone does not lend the agent", () => {
    const result = composerAccess(
      session({ p: seat("edit", { ...zonesForPreset("edit"), "ai.agents": "codex" }) }),
      "p",
      claude,
    );
    expect(result.kind).toBe("request");
  });
  it("their own login is theirs and never needs a request", () => {
    const own = { instanceId: "claude-lp-0123456789abcdef", driver: "claudeAgent" };
    expect(isOwnLoginInstance(own.instanceId)).toBe(true);
    expect(composerAccess(session({ p: seat("readonly") }), "p", own).kind).toBe("own");
  });
  it("shows nothing to the host", () => {
    expect(composerAccess({ ...session({}), user: null }, "p", claude).kind).toBe("none");
  });
});

describe("isReadOnlyIn from the member's seat", () => {
  it("Read only is derived from the zones the server sent", () => {
    expect(isReadOnlyIn(session({ p: seat("readonly") }), "p")).toBe(true);
    expect(isReadOnlyIn(session({ p: seat("chat") }), "p")).toBe(false);
    expect(isReadOnlyIn(session({ p: seat("full") }), "p")).toBe(false);
  });
});
