import { LP_READONLY_BANNER_TEXT } from "./readOnly.logic";

/** Stands in for the composer when the signed-in member only has Read only access. */
export function LpReadOnlyBanner() {
  return (
    <div
      role="status"
      data-testid="lp-readonly-banner"
      className="rounded-xl border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground"
    >
      {LP_READONLY_BANNER_TEXT}
    </div>
  );
}
