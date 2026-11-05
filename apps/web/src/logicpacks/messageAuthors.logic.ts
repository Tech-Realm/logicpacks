export interface LpMessageAuthor {
  readonly userId: string | null;
  readonly name: string;
  readonly color: number;
}

export type LpMessageAuthors = Readonly<Record<string, LpMessageAuthor>>;

export interface LpNametag {
  readonly userId: string | null;
  readonly name: string;
  readonly color: number;
}

/**
 * Whether a user message shows a name tag. Unknown author: none (never a wrong one).
 * A solo thread stays clean; the tag appears when 2+ people have posted, or when the
 * author is not the viewer. `viewerUserId` is undefined until the session is known and
 * null for the host owner.
 */
export function selectNametag(input: {
  readonly authors: LpMessageAuthors;
  readonly messageId: string;
  readonly viewerUserId: string | null | undefined;
}): LpNametag | null {
  const author = input.authors[input.messageId];
  if (author === undefined) return null;
  const distinct = new Set(Object.values(input.authors).map((entry) => entry.userId));
  const multi = distinct.size >= 2;
  const other = input.viewerUserId !== undefined && author.userId !== input.viewerUserId;
  return multi || other ? { userId: author.userId, name: author.name, color: author.color } : null;
}

/** Retry waits (ms) while a message's author is not known yet; about 5 s in all. */
export const AUTHOR_RETRY_DELAYS_MS = [300, 600, 1100, 1500, 1500] as const;
