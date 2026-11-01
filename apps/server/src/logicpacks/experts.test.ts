import { describe, expect, it } from "@effect/vitest";

import {
  briefFromThread,
  browseCatalog,
  grantAllows,
  grantedInstanceIds,
  publicExpert,
  revokeGrants,
  planSeed,
  SEED_EXPERTS,
  transitionRequest,
  validateExpert,
  type AssistanceRequest,
  type ProviderGrant,
} from "./experts.ts";
import { decideInstanceUse, memberInstanceId, providersForMember } from "./memberProviders.ts";

describe("expert catalog", () => {
  it("seeds only sample profiles with illustrative portraits and valid accounts", () => {
    expect(SEED_EXPERTS.length).toBeGreaterThanOrEqual(6);
    for (const expert of SEED_EXPERTS) {
      expect(expert.sample).toBe(true);
      expect(expert.avatar).toBe(`/experts/${expert.id}.webp`);
      const checked = validateExpert(expert);
      expect(checked.ok, expert.id).toBe(true);
    }
    const specialties = new Set(SEED_EXPERTS.map((expert) => expert.specialty));
    for (const wanted of ["Blender", "DaVinci Resolve", "Web", "Backend", "AI/ML", "QA"]) {
      expect(specialties.has(wanted)).toBe(true);
    }
  });

  it("plans the seed: everything on a fresh catalog, only what is new on an old one", () => {
    expect(planSeed([], "0").map((e) => e.id)).toEqual(SEED_EXPERTS.map((e) => e.id));
    const ingridV1 = { ...SEED_EXPERTS[0]!, avatar: "/experts/ingrid-solberg.svg" };
    const tomasEdited = { ...SEED_EXPERTS[1]!, avatar: "https://example.com/tomas.jpg" };
    // anika-rao was deleted by the operator: she stays deleted.
    const plan = planSeed([ingridV1, tomasEdited], "1");
    const ids = plan.map((e) => e.id);
    expect(ids).toContain("ingrid-solberg");
    expect(plan.find((e) => e.id === "ingrid-solberg")?.avatar).toBe(
      "/experts/ingrid-solberg.webp",
    );
    expect(ids).not.toContain("tomas-reyes");
    expect(ids).not.toContain("anika-rao");
    expect(ids).toEqual(expect.arrayContaining(["yuna-park", "karim-haddad"]));
  });

  it("lists active experts, available first, and never shows their account email", () => {
    const list = browseCatalog([
      ...SEED_EXPERTS,
      { ...SEED_EXPERTS[0]!, id: "retired", name: "Retired", active: false },
    ]);
    expect(list.some((expert) => expert.id === "retired")).toBe(false);
    expect(list[0]?.availability).toBe("available");
    expect(list.at(-1)?.availability).toBe("away");
    for (const expert of list) expect("accountEmail" in expert).toBe(false);
    expect(browseCatalog(SEED_EXPERTS, { specialty: "blender" }).map((e) => e.id)).toEqual([
      "ingrid-solberg",
    ]);
    expect(publicExpert(SEED_EXPERTS[0]!)).not.toHaveProperty("active");
  });

  it("validates what the operator adds", () => {
    expect(
      validateExpert({ id: "Bad Id", name: "x", specialty: "y", accountEmail: "a@b.co" }).ok,
    ).toBe(false);
    expect(validateExpert({ id: "ok", name: "", specialty: "y", accountEmail: "a@b.co" }).ok).toBe(
      false,
    );
    expect(validateExpert({ id: "ok", name: "N", specialty: "y", accountEmail: "nope" }).ok).toBe(
      false,
    );
    expect(
      validateExpert({ id: "ok", name: "N", specialty: "y", accountEmail: "a@b.co", rating: 7 }).ok,
    ).toBe(false);
    expect(
      validateExpert({
        id: "ok",
        name: "N",
        specialty: "y",
        accountEmail: "a@b.co",
        avatar: "javascript:alert(1)",
      }).ok,
    ).toBe(false);
    const ok = validateExpert({
      id: "sam",
      name: " Sam ",
      specialty: "Web",
      accountEmail: "Sam@X.io",
    });
    expect(ok.ok && ok.expert).toMatchObject({
      name: "Sam",
      accountEmail: "sam@x.io",
      avatar: "/experts/sam.svg",
      sample: false,
      active: true,
    });
  });
});

const baseRequest: AssistanceRequest = {
  id: "req-1",
  projectId: "p1",
  projectTitle: "Launch film",
  requesterUserId: "ana",
  requesterName: "Ana",
  expertId: "ingrid-solberg",
  expertUserId: null,
  brief: "Light the hero shot",
  fromThreadId: "t1",
  expertThreadId: null,
  status: "requested",
  createdAtMs: 1,
  updatedAtMs: 1,
  history: [{ status: "requested", atMs: 1, by: "Ana" }],
};

const expert = { role: "expert" as const, name: "Ingrid" };
const requester = { role: "requester" as const, name: "Ana" };

describe("request lifecycle", () => {
  it("goes requested, accepted, working, done, then ended", () => {
    const accepted = transitionRequest(
      baseRequest,
      { kind: "accept", expertUserId: "ingrid", expertThreadId: "t2" },
      expert,
      2,
    );
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(accepted.request).toMatchObject({
      status: "accepted",
      expertUserId: "ingrid",
      expertThreadId: "t2",
    });
    const working = transitionRequest(accepted.request, { kind: "working" }, requester, 3);
    expect(working.ok && working.request.status).toBe("working");
    if (!working.ok) return;
    // Working again is a no-op in the history.
    const again = transitionRequest(working.request, { kind: "working" }, expert, 4);
    expect(again.ok && again.request.history.length).toBe(3);
    const done = transitionRequest(working.request, { kind: "done" }, expert, 5);
    expect(done.ok && done.request.status).toBe("done");
    if (!done.ok) return;
    const ended = transitionRequest(done.request, { kind: "end" }, requester, 6);
    expect(ended.ok && ended.request.history.map((entry) => entry.status)).toEqual([
      "requested",
      "accepted",
      "working",
      "done",
      "ended",
    ]);
  });

  it("only lets the expert answer and only the requester end it", () => {
    const byRequester = transitionRequest(
      baseRequest,
      { kind: "accept", expertUserId: "ana", expertThreadId: null },
      requester,
      2,
    );
    expect(byRequester).toEqual({ ok: false, message: "Only the expert can do that." });
    const endByExpert = transitionRequest(baseRequest, { kind: "end" }, expert, 2);
    expect(endByExpert).toEqual({ ok: false, message: "Only the person who asked can do that." });
    const declined = transitionRequest(baseRequest, { kind: "decline" }, expert, 2);
    expect(declined.ok && declined.request.status).toBe("declined");
    if (!declined.ok) return;
    expect(transitionRequest(declined.request, { kind: "working" }, expert, 3).ok).toBe(false);
    expect(transitionRequest(declined.request, { kind: "end" }, requester, 3).ok).toBe(false);
  });

  it("starts a brief from the thread's ledger entry", () => {
    expect(
      briefFromThread({
        threadTitle: "Hero shot",
        goal: "Light the lamp",
        files: ["scene.blend"],
        decisions: ["Keep it warm"],
      }),
    ).toBe(
      "Goal: Light the lamp\nFiles: scene.blend\nDecided so far: Keep it warm\nWhat I need help with: ",
    );
    expect(briefFromThread({ threadTitle: null, goal: null, files: [], decisions: [] })).toBe(
      "What I need help with: ",
    );
  });
});

describe("subscription grants", () => {
  const anaClaude = memberInstanceId("claude", "ana");
  const anaCodex = memberInstanceId("codex", "ana");
  const grant: ProviderGrant = {
    id: "g1",
    projectId: "p1",
    ownerUserId: "ana",
    ownerName: "Ana",
    granteeUserId: "ingrid",
    instanceIds: [anaClaude],
    requestId: "req-1",
    createdAtMs: 1,
    revokedAtMs: null,
  };

  it("lets the expert use only the granted login, only in that project", () => {
    expect(
      grantAllows([grant], { granteeUserId: "ingrid", instanceId: anaClaude, projectId: "p1" }),
    ).toBe(true);
    expect(
      grantAllows([grant], { granteeUserId: "ingrid", instanceId: anaClaude, projectId: "p2" }),
    ).toBe(false);
    expect(
      grantAllows([grant], { granteeUserId: "ingrid", instanceId: anaCodex, projectId: "p1" }),
    ).toBe(false);
    expect(
      grantAllows([grant], { granteeUserId: "bob", instanceId: anaClaude, projectId: "p1" }),
    ).toBe(false);
    expect(
      grantAllows([grant], { granteeUserId: "ingrid", instanceId: anaClaude, projectId: null }),
    ).toBe(false);
  });

  it("feeds the fence: someone else's login is allowed only while the grant holds", () => {
    const granted = grantAllows([grant], {
      granteeUserId: "ingrid",
      instanceId: anaClaude,
      projectId: "p1",
    });
    expect(
      decideInstanceUse({
        instanceId: anaClaude,
        userId: "ingrid",
        membersMustUseOwn: true,
        granted,
      }),
    ).toBe("granted");
    const [revoked] = revokeGrants([grant], (candidate) => candidate.requestId === "req-1", 9);
    expect(revoked?.revokedAtMs).toBe(9);
    const after = grantAllows([revoked!], {
      granteeUserId: "ingrid",
      instanceId: anaClaude,
      projectId: "p1",
    });
    expect(after).toBe(false);
    expect(
      decideInstanceUse({
        instanceId: anaClaude,
        userId: "ingrid",
        membersMustUseOwn: true,
        granted: after,
      }),
    ).toBe("someone_elses");
    expect(grantedInstanceIds([revoked!], "ingrid").size).toBe(0);
    // Revoking twice changes nothing.
    expect(revokeGrants([revoked!], () => true, 10)).toEqual([]);
  });

  it("lists a granted login in the expert's picker and hides it again once revoked", () => {
    const providers = [
      { instanceId: anaClaude },
      { instanceId: memberInstanceId("claude", "bob") },
    ];
    const listed = providersForMember(providers, {
      userId: "ingrid",
      membersMustUseOwn: true,
      grantedInstanceIds: grantedInstanceIds([grant], "ingrid"),
    });
    expect(listed.map((provider) => provider.instanceId)).toEqual([anaClaude]);
    expect(
      providersForMember(providers, {
        userId: "ingrid",
        membersMustUseOwn: true,
        grantedInstanceIds: new Set(),
      }),
    ).toEqual([]);
  });
});
