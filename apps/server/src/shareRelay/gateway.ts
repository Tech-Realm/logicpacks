// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import { HOST_COOKIE_PREFIX } from "../auth/utils.ts";
import { RELAY_MARKER_HEADER, relayMarkerValue } from "./relayTrust.ts";

/** Page for anything a visitor without a member session may not see. Says nothing about this host. */
export const GENERIC_PAGE =
  '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Not found</title><body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;font:16px -apple-system,Segoe UI,sans-serif;color:#55554f;background:#f6f6f4"><p>This page is not available.</p></body></html>';

export interface RelayedRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
}

export interface GatewayContext {
  /** The cookie this host stores a member session in. */
  readonly sessionCookieName: string | null;
}

export type Verdict =
  | {
      readonly allow: true;
      readonly credentialed: boolean;
      /** Anyone with a valid member session may pass; the client checks the session before it forwards. */
      readonly needsMember: boolean;
      /** A one-time websocket ticket cannot be pre-checked; the socket handshake validates it. */
      readonly ticket: boolean;
    }
  | { readonly allow: false; readonly status: 403 | 404 | 405 };

/** Never reachable through the relay, with or without a session. */
const DENIED_PREFIXES: ReadonlyArray<string> = [
  "/pair",
  "/api/auth/pairing-token",
  "/api/auth/pairing-links",
  "/api/auth/clients",
  "/api/auth/browser-session",
  "/oauth",
  "/mcp",
  "/api/connect",
  "/api/t3-connect",
  "/api/hooks",
  "/api/device-hub",
  "/api/devices",
  "/api/observability",
  "/api/lp/helper/pair/local",
  "/api/lp/helper/key",
];

/** What someone holding only an invite link (no session yet) may open. */
const PUBLIC_EXACT = new Set([
  "GET /lp/join",
  "GET /lp/join/project",
  "GET /lp/login",
  "POST /api/lp/join",
  "POST /api/lp/join/project",
  "POST /api/lp/auth/password",
  "POST /api/lp/auth/quick",
  "GET /lp/helper",
  "POST /api/lp/helper/pair/start",
  "GET /api/lp/helper/pair",
  "POST /api/lp/helper/pair/poll",
]);

/** Signed, short-lived upload URLs the app hands out over the RPC socket; the token is the credential. */
const PUBLIC_POST_PREFIXES = ["/api/attachments/upload/"];

const ENVIRONMENT_DESCRIPTOR = "/.well-known/t3/environment";

const ALLOWED_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);

/** Decodes and flattens a request path so `/%70air`, `/a/../pair` and `//pair` cannot dodge a rule. */
export const normalizeRelayedPath = (rawPath: string): { path: string; query: string } | null => {
  if (!rawPath.startsWith("/") || /[\u0000-\u001f\u007f]/.test(rawPath)) return null;
  const q = rawPath.indexOf("?");
  const pathname = q === -1 ? rawPath : rawPath.slice(0, q);
  const query = q === -1 ? "" : rawPath.slice(q + 1);
  if (/%2f|%5c|%00/i.test(pathname)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const flat = NodePath.posix.normalize(decoded.replace(/\\/g, "/")).toLowerCase();
  const trimmed = flat.length > 1 ? flat.replace(/\/+$/, "") : flat;
  return { path: trimmed.length === 0 ? "/" : trimmed, query };
};

const hasCredential = (request: RelayedRequest, ctx: GatewayContext, normalizedPath: string, query: string): boolean => {
  const auth = request.headers.authorization;
  if (typeof auth === "string" && /^(bearer|dpop)\s+\S+/i.test(auth)) return true;
  const cookie = request.headers.cookie;
  if (ctx.sessionCookieName !== null && typeof cookie === "string") {
    for (const part of cookie.split(";")) {
      const eq = part.indexOf("=");
      // Public links are always https, so only the `__Host-` name is a session here.
      if (
        eq > 0 &&
        part.slice(0, eq).trim() === `${HOST_COOKIE_PREFIX}${ctx.sessionCookieName}` &&
        part.length > eq + 1
      ) {
        return true;
      }
    }
  }
  return normalizedPath === "/ws" && /(^|&)wsTicket=/.test(query);
};

export const classifyRelayedRequest = (request: RelayedRequest, ctx: GatewayContext): Verdict => {
  const method = request.method.toUpperCase();
  if (!ALLOWED_METHODS.has(method)) return { allow: false, status: 405 };
  const normalized = normalizeRelayedPath(request.path);
  if (normalized === null) return { allow: false, status: 404 };
  const { path, query } = normalized;
  for (const prefix of DENIED_PREFIXES) {
    if (path === prefix || path.startsWith(`${prefix}/`)) return { allow: false, status: 404 };
  }
  // The environment descriptor is how the app starts; a signed-in member gets it, nobody else does.
  if ((path === "/.well-known" || path.startsWith("/.well-known/")) && path !== ENVIRONMENT_DESCRIPTOR) {
    return { allow: false, status: 404 };
  }
  const credentialed = hasCredential(request, ctx, path, query);
  const open =
    PUBLIC_EXACT.has(`${method === "HEAD" ? "GET" : method} ${path}`) ||
    (method === "POST" && PUBLIC_POST_PREFIXES.some((prefix) => path.startsWith(prefix)));
  const ticket = path === "/ws" && /(^|&)wsTicket=/.test(query);
  if (open) return { allow: true, credentialed, needsMember: false, ticket: false };
  if (credentialed) return { allow: true, credentialed, needsMember: true, ticket };
  return { allow: false, status: 404 };
};

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "proxy-connection",
  "upgrade",
]);

const isSpoofable = (n: string) =>
  n.startsWith("x-forwarded-") ||
  n.startsWith("x-lp-") ||
  n.startsWith("x-relay-") ||
  n.startsWith("cf-") ||
  n === "forwarded" ||
  n === "x-real-ip" ||
  n === "true-client-ip" ||
  n === "x-client-ip" ||
  n === "via" ||
  n === "x-original-host";

/**
 * Headers for the request this process makes to its own server. Whatever the visitor claimed about
 * who they are or where they came from is dropped first; then the relay facts are written.
 */
export const headersForLocalServer = (input: {
  readonly visitorHeaders: Readonly<Record<string, unknown>>;
  readonly publicHost: string;
  readonly ip: string;
}): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.visitorHeaders)) {
    const n = name.toLowerCase();
    if (typeof value !== "string" || HOP_BY_HOP.has(n) || isSpoofable(n) || n === "host") continue;
    if (/[\r\n]/.test(value)) continue;
    out[n] = value;
  }
  out.host = input.publicHost;
  out["x-forwarded-for"] = input.ip.slice(0, 64).replace(/[^0-9a-fA-F:.]/g, "");
  out["x-forwarded-proto"] = "https";
  out["x-forwarded-host"] = input.publicHost;
  out[RELAY_MARKER_HEADER] = relayMarkerValue();
  return out;
};

/** Response headers for the visitor: session cookies become Secure, host-internal headers never leave. */
export const headersForVisitor = (
  raw: Readonly<Record<string, string | string[] | undefined>>,
  options: { readonly secureCookies: boolean } = { secureCookies: true },
): Record<string, string | string[]> => {
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(raw)) {
    const n = name.toLowerCase();
    if (value === undefined || HOP_BY_HOP.has(n) || n.startsWith("x-lp-") || n.startsWith("x-relay-")) continue;
    if (n === "set-cookie") {
      const cookies = (Array.isArray(value) ? value : [value]).map((c) =>
        !options.secureCookies || /;\s*secure(\s*;|\s*$)/i.test(c) ? c : `${c}; Secure`,
      );
      out[n] = cookies;
    } else out[n] = value;
  }
  return out;
};
