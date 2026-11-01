import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { APP_BASE_NAME } from "../branding";
import { externalApi, formatMoney, type LpPricing } from "../logicpacks/externalApi";
import { BYO_AI_COPY, PRICE_COPY } from "../logicpacks/ExternalControls";
import { useFeatures } from "../logicpacks/features";

/**
 * Public pricing for vetted freelancers, in the visitor's currency (CF-IPCountry, then the
 * browser language, then the account's region, then US). Anyone can open it; no sign-in.
 */
/** The freelancer rate card is part of Talent: absent for accounts without it. */
function PricingPage() {
  const { loaded, features } = useFeatures();
  if (!loaded) return null;
  if (!features.includes("talent")) return <Navigate to="/" replace />;
  return <PricingContent />;
}

function PricingContent() {
  const [pricing, setPricing] = useState<LpPricing | null>(null);
  const [region, setRegion] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // oxlint-disable-next-line logicpacks/no-unreasoned-state-sync -- reads the published rate card for the chosen region
  useEffect(() => {
    let live = true;
    externalApi
      .pricing(region)
      .then((next) => {
        if (live) setPricing(next);
      })
      .catch((cause: unknown) => {
        if (live)
          setError(cause instanceof Error ? cause.message : "Prices are not available right now.");
      });
    return () => {
      live = false;
    };
  }, [region]);

  return (
    <div className="h-full overflow-y-auto bg-background px-4 py-10 text-foreground sm:px-6">
      <main className="mx-auto flex w-full max-w-3xl flex-col gap-10" data-testid="lp-pricing">
        <header className="flex flex-col gap-3">
          <span className="text-lg font-medium tracking-tight">{APP_BASE_NAME}</span>
          <h1 className="text-2xl leading-tight font-semibold">
            Vetted freelancers, priced for where you are
          </h1>
          <p className="text-sm text-muted-foreground">
            When your agents get stuck, bring in a designer, developer or DevOps freelancer vetted
            by LogicPacks. They join your project with access to only what the brief needs, and
            leave when it is done. {BYO_AI_COPY}
          </p>
          {pricing ? (
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              Prices in
              <select
                className="rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground"
                data-testid="lp-pricing-region"
                value={pricing.region.code}
                onChange={(event) => setRegion(event.target.value)}
              >
                {pricing.regions.map((option) => (
                  <option key={option.code} value={option.code}>
                    {option.label} ({option.currency})
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </header>

        {error ? <p className="text-sm text-destructive">{error}</p> : null}

        {pricing ? (
          <>
            <section className="flex flex-col gap-3">
              <h2 className="text-lg font-semibold">Hourly rates</h2>
              <p className="text-sm text-muted-foreground">{PRICE_COPY}</p>
              <table
                className="w-full border-collapse text-sm"
                data-testid="lp-pricing-rates"
                data-currency={pricing.region.currency}
              >
                <thead>
                  <tr className="border-b border-border text-left text-muted-foreground">
                    <th className="py-2 font-medium">Role</th>
                    {pricing.roles[0]?.levels.map((level) => (
                      <th key={level.level} className="py-2 text-right font-medium">
                        {level.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {pricing.roles.map((role) => (
                    <tr key={role.role} className="border-b border-border/60">
                      <td className="py-2">{role.label}</td>
                      {role.levels.map((level) => (
                        <td key={level.level} className="py-2 text-right tabular-nums">
                          {formatMoney(level.hourly, pricing.region.currency)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>

            <section className="flex flex-col gap-3">
              <h2 className="text-lg font-semibold">Packages</h2>
              <ul className="grid gap-3 sm:grid-cols-2" data-testid="lp-pricing-packages">
                {pricing.packages.map((pkg) => (
                  <li
                    key={pkg.id}
                    className="flex flex-col gap-1 rounded-lg border border-border p-4"
                  >
                    <span className="text-sm font-medium">
                      {pkg.name} · {pkg.hours} hours
                    </span>
                    <span className="text-xs text-muted-foreground">{pkg.blurb}</span>
                    <span className="text-sm tabular-nums">
                      From {formatMoney(pkg.fromPrice, pricing.region.currency)}
                      {pkg.discountPct > 0 ? ` (${pkg.discountPct}% off)` : ""}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="text-xs text-muted-foreground">
                Each request gets a written brief with milestones and a fixed number of hours.
                Offers stay open for {pricing.offerDays} days. More hours need a new offer, so the
                price never moves on its own. Payment: {pricing.payment}.
              </p>
            </section>

            <section className="flex flex-col gap-3" data-testid="lp-how-we-vet">
              <h2 className="text-lg font-semibold">How we vet</h2>
              <ul className="grid gap-3 sm:grid-cols-2">
                {pricing.vetting.map((check) => (
                  <li
                    key={check.id}
                    className="flex flex-col gap-1 rounded-lg border border-border p-4"
                  >
                    <span className="text-sm font-medium">{check.label}</span>
                    <span className="text-xs text-muted-foreground">{check.detail}</span>
                  </li>
                ))}
              </ul>
              <p className="text-xs text-muted-foreground">
                In your project they never see .env files, keys or certificates, pasted secrets are
                hidden from them, and their access ends when the work is complete or cancelled.
              </p>
            </section>
          </>
        ) : error === null ? (
          <p className="text-sm text-muted-foreground">Loading prices…</p>
        ) : null}
      </main>
    </div>
  );
}

export const Route = createFileRoute("/pricing")({
  component: PricingPage,
});
