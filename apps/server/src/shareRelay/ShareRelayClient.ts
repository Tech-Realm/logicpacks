// Plain Node transport (sockets, timers); it is not Effect code.
// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off globalRandom:off globalConsole:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import * as NodePath from "node:path";

import {
  GENERIC_PAGE,
  classifyRelayedRequest,
  headersForLocalServer,
  headersForVisitor,
} from "./gateway.ts";
import { T, decodeFrame, encodeFrame, parseJsonBytes } from "./protocol.ts";

export const DEFAULT_SHARE_RELAY_URL = "wss://relay.logicpacks.io/connect";

export type ShareRelayState = "off" | "connecting" | "connected" | "retrying";

export interface ShareRelayStatus {
  readonly state: ShareRelayState;
  /** `https://<id>.logicpacks.io` once the relay accepted this host; null until then. */
  readonly origin: string | null;
  readonly error: string | null;
  readonly liveStreams: number;
}

export interface ShareRelayIdentity {
  readonly id: string;
  readonly secret: string;
}

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** 128 random bits as 26 base32 characters: a DNS label nobody can guess. */
export const newHostId = (): string => {
  const bytes = NodeCrypto.randomBytes(16);
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
};

export const readOrCreateIdentity = (file: string): ShareRelayIdentity => {
  try {
    const parsed = JSON.parse(NodeFS.readFileSync(file, "utf8")) as Partial<ShareRelayIdentity>;
    if (typeof parsed.id === "string" && /^[a-z2-7]{26}$/.test(parsed.id) && typeof parsed.secret === "string" && parsed.secret.length >= 32) {
      return { id: parsed.id, secret: parsed.secret };
    }
  } catch {}
  const identity = { id: newHostId(), secret: NodeCrypto.randomBytes(32).toString("base64url") };
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
  NodeFS.writeFileSync(file, JSON.stringify(identity), { mode: 0o600 });
  return identity;
};

export interface ShareRelayClientOptions {
  readonly relayUrl: string;
  /** Port of this app's own server; read at connect time so a restart on another port still works. */
  readonly localPort: () => number;
  readonly identity: () => ShareRelayIdentity;
  readonly sessionCookieName: () => string | null;
  readonly onChange?: (status: ShareRelayStatus) => void;
  readonly log?: (message: string) => void;
  readonly connectTimeoutMs?: number;
  readonly maxBackoffMs?: number;
}

const HIGH_WATER = 8 * 1024 * 1024;
const LOW_WATER = 1024 * 1024;

type Local =
  | {
      kind: "http";
      /** Null while the visitor's session is being checked; body frames wait in `queue`. */
      req: NodeHttp.ClientRequest | null;
      res: NodeHttp.IncomingMessage | null;
      ended: boolean;
      queue: Uint8Array[];
    }
  | { kind: "upgrade"; req: NodeHttp.ClientRequest | null; socket: NodeNet.Socket | null };

export class ShareRelayClient {
  private readonly options: ShareRelayClientOptions;
  private ws: WebSocket | null = null;
  private wanted = false;
  private state: ShareRelayState = "off";
  private origin: string | null = null;
  private publicHost: string | null = null;
  private error: string | null = null;
  private attempt = 0;
  private retryTimer: NodeJS.Timeout | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  private lastRx = 0;
  private readonly streams = new Map<number, Local>();
  /** The public origin is https whenever the relay is reached over wss; plain ws is a local test relay. */
  private readonly secureCookies: boolean;

  constructor(options: ShareRelayClientOptions) {
    this.options = options;
    this.secureCookies = options.relayUrl.startsWith("wss:");
  }

  status(): ShareRelayStatus {
    return { state: this.state, origin: this.origin, error: this.error, liveStreams: this.streams.size };
  }

  /** Connects (and keeps reconnecting) until `stop`. Safe to call repeatedly. */
  start() {
    if (this.wanted) return;
    this.wanted = true;
    this.attempt = 0;
    this.connect();
  }

  /**
   * Sharing is off: tell the relay to forget the tunnel (`forget`, the default: visitors see "no longer
   * active"), drop every live relayed request and socket right now, and stop reconnecting. Without
   * `forget` (the app is quitting) the relay keeps the id and visitors see "offline". `bye` is best
   * effort; closing the socket is what cuts access.
   */
  stop(options: { readonly forget?: boolean } = {}) {
    const forget = options.forget ?? true;
    this.wanted = false;
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const ws = this.ws;
    this.ws = null;
    this.destroyAllStreams();
    if (ws !== null) {
      try {
        if (forget && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "bye" }));
      } catch {}
      try {
        ws.close(1000, "bye");
      } catch {}
    }
    this.clearWatchdog();
    this.setState("off", null, null);
  }

  private setState(state: ShareRelayState, origin: string | null, error: string | null) {
    this.state = state;
    this.origin = origin;
    this.error = error;
    this.options.onChange?.(this.status());
  }

  private connect() {
    if (!this.wanted) return;
    this.setState(this.attempt === 0 ? "connecting" : "retrying", null, this.error);
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.options.relayUrl);
    } catch (cause) {
      this.fail(cause instanceof Error ? cause.message : "bad relay url");
      return;
    }
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    const timeout = setTimeout(() => {
      try {
        ws.close();
      } catch {}
    }, this.options.connectTimeoutMs ?? 12_000);
    ws.addEventListener("open", () => {
      const identity = this.options.identity();
      ws.send(JSON.stringify({ t: "hello", v: 1, id: identity.id, secret: identity.secret }));
    });
    ws.addEventListener("message", (event) => {
      this.lastRx = Date.now();
      const data = event.data;
      if (typeof data === "string") {
        this.onControl(ws, timeout, data);
        return;
      }
      const frame = decodeFrame(data as ArrayBuffer);
      if (frame !== null && this.ws === ws) this.onFrame(frame.type, frame.id, frame.payload);
    });
    ws.addEventListener("error", () => {});
    ws.addEventListener("close", () => {
      clearTimeout(timeout);
      if (this.ws !== ws) return;
      this.ws = null;
      this.destroyAllStreams();
      this.clearWatchdog();
      if (this.wanted) this.fail(this.error ?? "relay connection closed");
    });
  }

  private onControl(ws: WebSocket, timeout: NodeJS.Timeout, text: string) {
    let msg: { t?: string; host?: string; code?: string };
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.t === "ready" && typeof msg.host === "string") {
      clearTimeout(timeout);
      this.attempt = 0;
      this.publicHost = msg.host;
      this.lastRx = Date.now();
      this.watchdog = setInterval(() => {
        if (Date.now() - this.lastRx > 70_000) {
          try {
            ws.close();
          } catch {}
        }
      }, 15_000);
      this.watchdog.unref?.();
      this.setState("connected", `https://${msg.host}`, null);
      this.options.log?.(`share relay connected as ${msg.host.slice(0, 6)}...`);
    } else if (msg.t === "ping") {
      try {
        ws.send(JSON.stringify({ t: "pong" }));
      } catch {}
    } else if (msg.t === "error") {
      this.error = msg.code === "id_taken" ? "The relay refused this host id." : `The relay answered ${msg.code ?? "an error"}.`;
    }
  }

  private fail(message: string) {
    this.setState("retrying", null, message);
    this.attempt += 1;
    const delay = Math.min(this.options.maxBackoffMs ?? 30_000, 1000 * 2 ** Math.min(this.attempt - 1, 5)) * (0.75 + Math.random() * 0.5);
    this.retryTimer = setTimeout(() => this.connect(), delay);
    this.retryTimer.unref?.();
  }

  private clearWatchdog() {
    if (this.watchdog !== null) clearInterval(this.watchdog);
    this.watchdog = null;
  }

  private send(frame: Uint8Array): boolean {
    const ws = this.ws;
    if (ws === null || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(frame);
    return true;
  }

  private waitDrain(resume: () => void) {
    const tick = () => {
      const ws = this.ws;
      if (ws === null || ws.readyState !== WebSocket.OPEN || ws.bufferedAmount < LOW_WATER) resume();
      else setTimeout(tick, 5);
    };
    setTimeout(tick, 5);
  }

  private destroyAllStreams() {
    for (const local of this.streams.values()) {
      try {
        if (local.kind === "http") {
          local.req?.destroy();
          local.res?.destroy();
        } else {
          local.req?.destroy();
          local.socket?.destroy();
        }
      } catch {}
    }
    this.streams.clear();
  }

  private onFrame(type: number, id: number, payload: Uint8Array) {
    switch (type) {
      case T.REQ_HEAD:
        return this.onRequest(id, payload, false);
      case T.UPG_REQ:
        return this.onRequest(id, payload, true);
      case T.REQ_BODY: {
        const local = this.streams.get(id);
        if (local?.kind !== "http" || local.ended) return;
        if (local.req === null) {
          local.queue.push(payload.slice());
          return;
        }
        const req = local.req;
        if (!req.write(payload)) {
          this.send(encodeFrame(T.PAUSE, id));
          req.once("drain", () => this.send(encodeFrame(T.RESUME, id)));
        }
        return;
      }
      case T.REQ_END: {
        const local = this.streams.get(id);
        if (local?.kind !== "http") return;
        local.ended = true;
        local.req?.end();
        return;
      }
      case T.RAW: {
        const local = this.streams.get(id);
        if (local?.kind !== "upgrade" || local.socket === null) return;
        if (!local.socket.write(payload)) {
          this.send(encodeFrame(T.PAUSE, id));
          local.socket.once("drain", () => this.send(encodeFrame(T.RESUME, id)));
        }
        return;
      }
      case T.ABORT:
      case T.RAW_END: {
        const local = this.streams.get(id);
        if (local === undefined) return;
        this.streams.delete(id);
        try {
          local.req?.destroy();
          if (local.kind === "http") local.res?.destroy();
          else local.socket?.destroy();
        } catch {}
        return;
      }
      case T.PAUSE: {
        const local = this.streams.get(id);
        if (local?.kind === "http") local.res?.pause();
        else if (local?.kind === "upgrade") local.socket?.pause();
        return;
      }
      case T.RESUME: {
        const local = this.streams.get(id);
        if (local?.kind === "http") local.res?.resume();
        else if (local?.kind === "upgrade") local.socket?.resume();
        return;
      }
      default:
        return;
    }
  }

  private refuse(id: number, status: number) {
    const body = Buffer.from(status === 405 ? "" : GENERIC_PAGE);
    this.send(
      encodeFrame(T.RES_HEAD, id, {
        status,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "content-length": String(body.length),
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
        },
      }),
    );
    if (body.length > 0) this.send(encodeFrame(T.RES_BODY, id, body));
    this.send(encodeFrame(T.RES_END, id));
  }

  /** Whether the session a visitor presented belongs to a member. Cached for a few seconds per credential. */
  private readonly sessionChecks = new Map<string, { until: number; result: Promise<boolean> }>();

  private isMemberSession(visitorHeaders: Record<string, string>, publicHost: string, ip: string): Promise<boolean> {
    const key = NodeCrypto.createHash("sha256")
      .update(`${visitorHeaders.cookie ?? ""}\n${visitorHeaders.authorization ?? ""}`)
      .digest("hex");
    const now = Date.now();
    const cached = this.sessionChecks.get(key);
    if (cached !== undefined && cached.until > now) return cached.result;
    if (this.sessionChecks.size > 500) for (const [k, v] of this.sessionChecks) if (v.until <= now) this.sessionChecks.delete(k);
    const headers = headersForLocalServer({
      visitorHeaders: { cookie: visitorHeaders.cookie, authorization: visitorHeaders.authorization, accept: "application/json" },
      publicHost,
      ip,
    });
    const result = new Promise<boolean>((resolve) => {
      const req = NodeHttp.request(
        { host: "127.0.0.1", port: this.options.localPort(), method: "GET", path: "/api/lp/me", headers, agent: false, timeout: 5000 },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.length < 64 && chunks.push(chunk));
          res.on("end", () => {
            try {
              const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { user?: unknown };
              resolve(res.statusCode === 200 && body.user !== null && typeof body.user === "object");
            } catch {
              resolve(false);
            }
          });
          res.on("error", () => resolve(false));
        },
      );
      req.on("error", () => resolve(false));
      req.on("timeout", () => req.destroy());
      req.end();
    });
    // A member's session stays good for the whole visit; a refusal is remembered only briefly.
    const entry = { until: now + 5000, result };
    this.sessionChecks.set(key, entry);
    void result.then((ok) => {
      if (!ok) entry.until = Date.now() + 1500;
    });
    return result;
  }

  private onRequest(id: number, payload: Uint8Array, upgrade: boolean) {
    const head = parseJsonBytes(payload);
    const publicHost = this.publicHost;
    if (head === null || publicHost === null || typeof head.path !== "string") return this.refuse(id, 404);
    const path = head.path;
    const method = typeof head.method === "string" ? head.method : "GET";
    const visitorHeaders = (head.headers ?? {}) as Record<string, string>;
    if (typeof head.host === "string" && head.host.toLowerCase().replace(/:\d+$/, "") !== publicHost) {
      return this.refuse(id, 404);
    }
    const verdict = classifyRelayedRequest(
      { method, path, headers: visitorHeaders },
      { sessionCookieName: this.options.sessionCookieName() },
    );
    if (!verdict.allow) return this.refuse(id, verdict.status);
    const ip = typeof head.ip === "string" ? head.ip : "unknown";
    // The stream exists from now on so body frames that arrive while the session is checked are kept.
    const local: Local = upgrade
      ? { kind: "upgrade", req: null, socket: null }
      : { kind: "http", req: null, res: null, ended: false, queue: [] };
    this.streams.set(id, local);
    const proceed = () => {
      if (this.streams.get(id) !== local) return;
      this.forward(id, local, { method, path, visitorHeaders, publicHost, ip, upgrade });
    };
    if (verdict.needsMember && !verdict.ticket) {
      void this.isMemberSession(visitorHeaders, publicHost, ip).then((member) => {
        if (this.streams.get(id) !== local) return;
        if (!member) {
          this.streams.delete(id);
          this.refuse(id, 404);
          return;
        }
        proceed();
      });
    } else proceed();
  }

  private forward(
    id: number,
    local: Local,
    input: { method: string; path: string; visitorHeaders: Record<string, string>; publicHost: string; ip: string; upgrade: boolean },
  ) {
    const { method, path, visitorHeaders, publicHost, ip, upgrade } = input;
    const headers = headersForLocalServer({ visitorHeaders, publicHost, ip });
    if (upgrade) {
      headers.connection = "Upgrade";
      headers.upgrade = "websocket";
    }
    const req = NodeHttp.request({
      host: "127.0.0.1",
      port: this.options.localPort(),
      method,
      path,
      headers,
      agent: false,
    });
    local.req = req;
    if (upgrade && local.kind === "upgrade") {
      req.on("upgrade", (res, socket, firstBytes) => {
        local.socket = socket;
        this.send(encodeFrame(T.UPG_RES, id, { status: res.statusCode, headers: headersForVisitor(res.headers, { secureCookies: this.secureCookies }) }));
        if (firstBytes.length > 0) this.send(encodeFrame(T.RAW, id, firstBytes));
        socket.on("data", (chunk: Buffer) => {
          this.send(encodeFrame(T.RAW, id, chunk));
          if ((this.ws?.bufferedAmount ?? 0) > HIGH_WATER) {
            socket.pause();
            this.waitDrain(() => socket.resume());
          }
        });
        socket.on("close", () => {
          if (this.streams.delete(id)) this.send(encodeFrame(T.RAW_END, id));
        });
        socket.on("error", () => socket.destroy());
      });
      req.on("response", (res) => {
        res.resume();
        if (this.streams.delete(id)) this.send(encodeFrame(T.RES_HEAD, id, { status: res.statusCode, headers: {} }));
      });
      req.on("error", () => {
        if (this.streams.delete(id)) this.send(encodeFrame(T.ABORT, id));
      });
      req.end();
      return;
    }
    if (local.kind !== "http") return;
    req.on("response", (res) => {
      local.res = res;
      this.send(
        encodeFrame(T.RES_HEAD, id, { status: res.statusCode, headers: headersForVisitor(res.headers, { secureCookies: this.secureCookies }) }),
      );
      res.on("data", (chunk: Buffer) => {
        this.send(encodeFrame(T.RES_BODY, id, chunk));
        if ((this.ws?.bufferedAmount ?? 0) > HIGH_WATER) {
          res.pause();
          this.waitDrain(() => res.resume());
        }
      });
      res.on("end", () => {
        if (this.streams.delete(id)) this.send(encodeFrame(T.RES_END, id));
      });
      res.on("error", () => {
        if (this.streams.delete(id)) this.send(encodeFrame(T.ABORT, id));
      });
    });
    req.on("error", () => {
      if (this.streams.delete(id)) this.send(encodeFrame(T.ABORT, id));
    });
    for (const chunk of local.queue.splice(0)) req.write(chunk);
    if (local.ended) req.end();
  }
}
