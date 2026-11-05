// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import { describe, expect, it } from "@effect/vitest";

import { expandFeatures } from "./featureCodes.ts";
import {
  GRANT_PUBLIC_KEY_SPKI,
  publicKeyFrom,
  signGrant,
  verifyGrant,
  type FeatureGrant,
} from "./featureGrant.ts";

const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("ed25519");
const DEVICE = "dev-00000000-0000-4000-8000-000000000001";
const grant = (over: Partial<FeatureGrant> = {}): FeatureGrant => ({
  v: 1,
  deviceId: DEVICE,
  features: ["talent", "apps"],
  codeId: "code-1",
  issuedAtMs: 1_000,
  expiresAtMs: null,
  ...over,
});

describe("feature grants", () => {
  it("verifies a grant for its device and expands implied features", () => {
    const check = verifyGrant(signGrant(grant(), privateKey), publicKey, {
      deviceId: DEVICE,
      nowMs: 2_000,
    });
    expect(check.ok).toBe(true);
    if (check.ok)
      expect([...check.grant.features].toSorted()).toEqual(["apps", "freelancer_jobs", "talent"]);
  });

  it("refuses another device, a tampered body, another key and an expired grant", () => {
    const token = signGrant(grant({ expiresAtMs: 5_000 }), privateKey);
    expect(verifyGrant(token, publicKey, { deviceId: "dev-other", nowMs: 2_000 })).toEqual({
      ok: false,
      reason: "device",
    });
    const [body, sig] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(body!, "base64url").toString()),
        features: ["cloud"],
      }),
    ).toString("base64url");
    expect(verifyGrant(`${forged}.${sig}`, publicKey, { deviceId: DEVICE, nowMs: 2_000 }).ok).toBe(
      false,
    );
    expect(
      verifyGrant(token, publicKeyFrom(GRANT_PUBLIC_KEY_SPKI), { deviceId: DEVICE, nowMs: 2_000 })
        .ok,
    ).toBe(false);
    expect(verifyGrant(token, publicKey, { deviceId: DEVICE, nowMs: 6_000 })).toEqual({
      ok: false,
      reason: "expired",
    });
    expect(verifyGrant("nonsense", publicKey, { deviceId: DEVICE, nowMs: 0 }).ok).toBe(false);
  });

  it("treats cloud and the older cloud_agents key as one feature", () => {
    expect(expandFeatures(["cloud_agents"]).has("cloud")).toBe(true);
    expect(expandFeatures(["cloud"]).has("cloud_agents")).toBe(true);
    expect(expandFeatures(["apps"]).has("cloud")).toBe(false);
    // A removed feature id in an old code or grant is dropped without an error.
    expect(Array.from(expandFeatures(["packs", "talent"] as never))).toEqual(["talent", "freelancer_jobs"]);
  });
});
