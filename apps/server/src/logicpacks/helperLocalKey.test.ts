// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { localKeyMatches, readOrCreateLocalHelperKey } from "./helperHttp.ts";

describe("the local helper key", () => {
  it("is created once, private to the owner, and stable across reads", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lp-local-key-"));
    const file = NodePath.join(dir, "userdata", "helper-local.key");
    const first = readOrCreateLocalHelperKey(file);
    expect(first).not.toBeNull();
    expect(first!.length).toBeGreaterThanOrEqual(32);
    expect(NodeFS.statSync(file).mode & 0o077).toBe(0);
    expect(readOrCreateLocalHelperKey(file)).toBe(first);
    NodeFS.rmSync(dir, { recursive: true, force: true });
  });

  it("matches only the exact key", () => {
    expect(localKeyMatches("abc", "abc")).toBe(true);
    expect(localKeyMatches("abc", "abd")).toBe(false);
    expect(localKeyMatches("abc", "abcd")).toBe(false);
    expect(localKeyMatches("abc", "")).toBe(false);
  });
});
