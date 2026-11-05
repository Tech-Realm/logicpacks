import type {
  AuthClientMetadata,
  AuthClientMetadataDeviceType,
  AuthClientPresentationMetadata,
} from "@logicpacks/contracts";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no createHmac or timingSafeEqual.
import * as NodeCrypto from "node:crypto";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Result from "effect/Result";

const SESSION_COOKIE_NAME = "lp_session";

/** Cookies span ports; use separate names for servers sharing a hostname. */
/**
 * Public links are subdomains of the sign-in server's domain, and a host's page is host-written
 * code: it can set a cookie for the parent domain, and it would be sent here too. `__Host-` is the
 * one name a browser refuses to accept that way (Secure, no Domain, Path=/). It needs https, so
 * plain http on a LAN or loopback keeps the plain name; nothing there shares a parent domain.
 */
export const HOST_COOKIE_PREFIX = "__Host-";

const httpsOriginHosts = (env: NodeJS.ProcessEnv): ReadonlySet<string> => {
  const authority = env.LOGICPACKS_ACCOUNT_AUTHORITY_URL?.trim() || "https://app.logicpacks.io";
  const hosts = new Set<string>();
  for (const raw of [authority, ...(env.LOGICPACKS_PUBLIC_ORIGINS ?? "").split(",")]) {
    try {
      const url = new URL(raw.trim());
      if (url.protocol === "https:") hosts.add(url.host.toLowerCase());
    } catch {
      // Not an address ("off", empty).
    }
  }
  return hosts;
};

/**
 * Did this request reach us over https? The relay and Cloudflare say so. The address this server is
 * known by on https counts even if a proxy forgot to, so the strict name cannot be turned off from
 * outside. A client claiming https over plain http only gets a cookie its browser will refuse.
 */
export const isHttpsRequest = (
  headers: Readonly<Record<string, string | undefined>>,
  env: NodeJS.ProcessEnv = process.env,
): boolean => {
  if (headers["x-forwarded-proto"]?.split(",")[0]?.trim().toLowerCase() === "https") return true;
  const host = headers.host?.trim().toLowerCase();
  return host !== undefined && httpsOriginHosts(env).has(host);
};

export const requestCookieName = (
  baseName: string,
  headers: Readonly<Record<string, string | undefined>>,
): string => (isHttpsRequest(headers) ? `${HOST_COOKIE_PREFIX}${baseName}` : baseName);

export function resolveSessionCookieName(input: {
  readonly mode: "web" | "desktop";
  readonly port: number;
  readonly host: string | undefined;
  readonly instanceKey: string;
  readonly environmentId: string;
  readonly development: boolean;
}): string {
  if (input.mode === "desktop") {
    return `${SESSION_COOKIE_NAME}_${input.port}`;
  }

  const instanceHash = NodeCrypto.createHash("sha256")
    .update(
      !input.development && isRemoteReachableHost(input.host)
        ? input.environmentId
        : input.instanceKey,
    )
    .digest("hex")
    .slice(0, 12);

  if (!input.development && isRemoteReachableHost(input.host)) {
    return `${SESSION_COOKIE_NAME}_${instanceHash}`;
  }

  return `${SESSION_COOKIE_NAME}_${input.port}_${instanceHash}`;
}

export function resolveLegacySessionCookieName(input: {
  readonly mode: "web" | "desktop";
  readonly host: string | undefined;
  readonly development: boolean;
}): string | undefined {
  return input.mode === "web" && !input.development && isRemoteReachableHost(input.host)
    ? SESSION_COOKIE_NAME
    : undefined;
}

export function isRemoteReachableHost(host: string | undefined): boolean {
  if (host === "0.0.0.0" || host === "::" || host === "[::]") {
    return true;
  }
  if (!host || host.length === 0) {
    return false;
  }
  return !(
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]" ||
    host.startsWith("127.")
  );
}

export function base64UrlEncode(input: string | Uint8Array): string {
  return typeof input === "string"
    ? Base64Url.encode(new TextEncoder().encode(input))
    : Base64Url.encode(input);
}

export function base64UrlDecodeUtf8(input: string): string {
  return Result.getOrThrow(Base64Url.decodeString(input));
}

export function signPayload(payload: string, secret: Uint8Array): string {
  return NodeCrypto.createHmac("sha256", Buffer.from(secret)).update(payload).digest("base64url");
}

export function timingSafeEqualBase64Url(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "base64url");
  const rightBuffer = Buffer.from(right, "base64url");
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return NodeCrypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function normalizeNonEmptyString(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeIpAddress(value: string | null | undefined): string | undefined {
  const normalized = normalizeNonEmptyString(value);
  if (!normalized) {
    return undefined;
  }
  return normalized.startsWith("::ffff:") ? normalized.slice("::ffff:".length) : normalized;
}

function inferDeviceType(userAgent: string | undefined): AuthClientMetadataDeviceType {
  if (!userAgent) {
    return "unknown";
  }

  const normalized = userAgent.toLowerCase();
  if (/bot|crawler|spider|slurp|curl|wget/.test(normalized)) {
    return "bot";
  }
  if (/ipad|tablet/.test(normalized)) {
    return "tablet";
  }
  if (/iphone|android.+mobile|mobile/.test(normalized)) {
    return "mobile";
  }
  return "desktop";
}

function inferBrowser(userAgent: string | undefined): string | undefined {
  if (!userAgent) {
    return undefined;
  }
  const normalized = userAgent.toLowerCase();
  if (/edg(?:e|a|ios)?\//.test(normalized)) return "Edge";
  if (/opr\/|opios\//.test(normalized)) return "Opera";
  if (/firefox\/|fxios\//.test(normalized)) return "Firefox";
  if (/electron\//.test(normalized)) return "Electron";
  if (/chrome\//.test(normalized) || /crios\//.test(normalized)) return "Chrome";
  if (/safari\//.test(normalized) && !/chrome\//.test(normalized)) return "Safari";
  return undefined;
}

function inferOs(userAgent: string | undefined): string | undefined {
  if (!userAgent) {
    return undefined;
  }
  const normalized = userAgent.toLowerCase();
  if (/iphone|ipad|ipod/.test(normalized)) return "iOS";
  if (/android/.test(normalized)) return "Android";
  if (/mac os x|macintosh/.test(normalized)) return "macOS";
  if (/windows nt/.test(normalized)) return "Windows";
  if (/linux/.test(normalized)) return "Linux";
  return undefined;
}

function readRemoteAddressFromSource(source: unknown): string | undefined {
  if (!source || typeof source !== "object") {
    return undefined;
  }

  const candidate = source as {
    readonly remoteAddress?: string | null;
    readonly socket?: {
      readonly remoteAddress?: string | null;
    };
  };

  return normalizeIpAddress(candidate.socket?.remoteAddress ?? candidate.remoteAddress);
}

export function deriveAuthClientMetadata(input: {
  readonly request: HttpServerRequest.HttpServerRequest;
  readonly presented?: AuthClientPresentationMetadata;
}): AuthClientMetadata {
  const userAgent = normalizeNonEmptyString(input.request.headers["user-agent"]);
  const ipAddress = readRemoteAddressFromSource(input.request.source);
  const os = input.presented?.os ?? inferOs(userAgent);
  const browser = inferBrowser(userAgent);
  return {
    ...(input.presented?.label ? { label: input.presented.label } : {}),
    ...(ipAddress ? { ipAddress } : {}),
    ...(userAgent ? { userAgent } : {}),
    deviceType: input.presented?.deviceType ?? inferDeviceType(userAgent),
    ...(os ? { os } : {}),
    ...(browser ? { browser } : {}),
  };
}
