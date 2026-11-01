import * as NodeChildProcess from "node:child_process";

import type { SessionBatch } from "./events.ts";
import { discoverLocalHost, isLocalOrigin, NOT_CONNECTED } from "./localHost.ts";
import { loadConfig, saveConfig, type HelperConfig } from "./store.ts";

export class OfflineError extends Error {}
export class RejectedError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** POST or GET a host route with the helper's token. Network trouble is OfflineError; a refusal is RejectedError. */
export const callHost = async <A>(
  config: Pick<HelperConfig, "server" | "token">,
  path: string,
  options: { readonly body?: unknown; readonly timeoutMs?: number; readonly auth?: boolean } = {},
): Promise<A> => {
  try {
    return await callHostOnce<A>(config, path, options);
  } catch (error) {
    // The app picks a new port on some restarts: follow it once, then remember it.
    if (!(error instanceof OfflineError) || !isLocalOrigin(config.server)) throw error;
    const found = discoverLocalHost();
    if (found === null || found.origin === config.server?.replace(/\/+$/, "")) throw error;
    const result = await callHostOnce<A>({ ...config, server: found.origin }, path, options);
    try {
      const stored = loadConfig();
      if (isLocalOrigin(stored.server)) saveConfig({ ...stored, server: found.origin });
    } catch {}
    return result;
  }
};

const callHostOnce = async <A>(
  config: Pick<HelperConfig, "server" | "token">,
  path: string,
  options: { readonly body?: unknown; readonly timeoutMs?: number; readonly auth?: boolean } = {},
): Promise<A> => {
  if (!config.server) throw new RejectedError(0, NOT_CONNECTED);
  const headers: Record<string, string> = { accept: "application/json" };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.auth !== false && config.token) headers.authorization = `Bearer ${config.token}`;
  let response: Response;
  try {
    response = await fetch(new URL(path, config.server), {
      method: options.body === undefined ? "GET" : "POST",
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 8000),
    });
  } catch (cause) {
    throw new OfflineError(cause instanceof Error ? cause.message : String(cause));
  }
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (response.status >= 500) throw new OfflineError(`Host answered ${response.status}.`);
  if (!response.ok) {
    throw new RejectedError(
      response.status,
      String(payload.message ?? payload.error ?? `Host answered ${response.status}.`),
    );
  }
  return payload as A;
};

export type IngestResponse =
  | {
      readonly linked: true;
      readonly projectId: string;
      readonly threadId: string;
      readonly accepted: number;
      readonly duplicates: number;
    }
  | { readonly linked: false; readonly reason: string; readonly message: string };

export const sendBatch = (config: HelperConfig, batch: SessionBatch) =>
  callHost<IngestResponse>(config, "/api/lp/helper/ingest", { body: batch, timeoutMs: 15000 });

export interface GitInfo {
  readonly root: string | null;
  readonly remote: string | null;
  readonly branch: string | null;
}

const gitCache = new Map<string, GitInfo>();

const git = (cwd: string, args: ReadonlyArray<string>) => {
  try {
    return (
      NodeChildProcess.execFileSync("git", ["-C", cwd, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 3000,
      }).trim() || null
    );
  } catch {
    return null;
  }
};

/** The repository root, its origin (or first) remote, and branch, so the host can match the project. */
export const gitInfo = (cwd: string): GitInfo => {
  const cached = gitCache.get(cwd);
  if (cached) return cached;
  const root = git(cwd, ["rev-parse", "--show-toplevel"]);
  const firstRemote = root === null ? null : git(cwd, ["remote"])?.split("\n")[0];
  const remote =
    root === null
      ? null
      : (git(cwd, ["config", "--get", "remote.origin.url"]) ??
        (firstRemote ? git(cwd, ["config", "--get", `remote.${firstRemote}.url`]) : null));
  const branch = root === null ? null : git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const info = { root, remote, branch: branch === "HEAD" ? null : branch };
  gitCache.set(cwd, info);
  return info;
};
