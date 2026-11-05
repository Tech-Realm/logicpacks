// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

/**
 * Requests that arrive through the public-link relay are never local and never the owner.
 *
 * The relay client (this process) adds this header to every relayed request after it stripped
 * everything a visitor could have sent under an `x-lp-` name. The value is random per process
 * and never leaves it, so only the relay client can produce a request that carries it. The
 * auth layer then refuses every session that is not a signed-in member's.
 */
export const RELAY_MARKER_HEADER = "x-lp-relayed";

const marker = NodeCrypto.randomBytes(32).toString("hex");

export const relayMarkerValue = (): string => marker;

type Headers = Readonly<Record<string, string | ReadonlyArray<string> | undefined>>;

/** True when the request was handed to this server by the relay client. */
export const isRelayedHeaders = (headers: Headers): boolean => {
  const raw = headers[RELAY_MARKER_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return false;
  const a = Buffer.from(value);
  const b = Buffer.from(marker);
  return a.length === b.length && NodeCrypto.timingSafeEqual(a, b);
};

/** Same value as projectAccess.MEMBER_SUBJECT_PREFIX (a test keeps them equal); auth cannot import logicpacks. */
const MEMBER_SUBJECT_PREFIX = "lp-user:";

/**
 * What a relayed request may be authenticated as: a signed-in member. The owner's browser
 * session, `lp login` operator tokens, agent and MCP tokens and device tokens stay local.
 */
export const sessionAllowedThroughRelay = (subject: string): boolean =>
  subject.startsWith(MEMBER_SUBJECT_PREFIX) && subject.length > MEMBER_SUBJECT_PREFIX.length;
