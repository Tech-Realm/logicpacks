import { useNavigate } from "@tanstack/react-router";
import { LayoutPanelLeftIcon } from "lucide-react";

import { allLayoutModes } from "~/layoutModes/layoutModes";
import {
  setActiveLayoutMode,
  useActiveLayoutMode,
  useUserPrefsStore,
} from "~/layoutModes/userPrefsStore";
import { requestTourReplay } from "~/productTour/productTourStore";
import { Button } from "../ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";

/** The top bar's layout switch: Dev, Vibe and custom modes, with the shortcut in its label. */
export function LayoutModeSwitcher({ shortcutLabel }: { readonly shortcutLabel: string | null }) {
  const navigate = useNavigate();
  const mode = useActiveLayoutMode();
  const customModes = useUserPrefsStore((state) => state.prefs.layout.customModes);
  const label = `Layout: ${mode.label}${shortcutLabel ? ` (${shortcutLabel})` : ""}`;
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            size="xs"
            variant="ghost"
            className="shrink-0 [-webkit-app-region:no-drag]"
            aria-label={label}
            title={label}
            data-tour="layout-switcher"
            data-testid="lp-layout-switcher"
            data-layout-mode={mode.id}
          />
        }
      >
        <LayoutPanelLeftIcon className="size-4" />
        <span className="text-xs">{mode.label}</span>
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuGroup>
          <MenuGroupLabel>Layout</MenuGroupLabel>
          <MenuRadioGroup
            value={mode.id}
            onValueChange={(value) => setActiveLayoutMode(String(value))}
          >
            {allLayoutModes(customModes).map((option) => (
              <MenuRadioItem
                key={option.id}
                value={option.id}
                data-testid={`lp-layout-option-${option.id}`}
              >
                {option.label}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
        <MenuSeparator />
        <MenuItem onClick={() => void navigate({ to: "/settings/layout" })}>
          Layout settings
        </MenuItem>
        <MenuItem onClick={requestTourReplay} data-testid="lp-replay-tour-menu">
          Replay tour
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}
