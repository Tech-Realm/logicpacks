import type { PresenceEntry, PresenceLocation, ProjectId } from "@logicpacks/contracts";

import { PresenceAvatarStack } from "../presence/PresenceAvatarStack";
import { entriesInApp, entriesOnAppObject, presenceColor } from "../presence/presenceLogic";
import { usePresenceReporter, useProjectPresence } from "../presence/usePresence";
import { usePrimaryEnvironmentId } from "../state/environments";

/**
 * Live presence in an app recipe's workspace, on the same channel as files: who is on
 * which object in the outline, everyone in the app in the header, and each person's
 * pointer over the live view. App recipes run on the LogicPacks host, which is the
 * primary environment.
 */
export function useAppPresence(input: {
  readonly projectId: string;
  /** Null while the app is not on screen: this tab then reports nothing. */
  readonly location: PresenceLocation | null;
}): ReadonlyArray<PresenceEntry> {
  const environmentId = usePrimaryEnvironmentId();
  const projectId = input.projectId as ProjectId;
  usePresenceReporter({ environmentId, projectId, surface: "app", location: input.location });
  return useProjectPresence(environmentId, projectId);
}

/** Avatars on one outline row: the people and agents on that object right now. */
export function AppItemPresence({
  entries,
  recipeId,
  item,
}: {
  entries: ReadonlyArray<PresenceEntry>;
  recipeId: string;
  item: { readonly id: string | null; readonly name: string };
}) {
  return (
    <PresenceAvatarStack entries={entriesOnAppObject(entries, recipeId, item)} className="ml-1" />
  );
}

/** Everyone in the app, for the panel's header. */
export function AppPresenceBar({
  entries,
  recipeId,
}: {
  entries: ReadonlyArray<PresenceEntry>;
  recipeId: string;
}) {
  return <PresenceAvatarStack entries={entriesInApp(entries, recipeId)} withPath />;
}

/**
 * Canva-style cursors over the live view: an arrow in the person's colour with their
 * name, and what they have selected. Agents have no pointer; their flag sits in the
 * corner with the object they are working on.
 */
export function AppCursors({
  entries,
  recipeId,
}: {
  entries: ReadonlyArray<PresenceEntry>;
  recipeId: string;
}) {
  const inApp = entriesInApp(entries, recipeId);
  const pointers = inApp.filter((entry) => entry.location.pointer !== undefined);
  const agents = inApp.filter(
    (entry) => entry.actor.kind === "agent" && entry.location.appItem !== undefined,
  );
  if (pointers.length === 0 && agents.length === 0) return null;
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
      {pointers.map((entry) => {
        const color = presenceColor(entry.actor.colorIndex);
        const pointer = entry.location.pointer!;
        const on = entry.location.appItem?.label ?? entry.location.appItem?.itemId;
        return (
          <div
            key={entry.key}
            className="absolute transition-[left,top] duration-100 ease-out"
            style={{ left: `${pointer.x * 100}%`, top: `${pointer.y * 100}%` }}
            data-app-cursor={entry.actor.name}
          >
            <svg viewBox="0 0 16 16" className="size-4 text-background drop-shadow-sm" fill={color}>
              <path d="M1 1 L14 7 L8 8.5 L6 14 Z" stroke="currentColor" strokeWidth="1" />
            </svg>
            <span
              className="absolute top-3.5 left-3 rounded-sm px-1.5 py-0.5 text-3xs font-semibold whitespace-nowrap text-primary-foreground"
              style={{ backgroundColor: color }}
            >
              {entry.actor.name}
              {on ? ` · ${on}` : ""}
            </span>
          </div>
        );
      })}
      {agents.length > 0 ? (
        <ul className="absolute top-2 right-2 flex flex-col items-end gap-1">
          {agents.map((entry) => (
            <li
              key={entry.key}
              className="rounded-sm px-1.5 py-0.5 text-3xs font-semibold text-primary-foreground"
              style={{ backgroundColor: presenceColor(entry.actor.colorIndex) }}
              data-app-agent={entry.actor.name}
            >
              {entry.actor.name} {entry.location.activity}{" "}
              {entry.location.appItem!.label ?? entry.location.appItem!.itemId}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
