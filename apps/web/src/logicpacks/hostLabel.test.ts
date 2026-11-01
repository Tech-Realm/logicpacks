import { describe, expect, it } from "vite-plus/test";

import type { LpSession } from "./api";
import { lpHostLabelFor } from "./store";

const base: LpSession = {
  user: null,
  operator: true,
  cloudHost: false,
  workspaces: [
    { workspaceId: "w1", name: "Acme", role: "owner" } as LpSession["workspaces"][number],
  ],
  currentWorkspaceId: "w1",
  claude: null,
  templates: [],
};
const member = { ...base, operator: false, user: { userId: "u1" } as LpSession["user"] };

describe("lpHostLabelFor", () => {
  it("keeps the desktop owner's own machine name", () => {
    expect(lpHostLabelFor(base)).toBeNull();
    expect(lpHostLabelFor(null)).toBeNull();
  });
  it("names a host members see after the workspace", () => {
    expect(lpHostLabelFor(member)).toBe("Acme cloud");
    expect(lpHostLabelFor({ ...base, cloudHost: true })).toBe("Acme cloud");
  });
  it("prefers LOGICPACKS_HOST_LABEL", () => {
    expect(lpHostLabelFor({ ...member, hostLabel: "Studio box" })).toBe("Studio box");
  });
});
