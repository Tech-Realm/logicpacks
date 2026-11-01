import { SidebarInset } from "../../components/ui/sidebar";
import { WorkspacePageHeader } from "../../components/WorkspacePageHeader";
import { isElectron } from "../../env";
import { MachineDemo } from "./MachineDemo";
import { parseDemoStart } from "./machineDemoScript";

export interface MachineDemoSearch {
  /** Start position in seconds. */
  readonly t?: number;
  readonly autoplay?: boolean;
}

/** The coming-soon "any app" demo: a shared machine with Blender, Resolve, a browser and code. */
export function MachineDemoPage({ search }: { search: MachineDemoSearch }) {
  return (
    <SidebarInset role="main" className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      {/* The desktop window only moves where CSS opts in, so keep a titlebar strip. */}
      {isElectron ? <WorkspacePageHeader electron /> : null}
      <MachineDemo initialTime={parseDemoStart(search.t)} autoplay={search.autoplay ?? true} />
    </SidebarInset>
  );
}
