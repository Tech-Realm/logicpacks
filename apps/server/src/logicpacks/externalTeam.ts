/**
 * External team (Beta): a customer asks for a vetted human, gets a brief and a priced offer,
 * accepts it, and LogicPacks staff assign someone who joins the project as a scoped member.
 * Plain data and rules, no Effect and no storage, so every rule is unit-tested directly.
 * `ExternalTeamService.ts` stores them and `externalHttp.ts` runs the flow.
 */
import {
  LEVEL_LABEL,
  OFFER_DAYS,
  ROLE_LABEL,
  SECRET_ALLOW,
  SECRET_PATTERNS,
  TALENT_LEVELS,
  TALENT_ROLES,
  type TalentLevel,
  type TalentRole,
} from "./externalConfig.ts";
import type { Quote } from "./externalPricing.ts";
import type { TalentProfile } from "./externalTalentSeed.ts";
import { pathMatches } from "./goals.ts";

// ── Briefs ────────────────────────────────────────────────────────────────

export interface BriefMilestone {
  readonly title: string;
  readonly hours: number;
  readonly criteria: ReadonlyArray<string>;
}

export interface Brief {
  readonly title: string;
  /** What the customer asked for, in their words. */
  readonly need: string;
  readonly role: TalentRole;
  readonly level: TalentLevel;
  readonly scope: string;
  readonly deliverables: ReadonlyArray<string>;
  readonly outOfScope: ReadonlyArray<string>;
  readonly milestones: ReadonlyArray<BriefMilestone>;
  /** Folders the work may touch (the goal's guardrails); empty means anywhere not avoided. */
  readonly paths: ReadonlyArray<string>;
  /** Folders and files the work must not touch. */
  readonly avoid: ReadonlyArray<string>;
  readonly hours: number;
  /** Who drafted it: a model on the host's own login, or the built-in template estimator. */
  readonly draftedBy: "model" | "template" | "agent" | "person";
}

const ROLE_WORDS: Record<TalentRole, ReadonlyArray<string>> = {
  devops: [
    "deploy",
    "deployment",
    "ci",
    "cd",
    "pipeline",
    "docker",
    "kubernetes",
    "k8s",
    "aws",
    "gcp",
    "azure",
    "server",
    "nginx",
    "dns",
    "ssl",
    "certificate",
    "terraform",
    "hosting",
    "monitoring",
    "infra",
    "infrastructure",
    "backup",
    "uptime",
    "github actions",
    "vps",
    "cloudflare",
    "devops",
  ],
  designer: [
    "design",
    "designer",
    "figma",
    "logo",
    "ui",
    "ux",
    "mockup",
    "wireframe",
    "brand",
    "branding",
    "illustration",
    "icon",
    "icons",
    "landing page look",
    "visual",
    "typography",
    "prototype",
  ],
  developer: [
    "bug",
    "fix",
    "api",
    "feature",
    "react",
    "backend",
    "frontend",
    "database",
    "integrate",
    "integration",
    "endpoint",
    "typescript",
    "python",
    "node",
    "app",
    "code",
    "test",
    "tests",
    "refactor",
    "stripe",
    "auth",
    "login",
    "developer",
  ],
};

const SENIOR_WORDS = [
  "senior",
  "architect",
  "architecture",
  "complex",
  "scale",
  "scaling",
  "migration",
  "security",
  "audit",
  "performance",
];
const JUNIOR_WORDS = ["simple", "small", "quick", "tiny", "typo", "minor", "junior"];
const BIG_WORDS = [
  "whole",
  "entire",
  "full",
  "complete",
  "rebuild",
  "redesign",
  "migrate",
  "migration",
  "from scratch",
];
const SMALL_WORDS = ["small", "quick", "tiny", "typo", "minor", "one"];

const wordHit = (text: string, word: string) =>
  new RegExp(`(^|[^a-z0-9])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`).test(text);

const countHits = (text: string, words: ReadonlyArray<string>) =>
  words.reduce((sum, word) => sum + (wordHit(text, word) ? 1 : 0), 0);

export const guessRole = (need: string): TalentRole => {
  const text = need.toLowerCase();
  const scores = TALENT_ROLES.map((role) => ({ role, score: countHits(text, ROLE_WORDS[role]) }));
  const best = scores.toSorted((a, b) => b.score - a.score)[0]!;
  return best.score === 0 ? "developer" : best.role;
};

export const guessLevel = (need: string): TalentLevel => {
  const text = need.toLowerCase();
  if (countHits(text, SENIOR_WORDS) > 0) return "senior";
  if (countHits(text, JUNIOR_WORDS) > 0) return "junior";
  return "mid";
};

/** Folders and files named in the need: "in ci/ and deploy/", "src/api", "Dockerfile". */
export const pathsInText = (need: string): ReadonlyArray<string> => {
  const found = new Set<string>();
  for (const match of need.matchAll(
    /(?:^|[\s(`'"])((?:\.?[A-Za-z0-9_-]+\/)+(?:[A-Za-z0-9_.-]+)?|[A-Za-z0-9_-]+\.(?:ya?ml|json|toml|tsx?|jsx?|py|go|rs|md|css|html|sh)|Dockerfile|Makefile)(?=$|[\s),.;:`'"])/g,
  )) {
    const path = match[1]!.replace(/^\.\//, "");
    if (path.startsWith("http") || path.includes("//")) continue;
    found.add(path);
  }
  return Array.from(found).slice(0, 12);
};

/** How many separate asks: sentences, bullets and "and then"s. */
const askCount = (need: string) => {
  const parts = need
    .split(/\n|[.;!?](?:\s|$)|\band then\b|\balso\b|\bplus\b/i)
    .map((part) => part.trim())
    .filter((part) => part.length > 8);
  return Math.max(1, parts.length);
};

const BASE_HOURS: Record<TalentRole, number> = { developer: 6, devops: 5, designer: 5 };
const LEVEL_FACTOR: Record<TalentLevel, number> = { junior: 0.8, mid: 1, senior: 1.3 };

/** Hours for a need: a role base, more for each extra ask and for big words, less for small ones. */
export const estimateHours = (need: string, role: TalentRole, level: TalentLevel) => {
  const text = need.toLowerCase();
  let hours = BASE_HOURS[role] + (askCount(need) - 1) * 2.5;
  hours += countHits(text, BIG_WORDS) * 6;
  if (countHits(text, SMALL_WORDS) > 0) hours *= 0.5;
  hours *= LEVEL_FACTOR[level];
  return Math.min(40, Math.max(2, Math.round(hours)));
};

const MILESTONE_TEMPLATES: Record<
  TalentRole,
  ReadonlyArray<{ title: string; share: number; criteria: ReadonlyArray<string> }>
> = {
  developer: [
    {
      title: "Reproduce and plan",
      share: 0.2,
      criteria: [
        "The problem is reproduced or the change is specified",
        "Plan agreed in the thread",
      ],
    },
    {
      title: "Build",
      share: 0.55,
      criteria: ["The change works in the project", "No unrelated files changed"],
    },
    {
      title: "Test and hand over",
      share: 0.25,
      criteria: ["Tests or a manual check described", "Short handover note in the thread"],
    },
  ],
  devops: [
    {
      title: "Review the current setup",
      share: 0.25,
      criteria: ["What exists today is written down", "Plan agreed in the thread"],
    },
    {
      title: "Set it up",
      share: 0.5,
      criteria: ["The setup runs end to end", "No secrets committed or pasted"],
    },
    {
      title: "Verify and document",
      share: 0.25,
      criteria: ["A green run or a working deploy shown", "How to run it is documented"],
    },
  ],
  designer: [
    {
      title: "Direction and wireframes",
      share: 0.3,
      criteria: ["Two directions or one wireframe agreed"],
    },
    { title: "Design", share: 0.5, criteria: ["Designs cover the agreed screens"] },
    { title: "Handoff", share: 0.2, criteria: ["Files and specs a developer can build from"] },
  ],
};

const DELIVERABLES: Record<TalentRole, ReadonlyArray<string>> = {
  developer: [
    "Working code in the project, on a branch or committed as agreed",
    "A short note on what changed and how to check it",
  ],
  devops: [
    "A working setup in the project (config, scripts or pipeline)",
    "Run and rollback notes in the project",
  ],
  designer: [
    "Design files or exported assets in the project",
    "A handoff note with sizes, colours and states",
  ],
};

export const DEFAULT_OUT_OF_SCOPE: ReadonlyArray<string> = [
  "Work not listed in the deliverables (ask for a new offer)",
  "Reading or handling your secrets, keys or production credentials",
  "Ongoing maintenance after the handover",
  "Paid third-party services or licences",
];

/** Secret files are never in scope, whatever the brief says. */
export const DEFAULT_AVOID: ReadonlyArray<string> = [
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  "secrets/",
];

/** Splits hours across milestones by their share; every milestone gets at least one hour. */
export const splitHours = (total: number, shares: ReadonlyArray<number>) => {
  const raw = shares.map((share) => Math.max(1, Math.round(total * share)));
  const diff = total - raw.reduce((a, b) => a + b, 0);
  const biggest = raw.indexOf(Math.max(...raw));
  raw[biggest] = Math.max(1, raw[biggest]! + diff);
  return raw;
};

const titleFrom = (need: string) => {
  const first = need.split(/\n|[.!?](?:\s|$)/)[0]?.trim() ?? "";
  const clipped = first.length > 70 ? `${first.slice(0, 69).trimEnd()}…` : first;
  return clipped.length > 0
    ? clipped[0]!.toUpperCase() + clipped.slice(1)
    : "Help with this project";
};

/**
 * The deterministic template estimator: no model, no network. Used when no model is
 * available or the host turns drafting off, and as the base a model's draft is merged into.
 */
export const templateBrief = (input: {
  readonly need: string;
  readonly role?: TalentRole | null | undefined;
  readonly level?: TalentLevel | null | undefined;
}): Brief => {
  const need = input.need.trim();
  const role = input.role ?? guessRole(need);
  const level = input.level ?? guessLevel(need);
  const hours = estimateHours(need, role, level);
  const template = MILESTONE_TEMPLATES[role];
  const split = splitHours(
    hours,
    template.map((m) => m.share),
  );
  return {
    title: titleFrom(need),
    need,
    role,
    level,
    scope: need,
    deliverables: DELIVERABLES[role],
    outOfScope: DEFAULT_OUT_OF_SCOPE,
    milestones: template.map((m, index) => ({
      title: m.title,
      hours: split[index]!,
      criteria: m.criteria,
    })),
    paths: pathsInText(need),
    avoid: DEFAULT_AVOID,
    hours,
    draftedBy: "template",
  };
};

const cleanList = (items: unknown, max: number, length: number): ReadonlyArray<string> =>
  Array.isArray(items)
    ? Array.from(
        new Set(
          items
            .filter((item): item is string => typeof item === "string")
            .map((item) => item.trim().slice(0, length))
            .filter((item) => item.length > 0),
        ),
      ).slice(0, max)
    : [];

const cleanPath = (path: string) =>
  path.trim().replace(/^\.\//, "").replace(/^\/+/, "").replaceAll("\\", "/");

/**
 * Checks a brief someone edited (or a model or agent drafted) against a base; anything
 * missing or invalid keeps the base value. Hours always equal the milestones' sum.
 */
export const normalizeBrief = (raw: unknown, base: Brief): Brief => {
  const record = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const text = (key: string, max: number, fallback: string) =>
    typeof record[key] === "string" && (record[key] as string).trim().length > 0
      ? (record[key] as string).trim().slice(0, max)
      : fallback;
  const role = TALENT_ROLES.includes(record.role as TalentRole)
    ? (record.role as TalentRole)
    : base.role;
  const level = TALENT_LEVELS.includes(record.level as TalentLevel)
    ? (record.level as TalentLevel)
    : base.level;
  const milestones = Array.isArray(record.milestones)
    ? record.milestones
        .map((m): BriefMilestone | null => {
          if (m === null || typeof m !== "object") return null;
          const entry = m as Record<string, unknown>;
          const title = typeof entry.title === "string" ? entry.title.trim().slice(0, 200) : "";
          const hours = Math.round(Number(entry.hours));
          if (title.length === 0) return null;
          return {
            title,
            hours: Number.isFinite(hours) ? Math.min(40, Math.max(1, hours)) : 1,
            criteria: cleanList(entry.criteria, 8, 300),
          };
        })
        .filter((m): m is BriefMilestone => m !== null)
        .slice(0, 8)
    : [];
  const kept = milestones.length > 0 ? milestones : base.milestones;
  const hasList = (key: string) => Array.isArray(record[key]);
  return {
    title: text("title", 200, base.title),
    need: base.need,
    role,
    level,
    scope: text("scope", 4000, base.scope),
    deliverables: hasList("deliverables")
      ? cleanList(record.deliverables, 12, 300)
      : base.deliverables,
    outOfScope: hasList("outOfScope") ? cleanList(record.outOfScope, 12, 300) : base.outOfScope,
    milestones: kept,
    paths: hasList("paths") ? cleanList(record.paths, 20, 300).map(cleanPath) : base.paths,
    // Secret files stay avoided even if an edit drops them.
    avoid: Array.from(
      new Set([
        ...DEFAULT_AVOID,
        ...(hasList("avoid") ? cleanList(record.avoid, 20, 300).map(cleanPath) : base.avoid),
      ]),
    ),
    hours: kept.reduce((sum, m) => sum + m.hours, 0),
    draftedBy: base.draftedBy,
  };
};

/** Pulls the first JSON object out of a model reply ("```json {...} ```" or plain). */
export const parseModelJson = (text: string): unknown => {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
};

export const DRAFT_INSTRUCTIONS = `You write a short work brief for a vetted freelancer (designer, developer or devops).
Reply with ONLY a JSON object, no prose:
{"title": string, "role": "designer"|"developer"|"devops", "level": "junior"|"mid"|"senior",
 "scope": string, "deliverables": string[], "outOfScope": string[], "paths": string[],
 "milestones": [{"title": string, "hours": number, "criteria": string[]}]}
Keep it small and concrete: 2-4 milestones, honest hours (1-40 in total), paths are project folders the work may touch.`;

export const draftPrompt = (need: string, context: string) =>
  `Customer need:\n${need}\n\nProject context:\n${context || "(none)"}\n`;

// ── Offers ────────────────────────────────────────────────────────────────

export type OfferStatus =
  | "offered"
  | "accepted"
  | "assigned"
  | "active"
  | "completed"
  | "cancelled"
  | "expired";

export const LIVE_OFFER: ReadonlySet<OfferStatus> = new Set([
  "offered",
  "accepted",
  "assigned",
  "active",
]);
/** Statuses where the person has (or is about to have) access. */
export const ACCESS_OFFER: ReadonlySet<OfferStatus> = new Set(["assigned", "active"]);

export interface Assignment {
  readonly talentId: string;
  readonly talentName: string;
  readonly role: TalentRole;
  readonly email: string;
  /** Their LogicPacks account, once it exists. */
  readonly userId: string | null;
  /** The project invite when they had no account yet. */
  readonly inviteId: string | null;
  readonly invitePath: string | null;
  /** Assigning added them to the project; ending removes only such a membership. */
  readonly addedMember: boolean;
  readonly goalId: string | null;
  readonly assignedBy: string;
  readonly assignedAtMs: number;
  readonly joinedAtMs: number | null;
}

export interface HourEntry {
  readonly id: string;
  readonly hours: number;
  readonly note: string;
  readonly by: string;
  readonly atMs: number;
}

export type ChargeStatus = "pending" | "invoiced" | "paid" | "void";

/** The internal ledger row an accepted offer creates. No real payment happens here. */
export interface Charge {
  readonly id: string;
  readonly offerId: string;
  readonly amount: number;
  readonly currency: string;
  readonly status: ChargeStatus;
  /** The PaymentProvider that holds it ("invoice" until a real provider is approved). */
  readonly provider: string;
  readonly reference: string | null;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface Offer {
  readonly id: string;
  readonly projectId: string;
  readonly projectTitle: string;
  /** The thread it was asked from; notices go there. */
  readonly threadId: string | null;
  /** Null when the host operator asked. */
  readonly customerUserId: string | null;
  readonly customerName: string;
  readonly brief: Brief;
  readonly quote: Quote;
  /** How the region was picked, for staff ("cf-ipcountry PK"). */
  readonly regionSource: string;
  readonly status: OfferStatus;
  readonly expiresAtMs: number;
  readonly assignment: Assignment | null;
  readonly hourLog: ReadonlyArray<HourEntry>;
  /** The customer let this person run turns on the customer's own shared login (off by default). */
  readonly allowSharedLogin: boolean;
  /** An open proposal on the jobs board: freelancers can apply. */
  readonly published: boolean;
  readonly applications: ReadonlyArray<JobApplication>;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly history: ReadonlyArray<{
    readonly status: OfferStatus;
    readonly atMs: number;
    readonly by: string;
  }>;
}

export type ApplicationStatus = "applied" | "accepted" | "declined" | "withdrawn";

/** A freelancer's application to an open proposal. */
export interface JobApplication {
  readonly id: string;
  readonly userId: string;
  readonly name: string;
  readonly email: string;
  readonly note: string;
  /** Their own estimate, when they give one. */
  readonly hours: number | null;
  readonly status: ApplicationStatus;
  readonly atMs: number;
}

export class OfferRuleError extends Error {
  readonly reason: "invalid" | "forbidden";
  constructor(reason: "invalid" | "forbidden", message: string) {
    super(message);
    this.reason = reason;
  }
}

const refuse = (reason: OfferRuleError["reason"], message: string): never => {
  throw new OfferRuleError(reason, message);
};

const moved = (
  offer: Offer,
  status: OfferStatus,
  nowMs: number,
  by: string,
  patch: Partial<Offer> = {},
): Offer => ({
  ...offer,
  ...patch,
  status,
  updatedAtMs: nowMs,
  history:
    offer.status === status ? offer.history : [...offer.history, { status, atMs: nowMs, by }],
});

export const makeOffer = (input: {
  readonly id: string;
  readonly projectId: string;
  readonly projectTitle: string;
  readonly threadId: string | null;
  readonly customerUserId: string | null;
  readonly customerName: string;
  readonly brief: Brief;
  readonly quote: Quote;
  readonly regionSource: string;
  readonly nowMs: number;
}): Offer => ({
  id: input.id,
  projectId: input.projectId,
  projectTitle: input.projectTitle,
  threadId: input.threadId,
  customerUserId: input.customerUserId,
  customerName: input.customerName,
  brief: input.brief,
  quote: input.quote,
  regionSource: input.regionSource,
  status: "offered",
  expiresAtMs: input.nowMs + OFFER_DAYS * 24 * 60 * 60 * 1000,
  assignment: null,
  hourLog: [],
  allowSharedLogin: false,
  published: false,
  applications: [],
  createdAtMs: input.nowMs,
  updatedAtMs: input.nowMs,
  history: [{ status: "offered", atMs: input.nowMs, by: input.customerName }],
});

/** An offered offer past its expiry is expired; nothing else changes. */
export const withExpiry = (offer: Offer, nowMs: number): Offer =>
  offer.status === "offered" && nowMs > offer.expiresAtMs
    ? moved(offer, "expired", nowMs, "LogicPacks")
    : offer;

export const acceptOffer = (offer: Offer, by: string, nowMs: number): Offer => {
  const current = withExpiry(offer, nowMs);
  if (current.status === "expired") refuse("invalid", "This offer has expired. Ask for a new one.");
  if (current.status !== "offered") refuse("invalid", `This offer is ${current.status}.`);
  return moved(current, "accepted", nowMs, by);
};

export const assignOffer = (offer: Offer, assignment: Assignment, nowMs: number): Offer => {
  if (offer.status !== "accepted") {
    refuse(
      "invalid",
      offer.status === "offered"
        ? "The customer has not accepted this offer yet."
        : `This offer is ${offer.status}.`,
    );
  }
  return moved(offer, "assigned", nowMs, assignment.assignedBy, { assignment });
};

/** The assigned person is now in the project. */
export const activateOffer = (
  offer: Offer,
  patch: { readonly userId: string; readonly goalId: string | null },
  nowMs: number,
): Offer => {
  if (offer.status !== "assigned" || offer.assignment === null)
    refuse("invalid", `This offer is ${offer.status}.`);
  return moved(offer, "active", nowMs, offer.assignment!.talentName, {
    assignment: {
      ...offer.assignment!,
      userId: patch.userId,
      goalId: patch.goalId,
      joinedAtMs: nowMs,
    },
  });
};

// ── Jobs board (open proposals) ───────────────────────────────────────────

/** An accepted offer nobody is assigned to yet becomes a job freelancers can apply to. */
export const publishOffer = (offer: Offer, by: string, nowMs: number): Offer => {
  if (offer.status !== "accepted")
    refuse("invalid", "Only an accepted offer without a person can be published.");
  if (offer.published) return offer;
  return {
    ...offer,
    published: true,
    updatedAtMs: nowMs,
    history: [...offer.history, { status: offer.status, atMs: nowMs, by: `${by} (published)` }],
  };
};

export const isOpenJob = (offer: Offer) => offer.published && offer.status === "accepted";

export const applyToJob = (offer: Offer, application: JobApplication): Offer => {
  if (!isOpenJob(offer)) refuse("invalid", "This job is no longer open.");
  const mine = offer.applications.find(
    (a) => a.userId === application.userId && a.status === "applied",
  );
  if (mine) refuse("invalid", "You already applied to this job.");
  if (application.note.trim().length < 5)
    refuse("invalid", "Say a few words about how you would do it.");
  return {
    ...offer,
    applications: [...offer.applications, application],
    updatedAtMs: application.atMs,
  };
};

/** Marks the accepted application and declines the rest. */
export const settleApplications = (offer: Offer, acceptedId: string): Offer => ({
  ...offer,
  published: false,
  applications: offer.applications.map((a) =>
    a.id === acceptedId
      ? { ...a, status: "accepted" as const }
      : a.status === "applied"
        ? { ...a, status: "declined" as const }
        : a,
  ),
});

/**
 * What freelancers see before they are accepted: no customer, project, repo or folder names,
 * and pasted secrets redacted.
 */
export const jobView = (offer: Offer, viewerUserId: string | null = null) => {
  const hide = (text: string) => {
    let out = redactSecrets(text);
    for (const name of [offer.projectTitle, offer.customerName].filter(
      (n) => n.trim().length > 2,
    )) {
      out = out.split(name).join("[project]");
    }
    for (const path of offer.brief.paths) out = out.split(path).join("[folder]");
    return out
      .replace(/\b(?:https?:\/\/|git@)\S+/g, "[link]")
      .replace(/\b[\w.-]+\/[\w.-]+\.git\b/g, "[repo]");
  };
  const mine =
    viewerUserId === null ? undefined : offer.applications.find((a) => a.userId === viewerUserId);
  return {
    id: offer.id,
    title: hide(offer.brief.title),
    role: offer.brief.role,
    level: offer.brief.level,
    hours: offer.quote.hours,
    scope: hide(offer.brief.scope),
    deliverables: offer.brief.deliverables.map(hide),
    outOfScope: offer.brief.outOfScope,
    milestones: offer.brief.milestones.map((m) => ({ title: hide(m.title), hours: m.hours })),
    postedAtMs: offer.updatedAtMs,
    applicants: offer.applications.filter((a) => a.status === "applied").length,
    myApplication:
      mine === undefined ? null : { id: mine.id, status: mine.status, atMs: mine.atMs },
  };
};
export type JobView = ReturnType<typeof jobView>;

export const searchJobs = (
  offers: ReadonlyArray<Offer>,
  filter: { readonly role?: string | undefined; readonly skills?: string | undefined },
) => {
  const skills = (filter.skills ?? "")
    .toLowerCase()
    .split(/[,\s]+/)
    .filter((s) => s.length > 0);
  return offers
    .filter(isOpenJob)
    .filter((offer) => !filter.role || offer.brief.role === filter.role)
    .filter((offer) => {
      if (skills.length === 0) return true;
      const text = `${offer.brief.title} ${offer.brief.scope} ${offer.brief.need}`.toLowerCase();
      return skills.some((skill) => text.includes(skill));
    })
    .toSorted((a, b) => b.updatedAtMs - a.updatedAtMs);
};

export const hoursUsed = (offer: Offer) =>
  Math.round(offer.hourLog.reduce((sum, entry) => sum + entry.hours, 0) * 100) / 100;

/** Hours go against the quota; going over needs a new offer. */
export const logHours = (offer: Offer, entry: HourEntry): Offer => {
  if (!ACCESS_OFFER.has(offer.status))
    refuse("invalid", "Hours can only be logged while the work is open.");
  if (!(entry.hours > 0) || entry.hours > 24)
    refuse("invalid", "Log between a few minutes and 24 hours at a time.");
  const used = hoursUsed(offer);
  if (used + entry.hours > offer.quote.hours + 1e-9) {
    refuse(
      "invalid",
      `That goes over the ${offer.quote.hours} hours included (${used} used). More time needs a new offer.`,
    );
  }
  return { ...offer, hourLog: [...offer.hourLog, entry], updatedAtMs: entry.atMs };
};

export const endOffer = (
  offer: Offer,
  outcome: "completed" | "cancelled",
  by: string,
  nowMs: number,
): Offer => {
  if (!LIVE_OFFER.has(offer.status)) refuse("invalid", `This offer is already ${offer.status}.`);
  if (outcome === "completed" && !ACCESS_OFFER.has(offer.status)) {
    refuse("invalid", "Only assigned work can be completed; cancel it instead.");
  }
  return moved(offer, outcome, nowMs, by);
};

/** "Omar K. (vetted devops freelancer)". */
export const talentLabel = (assignment: Pick<Assignment, "talentName" | "role">) =>
  `${assignment.talentName} (vetted ${ROLE_LABEL[assignment.role].toLowerCase()} freelancer)`;

/** The line the customer sees in the thread: "Omar K. (vetted devops freelancer) joined: 6 of 10 hours used". */
export const joinedLine = (offer: Offer) =>
  offer.assignment === null
    ? null
    : `${talentLabel(offer.assignment)} ${offer.status === "active" ? "joined" : offer.status === "assigned" ? "is invited" : offer.status}: ${hoursUsed(offer)} of ${offer.quote.hours} hours used`;

export const roleLevelLabel = (role: TalentRole, level: TalentLevel) =>
  `${LEVEL_LABEL[level]} ${ROLE_LABEL[role].toLowerCase()}`;

// ── Talent search and matching ────────────────────────────────────────────

/** What customers and their agents see: no account email or pay rate. */
export type PublicTalent = Omit<TalentProfile, "accountEmail" | "rateUsd" | "active">;

export const publicTalent = ({
  accountEmail: _e,
  rateUsd: _r,
  active: _a,
  ...rest
}: TalentProfile): PublicTalent => rest;

const tokens = (text: string) =>
  new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9+#.]+/)
      .filter((token) => token.length > 1),
  );

const AVAILABILITY_SCORE = { available: 4, busy: 1, away: -6 } as const;

export interface TalentMatch {
  readonly talent: TalentProfile;
  readonly score: number;
  readonly reasons: ReadonlyArray<string>;
}

/** Ranks active profiles for a brief: role first, then skills named in it, level and availability. */
export const matchTalent = (
  talents: ReadonlyArray<TalentProfile>,
  brief: Pick<Brief, "role" | "level" | "need" | "scope" | "title" | "hours">,
  limit = 5,
): ReadonlyArray<TalentMatch> => {
  const text = `${brief.title} ${brief.need} ${brief.scope}`.toLowerCase();
  const words = tokens(text);
  return talents
    .filter((talent) => talent.active)
    .map((talent) => {
      const reasons: Array<string> = [];
      let score = 0;
      if (talent.role === brief.role) {
        score += 10;
        reasons.push(ROLE_LABEL[talent.role]);
      }
      const skills = talent.skills.filter(
        (skill) => words.has(skill.toLowerCase()) || text.includes(skill.toLowerCase()),
      );
      score += skills.length * 3;
      if (skills.length > 0) reasons.push(`Knows ${skills.join(", ")}`);
      if (talent.level === brief.level) {
        score += 2;
        reasons.push(LEVEL_LABEL[talent.level]);
      }
      score += AVAILABILITY_SCORE[talent.availability];
      reasons.push(
        talent.availability === "available"
          ? "Available now"
          : talent.availability === "busy"
            ? "Busy"
            : "Away",
      );
      if (talent.hoursFreePerWeek >= brief.hours) {
        score += 2;
        reasons.push(`${talent.hoursFreePerWeek} h free this week`);
      }
      return { talent, score, reasons };
    })
    .toSorted((a, b) => b.score - a.score || a.talent.name.localeCompare(b.talent.name))
    .slice(0, limit);
};

/** Directory search: free text over name, headline, skills and tools; optional role and availability. */
export const searchTalent = (
  talents: ReadonlyArray<TalentProfile>,
  filter: {
    readonly q?: string | undefined;
    readonly role?: string | undefined;
    readonly availability?: string | undefined;
  },
): ReadonlyArray<TalentProfile> => {
  const q = (filter.q ?? "").trim().toLowerCase();
  const order = { available: 0, busy: 1, away: 2 } as const;
  return talents
    .filter((talent) => talent.active)
    .filter((talent) => !filter.role || talent.role === filter.role)
    .filter((talent) => !filter.availability || talent.availability === filter.availability)
    .filter(
      (talent) =>
        q.length === 0 ||
        q
          .split(/\s+/)
          .every((word) =>
            [
              talent.name,
              talent.headline,
              talent.role,
              talent.region,
              ...talent.skills,
              ...talent.tools,
            ]
              .join(" ")
              .toLowerCase()
              .includes(word),
          ),
    )
    .toSorted(
      (a, b) => order[a.availability] - order[b.availability] || a.name.localeCompare(b.name),
    );
};

// ── Secrets ───────────────────────────────────────────────────────────────

/** The configured list plus LOGICPACKS_EXTERNAL_SECRET_PATTERNS from the host. */
export const secretPatterns = (extra: string | undefined = undefined): ReadonlyArray<string> =>
  Array.from(
    new Set([
      ...SECRET_PATTERNS,
      ...(extra ?? "")
        .split(",")
        .map((pattern) => pattern.trim())
        .filter((pattern) => pattern.length > 0),
    ]),
  );

const basenameGlob = (name: string, pattern: string) =>
  new RegExp(
    `^${pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replaceAll("*", ".*")
      .replaceAll("?", ".")}$`,
    "i",
  ).test(name);

/** Whether a project-relative (or absolute) path is a secret file or inside a secret folder. */
export const isSecretPath = (
  path: string,
  patterns: ReadonlyArray<string> = SECRET_PATTERNS,
): boolean => {
  const normal = path.trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (normal.length === 0) return false;
  const segments = normal.split("/").filter((s) => s.length > 0);
  const base = segments.at(-1) ?? "";
  if (SECRET_ALLOW.some((allowed) => allowed.toLowerCase() === base.toLowerCase())) return false;
  for (const pattern of patterns) {
    if (pattern.includes("/")) {
      const folder = pattern.replace(/\/\*\*$/, "").replace(/\/$/, "");
      // A secret folder anywhere in the path ("secrets/**" hides app/secrets/x too).
      if (!/[*?]/.test(folder) && segments.includes(folder)) return true;
      if (pathMatches(normal.replace(/^\/+/, ""), pattern)) return true;
    } else if (segments.some((segment) => basenameGlob(segment, pattern))) {
      return true;
    }
  }
  return false;
};

/** A path relative to a project root, or null when it is outside. */
export const relativeToRoot = (root: string, candidate: string): string | null => {
  const r = root.replace(/\/+$/, "");
  if (!candidate.startsWith("/")) return candidate;
  if (candidate === r) return "";
  return candidate.startsWith(`${r}/`) ? candidate.slice(r.length + 1) : null;
};

const REDACTED = "[redacted]";

const SECRET_REGEXES: ReadonlyArray<{ readonly re: RegExp; readonly keep?: number }> = [
  { re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g },
  { re: /\bAKIA[0-9A-Z]{16}\b/g },
  { re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g },
  { re: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g },
  { re: /\bsk-(?:ant-|proj-|live-)?[A-Za-z0-9_-]{20,}\b/g },
  { re: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
];

/** KEY=value and "key": "value" where the key says secret, token, password or key. */
const ASSIGNMENT =
  /\b([A-Za-z0-9_.-]*(?:SECRET|TOKEN|PASSWORD|PASSWD|PWD|API[_-]?KEY|PRIVATE[_-]?KEY|ACCESS[_-]?KEY|CLIENT[_-]?SECRET|AUTH)[A-Za-z0-9_.-]*)(["']?\s*[:=]\s*["']?)([^\s"',;]{6,})/gi;
/** scheme://user:password@host */
const URL_PASSWORD = /\b([a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:)([^@\s]{3,})(@)/gi;

/** Replaces pasted keys, tokens and passwords with [redacted]. */
export const redactSecrets = (text: string): string => {
  if (text.length < 8) return text;
  let out = text;
  for (const { re } of SECRET_REGEXES) out = out.replace(re, REDACTED);
  out = out.replace(ASSIGNMENT, (_all, key: string, sep: string, value: string) =>
    value === REDACTED ? `${key}${sep}${value}` : `${key}${sep}${REDACTED}`,
  );
  out = out.replace(
    URL_PASSWORD,
    (_all, head: string, _pw: string, at: string) => `${head}${REDACTED}${at}`,
  );
  return out;
};

/**
 * Redacts every string in a value: plain objects, arrays and class instances (stream items
 * are Schema classes), keeping each object's prototype. Returns the same object when nothing
 * changed. Dates, binary data, maps and sets pass through.
 */
export const redactDeep = <A>(value: A, depth = 0): A => {
  if (typeof value === "string") return redactSecrets(value) as A;
  if (value === null || typeof value !== "object" || depth > 40) return value;
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const redacted = redactDeep(item, depth + 1);
      if (redacted !== item) changed = true;
      return redacted;
    });
    return (changed ? next : value) as A;
  }
  if (
    value instanceof Date ||
    value instanceof Map ||
    value instanceof Set ||
    ArrayBuffer.isView(value)
  )
    return value;
  const changes: Array<[string, unknown]> = [];
  for (const [key, item] of Object.entries(value)) {
    const redacted = redactDeep(item, depth + 1);
    if (redacted !== item) changes.push([key, redacted]);
  }
  if (changes.length === 0) return value;
  // A copy with every own property (symbol keys, hidden fields) and the same prototype;
  // only the redacted fields differ.
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const copy = Object.create(Object.getPrototypeOf(value) as object | null, descriptors) as Record<
    string,
    unknown
  >;
  for (const [key, redacted] of changes) {
    Object.defineProperty(copy, key, { ...descriptors[key], value: redacted });
  }
  return copy as A;
};

/** RPCs that return thread content; redacted for vetted freelancers. */
export const THREAD_CONTENT_METHODS: ReadonlySet<string> = new Set([
  "orchestration.getThreadProjection",
  "orchestration.getTurnItem",
  "orchestration.searchThread",
  "orchestration.searchThreads",
  "orchestration.getThreadFamily",
  "orchestration.getOlderSettledThreads",
]);

/** Claude Code permission rules that keep an agent off secret files (defence in depth). */
export const claudeDenyRules = (patterns: ReadonlyArray<string>): ReadonlyArray<string> =>
  patterns.flatMap((pattern) => {
    const glob = pattern.includes("/") ? `./${pattern.replace(/\/$/, "/**")}` : `**/${pattern}`;
    return [`Read(${glob})`, `Edit(${glob})`];
  });

/** The rules this feature adds to a member's Claude settings, merged without touching others. */
export const mergeClaudeDeny = (
  settings: Record<string, unknown>,
  rules: ReadonlyArray<string>,
  remove = false,
): Record<string, unknown> => {
  const permissions =
    settings.permissions !== null && typeof settings.permissions === "object"
      ? (settings.permissions as Record<string, unknown>)
      : {};
  const current = Array.isArray(permissions.deny)
    ? (permissions.deny as Array<unknown>).filter((r): r is string => typeof r === "string")
    : [];
  const deny = remove
    ? current.filter((rule) => !rules.includes(rule))
    : Array.from(new Set([...current, ...rules]));
  return { ...settings, permissions: { ...permissions, deny } };
};

// ── Agent instructions ────────────────────────────────────────────────────

export const NO_SECRETS_RULE =
  "You work for an external team member in a customer's project. Never open, print, copy, ask for or paste secrets: .env files, keys, certificates, tokens or passwords. If a task needs one, stop and ask the customer to set it themselves. Stay inside the brief below; anything else needs the customer's OK first.";

/** Lines for an external member's agent each turn: the no-secrets rule and the brief. */
export const externalTurnLines = (offer: Offer): ReadonlyArray<string> => {
  const brief = offer.brief;
  return [
    "External team rules:",
    `- ${NO_SECRETS_RULE}`,
    `- Brief: ${brief.title} (${roleLevelLabel(brief.role, brief.level)}, ${offer.quote.hours} hours included, ${hoursUsed(offer)} used).`,
    ...brief.milestones.map((m, i) => `- Milestone ${i + 1}: ${m.title} (${m.hours} h)`),
    ...(brief.paths.length > 0 ? [`- Work only in: ${brief.paths.join(", ")}`] : []),
    `- Do not touch: ${brief.avoid.join(", ")}`,
    ...brief.outOfScope.map((line) => `- Out of scope: ${line}`),
  ];
};

/**
 * Whether an external member may run a turn on a provider login. Their own logins are always
 * fine; anyone else's (the customer's shared one, the host's) only when the customer turned
 * on "let them use my login" for this offer and the experts grant path also allows it.
 */
export const externalInstanceAllowed = (input: {
  readonly ownInstance: boolean;
  readonly allowSharedLogin: boolean;
}) => input.ownInstance || input.allowSharedLogin;

// ── File views for external members ─────────────────────────────────────

/** RPCs whose results list project files, and where the paths sit in them. */
export const SECRET_FILTERED_METHODS: ReadonlySet<string> = new Set([
  "projects.listEntries",
  "projects.searchEntries",
  "projects.searchContents",
  "projects.listIgnoredFiles",
]);

/** RPCs that open or write one named file. */
export const SECRET_GUARDED_METHODS: ReadonlySet<string> = new Set([
  "projects.readFile",
  "projects.writeFile",
]);

/** Drops secret files from a file-listing result (same shape back). */
export const filterSecretEntries = (
  method: string,
  result: unknown,
  patterns: ReadonlyArray<string>,
): unknown => {
  if (result === null || typeof result !== "object") return result;
  const record = result as Record<string, unknown>;
  const keep = (item: unknown) =>
    !(
      item !== null &&
      typeof item === "object" &&
      typeof (item as { path?: unknown }).path === "string" &&
      isSecretPath((item as { path: string }).path, patterns)
    );
  const key =
    method === "projects.searchContents"
      ? "matches"
      : method === "projects.listIgnoredFiles"
        ? "files"
        : "entries";
  const list = record[key];
  if (!Array.isArray(list)) return result;
  const kept = list.filter(keep);
  return kept.length === list.length ? result : { ...record, [key]: kept };
};

/** The file a guarded RPC names, relative to the project when it can be. */
export const guardedFilePath = (
  payload: unknown,
): { readonly cwd: string; readonly path: string } | null => {
  if (payload === null || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const cwd = record.cwd;
  const path = record.relativePath ?? record.path;
  return typeof cwd === "string" && typeof path === "string" ? { cwd, path } : null;
};
