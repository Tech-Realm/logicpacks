import { useLocation, useNavigate } from "@tanstack/react-router";
import { AppWindowIcon } from "lucide-react";

import { useFeature } from "../features";

import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "../../components/ui/sidebar";

/** The scripted film demos stay reachable by direct URL only; the signed-in app never links them. */
export const MACHINE_DEMO_PATH = "/demo/machine";
export const PACKS_DEMO_PATH = "/demo/packs";
/** The live "Any app": share a real window from the host. */
export const LIVE_MACHINE_PATH = "/machine";

/**
 * "Any app" (Beta): the live, access-gated app sharing. Accounts without the "apps" feature get
 * nothing at all here, not a teaser and not an empty Beta label.
 */
export function BetaSidebarGroup() {
  const apps = useFeature("apps");
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const active = useLocation({ select: (location) => location.pathname === LIVE_MACHINE_PATH });
  if (!apps) return null;
  return (
    <section aria-labelledby="lp-beta-group" className="flex flex-col gap-0.5">
      <h3
        id="lp-beta-group"
        className="px-[var(--sidebar-row-content-inset)] text-[11px] font-medium text-sidebar-muted-foreground"
      >
        Beta
      </h3>
      <SidebarMenu className="flex-row gap-1">
        <SidebarMenuItem className="min-w-0 flex-1">
          <SidebarMenuButton
            size="sm"
            isActive={active}
            data-testid="any-app-demo-entry"
            className="h-8 justify-start text-[13px]"
            onClick={() => {
              if (isMobile) setOpenMobile(false);
              void navigate({ to: LIVE_MACHINE_PATH });
            }}
          >
            <AppWindowIcon />
            <span className="truncate">
              Any app
              <span className="sr-only"> (Beta)</span>
            </span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    </section>
  );
}
