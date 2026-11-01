import { callHost, OfflineError, RejectedError } from "./client.ts";
import { NOT_CONNECTED } from "./localHost.ts";
import type { HelperConfig } from "./store.ts";

/**
 * The freelancer jobs board (invite-only beta) and the vetted talent directory, for `lp jobs`,
 * `lp talent` and the jobs_* MCP tools. Briefs come back redacted: no customer, project, repo
 * or folder names until the freelancer is accepted.
 */

export interface JobView {
  readonly id: string;
  readonly title: string;
  readonly role: string;
  readonly level: string;
  readonly hours: number;
  readonly scope: string;
  readonly deliverables: ReadonlyArray<string>;
  readonly outOfScope: ReadonlyArray<string>;
  readonly milestones: ReadonlyArray<{ readonly title: string; readonly hours: number }>;
  readonly applicants: number;
  readonly myApplication: { readonly id: string; readonly status: string } | null;
  readonly status?: string;
  readonly projectId?: string | null;
  readonly projectTitle?: string | null;
  readonly hoursUsed?: number | null;
}

interface TalentView {
  readonly id: string;
  readonly name: string;
  readonly role: string;
  readonly level: string;
  readonly headline: string;
  readonly skills: ReadonlyArray<string>;
  readonly tools: ReadonlyArray<string>;
  readonly availability: string;
  readonly sample: boolean;
  readonly reasons?: ReadonlyArray<string>;
}

const query = (params: Record<string, string | null | undefined>) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value) search.set(key, value);
  const text = search.toString();
  return text.length === 0 ? "" : `?${text}`;
};

const jobLine = (job: JobView) =>
  `${job.id}  ${job.title}  (${job.level} ${job.role}, ${job.hours} h, ${job.applicants} applicant${job.applicants === 1 ? "" : "s"})${
    job.myApplication ? `  [you applied: ${job.myApplication.status}]` : ""
  }`;

export const formatJob = (job: JobView) =>
  [
    `${job.title}`,
    `id: ${job.id}`,
    `${job.level} ${job.role}, ${job.hours} hours included`,
    "",
    job.scope,
    "",
    "Deliverables:",
    ...job.deliverables.map((line) => `- ${line}`),
    "Milestones:",
    ...job.milestones.map((m, i) => `${i + 1}. ${m.title} (${m.hours} h)`),
    "Out of scope:",
    ...job.outOfScope.map((line) => `- ${line}`),
    "",
    job.myApplication
      ? `You applied (${job.myApplication.status}).`
      : `Apply: lp jobs apply ${job.id} --note "how you would do it" [--hours N]`,
    "Customer and project names stay hidden until you are accepted. Never ask for or copy secrets.",
  ].join("\n");

export const jobsSearch = async (
  config: HelperConfig,
  filter: { role?: string | null; skills?: string | null },
) => {
  const result = await callHost<{ jobs: ReadonlyArray<JobView> }>(
    config,
    `/api/lp/jobs${query({ role: filter.role, skills: filter.skills })}`,
  );
  return result.jobs.length === 0 ? "No open jobs match." : result.jobs.map(jobLine).join("\n");
};

export const jobsShow = async (config: HelperConfig, id: string) => {
  const result = await callHost<{ job: JobView }>(config, `/api/lp/jobs/show${query({ id })}`);
  return formatJob(result.job);
};

export const jobsApply = async (
  config: HelperConfig,
  input: { id: string; note: string; hours?: number | null },
) => {
  const result = await callHost<{ job: JobView }>(config, "/api/lp/jobs/apply", {
    body: { jobId: input.id, note: input.note, hours: input.hours ?? null },
  });
  return `Applied to ${result.job.title} (${result.job.id}). LogicPacks staff or the customer will review it; lp jobs mine shows the status.`;
};

export const jobsMine = async (config: HelperConfig) => {
  const result = await callHost<{ jobs: ReadonlyArray<JobView> }>(config, "/api/lp/jobs/mine");
  if (result.jobs.length === 0) return "You have not applied to any jobs yet.";
  return result.jobs
    .map((job) =>
      job.projectTitle
        ? `${job.id}  ${job.title}  accepted: you are in ${job.projectTitle} (${job.hoursUsed ?? 0} of ${job.hours} h used)`
        : `${job.id}  ${job.title}  ${job.myApplication?.status ?? "applied"}`,
    )
    .join("\n");
};

const talentLine = (talent: TalentView) =>
  `${talent.name}  vetted ${talent.level} ${talent.role}, ${talent.availability}. ${talent.headline}. Skills: ${talent.skills.join(", ")}. Brings own AI: ${talent.tools.join(", ")}.${
    talent.reasons && talent.reasons.length > 0 ? ` Why: ${talent.reasons.join(", ")}.` : ""
  }${talent.sample ? " (sample profile)" : ""}`;

/** Customer side: search vetted freelancers, or match them to a need. */
export const talentSearch = async (
  config: HelperConfig,
  input: { q?: string | null; role?: string | null; need?: string | null },
) => {
  const result = await callHost<{ talent: ReadonlyArray<TalentView> }>(
    config,
    `/api/lp/external/talent${query({ q: input.q, role: input.role, need: input.need })}`,
  );
  return result.talent.length === 0
    ? "No vetted freelancers match."
    : [
        ...result.talent.map(talentLine),
        "",
        "To bring one in, your user opens Get help from a vetted freelancer in the thread header. They pay for the person's hours; the freelancer's AI is included and uses none of their tokens.",
      ].join("\n");
};

/** Errors as text: 403 feature_locked and "Jobs are invite-only for now." read cleanly. */
export const asText = async (
  run: () => Promise<string>,
): Promise<{ text: string; isError: boolean }> => {
  try {
    return { text: await run(), isError: false };
  } catch (error) {
    if (error instanceof OfflineError)
      return { text: `The LogicPacks host is unreachable: ${error.message}`, isError: true };
    if (error instanceof RejectedError) return { text: error.message, isError: true };
    throw error;
  }
};

export const JOBS_TOOLS = [
  {
    name: "jobs_search",
    description:
      "Freelancer jobs board (invite-only): open jobs from LogicPacks customers, redacted until you are accepted. Filter by role (designer, developer, devops) and skills.",
    inputSchema: {
      type: "object",
      properties: {
        role: { type: "string" },
        skills: { type: "string", description: "Comma separated." },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "jobs_show",
    description: "One job's full brief: scope, deliverables, milestones, hours, out of scope.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    annotations: { readOnlyHint: true },
  },
  {
    name: "jobs_apply",
    description:
      "Apply to a job for your user: a short note on how they would do it, and optionally their own hours estimate. Only when your user asked you to apply.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        note: { type: "string", maxLength: 2000 },
        hours: { type: "number" },
      },
      required: ["id", "note"],
    },
  },
] as const;

export const JOBS_TOOL_NAMES = new Set<string>(JOBS_TOOLS.map((tool) => tool.name));

export const callJobsTool = (config: HelperConfig, tool: string, args: Record<string, unknown>) => {
  const text = (value: unknown) => (typeof value === "string" ? value : null);
  if (!config.server || !config.token) {
    return Promise.resolve({ text: NOT_CONNECTED, isError: true });
  }
  switch (tool) {
    case "jobs_search":
      return asText(() => jobsSearch(config, { role: text(args.role), skills: text(args.skills) }));
    case "jobs_show":
      return asText(() => jobsShow(config, text(args.id) ?? ""));
    default:
      return asText(() =>
        jobsApply(config, {
          id: text(args.id) ?? "",
          note: text(args.note) ?? "",
          hours: typeof args.hours === "number" ? args.hours : null,
        }),
      );
  }
};
