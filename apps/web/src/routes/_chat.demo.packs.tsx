import { createFileRoute } from "@tanstack/react-router";

import { PacksDemoPage, type PacksDemoSearch } from "../logicpacks/demo/PacksDemoPage";

export const Route = createFileRoute("/_chat/demo/packs")({
  validateSearch: (raw: Record<string, unknown>): PacksDemoSearch => ({
    ...(raw.t === undefined ? {} : { t: Number(raw.t) || 0 }),
    ...(raw.autoplay === false || raw.autoplay === "0" || raw.autoplay === 0
      ? { autoplay: false }
      : {}),
  }),
  component: PacksDemoRoute,
});

function PacksDemoRoute() {
  const search = Route.useSearch();
  return <PacksDemoPage search={search} />;
}
