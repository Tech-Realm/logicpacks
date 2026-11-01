import { describe, expect, it } from "vite-plus/test";

import {
  accountPageHtml,
  helperApprovePageHtml,
  joinPageHtml,
  loginPageHtml,
} from "./loginPage.ts";

const inlineScripts = (html: string) =>
  [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((match) => match[1] ?? "");

describe("LogicPacks pages", () => {
  it.each([
    ["login", loginPageHtml({ quickLogin: true })],
    [
      "login with providers",
      loginPageHtml({ quickLogin: false, providers: { google: true, github: true }, error: "x" }),
    ],
    [
      "join with providers",
      joinPageHtml({
        workspaceName: "Team",
        quickLogin: false,
        invite: "tok",
        providers: { google: true, github: false },
      }),
    ],
    ["account", accountPageHtml()],
    ["helper approval", helperApprovePageHtml()],
  ])("%s page scripts parse", (_name, html) => {
    const scripts = inlineScripts(html);
    expect(scripts.length).toBeGreaterThan(0);
    for (const script of scripts) {
      // Parses only; a stray newline inside a string (from the template literal) throws here.
      expect(() => new Function(script)).not.toThrow();
    }
  });
});
