import { lpRequest, type LpProjectMember, type LpUser } from "./api";

/** Project sharing beyond existing accounts: pending invites and the share link. */
export type LpLinkExpiry = "1d" | "7d" | "never";

export interface LpPendingInvite {
  readonly inviteId: string;
  readonly email: string;
  readonly role: "member";
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly lastSentAt: string;
  readonly path: string;
}

export interface LpShareLink {
  readonly enabled: boolean;
  readonly role: "member";
  readonly expiry: LpLinkExpiry;
  readonly expiresAt: string | null;
  readonly domain: string | null;
  readonly path: string;
}

export interface LpShareOverview {
  readonly canManage: boolean;
  readonly members: ReadonlyArray<LpProjectMember>;
  readonly invites: ReadonlyArray<LpPendingInvite>;
  readonly link: LpShareLink | null;
  readonly joins: ReadonlyArray<{ readonly user: LpUser; readonly joinedAt: string }>;
  readonly emailMode?: "apps-script" | "smtp" | "log";
}

export type LpShareResult =
  | { readonly kind: "member"; readonly member: LpProjectMember }
  | { readonly kind: "invited"; readonly invite: LpPendingInvite; readonly emailSent: boolean };

export const shareApi = {
  overview: (projectId: string) =>
    lpRequest<LpShareOverview>(`/api/lp/shares?projectId=${encodeURIComponent(projectId)}`),
  share: (projectId: string, user: string) =>
    lpRequest<LpShareResult>("/api/lp/shares", { projectId, user }),
  resend: (projectId: string, inviteId: string) =>
    lpRequest<{ invite: LpPendingInvite; emailSent: boolean }>("/api/lp/shares/invites/resend", {
      projectId,
      inviteId,
    }),
  revoke: (projectId: string, inviteId: string) =>
    lpRequest("/api/lp/shares/invites/revoke", { projectId, inviteId }),
  updateLink: (
    projectId: string,
    change: { enabled?: boolean; expiry?: LpLinkExpiry; domain?: string | null },
  ) => lpRequest<{ link: LpShareLink }>("/api/lp/shares/link", { projectId, ...change }),
  resetLink: (projectId: string) =>
    lpRequest<{ link: LpShareLink }>("/api/lp/shares/link/reset", { projectId }),
};

/** A loose check for the inline hint; the server decides. */
export const looksLikeEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value.trim());
