import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  buildHostedPairingUrl,
  hasHostedPairingRequest,
  isHostedStaticApp,
  readHostedPairingRequest,
} from "./hostedPairing";

describe("hostedPairing", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("does not treat the server-served cloud host as the hosted static client", () => {
    vi.stubEnv("VITE_HOSTED_APP_URL", "");
    vi.stubEnv("VITE_HOSTED_APP_CHANNEL", "");
    vi.stubEnv("VITE_HTTP_URL", "");
    vi.stubEnv("VITE_WS_URL", "");
    expect(isHostedStaticApp(new URL("https://app.logicpacks.io/"))).toBe(false);

    vi.stubEnv("VITE_HOSTED_APP_URL", "https://static.example.com");
    expect(isHostedStaticApp(new URL("https://static.example.com/"))).toBe(true);
    expect(isHostedStaticApp(new URL("https://app.logicpacks.io/"))).toBe(false);
  });

  it("reads hosted pairing host and query token parameters", () => {
    const url = new URL("https://app.logicpacks.io/pair?host=100.64.1.2:3773&token=ABCD1234");

    expect(readHostedPairingRequest(url)).toEqual({
      host: "100.64.1.2:3773",
      token: "ABCD1234",
      label: "",
    });
    expect(hasHostedPairingRequest(url)).toBe(true);
  });

  it("prefers hash tokens so generated hosted links do not put credentials in search params", () => {
    vi.stubEnv("VITE_HOSTED_APP_URL", "https://preview.logicpacks.io");

    const url = new URL(
      buildHostedPairingUrl({
        host: "https://backend.example.com:3773",
        token: "pairing-token",
        label: "Workstation",
      }),
    );

    expect(url.origin).toBe("https://preview.logicpacks.io");
    expect(url.pathname).toBe("/pair");
    expect(url.searchParams.get("host")).toBe("https://backend.example.com:3773");
    expect(url.searchParams.get("label")).toBe("Workstation");
    expect(url.searchParams.has("token")).toBe(false);
    expect(url.hash).toBe("#token=pairing-token");
  });
});
