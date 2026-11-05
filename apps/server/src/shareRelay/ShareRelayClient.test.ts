import { describe, expect, it } from "vite-plus/test";

import { newHostId } from "./ShareRelayClient.ts";

describe("host ids", () => {
  it("are 128 bits of crypto randomness as a DNS-safe label", () => {
    const ids = new Set(Array.from({ length: 500 }, newHostId));
    expect(ids.size).toBe(500);
    for (const id of ids) expect(id).toMatch(/^[a-z2-7]{26}$/);
  });
});
