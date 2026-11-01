import { createFileRoute } from "@tanstack/react-router";
import { LayoutSettingsPanel } from "../components/settings/LayoutSettingsPanel";

export const Route = createFileRoute("/_chat/settings/layout")({ component: LayoutSettingsPanel });
