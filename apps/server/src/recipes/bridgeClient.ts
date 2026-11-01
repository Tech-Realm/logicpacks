// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - a line-delimited socket client used from plain async MCP and CLI code.
/**
 * Talks to an app recipe's in-app bridge: one JSON object per line over a
 * loopback socket. The bridge writes its port to `<session>/bridge.json`.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";

import type { RecipeActor } from "@logicpacks/contracts";

export interface BridgeInfo {
  readonly port: number;
  readonly pid?: number;
  readonly file?: string | null;
  /** Every request carries it; the bridge refuses anything without. */
  readonly token?: string;
}

export class BridgeError extends Error {
  override readonly name = "BridgeError";
}

export async function readBridgeInfo(session: string): Promise<BridgeInfo | null> {
  try {
    const parsed = JSON.parse(
      await NodeFSP.readFile(NodePath.join(session, "bridge.json"), "utf8"),
    ) as BridgeInfo;
    return typeof parsed.port === "number" ? parsed : null;
  } catch {
    return null;
  }
}

export interface BridgeClient {
  readonly call: (
    cmd: string,
    args?: Record<string, unknown>,
    actor?: RecipeActor,
  ) => Promise<unknown>;
  readonly close: () => void;
}

/** Connects to a bridge by its bridge.json (preferred: carries the token) or a bare port. */
export async function connectBridge(
  target: number | BridgeInfo,
  options: { readonly timeoutMs?: number } = {},
): Promise<BridgeClient> {
  const port = typeof target === "number" ? target : target.port;
  const token = typeof target === "number" ? undefined : target.token;
  const socket: NodeNet.Socket = await new Promise((resolve, reject) => {
    const candidate = NodeNet.createConnection({ host: "127.0.0.1", port }, () =>
      resolve(candidate),
    );
    candidate.once("error", reject);
  });
  socket.setEncoding("utf8");
  const timeoutMs = options.timeoutMs ?? 60_000;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  let buffer = "";
  let nextId = 1;

  const failAll = (error: Error) => {
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  };
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (line.length === 0) continue;
      let reply: { id?: number; ok?: boolean; result?: unknown; error?: string };
      try {
        reply = JSON.parse(line);
      } catch {
        continue;
      }
      const waiter = reply.id === undefined ? undefined : pending.get(reply.id);
      if (!waiter || reply.id === undefined) continue;
      pending.delete(reply.id);
      if (reply.ok) waiter.resolve(reply.result);
      else waiter.reject(new BridgeError(reply.error ?? "The bridge refused the request."));
    }
  });
  socket.on("error", (error) => failAll(new BridgeError(error.message)));
  socket.on("close", () => failAll(new BridgeError("The bridge closed the connection.")));

  return {
    call: (cmd, args = {}, actor) =>
      new Promise((resolve, reject) => {
        const id = nextId++;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new BridgeError(`The bridge did not answer ${cmd} within ${timeoutMs} ms.`));
        }, timeoutMs);
        pending.set(id, {
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        });
        socket.write(
          `${JSON.stringify({ id, cmd, args, ...(actor ? { actor } : {}), ...(token ? { token } : {}) })}\n`,
        );
      }),
    close: () => socket.end(),
  };
}

/** Wait for a freshly started bridge to write its port, then connect. */
export async function waitForBridge(
  session: string,
  options: { readonly timeoutMs?: number; readonly pollMs?: number } = {},
): Promise<BridgeClient> {
  const deadline = Date.now() + (options.timeoutMs ?? 60_000);
  let lastError: unknown;
  while (Date.now() < deadline) {
    const info = await readBridgeInfo(session);
    if (info) {
      try {
        return await connectBridge(info);
      } catch (error) {
        lastError = error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 250));
  }
  throw new BridgeError(
    `No bridge answered in ${session}${lastError instanceof Error ? `: ${lastError.message}` : "."}`,
  );
}
