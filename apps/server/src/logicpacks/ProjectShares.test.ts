import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { LogicPacksAccess, layer as accessLayer } from "./LogicPacksAccess.ts";
import { ProjectShares, layer as sharesLayer, normalizeDomain } from "./ProjectShares.ts";
import { layerRecording, type OutgoingMail } from "./shareMail.ts";

const sent: Array<OutgoingMail> = [];
const layerShares = sharesLayer.pipe(
  Layer.provideMerge(Layer.merge(accessLayer, layerRecording(sent))),
  Layer.provideMerge(SqlitePersistence.layerMemory),
);

const mail = {
  projectTitle: "Team site",
  absoluteUrl: (path: string) => `https://app.example.test${path}`,
};

/** A project owned by a fresh account; names are unique per test (the layer is shared). */
const ownedProject = (tag: string) =>
  Effect.gen(function* () {
    const access = yield* LogicPacksAccess;
    const owner = yield* access.signUp({
      email: `owner-${tag}@example.com`,
      password: "correct-horse",
      displayName: "Ana",
    });
    const projectId = `p-${tag}`;
    yield* access.recordOwner(projectId, owner.userId);
    return { owner, projectId };
  });

const tokenOf = (path: string) => new URL(path, "https://x.test").searchParams.get("invite")!;

it.layer(layerShares)("ProjectShares", (it) => {
  it.effect("an unknown email becomes a pending invite and gets one plain email", () =>
    Effect.gen(function* () {
      const shares = yield* ProjectShares;
      const access = yield* LogicPacksAccess;
      const { owner, projectId } = yield* ownedProject("pend");
      const before = sent.length;
      const outcome = yield* shares.share({
        projectId,
        actorUserId: owner.userId,
        user: "New.Person@Example.com",
        mail,
      });
      assert.strictEqual(outcome.kind, "invited");
      if (outcome.kind !== "invited") return;
      assert.strictEqual(outcome.invite.email, "new.person@example.com");
      assert.strictEqual(outcome.invite.role, "member");
      assert.strictEqual(outcome.invite.invitedBy, owner.userId);
      assert.isTrue(Date.parse(outcome.invite.expiresAt) > Date.parse(outcome.invite.createdAt));
      assert.strictEqual(sent.length, before + 1);
      const email = sent.at(-1)!;
      assert.strictEqual(email.to, "new.person@example.com");
      assert.strictEqual(email.subject, "Ana shared Team site with you on LogicPacks");
      assert.include(email.html, `https://app.example.test/lp/join/project?invite=`);
      assert.notInclude(email.text + email.html, "—");
      // Sharing again refreshes the same invite instead of adding a second one.
      yield* shares.share({
        projectId,
        actorUserId: owner.userId,
        user: "new.person@example.com",
        mail,
      });
      assert.strictEqual((yield* shares.listInvites(projectId)).length, 1);
      // An existing account keeps today's behaviour: straight in, no invite.
      yield* access.signUp({ email: "exists-pend@example.com", password: "correct-horse" });
      const direct = yield* shares.share({
        projectId,
        actorUserId: owner.userId,
        user: "exists-pend@example.com",
        mail,
      });
      assert.strictEqual(direct.kind, "member");
      assert.strictEqual((yield* shares.listInvites(projectId)).length, 1);
    }),
  );

  it.effect("an invalid email or unknown name is a gentle refusal", () =>
    Effect.gen(function* () {
      const shares = yield* ProjectShares;
      const { owner, projectId } = yield* ownedProject("bad");
      const bad = yield* shares
        .share({ projectId, actorUserId: owner.userId, user: "test@", mail })
        .pipe(Effect.flip);
      assert.strictEqual(bad._tag === "ShareError" && bad.reason, "invalid_email");
      const name = yield* shares
        .share({ projectId, actorUserId: owner.userId, user: "nobody-here", mail })
        .pipe(Effect.flip);
      assert.strictEqual(name._tag === "ShareError" && name.reason, "invalid_email");
      assert.include(name.message, "Use their email");
    }),
  );

  it.effect("resend restarts the expiry and mails again; revoke kills the link", () =>
    Effect.gen(function* () {
      const shares = yield* ProjectShares;
      const access = yield* LogicPacksAccess;
      const { owner, projectId } = yield* ownedProject("resend");
      const outcome = yield* shares.share({
        projectId,
        actorUserId: owner.userId,
        user: "late-resend@example.com",
        mail,
      });
      if (outcome.kind !== "invited") return assert.fail("expected an invite");
      yield* TestClock.adjust("3 days");
      const before = sent.length;
      const resent = yield* shares.resendInvite({
        projectId,
        actorUserId: owner.userId,
        inviteId: outcome.invite.inviteId,
        mail,
      });
      assert.strictEqual(sent.length, before + 1);
      assert.isTrue(Date.parse(resent.invite.expiresAt) > Date.parse(outcome.invite.expiresAt));
      assert.strictEqual(resent.invite.token, outcome.invite.token);

      yield* shares.revokeInvite({
        projectId,
        actorUserId: owner.userId,
        inviteId: outcome.invite.inviteId,
      });
      assert.strictEqual((yield* shares.listInvites(projectId)).length, 0);
      const target = yield* shares.resolveToken(outcome.invite.token);
      assert.strictEqual(target.kind === "closed" && target.reason, "not_found");
      // A revoked invite no longer opens the project on sign-up either.
      const user = yield* access.signUp({
        email: "late-resend@example.com",
        password: "correct-horse",
      });
      assert.deepStrictEqual(yield* shares.claimInvites(user), []);
      assert.strictEqual(access.roleOf(user.userId, projectId), null);
    }),
  );

  it.effect("signing up with the invited email grants access, link or not", () =>
    Effect.gen(function* () {
      const shares = yield* ProjectShares;
      const access = yield* LogicPacksAccess;
      const { owner, projectId } = yield* ownedProject("claim");
      yield* shares.share({
        projectId,
        actorUserId: owner.userId,
        user: "bo-claim@example.com",
        mail,
      });
      const bo = yield* access.signUp({ email: "Bo-Claim@example.com", password: "correct-horse" });
      assert.deepStrictEqual(yield* shares.claimInvites(bo), [projectId]);
      assert.strictEqual(access.roleOf(bo.userId, projectId), "member");
      assert.strictEqual((yield* shares.listInvites(projectId)).length, 0);
      // An expired invite does not grant.
      const second = yield* ownedProject("claim2");
      yield* shares.share({
        projectId: second.projectId,
        actorUserId: second.owner.userId,
        user: "cy-claim@example.com",
        mail,
      });
      yield* TestClock.adjust("15 days");
      const cy = yield* access.signUp({ email: "cy-claim@example.com", password: "correct-horse" });
      assert.deepStrictEqual(yield* shares.claimInvites(cy), []);
      assert.strictEqual(access.roleOf(cy.userId, second.projectId), null);
    }),
  );

  it.effect("the invite link works once, for whoever opens it", () =>
    Effect.gen(function* () {
      const shares = yield* ProjectShares;
      const access = yield* LogicPacksAccess;
      const { owner, projectId } = yield* ownedProject("tok");
      const outcome = yield* shares.share({
        projectId,
        actorUserId: owner.userId,
        user: "invited-tok@example.com",
        mail,
      });
      if (outcome.kind !== "invited") return assert.fail("expected an invite");
      const other = yield* access.signUp({
        email: "other-tok@example.com",
        password: "correct-horse",
      });
      yield* shares.joinWithToken({ token: outcome.invite.token, user: other });
      assert.strictEqual(access.roleOf(other.userId, projectId), "member");
      // Opening it again is fine for them, refused for anyone else.
      yield* shares.joinWithToken({ token: outcome.invite.token, user: other });
      const third = yield* access.signUp({
        email: "third-tok@example.com",
        password: "correct-horse",
      });
      const used = yield* shares
        .joinWithToken({ token: outcome.invite.token, user: third })
        .pipe(Effect.flip);
      assert.strictEqual(used._tag === "ShareError" && used.reason, "invite_used");
    }),
  );

  it.effect("the share link: on/off, expiry, reset and the join list", () =>
    Effect.gen(function* () {
      const shares = yield* ProjectShares;
      const access = yield* LogicPacksAccess;
      const { owner, projectId } = yield* ownedProject("link");
      assert.strictEqual(yield* shares.getLink(projectId), null);
      const link = yield* shares.updateLink({
        projectId,
        actorUserId: owner.userId,
        enabled: true,
        expiry: "1d",
      });
      assert.isTrue(link.enabled);
      assert.strictEqual(link.role, "member");
      const dee = yield* access.signUp({
        email: "dee-link@example.com",
        password: "correct-horse",
      });
      yield* shares.joinWithToken({ token: link.token, user: dee });
      assert.strictEqual(access.roleOf(dee.userId, projectId), "member");
      const joins = yield* shares.linkJoins(projectId);
      assert.deepStrictEqual(
        joins.map((join) => join.user.email),
        ["dee-link@example.com"],
      );

      // Off: refused.
      yield* shares.updateLink({ projectId, actorUserId: owner.userId, enabled: false });
      const eve = yield* access.signUp({
        email: "eve-link@example.com",
        password: "correct-horse",
      });
      const off = yield* shares.joinWithToken({ token: link.token, user: eve }).pipe(Effect.flip);
      assert.strictEqual(off._tag === "ShareError" && off.reason, "link_off");

      // On again with one day: works now, refused after a day.
      yield* shares.updateLink({ projectId, actorUserId: owner.userId, enabled: true });
      yield* TestClock.adjust("25 hours");
      const late = yield* shares.joinWithToken({ token: link.token, user: eve }).pipe(Effect.flip);
      assert.strictEqual(late._tag === "ShareError" && late.reason, "link_expired");

      // Never expires; reset makes a new token and the old one stops working.
      yield* shares.updateLink({ projectId, actorUserId: owner.userId, expiry: "never" });
      const reset = yield* shares.resetLink({ projectId, actorUserId: owner.userId });
      assert.notStrictEqual(reset.token, link.token);
      assert.strictEqual(reset.expiresAt, null);
      const old = yield* shares.joinWithToken({ token: link.token, user: eve }).pipe(Effect.flip);
      assert.strictEqual(old._tag === "ShareError" && old.reason, "not_found");
      yield* shares.joinWithToken({ token: reset.token, user: eve });
      assert.strictEqual(access.roleOf(eve.userId, projectId), "member");
    }),
  );

  it.effect("a domain-restricted link only lets in that domain", () =>
    Effect.gen(function* () {
      const shares = yield* ProjectShares;
      const access = yield* LogicPacksAccess;
      const { owner, projectId } = yield* ownedProject("dom");
      const bad = yield* shares
        .updateLink({ projectId, actorUserId: owner.userId, enabled: true, domain: "not a domain" })
        .pipe(Effect.flip);
      assert.strictEqual(bad.reason, "invalid_domain");
      const link = yield* shares.updateLink({
        projectId,
        actorUserId: owner.userId,
        enabled: true,
        expiry: "7d",
        domain: "@Acme.com",
      });
      assert.strictEqual(link.domain, "acme.com");
      const outsider = yield* access.signUp({
        email: "x-dom@gmail.com",
        password: "correct-horse",
      });
      const refused = yield* shares
        .joinWithToken({ token: link.token, user: outsider })
        .pipe(Effect.flip);
      assert.strictEqual(refused._tag === "ShareError" && refused.reason, "wrong_domain");
      const precheck = yield* shares
        .checkEmailForToken(link.token, "y@gmail.com")
        .pipe(Effect.flip);
      assert.strictEqual(precheck.reason, "wrong_domain");
      const insider = yield* access.signUp({ email: "x-dom@acme.com", password: "correct-horse" });
      yield* shares.joinWithToken({ token: link.token, user: insider });
      assert.strictEqual(access.roleOf(insider.userId, projectId), "member");
      // Clearing the domain opens it to anyone.
      const open = yield* shares.updateLink({ projectId, actorUserId: owner.userId, domain: null });
      assert.strictEqual(open.domain, null);
      yield* shares.joinWithToken({ token: link.token, user: outsider });
      assert.strictEqual(access.roleOf(outsider.userId, projectId), "member");
    }),
  );

  it.effect("only owners manage sharing; joining never raises or lowers a role", () =>
    Effect.gen(function* () {
      const shares = yield* ProjectShares;
      const access = yield* LogicPacksAccess;
      const { owner, projectId } = yield* ownedProject("role");
      const link = yield* shares.updateLink({
        projectId,
        actorUserId: owner.userId,
        enabled: true,
      });
      const member = yield* access.signUp({
        email: "m-role@example.com",
        password: "correct-horse",
      });
      yield* shares.joinWithToken({ token: link.token, user: member });
      assert.strictEqual(access.roleOf(member.userId, projectId), "member");

      for (const attempt of [
        shares
          .share({ projectId, actorUserId: member.userId, user: "z@example.com", mail })
          .pipe(Effect.asVoid),
        shares
          .updateLink({ projectId, actorUserId: member.userId, enabled: false })
          .pipe(Effect.asVoid),
        shares.resetLink({ projectId, actorUserId: member.userId }).pipe(Effect.asVoid),
      ]) {
        const refused = yield* Effect.flip(attempt);
        assert.strictEqual(refused.reason, "not_owner");
      }
      const invite = yield* shares.share({
        projectId,
        actorUserId: owner.userId,
        user: "pending-role@example.com",
        mail,
      });
      if (invite.kind !== "invited") return assert.fail("expected an invite");
      for (const attempt of [
        shares.resendInvite({
          projectId,
          actorUserId: member.userId,
          inviteId: invite.invite.inviteId,
          mail,
        }),
        shares.revokeInvite({
          projectId,
          actorUserId: member.userId,
          inviteId: invite.invite.inviteId,
        }),
      ]) {
        const refused = yield* Effect.flip(attempt);
        assert.strictEqual(refused.reason, "not_owner");
      }
      // The owner opening their own link stays owner and is not listed as a link join.
      yield* shares.joinWithToken({ token: link.token, user: owner });
      assert.strictEqual(access.roleOf(owner.userId, projectId), "owner");
      assert.deepStrictEqual(
        (yield* shares.linkJoins(projectId)).map((join) => join.user.userId),
        [member.userId],
      );
      // The operator (null actor) may manage any project.
      yield* shares.updateLink({ projectId, actorUserId: null, enabled: false });
    }),
  );

  it.effect("normalizes domains", () =>
    Effect.sync(() => {
      assert.strictEqual(normalizeDomain(" @Example.CO.uk "), "example.co.uk");
      assert.strictEqual(normalizeDomain("localhost"), null);
      assert.strictEqual(normalizeDomain("a b.com"), null);
      assert.strictEqual(tokenOf("/lp/join/project?invite=abc"), "abc");
    }),
  );
});
