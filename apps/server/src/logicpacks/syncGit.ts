import * as Effect from "effect/Effect";

/**
 * The git half of LogicPacks sync over an injected runner. Every checkout runs the
 * same tick (save, fetch, rebase, push); a conflicting rebase is aborted, so the
 * syncer never leaves a checkout half-merged, and is reported until resolved.
 */

export interface GitRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs `git <args>` in the checkout. Must not fail on a non-zero exit. */
export type GitRunner = (args: ReadonlyArray<string>) => Effect.Effect<GitRun>;

export const SYNC_REMOTE = "origin";

/** Used only when the checkout has no git identity, as on a fresh cloud host. */
export const SYNC_IDENTITY = { name: "LogicPacks", email: "sync@logicpacks.io" } as const;

export type TickState = "synced" | "conflict" | "error" | "busy";

export interface TickResult {
  readonly state: TickState;
  readonly branch: string | null;
  readonly ahead: number;
  readonly behind: number;
  readonly conflictFiles: ReadonlyArray<string>;
  /** Who made the commits that conflict with ours, when known. */
  readonly theirsAuthor: string | null;
  readonly committed: boolean;
  readonly pulled: number;
  readonly pushed: number;
  readonly message: string | null;
}

const lines = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

const firstLine = (run: GitRun) =>
  (lines(run.stderr)[0] ?? lines(run.stdout)[0] ?? `git exited with ${run.code}`).slice(0, 300);

/** Commits as the checkout's own identity, or as LogicPacks when it has none. */
export const identityArgs = Effect.fn("logicpacks.sync.identityArgs")(function* (git: GitRunner) {
  const email = yield* git(["config", "user.email"]);
  return email.code === 0 && email.stdout.trim().length > 0
    ? []
    : ["-c", `user.name=${SYNC_IDENTITY.name}`, "-c", `user.email=${SYNC_IDENTITY.email}`];
});

export const currentBranch = Effect.fn("logicpacks.sync.currentBranch")(function* (git: GitRunner) {
  const result = yield* git(["symbolic-ref", "--quiet", "--short", "HEAD"]);
  return result.code === 0 ? result.stdout.trim() || null : null;
});

export const remoteUrl = Effect.fn("logicpacks.sync.remoteUrl")(function* (git: GitRunner) {
  const result = yield* git(["remote", "get-url", SYNC_REMOTE]);
  return result.code === 0 ? result.stdout.trim() || null : null;
});

export const isRepository = Effect.fn("logicpacks.sync.isRepository")(function* (git: GitRunner) {
  const result = yield* git(["rev-parse", "--is-inside-work-tree"]);
  return result.code === 0 && result.stdout.trim() === "true";
});

export const hasCommits = Effect.fn("logicpacks.sync.hasCommits")(function* (git: GitRunner) {
  return (yield* git(["rev-parse", "--verify", "--quiet", "HEAD"])).code === 0;
});

export const unmergedFiles = Effect.fn("logicpacks.sync.unmergedFiles")(function* (git: GitRunner) {
  return lines((yield* git(["diff", "--name-only", "--diff-filter=U"])).stdout);
});

const isDirty = Effect.fn("logicpacks.sync.isDirty")(function* (git: GitRunner) {
  return (
    lines((yield* git(["status", "--porcelain", "--untracked-files=normal"])).stdout).length > 0
  );
});

/** Stages and commits everything. Returns whether a commit was made. */
export const commitAll = Effect.fn("logicpacks.sync.commitAll")(function* (
  git: GitRunner,
  message: string,
) {
  if (!(yield* isDirty(git))) return false;
  const add = yield* git(["add", "-A"]);
  if (add.code !== 0) return false;
  const identity = yield* identityArgs(git);
  const commit = yield* git([...identity, "commit", "--no-verify", "-q", "-m", message]);
  return commit.code === 0;
});

const counts = Effect.fn("logicpacks.sync.counts")(function* (git: GitRunner, upstream: string) {
  const result = yield* git(["rev-list", "--left-right", "--count", `HEAD...${upstream}`]);
  const [ahead, behind] = result.stdout.trim().split(/\s+/).map(Number);
  return { ahead: ahead ?? 0, behind: behind ?? 0 };
});

const refExists = Effect.fn("logicpacks.sync.refExists")(function* (git: GitRunner, ref: string) {
  return (yield* git(["rev-parse", "--verify", "--quiet", ref])).code === 0;
});

const base = (branch: string | null): TickResult => ({
  state: "synced",
  branch,
  ahead: 0,
  behind: 0,
  conflictFiles: [],
  theirsAuthor: null,
  committed: false,
  pulled: 0,
  pushed: 0,
  message: null,
});

/**
 * One sync pass over a checkout. `busy` (an agent is mid-turn in it) only
 * fetches and reports, so the syncer never moves files under a running agent.
 */
export const syncTick = Effect.fn("logicpacks.sync.tick")(function* (
  git: GitRunner,
  options: {
    /** Checked after the fetch, so a turn that starts during a slow fetch is still seen. */
    readonly busy: boolean | Effect.Effect<boolean>;
    readonly autoCommit: boolean;
    readonly commitMessage: string;
  },
) {
  const branch = yield* currentBranch(git);
  if (branch === null) {
    return { ...base(null), state: "error", message: "The checkout is not on a branch." } as const;
  }
  const upstream = `refs/remotes/${SYNC_REMOTE}/${branch}`;
  const unmerged = yield* unmergedFiles(git);
  if (unmerged.length > 0) {
    // Someone (a person or an agent) is resolving a merge or rebase here; leave it to them.
    return { ...base(branch), state: "conflict", conflictFiles: unmerged } as const;
  }

  const fetch = yield* git(["fetch", "--quiet", "--prune", SYNC_REMOTE]);
  if (fetch.code !== 0) {
    return { ...base(branch), state: "error", message: firstLine(fetch) } as const;
  }
  const busy = typeof options.busy === "boolean" ? options.busy : yield* options.busy;
  if (busy) {
    const known = yield* refExists(git, upstream);
    return {
      ...base(branch),
      state: "busy",
      ...(known ? yield* counts(git, upstream) : {}),
    } as const;
  }

  let committed = false;
  if (yield* isDirty(git)) {
    if (!options.autoCommit) {
      return {
        ...base(branch),
        state: "error",
        message: "Local changes are not committed yet.",
      } as const;
    }
    committed = yield* commitAll(git, options.commitMessage);
  }

  let pulled = 0;
  if (yield* refExists(git, upstream)) {
    const before = yield* counts(git, upstream);
    if (before.behind > 0) {
      if (before.ahead === 0) {
        const merge = yield* git(["merge", "--ff-only", "--quiet", upstream]);
        if (merge.code !== 0) {
          return {
            ...base(branch),
            ...before,
            committed,
            state: "error",
            message: firstLine(merge),
          } as const;
        }
      } else {
        const identity = yield* identityArgs(git);
        const rebase = yield* git([...identity, "rebase", "--quiet", upstream]);
        if (rebase.code !== 0) {
          const files = yield* unmergedFiles(git);
          yield* git(["rebase", "--abort"]);
          const author = yield* git(["log", "-1", "--format=%an", upstream]);
          return {
            ...base(branch),
            ...before,
            committed,
            state: files.length > 0 ? "conflict" : "error",
            conflictFiles: files,
            theirsAuthor: author.code === 0 ? author.stdout.trim() || null : null,
            message: files.length > 0 ? null : firstLine(rebase),
          } as const;
        }
      }
      pulled = before.behind;
    }
  }

  const after = (yield* refExists(git, upstream))
    ? yield* counts(git, upstream)
    : { ahead: 1, behind: 0 };
  let pushed = 0;
  if (after.ahead > 0) {
    const push = yield* git(["push", "--quiet", "-u", SYNC_REMOTE, `HEAD:refs/heads/${branch}`]);
    if (push.code !== 0) {
      return {
        ...base(branch),
        ...after,
        committed,
        pulled,
        state: "error",
        message: firstLine(push),
      } as const;
    }
    pushed = after.ahead;
  }
  return { ...base(branch), committed, pulled, pushed } as const;
});

export type ConflictStrategy = "mine" | "theirs";

/**
 * Settles a reported conflict with a merge that keeps one side's version of the
 * conflicting hunks (the rest of both sides merges as usual), then pushes.
 */
export const resolveConflict = Effect.fn("logicpacks.sync.resolveConflict")(function* (
  git: GitRunner,
  strategy: ConflictStrategy,
  message: string,
) {
  const branch = yield* currentBranch(git);
  if (branch === null) return { ok: false, message: "The checkout is not on a branch." } as const;
  const upstream = `refs/remotes/${SYNC_REMOTE}/${branch}`;
  const fetch = yield* git(["fetch", "--quiet", SYNC_REMOTE]);
  if (fetch.code !== 0) return { ok: false, message: firstLine(fetch) } as const;
  const identity = yield* identityArgs(git);
  const side = strategy === "mine" ? "ours" : "theirs";
  const merge = yield* git([
    ...identity,
    "merge",
    "--no-edit",
    "-X",
    side,
    "-m",
    message,
    upstream,
  ]);
  if (merge.code !== 0) {
    // -X only settles content conflicts; a file deleted on one side still needs a pick.
    const files = yield* unmergedFiles(git);
    if (files.length === 0) {
      yield* git(["merge", "--abort"]);
      return { ok: false, message: firstLine(merge) } as const;
    }
    yield* git(["checkout", `--${side}`, "--", ...files]);
    yield* git(["add", "-A", "--", ...files]);
    const commit = yield* git([...identity, "commit", "--no-verify", "--no-edit", "-q"]);
    if (commit.code !== 0) {
      yield* git(["merge", "--abort"]);
      return { ok: false, message: firstLine(commit) } as const;
    }
  }
  const push = yield* git(["push", "--quiet", "-u", SYNC_REMOTE, `HEAD:refs/heads/${branch}`]);
  if (push.code !== 0) return { ok: false, message: firstLine(push) } as const;
  return { ok: true, message: null } as const;
});

/** Rough intent match for "sync this to the cloud" said in a project's chat. */
export const isSyncIntent = (text: string): boolean => {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > 200) return false;
  if (/\b(don'?t|do not|never|stop|undo|unsync)\b/i.test(trimmed)) return false;
  return (
    /\b(sync|publish|push|move|upload|put|send)\b[^.?!\n]{0,30}\b(to|on|onto|into|with)\s+(the\s+)?(logicpacks\s+)?cloud\b(?!\.\w)/i.test(
      trimmed,
    ) || /^\s*(please\s+)?sync( (this|it|the project|this project))?\s*[.!]?\s*$/i.test(trimmed)
  );
};

/** A repository name for a new GitHub repo, from the project's title. */
export const repositoryNameFor = (title: string): string => {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 80);
  return slug.length > 0 ? slug : "logicpacks-project";
};
