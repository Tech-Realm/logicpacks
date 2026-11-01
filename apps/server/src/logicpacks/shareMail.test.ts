import * as NodeNet from "node:net";

import { afterAll, assert, beforeAll, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  appsScriptSend,
  buildMimeMessage,
  makeMailer,
  parseSmtpUrl,
  shareInviteMail,
  smtpSend,
} from "./shareMail.ts";

const mail = shareInviteMail({
  to: "bo@example.com",
  inviterName: "Ana",
  projectTitle: "Team site",
  link: "https://app.example.test/lp/join/project?invite=abc",
});

/** A tiny SMTP server that records the conversation (no TLS, localhost only). */
let server: NodeNet.Server;
let port = 0;
const transcripts: Array<Array<string>> = [];
beforeAll(async () => {
  server = NodeNet.createServer((socket) => {
    const lines: Array<string> = [];
    transcripts.push(lines);
    let inData = false;
    let buffer = "";
    socket.write("220 test ESMTP\r\n");
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let index: number;
      while ((index = buffer.indexOf("\r\n")) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        lines.push(line);
        if (inData) {
          if (line === ".") {
            inData = false;
            socket.write("250 queued\r\n");
          }
          continue;
        }
        if (line.startsWith("EHLO")) socket.write("250-test\r\n250 AUTH PLAIN LOGIN\r\n");
        else if (line.startsWith("AUTH PLAIN")) {
          const decoded = Buffer.from(line.slice(11), "base64").toString("utf8");
          socket.write(decoded === "\u0000resend\u0000secret" ? "235 ok\r\n" : "535 no\r\n");
        } else if (line === "DATA") {
          inData = true;
          socket.write("354 go\r\n");
        } else if (line === "QUIT") socket.end("221 bye\r\n");
        else socket.write("250 ok\r\n");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  port = (server.address() as NodeNet.AddressInfo).port;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe("shareMail", () => {
  it("writes a short plain invite with the link and no em-dashes", () => {
    assert.strictEqual(mail.subject, "Ana shared Team site with you on LogicPacks");
    assert.include(mail.text, "https://app.example.test/lp/join/project?invite=abc");
    assert.include(mail.html, 'href="https://app.example.test/lp/join/project?invite=abc"');
    assert.include(mail.text, "LogicPacks is");
    assert.notInclude(mail.text + mail.html + mail.subject, "—");
  });

  it("parses smtp and smtps URLs", () => {
    assert.deepStrictEqual(parseSmtpUrl("smtps://resend:re_abc@smtp.resend.com:465"), {
      host: "smtp.resend.com",
      port: 465,
      secure: true,
      user: "resend",
      password: "re_abc",
    });
    assert.strictEqual(parseSmtpUrl("smtp://smtp.example.com")?.port, 587);
    assert.strictEqual(parseSmtpUrl("https://example.com"), null);
    assert.strictEqual(parseSmtpUrl("not a url"), null);
  });

  it("builds a multipart message with base64 bodies", () => {
    const message = buildMimeMessage(
      "LogicPacks <invites@logicpacks.io>",
      mail,
      "Sun, 01 Nov 2026 09:00:00 +0000",
    );
    assert.include(message, "Content-Type: multipart/alternative");
    assert.include(message, "To: bo@example.com");
    assert.include(message, "Message-ID: <");
    assert.include(message, "@logicpacks.io>");
  });

  it("sends over SMTP with AUTH PLAIN", async () => {
    await smtpSend(
      { host: "127.0.0.1", port, secure: false, user: "resend", password: "secret" },
      "LogicPacks <invites@logicpacks.io>",
      mail,
      { dateHeader: "Sun, 01 Nov 2026 09:00:00 +0000" },
    );
    const lines = transcripts.at(-1)!;
    assert.include(lines, "MAIL FROM:<invites@logicpacks.io>");
    assert.include(lines, "RCPT TO:<bo@example.com>");
    assert.include(lines, ".");
  });

  it.live("reports a refused login without throwing", () =>
    Effect.gen(function* () {
      const mailer = makeMailer({ smtpUrl: `smtp://resend:wrong@127.0.0.1:${port}`, from: "" });
      assert.strictEqual(mailer.mode, "smtp");
      const result = yield* mailer.send(mail);
      assert.strictEqual(result.delivered, false);
    }),
  );

  it.effect("falls back to the log without an SMTP URL", () =>
    Effect.gen(function* () {
      const mailer = makeMailer({ smtpUrl: "", from: "" });
      assert.strictEqual(mailer.mode, "log");
      const result = yield* mailer.send(mail);
      assert.deepStrictEqual(result, {
        delivered: false,
        via: "log",
        reason: "no mail transport configured",
      });
    }),
  );

  describe("Apps Script transport", () => {
    const URL_ = "https://script.google.com/macros/s/TEST/exec";
    const KEY = "test-key-123";
    type Call = {
      url: string;
      init: { method: string; headers: Record<string, string>; body: string; redirect: string };
    };
    const fakeFetch = (answers: Array<{ status: number; body: string } | Error>) => {
      const calls: Array<Call> = [];
      const fetch = async (url: string, init: Call["init"]) => {
        calls.push({ url, init });
        const answer = answers.shift() ?? { status: 200, body: '{"ok":true}' };
        if (answer instanceof Error) throw answer;
        return {
          ok: answer.status >= 200 && answer.status < 300,
          status: answer.status,
          text: async () => answer.body,
        };
      };
      return { calls, fetch };
    };

    it("posts the JSON as text/plain with html and a plaintext fallback", async () => {
      const { calls, fetch } = fakeFetch([
        { status: 200, body: '{"ok":true,"sentTo":"bo@example.com"}' },
      ]);
      await appsScriptSend({ url: URL_, key: KEY }, mail, fetch);
      assert.strictEqual(calls.length, 1);
      const call = calls[0]!;
      assert.strictEqual(call.url, URL_);
      assert.strictEqual(call.init.method, "POST");
      assert.strictEqual(call.init.redirect, "follow");
      assert.match(call.init.headers["content-type"] ?? "", /^text\/plain/);
      const body = JSON.parse(call.init.body);
      assert.deepStrictEqual(Object.keys(body).sort(), [
        "action",
        "apiKey",
        "body",
        "htmlBody",
        "subject",
        "to",
      ]);
      assert.strictEqual(body.action, "sendEmail");
      assert.strictEqual(body.apiKey, KEY);
      assert.strictEqual(body.to, "bo@example.com");
      assert.strictEqual(body.body, mail.text);
      assert.strictEqual(body.htmlBody, mail.html);
    });

    it.live("is preferred over SMTP and retries a flaky redirect", () =>
      Effect.gen(function* () {
        const { calls, fetch } = fakeFetch([
          { status: 500, body: "<html>" },
          { status: 200, body: "<html>not json" },
        ]);
        const mailer = makeMailer({
          smtpUrl: `smtp://resend:secret@127.0.0.1:${port}`,
          from: "",
          appsScriptUrl: URL_,
          appsScriptKey: KEY,
          fetch,
          retrySpacing: "1 millis",
        });
        assert.strictEqual(mailer.mode, "apps-script");
        const before = transcripts.length;
        const result = yield* mailer.send(mail);
        assert.deepStrictEqual(result, { delivered: true, via: "apps-script" });
        assert.strictEqual(calls.length, 3);
        assert.strictEqual(transcripts.length, before, "SMTP was used too");
      }),
    );

    it.live("reports a refusal without retrying and never leaks the URL or key", () =>
      Effect.gen(function* () {
        const { calls, fetch } = fakeFetch([
          {
            status: 200,
            body: JSON.stringify({ ok: false, error: `bad apiKey ${KEY} for ${URL_}` }),
          },
        ]);
        const mailer = makeMailer({
          smtpUrl: "",
          from: "",
          appsScriptUrl: URL_,
          appsScriptKey: KEY,
          fetch,
          retrySpacing: "1 millis",
        });
        const result = yield* mailer.send(mail);
        assert.strictEqual(result.delivered, false);
        assert.strictEqual(calls.length, 1);
        if (result.delivered) return;
        assert.strictEqual(result.via, "apps-script");
        assert.notInclude(result.reason, KEY);
        assert.notInclude(result.reason, URL_);
        const down = fakeFetch([
          new Error(`connect ECONNREFUSED ${URL_}`),
          new Error("x"),
          new Error("y"),
        ]);
        const offline = makeMailer({
          smtpUrl: "",
          from: "",
          appsScriptUrl: URL_,
          appsScriptKey: KEY,
          fetch: down.fetch,
          retrySpacing: "1 millis",
        });
        const gone = yield* offline.send(mail);
        assert.strictEqual(gone.delivered, false);
        assert.strictEqual(down.calls.length, 3);
        if (!gone.delivered) assert.notInclude(gone.reason, URL_);
      }),
    );

    it.effect("is ignored without both a URL and a key", () =>
      Effect.sync(() => {
        assert.strictEqual(makeMailer({ smtpUrl: "", from: "", appsScriptUrl: URL_ }).mode, "log");
        assert.strictEqual(makeMailer({ smtpUrl: "", from: "", appsScriptKey: KEY }).mode, "log");
      }),
    );
  });
});
