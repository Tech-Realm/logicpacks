/**
 * The semantic op log an app recipe records: who changed which property of
 * which object, so separate work merges back with every disagreement named.
 * The merge itself lives in `@logicpacks/shared/recipes/opLog`.
 */
import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
export const RecipeActorKind = Schema.Literals(["human", "agent"]);
export type RecipeActorKind = typeof RecipeActorKind.Type;

export const RecipeActor = Schema.Struct({
  kind: RecipeActorKind,
  id: TrimmedNonEmptyString,
  name: Schema.optional(Schema.String),
});
export type RecipeActor = typeof RecipeActor.Type;

export const RecipeOpKind = Schema.Literals(["object.add", "object.set", "object.remove"]);
export type RecipeOpKind = typeof RecipeOpKind.Type;

/**
 * One semantic change. Objects are addressed by a stable id the adapter stamps
 * on them (Blender: the `lp_id` custom property), never by name, because a
 * rename is itself an edit two people can disagree about.
 */
export const RecipeOp = Schema.Struct({
  id: TrimmedNonEmptyString,
  seq: NonNegativeInt,
  at: IsoDateTime,
  actor: RecipeActor,
  kind: RecipeOpKind,
  objectId: TrimmedNonEmptyString,
  /** The object's name when the op was recorded, for people reading the log. */
  name: Schema.optional(Schema.String),
  objectType: Schema.optional(Schema.String),
  property: Schema.optional(Schema.String),
  value: Schema.optional(Schema.Unknown),
  previous: Schema.optional(Schema.Unknown),
});
export type RecipeOp = typeof RecipeOp.Type;

export const RecipeConflictKind = Schema.Literals([
  "property",
  "remove-vs-modify",
  "name-collision",
]);
export type RecipeConflictKind = typeof RecipeConflictKind.Type;

export const RecipeConflict = Schema.Struct({
  kind: RecipeConflictKind,
  objectId: TrimmedNonEmptyString,
  objectName: Schema.optional(Schema.String),
  property: Schema.optional(Schema.String),
  base: Schema.optional(Schema.Unknown),
  ours: Schema.optional(Schema.Unknown),
  theirs: Schema.optional(Schema.Unknown),
  oursActor: Schema.optional(RecipeActor),
  theirsActor: Schema.optional(RecipeActor),
});
export type RecipeConflict = typeof RecipeConflict.Type;

export const RecipeMergeReport = Schema.Struct({
  at: IsoDateTime,
  from: TrimmedNonEmptyString,
  into: TrimmedNonEmptyString,
  baseOps: NonNegativeInt,
  applied: NonNegativeInt,
  conflicts: Schema.Array(RecipeConflict),
});
export type RecipeMergeReport = typeof RecipeMergeReport.Type;
