import type { RecipeManifest } from "@logicpacks/contracts";
import { readDesktopPrimaryBearerToken } from "../environments/primary/desktopAuth";
import { resolvePrimaryEnvironmentHttpUrl } from "../environments/primary/target";
import type { LpProjectLocal } from "./projectFiles.logic";

export interface LpUser {
  readonly userId: string;
  readonly email: string;
  readonly displayName: string;
}

export type LpWorkspaceRole = "owner" | "member";

export interface LpWorkspace {
  readonly workspaceId: string;
  readonly name: string;
  readonly role: LpWorkspaceRole | "operator";
  readonly memberCount: number;
  readonly projectIds: ReadonlyArray<string>;
}

export interface LpTemplate {
  readonly id: string;
  readonly title: string;
  readonly description: string;
}

export type LpOnboardingChoice = "pro" | "beginner" | "skipped";

export interface LpConnection {
  /** The host has this provider set up at all. */
  readonly available: boolean;
  readonly connected: boolean;
  readonly account: string | null;
}

export interface LpSession {
  /** Null for the host operator (desktop owner, paired device). */
  readonly user: LpUser | null;
  readonly operator: boolean;
  /** Desktop/laptop host: agents run on the installed Claude Code / Codex; no logins in the app. */
  readonly localAgents?: boolean;
  /** This server is the team's cloud host. */
  readonly cloudHost?: boolean;
  /** LOGICPACKS_HOST_LABEL on the host, shown to members instead of the machine's name. */
  readonly hostLabel?: string | null;
  readonly workspaces: ReadonlyArray<LpWorkspace>;
  readonly currentWorkspaceId: string | null;
  readonly claude: { readonly instanceId: string; readonly connected: boolean } | null;
  /** Any of the member's own agents (Claude, Codex, OpenCode, Gemini) is connected. */
  readonly agentConnected?: boolean;
  /** First-run answer to "How do you work?"; null until the member answers or skips. */
  readonly onboarding?: LpOnboardingChoice | null;
  /** The member's own GitHub and Cloudflare; null for the operator. */
  readonly connections?: {
    readonly github: LpConnection;
    readonly cloudflare: LpConnection;
  } | null;
  /** Access-gated features unlocked for this caller, e.g. "apps". */
  readonly features?: ReadonlyArray<string>;
  readonly templates: ReadonlyArray<LpTemplate>;
}

export interface LpWorkspaceMember {
  readonly user: LpUser;
  readonly role: LpWorkspaceRole;
}

export interface LpProjectMember {
  readonly user: LpUser;
  readonly role: "owner" | "member";
}

export type LpSyncState = "not_synced" | "syncing" | "synced" | "conflict" | "error";

export interface LpProjectSync {
  readonly projectId: string;
  readonly state: LpSyncState;
  readonly remoteUrl: string | null;
  readonly branch: string | null;
  readonly cloudUrl: string | null;
  readonly cloudProjectId: string | null;
  readonly ahead: number;
  readonly behind: number;
  readonly conflictFiles: ReadonlyArray<string>;
  readonly theirsAuthor: string | null;
  readonly message: string | null;
  readonly lastSyncedAt: string | null;
}

export interface LpCloudHost {
  readonly isCloudHost: boolean;
  readonly url: string;
  readonly connected: boolean;
  readonly account: string | null;
  /** How often this server syncs synced projects, in seconds. */
  readonly syncSeconds?: number;
}

export type LpNewProject =
  | { readonly kind: "empty"; readonly name: string; readonly recipe?: string }
  | { readonly kind: "template"; readonly name: string; readonly template: string }
  | { readonly kind: "git"; readonly remoteUrl: string };

/** A project's recipe, and for app recipes whether this caller can open the app here. */
export interface LpProjectRecipe {
  readonly recipeId: string;
  readonly app: {
    readonly name: string;
    readonly download: string | null;
    readonly access: "open" | "open-in-desktop" | "coming-soon";
    readonly installed: boolean;
    readonly running: boolean;
  } | null;
}

/** One item of an app's outline (an object, for Blender), credited to its last editor. */
export interface LpRecipeViewItem {
  readonly id: string | null;
  readonly name: string;
  readonly type: string;
  readonly parent: string | null;
  readonly hidden: boolean;
  readonly last: {
    readonly actor: {
      readonly kind: "human" | "agent";
      readonly id: string;
      readonly name?: string;
    };
    readonly at: string;
    readonly kind: string;
  } | null;
}

/** An app project's live view: the app's frame (base64 PNG) and its outline. */
export type LpRecipeView =
  | { readonly running: false }
  | {
      readonly running: true;
      readonly file: string | null;
      readonly background: boolean;
      readonly ops: number;
      readonly objects: ReadonlyArray<LpRecipeViewItem>;
      readonly image: string | null;
      readonly mode: "viewport" | "render" | null;
      readonly imageError?: string;
    };

/** The project ledger: who is in which thread, goals, files, conflicts, negotiations. */
export interface LpLedgerPerson {
  readonly id: string;
  readonly name: string;
}

export interface LpLedgerThread {
  readonly threadId: string;
  readonly projectId: string;
  readonly title: string;
  readonly members: ReadonlyArray<LpLedgerPerson>;
  readonly agent: { readonly name: string; readonly model: string | null } | null;
  readonly goal: string | null;
  readonly goalSource: "agent" | "summary" | "title";
  readonly files: ReadonlyArray<{
    readonly path: string;
    readonly activity: string;
    readonly by: string;
    readonly atMs: number;
  }>;
  readonly branch: string | null;
  readonly status: "working" | "waiting" | "idle";
  readonly lastActiveAtMs: number;
  readonly branchedFrom: string | null;
}

export interface LpLedgerMessage {
  readonly id: string;
  readonly fromThreadId: string | null;
  readonly fromName: string;
  readonly toThreadId: string;
  readonly text: string;
  readonly kind: "ask" | "reply" | "notice";
  readonly replyTo: string | null;
  readonly createdAtMs: number;
  readonly deliveredAtMs: number | null;
  /** A goal milestone's task; the thread shows its task card instead. */
  readonly goalTask?: { readonly goalId: string; readonly milestoneId: string };
}

export interface LpLedgerConflict {
  readonly id: string;
  readonly source: "sync" | "overlap";
  readonly files: ReadonlyArray<string>;
  readonly parties: ReadonlyArray<{ readonly threadId: string; readonly name: string }>;
  readonly people: ReadonlyArray<string>;
  readonly reason: string;
  readonly state: "open" | "negotiating" | "resolved";
  readonly negotiationId: string | null;
}

export type LpNegotiationChoice = "accept" | "mine" | "theirs" | "both";

export interface LpNegotiation {
  readonly id: string;
  readonly conflictId: string | null;
  readonly files: ReadonlyArray<string>;
  readonly state: "collecting" | "awaiting_humans" | "agreed" | "merged" | "failed" | "timed_out";
  readonly round: number;
  readonly maxRounds: number;
  readonly parties: ReadonlyArray<{
    readonly threadId: string;
    readonly name: string;
    readonly position: {
      readonly keep: ReadonlyArray<string>;
      readonly drop: ReadonlyArray<string>;
      readonly insist: boolean;
    } | null;
    readonly question: string | null;
    readonly decision: LpNegotiationChoice | null;
  }>;
  readonly plan: { readonly summary: string } | null;
  readonly mergerThreadId: string | null;
  readonly outcome: {
    readonly ok: boolean;
    readonly branch: string | null;
    readonly summary: string;
    readonly by: string;
  } | null;
}

export interface LpProjectLedger {
  readonly projectId: string;
  readonly threads: ReadonlyArray<LpLedgerThread>;
  readonly conflicts: ReadonlyArray<LpLedgerConflict>;
  readonly negotiations: ReadonlyArray<LpNegotiation>;
  readonly decisions: ReadonlyArray<{
    readonly id: string;
    readonly text: string;
    readonly by: string;
  }>;
}

export interface LpThreadLedger {
  readonly threadId: string;
  readonly projectId: string;
  readonly notices: ReadonlyArray<LpLedgerMessage>;
  readonly conflicts: ReadonlyArray<LpLedgerConflict>;
  readonly negotiations: ReadonlyArray<LpNegotiation>;
}

/** An achievement a request just unlocked, as the server reports it. */
export interface LpUnlockedBadge {
  readonly id: string;
  readonly name: string;
  readonly points: number;
}

export type LpAgentKind = "claude" | "codex" | "opencode" | "gemini";

/** One of the four agents a member can connect, on this host. */
export interface LpAgentStatus {
  readonly kind: LpAgentKind;
  readonly label: string;
  readonly instanceId: string;
  readonly connected: boolean;
  readonly installed: boolean;
  readonly installHint: string;
  readonly methods: ReadonlyArray<"browser" | "token" | "api-key" | "free">;
}

/** A browser login in progress: the link, a device code where there is one, never a token. */
export interface LpAgentLogin {
  readonly provider: LpAgentKind;
  readonly loginId: string;
  readonly url: string | null;
  readonly code: string | null;
  readonly wantsCode: boolean;
  readonly done: boolean;
  readonly output: string;
  readonly running?: boolean;
  readonly connected?: boolean;
}

export interface LpAppOpSpec {
  readonly name: string;
  readonly usage: string;
  readonly summary: string;
  readonly mutates: boolean;
  readonly app: "blender" | "resolve" | "any";
}

export interface LpAppOps {
  readonly projectId: string;
  readonly canControl: boolean;
  readonly shared: { readonly appName: string; readonly recipeId: string | null } | null;
  readonly ops: ReadonlyArray<LpAppOpSpec>;
}

export class LpRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** An absolute URL on the primary environment, for links people open elsewhere. */
export function lpAbsoluteUrl(pathWithQuery: string): string {
  return new URL(pathWithQuery, resolvePrimaryEnvironmentHttpUrl("/")).toString();
}

function isSameOriginBrowser(base: string): boolean {
  return (
    typeof window !== "undefined" &&
    window.desktopBridge === undefined &&
    window.location.origin.startsWith("http") &&
    new URL(base).origin === window.location.origin
  );
}

/** The session cookie in a browser, the bearer on desktop: for requests lpRequest cannot make. */
export async function lpRequestAuth(url: string): Promise<{
  readonly credentials: RequestCredentials;
  readonly headers: Record<string, string>;
}> {
  if (isSameOriginBrowser(url)) return { credentials: "include", headers: {} };
  const token = await readDesktopPrimaryBearerToken();
  return { credentials: "omit", headers: token ? { authorization: `Bearer ${token}` } : {} };
}

/** Same auth as the environment's HTTP API: the session cookie in a browser, the bearer on desktop. */
export async function lpRequest<T>(path: string, body?: unknown): Promise<T> {
  const url = lpAbsoluteUrl(path);
  const auth = await lpRequestAuth(url);
  const headers: Record<string, string> = { ...auth.headers };
  const credentials = auth.credentials;
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(url, {
    method: body === undefined ? "GET" : "POST",
    credentials,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const message =
      typeof payload.message === "string"
        ? payload.message
        : typeof payload.error === "string"
          ? payload.error
          : "Something went wrong.";
    throw new LpRequestError(message, response.status);
  }
  return payload as T;
}

const query = (workspaceId: string) => `workspaceId=${encodeURIComponent(workspaceId)}`;

export const lpApi = {
  session: () => lpRequest<LpSession>("/api/lp/session"),
  createWorkspace: (name: string) =>
    lpRequest<{ workspace: LpWorkspace }>("/api/lp/workspaces", { name }),
  switchWorkspace: (workspaceId: string | null) =>
    lpRequest("/api/lp/workspaces/current", { workspaceId }),
  renameWorkspace: (workspaceId: string, name: string) =>
    lpRequest("/api/lp/workspaces/rename", { workspaceId, name }),
  deleteWorkspace: (workspaceId: string) => lpRequest("/api/lp/workspaces/delete", { workspaceId }),
  members: (workspaceId: string) =>
    lpRequest<{ members: ReadonlyArray<LpWorkspaceMember>; canManage: boolean }>(
      `/api/lp/workspaces/members?${query(workspaceId)}`,
    ),
  addMember: (workspaceId: string, user: string, role: LpWorkspaceRole) =>
    lpRequest("/api/lp/workspaces/members", { workspaceId, user, role }),
  setRole: (workspaceId: string, userId: string, role: LpWorkspaceRole) =>
    lpRequest("/api/lp/workspaces/members/role", { workspaceId, userId, role }),
  removeMember: (workspaceId: string, userId: string) =>
    lpRequest("/api/lp/workspaces/members/remove", { workspaceId, userId }),
  invite: (workspaceId: string) =>
    lpRequest<{ path: string }>(`/api/lp/workspaces/invite?${query(workspaceId)}`),
  resetInvite: (workspaceId: string) =>
    lpRequest<{ path: string }>("/api/lp/workspaces/invite/reset", { workspaceId }),
  setOnboarding: (choice: LpOnboardingChoice) =>
    lpRequest<{ choice: LpOnboardingChoice; projectId: string | null }>("/api/lp/onboarding", {
      choice,
    }),
  newProject: (input: LpNewProject) =>
    lpRequest<{ projectId: string }>("/api/lp/projects/new", input),
  projectRecipe: (projectId: string) =>
    lpRequest<LpProjectRecipe>(
      `/api/lp/projects/recipe?projectId=${encodeURIComponent(projectId)}`,
    ),
  launchRecipe: (projectId: string) =>
    lpRequest<{ running: boolean; alreadyRunning: boolean }>("/api/lp/recipes/launch", {
      projectId,
    }),
  recipeView: (projectId: string, width: number) =>
    lpRequest<LpRecipeView>(
      `/api/lp/recipes/view?projectId=${encodeURIComponent(projectId)}&width=${Math.round(width)}`,
    ),
  appStreamTicket: (projectId: string) =>
    lpRequest<{
      ticket: string;
      canHost: boolean;
      name: string;
      subject: string;
      project: string;
    }>("/api/lp/appstream/ticket", { projectId }),
  appOps: (projectId: string) =>
    lpRequest<LpAppOps>(`/api/lp/apps/ops?projectId=${encodeURIComponent(projectId)}`),
  runAppOp: (projectId: string, op: string, args: ReadonlyArray<string>, as: "human" | "agent") =>
    lpRequest<{ ok: boolean; result: unknown }>("/api/lp/apps/run", { projectId, op, args, as }),
  connectClaude: (token: string) => lpRequest("/api/lp/providers/claude", { token }),
  agents: () =>
    lpRequest<{
      scope: "member" | "host";
      /** False: no cloud logins for this member; agents run on their connected computer. */
      cloudAgents?: boolean;
      providers: ReadonlyArray<LpAgentStatus>;
    }>("/api/lp/providers/status"),
  startAgentLogin: (provider: LpAgentKind, via?: "copilot" | "chatgpt") =>
    lpRequest<LpAgentLogin>("/api/lp/providers/login/start", {
      provider,
      ...(via === undefined ? {} : { via }),
    }),
  agentLoginStatus: (provider: LpAgentKind) =>
    lpRequest<LpAgentLogin & { running: boolean; connected: boolean }>(
      `/api/lp/providers/login/status?provider=${provider}`,
    ),
  sendAgentLoginCode: (input: { provider: "claude" | "gemini"; code: string; loginId: string }) =>
    lpRequest<{ connected: boolean; accepted: boolean; failed: boolean; output: string }>(
      "/api/lp/providers/login/code",
      input,
    ),
  cancelAgentLogin: (provider: LpAgentKind) =>
    lpRequest("/api/lp/providers/login/cancel", { provider }),
  connectAgentFree: (provider: "opencode") =>
    lpRequest<{ connected: boolean }>("/api/lp/providers/free", { provider }),
  connectAgentKey: (input: {
    provider: Exclude<LpAgentKind, "claude">;
    key: string;
    keyProvider?: "anthropic" | "openai" | "openrouter";
  }) => lpRequest<{ connected: boolean }>("/api/lp/providers/key", input),
  disconnectAgent: (provider: LpAgentKind) => lpRequest("/api/lp/providers/remove", { provider }),
  logout: () => lpRequest("/api/lp/auth/logout", {}),
  projectMembers: (projectId: string) =>
    lpRequest<{ members: ReadonlyArray<LpProjectMember> }>(
      `/api/lp/members?projectId=${encodeURIComponent(projectId)}`,
    ),
  shareProject: (projectId: string, user: string) =>
    lpRequest("/api/lp/members", { projectId, user }),
  unshareProject: (projectId: string, userId: string) =>
    lpRequest("/api/lp/members/remove", { projectId, userId }),
  projectLocal: (projectId: string) =>
    lpRequest<LpProjectLocal>(`/api/lp/projects/local?projectId=${encodeURIComponent(projectId)}`),
  syncStatus: () =>
    lpRequest<{ cloud: LpCloudHost; projects: ReadonlyArray<LpProjectSync> }>(
      "/api/lp/sync/status",
    ),
  startSync: (projectId: string) =>
    lpRequest<{ status: LpProjectSync }>("/api/lp/sync/start", { projectId }),
  syncNow: (projectId: string) =>
    lpRequest<{ status: LpProjectSync }>("/api/lp/sync/now", { projectId }),
  resolveConflict: (projectId: string, strategy: "mine" | "theirs") =>
    lpRequest<{ status: LpProjectSync }>("/api/lp/sync/resolve", { projectId, strategy }),
  connectCloud: (input: {
    url: string;
    mode: "signup" | "login";
    email: string;
    password: string;
    displayName?: string;
  }) => lpRequest<{ cloud: LpCloudHost }>("/api/lp/cloud/connect", input),
  disconnectCloud: () => lpRequest<{ cloud: LpCloudHost }>("/api/lp/cloud/disconnect", {}),
  projectLedger: (projectId: string) =>
    lpRequest<LpProjectLedger>(`/api/lp/ledger/project?projectId=${encodeURIComponent(projectId)}`),
  threadLedger: (threadId: string) =>
    lpRequest<LpThreadLedger | null>(
      `/api/lp/ledger/thread?threadId=${encodeURIComponent(threadId)}`,
    ),
  sendToThread: (input: { threadId: string; to: string; text: string; replyTo?: string | null }) =>
    lpRequest<{ message: LpLedgerMessage }>("/api/lp/ledger/send", input),
  markNoticesSeen: (threadId: string, messageIds: ReadonlyArray<string>) =>
    lpRequest("/api/lp/ledger/seen", { threadId, messageIds }),
  proposeMerge: (input: { threadId: string; conflictId?: string }) =>
    lpRequest<{ negotiation: LpNegotiation }>("/api/lp/ledger/merge", input),
  decideNegotiation: (input: {
    negotiationId: string;
    threadId: string;
    choice: LpNegotiationChoice;
    override?: boolean;
  }) => lpRequest<{ negotiation: LpNegotiation }>("/api/lp/ledger/decide", input),
  branchThread: (threadId: string) =>
    lpRequest<{ threadId: string }>("/api/lp/ledger/branch", { threadId }),
  experts: () => lpRequest<{ beta: boolean; experts: ReadonlyArray<LpExpert> }>("/api/lp/experts"),
  expertBrief: (threadId: string) =>
    lpRequest<{ brief: string }>(`/api/lp/experts/brief?threadId=${encodeURIComponent(threadId)}`),
  expertRequests: (projectId: string) =>
    lpRequest<{ requests: ReadonlyArray<LpExpertRequest> }>(
      `/api/lp/experts/requests?projectId=${encodeURIComponent(projectId)}`,
    ),
  expertInbox: () =>
    lpRequest<{ requests: ReadonlyArray<LpExpertRequest> }>("/api/lp/experts/requests"),
  requestExpert: (input: {
    projectId: string;
    expertId: string;
    brief: string;
    fromThreadId: string;
  }) => lpRequest<{ request: LpExpertRequest }>("/api/lp/experts/requests", input),
  acceptExpertRequest: (requestId: string) =>
    lpRequest<{ request: LpExpertRequest }>("/api/lp/experts/accept", { requestId }),
  declineExpertRequest: (requestId: string) =>
    lpRequest<{ request: LpExpertRequest }>("/api/lp/experts/decline", { requestId }),
  setExpertStatus: (requestId: string, status: "working" | "done") =>
    lpRequest<{ request: LpExpertRequest }>("/api/lp/experts/status", { requestId, status }),
  grantExpert: (requestId: string) =>
    lpRequest<{ request: LpExpertRequest }>("/api/lp/experts/grant", { requestId }),
  revokeExpert: (requestId: string) =>
    lpRequest<{ request: LpExpertRequest }>("/api/lp/experts/revoke", { requestId }),
  delegateToExpert: (requestId: string, text: string) =>
    lpRequest<{ request: LpExpertRequest }>("/api/lp/experts/delegate", { requestId, text }),
  endExpertRequest: (requestId: string) =>
    lpRequest<{ request: LpExpertRequest }>("/api/lp/experts/end", { requestId }),
  adminExperts: () => lpRequest<{ experts: ReadonlyArray<LpExpertAdmin> }>("/api/lp/admin/experts"),
  adminPutExpert: (
    expert: Partial<LpExpertAdmin> & {
      id: string;
      name: string;
      specialty: string;
      accountEmail: string;
    },
  ) => lpRequest<{ expert: LpExpertAdmin }>("/api/lp/admin/experts", expert),
  adminRemoveExpert: (id: string) => lpRequest("/api/lp/admin/experts/remove", { id }),
  packs: (projectId: string) =>
    lpRequest<{ projectId: string; packs: ReadonlyArray<LpPackView> }>(
      `/api/lp/packs?projectId=${encodeURIComponent(projectId)}`,
    ),
  saveThreadAsPack: (input: {
    threadId: string;
    name?: string;
    prompts?: ReadonlyArray<string>;
    appItems?: ReadonlyArray<{
      kind: "app-object" | "timeline-marker";
      name: string;
      detail?: string;
    }>;
  }) =>
    lpRequest<LpPackView & { unlocked?: ReadonlyArray<LpUnlockedBadge> }>(
      "/api/lp/packs/save",
      input,
    ),
  // Not `usePack`: the React Compiler reads a `use` prefix as a hook call.
  handOffPack: (input: {
    projectId: string;
    packId: string;
    targetThreadId?: string;
    targetProjectId?: string;
  }) =>
    lpRequest<{
      copied: boolean;
      delivered: string | null;
      targetProjectId: string;
      unlocked?: ReadonlyArray<LpUnlockedBadge>;
    }>("/api/lp/packs/use", input),
};

export type LpExpertAvailability = "available" | "busy" | "away";

/** A curated expert as requesters see them. Sample profiles are illustrative, not real people. */
export interface LpExpert {
  readonly id: string;
  readonly name: string;
  readonly specialty: string;
  readonly skills: ReadonlyArray<string>;
  readonly bio: string;
  readonly rating: number;
  readonly reviews: number;
  readonly availability: LpExpertAvailability;
  readonly avatar: string;
  readonly sample: boolean;
}

export interface LpExpertAdmin extends LpExpert {
  readonly accountEmail: string;
  readonly active: boolean;
}

export type LpExpertRequestStatus =
  | "requested"
  | "accepted"
  | "working"
  | "done"
  | "declined"
  | "ended";

export interface LpExpertRequest {
  readonly id: string;
  readonly projectId: string;
  readonly projectTitle: string;
  readonly requesterUserId: string | null;
  readonly requesterName: string;
  readonly expertId: string;
  readonly expertUserId: string | null;
  readonly brief: string;
  readonly fromThreadId: string | null;
  readonly expertThreadId: string | null;
  readonly status: LpExpertRequestStatus;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly history: ReadonlyArray<{ status: LpExpertRequestStatus; atMs: number; by: string }>;
  readonly expert: LpExpert | null;
  readonly grants: ReadonlyArray<{
    id: string;
    instanceIds: ReadonlyArray<string>;
    ownerName: string;
    createdAtMs: number;
    revokedAtMs: number | null;
  }>;
  readonly grantActive: boolean;
}

/** A saved pack and the text an agent reads from its context. */
export interface LpPackView {
  readonly pack: RecipeManifest;
  readonly text: string | null;
}

/** The text a teammate pastes into their own Claude Code or Codex to join. */
export function inviteAgentPrompt(input: { workspaceName: string; url: string }): string {
  return [
    `Help me join the LogicPacks workspace "${input.workspaceName}".`,
    `1. Open this invite link in my browser: ${input.url}`,
    "2. I will create an account or sign in on that page. That puts me in the workspace.",
    "3. Then help me connect my Claude login: run `claude setup-token` in my terminal, and when it prints a token, tell me to paste it into LogicPacks under Connect Claude.",
    "Do not ask me to share the token with you or anyone else.",
  ].join("\n");
}
