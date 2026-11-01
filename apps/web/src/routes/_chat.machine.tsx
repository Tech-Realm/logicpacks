import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { LiveMachinePage, type LiveMachineSearch } from "../logicpacks/apps/LiveMachinePage";

export const Route = createFileRoute("/_chat/machine")({
  validateSearch: (raw: Record<string, unknown>): LiveMachineSearch =>
    typeof raw.project === "string" && raw.project.length > 0 ? { project: raw.project } : {},
  component: LiveMachineRoute,
});

function LiveMachineRoute() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  return (
    <LiveMachinePage
      search={search}
      onPick={(projectId) => void navigate({ to: "/machine", search: { project: projectId } })}
    />
  );
}
