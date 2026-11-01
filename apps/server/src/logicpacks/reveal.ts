import { CommandId, ProjectId } from "@logicpacks/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ProjectService from "../project/ProjectService.ts";

/**
 * Re-publishes a project once it is claimed. Its creation event reached the live
 * shell streams before the project had an owner or a workspace, so every fenced
 * stream, the creator's included, filtered it out. An unchanged title update is
 * a cheap event that the streams now let through.
 */
export const revealClaimedProject = Effect.fn("logicpacks.revealClaimedProject")(
  function* (projectId: string) {
    const projects = yield* Effect.serviceOption(ProjectService.ProjectService);
    if (Option.isNone(projects)) return;
    const id = ProjectId.make(projectId);
    const existing = yield* projects.value.getById(id);
    if (Option.isNone(existing)) return;
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    yield* projects.value.update({
      commandId: CommandId.make(`logicpacks-reveal:${projectId}:${now}`),
      projectId: id,
      title: existing.value.title,
    });
  },
  Effect.catchCause((cause) =>
    Effect.logWarning("Could not re-publish a claimed project", { cause }),
  ),
);
