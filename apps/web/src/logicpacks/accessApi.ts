import { lpRequest, type LpSeat } from "./api";

export interface LpAccessRequest {
  readonly id: string;
  readonly userId: string;
  readonly name: string;
  readonly zone: "ai" | "compute";
  readonly createdAtMs: number;
}

export interface LpAccessLogEntry {
  readonly id: string;
  readonly atMs: number;
  readonly userId: string | null;
  readonly name: string;
  readonly kind: string;
  readonly detail: string;
}

/** What the Share dialog reads about access; owners get all of it, members their own seat. */
export interface LpAccessOverview {
  readonly hostAgents: ReadonlyArray<"claude" | "codex" | "opencode">;
  /** Whether this host can confine a member's terminal and agent to the shared folders. */
  readonly sandbox?: { readonly available: boolean; readonly reason: string | null };
  readonly default?: LpSeat;
  readonly defaultIsSet?: boolean;
  readonly members?: Readonly<Record<string, LpSeat>>;
  readonly requests?: ReadonlyArray<LpAccessRequest>;
  readonly log?: ReadonlyArray<LpAccessLogEntry>;
  readonly mine: LpSeat | null;
}

export interface LpAccessChange {
  readonly projectId: string;
  /** Omitted: the project's default (what the share link gives). */
  readonly userId?: string;
  readonly preset?: string;
  readonly zones?: Readonly<Record<string, string>>;
  readonly clear?: boolean;
  readonly confirmFull?: boolean;
}

export const accessApi = {
  overview: (projectId: string) =>
    lpRequest<LpAccessOverview>(`/api/lp/access?projectId=${encodeURIComponent(projectId)}`),
  set: (change: LpAccessChange) => lpRequest<LpAccessOverview>("/api/lp/access/set", change),
  request: (projectId: string, zone: "ai" | "compute") =>
    lpRequest<{ request: { id: string; zone: string; status: string } }>("/api/lp/access/request", {
      projectId,
      zone,
    }),
  decide: (input: {
    projectId: string;
    requestId: string;
    decision: "allow" | "deny";
    confirmFull?: boolean;
  }) => lpRequest<LpAccessOverview>("/api/lp/access/decide", input),
};
