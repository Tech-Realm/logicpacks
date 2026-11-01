import { parseNewThreadLink, promptLinkAppPath } from "@logicpacks/shared/promptLinks";
import { describe, expect, it } from "vite-plus/test";

import {
  buildOpenOnMacLink,
  cloneCommands,
  filesFromInput,
  formatBytes,
  isExternalFileDrag,
  joinUploadPath,
  OPEN_ON_MAC_PROMPT,
  syncDelayText,
  uploadQuery,
} from "./projectFiles.logic";

describe("open on Mac link", () => {
  it("is a desktop /new link the app already understands", () => {
    const link = buildOpenOnMacLink("acme/team-site")!;
    expect(link.startsWith("logicpacks://new?")).toBe(true);
    const appPath = promptLinkAppPath(link);
    expect(appPath).not.toBeNull();
    const parsed = parseNewThreadLink(new URL(appPath!, "https://x.invalid").search);
    expect(parsed).toEqual({
      ok: true,
      value: {
        kind: "new",
        prompt: { text: OPEN_ON_MAC_PROMPT, hiddenCharacters: 0 },
        repository: { owner: "acme", name: "team-site" },
        provider: null,
        model: null,
      },
    });
  });

  it("uses the development scheme when asked and refuses non-repositories", () => {
    expect(buildOpenOnMacLink("a/b", "logicpacks-dev")?.startsWith("logicpacks-dev://new?")).toBe(
      true,
    );
    expect(buildOpenOnMacLink("not a repo")).toBeNull();
    expect(buildOpenOnMacLink("a/b/c")).toBeNull();
  });
});

describe("sync wording", () => {
  it("says how soon a push shows up on the host", () => {
    expect(syncDelayText(120)).toBe("within 2 minutes");
    expect(syncDelayText(60)).toBe("within 1 minute");
    expect(syncDelayText(20)).toBe("within 20 seconds");
    expect(syncDelayText(0)).toBe("after the next sync");
  });

  it("builds the clone commands", () => {
    expect(
      cloneCommands({
        title: "Team site",
        githubRepo: "acme/site",
        cloneUrl: "https://github.com/acme/site.git",
      }),
    ).toEqual({
      lpClone: "lp clone acme/site",
      gitClone: "git clone https://github.com/acme/site.git",
    });
    expect(cloneCommands({ title: "My App", githubRepo: null, cloneUrl: null })).toEqual({
      lpClone: 'lp clone "My App"',
      gitClone: null,
    });
  });
});

describe("upload helpers", () => {
  it("joins folder and path", () => {
    expect(joinUploadPath("assets/", "/img/a.png")).toBe("assets/img/a.png");
    expect(joinUploadPath("", "a.txt")).toBe("a.txt");
    expect(joinUploadPath("./x", "y\\z.txt")).toBe("x/y/z.txt");
  });

  it("builds the request query", () => {
    const query = new URLSearchParams(
      uploadQuery({ projectId: "p 1", folder: "a b", path: "c&d.txt", conflict: "keep-both" }),
    );
    expect(Object.fromEntries(query)).toEqual({
      projectId: "p 1",
      folder: "a b",
      path: "c&d.txt",
      conflict: "keep-both",
    });
  });

  it("keeps the folder structure of a picked folder", () => {
    const file = new File(["x"], "a.txt");
    Object.defineProperty(file, "webkitRelativePath", { value: "site/img/a.txt" });
    const loose = new File(["y"], "b.txt");
    const list = [file, loose] as unknown as FileList;
    expect(filesFromInput(list).map((item) => item.path)).toEqual(["site/img/a.txt", "b.txt"]);
  });

  it("tells file drags from other drags", () => {
    expect(isExternalFileDrag({ types: ["Files"] } as unknown as DataTransfer)).toBe(true);
    expect(isExternalFileDrag({ types: ["text/plain"] } as unknown as DataTransfer)).toBe(false);
    expect(isExternalFileDrag(null)).toBe(false);
  });

  it("formats sizes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});
