/**
 * The project ledger's plain data and rules: who is in which thread, what each
 * agent is on (goal, files, branch), decisions, cross-thread messages and open
 * conflicts. No Effect and no storage, so every rule is unit-tested directly.
 */

import type { PreservedVersion } from "./preservedVersions.ts";

export interface LedgerPerson {
  /** A member's user id, or "host" for the host operator. */
  readonly id: string;
  readonly name: string;
}

export type LedgerFileActivity = "viewing" | "reading" | "editing" | "reviewing";

export interface LedgerFile {
  readonly path: string;
  readonly activity: LedgerFileActivity;
  /** Who touched it: a person's name or "<name>'s agent". */
  readonly by: string;
  readonly atMs: number;
}

export type LedgerGoalSource = "agent" | "summary" | "title";
export type LedgerThreadStatus = "working" | "waiting" | "idle";

export interface LedgerThread {
  readonly threadId: string;
  readonly projectId: string;
  readonly title: string;
  /** Everyone who created or wrote in the thread, creator first. */
  readonly members: ReadonlyArray<LedgerPerson>;
  /** The agent: "<owner>'s agent" with its model, when known. */
  readonly agent: { readonly name: string; readonly model: string | null } | null;
  readonly goal: string | null;
  readonly goalSource: LedgerGoalSource;
  /** Most recent first, at most MAX_FILES. */
  readonly files: ReadonlyArray<LedgerFile>;
  readonly branch: string | null;
  readonly status: LedgerThreadStatus;
  readonly lastActiveAtMs: number;
  /** The thread this one was branched from, carrying its context. */
  readonly branchedFrom: string | null;
  /** Set once a person wrote in the thread, so a host placeholder owner can be replaced. */
  readonly ownerConfirmed?: boolean;
}

export type LedgerMessageKind = "ask" | "reply" | "notice";

export interface LedgerMessage {
  readonly id: string;
  readonly projectId: string;
  readonly fromThreadId: string | null;
  readonly fromName: string;
  readonly toThreadId: string;
  readonly text: string;
  readonly kind: LedgerMessageKind;
  readonly replyTo: string | null;
  readonly createdAtMs: number;
  /** When the receiving thread's agent was handed it at a turn start. */
  readonly deliveredAtMs: number | null;
  /** When a person in the receiving thread dismissed the notice. */
  readonly seenAtMs: number | null;
  /** A goal milestone's task (shown as its task card, not as a plain notice). */
  readonly goalTask?: { readonly goalId: string; readonly milestoneId: string } | undefined;
}

export interface LedgerDecision {
  readonly id: string;
  readonly projectId: string;
  readonly threadId: string | null;
  readonly text: string;
  readonly by: string;
  readonly atMs: number;
}

export type LedgerConflictSource = "sync" | "overlap";
export type LedgerConflictState = "open" | "negotiating" | "resolved";

export interface LedgerConflictParty {
  readonly threadId: string;
  readonly name: string;
}

export interface LedgerConflict {
  readonly id: string;
  readonly projectId: string;
  readonly source: LedgerConflictSource;
  readonly files: ReadonlyArray<string>;
  /** The threads whose work collides. */
  readonly parties: ReadonlyArray<LedgerConflictParty>;
  /** Whose work it is, by name: "Ana", "Ali". */
  readonly people: ReadonlyArray<string>;
  readonly reason: string;
  readonly state: LedgerConflictState;
  readonly negotiationId: string | null;
  readonly createdAtMs: number;
  readonly resolvedAtMs: number | null;
  /** Each party's last written version of the file, saved when the overlap was seen (preservedVersions.ts). */
  readonly preserved?: ReadonlyArray<PreservedVersion> | undefined;
  /** No git remote to branch on: Merge both writes every saved version into the file itself. */
  readonly localMerge?: boolean | undefined;
}

export const MAX_FILES = 8;
const GOAL_MAX = 140;

const oneLine = (text: string) => text.replaceAll(/\s+/g, " ").trim();

export const clip = (text: string, max: number) => {
  const line = oneLine(text);
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/**
 * A goal from a person's latest prompt: its first sentence or line, without
 * greetings or the LogicPacks context block an agent may have been handed.
 */
export const summarizeGoal = (text: string): string | null => {
  const withoutContext = text.replace(/<logicpacks_project>[\s\S]*?<\/logicpacks_project>/g, "");
  const firstLine =
    withoutContext
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "";
  const sentence = (firstLine.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? firstLine)
    .replace(/^(hi|hey|hello|ok|okay|so|please)[,!.\s]+/i, "")
    .trim();
  if (sentence.length < 3) return null;
  return clip(sentence, GOAL_MAX);
};

/** Newest first, one entry per path; editing outranks reading for the same path. */
export const recordFile = (
  files: ReadonlyArray<LedgerFile>,
  file: LedgerFile,
  max = MAX_FILES,
): ReadonlyArray<LedgerFile> => {
  const previous = files.find((existing) => existing.path === file.path);
  const keepEditing =
    previous !== undefined &&
    previous.activity === "editing" &&
    file.activity !== "editing" &&
    file.atMs - previous.atMs < 10 * 60_000;
  const next: LedgerFile = keepEditing ? { ...file, activity: "editing" } : file;
  return [next, ...files.filter((existing) => existing.path !== file.path)].slice(0, max);
};

export const addMember = (
  members: ReadonlyArray<LedgerPerson>,
  person: LedgerPerson,
): ReadonlyArray<LedgerPerson> =>
  members.some((member) => member.id === person.id) ? members : [...members, person];

const lower = (text: string) => text.toLowerCase();
const basename = (path: string) => path.split("/").pop() ?? path;

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "what",
  "who",
  "working",
  "work",
  "works",
  "is",
  "on",
  "anyone",
  "someone",
  "page",
]);

const topicWords = (query: string) =>
  lower(query)
    .split(/[^a-z0-9_.-]+/)
    .filter((word) => word.length >= 3 && !STOPWORDS.has(word));

/** A person named `name`: their display name, its first word, or an email's local part. */
export const nameMatches = (candidate: string, name: string): boolean => {
  const wanted = lower(name.trim());
  if (wanted.length === 0) return false;
  const have = lower(candidate.trim());
  return (
    have === wanted ||
    have.split(/\s+/)[0] === wanted ||
    wanted.split(/\s+/)[0] === have ||
    have === wanted.split("@")[0]
  );
};

export interface WhoMatch {
  readonly thread: LedgerThread;
  readonly why: "person" | "file" | "topic";
}

/**
 * "Who is working on X": X is a person (their threads), a file (threads that
 * touched it), or a topic (threads whose goal or title mention it). Most recent
 * activity first.
 */
export const whoIsWorkingOn = (
  threads: ReadonlyArray<LedgerThread>,
  query: string,
): ReadonlyArray<WhoMatch> => {
  const trimmed = query.trim();
  if (trimmed.length === 0) return [];
  const byRecent = [...threads].sort((a, b) => b.lastActiveAtMs - a.lastActiveAtMs);
  const people = byRecent.filter((thread) =>
    thread.members.some((member) => nameMatches(member.name, trimmed)),
  );
  if (people.length > 0) return people.map((thread) => ({ thread, why: "person" as const }));
  const needle = lower(trimmed);
  const files = byRecent.filter((thread) =>
    thread.files.some(
      (file) =>
        lower(file.path) === needle ||
        lower(basename(file.path)) === needle ||
        (needle.includes("/") || needle.includes(".")
          ? lower(file.path).includes(needle)
          : lower(basename(file.path)).startsWith(needle)),
    ),
  );
  if (files.length > 0) return files.map((thread) => ({ thread, why: "file" as const }));
  const words = topicWords(trimmed);
  if (words.length === 0) return [];
  return byRecent
    .filter((thread) => {
      const haystack = lower(
        `${thread.title} ${thread.goal ?? ""} ${thread.files.map((file) => file.path).join(" ")}`,
      );
      return words.every((word) => haystack.includes(word));
    })
    .map((thread) => ({ thread, why: "topic" as const }));
};

export type TargetResolution =
  | { readonly kind: "thread"; readonly thread: LedgerThread }
  | { readonly kind: "none"; readonly message: string };

/**
 * Where "tell Ali ..." goes: an exact thread id, else that person's most
 * recently active thread other than the sender's.
 */
export const resolveTarget = (
  threads: ReadonlyArray<LedgerThread>,
  target: string,
  fromThreadId: string | null,
): TargetResolution => {
  const trimmed = target.trim();
  const exact = threads.find((thread) => thread.threadId === trimmed);
  if (exact !== undefined) return { kind: "thread", thread: exact };
  const candidates = threads
    .filter(
      (thread) =>
        thread.threadId !== fromThreadId &&
        thread.members.some((member) => nameMatches(member.name, trimmed)),
    )
    .sort((a, b) => b.lastActiveAtMs - a.lastActiveAtMs);
  const best = candidates[0];
  if (best !== undefined) return { kind: "thread", thread: best };
  const names = Array.from(
    new Set(threads.flatMap((thread) => thread.members.map((member) => member.name))),
  );
  return {
    kind: "none",
    message:
      names.length === 0
        ? `Nobody else has a thread in this project yet.`
        : `No thread for "${trimmed}". People with threads here: ${names.join(", ")}.`,
  };
};

/**
 * The threads a conflict on `files` touches: those whose recent files include
 * one of them, plus the threads of the person whose pushed commits collide
 * (`theirsAuthor`, by name or email). When nothing matches, every thread active
 * in the last hour hears about it, so a conflict is never silent.
 */
export const conflictParties = (input: {
  readonly threads: ReadonlyArray<LedgerThread>;
  readonly files: ReadonlyArray<string>;
  readonly theirsAuthor: string | null;
  readonly nowMs: number;
}): ReadonlyArray<LedgerThread> => {
  const wanted = new Set(input.files);
  const byFiles = input.threads.filter((thread) =>
    thread.files.some((file) => wanted.has(file.path)),
  );
  const author = input.theirsAuthor;
  const byAuthor =
    author === null
      ? []
      : input.threads.filter((thread) =>
          thread.members.some((member) => nameMatches(member.name, author)),
        );
  const chosen = new Map<string, LedgerThread>();
  for (const thread of [...byFiles, ...byAuthor]) chosen.set(thread.threadId, thread);
  if (chosen.size > 0) return Array.from(chosen.values());
  return input.threads.filter((thread) => input.nowMs - thread.lastActiveAtMs < 60 * 60_000);
};

const ownerName = (thread: LedgerThread) => thread.members[0]?.name ?? "Someone";

const ago = (atMs: number, nowMs: number) => {
  const minutes = Math.max(0, Math.floor((nowMs - atMs) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
};

/** One line an agent or a popover reads: who, which thread, goal, files, branch. */
export const describeThread = (thread: LedgerThread, nowMs: number): string => {
  const people = thread.members.map((member) => member.name).join(", ") || ownerName(thread);
  const goal = thread.goal === null ? "" : `; goal: ${thread.goal}`;
  const files =
    thread.files.length === 0
      ? ""
      : `; files: ${thread.files
          .slice(0, 4)
          .map((file) => `${file.path} (${file.activity})`)
          .join(", ")}`;
  const branch = thread.branch === null ? "" : `; branch ${thread.branch}`;
  return `${people} in "${clip(thread.title, 60)}" [thread ${thread.threadId}] ${thread.status}, ${ago(thread.lastActiveAtMs, nowMs)}${goal}${files}${branch}`;
};

export const describeConflict = (conflict: LedgerConflict): string =>
  `conflict ${conflict.id} (${conflict.source}, ${conflict.state}): ${conflict.files.join(", ") || "files"}; ${conflict.people.join(" and ") || "teammates"}; ${conflict.reason}`;

export interface TurnContextInput {
  readonly ownThreadId: string;
  readonly projectTitle: string | null;
  readonly threads: ReadonlyArray<LedgerThread>;
  /** Messages to this thread not yet handed to its agent. */
  readonly inbox: ReadonlyArray<LedgerMessage>;
  readonly conflicts: ReadonlyArray<LedgerConflict>;
  readonly decisions: ReadonlyArray<LedgerDecision>;
  /** Lines from negotiations this thread is part of. */
  readonly negotiationLines: ReadonlyArray<string>;
  /** Goal milestones assigned to this thread and drafts it planned (goals.ts). */
  readonly goalLines?: ReadonlyArray<string> | undefined;
  readonly nowMs: number;
}

const MAX_CONTEXT_THREADS = 6;

/**
 * The short live summary added to each turn. Empty when the thread is alone
 * with nothing waiting, so solo projects and replays see no change.
 */
export const turnContextText = (input: TurnContextInput): string => {
  const others = input.threads
    .filter((thread) => thread.threadId !== input.ownThreadId)
    .filter((thread) => input.nowMs - thread.lastActiveAtMs < 24 * 60 * 60_000)
    .sort((a, b) => b.lastActiveAtMs - a.lastActiveAtMs)
    .slice(0, MAX_CONTEXT_THREADS);
  const conflicts = input.conflicts.filter(
    (conflict) =>
      conflict.state !== "resolved" &&
      conflict.parties.some((party) => party.threadId === input.ownThreadId),
  );
  const goalLines = input.goalLines ?? [];
  if (
    others.length === 0 &&
    input.inbox.length === 0 &&
    conflicts.length === 0 &&
    input.negotiationLines.length === 0 &&
    goalLines.length === 0
  ) {
    return "";
  }
  const lines: string[] = [
    `<logicpacks_project>`,
    `Live ledger of ${input.projectTitle === null ? "this project" : `"${clip(input.projectTitle, 60)}"`} (other threads, messages, conflicts). Answer questions about teammates from it or lp_project_who_is_working_on; do not start work someone else is on without telling the user.`,
  ];
  if (others.length > 0) {
    lines.push("Other threads:");
    for (const thread of others) lines.push(`- ${describeThread(thread, input.nowMs)}`);
  }
  for (const message of input.inbox) {
    const from =
      message.fromThreadId === null
        ? message.fromName
        : `${message.fromName} [thread ${message.fromThreadId}]`;
    lines.push(
      `Message ${message.id} (${message.kind}) from ${from}: "${clip(message.text, 400)}"${
        message.fromThreadId === null || message.kind === "notice"
          ? ""
          : ` Tell the user, then reply with lp_project_send_to_thread to "${message.fromThreadId}" with replyTo "${message.id}".`
      }`,
    );
  }
  for (const conflict of conflicts) lines.push(`Open ${describeConflict(conflict)}`);
  for (const line of input.negotiationLines) lines.push(line);
  for (const line of goalLines) lines.push(line);
  const decisions = input.decisions.slice(-3);
  if (decisions.length > 0) {
    lines.push("Recent decisions:");
    for (const decision of decisions)
      lines.push(
        `- ${clip(decision.text, 200)} (${decision.by}, ${ago(decision.atMs, input.nowMs)})`,
      );
  }
  lines.push(`</logicpacks_project>`);
  return lines.join("\n");
};
