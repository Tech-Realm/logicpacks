import { agentLimitsFor, type AgentLimits } from "@logicpacks/contracts";

import { secretPatterns } from "./externalTeam.ts";
import { resolveSharedFolders } from "./memberJail.ts";
import { memberSandboxSupported } from "./folderSandbox.ts";
import { memberSandboxEnabled } from "./memberSandbox.ts";

/** The OS can confine a run here: macOS Seatbelt, or the cloud host's per-member Unix users. */
const sandboxPossible = () => memberSandboxSupported() || memberSandboxEnabled();

/**
 * Agent runs on a member's behalf stay inside the member's zones. The fence records who sent each
 * message; when a run starts, the runtime policy asks here for that sender's limits and passes
 * them to the provider (Claude: disallowed tools, Codex: sandbox, ACP agents: refused permission
 * requests). Limits are looked up when the run STARTS from the sender's live zones, so a change
 * made while a message waited in the queue applies to it.
 *
 * What this does NOT do, honestly:
 * - An agent allowed to edit files can write a script, a git hook or `t3.json` that someone
 *   later runs. Compute off blocks the agent's shell tool, not code the host then executes.
 * - Host MCP servers and skills are the host's tools; we cannot know what they run.
 * - A run whose sender is unknown (a scheduled task, another agent's message) gets the sender
 *   thread's limits when there is one, else none: those paths need Compute (see zoneGate.ts).
 */

/** Where a sandboxed run may read and write: resolved REAL folders plus the member's own space. */
export interface RunConfinement {
  readonly folders: ReadonlyArray<string>;
  /** The whole project is shared: a worktree of it is inside too. */
  readonly wholeProject: boolean;
  readonly worktreesDir: string;
  readonly memberHome: string;
  readonly stateDir: string;
}

export interface RunLimits extends AgentLimits {
  /** Secret-file globs Claude is told not to open when `hideSecrets`. */
  readonly secretGlobs: ReadonlyArray<string>;
  /** Present when the run must be confined to folders by the OS (see `sandbox`). */
  readonly confinement?: RunConfinement | undefined;
}

interface Sender {
  readonly userId: string;
  readonly projectId: string | null;
  /** What the fence knew when the message arrived: the project folder and the member's space. */
  readonly confine?:
    | {
        readonly projectRoot: string;
        readonly worktreesDir: string;
        readonly memberHome: string;
        readonly stateDir: string;
      }
    | undefined;
}

const bySender = new Map<string, Sender>();
const threadSender = new Map<string, Sender>();

/** Called by the fence before a member's message reaches the orchestrator. */
export const registerMemberMessage = (
  threadId: string,
  messageId: string,
  sender: Sender,
): void => {
  bySender.set(messageId, sender);
  threadSender.set(threadId, sender);
  if (bySender.size > 5000) {
    const oldest = bySender.keys().next();
    if (!oldest.done) bySender.delete(oldest.value);
  }
};

/** Whose message started a run: a member's, or null (host or unknown). */
export const senderOfMessage = (
  messageId: string,
  senderThreadId?: string | null | undefined,
): Sender | null =>
  bySender.get(messageId) ??
  (senderThreadId === undefined || senderThreadId === null
    ? null
    : (threadSender.get(senderThreadId) ?? null));

/** Test helper. */
export const clearRunSenders = () => {
  bySender.clear();
  threadSender.clear();
};

/** Resolves a sender's current limits; installed by LogicPacksAccess so it reads live zones. */
let resolveSenderLimits: ((sender: Sender) => AgentLimits | null) | null = null;
export const installRunLimiter = (resolve: ((sender: Sender) => AgentLimits | null) | null) => {
  resolveSenderLimits = resolve;
};

export const limitsForRun = (input: {
  readonly messageId: string;
  readonly senderThreadId?: string | null | undefined;
}): RunLimits | undefined => {
  const sender = senderOfMessage(input.messageId, input.senderThreadId);
  if (sender === null || resolveSenderLimits === null) return undefined;
  const limits = resolveSenderLimits(sender);
  if (limits === null) return undefined;
  const confine = sender.confine;
  const confinement =
    limits.sandbox &&
    confine !== undefined &&
    // A host that cannot sandbox keeps the tool limits for runs with no shell; a run WITH a shell
    // stays confined-or-refused (the adapter refuses to start it).
    (limits.shell || sandboxPossible())
      ? {
          folders: resolveSharedFolders(confine.projectRoot, limits.folders).folders,
          wholeProject: limits.folders.length === 0,
          worktreesDir: confine.worktreesDir,
          memberHome: confine.memberHome,
          stateDir: confine.stateDir,
        }
      : undefined;
  return {
    ...limits,
    secretGlobs: secretPatterns(process.env.LOGICPACKS_EXTERNAL_SECRET_PATTERNS),
    confinement,
  };
};

export { agentLimitsFor };

/**
 * Host-level writes through the agent's MCP tools (project create, update, delete, environment
 * settings, scheduled tasks): a thread last driven by a member may do them only if that person's
 * zones allow Projects or Compute. Installed by LogicPacksAccess; null when no member is known.
 */
let memberMayWriteHost: ((sender: Sender) => boolean) | null = null;
export const installHostWriteGuard = (guard: ((sender: Sender) => boolean) | null) => {
  memberMayWriteHost = guard;
};

/** False when the thread is a member's and their zones do not allow host-level writes. */
export const hostWriteAllowedForThread = (threadId: string): boolean => {
  const sender = threadSender.get(threadId);
  if (sender === undefined || memberMayWriteHost === null) return true;
  return memberMayWriteHost(sender);
};
