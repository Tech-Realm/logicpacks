import { SidebarInset } from "../../components/ui/sidebar";
import { WorkspacePageHeader } from "../../components/WorkspacePageHeader";
import { isElectron } from "../../env";
import { PacksDemo } from "./PacksDemo";
import { parsePacksDemoStart } from "./packsDemoScript";

export interface PacksDemoSearch {
  readonly t?: number;
  readonly autoplay?: boolean;
}

export function PacksDemoPage({ search }: { search: PacksDemoSearch }) {
  return (
    <SidebarInset role="main" className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      {isElectron ? <WorkspacePageHeader electron /> : null}
      <PacksDemo initialTime={parsePacksDemoStart(search.t)} autoplay={search.autoplay ?? true} />
    </SidebarInset>
  );
}
