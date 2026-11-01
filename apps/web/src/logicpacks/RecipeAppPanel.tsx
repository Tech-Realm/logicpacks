import {
  DEFAULT_RECIPE_ID,
  type PresenceEntry,
  type PresenceLocation,
} from "@logicpacks/contracts";
import {
  AppWindowIcon,
  Axis3dIcon,
  BoxIcon,
  CameraIcon,
  LightbulbIcon,
  MonitorDownIcon,
  ShapesIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "../components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../components/ui/empty";
import { Spinner } from "../components/ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { isElectron } from "../env";
import { cn } from "../lib/utils";
import { appPointer } from "../presence/presenceLogic";
import { lpApi, type LpRecipeView, type LpRecipeViewItem } from "./api";
import { AppCursors, AppItemPresence, AppPresenceBar, useAppPresence } from "./AppPresence";
import { DESKTOP_DOWNLOAD_URL, openProjectApp, useProjectRecipe } from "./RecipeControls";
import { actorLabel, outlineRows, recentEdits, shortAge, viewWidth } from "./recipeView.logic";

/** How often the app's frame refreshes while the panel is on screen. */
const POLL_MS = 1500;
const HIDDEN_POLL_MS = 6000;

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "Something went wrong.";

function ItemIcon({ type }: { type: string }) {
  const className = "size-3.5 shrink-0 text-muted-foreground";
  switch (type) {
    case "MESH":
      return <BoxIcon className={className} aria-hidden />;
    case "CAMERA":
      return <CameraIcon className={className} aria-hidden />;
    case "LIGHT":
      return <LightbulbIcon className={className} aria-hidden />;
    case "EMPTY":
      return <Axis3dIcon className={className} aria-hidden />;
    default:
      return <ShapesIcon className={className} aria-hidden />;
  }
}

/** A presence dot: who touched this item last, agents square, people round. */
function EditorMark({ last, now }: { last: NonNullable<LpRecipeViewItem["last"]>; now: number }) {
  const label = actorLabel(last.actor);
  const age = shortAge(last.at, now);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className="ml-auto inline-flex shrink-0 items-center gap-1 text-2xs text-muted-foreground" />
        }
      >
        <span
          aria-hidden
          className={cn(
            "inline-flex size-4 items-center justify-center bg-foreground text-3xs font-semibold text-background",
            last.actor.kind === "agent" ? "rounded-sm" : "rounded-full",
          )}
        >
          {label.slice(0, 1).toUpperCase()}
        </span>
        {age}
      </TooltipTrigger>
      <TooltipPopup side="left">
        {label} changed this {age === "now" ? "just now" : `${age} ago`}
      </TooltipPopup>
    </Tooltip>
  );
}

type OutlineSelection = { readonly id: string | null; readonly name: string };

const isSelected = (item: LpRecipeViewItem, selected: OutlineSelection | null) =>
  selected !== null &&
  (selected.id !== null ? selected.id === item.id : selected.name === item.name);

/**
 * The app's context where a code project has its file tree: Blender's scene outline,
 * each object with who is on it now (live presence) and who changed it last.
 */
function Outline({
  items,
  now,
  recipeId,
  presence,
  selected,
  onSelect,
}: {
  items: ReadonlyArray<LpRecipeViewItem>;
  now: number;
  recipeId: string;
  presence: ReadonlyArray<PresenceEntry>;
  selected: OutlineSelection | null;
  onSelect: (item: OutlineSelection | null) => void;
}) {
  const rows = outlineRows(items);
  return (
    <div className="flex min-h-0 flex-col" data-testid="lp-app-outline">
      <div className="px-3 pt-3 pb-1.5 text-2xs font-medium uppercase tracking-wide text-muted-foreground">
        Scene
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {rows.map(({ item, depth }) => (
          <li
            key={item.id ?? item.name}
            className={cn(
              "flex items-center gap-1.5 rounded-md text-xs",
              item.hidden && "opacity-50",
              isSelected(item, selected) && "bg-accent",
            )}
            data-testid="lp-app-outline-item"
            data-selected={isSelected(item, selected) || undefined}
          >
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left"
              style={{ paddingLeft: `${0.375 + depth * 0.875}rem` }}
              aria-pressed={isSelected(item, selected)}
              onClick={() =>
                onSelect(isSelected(item, selected) ? null : { id: item.id, name: item.name })
              }
            >
              <ItemIcon type={item.type} />
              <span className="min-w-0 truncate">{item.name}</span>
            </button>
            <AppItemPresence entries={presence} recipeId={recipeId} item={item} />
            <span className="pr-1.5">
              {item.last ? <EditorMark last={item.last} now={now} /> : null}
            </span>
          </li>
        ))}
        {rows.length === 0 ? (
          <li className="px-1.5 py-1 text-xs text-muted-foreground">The scene is empty.</li>
        ) : null}
      </ul>
    </div>
  );
}

/** The latest edits, newest first: what people and agents are doing in the app right now. */
function ActivityStrip({ items, now }: { items: ReadonlyArray<LpRecipeViewItem>; now: number }) {
  const recent = recentEdits(items, 3);
  if (recent.length === 0) return null;
  return (
    <ol className="flex flex-wrap gap-x-4 gap-y-1 border-t border-border px-3 py-2 text-2xs text-muted-foreground">
      {recent.map((item) => (
        <li
          key={`${item.id}:${item.last.at}`}

          data-testid="lp-app-activity"
        >
          <span className="text-foreground">{actorLabel(item.last.actor)}</span>
          {item.last.kind === "object.add"
            ? " added "
            : item.last.kind === "object.remove"
              ? " removed "
              : " changed "}
          <span className="text-foreground">{item.name}</span> {shortAge(item.last.at, now)}
        </li>
      ))}
    </ol>
  );
}

function Frame({ view }: { view: Extract<LpRecipeView, { running: true }> }) {
  if (view.image === null) {
    return (
      <p className="m-auto max-w-64 text-center text-xs text-muted-foreground">
        {view.imageError
          ? `No picture from the app yet: ${view.imageError}`
          : "No picture from the app yet."}
      </p>
    );
  }
  return (
    <img
      src={`data:image/png;base64,${view.image}`}
      alt="The app's view of the project"
      className="size-full object-contain"
      draggable={false}
      data-testid="lp-app-frame"
      data-mode={view.mode ?? undefined}
    />
  );
}

/**
 * An app recipe project's workspace: the app itself (a live frame of its window,
 * or a render on the headless cloud host) beside its outline, each item marked
 * with who changed it last.
 */
export function RecipeAppPanel({
  projectId,
  title,
  visible,
}: {
  projectId: string;
  title: string;
  visible: boolean;
}) {
  const recipe = useProjectRecipe(projectId, true);
  const [view, setView] = useState<LpRecipeView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [opening, setOpening] = useState(false);
  const frameRef = useRef<HTMLDivElement>(null);
  const canOpen = isElectron && recipe?.app?.access === "open";
  const [selected, setSelected] = useState<OutlineSelection | null>(null);
  const [pointer, setPointer] = useState<{ readonly x: number; readonly y: number } | null>(null);
  const recipeId = recipe?.recipeId ?? DEFAULT_RECIPE_ID;
  const appOnScreen = visible && canOpen && view?.running === true;
  // Where this person is in the app, shared like a file cursor: the object they picked
  // in the outline and their pointer over the live view.
  const location: PresenceLocation | null = appOnScreen
    ? {
        view: "app",
        activity: "viewing",
        ...(selected === null
          ? {}
          : { appItem: { recipeId, itemId: selected.id ?? selected.name, label: selected.name } }),
        ...(pointer === null ? {} : { pointer }),
      }
    : null;
  const presence = useAppPresence({ projectId, location });

  // oxlint-disable-next-line logicpacks/no-unreasoned-state-sync -- polls the app's live frame and outline from the LogicPacks server while this panel is on screen
  useEffect(() => {
    if (!visible || !canOpen) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      const width = viewWidth(frameRef.current?.clientWidth ?? 640, window.devicePixelRatio || 1);
      const next = await lpApi.recipeView(projectId, width).then(
        (result) => ({ ok: true as const, result }),
        (failure: unknown) => ({ ok: false as const, message: errorText(failure) }),
      );
      if (cancelled) return;
      if (next.ok) {
        setView(next.result);
        setError(null);
      } else {
        setError(next.message);
      }
      setNow(Date.now());
      timer = setTimeout(() => void tick(), document.hidden ? HIDDEN_POLL_MS : POLL_MS);
    };
    void tick();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [projectId, visible, canOpen]);

  if (recipe === null) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (recipe.recipeId === DEFAULT_RECIPE_ID || recipe.app === null) {
    return (
      <Empty size="compact">
        <EmptyHeader>
          <EmptyTitle>No app for this project</EmptyTitle>
          <EmptyDescription>Code projects show their files instead.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  const app = recipe.app;
  if (!canOpen) {
    return (
      <Empty size="compact" data-testid="lp-app-desktop-only">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <MonitorDownIcon aria-hidden />
          </EmptyMedia>
          <EmptyTitle>{app.name} runs in the desktop app</EmptyTitle>
          <EmptyDescription>
            The web version works on code. Open this project in the LogicPacks desktop app to see{" "}
            {app.name} here and work in it with your agents.
          </EmptyDescription>
        </EmptyHeader>
        <Button render={<a href={DESKTOP_DOWNLOAD_URL} target="_blank" rel="noreferrer" />}>
          Get the desktop app
        </Button>
      </Empty>
    );
  }

  const open = async () => {
    setOpening(true);
    await openProjectApp(projectId, { ...recipe, app });
    setOpening(false);
  };

  const running = view?.running === true ? view : null;
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="lp-app-panel">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-xs">
        <AppWindowIcon className="size-3.5 text-muted-foreground" aria-hidden />
        <span className="font-medium">{title}</span>
        <span className="text-muted-foreground" data-testid="lp-app-status">
          {running === null
            ? view === null
              ? "Connecting"
              : "Not open"
            : running.mode === "viewport"
              ? "Live from your viewport"
              : "Rendered on this machine"}
        </span>
        {running !== null ? (
          <span className="ml-auto flex items-center gap-2 text-muted-foreground">
            <AppPresenceBar entries={presence} recipeId={recipeId} />
            {running.ops} {running.ops === 1 ? "edit" : "edits"} logged
          </span>
        ) : null}
      </div>
      {running === null ? (
        <Empty size="compact">
          <EmptyHeader>
            <EmptyTitle>
              {view === null ? `Looking for ${app.name}` : `${app.name} is not open`}
            </EmptyTitle>
            <EmptyDescription>
              {error ??
                `Open it to work in ${app.name} with your agents. Their edits and yours are logged per object, so separate work merges back.`}
            </EmptyDescription>
          </EmptyHeader>
          {view === null ? null : (
            <Button
              disabled={opening || !app.installed}
              onClick={() => void open()}
              data-testid="lp-app-open"
            >
              {opening ? `Opening ${app.name}` : `Open ${app.name}`}
            </Button>
          )}
        </Empty>
      ) : (
        <div className="flex min-h-0 flex-1">
          <aside className="flex w-52 shrink-0 flex-col border-r border-border max-sm:w-40">
            <Outline
              items={running.objects}
              now={now}
              recipeId={recipeId}
              presence={presence}
              selected={selected}
              onSelect={setSelected}
            />
          </aside>
          <div className="flex min-w-0 flex-1 flex-col">
            <div
              ref={frameRef}
              className="relative flex min-h-0 flex-1 bg-black/90 p-2 dark:bg-black/40"
              data-testid="lp-app-view"
              onPointerMove={(event) => {
                const box = event.currentTarget.getBoundingClientRect();
                const next = appPointer(
                  event.clientX - box.left,
                  event.clientY - box.top,
                  box.width,
                  box.height,
                );
                setPointer((current) =>
                  current?.x === next?.x && current?.y === next?.y ? current : next,
                );
              }}
              onPointerLeave={() => setPointer(null)}
            >
              <Frame view={running} />
              <AppCursors entries={presence} recipeId={recipeId} />
            </div>
            <ActivityStrip items={running.objects} now={now} />
          </div>
        </div>
      )}
    </div>
  );
}
