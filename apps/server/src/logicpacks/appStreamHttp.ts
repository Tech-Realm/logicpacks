// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off globalTimers:off - one-time tickets, the action log file and a grant timer around the plain hub.
/**
 * Routes for live app sharing. `POST /api/lp/appstream/ticket` turns the
 * caller's session (cookie in a browser, bearer in the desktop app) into a
 * one-minute ticket, because browsers cannot put an Authorization header on a
 * WebSocket. `GET /api/lp/appstream/ws?ticket=` is the room's socket.
 */
import { refuseIfReadOnly } from "./readOnly.ts";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type {
  AppStreamClientMessage,
  AppStreamIceServer,
  AppStreamLogEntry,
  ProjectId,
} from "@logicpacks/contracts";
import * as NodeHttpServerRequest from "@effect/platform-node/NodeHttpServerRequest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as Socket from "effect/socket/Socket";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { sharedAppTurnContext } from "@logicpacks/shared/recipes/appGuides";

import { AppStreamHub, type AppStreamConnection } from "./appStream.ts";
import { registerSharedAppContext } from "./sharedAppContext.ts";
import { json, queryParam, readBody, resolveCaller, type Caller } from "./http.ts";
import { FEATURE_LOCKED, requireFeature } from "./features.ts";
import { LogicPacksAccess } from "./LogicPacksAccess.ts";

const TICKET_TTL_MS = 60_000;
const MAX_FRAME_BYTES = 4 * 1024 * 1024;

function iceServersFromEnv(): ReadonlyArray<AppStreamIceServer> {
  // oxlint-disable-next-line logicpacks/no-global-process-runtime -- read once for the process-wide hub.
  const raw = process.env["LOGICPACKS_ICE_SERVERS"]?.trim();
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) return parsed as AppStreamIceServer[];
    } catch {
      // Fall through to the default.
    }
  }
  if (raw === "none") return [];
  // Free public STUN finds the peers' addresses; on one LAN host candidates are enough.
  return [{ urls: "stun:stun.l.google.com:19302" }];
}

/** Project folders by id, for the action log file. Filled when a ticket is issued. */
const projectRoots = new Map<string, string>();

/** `.logicpacks/apps/` holds the action log and snapshots; it ignores itself in git. */
export function appsDir(root: string): string {
  const dir = NodePath.join(root, ".logicpacks", "apps");
  NodeFS.mkdirSync(dir, { recursive: true });
  const ignore = NodePath.join(dir, ".gitignore");
  if (!NodeFS.existsSync(ignore)) NodeFS.writeFileSync(ignore, "*\n");
  return dir;
}

export function rememberProjectRoot(projectId: string, root: string) {
  projectRoots.set(projectId, root);
}

const persist = (projectId: string, entry: AppStreamLogEntry) => {
  const root = projectRoots.get(projectId);
  if (!root) return;
  NodeFS.appendFileSync(
    NodePath.join(appsDir(root), "actions.jsonl"),
    `${JSON.stringify(entry)}\n`,
  );
};

/** The one hub of this server process: the socket route and the ops route share it. */
export const appStreamHub = new AppStreamHub({ iceServers: iceServersFromEnv(), persist });
setInterval(() => appStreamHub.tick(), 1000).unref();
registerSharedAppContext((projectId) => {
  const app = appStreamHub.sharedApp(projectId);
  if (app === null) return "";
  const host = appStreamHub.state(projectId).host;
  return sharedAppTurnContext({
    appName: app.appName,
    title: app.title,
    hostName: host?.name ?? "The host",
  });
});

interface Ticket {
  readonly projectId: string;
  readonly subject: string;
  readonly name: string;
  readonly canHost: boolean;
  /** A Read only member watches the shared app and never asks for control. */
  readonly readOnly: boolean;
  readonly expiresAtMs: number;
}
const tickets = new Map<string, Ticket>();

const subjectOf = (caller: Exclude<Caller, { kind: "anonymous" }>) =>
  caller.kind === "member" ? caller.userId : "operator";

/** The caller's access to a project, its folder and how they are named in the room. */
export const appRoomAccess = Effect.fn("logicpacks.appstream.access")(function* (
  caller: Caller,
  projectId: string,
) {
  if (caller.kind === "anonymous") return null;
  const access = yield* LogicPacksAccess;
  const role = caller.kind === "member" ? access.roleOf(caller.userId, projectId) : "owner";
  if (role === null) return null;
  const store = yield* ProjectStore.ProjectStoreV2;
  const shell = yield* store
    .getShell(projectId as ProjectId)
    .pipe(Effect.orElseSucceed(() => Option.none()));
  if (Option.isNone(shell)) return null;
  const user =
    caller.kind === "member"
      ? yield* access.getUser(caller.userId).pipe(Effect.orElseSucceed(() => null))
      : null;
  rememberProjectRoot(projectId, shell.value.workspaceRoot);
  return {
    subject: subjectOf(caller),
    name: user?.displayName ?? (caller.kind === "operator" ? "Host" : "Member"),
    // The person whose machine runs the app: the host owner, or a project owner on their desktop.
    canHost: caller.kind === "operator" || role === "owner",
    root: shell.value.workspaceRoot,
    title: shell.value.title,
  };
});

const TicketRequest = Schema.Struct({ projectId: Schema.String });

const ticketRoute = HttpRouter.add(
  "POST",
  "/api/lp/appstream/ticket",
  Effect.gen(function* () {
    const body = yield* readBody(TicketRequest);
    if (body === null) return json({ error: "bad_request" }, 400);
    const caller = yield* resolveCaller;
    if (caller.kind === "anonymous") return json({ error: "unauthenticated" }, 401);
    if (!(yield* requireFeature(caller, "apps"))) return json(FEATURE_LOCKED, 403);
    const room = yield* appRoomAccess(caller, body.projectId);
    if (room === null) return json({ error: "not_found" }, 404);
    const now = Date.now();
    for (const [key, ticket] of tickets) if (ticket.expiresAtMs < now) tickets.delete(key);
    const ticket = NodeCrypto.randomBytes(24).toString("base64url");
    tickets.set(ticket, {
      projectId: body.projectId,
      subject: room.subject,
      name: room.name,
      canHost: room.canHost,
      readOnly: (yield* refuseIfReadOnly(caller, body.projectId)) !== null,
      expiresAtMs: now + TICKET_TTL_MS,
    });
    return json({
      ticket,
      canHost: room.canHost,
      name: room.name,
      subject: room.subject,
      project: room.title,
    });
  }),
);

/** The room as it is now plus the recent log, for a page that is not connected yet. */
const stateRoute = HttpRouter.add(
  "GET",
  "/api/lp/appstream/state",
  Effect.gen(function* () {
    const projectId = yield* queryParam("projectId");
    const caller = yield* resolveCaller;
    if (caller.kind === "anonymous") return json({ error: "unauthenticated" }, 401);
    if (!(yield* requireFeature(caller, "apps"))) return json(FEATURE_LOCKED, 403);
    const room = yield* appRoomAccess(caller, projectId);
    if (room === null) return json({ error: "not_found" }, 404);
    return json({ state: appStreamHub.state(projectId), log: appStreamHub.logs(projectId) });
  }),
);

const textDecoder = new TextDecoder();

const socketRoute = HttpRouter.add(
  "GET",
  "/api/lp/appstream/ws",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (request.headers.upgrade?.toLowerCase() !== "websocket") {
      return HttpServerResponse.text("Upgrade Required", { status: 426 });
    }
    const ticketId = yield* queryParam("ticket");
    const wanted = (yield* queryParam("role")) === "host" ? "host" : "viewer";
    const ticket = tickets.get(ticketId);
    tickets.delete(ticketId);
    if (!ticket || ticket.expiresAtMs < Date.now()) {
      return HttpServerResponse.text("Unauthorized", { status: 401 });
    }
    if (wanted === "host" && !ticket.canHost) {
      return HttpServerResponse.text("Only the host can share an app", { status: 403 });
    }
    const incoming = NodeHttpServerRequest.toIncomingMessage(request);
    // Frames are JPEG or tiny JSON: no deflate, and the socket buffer stays measurable.
    delete incoming.headers["sec-websocket-extensions"];
    const transport = incoming.socket;

    return yield* Effect.scoped(
      Effect.gen(function* () {
        const socket = yield* request.upgrade;
        const writer = yield* socket.writer;
        const outgoing = yield* Queue.unbounded<string | Uint8Array | Socket.CloseEvent>();
        let queuedBytes = 0;
        const key = NodeCrypto.randomBytes(9).toString("base64url");
        const connection: AppStreamConnection = {
          key,
          subject: ticket.subject,
          name: ticket.name,
          role: wanted,
          send: (message) => {
            if (typeof message !== "string") queuedBytes += message.byteLength;
            Queue.offerUnsafe(outgoing, message);
          },
          // Frames waiting in our own queue count too: the socket buffer alone stays small while
          // the queue grows, and the viewer would see the app seconds late.
          buffered: () => transport.writableLength + queuedBytes,
          close: (code, reason) => {
            Queue.offerUnsafe(outgoing, new Socket.CloseEvent(code, reason));
          },
        };
        const pump = Effect.forever(
          Queue.take(outgoing).pipe(
            Effect.flatMap((message) =>
              message instanceof Socket.CloseEvent
                ? writer.write(message).pipe(Effect.andThen(Effect.interrupt))
                : writer.write(message).pipe(
                    Effect.ensuring(
                      Effect.sync(() => {
                        if (typeof message !== "string") queuedBytes -= message.byteLength;
                      }),
                    ),
                  ),
            ),
          ),
        );
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => appStreamHub.leave(ticket.projectId, key)),
        );
        appStreamHub.join(ticket.projectId, connection);
        const receive = (chunk: Uint8Array | string) =>
          Effect.sync(() => {
            if (typeof chunk !== "string") {
              // Binary from the host is a JPEG frame for the fallback path.
              if (wanted === "host" && chunk.byteLength <= MAX_FRAME_BYTES) {
                // JSON control messages may arrive as binary from some clients.
                if (chunk[0] === 0x7b) return handleText(textDecoder.decode(chunk));
                appStreamHub.frame(ticket.projectId, key, chunk);
              } else if (chunk[0] === 0x7b) {
                handleText(textDecoder.decode(chunk));
              }
              return;
            }
            handleText(chunk);
          });
        const handleText = (text: string) => {
          let message: AppStreamClientMessage;
          try {
            message = JSON.parse(text) as AppStreamClientMessage;
          } catch {
            return;
          }
          if (message === null || typeof message !== "object" || typeof message.t !== "string")
            return;
          if (ticket.readOnly && message.t === "control.request") return;
          appStreamHub.message(ticket.projectId, key, message);
        };
        const reader = yield* socket.reader;
        const read = Effect.forever(
          reader.pull.pipe(
            Effect.flatMap((chunks) => Effect.forEach(chunks, receive, { discard: true })),
          ),
        );
        return yield* Effect.raceFirst(pump, read).pipe(Effect.as(HttpServerResponse.empty()));
      }),
    ).pipe(Effect.orElseSucceed(() => HttpServerResponse.empty()));
  }),
);

export const layer = Layer.mergeAll(ticketRoute, stateRoute, socketRoute);
