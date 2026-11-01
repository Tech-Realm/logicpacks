import { ChevronsUpDownIcon } from "lucide-react";
import { useFeatures } from "./features";
import type { ReactNode } from "react";

import { cn } from "../lib/utils";
import { Button } from "../components/ui/button";
import { LogicPacksMark } from "../components/LogicPacksMark";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../components/ui/menu";
import { toastManager } from "../components/ui/toast";
import { requestTourReplay } from "../productTour/productTourStore";
import { lpApi, type LpSession } from "./api";
import { currentWorkspace, openLpDialog, switchWorkspace, useLogicPacksSession } from "./store";

const ALL_PROJECTS = "__all__";

function workspaceLabel(session: LpSession) {
  return currentWorkspace(session)?.name ?? (session.operator ? "All projects" : "No workspace");
}

function initials(session: LpSession) {
  const name = session.user?.displayName ?? "Host";
  return name.slice(0, 1).toUpperCase();
}

const reportFailure = (title: string) => (error: unknown) => {
  toastManager.add({
    type: "error",
    title,
    description: error instanceof Error ? error.message : undefined,
  });
};

/** Workspaces, switching, and the account actions. Shared by the header and the avatar. */
function WorkspaceMenuItems({ session }: { session: LpSession }) {
  const current = currentWorkspace(session);
  const { canRedeem } = useFeatures();
  return (
    <>
      <MenuGroup>
        <MenuGroupLabel>
          {session.user ? `${session.user.displayName} · ${session.user.email}` : "Host operator"}
        </MenuGroupLabel>
        <MenuRadioGroup
          value={session.currentWorkspaceId ?? ALL_PROJECTS}
          onValueChange={(value) => {
            const next = value === ALL_PROJECTS ? null : String(value);
            if (next === session.currentWorkspaceId) return;
            void switchWorkspace(next).catch(reportFailure("Could not switch workspace"));
          }}
        >
          {session.operator ? (
            <MenuRadioItem value={ALL_PROJECTS}>All projects on this host</MenuRadioItem>
          ) : null}
          {session.workspaces.map((workspace) => (
            <MenuRadioItem key={workspace.workspaceId} value={workspace.workspaceId}>
              {workspace.name}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuGroup>
      <MenuSeparator />
      <MenuItem onClick={() => openLpDialog({ kind: "new-workspace" })}>New workspace</MenuItem>
      <MenuItem onClick={() => openLpDialog({ kind: "add-project" })}>Add project</MenuItem>
      {current ? (
        <MenuItem
          onClick={() => openLpDialog({ kind: "manage", workspaceId: current.workspaceId })}
        >
          Manage workspace
        </MenuItem>
      ) : null}
      <MenuItem onClick={requestTourReplay} data-testid="lp-replay-tour-avatar">
        Replay tour
      </MenuItem>
      {session.user === null && session.operator ? (
        <>
          <MenuSeparator />
          <MenuItem
            data-testid="lp-your-agents"
            onClick={() => openLpDialog({ kind: "connect-claude" })}
          >
            Your agents
          </MenuItem>
          {canRedeem ? (
            <MenuItem
              data-testid="lp-redeem-code"
              onClick={() => openLpDialog({ kind: "redeem-code" })}
            >
              Enter access code
            </MenuItem>
          ) : null}
        </>
      ) : null}
      {session.user ? (
        <>
          <MenuSeparator />
          <MenuItem onClick={() => openLpDialog({ kind: "connect-claude" })}>
            {session.agentConnected || session.claude?.connected
              ? "Your agents"
              : "Connect your agent"}
          </MenuItem>
          <MenuItem
            data-testid="lp-redeem-code"
            onClick={() => openLpDialog({ kind: "redeem-code" })}
          >
            Redeem access code
          </MenuItem>
          <MenuItem
            onClick={() =>
              void lpApi
                .logout()
                .then(() => window.location.assign(new URL("/lp/login", window.location.href)))
                .catch(reportFailure("Could not sign out"))
            }
          >
            Sign out
          </MenuItem>
        </>
      ) : null}
    </>
  );
}

/**
 * The switcher's own width for the sidebar's minimum-width probe, so the desktop's back and
 * forward buttons never sit on top of the workspace name.
 */
export function WorkspaceSwitcherWidthProbe({ fallback }: { fallback: ReactNode }) {
  const { session } = useLogicPacksSession(false);
  if (session === null) return <>{fallback}</>;
  return (
    <Button size="sm" variant="ghost" tabIndex={-1}>
      <span className="max-w-40 truncate font-medium">{workspaceLabel(session)}</span>
      <ChevronsUpDownIcon className="size-3.5" />
    </Button>
  );
}

/**
 * The sidebar header on a LogicPacks host shows the workspace you are in.
 * Falls back to `fallback` (the brand) when the host has no LogicPacks
 * session, such as a plain remote environment.
 */
export function WorkspaceSwitcher({
  fallback,
  onBackdrop,
}: {
  fallback: ReactNode;
  onBackdrop: boolean;
}) {
  const { session } = useLogicPacksSession();
  if (session === null) return <>{fallback}</>;
  return (
    <div className="ml-[var(--workspace-titlebar-content-left)] flex min-w-0 items-center [-webkit-app-region:no-drag]">
      <Menu>
        <MenuTrigger
          render={
            <Button
              size="compact"
              variant={onBackdrop ? "media-navigation" : "ghost"}
              className="min-w-0 shrink"
              aria-label="Switch workspace"
              data-testid="lp-workspace-switcher"
            />
          }
        >
          <LogicPacksMark aria-hidden className="size-4 text-foreground" />
          <span className="min-w-0 truncate font-medium tracking-tight">
            {workspaceLabel(session)}
          </span>
        </MenuTrigger>
        <MenuPopup align="start">
          <WorkspaceMenuItems session={session} />
        </MenuPopup>
      </Menu>
    </div>
  );
}

/**
 * The sidebar footer's identity row: your avatar, your name and your agent's state. It opens
 * the account and workspace menu. `compact` keeps only the avatar (utility pages).
 */
export function WorkspaceAvatarMenu({ compact = false }: { compact?: boolean }) {
  const { session } = useLogicPacksSession();
  if (session === null) return null;
  const needsClaude =
    session.user !== null && session.claude?.connected !== true && session.agentConnected !== true;
  const name = session.user?.displayName ?? "Host";
  const status = session.user === null ? "This computer" : needsClaude ? "No agent" : "Agent ready";
  return (
    <>
      <Menu>
        <MenuTrigger
          render={
            <button
              type="button"
              aria-label="Account and workspaces"
              data-testid="lp-avatar"
              className={cn(
                "flex h-10 min-w-0 cursor-pointer items-center gap-2.5 rounded-row text-left outline-hidden transition-colors duration-(--lp-dur-1) ease-lp hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-ring data-[popup-open]:bg-sidebar-row-hover",
                compact ? "size-8 justify-center" : "flex-1 px-1.5",
              )}
            />
          }
        >
          <span
            className={cn(
              "flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
              session.user
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground",
            )}
          >
            {initials(session)}
          </span>
          {compact ? null : (
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-[13px] font-medium leading-tight text-sidebar-foreground">
                {name}
              </span>
              <span className="flex items-center gap-1.5 truncate text-[11px] leading-tight text-sidebar-muted-foreground">
                <span
                  aria-hidden
                  className={cn(
                    "size-1.5 shrink-0 rounded-full",
                    needsClaude ? "shadow-[inset_0_0_0_1.25px_currentColor]" : "bg-current",
                  )}
                />
                {status}
              </span>
            </span>
          )}
        </MenuTrigger>
        <MenuPopup align="start" side="top">
          <WorkspaceMenuItems session={session} />
        </MenuPopup>
      </Menu>
    </>
  );
}

/** Above the identity row until the signed-in person connects an agent. */
export function WorkspaceAgentNudge() {
  const { session } = useLogicPacksSession();
  if (session === null) return null;
  const needsClaude =
    session.user !== null && session.claude?.connected !== true && session.agentConnected !== true;
  if (!needsClaude) return null;
  return (
    <Button
      size="sm"
      variant="outline"
      className="w-full justify-center"
      data-testid="lp-connect-claude-nudge"
      onClick={() => openLpDialog({ kind: "connect-claude" })}
    >
      Connect your agent
    </Button>
  );
}
