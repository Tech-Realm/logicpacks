/**
 * Live app sharing ("Every app, every agent, one machine"): the wire protocol of
 * `/api/lp/appstream/ws`. The host's desktop app streams one app window to the
 * project's viewers over WebRTC (the LogicPacks server relays signalling only),
 * or as JPEG frames over this socket when no peer connection comes up. Viewers
 * ask for control; the host approves each person with a time limit and can
 * revoke anyone, or everyone with the kill switch. The server forwards input
 * only from people with a live grant, and the host checks again before it
 * injects anything.
 */

export type AppStreamRole = "host" | "viewer";

/** Who someone is across reconnects: a member's user id, or "operator" for the host owner. */
export type AppStreamSubject = string;

export interface AppStreamPerson {
  /** One connection. */
  readonly key: string;
  readonly subject: AppStreamSubject;
  readonly name: string;
  readonly role: AppStreamRole;
  /** Presence palette slot, stable per subject. */
  readonly colorIndex: number;
  /** Viewers on the JPEG fallback, so the host knows to send frames through the server. */
  readonly jpeg?: boolean;
}

export interface AppStreamSharedApp {
  /** The app's name, e.g. "Blender". */
  readonly appName: string;
  /** The window's title. */
  readonly title: string;
  /** The capture source the host picked (Electron desktopCapturer id). */
  readonly sourceId: string;
  /** macOS CGWindowID, Windows HWND, when known. Input goes to this window only. */
  readonly windowId: number | null;
  readonly width: number;
  readonly height: number;
  /** A recipe whose ops agents can use on this app, e.g. "blender". */
  readonly recipeId: string | null;
  readonly sharedAtMs: number;
}

export interface AppStreamGrant {
  readonly subject: AppStreamSubject;
  readonly name: string;
  readonly grantedAtMs: number;
  readonly expiresAtMs: number;
}

export interface AppStreamRequest {
  readonly subject: AppStreamSubject;
  readonly name: string;
  readonly atMs: number;
}

export type AppStreamLogSource = "human" | "agent" | "host" | "system";

/** One line of the action log: "Mira's agent: blender.move Vase z 1.24". */
export interface AppStreamLogEntry {
  readonly id: string;
  readonly atMs: number;
  readonly source: AppStreamLogSource;
  /** "Mira's agent", "Ana", "Host". */
  readonly actor: string;
  readonly subject: AppStreamSubject | null;
  /** The semantic op, e.g. "blender.move". */
  readonly op: string;
  /** Its arguments in a few words: "Vase z 1.24". */
  readonly detail: string;
  readonly ok: boolean;
  /** Set when the op made a snapshot, so the log can offer a restore. */
  readonly snapshot?: string;
}

export interface AppStreamState {
  readonly projectId: string;
  readonly host: AppStreamPerson | null;
  readonly app: AppStreamSharedApp | null;
  readonly people: ReadonlyArray<AppStreamPerson>;
  readonly grants: ReadonlyArray<AppStreamGrant>;
  readonly requests: ReadonlyArray<AppStreamRequest>;
}

/** Input from a viewer, in window coordinates normalised to 0..1. */
export type AppStreamInput =
  | {
      readonly kind: "move" | "down" | "up";
      readonly x: number;
      readonly y: number;
      readonly button?: 0 | 1 | 2;
    }
  | {
      readonly kind: "scroll";
      readonly x: number;
      readonly y: number;
      readonly dx: number;
      readonly dy: number;
    }
  | {
      readonly kind: "key";
      /** KeyboardEvent.code, e.g. "KeyG", "Numpad1", "Space". */
      readonly code: string;
      readonly down: boolean;
      readonly shift?: boolean;
      readonly ctrl?: boolean;
      readonly alt?: boolean;
      readonly meta?: boolean;
    };

export type AppStreamClientMessage =
  | { readonly t: "share"; readonly app: Omit<AppStreamSharedApp, "sharedAtMs"> }
  | { readonly t: "unshare" }
  | { readonly t: "grant"; readonly subject: AppStreamSubject; readonly minutes: number }
  | { readonly t: "deny"; readonly subject: AppStreamSubject }
  | { readonly t: "revoke"; readonly subject: AppStreamSubject | "*" }
  | { readonly t: "kill" }
  | { readonly t: "signal"; readonly to: string; readonly data: unknown }
  | { readonly t: "control.request" }
  | { readonly t: "control.release" }
  | { readonly t: "input"; readonly ev: AppStreamInput }
  | { readonly t: "cursor"; readonly x: number; readonly y: number }
  | { readonly t: "jpeg"; readonly on: boolean }
  | { readonly t: "log"; readonly op: string; readonly detail: string }
  | { readonly t: "ping"; readonly at: number };

export type AppStreamServerMessage =
  | {
      readonly t: "hello";
      readonly you: AppStreamPerson;
      readonly iceServers: ReadonlyArray<AppStreamIceServer>;
    }
  | { readonly t: "state"; readonly state: AppStreamState }
  | { readonly t: "signal"; readonly from: string; readonly data: unknown }
  | {
      readonly t: "input";
      readonly from: string;
      readonly subject: AppStreamSubject;
      readonly name: string;
      readonly ev: AppStreamInput;
    }
  | {
      readonly t: "cursor";
      readonly key: string;
      readonly name: string;
      readonly colorIndex: number;
      readonly x: number;
      readonly y: number;
      readonly controlling: boolean;
    }
  | { readonly t: "log"; readonly entry: AppStreamLogEntry }
  | { readonly t: "logs"; readonly entries: ReadonlyArray<AppStreamLogEntry> }
  | { readonly t: "error"; readonly code: string; readonly message: string }
  | { readonly t: "pong"; readonly at: number };

export interface AppStreamIceServer {
  readonly urls: string | ReadonlyArray<string>;
  readonly username?: string;
  readonly credential?: string;
}

/** Longest a host can hand over control in one grant. */
export const APP_STREAM_MAX_GRANT_MINUTES = 120;
