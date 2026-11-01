import { LPCHAT_PLAN_TUNNEL_LIMITS } from "@logicpacks/contracts/relay";
import { TriangleAlertIcon } from "lucide-react";
import type { ReactNode } from "react";

import type { ManagedTunnelUpgrade } from "../../cloud/managedRelayState";
import { cn } from "../../lib/utils";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";

// Above this, one slot per tunnel is too thin to read, so the bar fills instead.
const MAX_SEGMENTS = 10;

export const LPCHAT_SUBSCRIPTION_URL = "https://chat.logicpacks.io/settings/subscription";

export function tunnelUpgradeCopy(upgrade: Exclude<ManagedTunnelUpgrade, null>): string {
  const { pro, premier } = LPCHAT_PLAN_TUNNEL_LIMITS;
  switch (upgrade) {
    case "link":
      return `Link LogicPacks Chat Pro for up to ${pro} tunnels, or Premier for up to ${premier}.`;
    case "pro":
      return `Upgrade to LogicPacks Chat Pro for up to ${pro} tunnels, or Premier for up to ${premier}.`;
    case "premier":
      return `Upgrade to LogicPacks Chat Premier for up to ${premier} tunnels.`;
  }
}

/** "2 of 3 tunnels in use" with one bar slot per tunnel. */
export function TunnelUsageMeter({
  used,
  limit,
  action,
  className,
}: {
  readonly used: number;
  readonly limit: number;
  readonly action?: ReactNode;
  readonly className?: string;
}) {
  const full = used >= limit;
  const fill = full ? "bg-warning" : "bg-foreground/72";
  return (
    <div className={cn("flex max-w-sm flex-col gap-1.5", className)}>
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className={cn("tabular-nums", full ? "text-warning-foreground" : "text-foreground")}>
          {used} of {limit} tunnels in use
        </span>
        {action}
      </div>
      <div
        role="meter"
        aria-label="LogicPacks Connect tunnels in use"
        aria-valuemin={0}
        aria-valuemax={limit}
        aria-valuenow={used}
        className="flex h-1.5 gap-1"
      >
        {limit <= MAX_SEGMENTS ? (
          Array.from({ length: limit }, (_, index) => (
            <span
              key={index}
              className={cn("flex-1 rounded-full", index < used ? fill : "bg-muted")}
            />
          ))
        ) : (
          <span className="flex-1 overflow-hidden rounded-full bg-muted">
            <span
              className={cn("block h-full rounded-full", fill)}
              style={{ width: `${Math.min(100, (used / limit) * 100)}%` }}
            />
          </span>
        )}
      </div>
    </div>
  );
}

/** Shown when the relay refuses a new tunnel because the account is at its cap. */
export function TunnelLimitAlert({
  upgrade,
  onLinkLpChat,
  onManageTunnels,
}: {
  readonly upgrade: ManagedTunnelUpgrade;
  readonly onLinkLpChat: (() => void) | null;
  readonly onManageTunnels: (() => void) | null;
}) {
  const action =
    upgrade === "link" && onLinkLpChat ? (
      <Button size="sm" onClick={onLinkLpChat}>
        Link LogicPacks Chat
      </Button>
    ) : upgrade === "pro" || upgrade === "premier" ? (
      <Button
        size="sm"
        render={<a href={LPCHAT_SUBSCRIPTION_URL} target="_blank" rel="noopener noreferrer" />}
      >
        Upgrade on LogicPacks Chat
      </Button>
    ) : onManageTunnels ? (
      <Button size="sm" variant="outline" onClick={onManageTunnels}>
        Manage tunnels
      </Button>
    ) : null;
  return (
    <Alert variant="warning">
      <TriangleAlertIcon />
      <AlertTitle>You&apos;re out of tunnels (they cost us money).</AlertTitle>
      <AlertDescription>
        {upgrade === "link"
          ? "Switch to Tailscale or get more tunnels by linking your LogicPacks Chat sub (sorry!)"
          : upgrade
            ? "Switch to Tailscale or get more tunnels by upgrading your LogicPacks Chat sub (sorry!)"
            : "Switch to Tailscale or deregister an environment you no longer use (sorry!)"}
      </AlertDescription>
      {action ? <AlertAction>{action}</AlertAction> : null}
    </Alert>
  );
}
