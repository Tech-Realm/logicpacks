/**
 * External team (Beta): published prices, localised by region. Pure, unit-tested; the
 * region table and rates live in `externalConfig.ts`.
 */
import {
  AGENT_TOKENS_PER_HUMAN_HOUR,
  BASE_HOURLY_USD,
  COUNTRY_REGION,
  DEFAULT_REGION,
  FALLBACK_REGION,
  LANGUAGE_REGION,
  LEVEL_LABEL,
  PACKAGES,
  REGIONS,
  ROLE_LABEL,
  TALENT_LEVELS,
  TALENT_ROLES,
  type PackageConfig,
  type RegionConfig,
  type TalentLevel,
  type TalentRole,
} from "./externalConfig.ts";

export type RegionSource = "override" | "cf-ipcountry" | "accept-language" | "account" | "default";

export interface ResolvedRegion {
  readonly region: RegionConfig;
  readonly source: RegionSource;
  /** The country the region came from, when there was one. */
  readonly country: string | null;
}

export const regionByCode = (code: string | null | undefined): RegionConfig | null =>
  code ? (REGIONS.find((region) => region.code === code.trim().toUpperCase()) ?? null) : null;

const fallbackRegion = () => regionByCode(FALLBACK_REGION) ?? REGIONS[0]!;

/** A country code to its region; unknown but valid countries are the fallback region. */
export const regionForCountry = (country: string): RegionConfig | null => {
  const code = country.trim().toUpperCase();
  // Cloudflare sends XX for unknown and T1 for Tor.
  if (!/^[A-Z]{2}$/.test(code) || code === "XX" || code === "T1") return null;
  return regionByCode(COUNTRY_REGION[code] ?? FALLBACK_REGION) ?? fallbackRegion();
};

/** The first Accept-Language entry that names a country or a mapped language. */
export const regionFromAcceptLanguage = (
  header: string | null | undefined,
): { readonly region: RegionConfig; readonly country: string | null } | null => {
  if (!header) return null;
  const tags = header
    .split(",")
    .map((part) => {
      const [tag = "", ...params] = part.trim().split(";");
      const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
      return { tag: tag.trim(), q: q ? Number(q.slice(2)) || 0 : 1 };
    })
    .filter((entry) => entry.tag.length > 0 && entry.tag !== "*")
    .toSorted((a, b) => b.q - a.q);
  for (const { tag } of tags) {
    const parts = tag.split(/[-_]/);
    const language = (parts[0] ?? "").toLowerCase();
    const country = parts.slice(1).find((part) => /^[A-Za-z]{2}$/.test(part));
    if (country) {
      const region = regionForCountry(country);
      if (region) return { region, country: country.toUpperCase() };
    }
    const byLanguage = regionByCode(LANGUAGE_REGION[language]);
    if (byLanguage) return { region: byLanguage, country: null };
  }
  return null;
};

/**
 * Where prices come from, in order: an explicit preview override, Cloudflare's
 * CF-IPCountry, Accept-Language, the account setting, then the default (US).
 */
export const resolveRegion = (input: {
  readonly override?: string | null | undefined;
  readonly cfCountry?: string | null | undefined;
  readonly acceptLanguage?: string | null | undefined;
  readonly accountRegion?: string | null | undefined;
}): ResolvedRegion => {
  const override = regionByCode(input.override);
  if (override) return { region: override, source: "override", country: null };
  if (input.cfCountry) {
    const region = regionForCountry(input.cfCountry);
    if (region) return { region, source: "cf-ipcountry", country: input.cfCountry.toUpperCase() };
  }
  const fromLanguage = regionFromAcceptLanguage(input.acceptLanguage);
  if (fromLanguage) return { ...fromLanguage, source: "accept-language" };
  const account = regionByCode(input.accountRegion);
  if (account) return { region: account, source: "account", country: null };
  return { region: regionByCode(DEFAULT_REGION) ?? REGIONS[0]!, source: "default", country: null };
};

const roundTo = (value: number, step: number) => Math.max(step, Math.round(value / step) * step);

/** The published hourly price for a role and level in a region, in its currency. */
export const hourlyRate = (region: RegionConfig, role: TalentRole, level: TalentLevel) => {
  const exact = region.overrides?.[role]?.[level];
  if (exact !== undefined) return exact;
  return roundTo(BASE_HOURLY_USD[role][level] * region.wageIndex * region.perUsd, region.roundTo);
};

/** The package a number of hours falls into: the biggest one it reaches. */
export const packageFor = (hours: number): PackageConfig | null =>
  PACKAGES.filter((pkg) => hours >= pkg.hours).at(-1) ?? null;

export interface Quote {
  readonly region: string;
  readonly currency: string;
  readonly role: TalentRole;
  readonly level: TalentLevel;
  readonly hours: number;
  readonly hourly: number;
  readonly subtotal: number;
  readonly discountPct: number;
  readonly price: number;
  readonly packageName: string | null;
  /** Rough agent tokens a person saves you on this work. An estimate, not a measurement. */
  readonly tokensSavedEstimate: number;
}

export const MIN_HOURS = 1;
export const MAX_HOURS = 80;

export const clampHours = (hours: number) =>
  Math.min(MAX_HOURS, Math.max(MIN_HOURS, Math.ceil(Number.isFinite(hours) ? hours : MIN_HOURS)));

export const quote = (
  region: RegionConfig,
  role: TalentRole,
  level: TalentLevel,
  rawHours: number,
): Quote => {
  const hours = clampHours(rawHours);
  const hourly = hourlyRate(region, role, level);
  const pkg = packageFor(hours);
  const subtotal = hourly * hours;
  const discountPct = pkg?.discountPct ?? 0;
  return {
    region: region.code,
    currency: region.currency,
    role,
    level,
    hours,
    hourly,
    subtotal,
    discountPct,
    price: roundTo(subtotal * (1 - discountPct / 100), region.roundTo),
    packageName: pkg?.name ?? null,
    tokensSavedEstimate: tokensSaved(role, hours),
  };
};

/** Heuristic: agent tokens of trial and error a person's hours replace, rounded to 10k. */
export const tokensSaved = (role: TalentRole, hours: number) =>
  Math.round((AGENT_TOKENS_PER_HUMAN_HOUR[role] * hours) / 10_000) * 10_000;

/** The whole published card for a region: hourly rates and packages. */
export const rateCard = (resolved: ResolvedRegion) => ({
  region: {
    code: resolved.region.code,
    label: resolved.region.label,
    currency: resolved.region.currency,
    source: resolved.source,
    country: resolved.country,
  },
  regions: REGIONS.map((region) => ({
    code: region.code,
    label: region.label,
    currency: region.currency,
  })),
  roles: TALENT_ROLES.map((role) => ({
    role,
    label: ROLE_LABEL[role],
    levels: TALENT_LEVELS.map((level) => ({
      level,
      label: LEVEL_LABEL[level],
      hourly: hourlyRate(resolved.region, role, level),
    })),
  })),
  packages: PACKAGES.map((pkg) => ({
    ...pkg,
    // "From": the mid-level developer price, the most common ask.
    fromPrice: quote(resolved.region, "developer", "mid", pkg.hours).price,
  })),
});

/** "PKR 22,400" / "USD 640". */
export const formatMoney = (amount: number, currency: string) =>
  `${currency} ${Math.round(amount).toLocaleString("en-US")}`;
