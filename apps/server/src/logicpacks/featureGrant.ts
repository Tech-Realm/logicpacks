// @effect-diagnostics nodeBuiltinImport:off
/**
 * Access codes for the downloaded app. Codes are made and counted on the LogicPacks cloud
 * (app.logicpacks.io, /ops); a laptop host sends a typed code there and gets back a grant
 * signed with the cloud's Ed25519 key. The laptop verifies it with the public key below and
 * stores it, so its features work offline. Plain functions, unit-tested.
 */
import * as NodeCrypto from "node:crypto";

import { expandFeatures, isGatedFeature, type GatedFeature } from "./featureCodes.ts";

/** The production public key (SPKI, base64). Its private half lives only on the cloud host. */
export const GRANT_PUBLIC_KEY_SPKI = "MCowBQYDK2VwAyEAQJ2MoHPiEG/NxrjJ6rtJ2I/wa6j5rh5K2SUPX8eecN8=";

export interface FeatureGrant {
  readonly v: 1;
  readonly deviceId: string;
  readonly features: ReadonlyArray<GatedFeature>;
  readonly codeId: string;
  readonly issuedAtMs: number;
  /** The code's own expiry; null when it has none. */
  readonly expiresAtMs: number | null;
}

const b64url = (buffer: Buffer) => buffer.toString("base64url");

export const publicKeyFrom = (spkiBase64: string) =>
  NodeCrypto.createPublicKey({
    key: Buffer.from(spkiBase64, "base64"),
    format: "der",
    type: "spki",
  });

/** PEM, or a base64 PKCS#8 DER body (env-friendly). */
export const privateKeyFrom = (raw: string) =>
  raw.includes("-----BEGIN")
    ? NodeCrypto.createPrivateKey(raw)
    : NodeCrypto.createPrivateKey({
        key: Buffer.from(raw.trim(), "base64"),
        format: "der",
        type: "pkcs8",
      });

export const signGrant = (grant: FeatureGrant, privateKey: NodeCrypto.KeyObject): string => {
  const body = b64url(Buffer.from(JSON.stringify(grant), "utf8"));
  const signature = NodeCrypto.sign(null, Buffer.from(body, "utf8"), privateKey);
  return `${body}.${b64url(signature)}`;
};

export type GrantCheck =
  | { readonly ok: true; readonly grant: FeatureGrant }
  | { readonly ok: false; readonly reason: "malformed" | "signature" | "device" | "expired" };

/** Verifies the signature, the device it was made for and its expiry. */
export const verifyGrant = (
  token: string,
  publicKey: NodeCrypto.KeyObject,
  expect: { readonly deviceId: string | null; readonly nowMs: number },
): GrantCheck => {
  const [body, signature, extra] = token.trim().split(".");
  if (!body || !signature || extra !== undefined) return { ok: false, reason: "malformed" };
  let valid = false;
  try {
    valid = NodeCrypto.verify(
      null,
      Buffer.from(body, "utf8"),
      publicKey,
      Buffer.from(signature, "base64url"),
    );
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!valid) return { ok: false, reason: "signature" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const grant = parsed as Partial<FeatureGrant>;
  if (
    grant.v !== 1 ||
    typeof grant.deviceId !== "string" ||
    typeof grant.codeId !== "string" ||
    !Array.isArray(grant.features)
  ) {
    return { ok: false, reason: "malformed" };
  }
  if (expect.deviceId !== null && grant.deviceId !== expect.deviceId)
    return { ok: false, reason: "device" };
  const expiresAtMs = typeof grant.expiresAtMs === "number" ? grant.expiresAtMs : null;
  if (expiresAtMs !== null && expect.nowMs > expiresAtMs) return { ok: false, reason: "expired" };
  return {
    ok: true,
    grant: {
      v: 1,
      deviceId: grant.deviceId,
      codeId: grant.codeId,
      features: Array.from(expandFeatures(grant.features.filter(isGatedFeature))),
      issuedAtMs: typeof grant.issuedAtMs === "number" ? grant.issuedAtMs : 0,
      expiresAtMs,
    },
  };
};
