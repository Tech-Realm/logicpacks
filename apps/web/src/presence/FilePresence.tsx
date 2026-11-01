import type { EnvironmentId, ProjectId } from "@logicpacks/contracts";

import { entriesInFile } from "./presenceLogic";
import { PresenceAvatarStack } from "./PresenceAvatarStack";
import { useProjectPresence } from "./usePresence";

/**
 * Avatars for one file, subscribing on its own so a tab or diff header
 * re-renders on presence changes without re-rendering its whole panel.
 */
export function FilePresence(props: {
  readonly environmentId: EnvironmentId | null;
  readonly projectId: ProjectId | null | undefined;
  readonly path: string;
  readonly className?: string;
}) {
  const presence = useProjectPresence(props.environmentId, props.projectId);
  return (
    <PresenceAvatarStack
      entries={entriesInFile(presence, props.path)}
      {...(props.className ? { className: props.className } : {})}
    />
  );
}
