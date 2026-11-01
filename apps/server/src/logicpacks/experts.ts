/**
 * Request assistance (beta): the curated expert catalog, a request's lifecycle and the
 * subscription grants an owner gives an expert. Plain data and rules, no Effect and no
 * storage, so every rule is unit-tested directly. `ExpertsService.ts` stores them.
 */

export type ExpertAvailability = "available" | "busy" | "away";

export interface Expert {
  readonly id: string;
  readonly name: string;
  /** The headline skill: "Blender", "DaVinci Resolve", "Web", "Backend". */
  readonly specialty: string;
  readonly skills: ReadonlyArray<string>;
  readonly bio: string;
  /** 0 to 5, one decimal. */
  readonly rating: number;
  readonly reviews: number;
  readonly availability: ExpertAvailability;
  /** An image URL or an app path ("/experts/ingrid-solberg.webp"). Illustrative portraits only. */
  readonly avatar: string;
  /** The LogicPacks account the expert signs in with. Never shown to requesters. */
  readonly accountEmail: string;
  /** A sample profile shipped with the seed, not a real person. */
  readonly sample: boolean;
  readonly active: boolean;
}

/** What a requester sees: no account email. */
export type PublicExpert = Omit<Expert, "accountEmail" | "active">;

export const publicExpert = ({
  accountEmail: _email,
  active: _active,
  ...rest
}: Expert): PublicExpert => rest;

/**
 * The seed: sample profiles with illustrative, generated portraits. They are marked
 * `sample: true` so the operator can tell them from real experts they add.
 */
export const SEED_EXPERTS: ReadonlyArray<Expert> = [
  {
    id: "ingrid-solberg",
    name: "Ingrid Solberg",
    specialty: "Blender",
    skills: ["Modelling", "Lighting", "Geometry nodes"],
    bio: "Sets up scenes, lights and materials, and cleans up topology before a render.",
    rating: 4.9,
    reviews: 128,
    availability: "available",
    avatar: "/experts/ingrid-solberg.webp",
    accountEmail: "ingrid-solberg@experts.logicpacks.internal",
    sample: true,
    active: true,
  },
  {
    id: "tomas-reyes",
    name: "Tomás Reyes",
    specialty: "DaVinci Resolve",
    skills: ["Colour grading", "Timeline cleanup", "Fusion titles"],
    bio: "Grades, conforms and tidies timelines so the edit is ready to deliver.",
    rating: 4.8,
    reviews: 94,
    availability: "available",
    avatar: "/experts/tomas-reyes.webp",
    accountEmail: "tomas-reyes@experts.logicpacks.internal",
    sample: true,
    active: true,
  },
  {
    id: "anika-rao",
    name: "Anika Rao",
    specialty: "Web",
    skills: ["React", "Accessibility", "Performance"],
    bio: "Builds and fixes front ends, from layout bugs to slow pages.",
    rating: 4.9,
    reviews: 211,
    availability: "busy",
    avatar: "/experts/anika-rao.webp",
    accountEmail: "anika-rao@experts.logicpacks.internal",
    sample: true,
    active: true,
  },
  {
    id: "jonas-weber",
    name: "Jonas Weber",
    specialty: "Backend",
    skills: ["Postgres", "APIs", "Queues"],
    bio: "Designs schemas and APIs, and finds the slow query before it finds you.",
    rating: 4.7,
    reviews: 76,
    availability: "available",
    avatar: "/experts/jonas-weber.webp",
    accountEmail: "jonas-weber@experts.logicpacks.internal",
    sample: true,
    active: true,
  },
  {
    id: "lea-moreau",
    name: "Léa Moreau",
    specialty: "Motion",
    skills: ["After Effects", "Lottie", "Typography"],
    bio: "Animates titles and product shots, and hands over files your team can edit.",
    rating: 4.8,
    reviews: 63,
    availability: "away",
    avatar: "/experts/lea-moreau.webp",
    accountEmail: "lea-moreau@experts.logicpacks.internal",
    sample: true,
    active: true,
  },
  {
    id: "kofi-mensah",
    name: "Kofi Mensah",
    specialty: "DevOps",
    skills: ["CI", "Docker", "Cloud hosts"],
    bio: "Sets up builds, deploys and the cloud host so the team ships without waiting.",
    rating: 4.6,
    reviews: 58,
    availability: "available",
    avatar: "/experts/kofi-mensah.webp",
    accountEmail: "kofi-mensah@experts.logicpacks.internal",
    sample: true,
    active: true,
  },
  {
    id: "yuna-park",
    name: "Yuna Park",
    specialty: "AI/ML",
    skills: ["Evals", "RAG", "Fine-tuning"],
    bio: "Builds evals and retrieval for your agents, and tells you when a pack beats training.",
    rating: 4.9,
    reviews: 87,
    availability: "available",
    avatar: "/experts/yuna-park.webp",
    accountEmail: "yuna-park@experts.logicpacks.internal",
    sample: true,
    active: true,
  },
  {
    id: "karim-haddad",
    name: "Karim Haddad",
    specialty: "QA",
    skills: ["Playwright", "Test plans", "Release checks"],
    bio: "Writes the tests that catch it first, and checks every release before it ships.",
    rating: 4.7,
    reviews: 102,
    availability: "busy",
    avatar: "/experts/karim-haddad.webp",
    accountEmail: "karim-haddad@experts.logicpacks.internal",
    sample: true,
    active: true,
  },
];

/** Bumped when the seed changes in a way existing catalogs should pick up. */
export const SEED_VERSION = "2";

/** The first seed: six profiles with drawn SVG portraits. */
const FIRST_SEED_IDS = new Set([
  "ingrid-solberg",
  "tomas-reyes",
  "anika-rao",
  "jonas-weber",
  "lea-moreau",
  "kofi-mensah",
]);

/**
 * What to write for a catalog seeded at `fromVersion` ("0" = never seeded). A fresh
 * catalog gets the whole seed. One seeded at "1" gets the profiles added since, and its
 * sample profiles that still show their drawn portrait get the photo one. Deleted
 * first-seed profiles stay deleted, and edited portraits are left alone.
 */
export const planSeed = (
  stored: ReadonlyArray<Expert>,
  fromVersion: string,
): ReadonlyArray<Expert> => {
  const byId = new Map(stored.map((expert) => [expert.id, expert]));
  const out: Expert[] = [];
  for (const seed of SEED_EXPERTS) {
    const current = byId.get(seed.id);
    if (!current) {
      if (fromVersion === "0" || !FIRST_SEED_IDS.has(seed.id)) out.push(seed);
      continue;
    }
    if (current.sample && current.avatar === `/experts/${seed.id}.svg`) {
      out.push({ ...current, avatar: seed.avatar });
    }
  }
  return out;
};

const EXPERT_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Checks an expert the operator adds or edits. Returns the cleaned expert or why not. */
export const validateExpert = (
  input: Partial<Expert> & { readonly id?: string },
):
  | { readonly ok: true; readonly expert: Expert }
  | { readonly ok: false; readonly message: string } => {
  const id = (input.id ?? "").trim();
  if (!EXPERT_ID.test(id)) return { ok: false, message: "Use a lower-case id with dashes." };
  const name = (input.name ?? "").trim();
  if (name.length === 0 || name.length > 80)
    return { ok: false, message: "Give the expert a name." };
  const specialty = (input.specialty ?? "").trim();
  if (specialty.length === 0 || specialty.length > 40) {
    return { ok: false, message: "Give a specialty, like Blender or Backend." };
  }
  const email = (input.accountEmail ?? "").trim().toLowerCase();
  if (!EMAIL.test(email)) return { ok: false, message: "Give the email the expert signs in with." };
  const rating = Number(input.rating ?? 0);
  if (!Number.isFinite(rating) || rating < 0 || rating > 5) {
    return { ok: false, message: "Rating is from 0 to 5." };
  }
  const avatar = (input.avatar ?? "").trim();
  if (avatar.length > 0 && !/^(https:\/\/|\/)[^\s"'<>]*$/.test(avatar)) {
    return { ok: false, message: "The portrait is an https URL or an app path." };
  }
  const availability = input.availability ?? "available";
  if (!["available", "busy", "away"].includes(availability)) {
    return { ok: false, message: "Availability is available, busy or away." };
  }
  return {
    ok: true,
    expert: {
      id,
      name,
      specialty,
      skills: (input.skills ?? [])
        .map((skill) => skill.trim())
        .filter((skill) => skill.length > 0)
        .slice(0, 8),
      bio: (input.bio ?? "").trim().slice(0, 400),
      rating: Math.round(rating * 10) / 10,
      reviews: Math.max(0, Math.floor(Number(input.reviews ?? 0)) || 0),
      availability,
      avatar: avatar.length > 0 ? avatar : `/experts/${id}.svg`,
      accountEmail: email,
      sample: input.sample ?? false,
      active: input.active ?? true,
    },
  };
};

/** The catalog a requester browses: active experts, available first, best rated first. */
export const browseCatalog = (
  experts: ReadonlyArray<Expert>,
  filter?: { readonly specialty?: string | undefined },
): ReadonlyArray<PublicExpert> => {
  const order: Record<ExpertAvailability, number> = { available: 0, busy: 1, away: 2 };
  return experts
    .filter((expert) => expert.active)
    .filter(
      (expert) =>
        !filter?.specialty || expert.specialty.toLowerCase() === filter.specialty.toLowerCase(),
    )
    .toSorted(
      (a, b) =>
        order[a.availability] - order[b.availability] ||
        b.rating - a.rating ||
        a.name.localeCompare(b.name),
    )
    .map(publicExpert);
};

// ── Requests ───────────────────────────────────────────────────────────────

export type RequestStatus = "requested" | "accepted" | "working" | "done" | "declined" | "ended";

export const OPEN_STATUSES: ReadonlySet<RequestStatus> = new Set([
  "requested",
  "accepted",
  "working",
]);

export interface AssistanceRequest {
  readonly id: string;
  readonly projectId: string;
  readonly projectTitle: string;
  /** Null when the host operator asked. */
  readonly requesterUserId: string | null;
  readonly requesterName: string;
  readonly expertId: string;
  /** Set when the expert accepts: their LogicPacks account. */
  readonly expertUserId: string | null;
  readonly brief: string;
  /** The requester's thread the brief came from; replies and delegations go from here. */
  readonly fromThreadId: string | null;
  /** The expert's own thread in the project, made when they accept. */
  readonly expertThreadId: string | null;
  /** Accepting added the expert to the project; ending removes only such a membership. */
  readonly addedMember?: boolean;
  readonly status: RequestStatus;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly history: ReadonlyArray<{
    readonly status: RequestStatus;
    readonly atMs: number;
    readonly by: string;
  }>;
}

export type RequestAction =
  | {
      readonly kind: "accept";
      readonly expertUserId: string;
      readonly expertThreadId: string | null;
    }
  | { readonly kind: "decline" }
  | { readonly kind: "working" }
  | { readonly kind: "done" }
  | { readonly kind: "end" };

export type ActorRole = "requester" | "expert";

/** Who may take each step: the expert answers and works, the requester ends it. */
const RULES: Record<
  RequestAction["kind"],
  {
    readonly from: ReadonlyArray<RequestStatus>;
    readonly to: RequestStatus;
    readonly by: ReadonlyArray<ActorRole>;
  }
> = {
  accept: { from: ["requested"], to: "accepted", by: ["expert"] },
  decline: { from: ["requested"], to: "declined", by: ["expert"] },
  working: { from: ["accepted", "working"], to: "working", by: ["expert", "requester"] },
  done: { from: ["accepted", "working"], to: "done", by: ["expert", "requester"] },
  end: { from: ["requested", "accepted", "working", "done"], to: "ended", by: ["requester"] },
};

export const transitionRequest = (
  request: AssistanceRequest,
  action: RequestAction,
  actor: { readonly role: ActorRole; readonly name: string },
  nowMs: number,
):
  | { readonly ok: true; readonly request: AssistanceRequest }
  | { readonly ok: false; readonly message: string } => {
  const rule = RULES[action.kind];
  if (!rule.by.includes(actor.role)) {
    return {
      ok: false,
      message:
        actor.role === "requester"
          ? "Only the expert can do that."
          : "Only the person who asked can do that.",
    };
  }
  if (!rule.from.includes(request.status)) {
    return { ok: false, message: `This request is ${request.status}.` };
  }
  const next: AssistanceRequest = {
    ...request,
    ...(action.kind === "accept"
      ? { expertUserId: action.expertUserId, expertThreadId: action.expertThreadId }
      : {}),
    status: rule.to,
    updatedAtMs: nowMs,
    history:
      request.status === rule.to
        ? request.history
        : [...request.history, { status: rule.to, atMs: nowMs, by: actor.name }],
  };
  return { ok: true, request: next };
};

/** A brief from the thread's ledger entry, for the request form to start from. */
export const briefFromThread = (input: {
  readonly threadTitle: string | null;
  readonly goal: string | null;
  readonly files: ReadonlyArray<string>;
  readonly decisions: ReadonlyArray<string>;
}): string => {
  const lines = [
    input.goal
      ? `Goal: ${input.goal}`
      : input.threadTitle
        ? `Working on: ${input.threadTitle}`
        : null,
    input.files.length > 0 ? `Files: ${input.files.slice(0, 5).join(", ")}` : null,
    input.decisions.length > 0 ? `Decided so far: ${input.decisions.slice(-3).join("; ")}` : null,
    "What I need help with: ",
  ];
  return lines.filter((line): line is string => line !== null).join("\n");
};

// ── Subscription grants ────────────────────────────────────────────────────

/**
 * An owner lets a member run turns on their provider logins, for one project, until
 * revoked. Grants are scoped: one project, named instances, one grantee.
 */
export interface ProviderGrant {
  readonly id: string;
  readonly projectId: string;
  /** Null for the host operator's logins. */
  readonly ownerUserId: string | null;
  readonly ownerName: string;
  readonly granteeUserId: string;
  readonly instanceIds: ReadonlyArray<string>;
  /** The assistance request that asked for it, if any. */
  readonly requestId: string | null;
  readonly createdAtMs: number;
  readonly revokedAtMs: number | null;
}

export const isActiveGrant = (grant: ProviderGrant) => grant.revokedAtMs === null;

/** Whether `granteeUserId` may run a turn on `instanceId` in `projectId`. */
export const grantAllows = (
  grants: Iterable<ProviderGrant>,
  input: {
    readonly granteeUserId: string;
    readonly instanceId: string;
    readonly projectId: string | null;
  },
): boolean => {
  if (input.projectId === null) return false;
  for (const grant of grants) {
    if (
      isActiveGrant(grant) &&
      grant.granteeUserId === input.granteeUserId &&
      grant.projectId === input.projectId &&
      grant.instanceIds.includes(input.instanceId)
    ) {
      return true;
    }
  }
  return false;
};

/** Every instance some active grant lets this member use, for the model picker. */
export const grantedInstanceIds = (
  grants: Iterable<ProviderGrant>,
  granteeUserId: string,
): ReadonlySet<string> => {
  const ids = new Set<string>();
  for (const grant of grants) {
    if (isActiveGrant(grant) && grant.granteeUserId === granteeUserId) {
      for (const id of grant.instanceIds) ids.add(id);
    }
  }
  return ids;
};

/** Revokes every active grant matching `match`; returns the revoked ones. */
export const revokeGrants = (
  grants: ReadonlyArray<ProviderGrant>,
  match: (grant: ProviderGrant) => boolean,
  nowMs: number,
): ReadonlyArray<ProviderGrant> =>
  grants
    .filter((grant) => isActiveGrant(grant) && match(grant))
    .map((grant) => ({
      ...grant,
      revokedAtMs: nowMs,
    }));
