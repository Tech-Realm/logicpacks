import { CheckIcon, CopyIcon, ExternalLinkIcon, TerminalIcon } from "lucide-react";
import { isElectron } from "../env";
import { LocalAgentsPanel } from "./LocalAgents";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";

import { ClaudeAI, OpenAI } from "../components/Icons";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { writeTextToClipboard } from "../hooks/useCopyToClipboard";
import { CONNECT_AGENT_PROMPT } from "./connectPrompt";
import { cn } from "../lib/utils";
import { lpApi, type LpAgentKind, type LpAgentLogin, type LpAgentStatus } from "./api";
import { ConnectComputerForm } from "./ConnectComputer";
import { refreshLogicPacksSession } from "./store";

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "Something went wrong.";

/** Mono marks for the four agents. OpenCode and Gemini get simple drawn marks. */
export function AgentMark({ kind, className }: { kind: LpAgentKind; className?: string }) {
  const base = cn("size-4 shrink-0", className);
  switch (kind) {
    case "claude":
      return <ClaudeAI aria-hidden className={cn(base, "fill-current")} />;
    case "codex":
      return <OpenAI aria-hidden className={base} />;
    case "opencode":
      return (
        <svg aria-hidden viewBox="0 0 24 24" className={base} fill="none" stroke="currentColor">
          <rect x="3.5" y="3.5" width="17" height="17" rx="3" strokeWidth="1.6" />
          <path d="M8 9.5 10.5 12 8 14.5M12.5 15h3.5" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      );
    case "gemini":
      return (
        <svg aria-hidden viewBox="0 0 24 24" className={base} fill="currentColor">
          <path d="M12 2c.5 5.2 4.8 9.5 10 10-5.2.5-9.5 4.8-10 10-.5-5.2-4.8-9.5-10-10 5.2-.5 9.5-4.8 10-10Z" />
        </svg>
      );
  }
}

const AGENT_ORDER: ReadonlyArray<LpAgentKind> = ["claude", "codex", "opencode", "gemini"];
const LABEL: Record<LpAgentKind, string> = {
  claude: "Claude",
  codex: "Codex",
  opencode: "OpenCode",
  gemini: "Gemini CLI",
};

function Copyable({ text, label }: { text: string; label: string }) {
  return (
    <Button
      size="xs"
      variant="ghost"
      aria-label={label}
      onClick={() => void writeTextToClipboard(text).catch(() => undefined)}
    >
      <CopyIcon aria-hidden />
    </Button>
  );
}

/** Where the CLI is missing on the host: say how to install it, never pretend to log in. */
function InstallHint({ status }: { status: LpAgentStatus }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
      <TerminalIcon aria-hidden className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1">
        {status.label} is not installed on this host. Install it there:{" "}
        <code className="rounded bg-muted px-1 text-foreground">{status.installHint}</code>
      </span>
      <Copyable text={status.installHint} label={`Copy the ${status.label} install command`} />
    </div>
  );
}

/** Device logins finish on their own; the others end with a code pasted back. */
const isDeviceLogin = (provider: LpAgentKind) => provider === "codex" || provider === "opencode";

type OpenCodeVia = "copilot" | "chatgpt";

const loginButtonLabel = (provider: LpAgentKind, via: OpenCodeVia | undefined) =>
  provider === "opencode"
    ? via === "chatgpt"
      ? "Log in with ChatGPT"
      : "Log in with GitHub Copilot"
    : provider === "gemini"
      ? "Log in with Google"
      : `Log in with ${LABEL[provider]}`;

const loginTitle = (provider: LpAgentKind, via: OpenCodeVia | undefined) =>
  provider === "claude"
    ? "Sign in to Claude"
    : provider === "codex"
      ? "Sign in to ChatGPT for Codex"
      : provider === "gemini"
        ? "Sign in with Google for Gemini CLI"
        : via === "chatgpt"
          ? "Sign in to ChatGPT for OpenCode"
          : "Sign in to GitHub Copilot for OpenCode";

/** "Log in with ...": the CLI's own login runs on the host, and its link is shown here. */
function BrowserLogin({
  provider,
  via,
  onConnected,
}: {
  provider: LpAgentKind;
  via?: OpenCodeVia;
  onConnected: () => void;
}) {
  const [login, setLogin] = useState<LpAgentLogin | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const polling = useRef<number | null>(null);

  const stopPolling = () => {
    if (polling.current !== null) window.clearInterval(polling.current);
    polling.current = null;
  };
  // oxlint-disable-next-line logicpacks/no-unreasoned-state-sync -- clears the device-login poll timer on unmount
  useEffect(
    () => () => {
      if (polling.current !== null) window.clearInterval(polling.current);
    },
    [],
  );

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const started = await lpApi.startAgentLogin(provider, via);
      setLogin(started);
      if (started.url === null) setError(started.output || "The login did not start. Try again.");
      // Device logins finish on their own once the code is approved in the browser.
      if (isDeviceLogin(provider) && started.url !== null) {
        stopPolling();
        polling.current = window.setInterval(() => {
          void lpApi
            .agentLoginStatus(provider)
            .then(async (status) => {
              if (status.connected) {
                stopPolling();
                await refreshLogicPacksSession();
                onConnected();
              } else if (!status.running) {
                stopPolling();
                setError(
                  `The ${LABEL[provider]} login ended before it was approved. Start it again.`,
                );
              }
            })
            .catch(() => undefined);
        }, 2500);
      }
    } catch (cause) {
      setError(errorText(cause));
    }
    setBusy(false);
  };

  const submitCode = async (event: FormEvent) => {
    event.preventDefault();
    if (login === null || code.trim() === "") return;
    setBusy(true);
    setError(null);
    try {
      if (provider !== "claude" && provider !== "gemini") return;
      const result = await lpApi.sendAgentLoginCode({
        provider,
        code: code.trim(),
        loginId: login.loginId,
      });
      if (result.connected) {
        await refreshLogicPacksSession();
        onConnected();
      } else {
        setError(
          result.failed
            ? `${provider === "gemini" ? "Google" : "Claude"} did not accept that code. Start again and paste the new one.`
            : "No sign-in came back yet. Check the code and try again.",
        );
      }
    } catch (cause) {
      setError(errorText(cause));
    }
    setBusy(false);
  };

  const cancel = () => {
    stopPolling();
    void lpApi.cancelAgentLogin(provider).catch(() => undefined);
    setLogin(null);
    setCode("");
  };

  const testId = via === "chatgpt" ? `lp-login-${provider}-chatgpt` : `lp-login-${provider}`;
  if (login === null || login.url === null) {
    return (
      <div className="flex flex-col gap-2">
        <Button
          variant="outline"
          className="justify-start"
          disabled={busy}
          data-testid={testId}
          onClick={() => void start()}
        >
          <AgentMark kind={provider} />
          {busy ? "Starting" : loginButtonLabel(provider, via)}
        </Button>
        {error ? (
          <p className="text-xs text-destructive" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div
      className="flex flex-col gap-3 rounded-xl border bg-muted/30 p-3"
      data-testid={`${testId}-flow`}
    >
      <div className="flex items-center gap-2 text-sm font-medium">
        <AgentMark kind={provider} />
        {loginTitle(provider, via)}
      </div>
      <ol className="flex flex-col gap-2 text-sm text-muted-foreground">
        <li>
          1.{" "}
          <a
            href={login.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 font-medium text-foreground underline underline-offset-4"
            data-testid={`${testId}-link`}
          >
            Open the sign-in page
            <ExternalLinkIcon aria-hidden className="size-3" />
          </a>
        </li>
        {isDeviceLogin(provider) ? (
          <li className="flex flex-wrap items-center gap-2">
            2. Enter this code there:
            <span
              className="rounded-md border bg-background px-2 py-0.5 font-mono text-base font-semibold tracking-widest text-foreground"
              data-testid={`${testId}-code`}
            >
              {login.code ?? "…"}
            </span>
            {login.code ? <Copyable text={login.code} label="Copy the device code" /> : null}
          </li>
        ) : (
          <li>
            2. Approve, then paste the code {provider === "gemini" ? "Google" : "Claude"} shows you
            here.
          </li>
        )}
      </ol>
      {!isDeviceLogin(provider) ? (
        <form className="flex gap-2" onSubmit={(event) => void submitCode(event)}>
          <Input
            size="sm"
            aria-label={provider === "gemini" ? "Code from Google" : "Code from Claude"}
            autoComplete="off"
            placeholder="Paste the code"
            value={code}
            data-testid={`lp-login-${provider}-code`}
            onChange={(event) => setCode(event.target.value)}
          />
          <Button size="sm" type="submit" disabled={busy || code.trim() === ""}>
            {busy ? "Checking" : "Connect"}
          </Button>
        </form>
      ) : (
        <p className="text-xs text-muted-foreground">Waiting for you to approve the code.</p>
      )}
      {error ? (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      <div>
        <Button size="xs" variant="ghost" onClick={cancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** The old way, kept as a fallback: paste a token from `claude setup-token`. */
function PasteToken({ onConnected }: { onConnected: () => void }) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await lpApi.connectClaude(token.trim());
      await refreshLogicPacksSession();
      onConnected();
    } catch (cause) {
      setError(errorText(cause));
    }
    setBusy(false);
  };
  return (
    <form className="flex flex-col gap-2" onSubmit={(event) => void submit(event)}>
      <p className="text-xs text-muted-foreground">
        Run <code className="rounded bg-muted px-1">claude setup-token</code> on your computer and
        paste the token it prints.
      </p>
      <div className="flex gap-2">
        <Input
          size="sm"
          aria-label="Claude token"
          autoComplete="off"
          placeholder="sk-ant-oat01-..."
          required
          type="password"
          value={token}
          onChange={(event) => setToken(event.target.value)}
        />
        <Button type="submit" size="sm" disabled={busy} data-testid="lp-connect-claude">
          {busy ? "Connecting" : "Connect"}
        </Button>
      </div>
      {error ? (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}

function ApiKeyForm({ status, onConnected }: { status: LpAgentStatus; onConnected: () => void }) {
  const [key, setKey] = useState("");
  const [keyProvider, setKeyProvider] = useState<"anthropic" | "openai" | "openrouter">(
    "anthropic",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const provider = status.kind as Exclude<LpAgentKind, "claude">;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await lpApi.connectAgentKey({
        provider,
        key: key.trim(),
        ...(provider === "opencode" ? { keyProvider } : {}),
      });
      await refreshLogicPacksSession();
      onConnected();
    } catch (cause) {
      setError(errorText(cause));
    }
    setBusy(false);
  };
  return (
    <form className="flex flex-col gap-2" onSubmit={(event) => void submit(event)}>
      {provider === "opencode" ? (
        <div className="flex gap-1" role="radiogroup" aria-label="Model provider">
          {(["anthropic", "openai", "openrouter"] as const).map((option) => (
            <Button
              key={option}
              type="button"
              size="xs"
              variant={keyProvider === option ? "secondary" : "ghost"}
              aria-pressed={keyProvider === option}
              onClick={() => setKeyProvider(option)}
            >
              {option === "anthropic" ? "Anthropic" : option === "openai" ? "OpenAI" : "OpenRouter"}
            </Button>
          ))}
        </div>
      ) : null}
      <div className="flex gap-2">
        <Input
          size="sm"
          aria-label={`${status.label} API key`}
          autoComplete="off"
          type="password"
          placeholder={provider === "gemini" ? "Gemini API key" : "API key"}
          value={key}
          onChange={(event) => setKey(event.target.value)}
        />
        <Button size="sm" type="submit" disabled={busy || key.trim() === ""}>
          {busy ? "Saving" : "Connect"}
        </Button>
      </div>
      {error ? (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}

/** OpenCode's free models: no account, nothing to paste. */
function FreeModels({ onConnected }: { onConnected: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      await lpApi.connectAgentFree("opencode");
      await refreshLogicPacksSession();
      onConnected();
    } catch (cause) {
      setError(errorText(cause));
    }
    setBusy(false);
  };
  return (
    <div className="flex flex-col gap-1">
      <Button
        variant="outline"
        className="justify-start"
        disabled={busy}
        data-testid="lp-connect-opencode-free"
        onClick={() => void connect()}
      >
        <AgentMark kind="opencode" />
        {busy ? "Connecting" : "Use the free models"}
      </Button>
      <p className="text-xs text-muted-foreground">No account needed. Sign in later for more.</p>
      {error ? (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Every way the host offers to connect one of the other agents. */
function OtherAgentConnect({
  status,
  onConnected,
}: {
  status: LpAgentStatus;
  onConnected: () => void;
}) {
  const methods = new Set(status.methods);
  return (
    <div className="flex flex-col gap-3" data-testid={`lp-connect-${status.kind}`}>
      {methods.has("free") && status.kind === "opencode" ? (
        <FreeModels onConnected={onConnected} />
      ) : null}
      {methods.has("browser") ? (
        status.kind === "opencode" ? (
          <div className="grid grid-cols-2 gap-2">
            <BrowserLogin provider="opencode" via="copilot" onConnected={onConnected} />
            <BrowserLogin provider="opencode" via="chatgpt" onConnected={onConnected} />
          </div>
        ) : (
          <BrowserLogin provider={status.kind} onConnected={onConnected} />
        )
      ) : null}
      {methods.has("api-key") ? <ApiKeyForm status={status} onConnected={onConnected} /> : null}
    </div>
  );
}

function AgentRow({
  status,
  selected,
  onSelect,
}: {
  status: LpAgentStatus;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      data-testid={`lp-agent-${status.kind}`}
      className={cn(
        "flex flex-col items-center gap-1.5 rounded-xl border px-2 py-3 text-xs transition-colors duration-150",
        selected
          ? "border-foreground bg-accent text-foreground"
          : "border-border text-muted-foreground hover:border-foreground/40 hover:text-foreground",
      )}
    >
      <span className="relative">
        <AgentMark kind={status.kind} className="size-5" />
        {status.connected ? (
          <CheckIcon
            aria-label="Connected"
            className="absolute -right-2 -bottom-1 size-3 rounded-full bg-foreground p-0.5 text-background"
          />
        ) : null}
      </span>
      <span className="font-medium">{status.label}</span>
      <span className="text-3xs text-muted-foreground">
        {status.connected ? "Connected" : status.installed ? "Not connected" : "Not installed"}
      </span>
    </button>
  );
}

/** The third way in: no login here, the person's own agent sets LogicPacks up with `lp`. */
function OwnAgentPrompt() {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col gap-2 rounded-lg border px-3 py-2" data-testid="lp-own-agent">
      <div className="flex items-center gap-2 text-sm">
        <TerminalIcon aria-hidden className="size-4" />
        Use your own agent: copy this prompt
        <Button
          size="xs"
          variant="ghost"
          className="ml-auto"
          aria-label="Copy the setup prompt"
          data-testid="lp-own-agent-copy"
          onClick={() =>
            void writeTextToClipboard(CONNECT_AGENT_PROMPT)
              .then(() => setCopied(true))
              .catch(() => undefined)
          }
        >
          {copied ? <CheckIcon aria-hidden /> : <CopyIcon aria-hidden />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <pre className="whitespace-pre-wrap rounded-md bg-muted px-2 py-1.5 font-mono text-2xs text-muted-foreground">
        {CONNECT_AGENT_PROMPT}
      </pre>
      <p className="text-3xs text-muted-foreground">
        Paste it into Claude Code, Codex, Cursor, Hermes or any agent. It installs the small lp
        helper, connects it to the LogicPacks app on this computer and shares this project. Keep the
        LogicPacks app open while it runs.
      </p>
    </div>
  );
}

/**
 * Connect your agent: Log in with Claude or Codex (the CLI login runs on the host, in
 * the member's own home), OpenCode (free models, a device login or a key) or Gemini CLI
 * (Google login or a key). A token paste stays as a small fallback for Claude.
 */
export function ConnectAgentForm({
  onConnected,
  footer,
}: {
  onConnected: () => void;
  footer?: ReactNode;
}) {
  const [statuses, setStatuses] = useState<ReadonlyArray<LpAgentStatus> | null>(null);
  /** Null until loaded; false: this member runs agents on their own computer (no cloud logins). */
  const [cloudAgents, setCloudAgents] = useState<boolean | null>(null);
  const [scope, setScope] = useState<string | null>(null);
  const [onComputer, setOnComputer] = useState(false);
  const [selected, setSelected] = useState<LpAgentKind | null>(null);
  const [pasteToken, setPasteToken] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    lpApi
      .agents()
      .then((result) => {
        setStatuses(result.providers);
        setCloudAgents(result.cloudAgents !== false);
      })
      .catch((cause) => setError(errorText(cause)));
  // oxlint-disable-next-line logicpacks/no-unreasoned-state-sync -- loads the host's agent statuses once
  useEffect(() => {
    lpApi
      .agents()
      .then((result) => {
        setStatuses(result.providers);
        setCloudAgents(result.cloudAgents !== false);
        setScope(result.scope ?? null);
      })
      .catch((cause) => setError(errorText(cause)));
  }, []);

  const connected = () => {
    void load();
    onConnected();
  };

  const byKind = new Map((statuses ?? []).map((status) => [status.kind, status]));
  const current = selected === null ? null : (byKind.get(selected) ?? null);

  // LogicPacks for Mac, or this computer's own host: the installed CLIs, no login buttons.
  if (isElectron || scope === "host") {
    return (
      <div className="flex flex-col gap-3" data-testid="lp-connect-agent">
        <LocalAgentsPanel />
        {footer ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">{footer}</div>
        ) : null}
      </div>
    );
  }

  // Without cloud_agents agents run on the member's computer. Cloud logins they already have
  // keep working (grandfathered) and stay listed; no new ones are offered.
  if (cloudAgents === false || onComputer) {
    const kept = (statuses ?? []).filter((status) => status.connected);
    return (
      <div className="flex flex-col gap-3" data-testid="lp-connect-agent">
        <ConnectComputerForm onConnected={onConnected} />
        {kept.map((status) => (
          <div
            key={status.kind}
            className="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm"
            data-testid={`lp-agent-${status.kind}-connected`}
          >
            <AgentMark kind={status.kind} />
            {status.label} connected on the cloud
            <CheckIcon aria-hidden className="ml-auto size-4" />
          </div>
        ))}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {cloudAgents === true ? (
            <Button size="xs" variant="ghost-muted" onClick={() => setOnComputer(false)}>
              Log in on the cloud instead
            </Button>
          ) : null}
          {footer}
        </div>
        {error ? (
          <p className="text-xs text-destructive" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3" data-testid="lp-connect-agent">
      <p className="text-sm text-muted-foreground">
        Your turns run on your own plan. Sign in once; nothing is shared unless you share it.
      </p>
      <div className="grid grid-cols-2 gap-2">
        {(["claude", "codex"] as const).map((kind) => {
          const status = byKind.get(kind);
          if (status?.connected) {
            return (
              <div
                key={kind}
                className="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm"
                data-testid={`lp-agent-${kind}-connected`}
              >
                <AgentMark kind={kind} />
                {LABEL[kind]} connected
                <CheckIcon aria-hidden className="ml-auto size-4" />
              </div>
            );
          }
          if (status !== undefined && !status.installed) {
            return (
              <div key={kind} className="col-span-2">
                <InstallHint status={status} />
              </div>
            );
          }
          return <BrowserLogin key={kind} provider={kind} onConnected={connected} />;
        })}
      </div>
      <OwnAgentPrompt />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Button
          size="xs"
          variant="ghost-muted"
          onClick={() => setPasteToken((value) => !value)}
          data-testid="lp-paste-token-toggle"
        >
          Paste a token instead
        </Button>
        <Button
          size="xs"
          variant="ghost-muted"
          onClick={() => setSelected((value) => (value === null ? "opencode" : null))}
          data-testid="lp-more-agents"
        >
          More agents
        </Button>
        <Button
          size="xs"
          variant="ghost-muted"
          onClick={() => setOnComputer(true)}
          data-testid="lp-run-on-computer"
        >
          Run on your computer
        </Button>
        {footer}
      </div>
      {pasteToken ? <PasteToken onConnected={connected} /> : null}
      {selected !== null && statuses !== null ? (
        <div className="flex flex-col gap-3" data-testid="lp-agent-picker">
          <div className="grid grid-cols-4 gap-2">
            {AGENT_ORDER.map((kind) => {
              const status = byKind.get(kind);
              return status === undefined ? null : (
                <AgentRow
                  key={kind}
                  status={status}
                  selected={selected === kind}
                  onSelect={() => setSelected(kind)}
                />
              );
            })}
          </div>
          {current === null ? null : current.connected ? (
            <div className="flex items-center gap-2 text-sm">
              <CheckIcon aria-hidden className="size-4" />
              {current.label} is connected.
              <Button
                size="xs"
                variant="ghost"
                onClick={() =>
                  void lpApi
                    .disconnectAgent(current.kind)
                    .then(load)
                    .then(() => refreshLogicPacksSession())
                }
              >
                Disconnect
              </Button>
            </div>
          ) : !current.installed ? (
            <InstallHint status={current} />
          ) : current.kind === "claude" || current.kind === "codex" ? (
            <BrowserLogin provider={current.kind} onConnected={connected} />
          ) : (
            <OtherAgentConnect status={current} onConnected={connected} />
          )}
        </div>
      ) : null}
      {error ? (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
