import type {
  LpAchievement,
  LpAchievementShelf,
  LpAchievementTier,
  LpUnlockedAchievement,
} from "@logicpacks/contracts";
import {
  BookOpenIcon,
  BotIcon,
  CloudUploadIcon,
  CombineIcon,
  CookingPotIcon,
  PackageIcon,
  DoorOpenIcon,
  FlameIcon,
  HandshakeIcon,
  LayersIcon,
  LinkIcon,
  LockIcon,
  type LucideIcon,
  MessagesSquareIcon,
  SparklesIcon,
  TrophyIcon,
  UsersIcon,
} from "lucide-react";

import { cn } from "../../lib/utils";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const ICONS: Record<string, LucideIcon> = {
  first_turn: SparklesIcon,
  first_sync: CloudUploadIcon,
  cloud_native: CloudUploadIcon,
  open_door: DoorOpenIcon,
  joined_team: HandshakeIcon,
  first_invite_accepted: UsersIcon,
  team_builder: UsersIcon,
  helper_linked: LinkIcon,
  bring_your_agent: LinkIcon,
  in_the_open: MessagesSquareIcon,
  open_book: BookOpenIcon,
  peacemaker: CombineIcon,
  merge_master: CombineIcon,
  recipe_author: CookingPotIcon,
  head_chef: CookingPotIcon,
  second_helping: CookingPotIcon,
  regular: CookingPotIcon,
  passed_around: PackageIcon,
  crowd_favourite: PackageIcon,
  warm_up: FlameIcon,
  week_streak: FlameIcon,
  month_streak: FlameIcon,
  agent_hour: BotIcon,
  ten_hours_back: BotIcon,
  hundred_hours_back: BotIcon,
  polyglot: LayersIcon,
  two_engines: LayersIcon,
};

// Tiers read through fill density, not hue, so badges follow the theme.
const TIER_CLASS: Record<LpAchievementTier, string> = {
  bronze: "border-foreground/30 bg-background text-foreground",
  silver: "border-foreground/50 bg-foreground/10 text-foreground",
  gold: "border-foreground bg-foreground/25 text-foreground",
  platinum: "border-foreground bg-foreground text-background",
};

const TIER_LABEL: Record<LpAchievementTier, string> = {
  bronze: "Bronze",
  silver: "Silver",
  gold: "Gold",
  platinum: "Platinum",
};

export function AchievementBadge({
  id,
  tier,
  unlocked = true,
  size = "md",
  className,
}: {
  readonly id: string;
  readonly tier: LpAchievementTier;
  readonly unlocked?: boolean;
  readonly size?: "sm" | "md" | "lg";
  readonly className?: string;
}) {
  const Icon = ICONS[id] ?? TrophyIcon;
  const box = size === "sm" ? "size-5" : size === "lg" ? "size-14" : "size-9";
  const icon = size === "sm" ? "size-2.5" : size === "lg" ? "size-6" : "size-4";
  return (
    <span
      data-testid="achievement-badge"
      data-unlocked={unlocked}
      className={cn("relative inline-grid shrink-0 place-items-center", box, className)}
    >
      <span
        aria-hidden
        className={cn(
          "absolute inset-[14%] rotate-45 rounded-md border",
          TIER_CLASS[tier],
          !unlocked && "border-dashed border-foreground/25 bg-transparent text-muted-foreground",
        )}
      />
      <Icon aria-hidden className={cn("relative", icon, !unlocked && "opacity-50")} />
      {!unlocked ? (
        <LockIcon
          aria-hidden
          className="absolute -right-0.5 -bottom-0.5 size-3 text-muted-foreground"
        />
      ) : null}
    </span>
  );
}

/** A row of earned badges for a leaderboard row or a main-thread card. */
export function AchievementStrip({
  achievements,
  max = 4,
}: {
  readonly achievements: ReadonlyArray<LpUnlockedAchievement>;
  readonly max?: number;
}) {
  if (achievements.length === 0) return null;
  const shown = achievements.slice(0, max);
  const rest = achievements.length - shown.length;
  return (
    <span className="flex items-center -space-x-1">
      {shown.map((achievement) => (
        <Tooltip key={achievement.id}>
          <TooltipTrigger
            render={
              <span>
                <AchievementBadge id={achievement.id} tier={achievement.tier} size="sm" />
              </span>
            }
          />
          <TooltipPopup>
            {achievement.name} · {TIER_LABEL[achievement.tier]} · {achievement.points} pts
          </TooltipPopup>
        </Tooltip>
      ))}
      {rest > 0 ? <span className="ps-2 text-xs text-muted-foreground">+{rest}</span> : null}
    </span>
  );
}

export function AchievementShelves({
  shelves,
  achievements,
}: {
  readonly shelves: ReadonlyArray<LpAchievementShelf>;
  readonly achievements: ReadonlyArray<LpAchievement>;
}) {
  return (
    <div className="space-y-6">
      {shelves.map((shelf) => {
        const items = achievements.filter((achievement) => achievement.shelf === shelf.id);
        if (items.length === 0) return null;
        const earned = items.filter((achievement) => achievement.unlocked).length;
        return (
          <section key={shelf.id} aria-label={shelf.name}>
            <div className="mb-3 flex items-baseline justify-between">
              <h4 className="text-xs font-medium text-muted-foreground">{shelf.name}</h4>
              <span className="text-xs tabular-nums text-muted-foreground">
                {earned}/{items.length}
              </span>
            </div>
            <div className="grid grid-cols-3 gap-x-2 gap-y-4 sm:grid-cols-5 lg:grid-cols-7">
              {items.map((achievement) => (
                <Popover key={achievement.id}>
                  <PopoverTrigger
                    data-testid="achievement"
                    data-unlocked={achievement.unlocked}
                    render={
                      <button
                        type="button"
                        className="group flex flex-col items-center gap-1.5 rounded-md p-1.5 text-center hover:bg-accent"
                      />
                    }
                  >
                    <AchievementBadge
                      id={achievement.id}
                      tier={achievement.tier}
                      unlocked={achievement.unlocked}
                      size="lg"
                      className="transition-transform group-hover:-translate-y-0.5"
                    />
                    <span
                      className={cn(
                        "text-xs font-medium leading-tight",
                        !achievement.unlocked && "text-muted-foreground",
                      )}
                    >
                      {achievement.name}
                    </span>
                    <span className="text-3xs tabular-nums text-muted-foreground">
                      {achievement.points} pts
                    </span>
                  </PopoverTrigger>
                  <PopoverPopup className="w-64">
                    <div className="space-y-2">
                      <p className="font-medium">{achievement.name}</p>
                      <p className="text-sm text-muted-foreground">{achievement.description}</p>
                      <div className="h-1 overflow-hidden rounded-full bg-foreground/10">
                        <div
                          className="h-full rounded-full bg-foreground"
                          style={{ width: `${Math.round(achievement.progress * 100)}%` }}
                        />
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {achievement.unlocked
                          ? `Unlocked${achievement.unlockedAt ? ` ${achievement.unlockedAt.slice(0, 10)}` : ""}`
                          : `${formatProgress(achievement)} so far`}{" "}
                        · {TIER_LABEL[achievement.tier]} · {achievement.points} pts
                      </p>
                    </div>
                  </PopoverPopup>
                </Popover>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function formatProgress(achievement: LpAchievement): string {
  const current =
    achievement.current >= 1000
      ? Math.round(achievement.current).toLocaleString()
      : Math.round(achievement.current * 10) / 10;
  const threshold = achievement.threshold.toLocaleString();
  return `${current} of ${threshold}`;
}
