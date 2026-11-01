import type { RecipeActor, RecipeOp } from "@logicpacks/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  commonRecipeOpPrefix,
  describeRecipeOp,
  groupRecipeTurns,
  mergeRecipeOpLogs,
  parseRecipeOpLog,
  recipeValuesEqual,
  replayRecipeOps,
  summariseRecipeParticipants,
} from "./opLog.ts";

const human: RecipeActor = { kind: "human", id: "sara", name: "Sara" };
const agentA: RecipeActor = { kind: "agent", id: "agent-a" };
const agentB: RecipeActor = { kind: "agent", id: "agent-b" };

let counter = 0;
function op(partial: Omit<RecipeOp, "id" | "seq" | "at"> & { id?: string }): RecipeOp {
  counter += 1;
  return {
    id: partial.id ?? `op-${counter}`,
    seq: counter,
    at: `2026-10-31T12:${String(Math.floor(counter / 60)).padStart(2, "0")}:${String(counter % 60).padStart(2, "0")}.000Z`,
    ...partial,
  };
}

const cubeProps = { name: "Cube", location: [0, 0, 0], scale: [1, 1, 1], hide_viewport: false };

/** A base where a cube and a light exist, shared by both branches. */
function base(): RecipeOp[] {
  return [
    op({
      id: "b1",
      actor: human,
      kind: "object.add",
      objectId: "cube",
      objectType: "MESH",
      value: cubeProps,
    }),
    op({
      id: "b2",
      actor: human,
      kind: "object.add",
      objectId: "light",
      objectType: "LIGHT",
      value: { name: "Light", location: [4, 1, 6], "light.energy": 1000 },
    }),
  ];
}

describe("replayRecipeOps", () => {
  it("applies adds, sets and removes in order", () => {
    const scene = replayRecipeOps([
      ...base(),
      op({
        actor: agentA,
        kind: "object.set",
        objectId: "cube",
        property: "location",
        value: [1, 2, 3],
      }),
      op({ actor: agentA, kind: "object.remove", objectId: "light" }),
    ]);
    expect([...scene.keys()]).toEqual(["cube"]);
    expect(scene.get("cube")?.props.location).toEqual([1, 2, 3]);
    expect(scene.get("cube")?.objectType).toBe("MESH");
  });

  it("ignores a set on an object that is gone", () => {
    const scene = replayRecipeOps([
      op({ actor: agentA, kind: "object.set", objectId: "ghost", property: "name", value: "x" }),
    ]);
    expect(scene.size).toBe(0);
  });
});

describe("recipeValuesEqual", () => {
  it("forgives float noise but not real moves", () => {
    expect(recipeValuesEqual([1, 2.00001, 3], [1, 2, 3])).toBe(true);
    expect(recipeValuesEqual([1, 2.1, 3], [1, 2, 3])).toBe(false);
    expect(recipeValuesEqual(null, undefined)).toBe(true);
    expect(recipeValuesEqual({ a: [1] }, { a: [1] })).toBe(true);
  });
});

describe("mergeRecipeOpLogs", () => {
  it("finds the shared prefix as the base", () => {
    const shared = base();
    const ours = [...shared, op({ actor: agentA, kind: "object.remove", objectId: "light" })];
    const theirs = [...shared, op({ actor: agentB, kind: "object.remove", objectId: "cube" })];
    expect(commonRecipeOpPrefix(ours, theirs)).toBe(2);
  });

  it("takes non-overlapping property edits from both sides without conflict", () => {
    const shared = base();
    const ours = [
      ...shared,
      op({
        actor: agentA,
        kind: "object.set",
        objectId: "cube",
        property: "location",
        value: [2, 0, 0],
      }),
    ];
    const theirs = [
      ...shared,
      op({
        actor: agentB,
        kind: "object.set",
        objectId: "cube",
        property: "scale",
        value: [3, 3, 3],
      }),
      op({
        actor: agentB,
        kind: "object.set",
        objectId: "light",
        property: "light.energy",
        value: 50,
      }),
    ];
    const result = mergeRecipeOpLogs(ours, theirs);
    expect(result.baseOps).toBe(2);
    expect(result.conflicts).toEqual([]);
    expect(result.apply.map((draft) => [draft.objectId, draft.property, draft.value])).toEqual([
      ["cube", "scale", [3, 3, 3]],
      ["light", "light.energy", 50],
    ]);
    expect(result.apply.every((draft) => draft.actor.id === "agent-b")).toBe(true);
    expect(result.merged.get("cube")?.props).toMatchObject({
      location: [2, 0, 0],
      scale: [3, 3, 3],
    });
  });

  it("reports a property both sides changed differently and keeps ours", () => {
    const shared = base();
    const ours = [
      ...shared,
      op({
        actor: agentA,
        kind: "object.set",
        objectId: "cube",
        property: "location",
        value: [5, 0, 0],
      }),
    ];
    const theirs = [
      ...shared,
      op({
        actor: agentB,
        kind: "object.set",
        objectId: "cube",
        property: "location",
        value: [0, 5, 0],
      }),
    ];
    const result = mergeRecipeOpLogs(ours, theirs);
    expect(result.apply).toEqual([]);
    expect(result.conflicts).toEqual([
      {
        kind: "property",
        objectId: "cube",
        objectName: "Cube",
        property: "location",
        base: [0, 0, 0],
        ours: [5, 0, 0],
        theirs: [0, 5, 0],
        oursActor: agentA,
        theirsActor: agentB,
      },
    ]);
    expect(result.merged.get("cube")?.props.location).toEqual([5, 0, 0]);
  });

  it("treats the same change on both sides as agreement", () => {
    const shared = base();
    const move = {
      kind: "object.set" as const,
      objectId: "cube",
      property: "location",
      value: [1, 1, 1],
    };
    const result = mergeRecipeOpLogs(
      [...shared, op({ actor: agentA, ...move })],
      [...shared, op({ actor: agentB, ...move })],
    );
    expect(result.conflicts).toEqual([]);
    expect(result.apply).toEqual([]);
  });

  it("brings over objects only they added", () => {
    const shared = base();
    const theirs = [
      ...shared,
      op({
        actor: agentB,
        kind: "object.add",
        objectId: "cam",
        objectType: "CAMERA",
        value: { name: "Camera", location: [0, -8, 2] },
      }),
    ];
    const result = mergeRecipeOpLogs(shared, theirs);
    expect(result.conflicts).toEqual([]);
    expect(result.apply).toEqual([
      {
        kind: "object.add",
        objectId: "cam",
        name: "Camera",
        objectType: "CAMERA",
        value: { name: "Camera", location: [0, -8, 2] },
        actor: agentB,
      },
    ]);
  });

  it("flags two different new objects that would share a name", () => {
    const shared = base();
    const ours = [
      ...shared,
      op({
        actor: agentA,
        kind: "object.add",
        objectId: "tree-a",
        objectType: "MESH",
        value: { name: "Tree" },
      }),
    ];
    const theirs = [
      ...shared,
      op({
        actor: agentB,
        kind: "object.add",
        objectId: "tree-b",
        objectType: "MESH",
        value: { name: "Tree" },
      }),
    ];
    const result = mergeRecipeOpLogs(ours, theirs);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toMatchObject({
      kind: "name-collision",
      objectId: "tree-b",
      objectName: "Tree",
      ours: "tree-a",
      theirs: "tree-b",
    });
    // Still added: nothing is lost, the person just has to rename one.
    expect(result.apply.map((draft) => draft.objectId)).toEqual(["tree-b"]);
  });

  it("applies their removal of an object we left alone", () => {
    const shared = base();
    const result = mergeRecipeOpLogs(shared, [
      ...shared,
      op({ actor: agentB, kind: "object.remove", objectId: "light" }),
    ]);
    expect(result.conflicts).toEqual([]);
    expect(result.apply).toEqual([
      { kind: "object.remove", objectId: "light", name: "Light", actor: agentB },
    ]);
    expect(result.merged.has("light")).toBe(false);
  });

  it("reports removal on one side against an edit on the other, both ways", () => {
    const shared = base();
    const removeOurs = mergeRecipeOpLogs(
      [...shared, op({ actor: agentA, kind: "object.remove", objectId: "cube" })],
      [
        ...shared,
        op({
          actor: agentB,
          kind: "object.set",
          objectId: "cube",
          property: "name",
          value: "Hero",
        }),
      ],
    );
    expect(removeOurs.conflicts).toMatchObject([
      { kind: "remove-vs-modify", objectId: "cube", ours: null, theirsActor: agentB },
    ]);
    expect(removeOurs.apply).toEqual([]);

    const removeTheirs = mergeRecipeOpLogs(
      [
        ...shared,
        op({
          actor: agentA,
          kind: "object.set",
          objectId: "cube",
          property: "scale",
          value: [2, 2, 2],
        }),
      ],
      [...shared, op({ actor: agentB, kind: "object.remove", objectId: "cube" })],
    );
    expect(removeTheirs.conflicts).toMatchObject([
      { kind: "remove-vs-modify", objectId: "cube", theirs: null, oursActor: agentA },
    ]);
    expect(removeTheirs.merged.has("cube")).toBe(true);
  });

  it("is a no-op for identical logs", () => {
    const shared = base();
    const result = mergeRecipeOpLogs(shared, shared);
    expect(result.baseOps).toBe(2);
    expect(result.apply).toEqual([]);
    expect(result.conflicts).toEqual([]);
  });
});

describe("reading a log", () => {
  it("groups consecutive ops by actor into turns", () => {
    const ops = [
      op({ actor: human, kind: "object.add", objectId: "a", value: { name: "A" } }),
      op({ actor: human, kind: "object.set", objectId: "a", property: "name", value: "B" }),
      op({ actor: agentA, kind: "object.remove", objectId: "a" }),
      op({ actor: human, kind: "object.add", objectId: "c", value: { name: "C" } }),
    ];
    const turns = groupRecipeTurns(ops);
    expect(turns.map((turn) => [turn.actor.id, turn.ops])).toEqual([
      ["sara", 2],
      ["agent-a", 1],
      ["sara", 1],
    ]);
    const participants = summariseRecipeParticipants(ops);
    expect(participants[0]).toMatchObject({ actor: human, ops: 3, objects: 2 });
    expect(participants[1]).toMatchObject({ actor: agentA, ops: 1 });
  });

  it("describes ops in plain words", () => {
    expect(
      describeRecipeOp(
        op({
          actor: human,
          kind: "object.set",
          objectId: "a",
          name: "Cube",
          property: "location",
          value: [1, 2.123456, 0],
        }),
      ),
    ).toBe("Sara set Cube.location to (1, 2.123, 0)");
    expect(
      describeRecipeOp(
        op({ actor: agentA, kind: "object.add", objectId: "a", name: "Cam", objectType: "CAMERA" }),
      ),
    ).toBe("Agent (agent-a) added camera Cam");
  });

  it("keeps every whole line of a log with a torn tail", () => {
    const good = op({ actor: human, kind: "object.remove", objectId: "a" });
    const text = `${JSON.stringify(good)}\n{"id":"torn","seq":`;
    expect(parseRecipeOpLog(text)).toEqual([good]);
  });
});
