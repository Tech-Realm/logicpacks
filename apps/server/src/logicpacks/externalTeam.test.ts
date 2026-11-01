import { describe, expect, it } from "@effect/vitest";

import { regionByCode, quote } from "./externalPricing.ts";
import { SEED_TALENT } from "./externalTalentSeed.ts";
import {
  acceptOffer,
  activateOffer,
  applyToJob,
  assignOffer,
  claudeDenyRules,
  endOffer,
  estimateHours,
  externalInstanceAllowed,
  externalTurnLines,
  filterSecretEntries,
  guardedFilePath,
  guessLevel,
  guessRole,
  hoursUsed,
  isOpenJob,
  isSecretPath,
  jobView,
  joinedLine,
  logHours,
  makeOffer,
  matchTalent,
  mergeClaudeDeny,
  normalizeBrief,
  parseModelJson,
  publicTalent,
  publishOffer,
  redactDeep,
  redactSecrets,
  relativeToRoot,
  searchJobs,
  searchTalent,
  secretPatterns,
  settleApplications,
  templateBrief,
  withExpiry,
  type Assignment,
  type Offer,
} from "./externalTeam.ts";

const US = regionByCode("US")!;
const NEED =
  "Set up GitHub Actions deploy to our VPS with nginx and SSL for apps/api, it keeps failing";

const offer = (patch: Partial<Offer> = {}): Offer => {
  const brief = templateBrief({ need: NEED });
  return {
    ...makeOffer({
      id: "off-1",
      projectId: "proj-1",
      projectTitle: "Acme Storefront",
      threadId: "thread-1",
      customerUserId: "cust-1",
      customerName: "Dana",
      brief,
      quote: quote(US, brief.role, brief.level, 10),
      regionSource: "cf-ipcountry US",
      nowMs: 1_000,
    }),
    ...patch,
  };
};

const assignment = (patch: Partial<Assignment> = {}): Assignment => ({
  talentId: "omar-k",
  talentName: "Omar K.",
  role: "devops",
  email: "omar-k@talent.logicpacks.internal",
  userId: null,
  inviteId: "inv-1",
  invitePath: "/lp/join/abc",
  addedMember: false,
  goalId: null,
  assignedBy: "staff@example.com",
  assignedAtMs: 2_000,
  joinedAtMs: null,
  ...patch,
});

describe("brief drafting (template fallback)", () => {
  it("guesses role, level and hours from the need", () => {
    expect(guessRole(NEED)).toBe("devops");
    expect(guessRole("Redesign our logo and landing page look in Figma")).toBe("designer");
    expect(guessRole("Fix the login bug in the React app")).toBe("developer");
    expect(guessLevel("a quick small typo fix")).toBe("junior");
    expect(guessLevel("security audit and migration")).toBe("senior");
    const small = estimateHours("quick typo fix", "developer", "junior");
    const big = estimateHours(
      "rebuild the whole backend from scratch with a migration",
      "developer",
      "senior",
    );
    expect(small).toBeLessThan(big);
  });

  it("drafts a complete brief whose milestone hours add up", () => {
    const brief = templateBrief({ need: NEED });
    expect(brief.draftedBy).toBe("template");
    expect(brief.role).toBe("devops");
    expect(brief.deliverables.length).toBeGreaterThan(0);
    expect(brief.outOfScope.length).toBeGreaterThan(0);
    expect(brief.milestones.length).toBeGreaterThan(0);
    expect(brief.milestones.reduce((sum, m) => sum + m.hours, 0)).toBe(brief.hours);
    expect(brief.paths).toContain("apps/api");
    expect(brief.avoid).toContain(".env");
  });

  it("takes a model's JSON but keeps the template where it is missing or invalid", () => {
    const base = templateBrief({ need: NEED });
    const parsed = parseModelJson(
      'Sure!\n```json\n{"title":"CI deploy","role":"wizard","hours":6,"deliverables":["Working pipeline"]}\n```',
    );
    const brief = normalizeBrief(parsed, base);
    expect(brief.title).toBe("CI deploy");
    expect(brief.role).toBe(base.role);
    expect(brief.deliverables).toEqual(["Working pipeline"]);
    expect(brief.milestones.reduce((sum, m) => sum + m.hours, 0)).toBe(brief.hours);
    expect(normalizeBrief(parseModelJson("not json"), base)).toEqual(base);
  });
});

describe("offers and the hours ledger", () => {
  it("expires, accepts, assigns, activates and completes", () => {
    const fresh = offer();
    expect(fresh.status).toBe("offered");
    expect(withExpiry(fresh, fresh.expiresAtMs + 1).status).toBe("expired");
    expect(() => acceptOffer(fresh, "Dana", fresh.expiresAtMs + 1)).toThrow(/expired/);
    expect(() => assignOffer(fresh, assignment(), 2_000)).toThrow(/not accepted/);
    const accepted = acceptOffer(fresh, "Dana", 1_500);
    const assigned = assignOffer(accepted, assignment(), 2_000);
    const active = activateOffer(assigned, { userId: "user-omar", goalId: "goal-1" }, 3_000);
    expect(active.status).toBe("active");
    expect(active.assignment).toMatchObject({
      userId: "user-omar",
      goalId: "goal-1",
      joinedAtMs: 3_000,
    });
    expect(active.history.map((h) => h.status)).toEqual([
      "offered",
      "accepted",
      "assigned",
      "active",
    ]);
    expect(endOffer(active, "completed", "Dana", 4_000).status).toBe("completed");
    expect(() => endOffer(accepted, "completed", "Dana", 4_000)).toThrow(/cancel/);
    expect(endOffer(accepted, "cancelled", "Dana", 4_000).status).toBe("cancelled");
  });

  it("counts hours used and refuses overage", () => {
    const active = activateOffer(
      assignOffer(acceptOffer(offer(), "Dana", 1_500), assignment(), 2_000),
      { userId: "user-omar", goalId: null },
      3_000,
    );
    const six = logHours(active, {
      id: "h1",
      hours: 6,
      note: "pipeline",
      by: "Omar K.",
      atMs: 4_000,
    });
    expect(hoursUsed(six)).toBe(6);
    expect(joinedLine(six)).toContain("6 of 10 hours used");
    expect(joinedLine(six)).toContain("Omar K. (vetted devops freelancer)");
    expect(() =>
      logHours(six, { id: "h2", hours: 5, note: "", by: "Omar K.", atMs: 5_000 }),
    ).toThrow(/new offer/);
    expect(() => logHours(offer(), { id: "h3", hours: 1, note: "", by: "x", atMs: 1 })).toThrow(
      /open/,
    );
  });
});

describe("jobs board", () => {
  const accepted = () => acceptOffer(offer(), "Dana", 1_500);

  it("publishes an accepted offer and takes applications", () => {
    expect(() => publishOffer(offer(), "staff", 2_000)).toThrow(/accepted/);
    const job = publishOffer(accepted(), "staff", 2_000);
    expect(isOpenJob(job)).toBe(true);
    const app = {
      id: "a1",
      userId: "u-free",
      name: "Free",
      email: "f@x.dev",
      note: "I have done this",
      hours: 8,
      status: "applied" as const,
      atMs: 3_000,
    };
    const applied = applyToJob(job, app);
    expect(() => applyToJob(applied, { ...app, id: "a2" })).toThrow(/already/);
    expect(() => applyToJob(job, { ...app, id: "a3", userId: "u2", note: "hi" })).toThrow(
      /few words/,
    );
    const settled = settleApplications(
      applyToJob(applied, { ...app, id: "a4", userId: "u3" }),
      "a1",
    );
    expect(settled.applications.map((a) => a.status)).toEqual(["accepted", "declined"]);
    expect(isOpenJob(settled)).toBe(false);
  });

  it("redacts customer, project, folders, links and secrets before acceptance", () => {
    const base = accepted();
    const job = publishOffer(
      {
        ...base,
        brief: {
          ...base.brief,
          title: "Acme Storefront deploy",
          scope:
            "Dana wants apps/api deployed from https://github.com/acme/store.git with key sk-ant-abcdefghijklmnopqrstuvwxyz",
        },
      },
      "staff",
      2_000,
    );
    const view = jobView(job);
    const text = JSON.stringify(view);
    expect(text).not.toContain("Acme Storefront");
    expect(text).not.toContain("Dana");
    expect(text).not.toContain("apps/api");
    expect(text).not.toContain("github.com");
    expect(text).not.toContain("sk-ant-");
    expect(view).not.toHaveProperty("projectId");
    expect(searchJobs([job, base], { role: "devops", skills: "nginx" }).map((o) => o.id)).toEqual([
      "off-1",
    ]);
    expect(searchJobs([job], { role: "designer" })).toEqual([]);
  });
});

describe("talent directory", () => {
  it("seeds 12 to 20 sample profiles with tools and vetting checks", () => {
    expect(SEED_TALENT.length).toBeGreaterThanOrEqual(12);
    expect(SEED_TALENT.length).toBeLessThanOrEqual(20);
    for (const talent of SEED_TALENT) {
      expect(talent.sample).toBe(true);
      expect(talent.tools.length).toBeGreaterThan(0);
      expect(Object.keys(talent.checks).toSorted()).toEqual(["identity", "keys", "nda", "skills"]);
    }
    const shown = publicTalent(SEED_TALENT[0]!);
    expect(shown).not.toHaveProperty("accountEmail");
    expect(shown).not.toHaveProperty("rateUsd");
  });

  it("suggests a matching devops person first and searches the directory", () => {
    const brief = templateBrief({ need: NEED });
    const matches = matchTalent(SEED_TALENT, brief);
    expect(matches[0]!.talent.role).toBe("devops");
    expect(matches[0]!.reasons).toContain("DevOps");
    expect(
      searchTalent(SEED_TALENT, { role: "designer" }).every((t) => t.role === "designer"),
    ).toBe(true);
    expect(searchTalent(SEED_TALENT, { q: "omar" }).map((t) => t.id)).toContain("omar-k");
  });
});

describe("secrets", () => {
  it("knows secret files and keeps templates visible", () => {
    const patterns = secretPatterns("config/prod.yml, *.sqlite");
    for (const path of [
      ".env",
      "apps/api/.env.local",
      "certs/server.pem",
      "deploy/id_rsa",
      "secrets/a/b.txt",
      "app/secrets/x",
      "data.sqlite",
    ]) {
      expect(isSecretPath(path, patterns), path).toBe(true);
    }
    for (const path of [".env.example", "src/env.ts", "README.md", "apps/api/src/keys.ts"]) {
      expect(isSecretPath(path, patterns), path).toBe(false);
    }
    expect(relativeToRoot("/srv/p", "/srv/p/.env")).toBe(".env");
    expect(relativeToRoot("/srv/p", "/etc/passwd")).toBeNull();
    expect(guardedFilePath({ cwd: "/srv/p", relativePath: ".env" })).toEqual({
      cwd: "/srv/p",
      path: ".env",
    });
  });

  it("filters secret files out of file listings", () => {
    const patterns = secretPatterns();
    const listed = {
      entries: [
        { path: ".env", kind: "file" },
        { path: "src/a.ts", kind: "file" },
      ],
      truncated: false,
    };
    expect(filterSecretEntries("projects.listEntries", listed, patterns)).toEqual({
      entries: [{ path: "src/a.ts", kind: "file" }],
      truncated: false,
    });
    const matches = { matches: [{ path: ".env.production", lineNumber: 1 }], truncated: false };
    expect(filterSecretEntries("projects.searchContents", matches, patterns)).toEqual({
      matches: [],
      truncated: false,
    });
    const clean = { entries: [{ path: "a.ts", kind: "file" }], truncated: false };
    expect(filterSecretEntries("projects.listEntries", clean, patterns)).toBe(clean);
  });

  it("redacts pasted secrets and leaves normal text alone", () => {
    expect(redactSecrets("my key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz")).toBe(
      "my key is [redacted]",
    );
    expect(redactSecrets("DATABASE_PASSWORD=hunter2hunter2")).toBe("DATABASE_PASSWORD=[redacted]");
    expect(redactSecrets("postgres://app:s3cretpw@db:5432/app")).toBe(
      "postgres://app:[redacted]@db:5432/app",
    );
    expect(redactSecrets("AKIAABCDEFGHIJKLMNOP")).toBe("[redacted]");
    expect(redactSecrets("Please deploy the api to the server today")).toBe(
      "Please deploy the api to the server today",
    );
    const item = {
      kind: "event",
      event: { text: "token: ghp_abcdefghijklmnopqrstuvwxyz0123456789", n: 1 },
    };
    expect(redactDeep(item).event.text).toBe("token: [redacted]");
    class Item {
      readonly text: string;
      constructor(text: string) {
        this.text = text;
      }
      get loud() {
        return this.text.toUpperCase();
      }
    }
    const instance = redactDeep({
      items: [new Item("key sk-ant-api03-abcdefghijklmnopqrstuvwxyz")],
    });
    expect(instance.items[0]).toBeInstanceOf(Item);
    expect(instance.items[0]!.text).toBe("key [redacted]");
    const plain = { a: "hello there", b: [1, "x"] };
    expect(redactDeep(plain)).toBe(plain);
  });

  it("adds and removes only its own Claude deny rules", () => {
    const rules = claudeDenyRules([".env", "secrets/**"]);
    expect(rules).toContain("Read(**/.env)");
    expect(rules).toContain("Read(./secrets/**)");
    const merged = mergeClaudeDeny({ model: "x", permissions: { deny: ["Bash(rm:*)"] } }, rules);
    expect((merged.permissions as { deny: Array<string> }).deny).toEqual(["Bash(rm:*)", ...rules]);
    const removed = mergeClaudeDeny(merged, rules, true);
    expect(removed).toEqual({ model: "x", permissions: { deny: ["Bash(rm:*)"] } });
  });
});

describe("guardrails for the freelancer's agent", () => {
  it("adds the no-secrets rule, brief and milestones to every turn", () => {
    const lines = externalTurnLines(offer()).join("\n");
    expect(lines).toContain("Never open, print, copy, ask for or paste secrets");
    expect(lines).toContain("Milestone 1:");
    expect(lines).toContain("Do not touch:");
  });

  it("uses their own AI login unless the customer allows theirs", () => {
    expect(externalInstanceAllowed({ ownInstance: true, allowSharedLogin: false })).toBe(true);
    expect(externalInstanceAllowed({ ownInstance: false, allowSharedLogin: false })).toBe(false);
    expect(externalInstanceAllowed({ ownInstance: false, allowSharedLogin: true })).toBe(true);
  });
});
