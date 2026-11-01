import { FolderOpenIcon } from "lucide-react";
import { useState, type FormEvent } from "react";

import { openCommandPalette } from "../commandPaletteBus";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Toggle, ToggleGroup } from "../components/ui/toggle-group";
import { DEFAULT_RECIPE_ID } from "@logicpacks/contracts";
import { BUILT_IN_RECIPES } from "@logicpacks/shared/recipes/builtin";
import { lpApi, type LpSession } from "./api";
import { RecipePicker } from "./RecipeControls";
import { refreshLogicPacksSession } from "./store";

type Source = "empty" | "template" | "git";

const recipeName = (recipeId: string) =>
  BUILT_IN_RECIPES.find((candidate) => candidate.id === recipeId)?.name ?? recipeId;

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "Something went wrong.";

/**
 * Add a project in one step: pick its recipe (Code by default), then an empty
 * repository, a template, or a git URL. An app recipe starts empty. It lands in
 * the current workspace; the operator can also pick a folder on this computer.
 */
export function AddProjectForm({
  session,
  onCreated,
  initialSource = "empty",
}: {
  session: LpSession;
  onCreated: (projectId: string) => void;
  /** Developers start from a repository; everyone else from an empty project. */
  initialSource?: Source;
}) {
  const [recipe, setRecipe] = useState<string>(DEFAULT_RECIPE_ID);
  const [chosenSource, setSource] = useState<Source>(initialSource);
  const isCode = recipe === DEFAULT_RECIPE_ID;
  const source: Source = isCode ? chosenSource : "empty";
  const [name, setName] = useState("");
  const [template, setTemplate] = useState(session.templates[0]?.id ?? "");
  const [remoteUrl, setRemoteUrl] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const created = await lpApi.newProject(
        source === "git"
          ? { kind: "git", remoteUrl: remoteUrl.trim() }
          : source === "template"
            ? { kind: "template", name: name.trim(), template }
            : isCode
              ? { kind: "empty", name: name.trim() }
              : { kind: "empty", name: name.trim(), recipe },
      );
      await refreshLogicPacksSession();
      onCreated(created.projectId);
    } catch (cause) {
      setError(errorText(cause));
    }
    // The catch never rethrows, so this always runs (React Compiler cannot lower `finally`).
    setPending(false);
  };

  return (
    <form className="flex flex-col gap-3" onSubmit={(event) => void submit(event)}>
      <RecipePicker value={recipe} onChange={setRecipe} operator={session.operator} />
      <div className={isCode ? "flex flex-wrap items-center gap-2" : "hidden"}>
        <ToggleGroup
          aria-label="Start from"
          value={[source]}
          onValueChange={(value) => {
            const next = value[0] as Source | undefined;
            if (next) setSource(next);
          }}
        >
          <Toggle value="empty">Empty</Toggle>
          <Toggle value="template">Template</Toggle>
          <Toggle value="git">Git URL</Toggle>
        </ToggleGroup>
        {session.operator ? (
          <Button
            size="sm"
            type="button"
            variant="ghost"
            onClick={() => openCommandPalette({ open: "add-project" })}
          >
            <FolderOpenIcon />
            Folder on this computer
          </Button>
        ) : null}
      </div>
      {source === "git" ? (
        <Input
          aria-label="Git URL"
          autoFocus
          name="remoteUrl"
          placeholder="https://github.com/team/app"
          required
          value={remoteUrl}
          onChange={(event) => setRemoteUrl(event.target.value)}
        />
      ) : (
        <Input
          aria-label="Project name"
          autoFocus
          name="projectName"
          placeholder="Project name"
          required
          maxLength={80}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      )}
      {source === "template" ? (
        <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Template">
          {session.templates.map((option) => (
            <Button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={template === option.id}
              variant={template === option.id ? "secondary" : "outline"}
              size="sm-multiline"
              onClick={() => setTemplate(option.id)}
            >
              <span className="flex flex-col items-start text-left">
                <span className="font-medium">{option.title}</span>
                <span className="text-xs text-muted-foreground">{option.description}</span>
              </span>
            </Button>
          ))}
        </div>
      ) : null}
      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end">
        <Button type="submit" size="sm" disabled={pending} data-testid="lp-create-project">
          {pending
            ? "Creating"
            : source === "git"
              ? "Clone project"
              : isCode
                ? "Create project"
                : `Create ${recipeName(recipe)} project`}
        </Button>
      </div>
    </form>
  );
}
