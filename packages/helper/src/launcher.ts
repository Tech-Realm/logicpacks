// oxlint-disable logicpacks/no-global-process-runtime -- plain CLI shipped as one file; there is no Effect runtime to inject.
import * as NodeFS from "node:fs";

/**
 * Set to true by `bun build --compile --define LP_STANDALONE=true` (scripts/build-standalone.mjs).
 * The standalone `lp` binary carries its own runtime, so nothing on the user's machine needs Node.
 */
declare const LP_STANDALONE: boolean | undefined;

export const isStandalone = () => typeof LP_STANDALONE !== "undefined" && LP_STANDALONE === true;

const real = (path: string) => {
  try {
    return NodeFS.realpathSync(path);
  } catch {
    return path;
  }
};

export interface SelfLaunch {
  /** The program to start. */
  readonly command: string;
  /** Arguments that come before the lp command itself (the script path when run by Node). */
  readonly args: ReadonlyArray<string>;
}

/** How to start this same lp again: the standalone binary itself, or Node with this script. */
export const selfLaunch = (): SelfLaunch =>
  isStandalone()
    ? { command: real(process.execPath), args: [] }
    : { command: process.execPath, args: [real(process.argv[1] ?? "lp")] };

/** The program path alone: the binary, or the script when Node runs it. */
export const selfPath = () => {
  const launch = selfLaunch();
  return launch.args[0] ?? launch.command;
};

/** Set by the standalone build (`--define LP_VERSION=...`); the Node script reports "dev". */
declare const LP_VERSION: string | undefined;

export const helperVersion = () => (typeof LP_VERSION === "string" ? LP_VERSION : "dev");
