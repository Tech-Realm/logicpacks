import { describe, expect, it } from "@effect/vitest";

import {
  codeStatus,
  generateCode,
  hashCode,
  makeRateLimiter,
  normalizeCode,
  redeem,
  type AccessCode,
} from "./featureCodes.ts";

const code = (patch: Partial<AccessCode> = {}): AccessCode => ({
  id: "code-1",
  hash: hashCode("LP-ABCD-EFGH"),
  hint: "EFGH",
  features: ["talent", "apps"],
  maxUses: 2,
  uses: 0,
  expiresAtMs: 10_000,
  note: "",
  createdBy: "staff@example.com",
  createdAtMs: 0,
  revokedAtMs: null,
  redeemedBy: [],
  ...patch,
});

describe("access codes", () => {
  it("generates human-typable LP-XXXX-XXXX codes without ambiguous characters", () => {
    for (let i = 0; i < 200; i += 1) {
      const generated = generateCode();
      expect(generated).toMatch(/^LP-[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/);
    }
    expect(new Set(Array.from({ length: 200 }, () => generateCode())).size).toBe(200);
  });

  it("normalizes case, spaces and dashes", () => {
    expect(normalizeCode("lp abcd efgh")).toBe("LP-ABCD-EFGH");
    expect(normalizeCode("ABCDEFGH")).toBe("LP-ABCD-EFGH");
    expect(normalizeCode("LP-ABC")).toBeNull();
  });

  it("stores only a hash", () => {
    expect(hashCode("LP-ABCD-EFGH")).not.toContain("ABCD");
    expect(hashCode("LP-ABCD-EFGH")).toHaveLength(64);
  });

  it("redeems, counts uses and stops at max uses", () => {
    const first = redeem(code(), "u1", 5);
    expect(first.ok && first.fresh && first.code.uses).toBe(1);
    if (!first.ok) throw new Error("expected ok");
    const second = redeem(first.code, "u2", 6);
    if (!second.ok) throw new Error("expected ok");
    expect(second.code.uses).toBe(2);
    expect(redeem(second.code, "u3", 7)).toEqual({ ok: false, reason: "used_up" });
    // The same user again keeps their features and uses nothing.
    const again = redeem(second.code, "u1", 8);
    expect(again.ok && !again.fresh && again.code.uses).toBe(2);
  });

  it("refuses expired, revoked and unknown codes", () => {
    expect(redeem(code(), "u1", 20_000)).toEqual({ ok: false, reason: "expired" });
    expect(redeem(code({ revokedAtMs: 1 }), "u1", 5)).toEqual({ ok: false, reason: "revoked" });
    expect(redeem(undefined, "u1", 5)).toEqual({ ok: false, reason: "unknown" });
    expect(codeStatus(code({ maxUses: null, uses: 99, expiresAtMs: null }), 1e12)).toBe("active");
  });

  it("rate limits redeem attempts per key", () => {
    const allow = makeRateLimiter(3, 1000);
    expect([1, 2, 3, 4].map(() => allow("ip:1", 0))).toEqual([true, true, true, false]);
    expect(allow("ip:2", 0)).toBe(true);
    expect(allow("ip:1", 2000)).toBe(true);
  });
});
