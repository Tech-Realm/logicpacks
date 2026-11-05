import { describe, expect, it } from "vite-plus/test";

import { helperVersion, isStandalone, selfLaunch, selfPath } from "./launcher.ts";

describe("launcher", () => {
  it("runs as a Node script in tests: node plus this script, version dev", () => {
    expect(isStandalone()).toBe(false);
    const launch = selfLaunch();
    expect(launch.command).toBe(process.execPath);
    expect(launch.args).toHaveLength(1);
    expect(selfPath()).toBe(launch.args[0]);
    expect(helperVersion()).toBe("dev");
  });
});
