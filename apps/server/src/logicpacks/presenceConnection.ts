import type {
  PresenceActor,
  PresenceEntry,
  PresenceLocation,
  PresenceSubscribeInput,
  PresenceUpdateInput,
  ProjectId,
} from "@logicpacks/contracts";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerConfig from "../config.ts";
import { messageAuthorStore } from "./messageAuthors.ts";
import { LogicPacksAccess } from "./LogicPacksAccess.ts";
import { normalizePresencePath, presenceColorIndex } from "./presence.ts";
import { PresenceService } from "./PresenceService.ts";
import { memberSubject, memberUserIdFromSubject } from "./projectAccess.ts";

export const HOST_ACTOR_ID = "host";

/** What the operator is called in other people's presence. Never a real name by default. */
export const hostDisplayName = Config.String("LOGICPACKS_HOST_NAME").pipe(
  Config.withDefault("Host"),
  Effect.orElseSucceed(() => "Host"),
);

export interface PresenceOwner {
  readonly id: string;
  readonly name: string;
}

/** The person behind a session subject: a member by their display name, else the host. */
export const presenceOwnerFor = Effect.fn("logicpacks.presenceOwnerFor")(function* (
  subject: string,
) {
  const userId = memberUserIdFromSubject(subject);
  if (userId === null) return { id: HOST_ACTOR_ID, name: yield* hostDisplayName };
  const access = yield* LogicPacksAccess;
  const user = yield* access.getUser(userId).pipe(Effect.orElseSucceed(() => null));
  return { id: memberSubject(userId), name: user?.displayName ?? "Member" };
});

/** The label after the owner's name; a possessive the reporter added is dropped, the owner comes from the session. */
const agentLabelText = (label: string | undefined) =>
  label
    ?.trim()
    .replace(/^[^']*'s\s+/, "")
    .trim() || "agent";

export const agentActorFor = (
  owner: PresenceOwner,
  agentId: string,
  label?: string | undefined,
  colorIndex?: number,
): PresenceActor => ({
  id: `agent:${agentId}`,
  kind: "agent",
  name: `${owner.name}'s ${agentLabelText(label)}`,
  // An agent wears its owner's colour, so "Ali" and "Ali's agent" read as one team.
  colorIndex: colorIndex ?? presenceColorIndex(owner.id),
});

/**
 * One socket's (or one helper request's) view of presence. Reports are named
 * from the session, never from the payload, and scoped to visible projects.
 */
export const makePresenceConnection = Effect.fn("logicpacks.makePresenceConnection")(
  function* (input: {
    readonly subject: string;
    /** Null for stateless HTTP reports, which only expire. */
    readonly connectionId: string | null;
    readonly keyPrefix: string;
    readonly canSeeProject: (projectId: string) => boolean;
  }) {
    const presence = yield* PresenceService;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const owner = yield* presenceOwnerFor(input.subject);
    const configOption = yield* Effect.serviceOption(ServerConfig.ServerConfig);
    const ownerUserId = memberUserIdFromSubject(input.subject);
    // The admin's colour pick for this person, else the stable hash.
    const ownerColor = () =>
      configOption._tag === "Some"
        ? messageAuthorStore(configOption.value.stateDir).colorOf(ownerUserId)
        : presenceColorIndex(owner.id);

    const resolveProjectId = Effect.fn("logicpacks.presence.resolveProjectId")(function* (
      update: PresenceUpdateInput,
    ) {
      if (update.projectId !== undefined) return update.projectId;
      if (update.threadId === undefined) return null;
      const shell = yield* threads
        .getThreadShell(update.threadId)
        .pipe(Effect.orElseSucceed(() => null));
      return shell?.projectId ?? null;
    });

    const report = Effect.fn("logicpacks.presence.report")(function* (update: PresenceUpdateInput) {
      const projectId = yield* resolveProjectId(update);
      if (projectId === null || !input.canSeeProject(projectId)) return;
      const key = `${input.keyPrefix}:${update.clientId}`;
      const isAgent = update.actorKind === "agent" && update.source === "helper";
      const actor: PresenceActor = isAgent
        ? agentActorFor(owner, `${owner.id}:${update.clientId}`, update.agentLabel, ownerColor())
        : {
            id: owner.id,
            kind: "human",
            name: owner.name,
            colorIndex: ownerColor(),
          };
      yield* presence.write({
        key,
        clientId: update.clientId,
        connectionId: input.connectionId,
        projectId: projectId as ProjectId,
        threadId: update.threadId,
        actor,
        source: update.source,
        location: update.location === null ? null : normalizeLocationPath(update.location),
      });
    });

    const visible =
      (filter: PresenceSubscribeInput) =>
      (entry: PresenceEntry): boolean =>
        input.canSeeProject(entry.projectId) &&
        (filter.projectId === undefined || entry.projectId === filter.projectId);

    return {
      owner,
      report,
      subscribe: (filter: PresenceSubscribeInput) => presence.stream(visible(filter)),
      list: (filter: PresenceSubscribeInput) => presence.list(visible(filter)),
      close:
        input.connectionId === null ? Effect.void : presence.dropConnection(input.connectionId),
    };
  },
);

/** Drops a path that is not project-relative instead of rejecting the whole report. */
const normalizeLocationPath = (location: PresenceLocation): PresenceLocation => {
  const { path, ...rest } = location;
  const normalized = path === undefined ? null : normalizePresencePath(path);
  return normalized === null ? rest : { ...rest, path: normalized };
};
