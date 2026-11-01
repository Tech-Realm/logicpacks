/**
 * The semantic op log: replay, summarise and merge. Two logs that share a prefix
 * forked from one snapshot, so the prefix is the base and each object property
 * merges three ways like a line in git. Pure, so every caller agrees.
 */
import type { RecipeActor, RecipeConflict, RecipeOp, RecipeOpKind } from "@logicpacks/contracts";

export interface RecipeObjectState {
  readonly objectType: string | undefined;
  readonly props: Readonly<Record<string, unknown>>;
}

export type RecipeSceneState = ReadonlyMap<string, RecipeObjectState>;

/** An op to apply, before the adapter assigns it a sequence number and time. */
export interface RecipeOpDraft {
  readonly kind: RecipeOpKind;
  readonly objectId: string;
  readonly name?: string;
  readonly objectType?: string;
  readonly property?: string;
  readonly value?: unknown;
  readonly actor: RecipeActor;
}

const FLOAT_TOLERANCE = 1e-4;

/** Structural equality that forgives float noise from a round trip through Blender. */
export function recipeValuesEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left === "number" && typeof right === "number") {
    return Math.abs(left - right) <= FLOAT_TOLERANCE;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((item, index) => recipeValuesEqual(item, right[index]))
    );
  }
  if (
    left !== null &&
    right !== null &&
    typeof left === "object" &&
    typeof right === "object" &&
    !Array.isArray(left) &&
    !Array.isArray(right)
  ) {
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const keys = new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)]);
    return [...keys].every((key) => recipeValuesEqual(leftRecord[key], rightRecord[key]));
  }
  // null and undefined both mean "not set".
  return (left ?? null) === null && (right ?? null) === null;
}

function asProps(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

export function replayRecipeOps(ops: ReadonlyArray<RecipeOp>): Map<string, RecipeObjectState> {
  const scene = new Map<string, RecipeObjectState>();
  for (const op of ops) {
    switch (op.kind) {
      case "object.add": {
        scene.set(op.objectId, { objectType: op.objectType, props: asProps(op.value) });
        break;
      }
      case "object.set": {
        const current = scene.get(op.objectId);
        if (!current || op.property === undefined) break;
        scene.set(op.objectId, {
          objectType: current.objectType,
          props: { ...current.props, [op.property]: op.value ?? null },
        });
        break;
      }
      case "object.remove": {
        scene.delete(op.objectId);
        break;
      }
    }
  }
  return scene;
}

/** How many leading ops two logs share, by op id. That prefix is the merge base. */
export function commonRecipeOpPrefix(
  ours: ReadonlyArray<RecipeOp>,
  theirs: ReadonlyArray<RecipeOp>,
): number {
  const limit = Math.min(ours.length, theirs.length);
  let index = 0;
  while (index < limit && ours[index]!.id === theirs[index]!.id) index += 1;
  return index;
}

function objectChanged(base: RecipeObjectState, next: RecipeObjectState): boolean {
  return !recipeValuesEqual(base.props, next.props);
}

function objectName(state: RecipeObjectState | undefined): string | undefined {
  const name = state?.props.name;
  return typeof name === "string" ? name : undefined;
}

/** Who last touched an object (and, when given, one property of it) in a run of ops. */
function lastActor(
  ops: ReadonlyArray<RecipeOp>,
  objectId: string,
  property?: string,
): RecipeActor | undefined {
  for (let index = ops.length - 1; index >= 0; index -= 1) {
    const op = ops[index]!;
    if (op.objectId !== objectId) continue;
    if (property === undefined || op.kind !== "object.set" || op.property === property) {
      return op.actor;
    }
  }
  return undefined;
}

export interface RecipeMergeResult {
  /** Ops shared by both logs: the base. */
  readonly baseOps: number;
  /** What to apply on top of ours to get the merged scene. */
  readonly apply: ReadonlyArray<RecipeOpDraft>;
  readonly conflicts: ReadonlyArray<RecipeConflict>;
  /** The scene after `apply`, with every conflict left as ours had it. */
  readonly merged: Map<string, RecipeObjectState>;
}

const MERGE_ACTOR_FALLBACK: RecipeActor = { kind: "agent", id: "merge" };

/**
 * Three-way merge at object and property level. Ours wins every conflict in
 * `merged` and every conflict is reported. Two objects ending up with one name
 * are reported too, because Blender would quietly rename one to `.001`.
 */
export function mergeRecipeOpLogs(
  ours: ReadonlyArray<RecipeOp>,
  theirs: ReadonlyArray<RecipeOp>,
): RecipeMergeResult {
  const baseOps = commonRecipeOpPrefix(ours, theirs);
  const base = replayRecipeOps(ours.slice(0, baseOps));
  const oursScene = replayRecipeOps(ours);
  const theirsScene = replayRecipeOps(theirs);
  const oursTail = ours.slice(baseOps);
  const theirsTail = theirs.slice(baseOps);

  const apply: RecipeOpDraft[] = [];
  const conflicts: RecipeConflict[] = [];
  const merged = new Map(oursScene);

  const ids = new Set([...base.keys(), ...oursScene.keys(), ...theirsScene.keys()]);
  for (const objectId of ids) {
    const b = base.get(objectId);
    const o = oursScene.get(objectId);
    const t = theirsScene.get(objectId);
    const theirActor = () => lastActor(theirsTail, objectId) ?? MERGE_ACTOR_FALLBACK;

    if (!b) {
      if (t && !o) {
        const name = objectName(t);
        const clash =
          name === undefined
            ? undefined
            : [...merged.entries()].find(
                ([otherId, other]) => otherId !== objectId && objectName(other) === name,
              );
        if (clash) {
          conflicts.push({
            kind: "name-collision",
            objectId,
            objectName: name,
            property: "name",
            ours: clash[0],
            theirs: objectId,
            ...withActor("oursActor", lastActor(oursTail, clash[0])),
            ...withActor("theirsActor", lastActor(theirsTail, objectId)),
          });
        }
        apply.push({
          kind: "object.add",
          objectId,
          ...(name === undefined ? {} : { name }),
          ...(t.objectType === undefined ? {} : { objectType: t.objectType }),
          value: t.props,
          actor: theirActor(),
        });
        merged.set(objectId, t);
      } else if (t && o) {
        // Both sides added an object with the same id: only possible when they
        // copied it from somewhere common. Merge its properties against nothing.
        mergeProps(objectId, { objectType: o.objectType, props: {} }, o, t);
      }
      continue;
    }

    if (!o && !t) continue;
    if (!o && t) {
      if (objectChanged(b, t)) {
        conflicts.push({
          kind: "remove-vs-modify",
          objectId,
          ...withName(objectName(t)),
          ours: null,
          theirs: t.props,
          ...withActor("oursActor", lastActor(oursTail, objectId)),
          ...withActor("theirsActor", lastActor(theirsTail, objectId)),
        });
      }
      continue;
    }
    if (o && !t) {
      if (objectChanged(b, o)) {
        conflicts.push({
          kind: "remove-vs-modify",
          objectId,
          ...withName(objectName(o)),
          ours: o.props,
          theirs: null,
          ...withActor("oursActor", lastActor(oursTail, objectId)),
          ...withActor("theirsActor", lastActor(theirsTail, objectId)),
        });
      } else {
        apply.push({
          kind: "object.remove",
          objectId,
          ...withDraftName(objectName(o)),
          actor: theirActor(),
        });
        merged.delete(objectId);
      }
      continue;
    }
    mergeProps(objectId, b, o!, t!);
  }

  return { baseOps, apply, conflicts, merged };

  function mergeProps(
    objectId: string,
    b: RecipeObjectState,
    o: RecipeObjectState,
    t: RecipeObjectState,
  ) {
    const keys = new Set([
      ...Object.keys(b.props),
      ...Object.keys(o.props),
      ...Object.keys(t.props),
    ]);
    const props: Record<string, unknown> = { ...o.props };
    for (const property of keys) {
      const bv = b.props[property];
      const ov = o.props[property];
      const tv = t.props[property];
      if (recipeValuesEqual(ov, tv) || recipeValuesEqual(tv, bv)) continue;
      if (recipeValuesEqual(ov, bv)) {
        apply.push({
          kind: "object.set",
          objectId,
          ...withDraftName(objectName(o)),
          property,
          value: tv ?? null,
          actor: lastActor(theirsTail, objectId, property) ?? MERGE_ACTOR_FALLBACK,
        });
        props[property] = tv ?? null;
        continue;
      }
      conflicts.push({
        kind: "property",
        objectId,
        ...withName(objectName(o)),
        property,
        base: bv ?? null,
        ours: ov ?? null,
        theirs: tv ?? null,
        ...withActor("oursActor", lastActor(oursTail, objectId, property)),
        ...withActor("theirsActor", lastActor(theirsTail, objectId, property)),
      });
    }
    merged.set(objectId, { objectType: o.objectType, props });
  }
}

function withName(name: string | undefined): { objectName?: string } {
  return name === undefined ? {} : { objectName: name };
}

function withDraftName(name: string | undefined): { name?: string } {
  return name === undefined ? {} : { name };
}

function withActor<K extends "oursActor" | "theirsActor">(
  key: K,
  actor: RecipeActor | undefined,
): Partial<Record<K, RecipeActor>> {
  return actor === undefined ? {} : ({ [key]: actor } as Partial<Record<K, RecipeActor>>);
}

export function recipeActorKey(actor: RecipeActor): string {
  return `${actor.kind}:${actor.id}`;
}

export function recipeActorLabel(actor: RecipeActor): string {
  if (actor.name && actor.name.trim().length > 0) return actor.name;
  return actor.kind === "human" ? `Person (${actor.id})` : `Agent (${actor.id})`;
}

export interface RecipeParticipant {
  readonly actor: RecipeActor;
  readonly ops: number;
  readonly objects: number;
  readonly lastAt: string;
}

/** Who did how much, most recently active first. */
export function summariseRecipeParticipants(ops: ReadonlyArray<RecipeOp>): RecipeParticipant[] {
  const byActor = new Map<
    string,
    { actor: RecipeActor; ops: number; objects: Set<string>; lastAt: string }
  >();
  for (const op of ops) {
    const key = recipeActorKey(op.actor);
    const entry = byActor.get(key) ?? {
      actor: op.actor,
      ops: 0,
      objects: new Set(),
      lastAt: op.at,
    };
    entry.ops += 1;
    entry.objects.add(op.objectId);
    if (op.at > entry.lastAt) entry.lastAt = op.at;
    byActor.set(key, entry);
  }
  return [...byActor.values()]
    .map((entry) => ({
      actor: entry.actor,
      ops: entry.ops,
      objects: entry.objects.size,
      lastAt: entry.lastAt,
    }))
    .sort((left, right) => right.lastAt.localeCompare(left.lastAt));
}

export interface RecipeTurn {
  readonly actor: RecipeActor;
  readonly fromSeq: number;
  readonly toSeq: number;
  readonly ops: number;
  readonly startedAt: string;
  readonly endedAt: string;
}

/** Consecutive runs of ops by one actor: who had the scene, and for how long. */
export function groupRecipeTurns(ops: ReadonlyArray<RecipeOp>): RecipeTurn[] {
  const turns: RecipeTurn[] = [];
  for (const op of ops) {
    const last = turns.at(-1);
    if (last && recipeActorKey(last.actor) === recipeActorKey(op.actor)) {
      turns[turns.length - 1] = { ...last, toSeq: op.seq, ops: last.ops + 1, endedAt: op.at };
    } else {
      turns.push({
        actor: op.actor,
        fromSeq: op.seq,
        toSeq: op.seq,
        ops: 1,
        startedAt: op.at,
        endedAt: op.at,
      });
    }
  }
  return turns;
}

/** One line per op, in plain words, for a log view or a replay caption. */
export function describeRecipeOp(op: RecipeOp): string {
  const who = recipeActorLabel(op.actor);
  const what = op.name ?? op.objectId;
  switch (op.kind) {
    case "object.add":
      return `${who} added ${op.objectType ? `${op.objectType.toLowerCase()} ` : ""}${what}`;
    case "object.remove":
      return `${who} removed ${what}`;
    case "object.set":
      return `${who} set ${what}.${op.property ?? "?"} to ${formatRecipeValue(op.value)}`;
  }
}

export function formatRecipeValue(value: unknown): string {
  if (Array.isArray(value)) {
    return `(${value.map((item) => (typeof item === "number" ? Number(item.toFixed(3)) : String(item))).join(", ")})`;
  }
  if (typeof value === "number") return String(Number(value.toFixed(3)));
  if (value === null || value === undefined) return "none";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * Parse a JSON-lines op log, skipping lines that are not ops. A torn last line
 * (the app was killed mid-write) must not hide every op before it.
 */
export function parseRecipeOpLog(text: string): RecipeOp[] {
  const ops: RecipeOp[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed = JSON.parse(trimmed) as Partial<RecipeOp>;
      if (
        typeof parsed.id === "string" &&
        typeof parsed.seq === "number" &&
        typeof parsed.objectId === "string" &&
        typeof parsed.kind === "string" &&
        parsed.actor !== undefined
      ) {
        ops.push(parsed as RecipeOp);
      }
    } catch {
      // torn or foreign line
    }
  }
  return ops;
}
