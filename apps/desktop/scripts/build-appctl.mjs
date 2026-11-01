// Compiles lp-appctl (the app-sharing input helper) for release: a universal macOS binary.
//   node apps/desktop/scripts/build-appctl.mjs --output <dir>/lp-appctl
// The packaged app looks for it at Resources/lp-appctl (or Resources/lp-appctl/lp-appctl);
// development builds compile the same source into the app's user data on first use.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

const { values } = NodeUtil.parseArgs({ options: { output: { type: "string" } } });
if (!values.output) throw new Error("--output is required");
// oxlint-disable-next-line logicpacks/no-global-process-runtime -- standalone build script.
if (process.platform !== "darwin") throw new Error("lp-appctl builds on macOS only");

const { APPCTL_SWIFT_SOURCE } = await import("../src/appShare/appctl.swift.ts");
const work = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lp-appctl-"));
try {
  const source = NodePath.join(work, "appctl.swift");
  NodeFS.writeFileSync(source, APPCTL_SWIFT_SOURCE);
  const slices = ["arm64", "x86_64"].map((arch) => {
    const out = NodePath.join(work, `lp-appctl-${arch}`);
    NodeChildProcess.execFileSync(
      "/usr/bin/xcrun",
      ["swiftc", "-O", "-target", `${arch}-apple-macos12`, source, "-o", out],
      { stdio: "inherit" },
    );
    return out;
  });
  NodeFS.mkdirSync(NodePath.dirname(values.output), { recursive: true });
  NodeChildProcess.execFileSync("/usr/bin/lipo", ["-create", ...slices, "-output", values.output], {
    stdio: "inherit",
  });
  NodeFS.chmodSync(values.output, 0o755);
  console.log(`lp-appctl: ${values.output}`);
} finally {
  NodeFS.rmSync(work, { recursive: true, force: true });
}
