import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { LogicPacksAccess, layer } from "./LogicPacksAccess.ts";

const layerAccess = layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory));

it.layer(layerAccess)("LogicPacksAccess", (it) => {
  it.effect("signs up, refuses a wrong password and a duplicate email", () =>
    Effect.gen(function* () {
      const access = yield* LogicPacksAccess;
      const user = yield* access.signUp({ email: "Ana@Example.com", password: "correct-horse" });
      assert.strictEqual(user.email, "ana@example.com");
      const loggedIn = yield* access.logIn({ email: "ana@example.com", password: "correct-horse" });
      assert.strictEqual(loggedIn.userId, user.userId);
      const wrong = yield* access
        .logIn({ email: "ana@example.com", password: "nope-nope-nope" })
        .pipe(Effect.flip);
      assert.strictEqual(wrong.reason, "invalid_credentials");
      const duplicate = yield* access
        .signUp({ email: "ana@example.com", password: "another-pass" })
        .pipe(Effect.flip);
      assert.strictEqual(duplicate.reason, "email_taken");
    }),
  );

  it.effect("a synced project remembers whose GitHub it pushes with, until cleared", () =>
    Effect.gen(function* () {
      const access = yield* LogicPacksAccess;
      assert.isNull(access.syncPusher("p-push"));
      yield* access.setSyncPusher("p-push", "user-a");
      assert.strictEqual(access.syncPusher("p-push"), "user-a");
      assert.isNull(access.syncPusher("p-other"));
      yield* access.setSyncPusher("p-push", null);
      assert.isNull(access.syncPusher("p-push"));
    }),
  );

  it.effect("quick login creates a passwordless account once", () =>
    Effect.gen(function* () {
      const access = yield* LogicPacksAccess;
      const first = yield* access.quickLogin("Bea");
      const second = yield* access.quickLogin("bea");
      assert.strictEqual(first.userId, second.userId);
      assert.strictEqual(first.email, "bea@logicpacks.internal");
      const noPassword = yield* access
        .logIn({ email: first.email, password: "anything-goes" })
        .pipe(Effect.flip);
      assert.strictEqual(noPassword.reason, "invalid_credentials");
    }),
  );

  it.effect("only the owner shares, and a project keeps an owner", () =>
    Effect.gen(function* () {
      const access = yield* LogicPacksAccess;
      const owner = yield* access.quickLogin("owner");
      const mate = yield* access.quickLogin("mate");
      yield* access.recordOwner("p1", owner.userId);
      assert.strictEqual(access.roleOf(mate.userId, "p1"), null);

      const refused = yield* access
        .addMember({ projectId: "p1", actorUserId: mate.userId, user: "mate" })
        .pipe(Effect.flip);
      assert.strictEqual(refused.reason, "not_owner");

      yield* access.addMember({ projectId: "p1", actorUserId: owner.userId, user: "mate" });
      assert.strictEqual(access.roleOf(mate.userId, "p1"), "member");
      assert.deepStrictEqual(Array.from(access.visibleProjectIds(mate.userId)), ["p1"]);

      const lastOwner = yield* access
        .removeMember({ projectId: "p1", actorUserId: null, userId: owner.userId })
        .pipe(Effect.flip);
      assert.strictEqual(lastOwner.reason, "last_owner");

      yield* access.removeMember({
        projectId: "p1",
        actorUserId: owner.userId,
        userId: mate.userId,
      });
      assert.strictEqual(access.roleOf(mate.userId, "p1"), null);
      const members = yield* access.listMembers("p1");
      assert.deepStrictEqual(
        members.map((member) => [member.user.email, member.role]),
        [["owner@logicpacks.internal", "owner"]],
      );
    }),
  );

  it.effect("a new account starts in its own workspace", () =>
    Effect.gen(function* () {
      const access = yield* LogicPacksAccess;
      const cara = yield* access.signUp({
        email: "cara@example.com",
        password: "correct-horse",
        displayName: "Cara",
      });
      const mine = access.listWorkspaces(cara.userId);
      assert.deepStrictEqual(
        mine.map((workspace) => [workspace.name, workspace.role, workspace.memberCount]),
        [["Cara's workspace", "owner", 1]],
      );
      assert.strictEqual(access.currentWorkspaceId(cara.userId), mine[0]!.workspaceId);
    }),
  );

  it.effect("switching workspaces changes which projects are in view", () =>
    Effect.gen(function* () {
      const access = yield* LogicPacksAccess;
      const dev = yield* access.quickLogin("dev");
      const home = access.currentWorkspaceId(dev.userId)!;
      yield* access.attachProject("p-home", home);
      const second = yield* access.createWorkspace({
        actorUserId: dev.userId,
        name: " Side  gig ",
      });
      assert.strictEqual(second.name, "Side gig");
      assert.strictEqual(access.currentWorkspaceId(dev.userId), second.workspaceId);
      yield* access.attachProject("p-side", second.workspaceId);

      assert.isTrue(access.inView(dev.userId, "p-side"));
      assert.isFalse(access.inView(dev.userId, "p-home"));
      yield* access.setCurrentWorkspace({ actorUserId: dev.userId, workspaceId: home });
      assert.isTrue(access.inView(dev.userId, "p-home"));
      assert.isFalse(access.inView(dev.userId, "p-side"));
      // Both stay reachable; the view only decides what the sidebar lists.
      assert.strictEqual(access.roleOf(dev.userId, "p-side"), "owner");

      // The operator sees the whole host until they pick a workspace.
      assert.isTrue(access.inView(null, "p-home") && access.inView(null, "p-side"));
      yield* access.setCurrentWorkspace({ actorUserId: null, workspaceId: second.workspaceId });
      assert.isFalse(access.inView(null, "p-home"));
      yield* access.setCurrentWorkspace({ actorUserId: null, workspaceId: null });
    }),
  );

  it.effect("an invite link brings people in, and revoking takes everything back", () =>
    Effect.gen(function* () {
      const access = yield* LogicPacksAccess;
      const host = yield* access.quickLogin("host");
      const guest = yield* access.quickLogin("guest");
      const workspaceId = access.currentWorkspaceId(host.userId)!;
      yield* access.attachProject("p-team", workspaceId);
      assert.strictEqual(access.roleOf(guest.userId, "p-team"), null);

      const token = yield* access.inviteToken({ actorUserId: host.userId, workspaceId });
      assert.strictEqual(
        yield* access.inviteToken({ actorUserId: host.userId, workspaceId }),
        token,
      );
      assert.strictEqual(access.workspaceForInvite(token)?.name, "Host's workspace");
      const joined = yield* access.joinWithInvite({ token, userId: guest.userId });
      assert.strictEqual(joined.role, "member");
      assert.strictEqual(access.currentWorkspaceId(guest.userId), workspaceId);
      assert.strictEqual(access.roleOf(guest.userId, "p-team"), "member");
      assert.isTrue(access.inView(guest.userId, "p-team"));

      // Members cannot manage; a project a member adds is theirs and the workspace's.
      const refused = yield* access
        .removeWorkspaceMember({ actorUserId: guest.userId, workspaceId, userId: host.userId })
        .pipe(Effect.flip);
      assert.strictEqual(refused.reason, "not_owner");
      yield* access.recordOwner("p-guest", guest.userId);
      yield* access.attachProject("p-guest", workspaceId);
      assert.strictEqual(access.roleOf(host.userId, "p-guest"), "owner");

      const lastOwner = yield* access
        .setWorkspaceRole({
          actorUserId: host.userId,
          workspaceId,
          userId: host.userId,
          role: "member",
        })
        .pipe(Effect.flip);
      assert.strictEqual(lastOwner.reason, "last_owner");

      yield* access.removeWorkspaceMember({
        actorUserId: host.userId,
        workspaceId,
        userId: guest.userId,
      });
      assert.strictEqual(access.roleOf(guest.userId, "p-team"), null);
      assert.strictEqual(access.roleOf(guest.userId, "p-guest"), null);
      assert.notStrictEqual(access.currentWorkspaceId(guest.userId), workspaceId);

      // A reset link stops the old one working.
      const fresh = yield* access.resetInvite({ actorUserId: host.userId, workspaceId });
      assert.notStrictEqual(fresh, token);
      const stale = yield* access.joinWithInvite({ token, userId: guest.userId }).pipe(Effect.flip);
      assert.strictEqual(stale.reason, "invalid_invite");
    }),
  );

  it.effect(
    "existing accounts are added by name, and project shares reach outside the workspace",
    () =>
      Effect.gen(function* () {
        const access = yield* LogicPacksAccess;
        const lead = yield* access.quickLogin("lead");
        const peer = yield* access.quickLogin("peer");
        const workspaceId = access.currentWorkspaceId(lead.userId)!;
        const unknown = yield* access
          .addWorkspaceMember({ actorUserId: lead.userId, workspaceId, user: "nobody" })
          .pipe(Effect.flip);
        assert.strictEqual(unknown.reason, "unknown_user");
        yield* access.addWorkspaceMember({ actorUserId: lead.userId, workspaceId, user: "peer" });
        const members = yield* access.listWorkspaceMembers({
          actorUserId: peer.userId,
          workspaceId,
        });
        assert.deepStrictEqual(
          members.map((member) => [member.user.email, member.role]),
          [
            ["lead@logicpacks.internal", "owner"],
            ["peer@logicpacks.internal", "member"],
          ],
        );

        // A project shared on its own shows in every view of someone outside its workspace.
        const outsider = yield* access.quickLogin("outsider");
        yield* access.recordOwner("p-solo", lead.userId);
        yield* access.attachProject("p-solo", workspaceId);
        yield* access.addMember({
          projectId: "p-solo",
          actorUserId: lead.userId,
          user: "outsider",
        });
        assert.isTrue(access.inView(outsider.userId, "p-solo"));
        assert.isFalse(
          access.listWorkspaces(outsider.userId).some((w) => w.workspaceId === workspaceId),
        );

        yield* access.deleteWorkspace({ actorUserId: lead.userId, workspaceId });
        assert.strictEqual(access.roleOf(peer.userId, "p-solo"), null);
        assert.strictEqual(access.roleOf(lead.userId, "p-solo"), "owner");
      }),
  );

  it.effect("remembers synced projects after a restart", () =>
    Effect.gen(function* () {
      const access = yield* LogicPacksAccess;
      yield* access.markSynced("p-synced", "git@github.com:acme/app.git");
      const restarted = yield* Layer.build(layer).pipe(
        Effect.map((context) => Context.get(context, LogicPacksAccess)),
        Effect.scoped,
      );
      assert.isTrue(restarted.isSynced("p-synced"));
      assert.isFalse(restarted.isSynced("p1"));
      const dev = (yield* restarted.listUsers()).find((user) => user.email.startsWith("dev@"))!;
      assert.deepStrictEqual(
        restarted.listWorkspaces(dev.userId).map((workspace) => workspace.name),
        ["Dev's workspace", "Side gig"],
      );
    }),
  );
});
