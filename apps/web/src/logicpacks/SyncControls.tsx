import type { EnvironmentId } from "@logicpacks/contracts";
import { useCloudSyncLocked } from "./features";
import {
  CloudAlertIcon,
  CloudIcon,
  CloudOffIcon,
  CloudUploadIcon,
  TriangleAlertIcon,
  UserPlusIcon,
} from "lucide-react";
import { useState, type FormEvent } from "react";

import { type ComposerBannerStackItem } from "../components/chat/ComposerBannerStack";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { DialogDescription, DialogHeader, DialogPanel, DialogTitle } from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "../components/ui/popover";
import { Toggle, ToggleGroup } from "../components/ui/toggle-group";
import { toastManager } from "../components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { usePrimaryEnvironmentId } from "../state/environments";
import { lpApi, type LpProjectSync, type LpSession, type LpSyncState } from "./api";
import { closeLpDialog, openLpDialog, useLogicPacksSession } from "./store";
import { applySyncStatus, refreshSyncStatus, useCloudHost, useProjectSync } from "./sync";

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "Something went wrong.";

const LABEL: Record<LpSyncState, string> = {
  not_synced: "Not synced",
  syncing: "Syncing",
  synced: "Synced",
  conflict: "Conflict",
  error: "Sync paused",
};

/** What the small "Not synced" chip says when it is clicked and sync cannot be turned on yet. */
export const SYNC_SOON_NOTE =
  "Sync is coming soon, so your projects keep running even when the host shuts off.";

const VARIANT = {
  not_synced: "outline",
  syncing: "info",
  synced: "success",
  conflict: "warning",
  error: "error",
} as const;

/** Sync status only exists for projects on the server this app signed in to. */
function useLpProjectSync(projectId: string | null, environmentId: EnvironmentId | null) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { session } = useLogicPacksSession(false);
  const status = useProjectSync(projectId);
  if (session === null || environmentId === null || environmentId !== primaryEnvironmentId) {
    return null;
  }
  return status;
}

function describe(status: LpProjectSync, cloudHost: boolean): string {
  switch (status.state) {
    case "not_synced":
      return cloudHost
        ? "Not on GitHub yet. Sync backs it up and keeps every checkout in step."
        : "Only on this computer. Teammates can't see it until you sync.";
    case "syncing":
      return status.message ?? "Syncing";
    case "synced":
      return status.behind > 0
        ? `${status.behind} new change${status.behind === 1 ? "" : "s"} from teammates, pulling after the current turn.`
        : cloudHost || status.cloudUrl === null
          ? "On the cloud host. Everyone in the workspace works on it, and agents keep running."
          : `Shared through ${new URL(status.cloudUrl).host}. Work keeps going there when this computer is off.`;
    case "conflict":
      return `${status.conflictFiles.join(", ") || "Some files"} changed here and by ${status.theirsAuthor ?? "a teammate"}.`;
    case "error":
      return status.message ?? "Sync stopped. Retry, or ask the agent to look.";
  }
}

export function LpSyncBadge({
  projectId,
  environmentId,
  title,
  compact = false,
}: {
  projectId: string;
  environmentId: EnvironmentId | null;
  title: string;
  compact?: boolean;
}) {
  const status = useLpProjectSync(projectId, environmentId);
  const cloud = useCloudHost();
  const cloudLocked = useCloudSyncLocked();
  if (status === null) return null;
  if (cloudLocked && status.state === "not_synced") {
    // One small, quiet chip in the project header; nothing in the sidebar rows. It does not
    // advertise anything: a click only says why there is nothing to turn on yet.
    if (compact) return null;
    return (
      <Popover>
        <PopoverTrigger
          render={
            <button
              type="button"
              data-testid="lp-cloud-sync-soon"
              data-sync-state="not_synced"
              aria-label={`${LABEL.not_synced}: ${title}`}
              className="inline-flex h-5 min-w-0 cursor-pointer items-center truncate whitespace-nowrap rounded-pill px-1.5 text-2xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
              onClick={(event) => event.stopPropagation()}
            />
          }
        >
          {LABEL.not_synced}
        </PopoverTrigger>
        <PopoverPopup side="bottom" align="start" className="w-64" data-testid="lp-cloud-sync-note">
          <p className="text-sm text-muted-foreground">{SYNC_SOON_NOTE}</p>
        </PopoverPopup>
      </Popover>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Badge
            render={<button type="button" />}
            variant={VARIANT[status.state]}
            size="sm"
            data-testid="lp-sync-badge"
            data-sync-state={status.state}
            data-lp-dot={
              status.state === "not_synced" ? "ring" : status.state === "syncing" ? "pulse" : ""
            }
            aria-label={`${LABEL[status.state]}: ${title}`}
            onClick={(event) => {
              event.stopPropagation();
              openLpDialog({ kind: "sync-project", projectId, title });
            }}
          />
        }
      >
        {compact ? <span className="sr-only">{LABEL[status.state]}</span> : LABEL[status.state]}
      </TooltipTrigger>
      <TooltipPopup side="bottom">{describe(status, cloud?.isCloudHost === true)}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * Shares the open project with another LogicPacks user in one step. Signed-in people and the
 * host's own operator (a laptop's owner shares by link and sets what people can do).
 */
export function LpShareProjectButton({
  projectId,
  environmentId,
  title,
}: {
  projectId: string;
  environmentId: EnvironmentId | null;
  title: string;
}) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { session } = useLogicPacksSession(false);
  if (session === null || environmentId !== primaryEnvironmentId) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="xs"
            variant="ghost"
            data-testid="lp-share-project-open"
            aria-label={`Share ${title}`}
            onClick={(event) => {
              event.stopPropagation();
              openLpDialog({ kind: "share-project", projectId, title });
            }}
          />
        }
      >
        <UserPlusIcon aria-hidden />
        Share
      </TooltipTrigger>
      <TooltipPopup side="bottom">Share this project with someone on LogicPacks</TooltipPopup>
    </Tooltip>
  );
}

/** Starts Sync, or asks for the cloud host first when this computer has none yet. */
export async function startProjectSync(projectId: string, title: string) {
  try {
    const result = await lpApi.startSync(projectId);
    applySyncStatus(result.status);
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 409) {
      openLpDialog({ kind: "sync-project", projectId, title });
      return;
    }
    toastManager.add({ type: "error", title: "Could not sync", description: errorText(error) });
  }
}

const resolve = async (projectId: string, strategy: "mine" | "theirs") => {
  try {
    applySyncStatus((await lpApi.resolveConflict(projectId, strategy)).status);
    toastManager.add({ type: "success", title: "Conflict resolved and pushed" });
  } catch (error) {
    toastManager.add({ type: "error", title: "Could not resolve", description: errorText(error) });
  }
};

const syncNow = async (projectId: string) => {
  try {
    applySyncStatus((await lpApi.syncNow(projectId)).status);
  } catch (error) {
    toastManager.add({ type: "error", title: "Could not sync", description: errorText(error) });
  }
};

const dismissedReminders = new Set<string>();

/** The composer notice for the open project: the not-synced reminder, progress, or a conflict. */
export function useLpSyncBanner(input: {
  projectId: string | null;
  environmentId: EnvironmentId | null;
  title: string | null;
}): ComposerBannerStackItem | null {
  const status = useLpProjectSync(input.projectId, input.environmentId);
  const cloud = useCloudHost();
  const cloudLocked = useCloudSyncLocked();
  const [, setDismissTick] = useState(0);
  if (status === null || input.projectId === null) return null;
  if (cloudLocked && status.state === "not_synced") return null;
  const projectId = input.projectId;
  const title = input.title ?? "this project";
  const cloudHost = cloud?.isCloudHost === true;
  switch (status.state) {
    case "synced":
      return null;
    case "not_synced":
      if (dismissedReminders.has(projectId)) return null;
      return {
        id: `lp-sync:${projectId}`,
        variant: "default",
        icon: <CloudOffIcon />,
        title: "Not synced",
        description: status.message ?? describe(status, cloudHost),
        actions: (
          <Button
            size="xs"
            variant="outline"
            data-testid="lp-sync-start"
            onClick={() => void startProjectSync(projectId, title)}
          >
            <CloudUploadIcon />
            Sync
          </Button>
        ),
        dismissLabel: "Not now",
        onDismiss: () => {
          dismissedReminders.add(projectId);
          setDismissTick((tick) => tick + 1);
        },
      };
    case "syncing":
      return {
        id: `lp-sync:${projectId}`,
        variant: "info",
        icon: <CloudUploadIcon />,
        title: "Syncing",
        description: describe(status, cloudHost),
      };
    case "conflict":
      return {
        id: `lp-sync:${projectId}`,
        variant: "warning",
        icon: <TriangleAlertIcon />,
        title: "Sync conflict",
        description: `${describe(status, cloudHost)} Pick a side for the conflicting lines, or ask the agent to merge them.`,
        actions: (
          <>
            <Button
              size="xs"
              variant="ghost"
              data-testid="lp-sync-keep-theirs"
              onClick={() => void resolve(projectId, "theirs")}
            >
              Keep theirs
            </Button>
            <Button
              size="xs"
              variant="outline"
              data-testid="lp-sync-keep-mine"
              onClick={() => void resolve(projectId, "mine")}
            >
              Keep mine
            </Button>
          </>
        ),
      };
    case "error":
      return {
        id: `lp-sync:${projectId}`,
        variant: "error",
        icon: <CloudAlertIcon />,
        title: "Sync paused",
        description: describe(status, cloudHost),
        actions: (
          <Button
            size="xs"
            variant="outline"
            onClick={() =>
              void (status.remoteUrl === null
                ? startProjectSync(projectId, title)
                : syncNow(projectId))
            }
          >
            Retry
          </Button>
        ),
      };
  }
}

function ConnectCloudForm({ onConnected }: { onConnected: () => void }) {
  const cloud = useCloudHost();
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [url, setUrl] = useState(cloud?.url ?? "https://app.logicpacks.io");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      await lpApi.connectCloud({
        url: url.trim(),
        mode,
        email: email.trim(),
        password,
        ...(mode === "signup" && name.trim() ? { displayName: name.trim() } : {}),
      });
      await refreshSyncStatus();
      onConnected();
    } catch (cause) {
      setError(errorText(cause));
    }
    // The catch never rethrows, so this always runs (React Compiler cannot lower `finally`).
    setPending(false);
  };
  return (
    <form className="flex flex-col gap-3" onSubmit={(event) => void submit(event)}>
      <ToggleGroup
        aria-label="Account"
        value={[mode]}
        onValueChange={(value) => {
          const next = value[0] as "login" | "signup" | undefined;
          if (next) setMode(next);
        }}
      >
        <Toggle value="login">I have an account</Toggle>
        <Toggle value="signup">Create one</Toggle>
      </ToggleGroup>
      <Input
        aria-label="Cloud host"
        name="cloudUrl"
        placeholder="https://app.logicpacks.io"
        required
        value={url}
        onChange={(event) => setUrl(event.target.value)}
      />
      {mode === "signup" ? (
        <Input
          aria-label="Your name"
          name="displayName"
          placeholder="Your name"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      ) : null}
      <Input
        aria-label="Email"
        name="email"
        type="email"
        placeholder="you@example.com"
        required
        value={email}
        onChange={(event) => setEmail(event.target.value)}
      />
      <Input
        aria-label="Password"
        name="password"
        type="password"
        placeholder="Password"
        required
        minLength={8}
        value={password}
        onChange={(event) => setPassword(event.target.value)}
      />
      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      <Button type="submit" disabled={pending} data-testid="lp-cloud-connect">
        {pending ? "Connecting" : "Connect and sync"}
      </Button>
    </form>
  );
}

/** Sync for one project: connect the cloud host once, then one button; afterwards, where it lives. */
export function SyncProjectDialog({
  projectId,
  title,
  session,
}: {
  projectId: string;
  title: string;
  session: LpSession;
}) {
  const status = useProjectSync(projectId);
  const cloud = useCloudHost();
  const cloudLocked = useCloudSyncLocked();
  const needsCloud = cloud !== null && !cloud.isCloudHost && !cloud.connected && session.operator;
  const start = async () => {
    closeLpDialog();
    await startProjectSync(projectId, title);
  };
  const state = status?.state ?? "not_synced";
  const synced =
    state === "synced" || state === "conflict" || (state === "error" && status?.remoteUrl);
  if (cloudLocked && !synced) {
    return (
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription data-testid="lp-cloud-sync-soon">
          Cloud sync: coming soon
        </DialogDescription>
      </DialogHeader>
    );
  }
  return (
    <>
      <DialogHeader>
        <DialogTitle>{synced ? `${title} is synced` : `Sync ${title}`}</DialogTitle>
        <DialogDescription>
          {synced
            ? describe(status!, cloud?.isCloudHost === true)
            : cloud?.isCloudHost
              ? "Pushes it to a private GitHub repository. Everyone in the workspace already works here, and every checkout pulls and pushes on its own."
              : "Pushes it to a private GitHub repository and puts it on your cloud host for everyone in your workspace. Agents keep working there when this computer is off."}
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        {synced && status ? (
          <div className="flex flex-col gap-3 text-sm">
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
              <dt className="text-muted-foreground">Repository</dt>
              <dd className="truncate font-mono text-xs">{status.remoteUrl}</dd>
              {status.cloudUrl ? (
                <>
                  <dt className="text-muted-foreground">Cloud host</dt>
                  <dd className="truncate">
                    <a
                      className="underline underline-offset-2"
                      href={status.cloudUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {new URL(status.cloudUrl).host}
                    </a>
                  </dd>
                </>
              ) : null}
              {status.lastSyncedAt ? (
                <>
                  <dt className="text-muted-foreground">Last synced</dt>
                  <dd>{new Date(status.lastSyncedAt).toLocaleTimeString()}</dd>
                </>
              ) : null}
            </dl>
            {status.cloudUrl ? (
              <p className="text-muted-foreground">
                Agents on the cloud host run on your own Claude login.{" "}
                <a
                  className="underline underline-offset-2"
                  href={`${status.cloudUrl}/lp/account`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Connect Claude there
                </a>{" "}
                so they keep going while this computer is off.
              </p>
            ) : null}
            <Button size="sm" variant="outline" onClick={() => void syncNow(projectId)}>
              Sync now
            </Button>
          </div>
        ) : needsCloud ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">
              Sign in to your cloud host once. Your teammates join it with your workspace invite.
            </p>
            <ConnectCloudForm onConnected={() => void start()} />
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {cloud && !cloud.isCloudHost ? (
              <p className="text-sm text-muted-foreground">
                Cloud host: {new URL(cloud.url).host}
                {cloud.account ? ` as ${cloud.account}` : ""}
              </p>
            ) : null}
            <Button data-testid="lp-sync-confirm" onClick={() => void start()}>
              <CloudIcon />
              Sync
            </Button>
          </div>
        )}
      </DialogPanel>
    </>
  );
}
