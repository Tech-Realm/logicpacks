/**
 * External team (Beta): the payment seam. Today every charge is "invoiced": recorded in the
 * internal ledger and settled outside the app. A real provider (Stripe or another) plugs in
 * by implementing `PaymentProvider` and being returned from `paymentProvider()`; nothing else
 * in the flow changes. No provider is wired until the owner approves one.
 */
import type { Charge } from "./externalTeam.ts";

export interface PaymentProvider {
  readonly id: string;
  /** What the customer sees: "Payment: invoiced". */
  readonly label: string;
  /** Opens a charge for an accepted offer. Must not move money without the customer's consent. */
  readonly open: (charge: Charge) => Promise<Pick<Charge, "status" | "reference">>;
  /** Cancels an open charge (offer cancelled before work). */
  readonly void: (charge: Charge) => Promise<Pick<Charge, "status">>;
}

/** Records the charge as invoiced; settled by invoice outside the app. */
export const invoicedProvider: PaymentProvider = {
  id: "invoice",
  label: "invoiced",
  open: async (charge) => ({
    status: "invoiced",
    reference: `INV-${charge.id.slice(-8).toUpperCase()}`,
  }),
  void: async () => ({ status: "void" }),
};

export const paymentProvider = (): PaymentProvider => invoicedProvider;
