import { LpReportActivityInput } from "@logicpacks/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { packKey, publishCredits, publishedSubject, reuseCredits } from "./packCredits.ts";

describe("pack credits", () => {
  it("keys a pack by id and save time, so a copy in another project is the same pack", () => {
    const saved = { id: "checkout-flow", context: { source: { savedAt: "2026-11-01T10:00:00Z" } } };
    expect(packKey(saved)).toBe("checkout-flow@2026-11-01T10:00:00Z");
    expect(packKey({ ...saved })).toBe(packKey(saved));
    expect(packKey({ id: "builtin" })).toBe("builtin");
  });

  it("credits the author for publishing", () => {
    expect(publishCredits("ali", "k")).toEqual([
      { participantId: "ali", kind: "recipe.published", subject: publishedSubject("k") },
    ]);
  });

  it("credits the person reusing a teammate's pack and the author", () => {
    expect(reuseCredits({ authorId: "ali", reuserId: "sara", key: "k", useId: "u1" })).toEqual([
      { participantId: "sara", kind: "recipe.reused", subject: "pack:k:use:u1" },
      { participantId: "ali", kind: "pack.reused_by_teammate", subject: "pack:k:by:sara" },
      { participantId: "ali", kind: "pack.reuse_received", subject: "pack:k:use:u1" },
    ]);
  });

  it("counts a teammate once per pack, but every use", () => {
    const first = reuseCredits({ authorId: "ali", reuserId: "sara", key: "k", useId: "u1" });
    const second = reuseCredits({ authorId: "ali", reuserId: "sara", key: "k", useId: "u2" });
    const teammate = (credits: typeof first) =>
      credits.find((credit) => credit.kind === "pack.reused_by_teammate")!.subject;
    const use = (credits: typeof first) =>
      credits.find((credit) => credit.kind === "pack.reuse_received")!.subject;
    expect(teammate(first)).toBe(teammate(second));
    expect(use(first)).not.toBe(use(second));
  });

  it("gives nothing for reusing your own pack", () => {
    expect(reuseCredits({ authorId: "ali", reuserId: "ali", key: "k", useId: "u1" })).toEqual([]);
  });

  it("still counts the reuse when the host never saw the pack published", () => {
    expect(reuseCredits({ authorId: null, reuserId: "sara", key: "k", useId: "u1" })).toEqual([
      { participantId: "sara", kind: "recipe.reused", subject: "pack:k:use:u1" },
    ]);
  });
});

describe("pack activity is server-only", () => {
  const decode = Schema.decodeUnknownOption(LpReportActivityInput);
  it("rejects publish and reuse kinds from the client activity endpoint", () => {
    for (const kind of [
      "recipe.published",
      "recipe.reused",
      "pack.reused_by_teammate",
      "pack.reuse_received",
    ]) {
      expect(Option.isNone(decode({ kind, subject: "pack:k" }))).toBe(true);
    }
  });

  it("still accepts the kinds only the caller can see", () => {
    for (const kind of ["conflict.resolved", "helper.session_linked"]) {
      expect(Option.isSome(decode({ kind, subject: "s" }))).toBe(true);
    }
  });
});
