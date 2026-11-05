import { describe, expect, it } from "vite-plus/test";

import { resolveOnboardingProviderInstallCommand } from "../onboarding/providerReadiness.logic";
import { localAgentPlatform } from "./LocalAgents";

describe("localAgentPlatform", () => {
  it("follows the app server's OS", () => {
    expect(localAgentPlatform("windows")).toBe("windows");
    expect(localAgentPlatform("darwin", "Windows NT")).toBe("posix");
    expect(localAgentPlatform("linux")).toBe("posix");
  });

  it("falls back to the browser's OS before the server config loads", () => {
    expect(localAgentPlatform(undefined, "Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe(
      "windows",
    );
    expect(localAgentPlatform(undefined, "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)")).toBe(
      "posix",
    );
  });

  it("shows native installers that need no Node or npm", () => {
    for (const driver of ["claudeAgent", "codex"] as const) {
      for (const os of ["windows", "darwin"] as const) {
        expect(resolveOnboardingProviderInstallCommand(driver, os)).not.toMatch(/npm|node/);
      }
    }
    expect(resolveOnboardingProviderInstallCommand("codex", "windows")).toMatch(/\| iex$/);
  });
});
