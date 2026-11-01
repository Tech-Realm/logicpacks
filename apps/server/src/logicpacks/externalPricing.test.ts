import { describe, expect, it } from "@effect/vitest";

import { REGIONS } from "./externalConfig.ts";
import {
  hourlyRate,
  packageFor,
  quote,
  rateCard,
  regionByCode,
  regionFromAcceptLanguage,
  resolveRegion,
  tokensSaved,
} from "./externalPricing.ts";

const region = (code: string) => {
  const found = regionByCode(code);
  if (found === null) throw new Error(`no region ${code}`);
  return found;
};

describe("external pricing regions", () => {
  it("resolves CF-IPCountry first, then Accept-Language, account, default", () => {
    expect(resolveRegion({ cfCountry: "PK", acceptLanguage: "de-DE" })).toMatchObject({
      region: { code: "PK" },
      source: "cf-ipcountry",
      country: "PK",
    });
    expect(resolveRegion({ cfCountry: "DE" }).region.code).toBe("EU");
    expect(resolveRegion({ cfCountry: "BR" }).region.code).toBe("INTL");
    expect(resolveRegion({ acceptLanguage: "en-GB,en;q=0.9" })).toMatchObject({
      region: { code: "UK" },
      source: "accept-language",
    });
    expect(resolveRegion({ accountRegion: "UAE" })).toMatchObject({
      region: { code: "UAE" },
      source: "account",
    });
    expect(resolveRegion({})).toMatchObject({ region: { code: "US" }, source: "default" });
    expect(resolveRegion({ override: "IN", cfCountry: "US" })).toMatchObject({
      region: { code: "IN" },
      source: "override",
    });
  });

  it("reads languages without a country", () => {
    expect(regionFromAcceptLanguage("ur")?.region.code).toBe("PK");
    expect(regionFromAcceptLanguage("xx")).toBeNull();
    expect(regionFromAcceptLanguage(null)).toBeNull();
  });

  it("prices every region in its own currency, rounded", () => {
    for (const config of REGIONS) {
      const hourly = hourlyRate(config, "developer", "senior");
      expect(hourly).toBeGreaterThan(0);
      expect(hourly % config.roundTo).toBe(0);
    }
    expect(hourlyRate(region("US"), "developer", "senior")).toBe(120);
    expect(hourlyRate(region("PK"), "devops", "senior")).toBe(9100);
  });

  it("uses exact overrides when a region sets them", () => {
    const withOverride = { ...region("UK"), overrides: { designer: { mid: 55 } } };
    expect(hourlyRate(withOverride, "designer", "mid")).toBe(55);
    expect(hourlyRate(withOverride, "designer", "senior")).toBe(
      hourlyRate(region("UK"), "designer", "senior"),
    );
  });
});

describe("external pricing quotes", () => {
  it("applies the package discount for the hours", () => {
    expect(packageFor(1)).toBeNull();
    expect(packageFor(10)?.id).toBe("sprint");
    expect(packageFor(25)?.id).toBe("project");
    const sprint = quote(region("US"), "devops", "senior", 10);
    expect(sprint).toMatchObject({
      hours: 10,
      hourly: 130,
      subtotal: 1300,
      discountPct: 5,
      price: 1235,
      packageName: "Sprint",
    });
  });

  it("clamps hours and labels a token estimate", () => {
    expect(quote(region("US"), "designer", "junior", 0).hours).toBe(1);
    expect(quote(region("US"), "designer", "junior", 500).hours).toBe(80);
    expect(quote(region("US"), "designer", "junior", 2.2).hours).toBe(3);
    expect(tokensSaved("devops", 10)).toBe(1_500_000);
    expect(quote(region("PK"), "devops", "mid", 4).tokensSavedEstimate).toBe(600_000);
  });

  it("builds a rate card for the published pricing page", () => {
    const card = rateCard(resolveRegion({ cfCountry: "AE" }));
    expect(card).toMatchObject({ region: { code: "UAE", currency: "AED" } });
  });
});
