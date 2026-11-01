/**
 * "Any app" live: the host's real app window, streamed to everyone in the
 * project, with named cursors, host-gated control, the action log and the
 * app's recipe for agents. Same layout as the /demo/machine film: context and
 * action log on the left, the live app and the app strip in the middle,
 * control and agents on the right.
 */
import type { AppStreamInput, DesktopShareableWindow } from "@logicpacks/contracts";
import {
  AppWindowIcon,
  CameraIcon,
  CopyIcon,
  HandIcon,
  OctagonXIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  ShieldCheckIcon,
  SparklesIcon,
  SquareIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { presenceColor } from "../../presence/presenceLogic";
import { lpApi, type LpAppOpSpec } from "../api";
import { AppStreamSession, type AppStreamCursor, type AppStreamStats } from "./appStreamSession";
import { installBenchProbe } from "./bench";

const GRANT_MINUTES = [5, 15, 60] as const;

function useSession(projectId: string, role: "host" | "viewer") {
  const session = useMemo(() => new AppStreamSession(projectId, role), [projectId, role]);
  // oxlint-disable-next-line logicpacks/no-unreasoned-state-sync -- opens the project's app-sharing socket for as long as the page is open
  useEffect(() => {
    void session.connect();
    const uninstall = installBenchProbe(session);
    return () => {
      uninstall();
      session.close();
    };
  }, [session]);
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot);
  return { session, snapshot };
}

function recipeFor(appName: string | undefined): string | null {
  const name = (appName ?? "").toLowerCase();
  if (name.includes("blender")) return "blender";
  if (name.includes("resolve")) return "resolve";
  return null;
}

const ageText = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};

export function LiveMachine({ projectId, title }: { projectId: string; title: string }) {
  const canHostHere = isElectron && window.desktopBridge?.appShare !== undefined;
  const [role, setRole] = useState<"host" | "viewer">(canHostHere ? "host" : "viewer");
  const { session, snapshot } = useSession(projectId, role);
  const [windows, setWindows] = useState<ReadonlyArray<DesktopShareableWindow>>([]);
  const [permissions, setPermissions] = useState<{ screen: string; accessibility: boolean } | null>(
    null,
  );
  const [now, setNow] = useState(() => Date.now());
  /** The shared window's width (points) when it was picked, to notice when it shrinks. */
  const [pickedWidth, setPickedWidth] = useState<number | null>(null);
  const state = snapshot.state;
  const app = state?.app ?? null;
  const you = snapshot.you;
  const isHost = role === "host" && snapshot.canHost;
  const myGrant = state?.grants.find((grant) => grant.subject === you?.subject) ?? null;
  const myRequest = state?.requests.find((request) => request.subject === you?.subject) ?? null;
  const recipeId = app?.recipeId ?? recipeFor(app?.appName);
  // Stage Manager and Spaces shrink windows that are not in front, and capture follows.
  const sharedNow = windows.find((window_) => window_.sourceId === snapshot.sharing?.sourceId);
  const shrunk =
    snapshot.sharing !== null &&
    sharedNow !== undefined &&
    pickedWidth !== null &&
    sharedNow.width < pickedWidth * 0.6;

  // oxlint-disable-next-line logicpacks/no-unreasoned-state-sync -- a one-second clock for grant countdowns
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const refreshWindows = async () => {
    const bridge = window.desktopBridge?.appShare;
    if (!bridge) return;
    setPermissions(await bridge.permissions());
    setWindows(await bridge.listWindows());
  };
  // oxlint-disable-next-line logicpacks/no-unreasoned-state-sync -- the host's list of shareable windows, refreshed while the page is open
  useEffect(() => {
    if (!isHost) return;
    void refreshWindows();
    const timer = setInterval(() => void refreshWindows(), 5000);
    return () => clearInterval(timer);
  }, [isHost]);

  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground"
      data-testid="live-machine"
      data-role={isHost ? "host" : "viewer"}
      data-transport={snapshot.stats.transport}
    >
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-4">
        <span className="truncate text-sm font-medium">{title}</span>
        <Badge variant="outline">
          <AppWindowIcon />
          {app ? app.appName : "Any app"}
        </Badge>
        <Badge variant="secondary">Beta</Badge>
        {app ? (
          <span
            className="flex items-center gap-1.5 text-xs text-muted-foreground"
            data-testid="live-machine-live"
          >
            <span className="size-1.5 rounded-full bg-success" /> Live from the host
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-3 text-xs text-muted-foreground">
          <StatsChip stats={snapshot.stats} isHost={isHost} />
          <PeopleStack people={state?.people ?? []} />
          {canHostHere ? (
            <Button
              size="compact"
              variant="ghost-muted"
              onClick={() => setRole(role === "host" ? "viewer" : "host")}
            >
              {role === "host" ? "Watch as a viewer" : "Host from this Mac"}
            </Button>
          ) : null}
        </div>
      </header>
      {snapshot.error ? (
        <div
          className="border-b border-border bg-warning/8 px-4 py-1.5 text-xs"
          data-testid="live-machine-error"
        >
          {snapshot.error}
        </div>
      ) : null}
      <div className="grid min-h-0 flex-1 grid-cols-[14rem_minmax(0,1fr)_19rem] gap-px bg-border/60">
        <aside className="flex min-h-0 flex-col bg-background" aria-label="App context">
          <ContextPanel app={app} recipeId={recipeId} projectId={projectId} />
          <ActionLog entries={snapshot.log} />
        </aside>
        <section className="flex min-h-0 min-w-0 flex-col bg-background" aria-label="Live app view">
          <LiveView
            session={session}
            stream={snapshot.stream}
            frameUrl={snapshot.frameUrl}
            app={app}
            isHost={isHost}
            controlling={myGrant !== null}
            cursors={snapshot.cursors}
          />
          {isHost && shrunk ? (
            <div
              className="flex items-center gap-2 border-t border-border bg-warning/8 px-3 py-1.5 text-xs"
              data-testid="live-machine-shrunk"
            >
              <span className="min-w-0 flex-1">
                {snapshot.sharing?.appName} is in the background, so people see it small. Keep it in
                front while you share.
              </span>
              <Button size="compact" variant="outline" onClick={() => session.focusShared()}>
                Bring to front
              </Button>
            </div>
          ) : null}
          {isHost ? (
            <WindowStrip
              windows={windows}
              sharingSourceId={snapshot.sharing?.sourceId ?? null}
              permissions={permissions}
              onPick={(window_) => {
                setPickedWidth(window_.width);
                void session.share(window_, recipeFor(window_.app));
              }}
              onRefresh={() => void refreshWindows()}
            />
          ) : null}
        </section>
        <aside className="flex min-h-0 flex-col overflow-y-auto bg-background" aria-label="Control">
          {isHost ? (
            <HostControl
              session={session}
              requests={state?.requests ?? []}
              grants={state?.grants ?? []}
              sharing={snapshot.sharing !== null}
              hidden={snapshot.hidden}
              hiddenError={snapshot.hiddenError}
              accessibility={permissions?.accessibility ?? null}
              now={now}
            />
          ) : (
            <ViewerControl
              session={session}
              shared={app !== null}
              grantLeftMs={myGrant ? myGrant.expiresAtMs - now : null}
              requested={myRequest !== null}
            />
          )}
          <AgentRecipe projectId={projectId} recipeId={recipeId} />
        </aside>
      </div>
    </div>
  );
}

function StatsChip({ stats, isHost }: { stats: AppStreamStats; isHost: boolean }) {
  const parts = [
    isHost
      ? null
      : stats.transport === "webrtc"
        ? "WebRTC P2P"
        : stats.transport === "jpeg"
          ? "Relay (JPEG)"
          : stats.transport === "connecting"
            ? "Connecting"
            : null,
    stats.codec ? stats.codec.replace("video/", "") : null,
    stats.fps !== null ? `${Math.round(stats.fps)} fps` : null,
    stats.bitrateKbps !== null ? `${(stats.bitrateKbps / 1000).toFixed(1)} Mbps` : null,
    stats.rttMs !== null ? `${stats.rttMs} ms to server` : null,
  ].filter(Boolean);
  if (parts.length === 0) return null;
  return (
    <span className="hidden tabular-nums md:inline" data-testid="live-machine-stats">
      {parts.join(" · ")}
    </span>
  );
}

function PeopleStack({
  people,
}: {
  people: ReadonlyArray<{ key: string; name: string; colorIndex: number; role: string }>;
}) {
  return (
    <span className="flex -space-x-1.5" data-testid="live-machine-people">
      {people.map((person) => (
        <span
          key={person.key}
          title={`${person.name}${person.role === "host" ? " (host)" : ""}`}
          className="inline-flex size-6 items-center justify-center rounded-full border-2 border-background text-2xs font-semibold text-black"
          style={{ backgroundColor: presenceColor(person.colorIndex) }}
        >
          {person.name.slice(0, 1).toUpperCase()}
        </span>
      ))}
    </span>
  );
}

function ContextPanel({
  app,
  recipeId,
  projectId,
}: {
  app: { appName: string; title: string; width: number; height: number } | null;
  recipeId: string | null;
  projectId: string;
}) {
  const [objects, setObjects] = useState<ReadonlyArray<{ id: string; name: string; type: string }>>(
    [],
  );
  // oxlint-disable-next-line logicpacks/no-unreasoned-state-sync -- polls the Blender outline through the read-only op while Blender is shared
  useEffect(() => {
    if (recipeId !== "blender") return;
    let cancelled = false;
    const load = async () => {
      const out = await lpApi.runAppOp(projectId, "blender.objects", [], "human").catch(() => null);
      if (cancelled || !out) return;
      setObjects(((out.result as { objects?: unknown[] })?.objects ?? []) as never);
    };
    void load();
    const timer = setInterval(() => void load(), 4000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [projectId, recipeId]);
  return (
    <div
      className="flex min-h-0 flex-1 flex-col px-3 py-3 text-xs"
      data-testid="live-machine-context"
    >
      <div className="pb-2 text-2xs font-medium tracking-wide text-muted-foreground uppercase">
        Shared app
      </div>
      {app ? (
        <div className="space-y-1">
          <div className="font-medium">{app.appName}</div>
          <div className="truncate text-muted-foreground" title={app.title}>
            {app.title}
          </div>
          <div className="text-muted-foreground tabular-nums">
            {app.width} x {app.height}
          </div>
        </div>
      ) : (
        <p className="text-muted-foreground">Nothing is shared yet. The host picks a window.</p>
      )}
      {recipeId === "blender" && objects.length > 0 ? (
        <>
          <div className="pt-4 pb-1.5 text-2xs font-medium tracking-wide text-muted-foreground uppercase">
            Scene
          </div>
          <ul className="min-h-0 space-y-0.5 overflow-y-auto" data-testid="live-machine-outline">
            {objects.map((object) => (
              <li key={object.id} className="flex items-center gap-1.5 truncate">
                <SquareIcon className="size-3 shrink-0 opacity-50" />
                {object.name}
                <span className="ml-auto text-3xs text-muted-foreground">
                  {object.type.toLowerCase()}
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

function ActionLog({
  entries,
}: {
  entries: ReadonlyArray<{
    id: string;
    atMs: number;
    actor: string;
    op: string;
    detail: string;
    ok: boolean;
    source: string;
    snapshot?: string;
  }>;
}) {
  const recent = entries.slice(-8).toReversed();
  return (
    <div
      className="shrink-0 border-t border-border px-2 py-3"
      data-testid="live-machine-action-log"
    >
      <div className="flex items-center px-2 pb-2 text-2xs font-medium tracking-wide text-muted-foreground uppercase">
        Action log
        <span className="ml-auto normal-case tracking-normal">semantic ops</span>
      </div>
      <ol className="space-y-1">
        {recent.length === 0 ? (
          <li className="px-2 text-xs text-muted-foreground">
            Ops appear here as people and agents work.
          </li>
        ) : null}
        {recent.map((entry) => (
          <li
            key={entry.id}
            className={cn(
              "rounded-md border border-border/70 px-2 py-1.5",
              entry.snapshot && "border-dashed",
              !entry.ok && "border-warning/60 bg-warning/8",
            )}
            data-demo-motion="rise"
            data-testid="live-machine-log-entry"
          >
            <div className="flex items-center gap-1.5 text-3xs text-muted-foreground">
              {entry.source === "agent" ? <SparklesIcon className="size-3" /> : null}
              <span className="truncate">{entry.actor}</span>
              <span className="ml-auto shrink-0 tabular-nums">
                {new Date(entry.atMs).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                  second: "2-digit",
                })}
              </span>
            </div>
            <div className="truncate font-mono text-2xs" title={`${entry.op} ${entry.detail}`}>
              {entry.op} {entry.detail}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

const keyInput = (event: React.KeyboardEvent, down: boolean): AppStreamInput => ({
  kind: "key",
  code: event.code,
  down,
  shift: event.shiftKey,
  ctrl: event.ctrlKey,
  alt: event.altKey,
  meta: event.metaKey,
});

function LiveView({
  session,
  stream,
  frameUrl,
  app,
  isHost,
  controlling,
  cursors,
}: {
  session: AppStreamSession;
  stream: MediaStream | null;
  frameUrl: string | null;
  app: { width: number; height: number; appName: string } | null;
  isHost: boolean;
  controlling: boolean;
  cursors: ReadonlyArray<AppStreamCursor>;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const lastMove = useRef(0);
  // The video mounts only once the app is known, which can be after the stream arrives.
  const attachVideo = (video: HTMLVideoElement | null) => {
    if (video && video.srcObject !== stream) {
      video.srcObject = stream;
      if (stream) void video.play().catch(() => undefined);
    }
  };
  const ratio = app && app.width > 0 && app.height > 0 ? app.width / app.height : 16 / 10;
  const point = (event: React.PointerEvent) => {
    const box = boxRef.current!.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)),
      y: Math.min(1, Math.max(0, (event.clientY - box.top) / box.height)),
    };
  };
  const send = (ev: AppStreamInput) => {
    if (controlling && !isHost) session.input(ev);
  };
  const hasPicture = stream !== null || frameUrl !== null;
  return (
    <div className="relative flex min-h-0 flex-1 items-center justify-center bg-black/90 p-3 [container-type:size] dark:bg-black/40">
      {app === null ? (
        <p className="max-w-72 text-center text-sm text-white/70" data-testid="live-machine-empty">
          {isHost
            ? "Pick a window below to share it with the project."
            : "Waiting for the host to share an app."}
        </p>
      ) : (
        <div
          ref={boxRef}
          tabIndex={0}
          className={cn(
            "relative overflow-hidden rounded-md bg-black outline-none",
            controlling && !isHost && "ring-2 ring-success cursor-none",
          )}
          // Fit the window's shape inside the panel, whichever side is the limit.
          style={{ aspectRatio: String(ratio), width: `min(100cqw, ${ratio} * 100cqh)` }}
          data-testid="live-machine-view"
          data-controlling={controlling || undefined}
          onPointerMove={(event) => {
            const now = performance.now();
            if (now - lastMove.current < 16) return;
            lastMove.current = now;
            const p = point(event);
            session.cursor(p.x, p.y);
            send({ kind: "move", ...p });
          }}
          onPointerDown={(event) => {
            boxRef.current?.focus();
            send({
              kind: "down",
              ...point(event),
              button: event.button === 2 ? 2 : event.button === 1 ? 1 : 0,
            });
          }}
          onPointerUp={(event) =>
            send({
              kind: "up",
              ...point(event),
              button: event.button === 2 ? 2 : event.button === 1 ? 1 : 0,
            })
          }
          onContextMenu={(event) => controlling && event.preventDefault()}
          onWheel={(event) =>
            send({
              kind: "scroll",
              ...point(event as unknown as React.PointerEvent),
              dx: event.deltaX,
              dy: event.deltaY,
            })
          }
          onKeyDown={(event) => {
            if (!controlling || isHost) return;
            event.preventDefault();
            send(keyInput(event, true));
          }}
          onKeyUp={(event) => {
            if (!controlling || isHost) return;
            event.preventDefault();
            send(keyInput(event, false));
          }}
        >
          {stream ? (
            <video
              ref={attachVideo}
              muted
              playsInline
              autoPlay
              className="size-full object-fill"
              data-testid="live-machine-video"
            />
          ) : frameUrl ? (
            <img
              src={frameUrl}
              alt={`${app.appName} on the host`}
              className="size-full object-fill"
              draggable={false}
              data-testid="live-machine-frame"
            />
          ) : null}
          {!hasPicture ? (
            <div className="absolute inset-0 flex items-center justify-center text-xs text-white/60">
              Connecting to the host
            </div>
          ) : null}
          {cursors.map((cursor) => (
            <NamedCursor key={cursor.key} cursor={cursor} />
          ))}
        </div>
      )}
    </div>
  );
}

function NamedCursor({ cursor }: { cursor: AppStreamCursor }) {
  const color = presenceColor(cursor.colorIndex);
  return (
    <div
      className="pointer-events-none absolute z-20 transition-[left,top] duration-75 ease-out"
      style={{ left: `${cursor.x * 100}%`, top: `${cursor.y * 100}%` }}
      data-testid="live-machine-cursor"
      data-cursor-name={cursor.name}
    >
      <svg width="18" height="22" viewBox="0 0 18 22" className="relative text-white drop-shadow">
        <path
          d="M1 1 L1 18 L5.5 13.8 L8.6 21 L11.6 19.7 L8.6 12.6 L15 12.6 Z"
          fill={color}
          stroke="currentColor"
          strokeWidth="1.3"
        />
      </svg>
      <span
        className={cn(
          "absolute top-4 left-3 flex items-center gap-1 rounded-full px-2 py-0.5 text-2xs font-semibold whitespace-nowrap text-black shadow-md",
          cursor.x > 0.8 && "-left-3 -translate-x-full",
        )}
        style={{ backgroundColor: color }}
      >
        {cursor.controlling ? <HandIcon className="size-3" /> : null}
        {cursor.name}
      </span>
    </div>
  );
}

function WindowStrip({
  windows,
  sharingSourceId,
  permissions,
  onPick,
  onRefresh,
}: {
  windows: ReadonlyArray<DesktopShareableWindow>;
  sharingSourceId: string | null;
  permissions: { screen: string; accessibility: boolean } | null;
  onPick: (window: DesktopShareableWindow) => void;
  onRefresh: () => void;
}) {
  const blocked = permissions !== null && permissions.screen !== "granted";
  return (
    <div className="shrink-0 border-t border-border" data-testid="live-machine-windows">
      <div className="flex items-center gap-2 px-3 pt-2 text-2xs font-medium tracking-wide text-muted-foreground uppercase">
        Share an app
        <Button
          size="icon-xs"
          variant="ghost-muted"
          aria-label="Refresh windows"
          onClick={onRefresh}
        >
          <RefreshCwIcon />
        </Button>
        {blocked ? (
          <span className="normal-case tracking-normal text-warning-foreground">
            Turn on Screen Recording for LogicPacks in System Settings, Privacy and Security.
          </span>
        ) : null}
      </div>
      <div className="flex items-stretch gap-2 overflow-x-auto px-3 pt-2 pb-3">
        {windows.map((window_) => (
          <button
            key={window_.sourceId}
            type="button"
            onClick={() => onPick(window_)}
            aria-pressed={window_.sourceId === sharingSourceId}
            className={cn(
              "group flex w-40 shrink-0 flex-col overflow-hidden rounded-lg border bg-card text-left transition-colors",
              window_.sourceId === sharingSourceId
                ? "border-foreground/60"
                : "border-border hover:border-foreground/30",
            )}
            data-testid="live-machine-window"
            data-app={window_.app}
            data-title={window_.title}
          >
            <div className="relative aspect-video w-full overflow-hidden bg-black">
              {window_.thumbnail ? (
                <img
                  src={window_.thumbnail}
                  alt=""
                  draggable={false}
                  className="size-full object-contain"
                />
              ) : null}
            </div>
            <div className="flex items-center gap-1.5 px-2 py-1.5 text-2xs">
              <span className="truncate font-medium">{window_.app}</span>
              {window_.sourceId === sharingSourceId ? (
                <span
                  className="ml-auto size-1.5 shrink-0 rounded-full bg-success"
                  aria-label="Shared"
                />
              ) : null}
            </div>
          </button>
        ))}
        {windows.length === 0 ? (
          <div className="px-1 py-4 text-xs text-muted-foreground">No windows found yet.</div>
        ) : null}
      </div>
    </div>
  );
}

function HostControl({
  session,
  requests,
  grants,
  sharing,
  hidden,
  hiddenError,
  accessibility,
  now,
}: {
  session: AppStreamSession;
  requests: ReadonlyArray<{ subject: string; name: string }>;
  grants: ReadonlyArray<{ subject: string; name: string; expiresAtMs: number }>;
  sharing: boolean;
  hidden: boolean;
  hiddenError: string | null;
  accessibility: boolean | null;
  now: number;
}) {
  const [minutes, setMinutes] = useState<number>(15);
  return (
    <div
      className="space-y-4 border-b border-border px-3 py-3 text-xs"
      data-testid="live-machine-host-control"
    >
      <div className="flex items-center gap-2 text-2xs font-medium tracking-wide text-muted-foreground uppercase">
        <ShieldCheckIcon className="size-3.5" /> Control
      </div>
      {accessibility === false ? (
        <p className="rounded-md border border-warning/40 bg-warning/8 p-2">
          To let approved people use the app, turn on Accessibility for LogicPacks in System
          Settings, Privacy and Security.{" "}
          <button
            type="button"
            className="underline"
            onClick={() => void window.desktopBridge?.appShare?.requestAccessibility()}
          >
            Ask macOS
          </button>
        </p>
      ) : null}
      <div className="space-y-1.5">
        <div className="text-muted-foreground">Requests</div>
        {requests.length === 0 ? (
          <p className="text-muted-foreground">Nobody is asking for control.</p>
        ) : null}
        {requests.map((request) => (
          <div
            key={request.subject}
            className="flex items-center gap-1.5 rounded-md border border-border p-1.5"
            data-testid="live-machine-request"
          >
            <span className="min-w-0 flex-1 truncate font-medium">{request.name}</span>
            <Button
              size="compact"
              onClick={() => session.grant(request.subject, minutes)}
              data-testid="live-machine-approve"
            >
              Allow {minutes} min
            </Button>
            <Button
              size="compact"
              variant="ghost-muted"
              onClick={() => session.deny(request.subject)}
            >
              Deny
            </Button>
          </div>
        ))}
        <div className="flex items-center gap-1 text-muted-foreground">
          Time limit
          {GRANT_MINUTES.map((value) => (
            <button
              key={value}
              type="button"
              className={cn(
                "rounded px-1.5 py-0.5",
                value === minutes ? "bg-accent text-foreground" : "hover:bg-accent",
              )}
              onClick={() => setMinutes(value)}
            >
              {value}m
            </button>
          ))}
        </div>
      </div>
      <div className="space-y-1.5">
        <div className="text-muted-foreground">In control</div>
        {grants.length === 0 ? <p className="text-muted-foreground">Only you.</p> : null}
        {grants.map((grant) => (
          <div
            key={grant.subject}
            className="flex items-center gap-1.5 rounded-md border border-success/40 p-1.5"
            data-testid="live-machine-grant"
          >
            <HandIcon className="size-3.5" />
            <span className="min-w-0 flex-1 truncate font-medium">{grant.name}</span>
            <span className="tabular-nums text-muted-foreground">
              {ageText(grant.expiresAtMs - now)}
            </span>
            <Button
              size="compact"
              variant="ghost-muted"
              onClick={() => session.revoke(grant.subject)}
              data-testid="live-machine-revoke"
            >
              Revoke
            </Button>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="destructive"
          size="compact"
          onClick={() => session.kill()}
          data-testid="live-machine-kill"
        >
          <OctagonXIcon /> Stop all control
        </Button>
        <span className="text-muted-foreground">or press Cmd Shift Esc anywhere</span>
      </div>
      {sharing ? (
        <div className="space-y-1.5" data-testid="live-machine-hidden">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={hidden}
              onChange={(event) => void session.setHidden(event.target.checked)}
              data-testid="live-machine-hidden-toggle"
            />
            <span className="font-medium">Run on a hidden display</span>
          </label>
          <p className="text-muted-foreground">
            The app moves off your screen so you keep working while others use it. Your cursor and
            keyboard stay yours. Some shortcuts and Open or Save panels need the app in front.
          </p>
          {hiddenError ? (
            <p className="text-warning" data-testid="live-machine-hidden-error">
              Hidden display unavailable: {hiddenError}
            </p>
          ) : null}
        </div>
      ) : null}
      {sharing ? (
        <Button
          size="compact"
          variant="ghost-muted"
          onClick={() => void session.stopSharing()}
          data-testid="live-machine-stop"
        >
          Stop sharing
        </Button>
      ) : null}
    </div>
  );
}

function ViewerControl({
  session,
  shared,
  grantLeftMs,
  requested,
}: {
  session: AppStreamSession;
  shared: boolean;
  grantLeftMs: number | null;
  requested: boolean;
}) {
  return (
    <div
      className="space-y-3 border-b border-border px-3 py-3 text-xs"
      data-testid="live-machine-viewer-control"
    >
      <div className="flex items-center gap-2 text-2xs font-medium tracking-wide text-muted-foreground uppercase">
        <HandIcon className="size-3.5" /> Control
      </div>
      {grantLeftMs !== null ? (
        <>
          <p data-testid="live-machine-you-control">
            You have control for {ageText(grantLeftMs)}. Click into the app and work; the host sees
            your cursor and can take it back at any time.
          </p>
          <Button size="compact" variant="ghost-muted" onClick={() => session.releaseControl()}>
            Give control back
          </Button>
        </>
      ) : requested ? (
        <p className="text-muted-foreground" data-testid="live-machine-waiting">
          Asked the host. You can use the app once they allow it.
        </p>
      ) : (
        <Button
          size="compact"
          disabled={!shared}
          onClick={() => session.requestControl()}
          data-testid="live-machine-request-control"
        >
          Request control
        </Button>
      )}
    </div>
  );
}

function AgentRecipe({ projectId, recipeId }: { projectId: string; recipeId: string | null }) {
  const [ops, setOps] = useState<ReadonlyArray<LpAppOpSpec>>([]);
  const [snapshots, setSnapshots] = useState<ReadonlyArray<{ name: string }>>([]);
  const [canControl, setCanControl] = useState(false);
  const loadSnapshots = async () => {
    if (recipeId !== "blender") return;
    const out = await lpApi.runAppOp(projectId, "blender.snapshots", [], "human").catch(() => null);
    setSnapshots(
      ((out?.result as { snapshots?: { name: string }[] })?.snapshots ?? []).toReversed(),
    );
  };
  // oxlint-disable-next-line logicpacks/no-unreasoned-state-sync -- loads the op list and snapshots for the shared app
  useEffect(() => {
    void lpApi
      .appOps(projectId)
      .then((out) => {
        setOps(out.ops);
        setCanControl(out.canControl);
      })
      .catch(() => undefined);
    void loadSnapshots();
    const timer = setInterval(() => void loadSnapshots(), 6000);
    return () => clearInterval(timer);
  }, [projectId, recipeId]);
  const app = recipeId === "blender" ? "blender" : recipeId === "resolve" ? "resolve" : "any";
  const shown = ops.filter((op) => op.app === app).slice(0, 8);
  return (
    <div className="space-y-2 px-3 py-3 text-xs" data-testid="live-machine-recipe">
      <div className="flex items-center gap-2 text-2xs font-medium tracking-wide text-muted-foreground uppercase">
        <SparklesIcon className="size-3.5" /> Agents
        <span className="ml-auto normal-case tracking-normal">
          {app === "blender"
            ? "Blender recipe"
            : app === "resolve"
              ? "Resolve recipe"
              : "Any app recipe"}
        </span>
      </div>
      <p className="text-muted-foreground">
        Agents work through ops, not pixels. Each one lands in the action log under their name.
      </p>
      <ul className="space-y-1 font-mono text-2xs">
        {shown.map((op) => (
          <li key={op.name} className="flex items-center gap-1">
            <span className="min-w-0 flex-1 truncate" title={op.summary}>
              lp app run {op.usage.replace(/^\S+\s?/, `${op.name} `)}
            </span>
            <button
              type="button"
              aria-label={`Copy ${op.name}`}
              className="opacity-50 hover:opacity-100"
              onClick={() => void navigator.clipboard?.writeText(`lp app run ${op.usage}`)}
            >
              <CopyIcon className="size-3" />
            </button>
          </li>
        ))}
      </ul>
      {recipeId === "blender" ? (
        <div className="space-y-1.5 pt-2">
          <div className="flex items-center gap-1.5 text-muted-foreground">
            <CameraIcon className="size-3.5" /> Snapshots
            {canControl ? (
              <Button
                size="compact"
                variant="ghost-muted"
                className="ml-auto"
                onClick={() =>
                  void lpApi
                    .runAppOp(projectId, "blender.snapshot", [], "human")
                    .then(loadSnapshots)
                }
                data-testid="live-machine-snapshot"
              >
                Snapshot now
              </Button>
            ) : null}
          </div>
          {snapshots.slice(0, 5).map((snapshot) => (
            <div
              key={snapshot.name}
              className="flex items-center gap-1.5"
              data-testid="live-machine-snapshot-row"
            >
              <span className="min-w-0 flex-1 truncate font-mono text-2xs">{snapshot.name}</span>
              {canControl ? (
                <Button
                  size="compact"
                  variant="ghost-muted"
                  onClick={() =>
                    void lpApi
                      .runAppOp(projectId, "blender.restore", [snapshot.name], "human")
                      .then(loadSnapshots)
                  }
                >
                  <RotateCcwIcon /> Restore
                </Button>
              ) : null}
            </div>
          ))}
          {snapshots.length === 0 ? (
            <p className="text-muted-foreground">An agent's first edit takes one automatically.</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
