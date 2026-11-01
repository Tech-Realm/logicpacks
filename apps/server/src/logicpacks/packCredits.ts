/**
 * Who gets credit when a pack is published or reused. Credits are stored as activity rows
 * unique per kind, participant and subject, so recording twice never counts twice. Packs
 * name authors only by display name, so the host remembers the author from the publish.
 */

/** Server-recorded kinds. Callers cannot report these, so nobody can award them to themselves. */
export type PackActivityKind =
  | "recipe.published"
  | "recipe.reused"
  | "pack.reused_by_teammate"
  | "pack.reuse_received";

export interface PackCredit {
  readonly participantId: string;
  readonly kind: PackActivityKind;
  readonly subject: string;
}

export const packKey = (pack: {
  readonly id: string;
  readonly context?: { readonly source: { readonly savedAt: string } } | undefined;
}): string => (pack.context === undefined ? pack.id : `${pack.id}@${pack.context.source.savedAt}`);

export const publishedSubject = (key: string) => `pack:${key}`;

export const publishCredits = (authorId: string, key: string): ReadonlyArray<PackCredit> => [
  { participantId: authorId, kind: "recipe.published", subject: publishedSubject(key) },
];

/**
 * A reuse counts for the person reusing it (they reused a teammate's work) and for the
 * author (a teammate reused theirs). Reusing your own pack earns nothing. A pack whose
 * author the host never saw publish (made before this, or on another host) still counts
 * for the person reusing it.
 */
export const reuseCredits = (input: {
  readonly authorId: string | null;
  readonly reuserId: string;
  readonly key: string;
  /** Unique per use, so every reuse counts once. */
  readonly useId: string;
}): ReadonlyArray<PackCredit> => {
  if (input.authorId === input.reuserId) return [];
  const reused: PackCredit = {
    participantId: input.reuserId,
    kind: "recipe.reused",
    subject: `pack:${input.key}:use:${input.useId}`,
  };
  if (input.authorId === null) return [reused];
  return [
    reused,
    {
      participantId: input.authorId,
      kind: "pack.reused_by_teammate",
      subject: `pack:${input.key}:by:${input.reuserId}`,
    },
    {
      participantId: input.authorId,
      kind: "pack.reuse_received",
      subject: `pack:${input.key}:use:${input.useId}`,
    },
  ];
};
