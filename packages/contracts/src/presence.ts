import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

/**
 * Live presence: where each human and agent is in a project right now. Clients
 * report their own spot with `presence.update`; the server names the actor from
 * the session, so a client can never report as someone else. Entries expire on
 * idle and when the reporting connection closes.
 */
export const PRESENCE_COLOR_COUNT = 8;
/** A reporter that has not refreshed its spot within this window is gone. */
export const PRESENCE_TTL_MS = 75_000;
/** Clients refresh an unchanged spot at this interval while the user is active. */
export const PRESENCE_HEARTBEAT_MS = 30_000;
/** Cursor moves are sent at most this often per client. */
export const PRESENCE_THROTTLE_MS = 120;

export const PresenceActorKind = Schema.Literals(["human", "agent"]);
export type PresenceActorKind = typeof PresenceActorKind.Type;

/** Who reported: the web or desktop app, the LogicPacks helper beside an outside agent, or the host itself. */
export const PresenceSource = Schema.Literals(["web", "desktop", "helper", "server"]);
export type PresenceSource = typeof PresenceSource.Type;

export const PresenceView = Schema.Literals(["file", "diff", "tree", "chat", "app"]);
export type PresenceView = typeof PresenceView.Type;

export const PresenceActivity = Schema.Literals(["viewing", "reading", "editing", "reviewing"]);
export type PresenceActivity = typeof PresenceActivity.Type;

/** One-based line, zero-based column. */
export const PresencePosition = Schema.Struct({
  line: PositiveInt,
  column: NonNegativeInt,
});
export type PresencePosition = typeof PresencePosition.Type;

/** An item inside an app recipe, such as a Blender object or a Resolve clip. */
export const PresenceAppItem = Schema.Struct({
  recipeId: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  itemId: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
  label: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
});
export type PresenceAppItem = typeof PresenceAppItem.Type;

/** A spot over an app's live view, as fractions of its width and height (0 to 1). */
const PresenceFraction = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }));
export const PresencePointer = Schema.Struct({ x: PresenceFraction, y: PresenceFraction });
export type PresencePointer = typeof PresencePointer.Type;

export const PresenceLocation = Schema.Struct({
  view: PresenceView,
  activity: PresenceActivity,
  /** Relative to the project root, with forward slashes. Absent when not in a file. */
  path: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(1024))),
  /** The caret; `anchor` differs from it while text is selected. */
  cursor: Schema.optional(PresencePosition),
  anchor: Schema.optional(PresencePosition),
  appItem: Schema.optional(PresenceAppItem),
  /** The pointer over an app's live view (view "app"): the app's own cursor. */
  pointer: Schema.optional(PresencePointer),
});
export type PresenceLocation = typeof PresenceLocation.Type;

/**
 * Report this client's spot. One of `projectId` or `threadId` places it; the
 * server resolves a thread to its project. `location: null` leaves.
 */
export const PresenceUpdateInput = Schema.Struct({
  /** Stable per tab or per outside agent session; one spot per client. */
  clientId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  source: PresenceSource,
  projectId: Schema.optional(ProjectId),
  threadId: Schema.optional(ThreadId),
  /** Only the helper reports for an agent: the session's own outside Claude Code or Codex. */
  actorKind: Schema.optional(PresenceActorKind),
  /** Shown after the owner's name for agents, e.g. "Claude Code". */
  agentLabel: Schema.optional(Schema.String.check(Schema.isMaxLength(64))),
  location: Schema.NullOr(PresenceLocation),
});
export type PresenceUpdateInput = typeof PresenceUpdateInput.Type;

export const PresenceActor = Schema.Struct({
  /** Same person or agent across tabs and devices; avatar stacks group by it. */
  id: TrimmedNonEmptyString,
  kind: PresenceActorKind,
  name: Schema.String,
  /** Index into the theme's presence palette (`--presence-0` ...). */
  colorIndex: NonNegativeInt,
});
export type PresenceActor = typeof PresenceActor.Type;

export const PresenceEntry = Schema.Struct({
  key: TrimmedNonEmptyString,
  clientId: TrimmedNonEmptyString,
  projectId: ProjectId,
  threadId: Schema.optional(ThreadId),
  actor: PresenceActor,
  source: PresenceSource,
  location: PresenceLocation,
  since: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type PresenceEntry = typeof PresenceEntry.Type;

export const PresenceSubscribeInput = Schema.Struct({
  /** Omit for every project this session can see. */
  projectId: Schema.optional(ProjectId),
});
export type PresenceSubscribeInput = typeof PresenceSubscribeInput.Type;

export const PresenceStreamEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("snapshot"), entries: Schema.Array(PresenceEntry) }),
  Schema.Struct({ type: Schema.Literal("upsert"), entry: PresenceEntry }),
  Schema.Struct({ type: Schema.Literal("remove"), key: TrimmedNonEmptyString }),
]);
export type PresenceStreamEvent = typeof PresenceStreamEvent.Type;

export const applyPresenceStreamEvent = (
  entries: ReadonlyMap<string, PresenceEntry>,
  event: PresenceStreamEvent,
): ReadonlyMap<string, PresenceEntry> => {
  switch (event.type) {
    case "snapshot":
      return new Map(event.entries.map((entry) => [entry.key, entry]));
    case "upsert": {
      const next = new Map(entries);
      next.set(event.entry.key, event.entry);
      return next;
    }
    case "remove": {
      if (!entries.has(event.key)) return entries;
      const next = new Map(entries);
      next.delete(event.key);
      return next;
    }
  }
};
