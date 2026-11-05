import { useEffect, useState } from "react";

import { resolvePrimaryEnvironmentHttpUrl } from "../environments/primary/target";
import { lpAbsoluteUrl, lpRequest } from "./api";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/**
 * Where links for other devices (invites, share links) should point. The desktop app's own server
 * answers on 127.0.0.1, which no teammate can open: when Network access is on, use the address the
 * app advertises on the network instead. Null keeps the primary environment's URL.
 */
export function useLpShareBase(): string | null {
  const [base, setBase] = useState<string | null>(null);
  useEffect(() => {
    const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;
    if (!bridge?.getServerExposureState) return;
    let primaryHost: string;
    try {
      primaryHost = new URL(resolvePrimaryEnvironmentHttpUrl("/")).hostname;
    } catch {
      return;
    }
    if (!LOOPBACK_HOSTS.has(primaryHost)) return;
    let live = true;
    bridge
      .getServerExposureState()
      .then((state) => {
        if (live && state.mode === "network-accessible" && state.endpointUrl) {
          setBase(state.endpointUrl);
        }
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return base;
}

/** An absolute URL for a link someone opens on another device. */
export function lpShareUrl(pathWithQuery: string, base: string | null): string {
  return base === null ? lpAbsoluteUrl(pathWithQuery) : new URL(pathWithQuery, base).toString();
}

/** The host app's public-link tunnel (GET /api/lp/relay). Null when this is not the host owner's app. */
export interface LpRelayView {
  readonly state: "off" | "connecting" | "connected" | "retrying";
  readonly origin: string | null;
  readonly error: string | null;
  readonly available: boolean;
}

/**
 * Opening a share surface is the host pressing Share: it asks the app to open the public-link tunnel
 * and then follows its state until it is connected. Members and the cloud host get null.
 */
export function useLpRelay(): LpRelayView | null {
  const [relay, setRelay] = useState<LpRelayView | null>(null);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = (view: LpRelayView) => {
      if (!live) return;
      setRelay(view);
      timer = setTimeout(
        () => {
          lpRequest<LpRelayView>("/api/lp/relay").then(poll, () => undefined);
        },
        view.state === "connected" ? 15_000 : 1_500,
      );
    };
    lpRequest<LpRelayView>("/api/lp/relay/enable", {}).then(
      (view) => poll(view.available ? view : { ...view, state: "off" }),
      () => undefined,
    );
    return () => {
      live = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, []);
  return relay?.available ? relay : null;
}

/** The link to send: the public address when the tunnel is up, null while it is not. */
export function lpPublicShareUrl(pathWithQuery: string, relay: LpRelayView | null): string | null {
  return relay?.state === "connected" && relay.origin !== null
    ? new URL(pathWithQuery, relay.origin).toString()
    : null;
}
