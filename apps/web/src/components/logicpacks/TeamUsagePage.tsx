import type {
  EnvironmentId,
  LpAgentUsage,
  LpLeaderboard,
  LpLeaderboardEntry,
  LpLeaderboardRange,
  LpModelUsage,
  LpUsageDay,
} from "@logicpacks/contracts";
import { formatCount, formatTokens } from "@logicpacks/shared/usageFormat";
import { useNavigate } from "@tanstack/react-router";
import { ChevronDownIcon, EyeOffIcon } from "lucide-react";
import { Fragment, useEffect, useState } from "react";

import { cn } from "../../lib/utils";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { logicPacksUsageEnvironment } from "../../state/logicpacksUsage";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { AppRouteModal, AppRouteModalClose } from "../AppRouteModal";
import { Button } from "../ui/button";
import { RefreshIcon } from "../ui/refresh-icon";
import { ScrollArea } from "../ui/scroll-area";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Skeleton } from "../ui/skeleton";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { AchievementBadge, AchievementShelves, AchievementStrip } from "./Achievements";
import {
  buildHeatmap,
  formatCost,
  type HeatmapCell,
  formatHours,
  newlyUnlocked,
  providerLabel,
  RANGE_OPTIONS,
  SEEN_ACHIEVEMENTS_KEY,
  USAGE_VIEWS,
  type UsageView,
  weekOverWeek,
} from "./teamUsage.logic";

const ALL_PROJECTS = "__all__";

/** Switches Usage between the team leaderboard and this machine's own transcripts. */
export function UsageViewSwitch({ value }: { readonly value: UsageView }) {
  const navigate = useNavigate();
  return (
    <ToggleGroup
      aria-label="Usage view"
      variant="segmented"
      value={[value]}
      onValueChange={(next) => {
        const view = next[0];
        if (view === "team" || view === "machine") {
          void navigate({
            to: "/usage",
            search: view === "machine" ? { view: "machine" } : {},
            replace: true,
          });
        }
      }}
    >
      {USAGE_VIEWS.map((option) => (
        <Toggle key={option.value} value={option.value}>
          {option.label}
        </Toggle>
      ))}
    </ToggleGroup>
  );
}

export function TeamUsagePage() {
  const environmentId = usePrimaryEnvironmentId();
  const [range, setRange] = useState<LpLeaderboardRange>("30d");
  const [projectId, setProjectId] = useState<string | null>(null);
  const [tab, setTab] = useState<"people" | "agents">("people");

  const overall = useEnvironmentQuery(
    environmentId === null
      ? null
      : logicPacksUsageEnvironment.leaderboard({ environmentId, input: { range } }),
  );
  const scoped = useEnvironmentQuery(
    environmentId === null || projectId === null
      ? null
      : logicPacksUsageEnvironment.leaderboard({ environmentId, input: { range, projectId } }),
  );
  const board = projectId === null ? overall.data : scoped.data;
  const query = projectId === null ? overall : scoped;
  const refresh = () => {
    overall.refresh();
    if (projectId !== null) scoped.refresh();
  };

  return (
    <AppRouteModal label="Usage">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex min-h-12 shrink-0 items-center gap-2 border-b ps-5 pe-2">
          <WorkspaceBreadcrumb ariaLabel="Usage breadcrumb" className="min-w-0">
            <WorkspaceBreadcrumbItem>
              <h1>Usage</h1>
            </WorkspaceBreadcrumbItem>
            <WorkspaceBreadcrumbSeparator />
            <WorkspaceBreadcrumbItem current>
              <UsageViewSwitch value="team" />
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
          <div className="ms-auto flex shrink-0 items-center gap-1">
            <Select
              value={projectId ?? ALL_PROJECTS}
              onValueChange={(value) =>
                setProjectId(value === ALL_PROJECTS || value === null ? null : value)
              }
            >
              <SelectTrigger
                aria-label="Project"
                size="compact"
                variant="ghost"
                className="w-auto min-w-0 max-w-48"
              >
                <SelectValue>
                  {projectId === null
                    ? "All projects"
                    : (overall.data?.byProject.find((project) => project.projectId === projectId)
                        ?.title ?? "Project")}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem value={ALL_PROJECTS}>All projects</SelectItem>
                {(overall.data?.byProject ?? []).map((project) => (
                  <SelectItem key={project.projectId} value={project.projectId}>
                    {project.title}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <ToggleGroup
              aria-label="Leaderboard period"
              variant="segmented"
              value={[range]}
              onValueChange={(next) => {
                const value = RANGE_OPTIONS.find((option) => option.value === next[0]);
                if (value) setRange(value.value);
              }}
            >
              {RANGE_OPTIONS.map((option) => (
                <Toggle key={option.value} value={option.value}>
                  {option.label}
                </Toggle>
              ))}
            </ToggleGroup>
            <Button
              onClick={refresh}
              aria-label="Refresh leaderboard"
              aria-busy={query.isPending}
              disabled={query.isPending}
              size="icon-sm"
              variant="ghost"
            >
              <RefreshIcon size="sm" refreshing={query.isPending} />
            </Button>
            <AppRouteModalClose />
          </div>
        </header>
        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer width="wide">
            {environmentId === null ? (
              <p className="py-12 text-center text-sm text-muted-foreground">
                Connect to a LogicPacks host to see your team.
              </p>
            ) : board === null ? (
              query.error !== null ? (
                <p className="py-12 text-center text-sm text-muted-foreground">{query.error}</p>
              ) : (
                <TeamUsageSkeleton />
              )
            ) : (
              <TeamUsageContent
                board={board}
                environmentId={environmentId}
                tab={tab}
                onTab={setTab}
                onSharingChanged={refresh}
              />
            )}
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
    </AppRouteModal>
  );
}

function TeamUsageSkeleton() {
  return (
    <div className="space-y-6 py-6" aria-busy>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {Array.from({ length: 5 }, (_, index) => (
          <Skeleton key={index} className="h-16" />
        ))}
      </div>
      <Skeleton className="h-64" />
      <Skeleton className="h-32" />
    </div>
  );
}

function TeamUsageContent({
  board,
  environmentId,
  tab,
  onTab,
  onSharingChanged,
}: {
  readonly board: LpLeaderboard;
  readonly environmentId: EnvironmentId;
  readonly tab: "people" | "agents";
  readonly onTab: (tab: "people" | "agents") => void;
  readonly onSharingChanged: () => void;
}) {
  const change = weekOverWeek(board.totals.thisWeekTokens, board.totals.lastWeekTokens);
  return (
    <div className="space-y-8 py-6" data-testid="team-usage">
      <section aria-label="Totals" className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label="Tokens" value={formatTokens(board.totals.tokens)} />
        <Stat label="Turns" value={formatCount(board.totals.turns)} />
        <Stat
          label="Cost"
          value={formatCost(board.totals.costUsd)}
          hint={
            board.pricing === "priced"
              ? undefined
              : board.pricing === "partial"
                ? "Some models have no known price"
                : "No model prices yet. Open This machine once to load them."
          }
        />
        <Stat
          label="This week"
          value={formatTokens(board.totals.thisWeekTokens)}
          hint={`${change.label} vs last week (${formatTokens(board.totals.lastWeekTokens)})`}
          trend={change.direction}
        />
        <Stat label="Agent hours" value={formatHours(board.totals.agentHours)} />
      </section>

      <section aria-label="Leaderboard" className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-medium">Leaderboard</h2>
          <ToggleGroup
            aria-label="Leaderboard rows"
            variant="segmented"
            value={[tab]}
            onValueChange={(next) => {
              if (next[0] === "people" || next[0] === "agents") onTab(next[0]);
            }}
          >
            <Toggle value="people">People</Toggle>
            <Toggle value="agents">Agents</Toggle>
          </ToggleGroup>
        </div>
        {tab === "people" ? (
          <PeopleTable entries={board.entries} today={board.generatedAt} />
        ) : (
          <AgentsTable agents={board.agents} />
        )}
        {board.hiddenParticipants > 0 ? (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <EyeOffIcon className="size-3.5" aria-hidden />
            {board.hiddenParticipants === 1
              ? "One teammate keeps their usage private and is not counted here."
              : `${board.hiddenParticipants} teammates keep their usage private and are not counted here.`}
          </p>
        ) : null}
      </section>

      <section aria-label="Activity" className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-medium">Activity</h2>
          <span className="text-xs text-muted-foreground">Last 12 months, tokens per day</span>
        </div>
        <Heatmap days={board.days} today={board.generatedAt} />
      </section>

      <div className="grid gap-8 lg:grid-cols-2">
        <section aria-label="By model" className="space-y-3">
          <h2 className="text-sm font-medium">By provider and model</h2>
          <ModelList models={board.byModel} />
        </section>
        <section aria-label="By project" className="space-y-3">
          <h2 className="text-sm font-medium">By project</h2>
          {board.byProject.length === 0 ? (
            <p className="text-sm text-muted-foreground">No project activity in this period.</p>
          ) : (
            <ul className="divide-y rounded-lg border">
              {board.byProject.map((project) => (
                <li key={project.projectId} className="flex items-center gap-3 px-3 py-2 text-sm">
                  <span className="min-w-0 flex-1 truncate">{project.title}</span>
                  <span className="hidden text-xs text-muted-foreground sm:inline">
                    {project.participants === 1 ? "1 person" : `${project.participants} people`}
                    {project.topParticipantName ? `, led by ${project.topParticipantName}` : ""}
                  </span>
                  <span className="w-16 text-end tabular-nums">{formatTokens(project.tokens)}</span>
                  <span className="w-16 text-end tabular-nums text-muted-foreground">
                    {formatCost(project.costUsd)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <div className="grid gap-8 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <MyAchievements environmentId={environmentId} />
        <section aria-label="Recent unlocks" className="space-y-3">
          <h2 className="text-sm font-medium">Recent unlocks</h2>
          {board.recentUnlocks.length === 0 ? (
            <p className="text-sm text-muted-foreground">No achievements yet.</p>
          ) : (
            <ul className="space-y-2">
              {board.recentUnlocks.map((unlock) => (
                <li
                  key={`${unlock.participantId}:${unlock.achievement.id}`}
                  className="flex items-center gap-2 text-sm"
                >
                  <AchievementBadge
                    id={unlock.achievement.id}
                    tier={unlock.achievement.tier}
                    size="sm"
                  />
                  <span className="min-w-0 flex-1 truncate">
                    <span className="font-medium">{unlock.displayName}</span> unlocked{" "}
                    {unlock.achievement.name}
                  </span>
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {unlock.achievement.unlockedAt.slice(5, 10)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <UsageSharingCard board={board} environmentId={environmentId} onChanged={onSharingChanged} />
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
  trend,
}: {
  readonly label: string;
  readonly value: string;
  readonly hint?: string | undefined;
  readonly trend?: "up" | "down" | "flat";
}) {
  return (
    <div className="rounded-lg border px-3 py-2.5">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-lg font-medium tabular-nums">{value}</div>
      {hint ? (
        <div
          className={cn(
            "mt-0.5 text-xs text-muted-foreground",
            trend === "up" && "text-foreground",
          )}
        >
          {hint}
        </div>
      ) : null}
    </div>
  );
}

function PeopleTable({
  entries,
  today,
}: {
  readonly entries: ReadonlyArray<LpLeaderboardEntry>;
  readonly today: string;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const top = Math.max(1, ...entries.map((entry) => entry.tokens));
  if (entries.length === 0) {
    return <p className="text-sm text-muted-foreground">Nobody has run a turn yet.</p>;
  }
  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full min-w-[640px] text-sm">
        <thead className="text-xs text-muted-foreground">
          <tr className="border-b">
            <th className="w-10 px-3 py-2 text-start font-normal">#</th>
            <th className="px-3 py-2 text-start font-normal">Person</th>
            <th className="px-3 py-2 text-start font-normal">Tokens</th>
            <th className="px-3 py-2 text-end font-normal">Turns</th>
            <th className="px-3 py-2 text-end font-normal">Cost</th>
            <th className="px-3 py-2 text-end font-normal">Streak</th>
            <th className="px-3 py-2 text-end font-normal">Week</th>
            <th className="px-3 py-2 text-end font-normal">Points</th>
            <th className="w-8" />
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => {
            const change = weekOverWeek(entry.thisWeekTokens, entry.lastWeekTokens);
            const expanded = open === entry.participantId;
            return (
              <Fragment key={entry.participantId}>
                <tr
                  data-testid="leaderboard-row"
                  className={cn("border-b last:border-b-0", entry.isYou && "bg-accent/40")}
                >
                  <td className="px-3 py-2 tabular-nums text-muted-foreground">{entry.rank}</td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{entry.displayName}</span>
                      {entry.isYou ? (
                        <span className="rounded-sm border px-1 text-3xs text-muted-foreground">
                          you
                        </span>
                      ) : null}
                      {entry.private ? (
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <span className="text-muted-foreground">
                                <EyeOffIcon className="size-3.5" aria-label="Private" />
                              </span>
                            }
                          />
                          <TooltipPopup>Hidden from other members</TooltipPopup>
                        </Tooltip>
                      ) : null}
                      <AchievementStrip achievements={entry.achievements} max={3} />
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <span className="w-14 tabular-nums">{formatTokens(entry.tokens)}</span>
                      <span className="hidden h-1.5 flex-1 overflow-hidden rounded-full bg-foreground/10 md:block">
                        <span
                          className="block h-full rounded-full bg-foreground/70"
                          style={{ width: `${Math.round((entry.tokens / top) * 100)}%` }}
                        />
                      </span>
                    </div>
                  </td>
                  <td className="px-3 py-2 text-end tabular-nums">{formatCount(entry.turns)}</td>
                  <td className="px-3 py-2 text-end tabular-nums text-muted-foreground">
                    {formatCost(entry.costUsd)}
                  </td>
                  <td className="px-3 py-2 text-end tabular-nums">
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <span>
                            {entry.currentStreakDays > 0 ? `${entry.currentStreakDays}d` : "-"}
                          </span>
                        }
                      />
                      <TooltipPopup>Longest streak {entry.longestStreakDays} days</TooltipPopup>
                    </Tooltip>
                  </td>
                  <td
                    className={cn(
                      "px-3 py-2 text-end tabular-nums",
                      change.direction === "down" && "text-muted-foreground",
                    )}
                  >
                    {change.label}
                  </td>
                  <td className="px-3 py-2 text-end tabular-nums">{entry.points}</td>
                  <td className="pe-2">
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label={expanded ? "Hide details" : "Show details"}
                      aria-expanded={expanded}
                      onClick={() => setOpen(expanded ? null : entry.participantId)}
                    >
                      <ChevronDownIcon className={cn(expanded && "rotate-180")} />
                    </Button>
                  </td>
                </tr>
                {expanded ? (
                  <tr className="border-b last:border-b-0">
                    <td colSpan={9} className="space-y-4 bg-muted/30 px-3 py-3">
                      <Heatmap days={entry.days} today={today} compact />
                      <div className="grid gap-4 md:grid-cols-2">
                        <ModelList models={entry.byModel} />
                        <ul className="space-y-1 text-xs">
                          {entry.agents.map((agent) => (
                            <li key={agent.key} className="flex justify-between gap-2">
                              <span className="truncate">
                                {providerLabel(agent.driver)} · {agent.model}
                              </span>
                              <span className="shrink-0 tabular-nums text-muted-foreground">
                                {formatHours(agent.agentHours)} working
                              </span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function AgentsTable({ agents }: { readonly agents: ReadonlyArray<LpAgentUsage> }) {
  if (agents.length === 0) {
    return <p className="text-sm text-muted-foreground">No agent turns in this period.</p>;
  }
  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full min-w-[560px] text-sm">
        <thead className="text-xs text-muted-foreground">
          <tr className="border-b">
            <th className="w-10 px-3 py-2 text-start font-normal">#</th>
            <th className="px-3 py-2 text-start font-normal">Agent</th>
            <th className="px-3 py-2 text-end font-normal">Tokens</th>
            <th className="px-3 py-2 text-end font-normal">Turns</th>
            <th className="px-3 py-2 text-end font-normal">On its own</th>
            <th className="px-3 py-2 text-end font-normal">Working time</th>
            <th className="px-3 py-2 text-end font-normal">Cost</th>
          </tr>
        </thead>
        <tbody>
          {agents.map((agent, index) => (
            <tr key={agent.key} data-testid="agent-row" className="border-b last:border-b-0">
              <td className="px-3 py-2 tabular-nums text-muted-foreground">{index + 1}</td>
              <td className="px-3 py-2">
                <span className="font-medium">
                  {agent.ownerName}&rsquo;s {providerLabel(agent.driver)}
                </span>{" "}
                <span className="text-muted-foreground">{agent.model}</span>
              </td>
              <td className="px-3 py-2 text-end tabular-nums">{formatTokens(agent.tokens)}</td>
              <td className="px-3 py-2 text-end tabular-nums">{formatCount(agent.turns)}</td>
              <td className="px-3 py-2 text-end tabular-nums text-muted-foreground">
                {formatCount(agent.autonomousTurns)}
              </td>
              <td className="px-3 py-2 text-end tabular-nums">{formatHours(agent.agentHours)}</td>
              <td className="px-3 py-2 text-end tabular-nums text-muted-foreground">
                {formatCost(agent.costUsd)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ModelList({ models }: { readonly models: ReadonlyArray<LpModelUsage> }) {
  if (models.length === 0) {
    return <p className="text-sm text-muted-foreground">No turns in this period.</p>;
  }
  const total = Math.max(
    1,
    models.reduce((sum, model) => sum + model.tokens, 0),
  );
  return (
    <ul className="space-y-2">
      {models.map((model) => (
        <li key={`${model.driver}:${model.model}`} className="space-y-1">
          <div className="flex items-baseline justify-between gap-2 text-sm">
            <span className="min-w-0 truncate">
              <span className="text-muted-foreground">{providerLabel(model.driver)}</span>{" "}
              {model.model}
            </span>
            <span className="shrink-0 tabular-nums">
              {formatTokens(model.tokens)}
              <span className="ms-2 text-muted-foreground">{formatCost(model.costUsd)}</span>
            </span>
          </div>
          <div className="h-1 overflow-hidden rounded-full bg-foreground/10">
            <div
              className="h-full rounded-full bg-foreground/60"
              style={{ width: `${Math.max(1, Math.round((model.tokens / total) * 100))}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

const LEVEL_CLASS = [
  "bg-foreground/[0.06]",
  "bg-foreground/20",
  "bg-foreground/40",
  "bg-foreground/65",
  "bg-foreground",
] as const;

function Heatmap({
  days,
  today,
  compact = false,
}: {
  readonly days: ReadonlyArray<LpUsageDay>;
  /** The server's clock, so the grid ends on the host's today. */
  readonly today: string;
  readonly compact?: boolean;
}) {
  const [hovered, setHovered] = useState<HeatmapCell | null>(null);
  const columns = buildHeatmap(days, today, compact ? 26 : 53);
  const cell = compact ? "size-2" : "size-2.5";
  return (
    <div className="space-y-1.5">
      <div className="overflow-x-auto" role="img" aria-label="Daily activity">
        <div className="flex gap-0.75" onMouseLeave={() => setHovered(null)}>
          {columns.map((column) => (
            <div key={column[0]!.day} className="flex flex-col gap-0.75">
              {column.map((day) =>
                day.future ? (
                  <span key={day.day} className={cell} />
                ) : (
                  <span
                    key={day.day}
                    data-level={day.level}
                    onMouseEnter={() => setHovered(day)}
                    className={cn("rounded-xs", cell, LEVEL_CLASS[day.level])}
                  />
                ),
              )}
            </div>
          ))}
        </div>
      </div>
      <p className="h-4 text-xs tabular-nums text-muted-foreground">
        {hovered
          ? `${hovered.day}: ${formatTokens(hovered.tokens)} tokens, ${formatCount(hovered.turns)} turns`
          : null}
      </p>
    </div>
  );
}

function MyAchievements({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const query = useEnvironmentQuery(
    logicPacksUsageEnvironment.achievements({ environmentId, input: {} }),
  );
  const data = query.data;
  const unlockedIds = data?.achievements.filter((item) => item.unlocked).map((item) => item.id);
  const unlockedKey = unlockedIds?.join(",") ?? null;

  // Celebrate unlocks that happened since this device last showed the shelf.
  // oxlint-disable-next-line logicpacks/no-unreasoned-state-sync -- raises imperative toasts and keeps the device's seen list in localStorage in step with the host's unlocks.
  useEffect(() => {
    if (data === null || unlockedKey === null) return;
    const ids = unlockedKey.length === 0 ? [] : unlockedKey.split(",");
    let stored: string | null = null;
    try {
      stored = globalThis.localStorage?.getItem(SEEN_ACHIEVEMENTS_KEY) ?? null;
    } catch {
      stored = null;
    }
    const { fresh, seen } = newlyUnlocked(ids, stored);
    for (const id of fresh) {
      const achievement = data.achievements.find((item) => item.id === id);
      if (achievement) {
        toastManager.add({
          type: "success",
          title: `Achievement unlocked: ${achievement.name}`,
          description: `${achievement.description} ${achievement.points} points.`,
        });
      }
    }
    try {
      globalThis.localStorage?.setItem(SEEN_ACHIEVEMENTS_KEY, seen);
    } catch {
      // Storage can be blocked; the toast just repeats next time.
    }
  }, [data, unlockedKey]);

  return (
    <section aria-label="Your achievements" className="space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-medium">Your achievements</h2>
        {data ? (
          <span className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="tabular-nums">
              Level {data.level} · {data.points} pts
            </span>
            <span className="h-1 w-20 overflow-hidden rounded-full bg-foreground/10">
              <span
                className="block h-full rounded-full bg-foreground"
                style={{ width: `${Math.round(data.levelProgress * 100)}%` }}
              />
            </span>
          </span>
        ) : null}
      </div>
      {data ? (
        <AchievementShelves shelves={data.shelves} achievements={data.achievements} />
      ) : query.error ? (
        <p className="text-sm text-muted-foreground">{query.error}</p>
      ) : (
        <Skeleton className="h-40" />
      )}
    </section>
  );
}

function UsageSharingCard({
  board,
  environmentId,
  onChanged,
}: {
  readonly board: LpLeaderboard;
  readonly environmentId: EnvironmentId;
  readonly onChanged: () => void;
}) {
  const setSharing = useAtomCommand(logicPacksUsageEnvironment.setUsageSharing, {
    label: "Save usage sharing",
  });
  const [saving, setSaving] = useState(false);
  const sharing = board.viewer.sharing;
  return (
    <section
      aria-label="Usage sharing"
      className="flex items-start justify-between gap-4 rounded-lg border px-4 py-3"
    >
      <div className="space-y-1">
        <h2 className="text-sm font-medium">Share my usage with the team</h2>
        <p className="text-xs text-muted-foreground">
          {sharing.shareUsage
            ? sharing.isDecided
              ? "Teammates see your numbers and badges. You chose this."
              : "Teammates see your numbers and badges. This is the default; you have not changed it."
            : board.viewer.isOperator
              ? "Hidden from members. You run this host, so you still see everyone."
              : "Hidden from other members. You still see your own numbers, and the host owner still sees them for billing."}
        </p>
      </div>
      <Switch
        aria-label="Share my usage with the team"
        checked={sharing.shareUsage}
        disabled={saving}
        onCheckedChange={(checked) => {
          setSaving(true);
          void setSharing({ environmentId, input: { shareUsage: checked } }).then(() => {
            setSaving(false);
            onChanged();
          });
        }}
      />
    </section>
  );
}
