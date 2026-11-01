// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no randomBytes.
import * as NodeCrypto from "node:crypto";

import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export const PAIRING_TTL_MS = 10 * 60_000;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

interface PendingPairing {
  readonly code: string;
  readonly pollToken: string;
  readonly device: string | null;
  readonly expiresAt: number;
  reserved: boolean;
  approved: { readonly token: string; readonly who: string } | null;
}

export type PollResult =
  | { readonly status: "pending" }
  | { readonly status: "expired" }
  | { readonly status: "approved"; readonly token: string; readonly who: string };

const randomCode = () => {
  const bytes = NodeCrypto.randomBytes(8);
  const chars = Array.from(bytes, (byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]);
  return `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
};

/**
 * Device-code sign-in for the helper: `lp login` shows a code, a signed-in
 * person approves it in the browser, and the helper collects its token once.
 * Pending codes live in memory; a restart only makes the user run `lp login` again.
 */
export const makePairingStore = (now: () => number) => {
  const pending = new Map<string, PendingPairing>();
  const sweep = () => {
    const at = now();
    for (const [code, entry] of pending) if (entry.expiresAt <= at) pending.delete(code);
  };
  return {
    start: (device: string | null) => {
      sweep();
      let code = randomCode();
      while (pending.has(code)) code = randomCode();
      const entry: PendingPairing = {
        code,
        pollToken: NodeCrypto.randomBytes(24).toString("base64url"),
        device,
        expiresAt: now() + PAIRING_TTL_MS,
        reserved: false,
        approved: null,
      };
      pending.set(code, entry);
      return { code, pollToken: entry.pollToken, expiresInSeconds: PAIRING_TTL_MS / 1000 };
    },
    describe: (code: string) => {
      sweep();
      const entry = pending.get(code.trim().toUpperCase());
      return entry === undefined
        ? null
        : { device: entry.device, approved: entry.approved !== null };
    },
    /** Claims a live code for approval, once, so one approval mints one token. */
    reserve: (code: string) => {
      sweep();
      const entry = pending.get(code.trim().toUpperCase());
      if (entry === undefined || entry.reserved) return null;
      entry.reserved = true;
      return { code: entry.code, device: entry.device };
    },
    complete: (code: string, approved: { readonly token: string; readonly who: string } | null) => {
      const entry = pending.get(code);
      if (entry === undefined) return;
      if (approved === null) entry.reserved = false;
      else entry.approved = approved;
    },
    poll: (pollToken: string): PollResult => {
      sweep();
      for (const [code, entry] of pending) {
        if (entry.pollToken !== pollToken) continue;
        if (entry.approved === null) return { status: "pending" };
        pending.delete(code);
        return { status: "approved", ...entry.approved };
      }
      return { status: "expired" };
    },
  };
};

export class HelperPairing extends Context.Service<
  HelperPairing,
  ReturnType<typeof makePairingStore>
>()("logicpacks/logicpacks/helperPairing") {}

export const layer = Layer.effect(
  HelperPairing,
  Effect.gen(function* () {
    const clock = yield* Clock.Clock;
    return makePairingStore(() => clock.currentTimeMillisUnsafe());
  }),
);
