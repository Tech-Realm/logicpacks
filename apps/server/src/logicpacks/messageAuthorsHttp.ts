import { PRESENCE_COLOR_COUNT } from "@logicpacks/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpRouter } from "effect/http";

import * as ServerConfig from "../config.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import type { ThreadId } from "@logicpacks/contracts";
import { type Caller, json, queryParam, readBody, resolveCaller } from "./http.ts";
import { LogicPacksAccess } from "./LogicPacksAccess.ts";
import { messageAuthorStore } from "./messageAuthors.ts";
import { hostDisplayName } from "./presenceConnection.ts";

const unauthenticated = json({ error: "unauthenticated" }, 401);
const notFound = json({ error: "not_found", message: "Not found." }, 404);

/** Whether this caller may set a person's colour: the host operator, or an owner of a workspace the person is in. */
export const canSetPersonColor = Effect.fn("logicpacks.messageAuthors.canSetColor")(function* (
  caller: Caller,
  targetUserId: string | null,
) {
  if (caller.kind === "operator") return true;
  if (caller.kind !== "member" || targetUserId === null) return false;
  const access = yield* LogicPacksAccess;
  for (const workspace of access.listWorkspaces(caller.userId)) {
    if (workspace.role !== "owner") continue;
    const members = yield* access
      .listWorkspaceMembers({ actorUserId: caller.userId, workspaceId: workspace.workspaceId })
      .pipe(Effect.orElseSucceed(() => []));
    if (members.some((member) => member.user.userId === targetUserId)) return true;
  }
  return false;
});

const authorsRoute = HttpRouter.add(
  "GET",
  "/api/lp/messages/authors",
  Effect.gen(function* () {
    const caller = yield* resolveCaller;
    if (caller.kind === "anonymous") return unauthenticated;
    const threadId = yield* queryParam("threadId");
    if (threadId.length === 0) return notFound;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const projectId = yield* threads.getThreadShell(threadId as ThreadId).pipe(
      Effect.map((shell) => shell?.projectId ?? null),
      Effect.orElseSucceed(() => null),
    );
    const access = yield* LogicPacksAccess;
    if (
      projectId === null ||
      (caller.kind === "member" && access.roleOf(caller.userId, projectId) === null)
    ) {
      return notFound;
    }
    const config = yield* ServerConfig.ServerConfig;
    const store = messageAuthorStore(config.stateDir);
    const host = yield* hostDisplayName;
    const names = new Map<string, string>();
    const authors: Record<string, { userId: string | null; name: string; color: number }> = {};
    for (const [messageId, userId] of Object.entries(store.authorsOf(threadId))) {
      let name = host;
      if (userId !== null) {
        let known = names.get(userId);
        if (known === undefined) {
          const user = yield* access.getUser(userId).pipe(Effect.orElseSucceed(() => null));
          known = user?.displayName ?? "Member";
          names.set(userId, known);
        }
        name = known;
      }
      authors[messageId] = { userId, name, color: store.colorOf(userId) };
    }
    return json({ authors });
  }),
);

const ColorRequest = Schema.Struct({
  userId: Schema.NullOr(Schema.String),
  color: Schema.Number,
});

const colorRoute = HttpRouter.add(
  "POST",
  "/api/lp/people/color",
  Effect.gen(function* () {
    const caller = yield* resolveCaller;
    if (caller.kind === "anonymous") return unauthenticated;
    const body = yield* readBody(ColorRequest);
    if (
      body === null ||
      !Number.isInteger(body.color) ||
      body.color < 0 ||
      body.color >= PRESENCE_COLOR_COUNT
    ) {
      return json({ error: "bad_request" }, 400);
    }
    if (!(yield* canSetPersonColor(caller, body.userId))) {
      return json({ error: "not_owner", message: "Only a workspace owner can change colours." }, 403);
    }
    const config = yield* ServerConfig.ServerConfig;
    messageAuthorStore(config.stateDir).setColor(body.userId, body.color);
    return json({ userId: body.userId, color: body.color });
  }),
);

export const layer = Layer.mergeAll(authorsRoute, colorRoute);
