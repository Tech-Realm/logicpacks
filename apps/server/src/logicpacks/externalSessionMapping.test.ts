import { assert, describe, it } from "@effect/vitest";
import type { ThreadId } from "@logicpacks/contracts";
import * as DateTime from "effect/DateTime";

import { mapExternalEvent, matchProject, remoteKey } from "./externalSessionMapping.ts";

describe("remoteKey", () => {
  it("gives every spelling of one GitHub repository the same key", () => {
    const spellings = [
      "git@github.com:Acme/App.git",
      "https://github.com/acme/app",
      "https://github.com/acme/app.git/",
      "ssh://git@github.com/acme/app.git",
      "https://x-access-token:secret@github.com/acme/app",
    ];
    assert.deepStrictEqual(new Set(spellings.map(remoteKey)), new Set(["github.com/acme/app"]));
    assert.strictEqual(
      remoteKey("ssh://git@git.example.com:2222/team/app.git"),
      "git.example.com/team/app",
    );
    assert.strictEqual(remoteKey("not-a-remote"), null);
  });
});

describe("matchProject", () => {
  const candidates = [
    { id: "shop", workspaceRoot: "/work/shop", remoteKeys: ["github.com/acme/shop"] },
    { id: "api", workspaceRoot: "/work/shop/api", remoteKeys: [] },
    { id: "hosted", workspaceRoot: "/srv/acme-app", remoteKeys: ["github.com/acme/app"] },
  ];
  it("prefers the deepest folder, then the git remote, and never a sibling prefix", () => {
    assert.strictEqual(matchProject({ cwd: "/work/shop/api/src" }, candidates)?.id, "api");
    assert.strictEqual(matchProject({ cwd: "/work/shopping" }, candidates), null);
    assert.strictEqual(
      matchProject({ cwd: "/home/me/app", gitRemote: "git@github.com:acme/app.git" }, candidates)
        ?.id,
      "hosted",
    );
  });
});

describe("mapExternalEvent", () => {
  it("gives each file of a multi-file change its own item and keys the first by the event uid", () => {
    const items = mapExternalEvent({
      threadId: "external:codex:s1" as ThreadId,
      at: DateTime.makeUnsafe("2026-10-31T10:00:00.000Z"),
      roots: ["/repo"],
      event: {
        uid: "exec-1",
        at: "2026-10-31T10:00:00.000Z",
        type: "tool",
        tool: {
          name: "apply_patch",
          kind: "file_change",
          input: "",
          status: "completed",
          files: ["/repo/a.ts", "/repo/lib/b.ts"],
        },
      },
    });
    assert.deepStrictEqual(
      items.map((item) => {
        const turnItem = item.turnItem(1);
        return [item.key, turnItem.type === "file_change" ? turnItem.fileName : null];
      }),
      [
        ["exec-1", "a.ts"],
        ["exec-1#1", "lib/b.ts"],
      ],
    );
  });
});
