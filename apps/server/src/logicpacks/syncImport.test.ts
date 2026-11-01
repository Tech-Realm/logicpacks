import { describe, expect, it } from "@effect/vitest";

import { syncFolderName } from "./syncImport.ts";

describe("syncFolderName", () => {
  it("lands every spelling of one GitHub repository in one folder", () => {
    expect(syncFolderName("git@github.com:Acme/App.git")).toBe("acme-app");
    expect(syncFolderName("https://github.com/acme/app")).toBe("acme-app");
    expect(syncFolderName("https://github.com/acme/app.git/")).toBe("acme-app");
  });

  it("refuses remotes it cannot name safely", () => {
    expect(syncFolderName("not a url")).toBeNull();
    expect(syncFolderName("https://github.com/acme/..")).toBeNull();
  });
});
