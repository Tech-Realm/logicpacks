import { assert, describe, it } from "@effect/vitest";
import { acpPermissionDisposition } from "@logicpacks/provider-acp/server/clientPolicy";

import { claudeDisallowedToolsForLimits, claudeRuntimeQueryPolicyForRuntimePolicy } from "./ClaudeAdapterV2.ts";

const limits = (over: Partial<{ edits: boolean; shell: boolean; hideSecrets: boolean }>) => ({
  edits: false,
  shell: false,
  hideSecrets: true,
  secretGlobs: [".env", ".env.*", "*.pem", "secrets/"],
  ...over,
});

describe("zone limits reach the agents", () => {
  it("Claude: no shell tool without Compute, no edit tools without file writes", () => {
    const chat = claudeDisallowedToolsForLimits(limits({})) ?? [];
    for (const tool of ["Bash", "BashOutput", "Edit", "Write", "NotebookEdit"]) {
      assert.include(chat, tool);
    }
    const edit = claudeDisallowedToolsForLimits(limits({ edits: true })) ?? [];
    assert.include(edit, "Bash");
    assert.notInclude(edit, "Edit");
    assert.include(edit, "Edit(**/t3.json)");
    assert.include(edit, "Read(**/.env)");
    assert.include(edit, "Read(**/secrets/**)");
    const full = claudeDisallowedToolsForLimits(limits({ edits: true, shell: true, hideSecrets: false }));
    assert.isUndefined(full);
    assert.isUndefined(claudeDisallowedToolsForLimits(undefined));
  });

  it("Claude: the limit holds in bypass mode and reaches the query policy", () => {
    const policy = claudeRuntimeQueryPolicyForRuntimePolicy({
      runtimeMode: "full-access",
      interactionMode: "default",
      cwd: "/p",
      toolLimits: limits({ edits: true }),
    });
    assert.strictEqual(policy.permissionMode, "bypassPermissions");
    assert.include(policy.disallowedTools ?? [], "Bash");
  });

  it("ACP agents: a command or edit they ask to run is refused whatever the approval mode", () => {
    const request = (kind: string) => ({ toolCall: { kind, locations: [{ path: "/p/a.txt" }] } }) as never;
    const base = { runtimeMode: "full-access" as const, cwd: "/p" };
    assert.strictEqual(acpPermissionDisposition({ ...base, toolLimits: { edits: true, shell: false } }, request("execute")), "deny");
    assert.strictEqual(acpPermissionDisposition({ ...base, toolLimits: { edits: false, shell: false } }, request("edit")), "deny");
    assert.strictEqual(acpPermissionDisposition({ ...base, toolLimits: { edits: true, shell: false } }, request("edit")), "allow");
    assert.strictEqual(acpPermissionDisposition(base, request("execute")), "allow");
  });
});
