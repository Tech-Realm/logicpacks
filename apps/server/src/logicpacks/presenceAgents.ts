import type { OrchestrationV2DomainEvent, PresenceLocation, ThreadId } from "@logicpacks/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { forkParked } from "../serverActivation.ts";
import { LogicPacksAccess } from "./LogicPacksAccess.ts";
import { isMemberInstanceId, isOwnMemberInstance } from "./memberProviders.ts";
import {
  agentAppTouchFromTurnItem,
  agentPresenceKey,
  agentTouchFromTurnItem,
  positionOfText,
  relativeToRoots,
} from "./presence.ts";
import {
  agentActorFor,
  HOST_ACTOR_ID,
  hostDisplayName,
  type PresenceOwner,
} from "./presenceConnection.ts";
import { PresenceService } from "./PresenceService.ts";
import { memberSubject } from "./projectAccess.ts";

/** An agent between tool calls is still "in" its last file for this long. */
const AGENT_PRESENCE_TTL_MS = 45_000;
/** Larger files are not read just to place a cursor. */
const MAX_CURSOR_LOOKUP_BYTES = 1024 * 1024;
const FINISHED_RUN_STATUSES = new Set([
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
]);

/**
 * Agents running on this host show up where their tool calls are: each Read,
 * Edit or Write moves the thread's agent cursor, and a finished run removes it.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const projects = yield* ProjectStore.ProjectStoreV2;
    const presence = yield* PresenceService;
    const access = yield* LogicPacksAccess;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const hostName = yield* hostDisplayName;

    const ownerOf = Effect.fn("logicpacks.presenceAgents.ownerOf")(function* (instanceId: string) {
      if (!isMemberInstanceId(instanceId)) return { id: HOST_ACTOR_ID, name: hostName };
      const users = yield* access.listUsers().pipe(Effect.orElseSucceed(() => []));
      const user = users.find((candidate) => isOwnMemberInstance(instanceId, candidate.userId));
      return user === undefined
        ? { id: HOST_ACTOR_ID, name: hostName }
        : ({ id: memberSubject(user.userId), name: user.displayName } satisfies PresenceOwner);
    });

    const cursorFor = Effect.fn("logicpacks.presenceAgents.cursorFor")(function* (
      absolutePath: string,
      writtenText: string | undefined,
    ) {
      if (writtenText === undefined) return undefined;
      const info = yield* fileSystem.stat(absolutePath).pipe(Effect.option);
      if (info._tag === "None" || Number(info.value.size) > MAX_CURSOR_LOOKUP_BYTES)
        return undefined;
      const contents = yield* fileSystem.readFileString(absolutePath).pipe(Effect.option);
      return contents._tag === "None"
        ? undefined
        : (positionOfText(contents.value, writtenText) ?? undefined);
    });

    const onTurnItem = Effect.fn("logicpacks.presenceAgents.onTurnItem")(function* (
      threadId: ThreadId,
      item: Extract<OrchestrationV2DomainEvent, { type: "turn-item.updated" }>["payload"],
    ) {
      const appTouch = agentAppTouchFromTurnItem(item);
      const touch = appTouch === null ? agentTouchFromTurnItem(item) : null;
      if (appTouch === null && touch === null) return;
      const shell = yield* threads.getThreadShell(threadId).pipe(Effect.orElseSucceed(() => null));
      if (shell === null) return;
      if (appTouch !== null) {
        // In an app project the agent is on an object, not in a file: the outline and the
        // App tab show it there, the same way the file tree shows agents on files.
        const owner = yield* ownerOf(shell.modelSelection.instanceId);
        yield* presence.write({
          key: agentPresenceKey(threadId),
          clientId: threadId,
          connectionId: null,
          projectId: shell.projectId,
          threadId,
          actor: agentActorFor(owner, `thread:${threadId}`),
          source: "server",
          location: {
            view: "app",
            activity: appTouch.activity,
            appItem: {
              recipeId: appTouch.recipeId,
              itemId: appTouch.itemId,
              ...(appTouch.label === undefined ? {} : { label: appTouch.label }),
            },
          },
          ttlMs: AGENT_PRESENCE_TTL_MS,
        });
        return;
      }
      if (touch === null) return;
      const [project] = yield* projects
        .listShells({ projectIds: [shell.projectId] })
        .pipe(Effect.orElseSucceed(() => []));
      const roots = [shell.worktreePath, project?.workspaceRoot].filter(
        (root): root is string => typeof root === "string",
      );
      const relativePath = relativeToRoots(touch.filePath, roots);
      if (relativePath === null || roots[0] === undefined) return;
      const cursor = yield* cursorFor(path.join(roots[0], relativePath), touch.writtenText);
      const location: PresenceLocation = {
        view: "file",
        activity: touch.activity,
        path: relativePath,
        ...(cursor === undefined ? {} : { cursor }),
      };
      const owner = yield* ownerOf(shell.modelSelection.instanceId);
      yield* presence.write({
        key: agentPresenceKey(threadId),
        clientId: threadId,
        connectionId: null,
        projectId: shell.projectId,
        threadId,
        actor: agentActorFor(owner, `thread:${threadId}`),
        source: "server",
        location,
        ttlMs: AGENT_PRESENCE_TTL_MS,
      });
    });

    const handle = (event: OrchestrationV2DomainEvent) => {
      if (event.type === "turn-item.updated") {
        return onTurnItem(event.threadId, event.payload).pipe(
          Effect.catchCause((cause) => Effect.logDebug("Agent presence skipped", { cause })),
        );
      }
      if (event.type === "run.updated" && FINISHED_RUN_STATUSES.has(event.payload.status)) {
        const key = agentPresenceKey(event.threadId);
        return presence.dropWhere((record) => record.entry.key === key);
      }
      return Effect.void;
    };

    yield* forkParked(Stream.runForEach(threads.streamDomainEvents, handle));
  }),
);
