// @effect-diagnostics globalDate:off globalTimers:off - a plain in-memory relay driven by socket callbacks.
/**
 * The live app-sharing hub: one room per project. The host's desktop app shares
 * one window; viewers watch it over WebRTC (this hub relays signalling) or as
 * JPEG frames relayed through here. Control is host-gated: a viewer asks, the
 * host grants that person for a number of minutes, and the hub forwards input
 * only while the grant is live. The kill switch drops every grant at once.
 *
 * Plain TypeScript on purpose: the socket route and the ops route both talk to
 * it, and the tests drive it without a server.
 */
import {
  APP_STREAM_MAX_GRANT_MINUTES,
  type AppStreamClientMessage,
  type AppStreamGrant,
  type AppStreamIceServer,
  type AppStreamLogEntry,
  type AppStreamLogSource,
  type AppStreamPerson,
  type AppStreamRequest,
  type AppStreamServerMessage,
  type AppStreamSharedApp,
  type AppStreamState,
  type AppStreamSubject,
} from "@logicpacks/contracts";

import { presenceColorIndex } from "./presence.ts";

/** One open socket. `send` must never throw; `buffered` is the bytes waiting on the wire. */
export interface AppStreamConnection {
  readonly key: string;
  readonly subject: AppStreamSubject;
  readonly name: string;
  readonly role: "host" | "viewer";
  readonly send: (message: string | Uint8Array) => void;
  readonly buffered: () => number;
  readonly close: (code: number, reason: string) => void;
}

interface Room {
  readonly projectId: string;
  host: AppStreamConnection | null;
  app: AppStreamSharedApp | null;
  readonly viewers: Map<string, AppStreamConnection & { jpeg: boolean }>;
  readonly grants: Map<AppStreamSubject, AppStreamGrant>;
  readonly requests: Map<AppStreamSubject, AppStreamRequest>;
  readonly log: AppStreamLogEntry[];
  lastCursorAt: Map<string, number>;
}

/** A JPEG frame is skipped for a viewer whose socket already holds this much. */
const MAX_VIEWER_BUFFER_BYTES = 1024 * 1024;
const LOG_LIMIT = 200;
const CURSOR_MIN_INTERVAL_MS = 16;

export interface AppStreamHubOptions {
  readonly now?: () => number;
  readonly iceServers?: ReadonlyArray<AppStreamIceServer>;
  /** Where each project's log is persisted, line by line. */
  readonly persist?: (projectId: string, entry: AppStreamLogEntry) => void;
}

const clampUnit = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : null;

export class AppStreamHub {
  private readonly rooms = new Map<string, Room>();
  private readonly now: () => number;
  private seq = 0;
  private readonly options: AppStreamHubOptions;

  constructor(options: AppStreamHubOptions = {}) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  get iceServers(): ReadonlyArray<AppStreamIceServer> {
    return this.options.iceServers ?? [];
  }

  private room(projectId: string): Room {
    let room = this.rooms.get(projectId);
    if (!room) {
      room = {
        projectId,
        host: null,
        app: null,
        viewers: new Map(),
        grants: new Map(),
        requests: new Map(),
        log: [],
        lastCursorAt: new Map(),
      };
      this.rooms.set(projectId, room);
    }
    return room;
  }

  private person(connection: AppStreamConnection): AppStreamPerson {
    return {
      key: connection.key,
      subject: connection.subject,
      name: connection.name,
      role: connection.role,
      colorIndex: presenceColorIndex(connection.subject),
      ...("jpeg" in connection && connection.jpeg === true ? { jpeg: true } : {}),
    };
  }

  /** Drops grants whose time ran out; true when any did. */
  private expire(room: Room): boolean {
    const now = this.now();
    let changed = false;
    for (const [subject, grant] of room.grants) {
      if (grant.expiresAtMs <= now) {
        room.grants.delete(subject);
        this.appendLog(room, {
          source: "system",
          actor: grant.name,
          subject,
          op: "control.expired",
          detail: "time limit reached",
        });
        changed = true;
      }
    }
    return changed;
  }

  state(projectId: string): AppStreamState {
    const room = this.room(projectId);
    this.expire(room);
    return {
      projectId,
      host: room.host ? this.person(room.host) : null,
      app: room.app,
      people: [
        ...(room.host ? [this.person(room.host)] : []),
        ...[...room.viewers.values()].map((viewer) => this.person(viewer)),
      ],
      grants: [...room.grants.values()],
      requests: [...room.requests.values()],
    };
  }

  logs(projectId: string): ReadonlyArray<AppStreamLogEntry> {
    return [...this.room(projectId).log];
  }

  /** Whether this subject may drive the shared app right now (agents' mutating ops ask too). */
  hasControl(projectId: string, subject: AppStreamSubject): boolean {
    const room = this.room(projectId);
    if (this.expire(room)) this.broadcastState(room);
    return room.grants.has(subject);
  }

  sharedApp(projectId: string): AppStreamSharedApp | null {
    return this.rooms.get(projectId)?.app ?? null;
  }

  private sendTo(connection: AppStreamConnection, message: AppStreamServerMessage) {
    connection.send(JSON.stringify(message));
  }

  private everyone(room: Room): AppStreamConnection[] {
    return [...(room.host ? [room.host] : []), ...room.viewers.values()];
  }

  private broadcastState(room: Room) {
    const message = JSON.stringify({
      t: "state",
      state: this.state(room.projectId),
    } satisfies AppStreamServerMessage);
    for (const connection of this.everyone(room)) connection.send(message);
  }

  private appendLog(
    room: Room,
    input: {
      readonly source: AppStreamLogSource;
      readonly actor: string;
      readonly subject: AppStreamSubject | null;
      readonly op: string;
      readonly detail: string;
      readonly ok?: boolean;
      readonly snapshot?: string;
    },
  ): AppStreamLogEntry {
    this.seq += 1;
    const entry: AppStreamLogEntry = {
      id: `${this.now().toString(36)}-${this.seq}`,
      atMs: this.now(),
      source: input.source,
      actor: input.actor,
      subject: input.subject,
      op: input.op,
      detail: input.detail,
      ok: input.ok ?? true,
      ...(input.snapshot ? { snapshot: input.snapshot } : {}),
    };
    room.log.push(entry);
    if (room.log.length > LOG_LIMIT) room.log.splice(0, room.log.length - LOG_LIMIT);
    try {
      this.options.persist?.(room.projectId, entry);
    } catch {
      // The live log still has it.
    }
    const message = JSON.stringify({ t: "log", entry } satisfies AppStreamServerMessage);
    for (const connection of this.everyone(room)) connection.send(message);
    return entry;
  }

  /** Agents' ops and other server-side actions land in the same log. */
  log(projectId: string, input: Parameters<AppStreamHub["appendLog"]>[1]): AppStreamLogEntry {
    return this.appendLog(this.room(projectId), input);
  }

  /** A socket joined. Hosts replace an earlier host connection of the same project. */
  join(projectId: string, connection: AppStreamConnection): void {
    const room = this.room(projectId);
    if (connection.role === "host") {
      if (room.host && room.host.key !== connection.key) {
        room.host.close(4409, "Another window took over hosting.");
      }
      room.host = connection;
    } else {
      room.viewers.set(connection.key, { ...connection, jpeg: false });
    }
    this.sendTo(connection, {
      t: "hello",
      you: this.person(connection),
      iceServers: this.iceServers,
    });
    this.sendTo(connection, { t: "logs", entries: room.log.slice(-50) });
    this.broadcastState(room);
  }

  leave(projectId: string, key: string): void {
    const room = this.rooms.get(projectId);
    if (!room) return;
    if (room.host?.key === key) {
      room.host = null;
      if (room.app) {
        this.appendLog(room, {
          source: "host",
          actor: "Host",
          subject: null,
          op: "app.unshare",
          detail: `${room.app.appName} (host left)`,
        });
      }
      room.app = null;
      // Control never outlives the host's session.
      room.grants.clear();
      room.requests.clear();
    } else {
      room.viewers.delete(key);
      room.lastCursorAt.delete(key);
    }
    this.broadcastState(room);
  }

  /** A JPEG frame from the host: relayed to viewers on the fallback path, newest wins. */
  frame(projectId: string, key: string, bytes: Uint8Array): void {
    const room = this.rooms.get(projectId);
    if (!room || room.host?.key !== key) return;
    for (const viewer of room.viewers.values()) {
      if (!viewer.jpeg) continue;
      if (viewer.buffered() > MAX_VIEWER_BUFFER_BYTES) continue;
      viewer.send(bytes);
    }
  }

  /** One text message from a socket. Anything not allowed for its role is refused. */
  message(projectId: string, key: string, message: AppStreamClientMessage): void {
    const room = this.room(projectId);
    const isHost = room.host?.key === key;
    const from: AppStreamConnection | undefined = isHost ? room.host! : room.viewers.get(key);
    if (!from) return;
    const refuse = (code: string, text: string) =>
      this.sendTo(from, { t: "error", code, message: text });

    switch (message.t) {
      case "ping":
        return this.sendTo(from, { t: "pong", at: message.at });
      case "signal": {
        const target =
          room.host?.key === message.to ? room.host : (room.viewers.get(message.to) ?? null);
        // Viewers only signal the host; the host signals any viewer.
        if (!target || (!isHost && target !== room.host)) return;
        return this.sendTo(target, { t: "signal", from: key, data: message.data });
      }
      case "cursor": {
        const x = clampUnit(message.x);
        const y = clampUnit(message.y);
        if (x === null || y === null) return;
        const now = this.now();
        if (now - (room.lastCursorAt.get(key) ?? 0) < CURSOR_MIN_INTERVAL_MS) return;
        room.lastCursorAt.set(key, now);
        const out = JSON.stringify({
          t: "cursor",
          key,
          name: from.name,
          colorIndex: presenceColorIndex(from.subject),
          x,
          y,
          controlling: room.grants.has(from.subject),
        } satisfies AppStreamServerMessage);
        for (const connection of this.everyone(room)) {
          if (connection.key !== key) connection.send(out);
        }
        return;
      }
      case "log": {
        if (!isHost) return refuse("host_only", "Only the host writes to the log directly.");
        this.appendLog(room, {
          source: "human",
          actor: "Host",
          subject: from.subject,
          op: String(message.op).slice(0, 80),
          detail: String(message.detail).slice(0, 200),
        });
        return;
      }
    }

    if (isHost) {
      switch (message.t) {
        case "share": {
          const app = message.app;
          room.app = {
            appName: String(app.appName).slice(0, 120),
            title: String(app.title).slice(0, 300),
            sourceId: String(app.sourceId).slice(0, 200),
            windowId: typeof app.windowId === "number" ? app.windowId : null,
            width: Math.max(0, Math.round(Number(app.width) || 0)),
            height: Math.max(0, Math.round(Number(app.height) || 0)),
            recipeId: typeof app.recipeId === "string" ? app.recipeId : null,
            sharedAtMs: this.now(),
          };
          this.appendLog(room, {
            source: "host",
            actor: "Host",
            subject: from.subject,
            op: "app.share",
            detail:
              room.app.title === room.app.appName
                ? room.app.appName
                : `${room.app.appName}: ${room.app.title}`,
          });
          return this.broadcastState(room);
        }
        case "unshare": {
          if (room.app) {
            this.appendLog(room, {
              source: "host",
              actor: "Host",
              subject: from.subject,
              op: "app.unshare",
              detail: room.app.appName,
            });
          }
          room.app = null;
          room.grants.clear();
          room.requests.clear();
          return this.broadcastState(room);
        }
        case "grant": {
          const request = room.requests.get(message.subject);
          const viewer = [...room.viewers.values()].find((v) => v.subject === message.subject);
          const name = request?.name ?? viewer?.name;
          if (!name) return refuse("unknown_person", "That person is not watching.");
          const minutes = Math.min(
            APP_STREAM_MAX_GRANT_MINUTES,
            Math.max(1, Math.round(Number(message.minutes) || 0)),
          );
          const now = this.now();
          room.grants.set(message.subject, {
            subject: message.subject,
            name,
            grantedAtMs: now,
            expiresAtMs: now + minutes * 60_000,
          });
          room.requests.delete(message.subject);
          this.appendLog(room, {
            source: "host",
            actor: "Host",
            subject: from.subject,
            op: "control.grant",
            detail: `${name} for ${minutes} min`,
          });
          return this.broadcastState(room);
        }
        case "deny": {
          const request = room.requests.get(message.subject);
          room.requests.delete(message.subject);
          if (request) {
            this.appendLog(room, {
              source: "host",
              actor: "Host",
              subject: from.subject,
              op: "control.deny",
              detail: request.name,
            });
          }
          return this.broadcastState(room);
        }
        case "revoke":
        case "kill": {
          const all = message.t === "kill" || message.subject === "*";
          const names: string[] = [];
          for (const [subject, grant] of room.grants) {
            if (all || subject === (message as { subject: string }).subject) {
              room.grants.delete(subject);
              names.push(grant.name);
            }
          }
          if (message.t === "kill") room.requests.clear();
          this.appendLog(room, {
            source: "host",
            actor: "Host",
            subject: from.subject,
            op: message.t === "kill" ? "control.kill" : "control.revoke",
            detail: names.length > 0 ? names.join(", ") : "nobody had control",
          });
          return this.broadcastState(room);
        }
        default:
          return;
      }
    }

    // Viewers.
    const viewer = room.viewers.get(key)!;
    switch (message.t) {
      case "jpeg":
        viewer.jpeg = message.on === true;
        return this.broadcastState(room);
      case "control.request": {
        if (!room.app) return refuse("not_shared", "Nothing is shared right now.");
        if (room.grants.has(viewer.subject)) return;
        room.requests.set(viewer.subject, {
          subject: viewer.subject,
          name: viewer.name,
          atMs: this.now(),
        });
        this.appendLog(room, {
          source: "human",
          actor: viewer.name,
          subject: viewer.subject,
          op: "control.request",
          detail: room.app.appName,
        });
        return this.broadcastState(room);
      }
      case "control.release": {
        const had = room.grants.delete(viewer.subject) || room.requests.delete(viewer.subject);
        if (had) {
          this.appendLog(room, {
            source: "human",
            actor: viewer.name,
            subject: viewer.subject,
            op: "control.release",
            detail: "",
          });
        }
        return this.broadcastState(room);
      }
      case "input": {
        if (!room.host || !room.app) return refuse("not_shared", "Nothing is shared right now.");
        if (this.expire(room)) this.broadcastState(room);
        if (!room.grants.has(viewer.subject)) {
          return refuse("not_granted", "Ask the host for control first.");
        }
        return this.sendTo(room.host, {
          t: "input",
          from: key,
          subject: viewer.subject,
          name: viewer.name,
          ev: message.ev,
        });
      }
      default:
        return refuse("host_only", "Only the host can do that.");
    }
  }

  /** Called every second: expired grants leave and everyone hears about it. */
  tick(): void {
    for (const room of this.rooms.values()) {
      if (this.expire(room)) this.broadcastState(room);
    }
  }
}
