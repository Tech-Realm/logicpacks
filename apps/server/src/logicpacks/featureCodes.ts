// @effect-diagnostics nodeBuiltinImport:off
/**
 * Feature access: the core workspace is open to everyone; a few features are unlocked per
 * account with access codes. Plain rules, unit-tested; `FeatureAccess.ts` stores them.
 */
import * as NodeCrypto from "node:crypto";

/** Older grants and access codes may still carry "packs" (removed); isGatedFeature drops it. */
export const GATED_FEATURES = [
  "talent",
  "apps",
  "freelancer_jobs",
  "cloud",
  "cloud_agents",
] as const;
export type GatedFeature = (typeof GATED_FEATURES)[number];

/** What new codes offer in /ops: freelancer_jobs and cloud_agents ride on talent and cloud. */
export const OFFERED_FEATURES: ReadonlyArray<GatedFeature> = ["talent", "apps", "cloud"];

/**
 * Features that come with another. Talent covers the freelancer jobs board; cloud (cloud sync:
 * cloud-hosted projects, cloud agent logins and turns) absorbed the older cloud_agents key, so
 * codes made with either unlock both.
 */
const IMPLIES: Partial<Record<GatedFeature, ReadonlyArray<GatedFeature>>> = {
  talent: ["freelancer_jobs"],
  cloud: ["cloud_agents"],
  cloud_agents: ["cloud"],
};

export const expandFeatures = (features: Iterable<GatedFeature>): Set<GatedFeature> => {
  const out = new Set<GatedFeature>();
  for (const feature of features) {
    // Codes and grants issued before Packs was removed may still list it: ignore, never fail.
    if (!isGatedFeature(feature)) continue;
    out.add(feature);
    for (const implied of IMPLIES[feature] ?? []) out.add(implied);
  }
  return out;
};

export const FEATURE_LABEL: Record<GatedFeature, string> = {
  talent: "Talent (vetted freelancers)",
  apps: "Apps",
  freelancer_jobs: "Freelancer jobs board",
  cloud: "Cloud sync",
  cloud_agents: "Cloud sync",
};

export const isGatedFeature = (value: unknown): value is GatedFeature =>
  typeof value === "string" && (GATED_FEATURES as ReadonlyArray<string>).includes(value);

/** No 0/O, 1/I/L: easy to read out and type. */
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

/** LP-XXXX-XXXX: 8 random characters (~40 bits); redeeming is rate limited on top. */
export const generateCode = (
  random: (n: number) => Uint8Array = (n) => NodeCrypto.randomBytes(n),
) => {
  const chars: Array<string> = [];
  // Rejection sampling keeps every character equally likely (248 = 8 * 31).
  while (chars.length < 8) {
    for (const byte of random(16)) {
      if (byte < 248 && chars.length < 8) chars.push(ALPHABET[byte % ALPHABET.length]!);
    }
  }
  return `LP-${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
};

/** Case, spaces and dashes do not matter: "lp xxxx xxxx" is the same code. */
export const normalizeCode = (raw: string) => {
  const compact = raw
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .replace(/^LP/, "");
  return compact.length === 8 ? `LP-${compact.slice(0, 4)}-${compact.slice(4)}` : null;
};

export const hashCode = (code: string) =>
  NodeCrypto.createHash("sha256").update(`logicpacks-access:${code}`).digest("hex");

export interface AccessCode {
  readonly id: string;
  readonly hash: string;
  /** The last four characters, so a code can be told apart in the list. */
  readonly hint: string;
  readonly features: ReadonlyArray<GatedFeature>;
  /** Null means unlimited. */
  readonly maxUses: number | null;
  readonly uses: number;
  readonly expiresAtMs: number | null;
  readonly note: string;
  readonly createdBy: string;
  readonly createdAtMs: number;
  readonly revokedAtMs: number | null;
  readonly redeemedBy: ReadonlyArray<{ readonly userId: string; readonly atMs: number }>;
}

export type RedeemRefusal = "unknown" | "revoked" | "expired" | "used_up";

export const REDEEM_MESSAGES: Record<RedeemRefusal | "rate_limited" | "invalid", string> = {
  invalid: "That doesn't look like an access code (LP-XXXX-XXXX).",
  unknown: "That access code isn't valid.",
  revoked: "That access code has been turned off.",
  expired: "That access code has expired.",
  used_up: "That access code has been used up.",
  rate_limited: "Too many tries. Wait a few minutes and try again.",
};

export const codeStatus = (code: AccessCode, nowMs: number): "active" | RedeemRefusal => {
  if (code.revokedAtMs !== null) return "revoked";
  if (code.expiresAtMs !== null && nowMs > code.expiresAtMs) return "expired";
  if (code.maxUses !== null && code.uses >= code.maxUses) return "used_up";
  return "active";
};

/** Redeems a code; the same user redeeming again gets its features without using another use. */
export const redeem = (
  code: AccessCode | undefined,
  userId: string,
  nowMs: number,
):
  | {
      readonly ok: true;
      readonly code: AccessCode;
      readonly features: ReadonlyArray<GatedFeature>;
      readonly fresh: boolean;
    }
  | { readonly ok: false; readonly reason: RedeemRefusal } => {
  if (code === undefined) return { ok: false, reason: "unknown" };
  const already = code.redeemedBy.some((entry) => entry.userId === userId);
  const status = codeStatus(code, nowMs);
  if (status === "revoked" || status === "expired") return { ok: false, reason: status };
  if (already) return { ok: true, code, features: code.features, fresh: false };
  if (status === "used_up") return { ok: false, reason: status };
  return {
    ok: true,
    code: {
      ...code,
      uses: code.uses + 1,
      redeemedBy: [...code.redeemedBy, { userId, atMs: nowMs }],
    },
    features: code.features,
    fresh: true,
  };
};

/** A fixed-window limiter per key (account or address): `max` tries per `windowMs`. */
export const makeRateLimiter = (max: number, windowMs: number) => {
  const hits = new Map<string, { count: number; startMs: number }>();
  return (key: string, nowMs: number) => {
    const entry = hits.get(key);
    if (entry === undefined || nowMs - entry.startMs > windowMs) {
      hits.set(key, { count: 1, startMs: nowMs });
      return true;
    }
    entry.count += 1;
    return entry.count <= max;
  };
};

/** The cookie the sign-in pages set when someone types a code, read on every sign-in path. */
export const ACCESS_CODE_COOKIE = "lp_access_code";
