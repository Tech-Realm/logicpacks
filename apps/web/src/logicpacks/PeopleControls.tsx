import type { EnvironmentId, PresenceEntry, ProjectId } from "@logicpacks/contracts";
import { PaletteIcon, PlusIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "../components/ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../components/ui/popover";
import { presenceColor } from "../presence/presenceLogic";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { cn } from "../lib/utils";
import { useProjectPresence } from "../presence/usePresence";
import { lpApi, type LpUser, type LpWorkspaceMember } from "./api";
import { currentWorkspace, openLpDialog, useLogicPacksSession } from "./store";

/**
 * People are first-class in the LogicPacks layout (DESIGN.md, Layout): the sidebar's
 * workspace block and the top bar both show who is in the room. Avatars are monochrome:
 * ink for someone here now, a well for someone who is not.
 */

const MAX_FACES = 4;

// One fetch per workspace for the whole tab; the Manage dialog is where the list changes.
const membersByWorkspace = new Map<string, Promise<ReadonlyArray<LpWorkspaceMember>>>();

function loadMembers(workspaceId: string) {
  let pending = membersByWorkspace.get(workspaceId);
  if (pending === undefined) {
    pending = lpApi
      .members(workspaceId)
      .then((result) => result.members)
      .catch(() => {
        membersByWorkspace.delete(workspaceId);
        return [];
      });
    membersByWorkspace.set(workspaceId, pending);
  }
  return pending;
}

/** Everyone in the current workspace, you first. Empty until it loads or without a workspace. */
export function useLpWorkspacePeople(): ReadonlyArray<LpUser> {
  const { session } = useLogicPacksSession(false);
  const workspaceId = currentWorkspace(session)?.workspaceId ?? null;
  const selfId = session?.user?.userId ?? null;
  const [loaded, setLoaded] = useState<{
    workspaceId: string;
    people: ReadonlyArray<LpUser>;
  } | null>(null);
  // oxlint-disable-next-line logicpacks/no-unreasoned-state-sync -- loads the workspace's members from the LogicPacks API when the workspace changes
  useEffect(() => {
    if (workspaceId === null) return;
    let live = true;
    void loadMembers(workspaceId).then((members) => {
      if (!live) return;
      const people = members.map((member) => member.user);
      people.sort((a, b) => Number(b.userId === selfId) - Number(a.userId === selfId));
      setLoaded({ workspaceId, people });
    });
    return () => {
      live = false;
    };
  }, [workspaceId, selfId]);
  return loaded !== null && loaded.workspaceId === workspaceId ? loaded.people : [];
}

const initial = (name: string) => name.trim().slice(0, 1).toUpperCase() || "?";

function isHere(person: LpUser, presence: ReadonlyArray<PresenceEntry>) {
  return presence.some(
    (entry) =>
      entry.actor.kind !== "agent" &&
      (entry.actor.id === person.userId || entry.actor.name === person.displayName),
  );
}

export function LpFace({
  name,
  here,
  className,
}: {
  name: string;
  here: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      data-lp-face={here ? "here" : "away"}
      className={cn(
        "relative inline-flex size-6 shrink-0 select-none items-center justify-center rounded-full text-[10.5px] font-semibold leading-none ring-2 ring-(--lp-face-ring,var(--background))",
        here ? "bg-foreground text-background" : "bg-well-strong text-foreground/75",
        className,
      )}
    >
      {initial(name)}
    </span>
  );
}

function peopleLine(
  people: ReadonlyArray<LpUser>,
  here: ReadonlySet<string>,
  selfId: string | null,
) {
  return people
    .map((person) => {
      const name = person.userId === selfId ? `${person.displayName} (you)` : person.displayName;
      return here.has(person.userId) ? `${name}, here now` : name;
    })
    .join(". ");
}

const SWATCHES = [0, 1, 2, 3, 4, 5, 6, 7] as const;

/** Workspace owners pick each person's colour (avatars and message tags). Hidden for everyone else. */
function LpPersonColors({ workspaceId }: { workspaceId: string }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<{
    members: ReadonlyArray<LpWorkspaceMember>;
    canManage: boolean;
  } | null>(null);
  // oxlint-disable-next-line logicpacks/no-unreasoned-state-sync -- loads member colours from the LogicPacks API when the popover opens
  useEffect(() => {
    if (!open) return;
    let live = true;
    void lpApi
      .members(workspaceId)
      .then((result) => live && setState(result))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [open, workspaceId]);
  const pick = (userId: string, color: number) => {
    setState((current) =>
      current === null
        ? current
        : {
            ...current,
            members: current.members.map((m) => (m.user.userId === userId ? { ...m, color } : m)),
          },
    );
    membersByWorkspace.delete(workspaceId);
    void lpApi.setPersonColor(userId, color).catch(() => undefined);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost"
            data-testid="lp-people-colors-open"
            aria-label="Choose people colours"
          />
        }
      >
        <PaletteIcon aria-hidden />
      </PopoverTrigger>
      <PopoverPopup side="bottom" align="start" className="w-72" data-testid="lp-people-colors">
        <div className="flex flex-col gap-2">
          <p className="text-xs font-medium text-muted-foreground">People colours</p>
          {state === null ? (
            <p className="text-sm text-muted-foreground">Loading</p>
          ) : !state.canManage ? (
            <p className="text-sm text-muted-foreground">Only a workspace owner can change colours.</p>
          ) : (
            state.members.map((member) => (
              <div key={member.user.userId} className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate text-sm">{member.user.displayName}</span>
                <span className="flex shrink-0 gap-1">
                  {SWATCHES.map((color) => (
                    <button
                      key={color}
                      type="button"
                      data-testid="lp-color-swatch"
                      data-color={color}
                      aria-label={`Colour ${color + 1} for ${member.user.displayName}`}
                      aria-pressed={member.color === color}
                      onClick={() => pick(member.user.userId, color)}
                      className={cn(
                        "size-4 cursor-pointer rounded-full ring-offset-1 ring-offset-background",
                        member.color === color && "ring-2 ring-foreground",
                      )}
                      style={{ backgroundColor: presenceColor(color) }}
                    />
                  ))}
                </span>
              </div>
            ))
          )}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

/**
 * The top bar's people: everyone in the workspace, with whoever is in this project now
 * drawn in ink. You count as here.
 */
export function LpProjectPeople({
  projectId,
  environmentId,
}: {
  projectId: ProjectId;
  environmentId: EnvironmentId | null;
}) {
  const { session } = useLogicPacksSession(false);
  const people = useLpWorkspacePeople();
  const presence = useProjectPresence(environmentId, projectId);
  if (people.length === 0) return null;
  const selfId = session?.user?.userId ?? null;
  const here = new Set(
    people
      .filter((person) => person.userId === selfId || isHere(person, presence))
      .map((person) => person.userId),
  );
  // People here now lead the stack.
  const ordered = [...people].sort(
    (a, b) => Number(here.has(b.userId)) - Number(here.has(a.userId)),
  );
  const shown = ordered.slice(0, MAX_FACES);
  const overflow = ordered.length - shown.length;
  const line = peopleLine(ordered, here, selfId);
  const workspaceId = currentWorkspace(session)?.workspaceId ?? null;
  return (
    <span className="inline-flex shrink-0 items-center gap-1">
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={`In this workspace: ${line}`}
            data-testid="lp-project-people"
            className="inline-flex shrink-0 items-center -space-x-1.5 [-webkit-app-region:no-drag]"
          />
        }
      >
        {shown.map((person) => (
          <LpFace key={person.userId} name={person.displayName} here={here.has(person.userId)} />
        ))}
        {overflow > 0 ? (
          <span className="relative inline-flex h-6 items-center rounded-full bg-well-strong px-1.5 text-[10.5px] font-semibold text-muted-foreground ring-2 ring-background">
            +{overflow}
          </span>
        ) : null}
      </TooltipTrigger>
      <TooltipPopup side="bottom">
        <div className="flex flex-col gap-0.5">
          {ordered.map((person) => (
            <span key={person.userId} className="flex items-center gap-1.5">
              <span
                aria-hidden
                className={cn(
                  "size-1.5 rounded-full",
                  here.has(person.userId)
                    ? "bg-current"
                    : "shadow-[inset_0_0_0_1.25px_currentColor]",
                )}
              />
              {person.displayName}
              {person.userId === selfId ? " (you)" : ""}
            </span>
          ))}
        </div>
      </TooltipPopup>
    </Tooltip>
    {workspaceId !== null ? <LpPersonColors workspaceId={workspaceId} /> : null}
    </span>
  );
}

/**
 * The sidebar's people row: everyone in the workspace and a round Invite button.
 * Invite keeps its old test id, so flows that click it keep working.
 */
export function LpWorkspacePeopleRow() {
  const { session } = useLogicPacksSession();
  const workspace = currentWorkspace(session);
  const people = useLpWorkspacePeople();
  if (workspace === null) return null;
  const shown = people.slice(0, 6);
  const overflow = people.length - shown.length;
  const selfId = session?.user?.userId ?? null;
  return (
    <div
      className="flex min-w-0 items-center gap-2 [--lp-face-ring:var(--lp-canvas)]"
      data-testid="lp-workspace-people"
    >
      {people.length > 0 ? (
        <span
          role="img"
          aria-label={`${people.length} ${people.length === 1 ? "person" : "people"} in ${workspace.name}: ${people.map((person) => person.displayName).join(", ")}`}
          className="inline-flex min-w-0 items-center -space-x-1.5"
        >
          {shown.map((person) => (
            <LpFace key={person.userId} name={person.displayName} here={person.userId === selfId} />
          ))}
          {overflow > 0 ? (
            <span className="relative inline-flex h-6 items-center rounded-full bg-well-strong px-1.5 text-[10.5px] font-semibold text-muted-foreground ring-2 ring-(--lp-face-ring)">
              +{overflow}
            </span>
          ) : null}
        </span>
      ) : null}
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="icon-xs"
              variant="outline"
              className="rounded-full border-dashed [-webkit-app-region:no-drag]"
              data-testid="lp-invite"
              aria-label="Invite"
              onClick={() => openLpDialog({ kind: "manage", workspaceId: workspace.workspaceId })}
            />
          }
        >
          <PlusIcon aria-hidden />
        </TooltipTrigger>
        <TooltipPopup side="bottom">Invite people to {workspace.name}</TooltipPopup>
      </Tooltip>
      {people.length <= 1 ? (
        <button
          type="button"
          className="truncate text-xs text-muted-foreground transition-colors duration-(--lp-dur-1) ease-lp hover:text-foreground"
          onClick={() => openLpDialog({ kind: "manage", workspaceId: workspace.workspaceId })}
        >
          Invite your team
        </button>
      ) : null}
    </div>
  );
}

/** Under a new thread's headline: who you are building with, or a nudge to invite someone. */
export function LpDraftPeopleLine() {
  const { session } = useLogicPacksSession(false);
  const workspace = currentWorkspace(session);
  const people = useLpWorkspacePeople();
  if (workspace === null || people.length === 0) return null;
  const selfId = session?.user?.userId ?? null;
  const others = people.filter((person) => person.userId !== selfId);
  const names = others.slice(0, 2).map((person) => person.displayName);
  const rest = others.length - names.length;
  return (
    <div
      className="mt-4 flex min-w-0 items-center gap-2.5 text-sm text-muted-foreground"
      data-testid="lp-draft-people"
    >
      <span aria-hidden className="inline-flex shrink-0 items-center -space-x-1.5">
        {people.slice(0, 4).map((person) => (
          <LpFace key={person.userId} name={person.displayName} here={person.userId === selfId} />
        ))}
      </span>
      {others.length === 0 ? (
        <span className="min-w-0 truncate">
          Only you in {workspace.name} so far.{" "}
          <button
            type="button"
            className="cursor-pointer text-foreground underline decoration-hairline-strong underline-offset-4 transition-colors duration-(--lp-dur-1) ease-lp hover:decoration-foreground"
            onClick={() => openLpDialog({ kind: "manage", workspaceId: workspace.workspaceId })}
          >
            Invite someone
          </button>
        </span>
      ) : (
        <span className="min-w-0 truncate">
          Building with {rest > 0 ? `${names.join(", ")} and ${rest} more` : names.join(" and ")}
        </span>
      )}
    </div>
  );
}
