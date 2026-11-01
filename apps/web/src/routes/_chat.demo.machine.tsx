import { createFileRoute } from "@tanstack/react-router";

import { MachineDemoPage, type MachineDemoSearch } from "../logicpacks/demo/MachineDemoPage";

export const Route = createFileRoute("/_chat/demo/machine")({
  validateSearch: (raw: Record<string, unknown>): MachineDemoSearch => ({
    ...(raw.t === undefined ? {} : { t: Number(raw.t) || 0 }),
    ...(raw.autoplay === false || raw.autoplay === "0" || raw.autoplay === 0
      ? { autoplay: false }
      : {}),
  }),
  component: MachineDemoRoute,
});

function MachineDemoRoute() {
  const search = Route.useSearch();
  return <MachineDemoPage search={search} />;
}
