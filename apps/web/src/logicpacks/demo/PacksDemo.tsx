import {
  BookOpenIcon,
  BrainIcon,
  CheckIcon,
  FileTextIcon,
  GavelIcon,
  ListOrderedIcon,
  PackageIcon,
  PauseIcon,
  PenLineIcon,
  PlayIcon,
  RotateCcwIcon,
  SlidersHorizontalIcon,
  UserIcon,
  UsersIcon,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useEffectEvent, useState, type CSSProperties } from "react";

import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { cn } from "../../lib/utils";
import { AgentMark } from "../ConnectAgent";
import "./machineDemo.css";
import {
  COMPARE_PROMPT,
  COMPARE_PROMPT_MS,
  CONTEXT_BUDGET_TOKENS,
  GENERIC_ANSWER,
  PACK_ENTRY_LABEL,
  PACK_ENTRY_TOTAL_V2,
  PACK_JSON_V1,
  PACK_NAME,
  PACK_PROJECT,
  PACKED_ANSWER,
  PACKS_AGENT_LABEL,
  PACKS_AGENTS,
  PACKS_CHAPTERS,
  PACKS_DEMO_DURATION_MS,
  V2_PUBLISHED_MS,
  agentPackVersionAt,
  agentPullsAt,
  agentStateAt,
  answerAt,
  answerChecksAt,
  contextCountsAt,
  formatDemoTime,
  packDiffAt,
  packEntriesAt,
  packJsonLinesAt,
  packLayersAt,
  packsChapterAt,
  packsStageAt,
  packsTurnsFor,
  packVersionAt,
  type ContextField,
  type PackEntryKind,
} from "./packsDemoScript";

const ENTRY_ICON: Record<PackEntryKind, LucideIcon> = {
  decision: GavelIcon,
  style: PenLineIcon,
  preference: SlidersHorizontalIcon,
  domain: BookOpenIcon,
  memory: BrainIcon,
  example: FileTextIcon,
};

const FIELD_ICON: Record<ContextField, LucideIcon> = {
  summary: BookOpenIcon,
  decisions: GavelIcon,
  references: FileTextIcon,
  steps: ListOrderedIcon,
};

const FIELDS: readonly ContextField[] = ["summary", "decisions", "references", "steps"];

/** Same clock as the machine demo, sized to this script. */
function usePacksClock(initialTime: number, autoplay: boolean) {
  const [time, setTime] = useState(initialTime);
  const [playing, setPlaying] = useState(autoplay && initialTime < PACKS_DEMO_DURATION_MS);

  // oxlint-disable-next-line logicpacks/no-unreasoned-state-sync -- the clock is driven by animation frames, an external timer.
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const delta = now - last;
      last = now;
      setTime((current) => Math.min(PACKS_DEMO_DURATION_MS, current + delta));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing]);

  const ended = time >= PACKS_DEMO_DURATION_MS;
  if (ended && playing) setPlaying(false);

  return {
    time,
    playing,
    toggle: () => {
      if (ended) setTime(0);
      setPlaying((value) => !value || ended);
    },
    restart: () => {
      setTime(0);
      setPlaying(true);
    },
    seek: (next: number) => setTime(Math.min(PACKS_DEMO_DURATION_MS, Math.max(0, next))),
  };
}

export interface PacksDemoProps {
  /** Start position in ms; `?t=` sets it from the URL. */
  readonly initialTime?: number;
  readonly autoplay?: boolean;
}

export function PacksDemo({ initialTime = 0, autoplay = true }: PacksDemoProps) {
  const clock = usePacksClock(initialTime, autoplay);
  const t = clock.time;

  const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (event.code !== "Space" || event.repeat) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest("input, textarea, [contenteditable='true'], button")) return;
    event.preventDefault();
    clock.toggle();
  });
  // oxlint-disable-next-line logicpacks/no-unreasoned-state-sync -- subscribes to window key presses for Space to play.
  useEffect(() => {
    const listener = (event: KeyboardEvent) => onKeyDown(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground"
      data-testid="packs-demo"
      data-demo-time={Math.round(t)}
      data-demo-stage={packsStageAt(t)}
    >
      <PacksHeader t={t} />
      <div className="grid min-h-0 flex-1 grid-cols-[14rem_minmax(0,1fr)_19rem] gap-px bg-border/60">
        <aside className="flex min-h-0 flex-col overflow-y-auto bg-background" aria-label="Pack">
          <PackOutliner t={t} />
          <SourcePanel t={t} />
        </aside>
        <section className="flex min-h-0 min-w-0 flex-col bg-background" aria-label="Stage">
          <Stage t={t} />
          <AgentStrip t={t} />
        </section>
        <aside className="flex min-h-0 flex-col overflow-y-auto bg-background" aria-label="Agents">
          <AgentTurns t={t} />
        </aside>
      </div>
      <Transport
        t={t}
        playing={clock.playing}
        onToggle={clock.toggle}
        onRestart={clock.restart}
        onSeek={clock.seek}
      />
    </div>
  );
}

function PacksHeader({ t }: { t: number }) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-4">
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate text-sm font-medium">Packs</span>
        <Badge variant="outline">
          <PackageIcon />
          {PACK_NAME} v{packVersionAt(t)}
        </Badge>
        <Badge variant="secondary" data-testid="packs-demo-beta">
          Beta
        </Badge>
        <span className="hidden truncate text-xs text-muted-foreground xl:inline">
          Never fine-tune a model. Use a pack instead.
        </span>
      </div>
      <span className="ml-auto w-32 truncate text-right text-xs text-muted-foreground">
        {packsChapterAt(t).label}
      </span>
    </header>
  );
}

function SectionLabel({ children, aside }: { children: string; aside?: string }) {
  return (
    <div className="flex items-center pb-2 text-2xs font-medium tracking-wide text-muted-foreground uppercase">
      {children}
      {aside ? <span className="ml-auto normal-case tracking-normal">{aside}</span> : null}
    </div>
  );
}

function PackOutliner({ t }: { t: number }) {
  const counts = contextCountsAt(t);
  const diff = packDiffAt(t);
  return (
    <div className="border-b border-border p-3" data-testid="packs-demo-outliner">
      <SectionLabel aside={`v${packVersionAt(t)}`}>pack.json</SectionLabel>
      <div className="flex items-center gap-1.5 text-xs font-medium">
        <PackageIcon className="size-3.5" />
        <span className="truncate">{PACK_NAME}</span>
      </div>
      <div className="mt-1 ml-1.5 border-l border-border pl-2 font-mono text-3xs text-muted-foreground">
        <div className="py-0.5">formatVersion: recipe/1</div>
        <div className="py-0.5 text-foreground">context</div>
      </div>
      <div className="ml-4 space-y-0.5 border-l border-border pl-2">
        {FIELDS.map((field) => {
          const Icon = FIELD_ICON[field];
          const changed = diff.some((line) => line.field === field);
          return (
            <div
              key={field}
              className={cn(
                "flex items-center gap-1.5 rounded px-1 py-0.5 text-xs",
                counts[field] > 0 ? "text-foreground" : "text-muted-foreground/60",
              )}
            >
              <Icon className="size-3" />
              <span className="font-mono text-3xs">{field}</span>
              {changed ? (
                <span className="rounded border border-border px-1 text-3xs text-muted-foreground">
                  changed
                </span>
              ) : null}
              <span className="ml-auto tabular-nums text-3xs text-muted-foreground">
                {counts[field]}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SourcePanel({ t }: { t: number }) {
  const entries = packEntriesAt(t);
  return (
    <div className="p-3" data-testid="packs-demo-sources">
      <SectionLabel aside={PACK_PROJECT}>Built from work</SectionLabel>
      {entries.length === 0 ? (
        <div className="text-xs text-muted-foreground">
          Threads, reviews and files the team already has.
        </div>
      ) : null}
      <div className="space-y-1.5">
        {entries.map((entry) => {
          const Icon = ENTRY_ICON[entry.kind];
          return (
            <div key={entry.id} className="text-3xs leading-snug" data-demo-motion="rise">
              <div className="flex items-center gap-1 text-muted-foreground">
                <Icon className="size-3" />
                {PACK_ENTRY_LABEL[entry.kind]}
              </div>
              <div className="truncate text-foreground/80">{entry.from}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Stage({ t }: { t: number }) {
  const stage = packsStageAt(t);
  return (
    <div className="relative min-h-0 flex-1 overflow-hidden" data-testid="packs-demo-stage">
      <div key={stage} className="absolute inset-0 overflow-y-auto p-6" data-demo-motion="rise">
        {stage === "pitch" ? <Pitch /> : null}
        {stage === "build" ? <BuildView t={t} /> : null}
        {stage === "plug" ? <PlugView t={t} /> : null}
        {stage === "compare" ? <CompareView t={t} /> : null}
        {stage === "versions" ? <VersionsView t={t} /> : null}
        {stage === "pulls" ? <PullsView t={t} /> : null}
        {stage === "close" ? <Closing /> : null}
      </div>
    </div>
  );
}

function Pitch() {
  return (
    <div className="mx-auto flex h-full max-w-xl flex-col justify-center gap-4">
      <div className="text-3xl font-semibold tracking-tight">Never fine-tune a model.</div>
      <div className="text-3xl font-semibold tracking-tight text-muted-foreground">
        Use a pack instead.
      </div>
      <p className="text-sm text-muted-foreground">
        For small labs that want a model that knows their style, their decisions and their history,
        without a training run, a GPU bill or a model to babysit.
      </p>
    </div>
  );
}

function BuildView({ t }: { t: number }) {
  const entries = packEntriesAt(t);
  const jsonLines = packJsonLinesAt(t);
  return (
    <div className="grid h-full grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] gap-4">
      <div className="min-w-0">
        <SectionLabel aside={`${entries.length} entries`}>Captured</SectionLabel>
        <div className="space-y-2">
          {entries.map((entry) => {
            const Icon = ENTRY_ICON[entry.kind];
            return (
              <div
                key={entry.id}
                className="rounded-lg border border-border bg-card p-2"
                data-demo-motion="pop"
              >
                <div className="flex items-center gap-1.5 text-3xs text-muted-foreground">
                  <Icon className="size-3" />
                  {PACK_ENTRY_LABEL[entry.kind]}
                  <span className="ml-auto font-mono">context.{entry.field}</span>
                </div>
                <div className="mt-1 text-xs leading-snug">
                  {entry.shown}
                  {entry.streaming ? <Caret /> : null}
                </div>
                <div className="mt-0.5 text-3xs text-muted-foreground">by {entry.by}</div>
              </div>
            );
          })}
        </div>
      </div>
      <div className="min-w-0">
        <SectionLabel aside=".logicpacks/packs">pack.json</SectionLabel>
        <pre
          className="overflow-hidden rounded-lg border border-border bg-muted/30 p-3 font-mono text-3xs leading-relaxed"
          data-testid="packs-demo-json"
        >
          {PACK_JSON_V1.slice(0, jsonLines).map((line, index) => (
            // oxlint-disable-next-line react/no-array-index-key -- lines of fixed text, only ever appended; repeats like "}," have no other identity
            <div key={index} className="whitespace-pre">
              {line.includes('"formatVersion"') || line.includes('"context"') ? (
                <span className="font-semibold text-foreground">{line}</span>
              ) : (
                <span className="text-foreground/75">{line}</span>
              )}
            </div>
          ))}
        </pre>
      </div>
    </div>
  );
}

function PlugView({ t }: { t: number }) {
  return (
    <div className="mx-auto flex h-full max-w-2xl flex-col justify-center gap-5">
      <div>
        <div className="text-lg font-semibold">One pack, every agent</div>
        <div className="text-sm text-muted-foreground">
          The same pack.json loads into each agent as context. No weights change.
        </div>
      </div>
      <div className="grid grid-cols-4 gap-3">
        {PACKS_AGENTS.map((agent) => {
          const state = agentStateAt(agent, t);
          return (
            <div
              key={agent}
              className={cn(
                "flex flex-col items-center gap-2 rounded-xl border p-4 transition-colors",
                state === "tuned" ? "border-foreground/60 bg-card" : "border-border",
              )}
              data-testid={`packs-demo-agent-${agent}`}
              data-state={state}
            >
              <AgentMark kind={agent} className="size-7" />
              <div className="text-sm font-medium">{PACKS_AGENT_LABEL[agent]}</div>
              <div className="flex items-center gap-1 text-3xs text-muted-foreground">
                {state === "tuned" ? (
                  <>
                    <CheckIcon className="size-3 text-foreground" />
                    <span className="text-foreground">Tuned</span>
                  </>
                ) : state === "loading" ? (
                  <>
                    <span className="size-1.5 animate-pulse rounded-full bg-foreground" />
                    Loading pack
                  </>
                ) : (
                  "Plain model"
                )}
              </div>
              <div className="text-3xs text-muted-foreground">
                {state === "tuned" ? "0 training runs" : " "}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AnswerCard({
  title,
  aside,
  lines,
  streaming,
  muted,
  testId,
}: {
  title: string;
  aside: string;
  lines: readonly string[];
  streaming: boolean;
  muted?: boolean;
  testId: string;
}) {
  return (
    <div
      className={cn(
        "min-w-0 rounded-lg border p-3",
        muted ? "border-dashed border-border" : "border-foreground/50 bg-card",
      )}
      data-testid={testId}
    >
      <SectionLabel aside={aside}>{title}</SectionLabel>
      <div
        className={cn(
          "space-y-0.5 text-xs leading-snug",
          muted ? "text-muted-foreground" : "font-mono text-2xs",
        )}
      >
        {lines.map((line, index) => (
          // oxlint-disable-next-line react/no-array-index-key -- a streamed transcript: lines only append, and the same line can repeat
          <div key={index} className="whitespace-pre-wrap">
            {line}
            {streaming && index === lines.length - 1 ? <Caret /> : null}
          </div>
        ))}
      </div>
    </div>
  );
}

function CompareView({ t }: { t: number }) {
  const generic = answerAt(GENERIC_ANSWER, t);
  const packed = answerAt(PACKED_ANSWER, t);
  const checks = answerChecksAt(t);
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      {t >= COMPARE_PROMPT_MS ? (
        <div
          className="self-start rounded-lg bg-muted/60 px-3 py-2 text-sm"
          data-demo-motion="rise"
        >
          {COMPARE_PROMPT}
        </div>
      ) : null}
      <div className="grid grid-cols-2 gap-3">
        <AnswerCard
          title="Without a pack"
          aside="generic"
          lines={generic.lines}
          streaming={generic.streaming && generic.lines.length > 0}
          muted
          testId="packs-demo-generic"
        />
        <AnswerCard
          title="With the pack"
          aside={`${PACK_NAME} v1`}
          lines={packed.lines}
          streaming={packed.streaming && packed.lines.length > 0}
          testId="packs-demo-packed"
        />
      </div>
      <div className="flex flex-wrap gap-2">
        {checks.map((check) => (
          <span
            key={check.entryId}
            className="flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-3xs"
            data-demo-motion="pop"
          >
            <CheckIcon className="size-3" />
            {check.text}
          </span>
        ))}
      </div>
    </div>
  );
}

function VersionsView({ t }: { t: number }) {
  const diff = packDiffAt(t);
  const published = t >= V2_PUBLISHED_MS;
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4">
      <div className="flex items-center gap-2 text-sm">
        <Badge variant="outline">v1</Badge>
        <span className="text-muted-foreground">to</span>
        <Badge variant={published ? "default" : "outline"}>v2</Badge>
        <span className="ml-auto text-xs text-muted-foreground">
          {published ? "Published. Agents update on their next turn." : "Draft"}
        </span>
      </div>
      <div
        className="overflow-hidden rounded-lg border border-border font-mono text-2xs"
        data-testid="packs-demo-diff"
      >
        <div className="border-b border-border bg-muted/40 px-3 py-1.5 text-3xs text-muted-foreground">
          pack.json, context
        </div>
        {diff.map((line) => (
          <div
            key={line.t}
            className={cn(
              "flex items-baseline gap-2 border-b border-border/60 px-3 py-1.5 last:border-b-0",
              line.op === "+" && "bg-foreground/[0.06]",
              line.op === "-" &&
                "text-muted-foreground line-through decoration-muted-foreground/60",
            )}
            data-demo-motion="rise"
          >
            <span className="w-3 shrink-0 font-semibold">{line.op}</span>
            <span className="w-20 shrink-0 text-muted-foreground">{line.field}</span>
            <span className="min-w-0 flex-1">{line.text}</span>
            <span className="shrink-0 font-sans text-3xs text-muted-foreground no-underline">
              {line.why}
            </span>
          </div>
        ))}
      </div>
      <div className="text-xs text-muted-foreground">
        Every change is a version you can read, diff and roll back. Nothing is baked into weights.
      </div>
    </div>
  );
}

function PullsView({ t }: { t: number }) {
  const pulls = agentPullsAt(t);
  const layers = packLayersAt(t);
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-5">
      <div>
        <SectionLabel aside={`budget ${CONTEXT_BUDGET_TOKENS / 1_000}k tokens`}>
          What each agent pulled in
        </SectionLabel>
        <div className="space-y-2" data-testid="packs-demo-pulls">
          {pulls.map((pull) => (
            <div
              key={pull.agent}
              className="rounded-lg border border-border p-2"
              data-demo-motion="rise"
            >
              <div className="flex items-center gap-2 text-xs">
                <AgentMark kind={pull.agent} />
                <span className="font-medium">{PACKS_AGENT_LABEL[pull.agent]}</span>
                <span className="text-muted-foreground">{pull.task}</span>
                <span className="ml-auto tabular-nums text-3xs text-muted-foreground">
                  {pull.entries} of {PACK_ENTRY_TOTAL_V2} entries, {pull.tokens / 1_000}k tokens
                </span>
              </div>
              <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-foreground"
                  style={{ width: `${(pull.tokens / CONTEXT_BUDGET_TOKENS) * 100}%` }}
                />
              </div>
              <div className="mt-1 flex gap-1 font-mono text-3xs text-muted-foreground">
                {pull.fields.map((field) => (
                  <span key={field} className="rounded border border-border px-1">
                    {field}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
      {layers.length > 0 ? (
        <div>
          <SectionLabel aside="on top of the team pack">Personal layers</SectionLabel>
          <div className="space-y-1.5" data-testid="packs-demo-layers">
            {layers.map((layer) => (
              <div
                key={layer.owner}
                className="flex items-center gap-2 rounded-lg border border-border px-2 py-1.5 text-xs"
                data-demo-motion="rise"
              >
                {layer.scope === "team" ? (
                  <UsersIcon className="size-3.5" />
                ) : (
                  <UserIcon className="size-3.5" />
                )}
                <span className="font-medium">{layer.owner}</span>
                <span className="text-muted-foreground">{layer.text}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Closing() {
  return (
    <div className="mx-auto flex h-full max-w-xl flex-col justify-center gap-4">
      <div className="text-3xl font-semibold tracking-tight">Never fine-tune a model.</div>
      <div className="text-3xl font-semibold tracking-tight text-muted-foreground">
        Use a pack instead.
      </div>
      <div className="flex items-center gap-3 text-muted-foreground">
        {PACKS_AGENTS.map((agent) => (
          <AgentMark key={agent} kind={agent} className="size-5" />
        ))}
        <span className="text-sm">One pack. Four agents. Zero training runs.</span>
      </div>
    </div>
  );
}

function AgentStrip({ t }: { t: number }) {
  return (
    <div
      className="flex h-14 shrink-0 items-center gap-2 border-t border-border px-3"
      data-testid="packs-demo-strip"
    >
      {PACKS_AGENTS.map((agent) => {
        const version = agentPackVersionAt(agent, t);
        return (
          <div
            key={agent}
            className={cn(
              "flex h-9 min-w-0 flex-1 items-center gap-2 rounded-lg border px-2 text-xs",
              version > 0 ? "border-foreground/40" : "border-border text-muted-foreground",
            )}
          >
            <AgentMark kind={agent} />
            <span className="truncate">{PACKS_AGENT_LABEL[agent]}</span>
            <span className="ml-auto font-mono text-3xs text-muted-foreground">
              {version > 0 ? `@${version}` : "no pack"}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function AgentTurns({ t }: { t: number }) {
  return (
    <div className="p-3" data-testid="packs-demo-turns">
      <SectionLabel>Agent turns</SectionLabel>
      <div className="space-y-2">
        {PACKS_AGENTS.map((agent) => {
          const lines = packsTurnsFor(agent, t, 3);
          const working =
            lines.some((line) => line.streaming) || lines.some((line) => t - line.t < 1_500);
          const version = agentPackVersionAt(agent, t);
          return (
            <div key={agent} className="rounded-lg border border-border bg-card p-2">
              <div className="flex items-center gap-1.5 text-xs">
                <AgentMark kind={agent} className="size-3.5" />
                <span className="font-medium">{PACKS_AGENT_LABEL[agent]}</span>
                {version > 0 ? (
                  <span className="font-mono text-3xs text-muted-foreground">@{version}</span>
                ) : null}
                <span
                  className={cn(
                    "ml-auto flex items-center gap-1 text-3xs",
                    working ? "text-foreground" : "text-muted-foreground",
                  )}
                >
                  <span
                    className={cn(
                      "size-1.5 rounded-full",
                      working ? "animate-pulse bg-foreground" : "bg-muted-foreground/40",
                    )}
                  />
                  {working ? "Working" : lines.length > 0 ? "Idle" : "Waiting"}
                </span>
              </div>
              {lines.length > 0 ? (
                <div className="mt-1.5 space-y-1">
                  {lines.map((line) => (
                    <div
                      key={`${line.t}-${line.agent}`}
                      className={cn(
                        "text-xs leading-snug",
                        line.kind === "prompt" && "rounded-md bg-muted/60 px-1.5 py-1",
                        line.kind === "tool" && "font-mono text-3xs text-muted-foreground",
                      )}
                      data-demo-motion="rise"
                    >
                      {line.kind === "tool" ? "› " : null}
                      {line.shown}
                      {line.streaming && line.kind === "reply" ? <Caret /> : null}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Caret() {
  return <span className="ml-0.5 inline-block h-3 w-px animate-pulse bg-foreground align-middle" />;
}

function Transport({
  t,
  playing,
  onToggle,
  onRestart,
  onSeek,
}: {
  t: number;
  playing: boolean;
  onToggle: () => void;
  onRestart: () => void;
  onSeek: (t: number) => void;
}) {
  const style: CSSProperties = { width: `${(t / PACKS_DEMO_DURATION_MS) * 100}%` };
  return (
    <div className="flex h-12 shrink-0 items-center gap-3 border-t border-border px-4">
      <Button
        size="icon-sm"
        variant="outline"
        onClick={onToggle}
        aria-label={playing ? "Pause demo" : "Play demo"}
        data-testid="packs-demo-play"
      >
        {playing ? <PauseIcon /> : <PlayIcon />}
      </Button>
      <Button size="icon-sm" variant="ghost" onClick={onRestart} aria-label="Restart demo">
        <RotateCcwIcon />
      </Button>
      <span
        className="w-20 text-xs tabular-nums text-muted-foreground"
        data-testid="packs-demo-time"
      >
        {formatDemoTime(t)} / {formatDemoTime(PACKS_DEMO_DURATION_MS)}
      </span>
      <div className="relative flex h-8 min-w-0 flex-1 items-center">
        <button
          type="button"
          aria-label="Seek"
          className="absolute inset-x-0 top-1/2 h-4 -translate-y-1/2 cursor-pointer"
          onClick={(event) => {
            const box = event.currentTarget.getBoundingClientRect();
            onSeek(((event.clientX - box.left) / box.width) * PACKS_DEMO_DURATION_MS);
          }}
        >
          <span className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-muted" />
          <span
            className="absolute top-1/2 left-0 h-1 -translate-y-1/2 rounded-full bg-foreground"
            style={style}
          />
        </button>
        {PACKS_CHAPTERS.map((chapter) => (
          <button
            key={chapter.t}
            type="button"
            onClick={() => onSeek(chapter.t)}
            className={cn(
              "absolute top-0 -translate-x-px border-l border-border pl-1 text-3xs leading-none whitespace-nowrap transition-colors hover:text-foreground",
              t >= chapter.t ? "text-foreground/80" : "text-muted-foreground",
            )}
            style={{ left: `${(chapter.t / PACKS_DEMO_DURATION_MS) * 100}%` }}
          >
            {chapter.label}
          </button>
        ))}
      </div>
      <span className="hidden text-3xs text-muted-foreground lg:inline">
        Space to play or pause
      </span>
    </div>
  );
}
