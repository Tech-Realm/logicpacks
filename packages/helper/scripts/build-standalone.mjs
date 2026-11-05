#!/usr/bin/env node
// Builds the standalone lp helper: one executable per platform with its own runtime
// (bun build --compile), so nothing on the user's machine needs Node.
//   node packages/helper/scripts/build-standalone.mjs [--target <t>|all] [--out <dir>] [--version <v>]
// Targets: darwin-arm64, darwin-x64, linux-x64, windows-x64. Output: <out>/lp-<target>[.exe].
// Needs bun on the build machine (not on the user's).
import { spawnSync } from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const TARGETS = ["darwin-arm64", "darwin-x64", "linux-x64", "windows-x64"];
const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const helperDir = NodePath.join(here, "..");
const repo = NodePath.join(helperDir, "../..");

const flag = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};

const version =
  flag("version") ??
  JSON.parse(NodeFS.readFileSync(NodePath.join(repo, "apps/desktop/package.json"), "utf8")).version;
const out = NodePath.resolve(flag("out", NodePath.join(helperDir, "dist", "standalone")));
const target = flag("target", "all");
const targets = target === "all" ? TARGETS : [target];
for (const t of targets) {
  if (!TARGETS.includes(t))
    throw new Error(`unknown target ${t}; use one of ${TARGETS.join(", ")}`);
}

NodeFS.mkdirSync(out, { recursive: true });
const bun = process.env.BUN ?? "bun";
for (const t of targets) {
  const outfile = NodePath.join(out, `lp-${t}${t.startsWith("windows") ? ".exe" : ""}`);
  const args = [
    "build",
    NodePath.join(helperDir, "src/cli.ts"),
    "--compile",
    "--minify",
    `--target=bun-${t}`,
    "--define",
    "LP_STANDALONE=true",
    "--define",
    `LP_VERSION=${JSON.stringify(version)}`,
    "--outfile",
    outfile,
  ];
  // bun writes Windows version info only when it compiles on Windows (the CI build does).
  if (t.startsWith("windows") && process.platform === "win32") {
    args.push("--windows-title=LogicPacks helper", `--windows-version=${version}.0`);
    args.push("--windows-description=LogicPacks helper (lp)", "--windows-publisher=LogicPacks");
  }
  // No shell: on Windows it would strip the quotes in LP_VERSION="x.y.z" (bun is bun.exe there).
  const result = spawnSync(bun, args, { stdio: "inherit", cwd: helperDir });
  if (result.status !== 0) {
    process.stderr.write(`bun build failed for ${t}\n`);
    process.exit(result.status ?? 1);
  }
  process.stdout.write(`built ${outfile}\n`);
}
