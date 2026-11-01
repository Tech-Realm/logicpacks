import { lpRequest } from "./api";

/**
 * Vetted freelancers (Beta): the web client for /api/lp/external, /api/lp/pricing, /api/lp/jobs
 * and the staff /api/lp/ops routes. Prices come from the server in the customer's local
 * currency; nothing here moves money.
 */

export type LpTalentRole = "designer" | "developer" | "devops";
export type LpTalentLevel = "junior" | "mid" | "senior";
export type LpVettingCheckId = "identity" | "skills" | "nda" | "keys";

export const ROLE_LABEL: Record<LpTalentRole, string> = {
  designer: "Designer",
  developer: "Developer",
  devops: "DevOps",
};
export const LEVEL_LABEL: Record<LpTalentLevel, string> = {
  junior: "Junior",
  mid: "Mid-level",
  senior: "Senior",
};

export interface LpVettingCheck {
  readonly id: LpVettingCheckId;
  readonly label: string;
  readonly detail: string;
}

export interface LpQuote {
  readonly region: string;
  readonly currency: string;
  readonly role: LpTalentRole;
  readonly level: LpTalentLevel;
  readonly hours: number;
  readonly hourly: number;
  readonly subtotal: number;
  readonly discountPct: number;
  readonly price: number;
  readonly packageName: string | null;
  readonly tokensSavedEstimate: number;
}

export interface LpBrief {
  readonly title: string;
  readonly need: string;
  readonly role: LpTalentRole;
  readonly level: LpTalentLevel;
  readonly scope: string;
  readonly deliverables: ReadonlyArray<string>;
  readonly outOfScope: ReadonlyArray<string>;
  readonly milestones: ReadonlyArray<{
    readonly title: string;
    readonly hours: number;
    readonly detail?: string;
  }>;
  readonly paths: ReadonlyArray<string>;
  readonly avoid: ReadonlyArray<string>;
  readonly hours: number;
  readonly draftedBy: "model" | "template" | "agent" | "person";
}

export interface LpRegionInfo {
  readonly code: string;
  readonly label: string;
  readonly currency: string;
  readonly source: string;
  readonly country: string | null;
}

export interface LpTalent {
  readonly id: string;
  readonly name: string;
  readonly role: LpTalentRole;
  readonly level: LpTalentLevel;
  readonly headline: string;
  readonly skills: ReadonlyArray<string>;
  readonly tools: ReadonlyArray<string>;
  readonly region: string;
  readonly timezone: string;
  readonly availability: "available" | "busy" | "away";
  readonly hoursFreePerWeek: number;
  readonly vetted: boolean;
  readonly checks: Readonly<Record<LpVettingCheckId, string | null>>;
  readonly avatar: string | null;
  readonly sample: boolean;
  /** Staff only. */
  readonly accountEmail?: string;
  readonly rateUsd?: number;
  readonly active?: boolean;
  readonly reasons?: ReadonlyArray<string>;
}

export type LpOfferStatus =
  | "offered"
  | "accepted"
  | "assigned"
  | "active"
  | "completed"
  | "cancelled"
  | "expired";

export interface LpJobApplication {
  readonly id: string;
  readonly userId: string;
  readonly name: string;
  readonly email: string;
  readonly note: string;
  readonly hours: number | null;
  readonly status: "applied" | "accepted" | "declined" | "withdrawn";
  readonly atMs: number;
}

export interface LpOffer {
  readonly id: string;
  readonly projectId: string;
  readonly projectTitle: string;
  readonly threadId: string | null;
  readonly customerName: string;
  readonly brief: LpBrief;
  readonly quote: LpQuote;
  readonly regionSource: string;
  readonly status: LpOfferStatus;
  readonly expiresAtMs: number;
  readonly assignment: {
    readonly talentId: string;
    readonly talentName: string;
    readonly role: LpTalentRole;
    readonly userId: string | null;
    readonly email: string | null;
    readonly invitePath: string | null;
    readonly joinedAtMs: number | null;
    readonly label: string;
  } | null;
  readonly hourLog: ReadonlyArray<{
    readonly id: string;
    readonly hours: number;
    readonly note: string;
    readonly by: string;
    readonly atMs: number;
  }>;
  readonly allowSharedLogin: boolean;
  readonly published: boolean;
  readonly applications: ReadonlyArray<LpJobApplication>;
  readonly applicants: number;
  readonly talent: LpTalent | null;
  readonly hoursUsed: number;
  readonly joinedLine: string | null;
  readonly charge: {
    readonly status: string;
    readonly amount: number;
    readonly currency: string;
    readonly reference: string | null;
  } | null;
  readonly payment: string;
  readonly createdAtMs: number;
}

export interface LpDraft {
  readonly brief: LpBrief;
  readonly note: string;
  readonly quote: LpQuote;
  readonly region: LpRegionInfo;
  readonly payment: string;
}

export interface LpPricing {
  readonly region: LpRegionInfo;
  readonly regions: ReadonlyArray<{
    readonly code: string;
    readonly label: string;
    readonly currency: string;
  }>;
  readonly roles: ReadonlyArray<{
    readonly role: LpTalentRole;
    readonly label: string;
    readonly levels: ReadonlyArray<{
      readonly level: LpTalentLevel;
      readonly label: string;
      readonly hourly: number;
    }>;
  }>;
  readonly packages: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly hours: number;
    readonly discountPct: number;
    readonly blurb: string;
    readonly fromPrice: number;
  }>;
  readonly vetting: ReadonlyArray<LpVettingCheck>;
  readonly offerDays: number;
  readonly payment: string;
}

export interface LpAccessCode {
  readonly id: string;
  readonly hint: string;
  readonly features: ReadonlyArray<string>;
  readonly maxUses: number | null;
  readonly uses: number;
  readonly expiresAtMs: number | null;
  readonly note: string;
  readonly createdBy: string;
  readonly createdAtMs: number;
  readonly revokedAtMs: number | null;
  readonly redeemed: number;
  readonly status: "active" | "expired" | "revoked" | "used_up";
}

/** A member's AI login stored on the cloud host, listed for the owner on /ops. */
export interface LpCloudLogin {
  readonly name: string;
  readonly email: string;
  readonly agents: ReadonlyArray<string>;
  readonly status: "unlocked" | "locked";
}

const q = (params: Record<string, string | null | undefined>) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value) search.set(key, value);
  const text = search.toString();
  return text.length === 0 ? "" : `?${text}`;
};

export const externalApi = {
  pricing: (region?: string | null) => lpRequest<LpPricing>(`/api/lp/pricing${q({ region })}`),
  draft: (input: {
    projectId: string;
    need: string;
    role?: LpTalentRole | null;
    level?: LpTalentLevel | null;
  }) => lpRequest<LpDraft>("/api/lp/external/draft", input),
  createOffer: (input: {
    projectId: string;
    threadId: string | null;
    need: string;
    brief?: LpBrief;
    accept?: boolean;
    publish?: boolean;
  }) => lpRequest<{ offer: LpOffer }>("/api/lp/external/offers", input),
  offers: (projectId: string) =>
    lpRequest<{ offers: ReadonlyArray<LpOffer> }>(`/api/lp/external/offers${q({ projectId })}`),
  accept: (offerId: string) =>
    lpRequest<{ offer: LpOffer }>("/api/lp/external/offers/accept", { offerId }),
  setSharedLogin: (offerId: string, allow: boolean) =>
    lpRequest<{ offer: LpOffer }>("/api/lp/external/offers/shared-login", { offerId, allow }),
  cancel: (offerId: string) =>
    lpRequest<{ offer: LpOffer }>("/api/lp/external/offers/cancel", { offerId }),
  complete: (offerId: string) => lpRequest<{ offer: LpOffer }>("/api/lp/ops/complete", { offerId }),
  logHours: (offerId: string, hours: number, note: string) =>
    lpRequest<{ offer: LpOffer }>("/api/lp/external/hours", { offerId, hours, note }),
  acceptApplicant: (offerId: string, applicationId: string) =>
    lpRequest<{ offer: LpOffer }>("/api/lp/external/applicants/accept", { offerId, applicationId }),
  // Staff
  opsMe: () =>
    lpRequest<{ signedIn: boolean; staff: boolean; jobs: boolean; name: string | null }>(
      "/api/lp/ops/me",
    ),
  inbox: () => lpRequest<{ offers: ReadonlyArray<LpOffer> }>("/api/lp/ops/inbox"),
  talent: (filter: { q?: string; role?: string; availability?: string }) =>
    lpRequest<{ talent: ReadonlyArray<LpTalent>; vetting: ReadonlyArray<LpVettingCheck> }>(
      `/api/lp/ops/talent${q(filter)}`,
    ),
  matches: (offerId: string) =>
    lpRequest<{
      matches: ReadonlyArray<{ talent: LpTalent; score: number; reasons: ReadonlyArray<string> }>;
    }>(`/api/lp/ops/matches${q({ offerId })}`),
  assign: (offerId: string, talentId: string) =>
    lpRequest<{ offer: LpOffer }>("/api/lp/ops/assign", { offerId, talentId }),
  publish: (offerId: string) => lpRequest<{ offer: LpOffer }>("/api/lp/ops/publish", { offerId }),
  codes: () =>
    lpRequest<{
      codes: ReadonlyArray<LpAccessCode>;
      features: ReadonlyArray<{ feature: string; label: string }>;
      staff: ReadonlyArray<{ email: string; addedBy: string; addedAtMs: number }>;
      cloudLogins?: ReadonlyArray<LpCloudLogin>;
    }>("/api/lp/ops/codes"),
  createCode: (input: {
    features: ReadonlyArray<string>;
    maxUses: number | null;
    expiresInDays: number | null;
    note: string;
  }) => lpRequest<{ code: string; codes: ReadonlyArray<LpAccessCode> }>("/api/lp/ops/codes", input),
  revokeCode: (id: string) =>
    lpRequest<{ codes: ReadonlyArray<LpAccessCode> }>("/api/lp/ops/codes/revoke", { id }),
  setStaff: (email: string, remove = false) =>
    lpRequest<{ staff: ReadonlyArray<{ email: string; addedBy: string; addedAtMs: number }> }>(
      "/api/lp/ops/staff",
      {
        email,
        remove,
      },
    ),
};

/** "PKR 22,400". */
export const formatMoney = (amount: number, currency: string) =>
  `${currency} ${Math.round(amount).toLocaleString("en-US")}`;

/** "1.5M" / "600k". */
export const formatTokens = (tokens: number) =>
  tokens >= 1_000_000
    ? `${Math.round(tokens / 100_000) / 10}M`
    : tokens >= 1000
      ? `${Math.round(tokens / 1000)}k`
      : String(tokens);

export const STATUS_TEXT: Record<LpOfferStatus, string> = {
  offered: "Offer open",
  accepted: "Accepted, matching a freelancer",
  assigned: "Freelancer invited",
  active: "Working",
  completed: "Completed",
  cancelled: "Cancelled",
  expired: "Expired",
};

export const roleLevel = (role: LpTalentRole, level: LpTalentLevel) =>
  `${LEVEL_LABEL[level]} ${role === "devops" ? ROLE_LABEL[role] : ROLE_LABEL[role].toLowerCase()}`;
