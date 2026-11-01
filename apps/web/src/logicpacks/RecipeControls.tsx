import {
  DEFAULT_RECIPE_ID,
  type EnvironmentId,
  type RecipeManifest,
  type ScopedThreadRef,
} from "@logicpacks/contracts";
import { scopedThreadKey } from "@logicpacks/client-runtime/environment";
import { BUILT_IN_RECIPES } from "@logicpacks/shared/recipes/builtin";
import { recipeAccess, type RecipeAccess } from "@logicpacks/shared/recipes/runtime";
import { AppWindowIcon, MonitorDownIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { create } from "zustand";

import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { toastManager } from "../components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { isElectron } from "../env";
import { useRightPanelStore } from "../rightPanelStore";
import { usePrimaryEnvironmentId } from "../state/environments";
import { lpApi, type LpProjectRecipe } from "./api";
import { useLogicPacksSession } from "./store";

export const DESKTOP_DOWNLOAD_URL = "https://logicpacks.io/download";

/** The web build runs Code only; app recipes open in the desktop app. */
const CLIENT_SURFACE = isElectron ? "desktop" : "web";

export interface RecipeChoice {
  readonly recipe: RecipeManifest;
  readonly access: RecipeAccess;
}

/** Recipes the picker offers here, in catalog order, with coming-soon ones split out. */
export function recipeChoices(surface: "web" | "desktop" = CLIENT_SURFACE) {
  const choices = BUILT_IN_RECIPES.map((recipe) => ({
    recipe,
    access: recipeAccess(recipe, surface),
  }));
  return {
    offered: choices.filter((choice) => choice.access.kind !== "coming-soon"),
    comingSoon: choices.filter((choice) => choice.access.kind === "coming-soon"),
  };
}

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "Something went wrong.";

/** Pick what a new project is for. Code is the default; app recipes need the desktop app. */
export function RecipePicker({
  value,
  onChange,
  operator,
}: {
  value: string;
  onChange: (recipeId: string) => void;
  /** Only the machine's operator can open its apps; members get Code. */
  operator: boolean;
}) {
  const { offered, comingSoon } = recipeChoices(operator ? CLIENT_SURFACE : "web");
  return (
    <div className="flex flex-col gap-1.5">
      <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Recipe">
        {offered.map(({ recipe, access }) => {
          const open = access.kind === "open";
          return (
            <Button
              key={recipe.id}
              type="button"
              role="radio"
              aria-checked={value === recipe.id}
              aria-disabled={!open}
              disabled={!open}
              variant={value === recipe.id ? "secondary" : "outline"}
              size="sm-multiline"
              data-testid={`lp-recipe-${recipe.id}`}
              onClick={() => onChange(recipe.id)}
            >
              <span className="flex flex-col items-start gap-0.5 text-left">
                <span className="flex items-center gap-1.5 font-medium">
                  {recipe.name}
                  {recipe.availability === "preview" ? (
                    <Badge size="sm" variant="outline">
                      Preview
                    </Badge>
                  ) : null}
                </span>
                <span className="text-xs text-muted-foreground">
                  {open ? recipe.summary : access.message}
                </span>
              </span>
            </Button>
          );
        })}
      </div>
      {offered.some((choice) => choice.access.kind === "open-in-desktop") ? (
        <a
          className="inline-flex items-center gap-1 self-start text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          href={DESKTOP_DOWNLOAD_URL}
          target="_blank"
          rel="noreferrer"
          data-testid="lp-recipe-download"
        >
          <MonitorDownIcon className="size-3.5" aria-hidden />
          Get the desktop app to work in Blender and other apps
        </a>
      ) : null}
      {comingSoon.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          Beta: {comingSoon.map((choice) => choice.recipe.name).join(", ")}.
        </p>
      ) : null}
    </div>
  );
}

const useRecipeStore = create<{ readonly byProject: Readonly<Record<string, LpProjectRecipe>> }>(
  () => ({ byProject: {} }),
);

export const setProjectRecipe = (projectId: string, recipe: LpProjectRecipe) =>
  useRecipeStore.setState((state) => ({ byProject: { ...state.byProject, [projectId]: recipe } }));

export function useProjectRecipe(projectId: string, enabled: boolean) {
  // oxlint-disable-next-line logicpacks/no-unreasoned-state-sync -- loads the open project's recipe from the LogicPacks server when the project changes
  useEffect(() => {
    if (!enabled) return;
    void lpApi
      .projectRecipe(projectId)
      .then((recipe) => setProjectRecipe(projectId, recipe))
      .catch(() => undefined);
  }, [projectId, enabled]);
  const recipe = useRecipeStore((state) => state.byProject[projectId] ?? null);
  return enabled ? recipe : null;
}

type AppRecipe = LpProjectRecipe & { readonly app: NonNullable<LpProjectRecipe["app"]> };

/** Opens the project's app on this machine with the bridge loaded, and says how it went. */
export async function openProjectApp(projectId: string, recipe: AppRecipe): Promise<boolean> {
  const app = recipe.app;
  try {
    await lpApi.launchRecipe(projectId);
    setProjectRecipe(projectId, { ...recipe, app: { ...app, running: true } });
    toastManager.add({ type: "success", title: `${app.name} is open` });
    return true;
  } catch (error) {
    toastManager.add({
      type: "error",
      title: `Could not open ${app.name}`,
      description: errorText(error),
    });
    return false;
  }
}

/** Threads whose app panel was already opened for them, so closing it sticks for the session. */
const autoOpenedAppPanels = new Set<string>();

/**
 * The project's app, next to the sync badge: "Open Blender" where this machine
 * can run it, the desktop download where it cannot. Code projects show nothing.
 */
export function LpRecipeControl({
  projectId,
  environmentId,
  threadRef,
}: {
  projectId: string;
  environmentId: EnvironmentId | null;
  /** The open thread: an app project shows its app in this thread's side panel. */
  threadRef: ScopedThreadRef | null;
}) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { session } = useLogicPacksSession(false);
  const enabled =
    session !== null && environmentId !== null && environmentId === primaryEnvironmentId;
  const recipe = useProjectRecipe(projectId, enabled);
  const [pending, setPending] = useState(false);
  const appHere = isElectron && recipe?.app?.access === "open" ? recipe.app.name : null;
  const threadKey = threadRef === null ? null : scopedThreadKey(threadRef);
  // oxlint-disable-next-line logicpacks/no-unreasoned-state-sync -- app projects show the app where code projects show files: open its panel once per thread
  useEffect(() => {
    if (appHere === null || threadRef === null || threadKey === null) return;
    if (autoOpenedAppPanels.has(threadKey)) return;
    autoOpenedAppPanels.add(threadKey);
    useRightPanelStore.getState().openApp(threadRef, appHere, true);
  }, [appHere, threadKey, threadRef]);
  if (recipe === null || recipe.recipeId === DEFAULT_RECIPE_ID || recipe.app === null) return null;
  const app = recipe.app;

  if (app.access !== "open" || !isElectron) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <Badge
              render={<a href={DESKTOP_DOWNLOAD_URL} target="_blank" rel="noreferrer" />}
              variant="outline"
              size="sm"
              data-testid="lp-recipe-desktop-cta"
            />
          }
        >
          <MonitorDownIcon aria-hidden />
          {app.name}
        </TooltipTrigger>
        <TooltipPopup side="bottom">
          This is a {app.name} project. Open it in the LogicPacks desktop app to work in {app.name}.
        </TooltipPopup>
      </Tooltip>
    );
  }

  const open = async () => {
    if (threadRef !== null) useRightPanelStore.getState().openApp(threadRef, app.name);
    if (app.running) return;
    setPending(true);
    await openProjectApp(projectId, { ...recipe, app });
    setPending(false);
  };

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Badge
            render={<button type="button" disabled={pending || !app.installed} />}
            variant={app.running ? "success" : "outline"}
            size="sm"
            data-testid="lp-recipe-open"
            data-running={app.running}
            onClick={(event) => {
              event.stopPropagation();
              void open();
            }}
          />
        }
      >
        <AppWindowIcon aria-hidden />
        {pending ? `Opening ${app.name}` : app.running ? `${app.name} open` : `Open ${app.name}`}
      </TooltipTrigger>
      <TooltipPopup side="bottom">
        {app.installed
          ? `Agents in this project work in ${app.name} through its tools. Every edit is logged so separate work merges back.`
          : `${app.name} is not installed on this computer.`}
      </TooltipPopup>
    </Tooltip>
  );
}
