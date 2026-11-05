// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServer } from "effect/http";
import * as SqlClient from "effect/sql/SqlClient";

import * as EnvironmentAuthPolicy from "../auth/EnvironmentAuthPolicy.ts";
import * as ServerConfig from "../config.ts";
import {
  DEFAULT_SHARE_RELAY_URL,
  ShareRelayClient,
  readOrCreateIdentity,
  type ShareRelayStatus,
} from "./ShareRelayClient.ts";

/** What the web app needs to draw the Share dialog. */
export interface ShareRelayView extends ShareRelayStatus {
  /** The relay can be switched off for a build or machine (`LOGICPACKS_SHARE_RELAY=off`). */
  readonly available: boolean;
  /** Why the tunnel is open: the host pressed Share, a project link is on, or an invite is pending. */
  readonly reasons: ReadonlyArray<"pinned" | "link" | "invite">;
}

export class ShareRelay extends Context.Service<
  ShareRelay,
  {
    readonly status: () => Effect.Effect<ShareRelayView>;
    /** The host pressed Share: open the tunnel and keep it open for a while even with no link on. */
    readonly enable: () => Effect.Effect<ShareRelayView>;
    /** Stop sharing: close the tunnel and every relayed socket now. */
    readonly disable: () => Effect.Effect<ShareRelayView>;
    readonly reconcile: () => Effect.Effect<ShareRelayView>;
  }
>()("logicpacks/shareRelay/ShareRelay") {}

const PIN_MS = 2 * 60 * 60 * 1000;
const RECONCILE_MS = 2000;

export const relayUrlFromEnv = (env: NodeJS.ProcessEnv = process.env): string | null => {
  if ((env.LOGICPACKS_SHARE_RELAY ?? "").toLowerCase() === "off") return null;
  // A cloud host already has its own public address.
  if ((env.LOGICPACKS_CLOUD_HOST ?? "").toLowerCase() === "true") return null;
  const raw = env.LOGICPACKS_SHARE_RELAY_URL?.trim();
  return raw && raw.length > 0 ? raw : DEFAULT_SHARE_RELAY_URL;
};

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const policy = yield* EnvironmentAuthPolicy.EnvironmentAuthPolicy;
  const sql = yield* SqlClient.SqlClient;
  const server = yield* HttpServer.HttpServer;
  const descriptor = yield* policy.getDescriptor();
  const url = relayUrlFromEnv();
  const identityFile = NodePath.join(config.stateDir, "share-relay.json");
  let pinnedUntil = 0;
  let reasons: ShareRelayView["reasons"] = [];
  /** Set by an explicit stop: shares that existed then do not reopen the tunnel; a new one does. */
  let stopped: { readonly links: number; readonly invites: number } | null = null;
  let last = { links: 0, invites: 0 };

  const client =
    url === null
      ? null
      : new ShareRelayClient({
          relayUrl: url,
          localPort: () => {
            const address = server.address;
            return typeof address === "object" && address !== null && "port" in address ? address.port : config.port;
          },
          identity: () => readOrCreateIdentity(identityFile),
          sessionCookieName: () => descriptor.sessionCookieName,
        });

  // Quitting the app is not stopping the share: the id stays and visitors see "offline".
  yield* Effect.addFinalizer(() => Effect.sync(() => client?.stop({ forget: false })));

  const count = <E>(query: Effect.Effect<ReadonlyArray<{ readonly n: number }>, E>) =>
    query.pipe(
      Effect.map((rows) => Number(rows[0]?.n ?? 0)),
      Effect.orElseSucceed(() => 0),
    );

  const view = (): ShareRelayView => ({
    ...(client?.status() ?? { state: "off", origin: null, error: null, liveStreams: 0 }),
    available: client !== null,
    reasons,
  });

  const reconcile = Effect.fn("ShareRelay.reconcile")(function* () {
    if (client === null) return view();
    const now = yield* Clock.currentTimeMillis;
    const iso = DateTime.formatIso(DateTime.makeUnsafe(now));
    const links = yield* count(
      sql<{ n: number }>`SELECT COUNT(*) AS n FROM logicpacks_project_links WHERE enabled = 1 AND (expires_at IS NULL OR expires_at > ${iso})`,
    );
    const invites = yield* count(
      sql<{ n: number }>`SELECT COUNT(*) AS n FROM logicpacks_project_invites WHERE accepted_at IS NULL AND expires_at > ${iso}`,
    );
    last = { links, invites };
    if (stopped !== null) {
      // Turning a link off and on again is a new share; the same links still on are not.
      stopped =
        links > stopped.links || invites > stopped.invites
          ? null
          : { links: Math.min(stopped.links, links), invites: Math.min(stopped.invites, invites) };
    }
    const next: Array<"pinned" | "link" | "invite"> = [];
    if (stopped === null) {
      if (now < pinnedUntil) next.push("pinned");
      if (links > 0) next.push("link");
      if (invites > 0) next.push("invite");
    }
    reasons = next;
    if (next.length > 0) client.start();
    else if (client.status().state !== "off") client.stop();
    return view();
  });

  yield* reconcile().pipe(
    Effect.catchCause(() => Effect.void),
    Effect.delay(`${RECONCILE_MS} millis`),
    Effect.forever,
    Effect.forkScoped,
  );

  return ShareRelay.of({
    status: Effect.fn("ShareRelay.status")(function* () {
      return view();
    }),
    enable: Effect.fn("ShareRelay.enable")(function* () {
      pinnedUntil = (yield* Clock.currentTimeMillis) + PIN_MS;
      stopped = null;
      return yield* reconcile();
    }),
    disable: Effect.fn("ShareRelay.disable")(function* () {
        // Stopping is explicit: forget the pin, close the tunnel now, and let a link that is still on
        // reopen it only when the host presses Share again.
      pinnedUntil = 0;
      reasons = [];
      stopped = last;
      client?.stop();
      return view();
    }),
    reconcile,
  });
});

export const layer = Layer.effect(ShareRelay, make);
