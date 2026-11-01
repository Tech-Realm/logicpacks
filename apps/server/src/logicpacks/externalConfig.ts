/**
 * External team (Beta): the one file to edit for published prices, regions, staff and the
 * secret-file list. Everything here is plain data; `externalPricing.ts` and
 * `externalTeam.ts` read it.
 *
 * SEED DATA: every number below is a placeholder until the real rate card is agreed.
 */

export type TalentRole = "designer" | "developer" | "devops";
export type TalentLevel = "junior" | "mid" | "senior";

export const TALENT_ROLES: ReadonlyArray<TalentRole> = ["designer", "developer", "devops"];
export const TALENT_LEVELS: ReadonlyArray<TalentLevel> = ["junior", "mid", "senior"];

export const ROLE_LABEL: Record<TalentRole, string> = {
  designer: "Designer",
  developer: "Developer",
  devops: "DevOps",
};

export const LEVEL_LABEL: Record<TalentLevel, string> = {
  junior: "Junior",
  mid: "Mid-level",
  senior: "Senior",
};

/** Hourly rates in USD for the reference market (US). Regions scale these. SEED DATA. */
export const BASE_HOURLY_USD: Record<TalentRole, Record<TalentLevel, number>> = {
  designer: { junior: 45, mid: 70, senior: 100 },
  developer: { junior: 50, mid: 80, senior: 120 },
  devops: { junior: 55, mid: 90, senior: 130 },
};

export interface RegionConfig {
  readonly code: string;
  readonly label: string;
  readonly currency: string;
  /** Units of `currency` per 1 USD. SEED DATA, not a live exchange rate. */
  readonly perUsd: number;
  /** Local wage level against the US (1 = US wages). SEED DATA. */
  readonly wageIndex: number;
  /** Prices round to this many units of the currency. */
  readonly roundTo: number;
  /**
   * Exact hourly prices in the local currency, when set; they win over the
   * base rate x wage index x exchange rate.
   */
  readonly overrides?: Partial<Record<TalentRole, Partial<Record<TalentLevel, number>>>>;
}

/** The region table. `INTL` is the fallback for every country not listed. SEED DATA. */
export const REGIONS: ReadonlyArray<RegionConfig> = [
  { code: "US", label: "United States", currency: "USD", perUsd: 1, wageIndex: 1, roundTo: 1 },
  {
    code: "UK",
    label: "United Kingdom",
    currency: "GBP",
    perUsd: 0.79,
    wageIndex: 0.9,
    roundTo: 1,
  },
  {
    code: "EU",
    label: "European Union",
    currency: "EUR",
    perUsd: 0.92,
    wageIndex: 0.85,
    roundTo: 1,
  },
  {
    code: "UAE",
    label: "United Arab Emirates",
    currency: "AED",
    perUsd: 3.67,
    wageIndex: 0.8,
    roundTo: 5,
  },
  { code: "PK", label: "Pakistan", currency: "PKR", perUsd: 280, wageIndex: 0.25, roundTo: 100 },
  { code: "IN", label: "India", currency: "INR", perUsd: 84, wageIndex: 0.3, roundTo: 50 },
  {
    code: "INTL",
    label: "Rest of the world",
    currency: "USD",
    perUsd: 1,
    wageIndex: 0.7,
    roundTo: 1,
  },
];

export const DEFAULT_REGION = "US";
export const FALLBACK_REGION = "INTL";

/** ISO 3166 country codes for the regions above (anything else is INTL). */
export const COUNTRY_REGION: Readonly<Record<string, string>> = {
  US: "US",
  GB: "UK",
  UK: "UK",
  AE: "UAE",
  PK: "PK",
  IN: "IN",
  ...Object.fromEntries(
    [
      "AT",
      "BE",
      "BG",
      "HR",
      "CY",
      "CZ",
      "DK",
      "EE",
      "FI",
      "FR",
      "DE",
      "GR",
      "HU",
      "IE",
      "IT",
      "LV",
      "LT",
      "LU",
      "MT",
      "NL",
      "PL",
      "PT",
      "RO",
      "SK",
      "SI",
      "ES",
      "SE",
    ].map((country) => [country, "EU"]),
  ),
};

/** Languages that point to a region when Accept-Language has no country ("de", "ur"). */
export const LANGUAGE_REGION: Readonly<Record<string, string>> = {
  de: "EU",
  fr: "EU",
  es: "EU",
  it: "EU",
  nl: "EU",
  pl: "EU",
  pt: "EU",
  ur: "PK",
  hi: "IN",
};

/** Packages: N human hours included, with a small discount on the bigger ones. SEED DATA. */
export interface PackageConfig {
  readonly id: string;
  readonly name: string;
  readonly hours: number;
  readonly discountPct: number;
  readonly blurb: string;
}

export const PACKAGES: ReadonlyArray<PackageConfig> = [
  { id: "quick", name: "Quick fix", hours: 2, discountPct: 0, blurb: "One small, clear task." },
  { id: "starter", name: "Starter", hours: 5, discountPct: 0, blurb: "A feature or a setup." },
  {
    id: "sprint",
    name: "Sprint",
    hours: 10,
    discountPct: 5,
    blurb: "A few related pieces of work.",
  },
  {
    id: "project",
    name: "Project",
    hours: 20,
    discountPct: 10,
    blurb: "A larger piece, in milestones.",
  },
];

/** Days an offer stays open before it expires. */
export const OFFER_DAYS = 7;

/** LogicPacks staff (who see /ops) are listed in `accessConfig.ts`. */

/**
 * Files hidden from external team members and their agents. Basename globs ("*.pem") match in
 * any folder; patterns with a slash ("secrets/**") match from the project root. Extend on the
 * host with LOGICPACKS_EXTERNAL_SECRET_PATTERNS (comma separated).
 */
export const SECRET_PATTERNS: ReadonlyArray<string> = [
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "*.keystore",
  "*.jks",
  "id_rsa",
  "id_rsa.*",
  "id_ed25519",
  "id_ed25519.*",
  ".npmrc",
  ".pypirc",
  ".netrc",
  "credentials.json",
  "service-account*.json",
  ".secrets/**",
  "secrets/**",
];

/** Templates that are safe to show even though they look like env files. */
export const SECRET_ALLOW: ReadonlyArray<string> = [".env.example", ".env.sample", ".env.template"];

/**
 * What vetting covers, shown on every profile and on /pricing. The per-profile results in the
 * talent seed are SEED DATA.
 */
export const VETTING_CHECKS: ReadonlyArray<{
  readonly id: VettingCheckId;
  readonly label: string;
  readonly detail: string;
}> = [
  {
    id: "identity",
    label: "Identity verified",
    detail: "Government ID checked against a live video call.",
  },
  {
    id: "skills",
    label: "Skills test passed",
    detail: "A paid, timed task in their role, reviewed by a senior.",
  },
  {
    id: "nda",
    label: "NDA signed",
    detail: "Covers your code, data and anything they see in your project.",
  },
  {
    id: "keys",
    label: "Keys-never-shared policy",
    detail: "Never copies, asks for or pastes secrets; access ends with the job.",
  },
];
export type VettingCheckId = "identity" | "skills" | "nda" | "keys";

/**
 * Token-savings estimate shown next to the human option: a heuristic, labelled as an estimate.
 * One human hour of this kind of work is roughly this many agent tokens of trial and error.
 */
export const AGENT_TOKENS_PER_HUMAN_HOUR: Record<TalentRole, number> = {
  designer: 60_000,
  developer: 120_000,
  devops: 150_000,
};
