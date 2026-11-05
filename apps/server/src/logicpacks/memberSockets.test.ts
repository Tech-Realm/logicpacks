import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import { awaitMemberSocketClose, closeMemberSockets, openMemberSocketCount } from "./memberSockets.ts";

describe("member sockets", () => {
  it.effect("closing a member ends only that member's open sockets", () =>
    Effect.gen(function* () {
      const a1 = yield* Effect.forkChild(awaitMemberSocketClose("user-a"));
      const a2 = yield* Effect.forkChild(awaitMemberSocketClose("user-a"));
      const b = yield* Effect.forkChild(awaitMemberSocketClose("user-b"));
      yield* Effect.yieldNow;
      expect(openMemberSocketCount("user-a")).toBe(2);
      expect(closeMemberSockets("user-a")).toBe(2);
      yield* Fiber.join(a1);
      yield* Fiber.join(a2);
      expect(openMemberSocketCount("user-a")).toBe(0);
      expect(openMemberSocketCount("user-b")).toBe(1);
      expect(b.pollUnsafe()).toBeUndefined();
      closeMemberSockets("user-b");
      yield* Fiber.join(b);
    }),
  );

  it("never closes the operator's sockets and ignores unknown members", () => {
    expect(closeMemberSockets("nobody")).toBe(0);
  });
});
