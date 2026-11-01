import { createFileRoute } from "@tanstack/react-router";

import { TeamUsagePage } from "../components/logicpacks/TeamUsagePage";
import { parseUsageView } from "../components/logicpacks/teamUsage.logic";
import { UsagePage } from "../components/usage/UsagePage";

export interface UsageSearch {
  /** LogicPacks: Usage opens on the team leaderboard; `machine` is this machine's transcripts. */
  readonly view?: "machine";
}

function UsageRoute() {
  const { view } = Route.useSearch();
  return parseUsageView(view) === "machine" ? <UsagePage /> : <TeamUsagePage />;
}

export const Route = createFileRoute("/_chat/usage")({
  validateSearch: (raw: Record<string, unknown>): UsageSearch =>
    parseUsageView(raw.view) === "machine" ? { view: "machine" } : {},
  component: UsageRoute,
});
