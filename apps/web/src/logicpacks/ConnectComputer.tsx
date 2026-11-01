import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@logicpacks/client-runtime/state/runtime";
import { CheckIcon, LaptopIcon } from "lucide-react";
import { useState, type FormEvent } from "react";

import { DESKTOP_DOWNLOAD_URL } from "~/branding";
import { connectPairing as connectPairingAtom } from "~/connection/onboarding";
import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import { useAtomCommand } from "~/state/use-atom-command";
import { CommandBlock } from "../components/CommandBlock";
import { parsePairingUrlFields } from "../components/settings/ConnectionsSettings.logic";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";

/** The command that starts LogicPacks on the member's computer and prints a pairing URL. */
export const LOCAL_SERVE_COMMAND = "logicpacks serve";

/** Environments other than this cloud host: the member's own computers, connected from this browser. */
export function useConnectedComputers() {
  const { environments } = useEnvironments();
  const primaryId = usePrimaryEnvironmentId();
  return environments.filter((environment) => environment.environmentId !== primaryId);
}

/**
 * Run on your computer: the default way to run agents. The member starts LogicPacks on their
 * own machine (the command or the desktop app), pastes the pairing URL it prints, and this
 * browser connects to it as an environment. Turns then run there, on their own login, and
 * stream into this web app. No AI login of theirs is stored on the cloud host.
 */
export function ConnectComputerForm({ onConnected }: { onConnected?: () => void }) {
  const computers = useConnectedComputers();
  const connectPairing = useAtomCommand(connectPairingAtom, { reportFailure: false });
  const [pairingUrl, setPairingUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const fields = parsePairingUrlFields(pairingUrl);
    if (fields === null) {
      setError("Paste the full Pairing URL your computer printed.");
      return;
    }
    setBusy(true);
    setError(null);
    const result = await connectPairing(fields);
    setBusy(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const cause = squashAtomCommandFailure(result);
        setError(
          cause instanceof Error
            ? `Could not connect: ${cause.message}`
            : "Could not connect. Check that LogicPacks is still running on your computer.",
        );
      }
      return;
    }
    setPairingUrl("");
    onConnected?.();
  };

  return (
    <div className="flex flex-col gap-3" data-testid="lp-connect-computer">
      <p className="text-sm text-muted-foreground">
        Your agents run on your own computer with your own Claude or Codex login. This web app
        drives them; your AI login is never stored on our servers.
      </p>
      {computers.map((computer) => (
        <div
          key={computer.environmentId}
          className="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm"
          data-testid="lp-computer-connected"
        >
          <LaptopIcon aria-hidden className="size-4" />
          {computer.label} connected
          <CheckIcon aria-hidden className="ml-auto size-4" />
        </div>
      ))}
      {computers.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          Add a project and pick {computers[0]!.label} as its environment; its threads run there.
        </p>
      ) : null}
      <div className="text-sm">
        <p>
          1. Start LogicPacks on your computer: open the{" "}
          <a
            className="underline underline-offset-2 hover:text-foreground"
            href={DESKTOP_DOWNLOAD_URL}
            target="_blank"
            rel="noreferrer noopener"
          >
            desktop app
          </a>
          , or run this where the logicpacks command is installed:
        </p>
        <CommandBlock command={LOCAL_SERVE_COMMAND} className="mt-2" />
      </div>
      <form className="flex flex-col gap-2 text-sm" onSubmit={(event) => void submit(event)}>
        <label htmlFor="lp-pairing-url">2. Paste the Pairing URL it prints:</label>
        <div className="flex gap-2">
          <Input
            id="lp-pairing-url"
            value={pairingUrl}
            onChange={(event) => setPairingUrl(event.target.value)}
            placeholder="http://127.0.0.1:3773/pair#token=..."
            spellCheck={false}
            disabled={busy}
            data-testid="lp-pairing-url"
          />
          <Button
            type="submit"
            size="sm"
            disabled={busy || pairingUrl.trim().length === 0}
            data-testid="lp-connect-computer-submit"
          >
            {busy ? "Connecting" : "Connect"}
          </Button>
        </div>
      </form>
      {error ? (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
