import { AppWindowIcon } from "lucide-react";

import { SidebarInset } from "../../components/ui/sidebar";
import { WorkspacePageHeader } from "../../components/WorkspacePageHeader";
import { isElectron } from "../../env";
import { useProjects } from "../../state/entities";
import { useFeature } from "../features";
import { useLogicPacksSession } from "../store";
import { LiveMachine } from "./LiveMachine";

export interface LiveMachineSearch {
  /** The project id. Not "projectId": that search key is typed as a branded id elsewhere. */
  readonly project?: string;
}

/** "Any app" (Beta), live: share an app window from the host and work in it together. */
export function LiveMachinePage({
  search,
  onPick,
}: {
  search: LiveMachineSearch;
  onPick: (projectId: string) => void;
}) {
  useLogicPacksSession();
  const unlocked = useFeature("apps");
  const projects = useProjects().filter((project) => !project.isScratch);
  const project = projects.find((candidate) => candidate.id === search.project) ?? null;
  return (
    <SidebarInset role="main" className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      {isElectron ? <WorkspacePageHeader electron /> : null}
      {!unlocked ? null : project ? (
        <LiveMachine key={project.id} projectId={project.id} title={project.title} />
      ) : (
        <div
          className="mx-auto flex max-w-md flex-1 flex-col justify-center gap-3 p-6"
          data-testid="live-machine-pick"
        >
          <div className="flex items-center gap-2 text-sm font-medium">
            <AppWindowIcon className="size-4" /> Any app
          </div>
          <p className="text-sm text-muted-foreground">
            Share an app window from your Mac with a project. Everyone in it sees the app live, asks
            for control when they need it, and their agents work in it through the app's recipe.
          </p>
          <ul className="space-y-1">
            {projects.map((candidate) => (
              <li key={`${candidate.environmentId}:${candidate.id}`}>
                <button
                  type="button"
                  className="w-full rounded-md border border-border px-3 py-2 text-left text-sm hover:bg-accent"
                  onClick={() => onPick(candidate.id)}
                  data-testid="live-machine-project"
                >
                  {candidate.title}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </SidebarInset>
  );
}
