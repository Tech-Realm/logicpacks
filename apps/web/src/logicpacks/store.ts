import { useEffect } from "react";
import { create } from "zustand";

import {
  DEFAULT_MODEL_BY_PROVIDER,
  ProviderDriverKind,
  ProviderInstanceId,
  type EnvironmentId,
  type ServerSettings,
} from "@logicpacks/contracts";

import { clearCachedShellSnapshots } from "../connection/storage";
import { isElectron } from "../env";
import { readPrimaryEnvironmentId, usePrimaryEnvironmentId } from "../state/environments";
import { lpApi, type LpSession, type LpWorkspace } from "./api";
import type { UploadItem } from "./projectFiles.logic";

type SessionStatus = "idle" | "loading" | "ready" | "unavailable";

/** Which LogicPacks dialog is open. One at a time, like the rest of the app's hosts. */
export type LpDialog =
  | { readonly kind: "manage"; readonly workspaceId: string }
  | { readonly kind: "new-workspace" }
  | { readonly kind: "add-project" }
  | { readonly kind: "connect-claude" }
  | { readonly kind: "redeem-code" }
  | { readonly kind: "share-project"; readonly projectId: string; readonly title: string }
  | { readonly kind: "sync-project"; readonly projectId: string; readonly title: string }
  | { readonly kind: "get-local"; readonly projectId: string; readonly title: string }
  | {
      readonly kind: "upload-files";
      readonly projectId: string;
      readonly title: string;
      readonly folder: string;
      /** Files already dropped on the file tree. */
      readonly items?: ReadonlyArray<UploadItem>;
    };

interface LogicPacksState {
  readonly status: SessionStatus;
  readonly session: LpSession | null;
  readonly dialog: LpDialog | null;
}

const useLogicPacksStore = create<LogicPacksState>(() => ({
  status: "idle",
  session: null,
  dialog: null,
}));

let pendingLoad: Promise<void> | null = null;

/** Reloads the session; a server without the LogicPacks layer leaves it unavailable. */
export function refreshLogicPacksSession(): Promise<void> {
  if (pendingLoad) return pendingLoad;
  if (useLogicPacksStore.getState().status === "idle") {
    useLogicPacksStore.setState({ status: "loading" });
  }
  pendingLoad = lpApi
    .session()
    .then((session) => useLogicPacksStore.setState({ status: "ready", session }))
    .catch(() => {
      if (useLogicPacksStore.getState().session === null) {
        useLogicPacksStore.setState({ status: "unavailable" });
      }
    })
    .finally(() => {
      pendingLoad = null;
    });
  return pendingLoad;
}

export function useLogicPacksSession(enabled = true) {
  const state = useLogicPacksStore((store) => store);
  // oxlint-disable-next-line logicpacks/no-unreasoned-state-sync -- loads the LogicPacks session once the primary environment is signed in
  useEffect(() => {
    if (enabled && state.status === "idle") void refreshLogicPacksSession();
  }, [enabled, state.status]);
  return state;
}

export function currentWorkspace(session: LpSession | null): LpWorkspace | null {
  if (session === null || session.currentWorkspaceId === null) return null;
  return (
    session.workspaces.find((workspace) => workspace.workspaceId === session.currentWorkspaceId) ??
    null
  );
}

/** For event handlers outside React render. */
export const readLogicPacksSession = () => useLogicPacksStore.getState().session;

export const isMemberSession = (session: LpSession | null) => session?.user != null;

export function openLpDialog(dialog: LpDialog) {
  useLogicPacksStore.setState({ dialog });
}

export function closeLpDialog() {
  useLogicPacksStore.setState({ dialog: null });
}

export function useLpDialog() {
  return useLogicPacksStore((store) => store.dialog);
}

/**
 * The live sidebar follows the current workspace on the server, so a switch
 * starts the app over from home, the way switching a workspace does elsewhere.
 */
export async function switchWorkspace(workspaceId: string | null) {
  await lpApi.switchWorkspace(workspaceId);
  await reloadAtHome();
}

export async function reloadAtHome() {
  await clearCachedShellSnapshots();
  if (isElectron) {
    window.location.hash = "#/";
  } else {
    window.history.replaceState(null, "", "/");
  }
  window.location.reload();
}

/**
 * A member's own Claude login on this host, once connected. Host settings are
 * the operator's, so a member's new threads would otherwise default to a login
 * the host refuses to lend them.
 */
export function useMemberClaudeInstance(environmentId: EnvironmentId | null): string | null {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  return useLogicPacksStore((store) =>
    memberClaudeInstanceOf(store.session, environmentId, primaryEnvironmentId),
  );
}

/** For event handlers outside React render, such as starting a new thread. */
export const readMemberClaudeInstance = (environmentId: EnvironmentId | null): string | null =>
  memberClaudeInstanceOf(
    useLogicPacksStore.getState().session,
    environmentId,
    readPrimaryEnvironmentId(),
  );

function memberClaudeInstanceOf(
  session: LpSession | null,
  environmentId: EnvironmentId | null,
  primaryEnvironmentId: EnvironmentId | null,
): string | null {
  return session?.user != null &&
    session.claude?.connected === true &&
    environmentId !== null &&
    environmentId === primaryEnvironmentId
    ? session.claude.instanceId
    : null;
}

const CLAUDE_DEFAULT_MODEL =
  DEFAULT_MODEL_BY_PROVIDER[ProviderDriverKind.make("claudeAgent")] ?? "claude-opus-5-5";

export function withMemberClaudeDefault(
  settings: ServerSettings,
  instanceId: string | null,
): ServerSettings {
  if (instanceId === null || settings.defaultModelSelection?.instanceId === instanceId) {
    return settings;
  }
  return {
    ...settings,
    defaultModelSelection: {
      instanceId: ProviderInstanceId.make(instanceId),
      model: CLAUDE_DEFAULT_MODEL,
    },
  };
}

/**
 * The machine name members see. They never see the host's own name: it is LOGICPACKS_HOST_LABEL,
 * or "<workspace> cloud". Null keeps the environment's label (the desktop owner's own view).
 */
export function lpHostLabelFor(session: LpSession | null): string | null {
  if (session === null) return null;
  if (!isMemberSession(session) && session.cloudHost !== true) return null;
  if (session.hostLabel) return session.hostLabel;
  const workspace = currentWorkspace(session);
  return workspace ? `${workspace.name} cloud` : "LogicPacks cloud";
}

export function useLpHostLabel(): string | null {
  return lpHostLabelFor(useLogicPacksStore((store) => store.session));
}

/** The signed-in viewer is a LogicPacks member (not the host's own operator). */
export function useLpIsMember(): boolean {
  return useLogicPacksStore((store) => isMemberSession(store.session));
}
