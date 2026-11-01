import type { EnvironmentId, RecipeManifest } from "@logicpacks/contracts";
import { appLabel, referencesByApp } from "@logicpacks/shared/recipes/packContext";
import { ChevronDownIcon, ChevronRightIcon, PackageIcon } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";

import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../components/ui/menu";
import { toastManager } from "../components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { useStableCallback } from "../hooks/useStableCallback";
import { usePrimaryEnvironmentId } from "../state/environments";
import { useProjects } from "../state/entities";
import { lpApi, type LpPackView, type LpUnlockedBadge } from "./api";
import { useProjectLedger } from "./ledger";
import { useFeature } from "./features";
import { useLogicPacksSession } from "./store";

/**
 * Packs carry context between threads, apps and projects: a thread saved as a pack keeps
 * its ledger summary, decisions, file and app references and its prompts as steps.
 * "Use in…" hands it to another thread (its agent reads it next turn) or copies it into
 * another project. Agents read packs with the ledger's `packs` tool.
 */

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "Something went wrong.";

/** The app's outline, when the project's app is running: Blender objects, Resolve markers. */
/** Publishing and reusing packs count toward achievements; say so when one unlocks. */
function announceUnlocked(unlocked: ReadonlyArray<LpUnlockedBadge> | undefined) {
  for (const badge of unlocked ?? []) {
    toastManager.add({
      type: "success",
      title: `Achievement unlocked: ${badge.name}`,
      description: `+${badge.points} points`,
    });
  }
}

async function appItems(projectId: string) {
  try {
    const view = await lpApi.recipeView(projectId, 0);
    if (!view.running) return [];
    return view.objects.slice(0, 80).map((item) => ({
      kind: /marker/i.test(item.type) ? ("timeline-marker" as const) : ("app-object" as const),
      name: item.name,
      detail: item.type,
    }));
  } catch {
    return [];
  }
}

/** What a pack carries, grouped the way an agent reads it. */
export function PackContextView({ pack }: { pack: RecipeManifest }) {
  const context = pack.context;
  if (context === undefined) {
    return <p className="text-xs text-muted-foreground">{pack.summary}</p>;
  }
  return (
    <div className="flex flex-col gap-3 text-xs" data-testid="lp-pack-context">
      <p className="text-muted-foreground">
        From {context.source.threadTitle ?? "a thread"} in {context.source.projectTitle}, saved by{" "}
        {context.source.savedBy}
      </p>
      <section className="flex flex-col gap-1">
        <h4 className="font-medium text-foreground">Summary</h4>
        <p className="whitespace-pre-line text-foreground/80">{context.summary}</p>
      </section>
      {context.decisions.length > 0 ? (
        <section className="flex flex-col gap-1">
          <h4 className="font-medium text-foreground">Decisions</h4>
          <ul className="flex flex-col gap-0.5">
            {context.decisions.map((decision) => (
              <li key={`${decision.by}:${decision.text}`} className="text-foreground/80">
                {decision.text}
                <span className="text-muted-foreground"> · {decision.by}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {context.references.length > 0 ? (
        <section className="flex flex-col gap-1.5" data-testid="lp-pack-references">
          <h4 className="font-medium text-foreground">References</h4>
          {referencesByApp(context.references).map((group) => (
            <div key={group.app} className="flex flex-col gap-0.5">
              <span className="text-muted-foreground">{appLabel(group.app)}</span>
              <ul className="flex flex-wrap gap-1">
                {group.items.slice(0, 24).map((reference) => (
                  <li key={`${reference.name}:${reference.detail ?? ""}`}>
                    <Badge size="sm" variant="outline" title={reference.detail}>
                      {reference.name}
                    </Badge>
                  </li>
                ))}
                {group.items.length > 24 ? (
                  <li className="text-muted-foreground">+{group.items.length - 24} more</li>
                ) : null}
              </ul>
            </div>
          ))}
        </section>
      ) : null}
      {context.steps.length > 0 ? (
        <section className="flex flex-col gap-1">
          <h4 className="font-medium text-foreground">Workflow steps</h4>
          <ol className="flex list-decimal flex-col gap-0.5 pl-4">
            {context.steps.map((step) => (
              <li key={`${step.title}:${step.recipe ?? ""}`} className="text-foreground/80">
                {step.title}
                {step.recipe ? (
                  <span className="text-muted-foreground"> · {appLabel(step.recipe)}</span>
                ) : null}
              </li>
            ))}
          </ol>
        </section>
      ) : null}
    </div>
  );
}

function UseInMenu({
  view,
  projectId,
  threadId,
}: {
  view: LpPackView;
  projectId: string;
  threadId: string;
}) {
  const ledger = useProjectLedger(projectId);
  const projects = useProjects().filter(
    (project) => !project.isScratch && project.id !== projectId,
  );
  const [busy, setBusy] = useState(false);
  const handOff = async (
    target: { targetThreadId?: string; targetProjectId?: string },
    label: string,
  ) => {
    setBusy(true);
    try {
      const result = await lpApi.handOffPack({ projectId, packId: view.pack.id, ...target });
      toastManager.add({
        type: "success",
        title: `${view.pack.name} handed to ${label}`,
        description: result.delivered
          ? "Its agent reads the pack on its next turn."
          : "Copied into that project's packs.",
      });
      announceUnlocked(result.unlocked);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not use the pack",
        description: errorText(error),
      });
    }
    // The catch never rethrows, so this always runs (React Compiler cannot lower `finally`).
    setBusy(false);
  };
  const threads = (ledger?.threads ?? []).filter((thread) => thread.threadId !== threadId);
  return (
    <Menu>
      <MenuTrigger
        render={<Button size="xs" variant="outline" disabled={busy} data-testid="lp-pack-use" />}
      >
        Use in…
        <ChevronDownIcon aria-hidden />
      </MenuTrigger>
      <MenuPopup align="end" className="max-h-80 overflow-y-auto">
        <MenuGroup>
          <MenuGroupLabel>Hand to a thread</MenuGroupLabel>
          <MenuItem
            data-testid="lp-pack-use-here"
            onClick={() => void handOff({ targetThreadId: threadId }, "this thread")}
          >
            This thread
          </MenuItem>
          {threads.map((thread) => (
            <MenuItem
              key={thread.threadId}
              data-testid="lp-pack-use-thread"
              onClick={() =>
                void handOff(
                  { targetThreadId: thread.threadId },
                  thread.members[0]?.name ?? thread.title,
                )
              }
            >
              <span className="truncate">{thread.title}</span>
              <span className="ml-auto truncate pl-3 text-xs text-muted-foreground">
                {thread.members.map((member) => member.name).join(", ")}
              </span>
            </MenuItem>
          ))}
        </MenuGroup>
        {projects.length > 0 ? (
          <>
            <MenuSeparator />
            <MenuGroup>
              <MenuGroupLabel>Copy to a project</MenuGroupLabel>
              {projects.slice(0, 12).map((project) => (
                <MenuItem
                  key={project.id}
                  data-testid="lp-pack-use-project"
                  onClick={() => void handOff({ targetProjectId: project.id }, project.title)}
                >
                  {project.title}
                </MenuItem>
              ))}
            </MenuGroup>
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}

function PackRow({
  view,
  projectId,
  threadId,
  initiallyOpen,
}: {
  view: LpPackView;
  projectId: string;
  threadId: string;
  initiallyOpen: boolean;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  const context = view.pack.context;
  return (
    <li
      className="flex flex-col gap-2 border-b border-border/60 py-3 last:border-b-0"
      data-testid="lp-pack"
      data-pack-id={view.pack.id}
    >
      <div className="flex items-center gap-2">
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={open ? "Hide context" : "Show context"}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? <ChevronDownIcon aria-hidden /> : <ChevronRightIcon aria-hidden />}
        </Button>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-medium">{view.pack.name}</span>
          {context ? (
            <span className="truncate text-xs text-muted-foreground">
              {count(context.decisions.length, "decision")} ·{" "}
              {count(context.references.length, "reference")} ·{" "}
              {count(context.steps.length, "step")}
            </span>
          ) : null}
        </div>
        <UseInMenu view={view} projectId={projectId} threadId={threadId} />
      </div>
      {open ? <PackContextView pack={view.pack} /> : null}
    </li>
  );
}

function PacksPanel({
  projectId,
  threadId,
  threadTitle,
  getThreadPrompts,
}: {
  projectId: string;
  threadId: string;
  threadTitle: string;
  getThreadPrompts?: (() => ReadonlyArray<string>) | undefined;
}) {
  const [packs, setPacks] = useState<ReadonlyArray<LpPackView> | null>(null);
  const [name, setName] = useState(threadTitle);
  const [saving, setSaving] = useState(false);
  const [savedId, setSavedId] = useState<string | null>(null);
  const refresh = useStableCallback(() => {
    lpApi
      .packs(projectId)
      .then((result) => setPacks(result.packs))
      .catch(() => setPacks([]));
  });
  // oxlint-disable-next-line logicpacks/no-unreasoned-state-sync -- loads this project's packs from the server
  useEffect(refresh, [projectId, refresh]);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    try {
      const saved = await lpApi.saveThreadAsPack({
        threadId,
        ...(name.trim() ? { name: name.trim() } : {}),
        prompts: getThreadPrompts?.() ?? [],
        appItems: await appItems(projectId),
      });
      setSavedId(saved.pack.id);
      toastManager.add({ type: "success", title: `Saved as pack "${saved.pack.name}"` });
      announceUnlocked(saved.unlocked);
      refresh();
    } catch (error) {
      toastManager.add({ type: "error", title: "Could not save", description: errorText(error) });
    }
    // The catch never rethrows, so this always runs (React Compiler cannot lower `finally`).
    setSaving(false);
  };
  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center">
          <span className="me-2">Packs</span>
          <Badge size="sm" variant="outline">
            Beta
          </Badge>
        </DialogTitle>
        <DialogDescription>
          A pack carries this thread's context: summary, decisions, files and app objects, and its
          steps. Use it in another thread, app or project. Agents read packs themselves.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <form
          className="flex items-center gap-2"
          data-testid="lp-pack-save-form"
          onSubmit={(event) => void save(event)}
        >
          <Input
            size="sm"
            value={name}
            aria-label="Pack name"
            data-testid="lp-pack-name"
            onChange={(event) => setName(event.target.value)}
          />
          <Button size="sm" type="submit" disabled={saving} data-testid="lp-pack-save">
            Save this thread as a pack
          </Button>
        </form>
        <section className="flex flex-col gap-1">
          <p className="text-xs font-medium text-muted-foreground">In this project</p>
          {packs === null ? (
            <p className="text-sm text-muted-foreground">Loading</p>
          ) : packs.length === 0 ? (
            <p className="text-sm text-muted-foreground">No packs yet.</p>
          ) : (
            <ul data-testid="lp-pack-list">
              {packs.map((view) => (
                <PackRow
                  key={view.pack.id}
                  view={view}
                  projectId={projectId}
                  threadId={threadId}
                  initiallyOpen={view.pack.id === savedId}
                />
              ))}
            </ul>
          )}
        </section>
      </DialogPanel>
    </>
  );
}

/** Packs in the thread header: save this thread as one, see context, use packs elsewhere. */
export function LpSavePackButton({
  projectId,
  environmentId,
  threadId,
  threadTitle,
  getThreadPrompts,
}: {
  projectId: string;
  environmentId: EnvironmentId | null;
  threadId: string;
  threadTitle: string;
  getThreadPrompts?: (() => ReadonlyArray<string>) | undefined;
}) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { session } = useLogicPacksSession(false);
  const [open, setOpen] = useState(false);
  // Packs are a gated feature: without it the entry point is simply not there.
  const unlocked = useFeature("packs");
  if (
    !unlocked ||
    session === null ||
    environmentId === null ||
    environmentId !== primaryEnvironmentId
  ) {
    return null;
  }
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="xs"
              variant="ghost"
              data-testid="lp-packs-open"
              aria-label="Packs (Beta)"
              onClick={() => setOpen(true)}
            />
          }
        >
          <PackageIcon aria-hidden />
        </TooltipTrigger>
        <TooltipPopup side="bottom">Packs: save this thread, use it elsewhere (Beta)</TooltipPopup>
      </Tooltip>
      <DialogPopup className="max-w-2xl" data-testid="lp-packs-dialog">
        {open ? (
          <PacksPanel
            projectId={projectId}
            threadId={threadId}
            threadTitle={threadTitle}
            getThreadPrompts={getThreadPrompts}
          />
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}
