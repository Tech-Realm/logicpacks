import { describe, expect, it } from "vite-plus/test";

import { MEMBER_SUBJECT_PREFIX } from "../logicpacks/projectAccess.ts";
import {
  classifyRelayedRequest,
  headersForLocalServer,
  headersForVisitor,
  normalizeRelayedPath,
} from "./gateway.ts";
import { RELAY_MARKER_HEADER, isRelayedHeaders, relayMarkerValue, sessionAllowedThroughRelay } from "./relayTrust.ts";

const ctx = { sessionCookieName: "lp_session_3000_abc" };
const get = (path: string, headers: Record<string, string> = {}) => classifyRelayedRequest({ method: "GET", path, headers }, ctx);
const post = (path: string, headers: Record<string, string> = {}) => classifyRelayedRequest({ method: "POST", path, headers }, ctx);
const member = { cookie: "__Host-lp_session_3000_abc=tok" };

describe("what a relayed visitor may reach", () => {
  it("lets an invite holder open only the join and sign-in surfaces", () => {
    for (const [method, path] of [
      ["GET", "/lp/join/project?invite=abc"],
      ["GET", "/lp/join?invite=abc"],
      ["GET", "/lp/login"],
      ["POST", "/api/lp/join/project"],
      ["POST", "/api/lp/auth/password"],
    ] as const) {
      expect(classifyRelayedRequest({ method, path, headers: {} }, ctx).allow, `${method} ${path}`).toBe(true);
    }
  });

  it("shows everything else to a visitor without a session as nothing", () => {
    for (const path of ["/", "/index.html", "/assets/app.js", "/api/lp/me", "/api/lp/projects", "/ws", "/api/auth/session", "/robots.txt", "/lp/account"]) {
      expect(get(path), path).toEqual({ allow: false, status: 404 });
    }
  });

  it("never lets pairing, tokens, the local helper key or desktop routes through, even with a session", () => {
    for (const path of [
      "/pair",
      "/pair/",
      "/PAIR",
      "/%70air",
      "/a/../pair",
      "//pair",
      "/pair?token=1",
      "/api/auth/pairing-token",
      "/api/auth/pairing-links/revoke",
      "/api/auth/clients/revoke",
      "/api/auth/browser-session",
      "/oauth/token",
      "/oauth/mcp/register",
      "/.well-known/oauth-authorization-server",
      "/.well-known/anything",
      "/.well-known/t3/environment/../oauth-protected-resource",
      "/mcp",
      "/api/connect/relay-config",
      "/api/t3-connect/mint-credential",
      "/api/hooks/a/b",
      "/api/device-hub/x",
      "/api/devices/boot",
      "/api/observability/v1/traces",
      "/api/lp/helper/pair/local",
      "/api/lp/helper/pair/local/",
      "/API/LP/HELPER/PAIR/LOCAL",
      "/api/lp/helper/key",
      "/%2e%2e/pair",
      "/api/lp%2fhelper/pair/local",
    ]) {
      expect(get(path, member).allow, `GET ${path}`).toBe(false);
      expect(post(path, member).allow, `POST ${path}`).toBe(false);
      expect(get(path).allow, `anonymous GET ${path}`).toBe(false);
    }
  });

  it("hands the environment descriptor to a signed-in member only", () => {
    expect(get("/.well-known/t3/environment", member).allow).toBe(true);
    expect(get("/.well-known/t3/environment").allow).toBe(false);
  });

  it("lets a signed-in member (cookie, bearer token or socket ticket) use the app", () => {
    expect(get("/api/lp/projects", member)).toEqual({ allow: true, credentialed: true, needsMember: true, ticket: false });
    expect(get("/ws?wsTicket=abc")).toMatchObject({ allow: true, needsMember: true, ticket: true });
    expect(get("/lp/join/project?invite=x", member)).toMatchObject({ allow: true, needsMember: false });
    expect(get("/", member).allow).toBe(true);
    expect(get("/api/lp/me", { authorization: "Bearer abc" }).allow).toBe(true);
    expect(get("/ws?wsTicket=abc").allow).toBe(true);
    expect(get("/api/lp/me", { cookie: "other=1; __Host-lp_session_3000_abc=" }).allow).toBe(false);
    // A plain name could have been planted by a sibling subdomain.
    expect(get("/api/lp/me", { cookie: "lp_session_3000_abc=tok" }).allow).toBe(false);
    expect(get("/api/lp/me", { cookie: "lp_session_9999_zzz=tok" }).allow).toBe(false);
  });

  it("lets a signed upload URL through without a cookie", () => {
    expect(post("/api/attachments/upload/abc.def").allow).toBe(true);
    expect(get("/api/attachments/upload/abc.def").allow).toBe(false);
  });

  it("refuses odd methods and paths", () => {
    expect(classifyRelayedRequest({ method: "TRACE", path: "/", headers: member }, ctx)).toEqual({ allow: false, status: 405 });
    expect(classifyRelayedRequest({ method: "CONNECT", path: "/", headers: member }, ctx).allow).toBe(false);
    expect(get("http://evil/pair", member).allow).toBe(false);
    expect(get("/lp/join\u0000", member).allow).toBe(false);
    expect(normalizeRelayedPath("/a/%zz")).toBeNull();
  });
});

describe("headers sent on to the local server", () => {
  it("drops everything a visitor could use to look local or like the relay, then writes the relay facts", () => {
    const out = headersForLocalServer({
      visitorHeaders: {
        host: "attacker.example",
        "x-forwarded-for": "127.0.0.1",
        "x-forwarded-host": "localhost",
        "x-real-ip": "127.0.0.1",
        "cf-connecting-ip": "127.0.0.1",
        forwarded: "for=127.0.0.1",
        "true-client-ip": "127.0.0.1",
        [RELAY_MARKER_HEADER]: "guess",
        "x-lp-anything": "1",
        "x-relay-id": "1",
        via: "1.1 local",
        connection: "keep-alive",
        "transfer-encoding": "chunked",
        authorization: "Bearer visitor-own-token",
        cookie: "a=b",
        "user-agent": "x",
      },
      publicHost: "abc.logicpacks.io",
      ip: "203.0.113.9",
    });
    expect(out.host).toBe("abc.logicpacks.io");
    expect(out["x-forwarded-for"]).toBe("203.0.113.9");
    expect(out["x-forwarded-proto"]).toBe("https");
    expect(out["x-forwarded-host"]).toBe("abc.logicpacks.io");
    expect(out[RELAY_MARKER_HEADER]).toBe(relayMarkerValue());
    expect(out["x-real-ip"]).toBeUndefined();
    expect(out["cf-connecting-ip"]).toBeUndefined();
    expect(out.forwarded).toBeUndefined();
    expect(out["true-client-ip"]).toBeUndefined();
    expect(out["x-lp-anything"]).toBeUndefined();
    expect(out["x-relay-id"]).toBeUndefined();
    expect(out.via).toBeUndefined();
    expect(out.connection).toBeUndefined();
    expect(out["transfer-encoding"]).toBeUndefined();
    expect(out.cookie).toBe("a=b");
    expect(isRelayedHeaders(out)).toBe(true);
  });

  it("cannot be fooled by a spoofed address string", () => {
    const out = headersForLocalServer({ visitorHeaders: {}, publicHost: "a.b", ip: "1.2.3.4\r\nx-lp-relayed: 1" });
    expect(out["x-forwarded-for"]).toMatch(/^[0-9a-f:.]+$/);
    expect(out["x-forwarded-for"]).not.toMatch(/[\r\n -]/);
    expect(Object.keys(out).every((key) => !key.includes("\n"))).toBe(true);
  });

  it("answers visitors with Secure cookies and without internal headers", () => {
    const out = headersForVisitor({ "set-cookie": ["a=b; Path=/; HttpOnly", "c=d; Secure"], "x-lp-relayed": "1", connection: "close", "content-type": "text/html" });
    expect(out["set-cookie"]).toEqual(["a=b; Path=/; HttpOnly; Secure", "c=d; Secure"]);
    expect(out["x-lp-relayed"]).toBeUndefined();
    expect(out.connection).toBeUndefined();
    expect(headersForVisitor({ "set-cookie": "a=b" }, { secureCookies: false })["set-cookie"]).toEqual(["a=b"]);
  });
});

describe("the relay marker and who may use a relayed request", () => {
  it("is random, long and recognised only when exact", () => {
    expect(relayMarkerValue()).toMatch(/^[0-9a-f]{64}$/);
    expect(isRelayedHeaders({ [RELAY_MARKER_HEADER]: relayMarkerValue() })).toBe(true);
    expect(isRelayedHeaders({ [RELAY_MARKER_HEADER]: relayMarkerValue().slice(1) })).toBe(false);
    expect(isRelayedHeaders({ [RELAY_MARKER_HEADER]: "x".repeat(64) })).toBe(false);
    expect(isRelayedHeaders({})).toBe(false);
  });

  it("accepts member sessions only; the owner, helper operators, agents and devices stay local", () => {
    expect(sessionAllowedThroughRelay(`${MEMBER_SUBJECT_PREFIX}u1`)).toBe(true);
    for (const subject of ["desktop-bootstrap", "one-time-token", "lp-helper:local-operator", "mcp-client", "owner", "dev-auth", MEMBER_SUBJECT_PREFIX, ""]) {
      expect(sessionAllowedThroughRelay(subject), subject).toBe(false);
    }
  });
});
