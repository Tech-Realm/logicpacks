import { describe, expect, it } from "@effect/vitest";

import { AppStreamHub, type AppStreamConnection } from "./appStream.ts";

const makeConnection = (
  key: string,
  subject: string,
  name: string,
  role: "host" | "viewer",
): AppStreamConnection & { readonly inbox: unknown[]; closed: string | null } => {
  const inbox: unknown[] = [];
  const connection = {
    key,
    subject,
    name,
    role,
    inbox,
    closed: null as string | null,
    send: (message: string | Uint8Array) => {
      inbox.push(typeof message === "string" ? JSON.parse(message) : message);
    },
    buffered: () => 0,
    close: (_code: number, reason: string) => {
      connection.closed = reason;
    },
  };
  return connection;
};

const of = (inbox: unknown[], t: string) =>
  inbox.filter((message) => (message as { t: string }).t === t) as Array<Record<string, any>>;

describe("AppStreamHub", () => {
  const setup = () => {
    let now = 1_000_000;
    const hub = new AppStreamHub({ now: () => now });
    const host = makeConnection("h1", "operator", "Host", "host");
    const ana = makeConnection("v1", "user-ana", "Ana", "viewer");
    const bo = makeConnection("v2", "user-bo", "Bo", "viewer");
    hub.join("p1", host);
    hub.join("p1", ana);
    hub.join("p1", bo);
    hub.message("p1", "h1", {
      t: "share",
      app: {
        appName: "Blender",
        title: "scene.blend",
        sourceId: "window:42:0",
        windowId: 42,
        width: 1280,
        height: 800,
        recipeId: "blender",
      },
    });
    return { hub, host, ana, bo, advance: (ms: number) => (now += ms) };
  };

  it("never forwards input without a grant", () => {
    const { hub, host, ana } = setup();
    hub.message("p1", "v1", { t: "input", ev: { kind: "down", x: 0.5, y: 0.5 } });
    expect(of(host.inbox, "input")).toHaveLength(0);
    expect(of(ana.inbox, "error").at(-1)?.code).toBe("not_granted");
  });

  it("forwards input from the granted person only, until revoked", () => {
    const { hub, host, ana } = setup();
    hub.message("p1", "v1", { t: "control.request" });
    expect(hub.state("p1").requests.map((r) => r.subject)).toEqual(["user-ana"]);
    hub.message("p1", "h1", { t: "grant", subject: "user-ana", minutes: 5 });
    hub.message("p1", "v1", { t: "input", ev: { kind: "down", x: 0.5, y: 0.5 } });
    hub.message("p1", "v2", { t: "input", ev: { kind: "down", x: 0.1, y: 0.1 } });
    expect(of(host.inbox, "input").map((m) => m.name)).toEqual(["Ana"]);
    hub.message("p1", "h1", { t: "revoke", subject: "user-ana" });
    hub.message("p1", "v1", { t: "input", ev: { kind: "up", x: 0.5, y: 0.5 } });
    expect(of(host.inbox, "input")).toHaveLength(1);
    expect(of(ana.inbox, "error").at(-1)?.code).toBe("not_granted");
  });

  it("expires grants and drops them all on the kill switch", () => {
    const { hub, advance } = setup();
    hub.message("p1", "v1", { t: "control.request" });
    hub.message("p1", "h1", { t: "grant", subject: "user-ana", minutes: 1 });
    hub.message("p1", "v2", { t: "control.request" });
    hub.message("p1", "h1", { t: "grant", subject: "user-bo", minutes: 10 });
    advance(61_000);
    expect(hub.hasControl("p1", "user-ana")).toBe(false);
    expect(hub.hasControl("p1", "user-bo")).toBe(true);
    hub.message("p1", "h1", { t: "kill" });
    expect(hub.hasControl("p1", "user-bo")).toBe(false);
    expect(hub.logs("p1").map((entry) => entry.op)).toContain("control.kill");
  });

  it("lets only the host grant, and clears control when the host leaves", () => {
    const { hub } = setup();
    hub.message("p1", "v1", { t: "grant", subject: "user-ana", minutes: 5 } as never);
    expect(hub.hasControl("p1", "user-ana")).toBe(false);
    hub.message("p1", "v1", { t: "control.request" });
    hub.message("p1", "h1", { t: "grant", subject: "user-ana", minutes: 5 });
    hub.leave("p1", "h1");
    expect(hub.hasControl("p1", "user-ana")).toBe(false);
    expect(hub.state("p1").app).toBeNull();
  });

  it("relays signalling host to viewer and viewer to host only", () => {
    const { hub, host, ana, bo } = setup();
    hub.message("p1", "h1", { t: "signal", to: "v1", data: { sdp: "offer" } });
    hub.message("p1", "v1", { t: "signal", to: "h1", data: { sdp: "answer" } });
    hub.message("p1", "v1", { t: "signal", to: "v2", data: { sdp: "sneaky" } });
    expect(of(ana.inbox, "signal")).toHaveLength(1);
    expect(of(host.inbox, "signal")[0]?.from).toBe("v1");
    expect(of(bo.inbox, "signal")).toHaveLength(0);
  });
});
