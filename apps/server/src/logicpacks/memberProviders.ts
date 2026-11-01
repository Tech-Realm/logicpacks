// @effect-diagnostics-next-line nodeBuiltinImport:off -- a stable digest for instance ids, no Effect needed.
import * as NodeCrypto from "node:crypto";

/**
 * Each member's own provider login is an ordinary upstream provider instance with its
 * own home (CLAUDE_CONFIG_DIR, CODEX_HOME, ...), so the adapter needs no per-user
 * plumbing: a turn spends whoever's instance the thread selected.
 */
export const MEMBER_INSTANCE_PREFIX = "claude-lp-";

/** The four agents a member can log in to, in picker order. */
export const MEMBER_PROVIDER_KINDS = ["claude", "codex", "opencode", "gemini"] as const;
export type MemberProviderKind = (typeof MEMBER_PROVIDER_KINDS)[number];

export const isMemberProviderKind = (value: unknown): value is MemberProviderKind =>
  typeof value === "string" && (MEMBER_PROVIDER_KINDS as ReadonlyArray<string>).includes(value);

export const userDigest = (userId: string) =>
  NodeCrypto.createHash("sha256").update(userId).digest("hex").slice(0, 16);

/** `claude-lp-<hash>`, `codex-lp-<hash>`, `opencode-lp-<hash>`, `gemini-lp-<hash>`. */
export const memberInstanceId = (kind: MemberProviderKind, userId: string) =>
  `${kind}-lp-${userDigest(userId)}`;

export const memberClaudeInstanceId = (userId: string) => memberInstanceId("claude", userId);

const MEMBER_INSTANCE_PATTERN = /^(claude|codex|opencode|gemini)-lp-[0-9a-f]{16}$/;

export const isMemberInstanceId = (instanceId: string) => MEMBER_INSTANCE_PATTERN.test(instanceId);

/** Whether the instance is one of this member's own logins. */
export const isOwnMemberInstance = (instanceId: string, userId: string) =>
  MEMBER_PROVIDER_KINDS.some((kind) => memberInstanceId(kind, userId) === instanceId);

/** The instance a payload's model selection names, if any. */
export const selectedInstanceId = (payload: unknown): string | null => {
  if (payload === null || typeof payload !== "object") return null;
  const selection = (payload as Record<string, unknown>)["modelSelection"];
  if (selection === null || typeof selection !== "object") return null;
  const record = selection as Record<string, unknown>;
  const id = record["instanceId"] ?? record["provider"];
  return typeof id === "string" ? id : null;
};

/**
 * A message that names no model runs on the thread's current instance, which the
 * payload does not show. Returns the thread to look it up on.
 */
export const threadRunWithoutSelection = (payload: unknown): string | null => {
  if (payload === null || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  if (record["type"] !== "message.dispatch" || record["modelSelection"] !== undefined) return null;
  const threadId = record["threadId"];
  return typeof threadId === "string" && threadId.length > 0 ? threadId : null;
};

export type InstanceDecision = "allow" | "granted" | "someone_elses" | "needs_own_login";

/**
 * Members never run on another member's login, and by default not on the operator's
 * either: `LOGICPACKS_MEMBERS_OWN_PROVIDERS=false` lends those. A grant is the one
 * exception: the login's owner let this member use it, for one project. `granted` says
 * the caller holds such a grant for the project this turn runs in.
 */
export const decideInstanceUse = (input: {
  readonly instanceId: string;
  readonly userId: string;
  readonly membersMustUseOwn: boolean;
  readonly granted?: boolean | undefined;
}): InstanceDecision => {
  if (isOwnMemberInstance(input.instanceId, input.userId)) return "allow";
  if (input.granted === true) return "granted";
  if (isMemberInstanceId(input.instanceId)) return "someone_elses";
  return input.membersMustUseOwn ? "needs_own_login" : "allow";
};

/**
 * The provider list a member's client shows. Another member's login is listed only
 * while the member holds a grant for it. Once the member has their own, the host's
 * logins they may not use are hidden too, so the picker offers nothing the host refuses.
 */
export const providersForMember = <P extends { readonly instanceId: string }>(
  providers: ReadonlyArray<P>,
  input: {
    readonly userId: string;
    readonly membersMustUseOwn: boolean;
    /** Instances some grant lets this member use, in any project. */
    readonly grantedInstanceIds?: ReadonlySet<string> | undefined;
  },
): ReadonlyArray<P> => {
  const hasOwn = providers.some((provider) =>
    isOwnMemberInstance(provider.instanceId, input.userId),
  );
  return providers.filter((provider) => {
    const decision = decideInstanceUse({
      instanceId: provider.instanceId,
      userId: input.userId,
      membersMustUseOwn: input.membersMustUseOwn,
      granted: input.grantedInstanceIds?.has(provider.instanceId) ?? false,
    });
    return (
      decision === "allow" || decision === "granted" || (decision === "needs_own_login" && !hasOwn)
    );
  });
};
