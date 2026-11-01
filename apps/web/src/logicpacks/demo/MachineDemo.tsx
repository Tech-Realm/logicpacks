import {
  AppWindowIcon,
  ArrowRightIcon,
  BoxIcon,
  CameraIcon,
  CheckIcon,
  ClapperboardIcon,
  CodeIcon,
  FileCodeIcon,
  FilmIcon,
  FolderIcon,
  GlobeIcon,
  LaptopIcon,
  LightbulbIcon,
  PauseIcon,
  PlayIcon,
  RotateCcwIcon,
  SparklesIcon,
  TriangleAlertIcon,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useEffectEvent, useState, type CSSProperties, type ReactNode } from "react";

import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { cn } from "../../lib/utils";
import "./machineDemo.css";
import blenderImage from "./assets/blender-studio.webp";
import blenderMergedImage from "./assets/blender-studio-merged.webp";
import browserDocsImage from "./assets/browser-docs.webp";
import browserReferenceImage from "./assets/browser-reference.webp";
import resolveCutImage from "./assets/resolve-cut.webp";
import resolveEditImage from "./assets/resolve-edit.webp";
import {
  CODE_LINES,
  CONTEXT_ITEMS,
  DEMO_ACTORS,
  DEMO_APP_ORDER,
  DEMO_APPS,
  DEMO_CHAPTERS,
  DEMO_DURATION_MS,
  DEMO_PEOPLE,
  SNAPSHOT_ACTIONS,
  SNAPSHOT_AT_MS,
  actionLogAt,
  agentMessagesAt,
  appOfActorAt,
  chapterAt,
  codeLinesAt,
  conflictAt,
  cursorsAt,
  focusAppAt,
  formatDemoTime,
  presenceOnItems,
  snapshotAt,
  turnsFor,
  viewFor,
  type CursorState,
  type DemoActor,
  type DemoActorId,
  type DemoAppId,
  type DemoView,
} from "./machineDemoScript";

const VIEW_IMAGE: Record<Exclude<DemoView, "code">, { src: string; ratio: number }> = {
  blender: { src: blenderImage, ratio: 1600 / 875 },
  blenderMerged: { src: blenderMergedImage, ratio: 1600 / 875 },
  resolveEdit: { src: resolveEditImage, ratio: 1600 / 894 },
  resolveCut: { src: resolveCutImage, ratio: 1600 / 894 },
  browserDocs: { src: browserDocsImage, ratio: 1440 / 850 },
  browserReference: { src: browserReferenceImage, ratio: 1440 / 900 },
};

const APP_ICON: Record<DemoAppId, LucideIcon> = {
  blender: BoxIcon,
  resolve: ClapperboardIcon,
  browser: GlobeIcon,
  code: CodeIcon,
};

const ITEM_ICON: Record<string, LucideIcon> = {
  camera: CameraIcon,
  mesh: BoxIcon,
  light: LightbulbIcon,
  bin: FolderIcon,
  clip: FilmIcon,
  timeline: ClapperboardIcon,
  track: FilmIcon,
  tab: GlobeIcon,
  folder: FolderIcon,
  file: FileCodeIcon,
};

/** Where each replayed snapshot op lands in the Blender view, for the replay marker. */
const REPLAY_POINT = [
  { x: 64, y: 72 },
  { x: 64, y: 72 },
  { x: 38, y: 46 },
  { x: 38, y: 46 },
  { x: 43, y: 45 },
  { x: 52, y: 38 },
];

/** Follows the play state with requestAnimationFrame; the clock stops at the end. */
function useDemoClock(initialTime: number, autoplay: boolean) {
  const [time, setTime] = useState(initialTime);
  const [playing, setPlaying] = useState(autoplay && initialTime < DEMO_DURATION_MS);

  // oxlint-disable-next-line logicpacks/no-unreasoned-state-sync -- the clock is driven by animation frames, an external timer.
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const delta = now - last;
      last = now;
      setTime((current) => Math.min(DEMO_DURATION_MS, current + delta));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing]);

  const ended = time >= DEMO_DURATION_MS;
  if (ended && playing) setPlaying(false);

  return {
    time,
    playing,
    toggle: () => {
      if (ended) setTime(0);
      setPlaying((value) => !value || ended);
    },
    restart: () => {
      setTime(0);
      setPlaying(true);
    },
    seek: (next: number) => setTime(Math.min(DEMO_DURATION_MS, Math.max(0, next))),
  };
}

export interface MachineDemoProps {
  /** Start position in ms; `?t=` sets it from the URL. */
  readonly initialTime?: number;
  readonly autoplay?: boolean;
}

export function MachineDemo({ initialTime = 0, autoplay = true }: MachineDemoProps) {
  const clock = useDemoClock(initialTime, autoplay);
  const [pinnedApp, setPinnedApp] = useState<DemoAppId | null>(null);
  const t = clock.time;
  const app = pinnedApp ?? focusAppAt(t);
  const toggle = () => {
    setPinnedApp(null);
    clock.toggle();
  };

  const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (event.code !== "Space" || event.repeat) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest("input, textarea, [contenteditable='true'], button")) return;
    event.preventDefault();
    toggle();
  });
  // oxlint-disable-next-line logicpacks/no-unreasoned-state-sync -- subscribes to window key presses for Space to play.
  useEffect(() => {
    const listener = (event: KeyboardEvent) => onKeyDown(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground"
      data-testid="machine-demo"
      data-demo-time={Math.round(t)}
      data-demo-app={app}
    >
      <DemoHeader app={app} t={t} />
      <div className="grid min-h-0 flex-1 grid-cols-[13.5rem_minmax(0,1fr)_19rem] gap-px bg-border/60">
        <aside className="flex min-h-0 flex-col bg-background" aria-label="App context">
          <ContextPanel app={app} t={t} />
          <ActionLog t={t} />
        </aside>
        <section className="flex min-h-0 min-w-0 flex-col bg-background" aria-label="Live app view">
          <LiveAppView app={app} t={t} />
          <WindowStrip
            app={app}
            t={t}
            onSelect={(next) => {
              setPinnedApp(next);
              if (clock.playing) clock.toggle();
            }}
          />
        </section>
        <aside
          className="flex min-h-0 flex-col overflow-y-auto bg-background"
          aria-label="Activity"
        >
          <AgentTurns t={t} />
          <AgentChannel t={t} />
        </aside>
      </div>
      <Transport
        t={t}
        playing={clock.playing}
        onToggle={toggle}
        onRestart={() => {
          setPinnedApp(null);
          clock.restart();
        }}
        onSeek={(next) => {
          setPinnedApp(null);
          clock.seek(next);
        }}
      />
    </div>
  );
}

function DemoHeader({ app, t }: { app: DemoAppId; t: number }) {
  const meta = DEMO_APPS[app];
  const Icon = APP_ICON[app];
  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-4">
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate text-sm font-medium">Launch Film</span>
        <Badge variant="outline">
          <Icon />
          {meta.recipe} recipe
        </Badge>
        <Badge variant="secondary" data-testid="machine-demo-coming-soon">
          Beta
        </Badge>
        <span className="hidden truncate text-xs text-muted-foreground xl:inline">
          Scripted preview. Beta.
        </span>
      </div>
      <div className="ml-auto flex items-center gap-3">
        <span className="hidden items-center gap-1.5 text-xs text-muted-foreground md:flex">
          <span className="size-1.5 rounded-full bg-foreground" />
          Studio Mac, shared host
        </span>
        <AvatarStack
          actors={Object.values(DEMO_ACTORS).filter((actor) => appOfActorAt(actor.id, t) !== null)}
        />
        <span className="w-24 truncate text-right text-xs text-muted-foreground">
          {chapterAt(t).label}
        </span>
      </div>
    </header>
  );
}

function Avatar({ actor, size = "md" }: { actor: DemoActor; size?: "sm" | "md" }) {
  const agent = actor.kind === "agent";
  return (
    <span
      aria-label={actor.name}
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-black ring-2 ring-background",
        size === "sm" ? "size-4 text-5xs" : "size-6 text-3xs",
        agent && "rounded-md",
      )}
      style={{ backgroundColor: actor.color }}
    >
      {agent ? <SparklesIcon className={size === "sm" ? "size-2.5" : "size-3.5"} /> : actor.short}
    </span>
  );
}

function AvatarStack({
  actors,
  size = "md",
}: {
  actors: readonly DemoActor[];
  size?: "sm" | "md";
}) {
  if (actors.length === 0) return null;
  return (
    <span className={cn("flex items-center", size === "sm" ? "-space-x-1" : "-space-x-1.5")}>
      {actors.map((actor) => (
        <Avatar key={actor.id} actor={actor} size={size} />
      ))}
    </span>
  );
}

function ContextPanel({ app, t }: { app: DemoAppId; t: number }) {
  const presence = presenceOnItems(app, t);
  const snapshot = snapshotAt(t);
  const conflict = conflictAt(t);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
      <div className="px-2 pb-2 text-2xs font-medium tracking-wide text-muted-foreground uppercase">
        {DEMO_APPS[app].contextTitle}
      </div>
      <ul className="space-y-px" data-testid="machine-demo-context">
        {CONTEXT_ITEMS[app].map((item) => {
          const Icon = ITEM_ICON[item.kind] ?? BoxIcon;
          const here = presence.get(item.id) ?? [];
          const conflicted =
            app === "blender" &&
            item.id === "Ring_Brass" &&
            conflict !== null &&
            conflict.status !== "resolved";
          const snapshotLocked =
            app === "blender" && item.id === "Chair_02" && snapshot.phase === "local";
          return (
            <li
              key={item.id}
              className={cn(
                "flex h-7 items-center gap-2 rounded-md pr-1.5 text-xs transition-colors duration-300",
                here.length > 0 ? "bg-accent text-foreground" : "text-muted-foreground",
                conflicted && "bg-warning/12 text-warning-foreground",
              )}
              style={{ paddingLeft: `${0.5 + (item.depth ?? 0) * 0.9}rem` }}
            >
              <Icon className="size-3.5 shrink-0 opacity-70" />
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              {conflicted ? <TriangleAlertIcon className="size-3.5 shrink-0" /> : null}
              {snapshotLocked ? (
                <span className="text-3xs text-muted-foreground">in snapshot</span>
              ) : null}
              <AvatarStack actors={here} size="sm" />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function actorName(id: DemoActorId) {
  return DEMO_ACTORS[id].name;
}

function ActionLog({ t }: { t: number }) {
  const entries = actionLogAt(t, 6);
  return (
    <div
      className="shrink-0 border-t border-border px-2 py-3"
      data-testid="machine-demo-action-log"
    >
      <div className="flex items-center px-2 pb-2 text-2xs font-medium tracking-wide text-muted-foreground uppercase">
        Action log
        <span className="ml-auto normal-case tracking-normal">semantic ops</span>
      </div>
      <ol className="space-y-1">
        {entries.length === 0 ? (
          <li className="px-2 text-xs text-muted-foreground">
            Ops appear here as people and agents work.
          </li>
        ) : null}
        {entries.map((entry) => (
          <li
            key={entry.key}
            className={cn(
              "rounded-md border border-border/70 px-2 py-1.5",
              entry.source === "snapshot" && "border-dashed",
              entry.conflict && "border-warning/60 bg-warning/8",
            )}
            data-demo-motion="rise"
          >
            <div className="flex items-center gap-1.5 text-3xs text-muted-foreground">
              <span
                className="size-1.5 rounded-full"
                style={{ backgroundColor: DEMO_ACTORS[entry.actor].color }}
              />
              <span className="truncate">{actorName(entry.actor)}</span>
              <span className="ml-auto shrink-0">
                {entry.source === "snapshot" ? "replayed from #14" : DEMO_APPS[entry.app].app}
              </span>
            </div>
            <div className="truncate font-mono text-2xs">{entry.op}</div>
          </li>
        ))}
      </ol>
    </div>
  );
}

function LiveAppView({ app, t }: { app: DemoAppId; t: number }) {
  const view = viewFor(app, t);
  const ratio = view === "code" ? 1 : VIEW_IMAGE[view].ratio;
  const meta = DEMO_APPS[app];
  const snapshot = snapshotAt(t);
  const conflict = app === "blender" ? conflictAt(t) : null;
  const sinceSnapshot = t - SNAPSHOT_AT_MS;
  const showSnapshotFlash = app === "blender" && sinceSnapshot >= 0 && sinceSnapshot < 1_800;
  const replaying =
    app === "blender" &&
    (snapshot.phase === "merging" ||
      snapshot.phase === "conflict" ||
      snapshot.phase === "resolving");

  const code = view === "code";
  // The window (title bar + live view) is as large as the area allows at the app's own ratio.
  const frame: CSSProperties = code
    ? { width: "100cqw", height: "100cqh" }
    : { width: `min(100cqw, calc((100cqh - 2rem) * ${ratio}))` };

  return (
    <div className="relative min-h-0 flex-1 p-3">
      <div className="relative size-full" style={{ containerType: "size" }}>
        <div
          className="absolute top-1/2 left-1/2 flex -translate-x-1/2 -translate-y-1/2 flex-col"
          style={frame}
        >
          <div className="flex h-8 shrink-0 items-center gap-2 rounded-t-lg border border-b-0 border-border bg-card px-3">
            <span className="flex gap-1.5">
              <span className="size-2.5 rounded-full bg-muted-foreground/30" />
              <span className="size-2.5 rounded-full bg-muted-foreground/30" />
              <span className="size-2.5 rounded-full bg-muted-foreground/30" />
            </span>
            <span className="truncate text-xs font-medium">
              {meta.app} <span className="text-muted-foreground">· {meta.windowTitle}</span>
            </span>
            <span className="ml-auto flex shrink-0 items-center gap-1.5 text-2xs text-muted-foreground">
              <span className="size-1.5 animate-pulse rounded-full bg-destructive" />
              Live view from Studio Mac
            </span>
          </div>
          <div
            className={cn(
              "relative overflow-hidden rounded-b-lg border border-border bg-black",
              code && "min-h-0 flex-1",
            )}
            style={
              code
                ? { containerType: "size" }
                : { aspectRatio: String(ratio), containerType: "inline-size" }
            }
            data-testid="machine-demo-live-view"
          >
            {code ? <CodeView t={t} /> : <AppImages app={app} view={view} />}
            {replaying ? <ReplayOverlay t={t} /> : null}
            {cursorsAt(app, t).map((cursor) => (
              <Cursor key={cursor.actor.id} cursor={cursor} />
            ))}
            {showSnapshotFlash ? <SnapshotFlash since={sinceSnapshot} view={view} /> : null}
            {conflict ? <ConflictCard t={t} /> : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function AppImages({ app, view }: { app: DemoAppId; view: Exclude<DemoView, "code"> }) {
  // Every capture of this app stays mounted so a change (cut page, merged scene) crossfades.
  const views = (Object.keys(VIEW_IMAGE) as Exclude<DemoView, "code">[]).filter((key) =>
    app === "blender"
      ? key.startsWith("blender")
      : app === "resolve"
        ? key.startsWith("resolve")
        : key.startsWith("browser"),
  );
  return (
    <>
      {views.map((key) => (
        <img
          key={key}
          src={VIEW_IMAGE[key].src}
          alt={key === view ? `${DEMO_APPS[app].app} on the shared machine` : ""}
          draggable={false}
          className={cn(
            "absolute inset-0 size-full object-cover transition-opacity duration-1000 select-none",
            key === view ? "opacity-100" : "opacity-0",
          )}
        />
      ))}
    </>
  );
}

function highlight(line: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const pattern = /("[^"]*")|(\b(?:import|from|def|return|if|__name__)\b)|(\b\d+(?:\.\d+)?\b)/g;
  let last = 0;
  for (const match of line.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > last) parts.push(line.slice(last, index));
    parts.push(
      <span key={index} data-demo-tok={match[1] ? "str" : match[2] ? "kw" : "num"}>
        {match[0]}
      </span>,
    );
    last = index + match[0].length;
  }
  if (last < line.length) parts.push(line.slice(last));
  return parts;
}

/** The LogicPacks IDE as the code recipe shows it: files on the left, the agent typing. */
function CodeView({ t }: { t: number }) {
  const lines = codeLinesAt(t);
  return (
    <div className="absolute inset-0 flex font-mono" data-demo-code="">
      <div className="shrink-0" data-demo-code-tree="">
        <div data-demo-code-heading="">render-farm</div>
        <div>▾ render</div>
        <div data-demo-code-indent="" data-demo-code-active="">
          render_hero.py
        </div>
        <div data-demo-code-indent="">farm.toml</div>
        <div>▸ scenes</div>
        <div>README.md</div>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex" data-demo-code-tabs="">
          <span data-demo-code-tab="active">render_hero.py</span>
          <span data-demo-code-tab="">farm.toml</span>
        </div>
        <div data-demo-code-body="">
          {CODE_LINES.slice(0, lines).map((line, index) => (
            <div
              // oxlint-disable-next-line react/no-array-index-key -- a fixed script; lines never reorder.
              key={index}
              className="flex whitespace-pre"
              data-demo-code-line={index >= 5 && t < 66_000 ? "new" : "old"}
            >
              <span className="shrink-0" data-demo-code-gutter="">
                {index + 1}
              </span>
              <span>{highlight(line)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Cursor({ cursor }: { cursor: CursorState }) {
  const { actor } = cursor;
  const agent = actor.kind === "agent";
  return (
    <div
      className="pointer-events-none absolute z-20"
      style={{ left: `${cursor.x}%`, top: `${cursor.y}%` }}
      data-testid={`machine-demo-cursor-${actor.id}`}
    >
      {agent && cursor.doing ? (
        <span
          className="absolute -top-5 -left-5 size-10 animate-ping rounded-full opacity-30"
          style={{ backgroundColor: actor.color }}
        />
      ) : null}
      {agent ? (
        <svg
          width="22"
          height="22"
          viewBox="0 0 22 22"
          className="relative -translate-x-1 -translate-y-1 text-black drop-shadow"
        >
          <path
            d="M2 2 L20 9 L11.5 11.5 L9 20 Z"
            fill={actor.color}
            stroke="currentColor"
            strokeWidth="1.2"
          />
          <circle
            cx="16.5"
            cy="16.5"
            r="3"
            fill="currentColor"
            stroke={actor.color}
            strokeWidth="1.5"
          />
        </svg>
      ) : (
        <svg width="18" height="22" viewBox="0 0 18 22" className="relative text-white drop-shadow">
          <path
            d="M1 1 L1 18 L5.5 13.8 L8.6 21 L11.6 19.7 L8.6 12.6 L15 12.6 Z"
            fill={actor.color}
            stroke="currentColor"
            strokeWidth="1.3"
          />
        </svg>
      )}
      <div
        className={cn(
          "relative mt-0.5 flex flex-col gap-0.5",
          cursor.x > 78 ? "-ml-2 -translate-x-full items-end" : "ml-3 items-start",
        )}
      >
        <span
          className="flex items-center gap-1 rounded-full px-2 py-0.5 text-2xs font-semibold whitespace-nowrap text-black shadow-md"
          style={{ backgroundColor: actor.color }}
        >
          {agent ? <SparklesIcon className="size-3" /> : null}
          {actor.name}
        </span>
        {cursor.doing ? (
          <span className="rounded-md bg-black/80 px-1.5 py-0.5 text-3xs whitespace-nowrap text-white/90 shadow">
            {cursor.doing}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function SnapshotFlash({ since, view }: { since: number; view: DemoView }) {
  const flash = Math.max(0, 1 - since / 400);
  const fly = Math.min(1, Math.max(0, (since - 300) / 1_300));
  const image = view === "code" ? null : VIEW_IMAGE[view].src;
  return (
    <>
      <div
        className="pointer-events-none absolute inset-0 z-30 bg-white"
        style={{ opacity: flash * 0.8 }}
      />
      {image ? (
        <div
          className="pointer-events-none absolute z-30 overflow-hidden rounded-md border-4 border-white bg-white shadow-2xl"
          style={{
            left: `${25 + fly * 45}%`,
            top: `${20 + fly * 65}%`,
            width: `${50 - fly * 38}%`,
            opacity: 1 - Math.max(0, fly - 0.85) / 0.15,
            transform: `rotate(${fly * -6}deg)`,
          }}
        >
          <img src={image} alt="" className="block w-full" draggable={false} />
          <div className="bg-white px-2 py-1 text-3xs font-medium text-black">
            Snapshot #14 · Omar
          </div>
        </div>
      ) : null}
    </>
  );
}

function ReplayOverlay({ t }: { t: number }) {
  const snapshot = snapshotAt(t);
  const point = REPLAY_POINT[snapshot.replayed - 1];
  return (
    <>
      <div className="absolute top-3 left-1/2 z-30 w-[min(26rem,80%)] -translate-x-1/2 rounded-lg border border-white/15 bg-black/80 px-3 py-2 text-white shadow-xl backdrop-blur">
        <div className="flex items-center gap-2 text-xs">
          <LaptopIcon className="size-3.5 opacity-70" />
          <span className="font-medium">Merging snapshot #14 from Omar's laptop</span>
          <span className="ml-auto tabular-nums opacity-70">
            {snapshot.replayed}/{snapshot.total} ops
          </span>
        </div>
        <div className="mt-2 flex gap-1">
          {SNAPSHOT_ACTIONS.map((action, index) => (
            <span
              key={action.op}
              className={cn(
                "h-1 flex-1 rounded-full bg-white/15 transition-colors duration-300",
                index < snapshot.replayed && "bg-white",
                index === 2 &&
                  snapshot.phase !== "merging" &&
                  index < snapshot.replayed &&
                  "bg-warning",
              )}
            />
          ))}
        </div>
        <div className="mt-1.5 truncate font-mono text-2xs opacity-80">
          {SNAPSHOT_ACTIONS[snapshot.replayed - 1]?.op ?? "Replaying in order"}
        </div>
      </div>
      {point ? (
        <span
          key={snapshot.replayed}
          className="pointer-events-none absolute z-10 size-14 -translate-x-1/2 -translate-y-1/2 animate-ping rounded-full border-2 border-white/80"
          style={{ left: `${point.x}%`, top: `${point.y}%` }}
        />
      ) : null}
    </>
  );
}

function ConflictCard({ t }: { t: number }) {
  const conflict = conflictAt(t);
  if (!conflict) return null;
  const resolved = conflict.status === "resolved";
  return (
    <div
      className={cn(
        "absolute bottom-[5%] left-[2%] z-30 w-[min(20rem,42%)] rounded-lg border bg-popover/95 p-3 text-popover-foreground shadow-2xl backdrop-blur",
        resolved ? "border-success/50" : "border-warning/60",
      )}
      data-testid="machine-demo-conflict"
      data-demo-motion="pop"
      data-status={conflict.status}
    >
      <div className="flex items-center gap-2 text-xs font-medium">
        {resolved ? (
          <CheckIcon className="size-3.5 text-success" />
        ) : (
          <TriangleAlertIcon className="size-3.5 text-warning" />
        )}
        {resolved ? "Conflict resolved" : "Conflict on Ring_Brass"}
        <span className="ml-auto font-mono text-3xs text-muted-foreground">location, rotation</span>
      </div>
      <div className="mt-2 space-y-1.5 text-2xs">
        <ConflictSide
          actor="miraAgent"
          label="live"
          op="rotate x 0° → 12°, z 1.00"
          muted={resolved}
        />
        <ConflictSide
          actor="omar"
          label="snapshot #14"
          op="move → (-0.55, -0.05, 1.02)"
          muted={false}
        />
      </div>
      {conflict.status === "open" ? (
        <div className="mt-2 text-2xs text-muted-foreground">
          Both changed the ring. Asking Mira's agent to resolve.
        </div>
      ) : (
        <div className="mt-2 flex gap-1.5 rounded-md bg-muted/60 p-2 text-2xs">
          <SparklesIcon
            className="mt-px size-3 shrink-0"
            style={{ color: DEMO_ACTORS.miraAgent.color }}
          />
          <span>
            {conflict.resolution}
            {conflict.streaming ? <Caret /> : null}
          </span>
        </div>
      )}
    </div>
  );
}

function ConflictSide({
  actor,
  label,
  op,
  muted,
}: {
  actor: DemoActorId;
  label: string;
  op: string;
  muted: boolean;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-md border border-border/70 px-2 py-1",
        muted && "opacity-60",
      )}
    >
      <Avatar actor={DEMO_ACTORS[actor]} size="sm" />
      <span className="font-medium">{actorName(actor)}</span>
      <span className="text-muted-foreground">{label}</span>
      <span className="ml-auto truncate font-mono">{op}</span>
    </div>
  );
}

function Caret() {
  return (
    <span className="ml-0.5 inline-block h-[1em] w-[0.45em] animate-pulse bg-current align-[-0.15em]" />
  );
}

function WindowStrip({
  app,
  t,
  onSelect,
}: {
  app: DemoAppId;
  t: number;
  onSelect: (app: DemoAppId) => void;
}) {
  const snapshot = snapshotAt(t);
  return (
    <div
      className="flex shrink-0 items-stretch gap-2 overflow-x-auto px-3 pb-3"
      data-testid="machine-demo-windows"
    >
      {DEMO_APP_ORDER.map((id) => {
        const view = viewFor(id, t);
        const Icon = APP_ICON[id];
        const here = Object.values(DEMO_ACTORS).filter((actor) => appOfActorAt(actor.id, t) === id);
        return (
          <button
            key={id}
            type="button"
            onClick={() => onSelect(id)}
            aria-pressed={id === app}
            className={cn(
              "group flex w-36 shrink-0 flex-col overflow-hidden rounded-lg border bg-card text-left transition-colors",
              id === app ? "border-foreground/60" : "border-border hover:border-foreground/30",
            )}
          >
            <div className="relative aspect-video w-full overflow-hidden bg-black">
              {view === "code" ? (
                <div className="absolute inset-0 p-1.5 font-mono" data-demo-code-thumb="">
                  {CODE_LINES.slice(0, codeLinesAt(t)).map((line, index) => (
                    // oxlint-disable-next-line react/no-array-index-key -- a fixed script; lines never reorder.
                    <div key={index} className="truncate whitespace-pre">
                      {line || " "}
                    </div>
                  ))}
                </div>
              ) : (
                <img
                  src={VIEW_IMAGE[view].src}
                  alt=""
                  draggable={false}
                  className="size-full object-cover object-top"
                />
              )}
              <span className="absolute right-1 bottom-1">
                <AvatarStack actors={here} size="sm" />
              </span>
            </div>
            <div className="flex items-center gap-1.5 px-2 py-1.5 text-2xs">
              <Icon className="size-3 shrink-0 opacity-70" />
              <span className="truncate font-medium">{DEMO_APPS[id].app}</span>
              <span
                className="ml-auto size-1.5 shrink-0 rounded-full bg-foreground"
                aria-label="Live"
              />
            </div>
          </button>
        );
      })}
      {snapshot.phase !== "none" && snapshot.phase !== "taking" ? (
        <div
          className={cn(
            "flex w-48 shrink-0 flex-col justify-between rounded-lg border border-dashed p-2 text-2xs",
            snapshot.phase === "merged" ? "border-success/50" : "border-border",
          )}
          data-testid="machine-demo-snapshot"
          data-demo-motion="rise"
          data-phase={snapshot.phase}
        >
          <div className="flex items-center gap-1.5">
            <LaptopIcon className="size-3.5 opacity-70" />
            <span className="font-medium">Omar's laptop</span>
            <Avatar actor={DEMO_ACTORS.omar} size="sm" />
          </div>
          <div className="text-muted-foreground">Snapshot #14 of studio.blend</div>
          <div className="flex items-center gap-1.5">
            <Badge
              size="sm"
              variant={
                snapshot.phase === "merged"
                  ? "success"
                  : snapshot.phase === "local"
                    ? "outline"
                    : "warning"
              }
            >
              {snapshot.phase === "local"
                ? "Working locally"
                : snapshot.phase === "merged"
                  ? "Merged"
                  : snapshot.phase === "merging"
                    ? "Merging"
                    : "Needs a decision"}
            </Badge>
            <span className="ml-auto tabular-nums text-muted-foreground">
              {snapshot.phase === "local"
                ? `${snapshot.localOps} ops`
                : `${snapshot.replayed}/${snapshot.total}`}
            </span>
          </div>
        </div>
      ) : null}
      <div className="flex w-36 shrink-0 flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border px-2 text-center text-3xs text-muted-foreground">
        <AppWindowIcon className="size-4 opacity-60" />
        Same apps, same profiles, no VM
      </div>
    </div>
  );
}

function AgentTurns({ t }: { t: number }) {
  return (
    <div className="border-b border-border p-3" data-testid="machine-demo-turns">
      <div className="pb-2 text-2xs font-medium tracking-wide text-muted-foreground uppercase">
        Agent turns
      </div>
      <div className="space-y-2">
        {DEMO_PEOPLE.map((person) => {
          const lines = turnsFor(person, t, 3);
          const human = DEMO_ACTORS[person];
          const agent = DEMO_ACTORS[`${person}Agent` as DemoActorId];
          const working =
            lines.some((line) => line.streaming) || lines.some((line) => t - line.t < 2_500);
          return (
            <div key={person} className="rounded-lg border border-border bg-card p-2">
              <div className="flex items-center gap-1.5 text-xs">
                <AvatarStack actors={[human, agent]} size="sm" />
                <span className="font-medium">{human.name}</span>
                <span className="text-muted-foreground">and agent</span>
                <span
                  className={cn(
                    "ml-auto flex items-center gap-1 text-3xs",
                    working ? "text-foreground" : "text-muted-foreground",
                  )}
                >
                  <span
                    className={cn(
                      "size-1.5 rounded-full",
                      working ? "animate-pulse bg-foreground" : "bg-muted-foreground/40",
                    )}
                  />
                  {working ? "Working" : lines.length > 0 ? "Idle" : "Waiting"}
                </span>
              </div>
              {lines.length > 0 ? (
                <div className="mt-1.5 space-y-1">
                  {lines.map((line) => (
                    <div
                      key={`${line.t}-${line.actor}`}
                      className={cn(
                        "text-xs leading-snug",
                        line.kind === "prompt" && "rounded-md bg-muted/60 px-1.5 py-1",
                        line.kind === "tool" && "font-mono text-3xs text-muted-foreground",
                      )}
                      data-demo-motion="rise"
                    >
                      {line.kind === "tool" ? "› " : null}
                      {line.shown}
                      {line.streaming && line.kind === "reply" ? <Caret /> : null}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AgentChannel({ t }: { t: number }) {
  const messages = agentMessagesAt(t, 3);
  return (
    <div className="p-3" data-testid="machine-demo-agent-channel">
      <div className="flex items-center pb-2 text-2xs font-medium tracking-wide text-muted-foreground uppercase">
        Agents talking
        <span className="ml-auto normal-case tracking-normal">across machines</span>
      </div>
      {messages.length === 0 ? (
        <div className="text-xs text-muted-foreground">
          Agents coordinate here when their work touches.
        </div>
      ) : null}
      <div className="space-y-2">
        {messages.map((message) => (
          <div
            key={message.t}
            className="rounded-lg border border-border p-2"
            data-demo-motion="rise"
          >
            <div className="flex items-center gap-1 text-3xs text-muted-foreground">
              <Avatar actor={DEMO_ACTORS[message.from]} size="sm" />
              <span className="text-foreground">{actorName(message.from)}</span>
              <ArrowRightIcon className="size-3" />
              <Avatar actor={DEMO_ACTORS[message.to]} size="sm" />
              <span className="text-foreground">{actorName(message.to)}</span>
            </div>
            <div className="mt-1 text-xs leading-snug">
              {message.shown}
              {message.streaming ? <Caret /> : null}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Transport({
  t,
  playing,
  onToggle,
  onRestart,
  onSeek,
}: {
  t: number;
  playing: boolean;
  onToggle: () => void;
  onRestart: () => void;
  onSeek: (t: number) => void;
}) {
  const progress = t / DEMO_DURATION_MS;
  const style: CSSProperties = { width: `${progress * 100}%` };
  return (
    <div className="flex h-12 shrink-0 items-center gap-3 border-t border-border px-4">
      <Button
        size="icon-sm"
        variant="outline"
        onClick={onToggle}
        aria-label={playing ? "Pause demo" : "Play demo"}
        data-testid="machine-demo-play"
      >
        {playing ? <PauseIcon /> : <PlayIcon />}
      </Button>
      <Button size="icon-sm" variant="ghost" onClick={onRestart} aria-label="Restart demo">
        <RotateCcwIcon />
      </Button>
      <span
        className="w-20 text-xs tabular-nums text-muted-foreground"
        data-testid="machine-demo-time"
      >
        {formatDemoTime(t)} / {formatDemoTime(DEMO_DURATION_MS)}
      </span>
      <div className="relative flex h-8 min-w-0 flex-1 items-center">
        <button
          type="button"
          aria-label="Seek"
          className="absolute inset-x-0 top-1/2 h-4 -translate-y-1/2 cursor-pointer"
          onClick={(event) => {
            const box = event.currentTarget.getBoundingClientRect();
            onSeek(((event.clientX - box.left) / box.width) * DEMO_DURATION_MS);
          }}
        >
          <span className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-muted" />
          <span
            className="absolute top-1/2 left-0 h-1 -translate-y-1/2 rounded-full bg-foreground"
            style={style}
          />
        </button>
        {DEMO_CHAPTERS.map((chapter) => (
          <button
            key={chapter.t}
            type="button"
            onClick={() => onSeek(chapter.t)}
            className={cn(
              "absolute top-0 -translate-x-px border-l border-border pl-1 text-3xs leading-none whitespace-nowrap transition-colors hover:text-foreground",
              t >= chapter.t ? "text-foreground/80" : "text-muted-foreground",
            )}
            style={{ left: `${(chapter.t / DEMO_DURATION_MS) * 100}%` }}
          >
            {chapter.label}
          </button>
        ))}
      </div>
      <span className="hidden text-3xs text-muted-foreground lg:inline">
        Space to play or pause
      </span>
    </div>
  );
}
