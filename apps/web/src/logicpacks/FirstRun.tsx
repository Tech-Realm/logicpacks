import { CheckIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { cn } from "../lib/utils";
import { Button } from "../components/ui/button";
import { lpApi, type LpOnboardingChoice, type LpSession } from "./api";
import { ConnectAgentForm } from "./ConnectAgent";
import { useConnectedComputers } from "./ConnectComputer";
import { useFeature } from "./features";
import { AddProjectForm } from "./forms";
import {
  currentWorkspace,
  isMemberSession,
  refreshLogicPacksSession,
  useLogicPacksSession,
} from "./store";

function Step({
  number,
  title,
  done,
  active,
  children,
}: {
  number: number;
  title: string;
  done: boolean;
  active: boolean;
  children?: ReactNode;
}) {
  return (
    <li className="flex gap-3 p-5">
      <span
        className={cn(
          "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-medium tabular-nums transition-colors duration-200",
          done && "border-primary bg-primary text-primary-foreground",
          active && !done && "border-foreground",
        )}
      >
        {done ? <CheckIcon className="size-3.5" /> : number}
      </span>
      <div className="min-w-0 flex-1">
        <div className={cn("text-sm font-medium", !active && !done && "text-muted-foreground")}>
          {title}
        </div>
        {active && children ? <div className="mt-3">{children}</div> : null}
      </div>
    </li>
  );
}

function Welcome({ session }: { session: LpSession }) {
  return (
    <h1 className="text-2xl font-normal tracking-[-0.03em] sm:text-[2rem]">
      Welcome{session.user ? `, ${session.user.displayName}` : ""}
    </h1>
  );
}

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "Something went wrong.";

/** Full-page navigation: the provider's consent screen, then back home. */
const connect = (provider: "github" | "cloudflare") => {
  window.location.href = `/lp/auth/${provider}/connect?next=${encodeURIComponent("/")}`;
};

/**
 * The one first-run question. A developer connects GitHub (and optionally Cloudflare)
 * before their agent; a beginner gets a ready project on this host and goes straight to
 * a thread. Skippable, and changeable later on the account page.
 */
function HowDoYouWork({ session }: { session: LpSession }) {
  const [pending, setPending] = useState<LpOnboardingChoice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const choose = async (choice: LpOnboardingChoice) => {
    setPending(choice);
    setError(null);
    try {
      await lpApi.setOnboarding(choice);
      await refreshLogicPacksSession();
    } catch (cause) {
      setError(errorText(cause));
    }
    setPending(null);
  };
  return (
    <div
      className="w-full max-w-xl animate-rise px-6 py-12 text-left text-pretty"
      data-testid="lp-onboarding"
    >
      <Welcome session={session} />
      <p className="mt-1 text-lg leading-snug text-muted-foreground sm:text-xl">How do you work?</p>
      <div className="mt-8 grid gap-3 sm:grid-cols-2" role="radiogroup" aria-label="How you work">
        <Button
          variant="outline"
          size="sm-multiline"
          role="radio"
          aria-checked={false}
          disabled={pending !== null}
          data-testid="lp-onboarding-pro"
          onClick={() => void choose("pro")}
        >
          <span className="flex flex-col items-start gap-0.5 py-1 text-left">
            <span className="font-medium">I'm a developer</span>
            <span className="text-xs text-muted-foreground">
              Connect GitHub, then work in your own repositories.
            </span>
          </span>
        </Button>
        <Button
          variant="outline"
          size="sm-multiline"
          role="radio"
          aria-checked={false}
          disabled={pending !== null}
          data-testid="lp-onboarding-beginner"
          onClick={() => void choose("beginner")}
        >
          <span className="flex flex-col items-start gap-0.5 py-1 text-left">
            <span className="font-medium">
              {pending === "beginner" ? "Setting up your project" : "Just let me start"}
            </span>
            <span className="text-xs text-muted-foreground">
              We set up a project here. No accounts to connect.
            </span>
          </span>
        </Button>
      </div>
      {error ? (
        <p className="mt-3 text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      <div className="mt-4 flex justify-end">
        <Button
          size="xs"
          variant="ghost-muted"
          disabled={pending !== null}
          data-testid="lp-onboarding-skip"
          onClick={() => void choose("skipped")}
        >
          Skip for now
        </Button>
      </div>
    </div>
  );
}

/**
 * First run for a member of a shared host: answer "How do you work?", then connect an
 * agent and add a project, and the home page opens the first thread in it. Developers
 * connect GitHub first. Null when this is not a member session, so the host operator
 * keeps the regular empty state.
 */
export function LogicPacksFirstRun() {
  const { session } = useLogicPacksSession();
  const [skippedClaude, setSkippedClaude] = useState(false);
  const [skippedGithub, setSkippedGithub] = useState(false);
  const [skippedCloudflare, setSkippedCloudflare] = useState(false);
  const computers = useConnectedComputers();
  const cloudAgents = useFeature("cloud_agents");
  if (session === null || !isMemberSession(session)) return null;
  if (session.onboarding === null) return <HowDoYouWork session={session} />;

  const pro = session.onboarding === "pro";
  const github = session.connections?.github;
  const cloudflare = session.connections?.cloudflare;
  const githubShown = pro && github?.available === true;
  const cloudflareShown = pro && cloudflare?.available === true;
  const githubDone = github?.connected === true;
  const cloudflareDone = cloudflare?.connected === true;
  const githubActive = githubShown && !githubDone && !skippedGithub;
  const cloudflareActive =
    cloudflareShown && !githubActive && !cloudflareDone && !skippedCloudflare;
  const claudeDone =
    session.claude?.connected === true || session.agentConnected === true || computers.length > 0;
  const claudeActive = !githubActive && !cloudflareActive && !claudeDone && !skippedClaude;
  const projectActive = !githubActive && !cloudflareActive && !claudeActive;
  const workspace = currentWorkspace(session);
  const cloudflareNumber = githubShown ? 2 : 1;
  const agentNumber = (githubShown ? 1 : 0) + (cloudflareShown ? 1 : 0) + 1;
  return (
    <div
      className="w-full max-w-xl animate-rise px-6 py-12 text-left text-pretty"
      data-testid="lp-first-run"
    >
      <Welcome session={session} />
      <p className="mt-1 text-lg leading-snug text-muted-foreground sm:text-xl">
        {workspace
          ? `You're in ${workspace.name}. A few steps and your first agent is running.`
          : "A few steps and your first agent is running."}
      </p>
      {/* One frame, steps divided by hairlines, as on logicpacks.io (DESIGN.md, Layout). */}
      <ol className="mt-8 flex flex-col divide-y divide-hairline overflow-hidden rounded-frame border border-hairline bg-background">
        {githubShown ? (
          <Step
            number={1}
            title={
              githubDone ? `GitHub connected as ${github?.account ?? "you"}` : "Connect GitHub"
            }
            done={githubDone}
            active={githubActive}
          >
            <p className="text-sm text-muted-foreground">
              Your projects sync to your own GitHub and push as you.
            </p>
            <div className="mt-3 flex items-center justify-between gap-2">
              <Button size="sm" data-testid="lp-connect-github" onClick={() => connect("github")}>
                Connect GitHub
              </Button>
              <Button size="xs" variant="ghost-muted" onClick={() => setSkippedGithub(true)}>
                Skip for now
              </Button>
            </div>
          </Step>
        ) : null}
        {cloudflareShown ? (
          <Step
            number={cloudflareNumber}
            title={
              cloudflareDone
                ? `Cloudflare connected${cloudflare?.account ? ` as ${cloudflare.account}` : ""}`
                : "Connect Cloudflare (optional)"
            }
            done={cloudflareDone}
            active={cloudflareActive}
          >
            <p className="text-sm text-muted-foreground">
              For deploys and custom domains later. You can do this any time.
            </p>
            <div className="mt-3 flex items-center justify-between gap-2">
              <Button
                size="sm"
                variant="outline"
                data-testid="lp-connect-cloudflare"
                onClick={() => connect("cloudflare")}
              >
                Connect Cloudflare
              </Button>
              <Button
                size="xs"
                variant="ghost-muted"
                data-testid="lp-skip-cloudflare"
                onClick={() => setSkippedCloudflare(true)}
              >
                Skip
              </Button>
            </div>
          </Step>
        ) : null}
        <Step
          number={agentNumber}
          title={cloudAgents ? "Connect your agent" : "Connect your computer"}
          done={claudeDone}
          active={claudeActive}
        >
          <ConnectAgentForm
            onConnected={() => undefined}
            footer={
              <Button size="xs" variant="ghost-muted" onClick={() => setSkippedClaude(true)}>
                Skip for now
              </Button>
            }
          />
        </Step>
        <Step
          number={agentNumber + 1}
          title={pro ? "Add a project from GitHub" : "Add a project"}
          done={false}
          active={projectActive}
        >
          <AddProjectForm
            session={session}
            onCreated={() => undefined}
            initialSource={pro ? "git" : "empty"}
          />
        </Step>
        <Step
          number={agentNumber + 2}
          title="Start your first thread"
          done={false}
          active={false}
        />
      </ol>
    </div>
  );
}
