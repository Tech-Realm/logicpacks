import { useAtomValue } from "@effect/atom-react";
import type { ServerProvider } from "@logicpacks/contracts";
import { CheckIcon, CopyIcon, TerminalIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../components/ui/button";
import { writeTextToClipboard } from "../hooks/useCopyToClipboard";
import { resolveOnboardingProviderInstallCommand } from "../onboarding/providerReadiness.logic";
import { useEnvironmentProviders, usePrimaryEnvironmentId } from "../state/environments";
import { primaryServerConfigAtom } from "../state/server";

/**
 * Agents on this computer: the LogicPacks app runs the Claude Code and Codex already installed
 * and logged in here. There is no login inside the app; when a CLI is missing it shows the
 * official native install command for this OS (no Node or npm) and says to log in in a terminal.
 */
const LOCAL_AGENTS = [
  { kind: "claude", label: "Claude Code", driver: "claudeAgent", login: "claude auth login" },
  { kind: "codex", label: "Codex", driver: "codex", login: "codex login" },
] as const;

/** The OS this app's own server runs on; before its config loads, the browser's guess. */
export function localAgentPlatform(
  serverOs: string | undefined,
  userAgent: string = typeof navigator === "undefined" ? "" : navigator.userAgent,
): "windows" | "posix" {
  if (serverOs !== undefined) return serverOs === "windows" ? "windows" : "posix";
  return /windows/i.test(userAgent) ? "windows" : "posix";
}

type LocalState = "ready" | "logged_out" | "missing" | "checking";

export function localAgentState(provider: ServerProvider | undefined): LocalState {
  if (provider === undefined) return "checking";
  if (!provider.installed) return "missing";
  if (provider.auth.status === "unauthenticated") return "logged_out";
  if (provider.auth.status === "authenticated") return "ready";
  return "checking";
}

function CopyLine({ text, testId }: { text: string; testId: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2 rounded-md bg-muted px-2 py-1">
      <code className="min-w-0 flex-1 truncate font-mono text-2xs" data-testid={testId}>
        {text}
      </code>
      <Button
        size="xs"
        variant="ghost"
        aria-label={`Copy ${text}`}
        onClick={() =>
          void writeTextToClipboard(text)
            .then(() => setCopied(true))
            .catch(() => undefined)
        }
      >
        {copied ? <CheckIcon aria-hidden /> : <CopyIcon aria-hidden />}
      </Button>
    </div>
  );
}

export function LocalAgentsPanel() {
  const primary = usePrimaryEnvironmentId();
  const byEnvironment = useEnvironmentProviders();
  const providers = primary === null ? [] : (byEnvironment.get(primary) ?? []);
  const platform = localAgentPlatform(
    useAtomValue(primaryServerConfigAtom)?.environment.platform.os,
  );
  return (
    <div className="flex flex-col gap-3" data-testid="lp-local-agents">
      <p className="text-sm text-muted-foreground">
        Agents run on this computer with your own Claude Code or Codex, using the login you already
        have. Nothing of yours is stored on our servers.
      </p>
      {LOCAL_AGENTS.map((agent) => {
        const provider =
          providers.find((p) => p.driver === agent.driver && p.enabled) ??
          providers.find((p) => p.driver === agent.driver);
        const state = localAgentState(provider);
        return (
          <div
            key={agent.kind}
            className="flex flex-col gap-2 rounded-lg border px-3 py-2"
            data-testid={`lp-local-agent-${agent.kind}`}
            data-state={state}
          >
            <div className="flex items-center gap-2 text-sm">
              <TerminalIcon aria-hidden className="size-4" />
              <span className="font-medium">{agent.label}</span>
              <span className="ml-auto text-xs text-muted-foreground">
                {state === "ready"
                  ? provider?.auth.email
                    ? `Ready, ${provider.auth.email}`
                    : "Ready"
                  : state === "logged_out"
                    ? "Installed, not logged in"
                    : state === "missing"
                      ? "Not installed"
                      : "Checking"}
              </span>
            </div>
            {state === "missing" ? (
              <>
                <p className="text-xs text-muted-foreground">Install it in your terminal:</p>
                <CopyLine
                  text={resolveOnboardingProviderInstallCommand(
                    agent.driver,
                    platform === "windows" ? "windows" : "darwin",
                  )}
                  testId={`lp-local-install-${agent.kind}`}
                />
                <p className="text-xs text-muted-foreground">Then log in in your terminal:</p>
                <CopyLine text={agent.login} testId={`lp-local-login-${agent.kind}`} />
              </>
            ) : state === "logged_out" ? (
              <>
                <p className="text-xs text-muted-foreground">Log in in your terminal:</p>
                <CopyLine text={agent.login} testId={`lp-local-login-${agent.kind}`} />
              </>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
