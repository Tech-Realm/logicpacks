/**
 * External team (Beta): the default talent directory.
 *
 * SEED DATA. Every profile here is a mock: names, skills, rates and vetting results are
 * placeholders, marked `sample: true` and shown with a "Sample" badge. Replace this list with
 * the real team's details (or edit profiles from /ops); the account email is the LogicPacks
 * login the person signs in with when they are assigned.
 */
import type { TalentLevel, TalentRole, VettingCheckId } from "./externalConfig.ts";

export type TalentAvailability = "available" | "busy" | "away";

export interface TalentProfile {
  readonly id: string;
  readonly name: string;
  readonly role: TalentRole;
  readonly level: TalentLevel;
  readonly headline: string;
  readonly skills: ReadonlyArray<string>;
  /** The AI tools they bring, on their own logins and subscriptions. */
  readonly tools: ReadonlyArray<string>;
  /** Region code from the region table, where they work from. */
  readonly region: string;
  readonly timezone: string;
  /** What we pay them per hour in USD, for staff only. */
  readonly rateUsd: number;
  readonly availability: TalentAvailability;
  readonly hoursFreePerWeek: number;
  readonly vetted: boolean;
  /** Vetting results with the date each was checked (YYYY-MM-DD). */
  readonly checks: Readonly<Record<VettingCheckId, string | null>>;
  /** An app path or https URL; null shows initials. */
  readonly avatar: string | null;
  /** The LogicPacks login used when they are assigned. Staff only. */
  readonly accountEmail: string;
  readonly sample: boolean;
  readonly active: boolean;
}

const CHECKED: TalentProfile["checks"] = {
  identity: "2026-09-02",
  skills: "2026-09-09",
  nda: "2026-09-10",
  keys: "2026-09-10",
};

const profile = (
  id: string,
  name: string,
  role: TalentRole,
  level: TalentLevel,
  headline: string,
  skills: ReadonlyArray<string>,
  region: string,
  timezone: string,
  rateUsd: number,
  availability: TalentAvailability,
  hoursFreePerWeek: number,
  tools: ReadonlyArray<string> = ["Claude Code"],
): TalentProfile => ({
  id,
  name,
  role,
  level,
  headline,
  skills,
  tools,
  region,
  timezone,
  rateUsd,
  availability,
  hoursFreePerWeek,
  vetted: true,
  checks: CHECKED,
  avatar: null,
  accountEmail: `${id}@talent.logicpacks.internal`,
  sample: true,
  active: true,
});

export const SEED_TALENT: ReadonlyArray<TalentProfile> = [
  // DevOps
  profile(
    "omar-k",
    "Omar K.",
    "devops",
    "senior",
    "CI, containers and cloud deploys.",
    ["CI", "Docker", "GitHub Actions", "AWS", "Nginx", "Terraform"],
    "PK",
    "Asia/Karachi",
    35,
    "available",
    30,
    ["Claude Code", "Cursor"],
  ),
  profile(
    "sofia-r",
    "Sofia R.",
    "devops",
    "mid",
    "Keeps builds green and hosts boring.",
    ["Kubernetes", "Helm", "Monitoring", "Linux", "Docker"],
    "EU",
    "Europe/Lisbon",
    55,
    "available",
    20,
    ["Codex", "Claude Code"],
  ),
  profile(
    "daniel-m",
    "Daniel M.",
    "devops",
    "senior",
    "Cloud cost and reliability.",
    ["AWS", "GCP", "Terraform", "Postgres", "Backups"],
    "US",
    "America/Chicago",
    95,
    "busy",
    6,
    ["Claude Code"],
  ),
  profile(
    "aisha-n",
    "Aisha N.",
    "devops",
    "junior",
    "Server setup, DNS and SSL.",
    ["DNS", "SSL", "Linux", "Nginx", "Cloudflare"],
    "UAE",
    "Asia/Dubai",
    30,
    "available",
    25,
    ["Cursor"],
  ),
  profile(
    "ravi-p",
    "Ravi P.",
    "devops",
    "mid",
    "Pipelines and release automation.",
    ["CI", "GitHub Actions", "Docker", "Vercel", "Fly.io"],
    "IN",
    "Asia/Kolkata",
    28,
    "away",
    0,
    ["Codex"],
  ),
  // Developers
  profile(
    "hamza-t",
    "Hamza T.",
    "developer",
    "senior",
    "Full-stack TypeScript, APIs to UI.",
    ["TypeScript", "React", "Node", "Postgres", "APIs"],
    "PK",
    "Asia/Karachi",
    40,
    "available",
    25,
    ["Claude Code", "Cursor"],
  ),
  profile(
    "emily-c",
    "Emily C.",
    "developer",
    "mid",
    "Front ends that are fast and accessible.",
    ["React", "Next.js", "Accessibility", "CSS", "Performance"],
    "UK",
    "Europe/London",
    60,
    "available",
    15,
    ["Cursor", "Claude Code"],
  ),
  profile(
    "lukas-b",
    "Lukas B.",
    "developer",
    "senior",
    "Backends, queues and data models.",
    ["Go", "Postgres", "Queues", "APIs", "Redis"],
    "EU",
    "Europe/Berlin",
    75,
    "busy",
    8,
    ["Codex", "Cursor"],
  ),
  profile(
    "priya-s",
    "Priya S.",
    "developer",
    "mid",
    "Python services and integrations.",
    ["Python", "FastAPI", "Django", "Stripe", "APIs"],
    "IN",
    "Asia/Kolkata",
    30,
    "available",
    30,
    ["Claude Code"],
  ),
  profile(
    "marcus-j",
    "Marcus J.",
    "developer",
    "junior",
    "Bug fixes and small features.",
    ["JavaScript", "React", "Testing", "Node"],
    "US",
    "America/New_York",
    45,
    "available",
    20,
    ["Cursor"],
  ),
  profile(
    "yusuf-a",
    "Yusuf A.",
    "developer",
    "mid",
    "Mobile and cross-platform apps.",
    ["React Native", "Expo", "Swift", "Kotlin"],
    "UAE",
    "Asia/Dubai",
    50,
    "away",
    0,
    ["Claude Code", "Codex"],
  ),
  // Designers
  profile(
    "sara-h",
    "Sara H.",
    "designer",
    "senior",
    "Product design from flows to UI kits.",
    ["Figma", "UX", "Design systems", "Prototyping"],
    "PK",
    "Asia/Karachi",
    32,
    "available",
    20,
    ["Claude Code", "Figma AI"],
  ),
  profile(
    "chloe-d",
    "Chloe D.",
    "designer",
    "mid",
    "Landing pages and brand touches.",
    ["Figma", "Landing pages", "Branding", "Illustration"],
    "EU",
    "Europe/Paris",
    50,
    "available",
    15,
    ["Cursor", "Figma AI"],
  ),
  profile(
    "noah-w",
    "Noah W.",
    "designer",
    "mid",
    "UI polish and handoff to developers.",
    ["Figma", "UI", "Tailwind", "Handoff"],
    "US",
    "America/Los_Angeles",
    65,
    "busy",
    5,
    ["Claude Code"],
  ),
  profile(
    "meera-v",
    "Meera V.",
    "designer",
    "junior",
    "Icons, banners and social assets.",
    ["Illustration", "Icons", "Figma", "Canva"],
    "IN",
    "Asia/Kolkata",
    22,
    "available",
    30,
    ["Figma AI"],
  ),
  profile(
    "tom-g",
    "Tom G.",
    "designer",
    "senior",
    "UX research and information design.",
    ["UX", "Research", "Wireframes", "Figma"],
    "UK",
    "Europe/London",
    80,
    "available",
    10,
    ["Claude Code", "Figma AI"],
  ),
];
