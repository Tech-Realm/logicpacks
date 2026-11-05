import * as Effect from "effect/Effect";

/**
 * Live websockets of members. Removing a member (from a project or a workspace) cuts their data
 * access at once; this also closes the sockets they already have open, so nothing keeps streaming
 * to them, whether they connect directly or through the share relay. The client reconnects and
 * is then served with its current access.
 */
const waiters = new Map<string, Set<() => void>>();

/** Completes when this member's sockets are closed on purpose; never for the operator (null). */
export const awaitMemberSocketClose = (userId: string | null): Effect.Effect<void> =>
  userId === null
    ? Effect.never
    : Effect.callback<void>((resume) => {
        let set = waiters.get(userId);
        if (set === undefined) {
          set = new Set();
          waiters.set(userId, set);
        }
        const wake = () => resume(Effect.void);
        set.add(wake);
        return Effect.sync(() => {
          const current = waiters.get(userId);
          current?.delete(wake);
          if (current !== undefined && current.size === 0) waiters.delete(userId);
        });
      });

/** Closes every open socket of this member. Returns how many were closed. */
export const closeMemberSockets = (userId: string): number => {
  const set = waiters.get(userId);
  if (set === undefined) return 0;
  const wakes = Array.from(set);
  waiters.delete(userId);
  for (const wake of wakes) wake();
  return wakes.length;
};

export const openMemberSocketCount = (userId: string): number => waiters.get(userId)?.size ?? 0;
