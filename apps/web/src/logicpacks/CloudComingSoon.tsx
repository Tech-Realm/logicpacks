import { useState, type FormEvent } from "react";

import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { lpApi } from "./api";
import { featuresApi } from "./features";
import { DESKTOP_DOWNLOAD_URL } from "./RecipeControls";

/**
 * The LogicPacks cloud for a signed-in member without cloud access: cloud workspaces are
 * coming soon, the Mac app works with a team today. An access code field lets someone who has
 * one in. Teammates invited into a cloud project skip this page (the server counts them in).
 */
export function CloudComingSoonPage() {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (code.trim().length === 0) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await featuresApi.redeem(code.trim());
      if (result.features.includes("cloud")) {
        window.location.assign("/");
        return;
      }
      setMessage("That code is saved, but it does not include cloud workspaces.");
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "That access code isn't valid.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main
      className="flex min-h-dvh items-center justify-center bg-background px-6 text-foreground"
      data-testid="lp-cloud-coming-soon"
    >
      <div className="flex w-full max-w-md flex-col gap-6">
        <div className="flex flex-col gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">
            Cloud workspaces are coming soon.
          </h1>
          <p className="text-muted-foreground">
            Download LogicPacks for Mac to work with your team now.
          </p>
        </div>
        <Button
          render={<a href={DESKTOP_DOWNLOAD_URL} target="_blank" rel="noreferrer" />}
          className="self-start"
          data-testid="lp-cloud-download"
        >
          Download for Mac
        </Button>
        <form className="flex flex-col gap-2" onSubmit={(event) => void submit(event)}>
          <label htmlFor="lp-cloud-code" className="text-sm text-muted-foreground">
            Have an access code?
          </label>
          <div className="flex gap-2">
            <Input
              id="lp-cloud-code"
              value={code}
              placeholder="LP-XXXX-XXXX"
              autoComplete="off"
              data-testid="lp-cloud-code-input"
              onChange={(event) => setCode(event.currentTarget.value)}
            />
            <Button
              type="submit"
              variant="outline"
              disabled={busy}
              data-testid="lp-cloud-code-submit"
            >
              Continue
            </Button>
          </div>
          {message ? (
            <p className="text-xs text-destructive" role="alert">
              {message}
            </p>
          ) : null}
        </form>
        <Button
          size="xs"
          variant="ghost-muted"
          className="self-start"
          onClick={() =>
            void lpApi
              .logout()
              .then(() => window.location.assign("/lp/login"))
              .catch(() => undefined)
          }
        >
          Sign out
        </Button>
      </div>
    </main>
  );
}
