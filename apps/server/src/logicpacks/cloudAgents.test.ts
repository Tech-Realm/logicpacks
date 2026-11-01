import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { cloudLoginGate } from "./cloudAgents.ts";
import { FeatureAccess } from "./FeatureAccess.ts";

const MIA = { userId: "user-mia", email: "mia@example.com" };

const features = (unlocked: ReadonlyArray<string>, isCloudHost = true) =>
  Layer.succeed(FeatureAccess, {
    isCloudHost,
    has: (subject: { readonly kind: string; readonly email?: string | null }, feature: string) =>
      subject.kind === "operator" ||
      (feature === "cloud" && unlocked.includes(subject.email ?? "")),
    adoptGrant: () => Effect.succeed(false),
  } as unknown as FeatureAccess["Service"]);

const statusOf = (response: unknown) =>
  (response as { readonly status: number } | null)?.status ?? null;

describe("cloud login gate", () => {
  it.effect("locks a cloud login for a member without cloud", () =>
    Effect.gen(function* () {
      expect(statusOf(yield* cloudLoginGate(MIA, "claude"))).toBe(403);
    }).pipe(Effect.provide(features([]))),
  );

  it.effect("lets a member with cloud store a cloud login", () =>
    Effect.gen(function* () {
      expect(yield* cloudLoginGate(MIA, "codex")).toBeNull();
    }).pipe(Effect.provide(features([MIA.email]))),
  );

  it.effect("never stores logins on a laptop host, code or not", () =>
    Effect.gen(function* () {
      expect(statusOf(yield* cloudLoginGate(MIA, "claude"))).toBe(403);
    }).pipe(Effect.provide(features([MIA.email], false))),
  );
});
