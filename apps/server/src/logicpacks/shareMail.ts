import * as NodeNet from "node:net";
import * as NodeTls from "node:tls";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Message-ID needs a random part.
import * as NodeCrypto from "node:crypto";

import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Schedule from "effect/Schedule";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/**
 * Share invite mail: one short email per invite. Transport: the Google Apps Script mail API
 * (LOGICPACKS_MAIL_APPS_SCRIPT_URL + _KEY) first, else LOGICPACKS_SMTP_URL, else only logged;
 * the Share dialog's copyable link always works.
 */
export interface OutgoingMail {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

export type MailTransport = "apps-script" | "smtp" | "log";

export type MailResult =
  | { readonly delivered: true; readonly via: "apps-script" | "smtp" }
  | { readonly delivered: false; readonly via: MailTransport; readonly reason: string };

export class ShareMailer extends Context.Service<
  ShareMailer,
  {
    /** Apps Script when configured, else SMTP when configured, else "log". */
    readonly mode: MailTransport;
    /** Never fails: a mail that cannot go out is logged and reported as not delivered. */
    readonly send: (mail: OutgoingMail) => Effect.Effect<MailResult>;
  }
>()("logicpacks/logicpacks/shareMail/ShareMailer") {}

const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

/** The invite email. Short and plain, no em-dashes. */
export const shareInviteMail = (input: {
  readonly to: string;
  readonly inviterName: string;
  readonly projectTitle: string;
  readonly link: string;
}): OutgoingMail => {
  const subject = `${input.inviterName} shared ${input.projectTitle} with you on LogicPacks`;
  const about =
    "LogicPacks is a shared workspace where people and their AI coding agents build projects together.";
  const text = [
    `${input.inviterName} shared ${input.projectTitle} with you on LogicPacks.`,
    "",
    `Open the project: ${input.link}`,
    "",
    about,
    "",
    "If you did not expect this, you can ignore this email.",
  ].join("\n");
  const html = `<!doctype html>
<html><body style="margin:0;padding:32px 16px;background:#f4f4f5;font-family:Inter,-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#18181b">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border:1px solid #e4e4e7;border-radius:16px">
<tr><td style="padding:32px">
<p style="margin:0 0 20px;font-size:14px;font-weight:600">LogicPacks</p>
<h1 style="margin:0 0 24px;font-size:22px;font-weight:400;letter-spacing:-0.02em;line-height:1.3">${escapeHtml(input.inviterName)} shared <strong style="font-weight:600">${escapeHtml(input.projectTitle)}</strong> with you</h1>
<a href="${escapeHtml(input.link)}" style="display:inline-block;background:#18181b;color:#ffffff;text-decoration:none;font-size:14px;font-weight:500;padding:10px 20px;border-radius:9999px">Open the project</a>
<p style="margin:24px 0 0;font-size:13px;line-height:1.5;color:#52525b">${escapeHtml(about)}</p>
<p style="margin:16px 0 0;font-size:12px;line-height:1.5;color:#a1a1aa">Or paste this link into your browser: ${escapeHtml(input.link)}</p>
</td></tr></table>
</td></tr></table>
</body></html>`;
  return { to: input.to, subject, text, html };
};

// ── SMTP ────────────────────────────────────────────────────────────────────

export interface SmtpTarget {
  readonly host: string;
  readonly port: number;
  /** smtps: TLS from the first byte (465). smtp: plain, upgraded with STARTTLS when offered. */
  readonly secure: boolean;
  readonly user: string | null;
  readonly password: string | null;
}

/** `smtp://user:pass@host:587` or `smtps://user:pass@host:465`. Null when it does not parse. */
export const parseSmtpUrl = (raw: string): SmtpTarget | null => {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "smtp:" && url.protocol !== "smtps:") return null;
  if (url.hostname.length === 0) return null;
  const secure = url.protocol === "smtps:";
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : secure ? 465 : 587,
    secure,
    user: url.username ? decodeURIComponent(url.username) : null,
    password: url.password ? decodeURIComponent(url.password) : null,
  };
};

/** The bare address in `Name <a@b>` or `a@b`. */
export const mailAddress = (from: string) => /<([^>]+)>/.exec(from)?.[1]?.trim() ?? from.trim();

const encodeHeader = (value: string) =>
  /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value).toString("base64")}?=`;

const base64Lines = (value: string) =>
  (
    Buffer.from(value)
      .toString("base64")
      .match(/.{1,76}/g) ?? []
  ).join("\r\n");

/** The RFC 5322 message: multipart/alternative, plain text and HTML, base64 bodies. */
export const buildMimeMessage = (from: string, mail: OutgoingMail, dateHeader: string) => {
  const boundary = `lp-${NodeCrypto.randomBytes(12).toString("hex")}`;
  const domain = mailAddress(from).split("@")[1] ?? "logicpacks.io";
  return [
    `From: ${from}`,
    `To: ${mail.to}`,
    `Subject: ${encodeHeader(mail.subject)}`,
    `Date: ${dateHeader}`,
    `Message-ID: <${NodeCrypto.randomUUID()}@${domain}>`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(mail.text),
    `--${boundary}`,
    "Content-Type: text/html; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(mail.html),
    `--${boundary}--`,
    "",
  ].join("\r\n");
};

const isLocalHost = (host: string) =>
  host === "localhost" || host === "127.0.0.1" || host === "::1";

/**
 * Sends one message over SMTP: EHLO, STARTTLS when offered, AUTH PLAIN or LOGIN, then
 * MAIL/RCPT/DATA. Credentials never go over a plain connection except to localhost.
 */
export const smtpSend = (
  target: SmtpTarget,
  from: string,
  mail: OutgoingMail,
  options: {
    readonly dateHeader: string;
    readonly timeoutMs?: number;
    readonly heloName?: string;
  },
): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    const timeoutMs = options.timeoutMs ?? 20_000;
    const helo = options.heloName ?? "logicpacks.local";
    let socket: NodeNet.Socket = target.secure
      ? NodeTls.connect({ host: target.host, port: target.port, servername: target.host })
      : NodeNet.connect({ host: target.host, port: target.port });
    let buffer = "";
    let waiting: ((reply: { code: number; lines: Array<string> }) => void) | null = null;
    let pending: Array<string> = [];
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      socket.setTimeout(0);
      socket.removeAllListeners();
      socket.on("error", () => undefined);
      socket.end();
      if (error) reject(error);
      else resolve();
    };
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let index: number;
      while ((index = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, index).replace(/\r$/, "");
        buffer = buffer.slice(index + 1);
        pending.push(line);
        // "250-..." continues, "250 ..." ends a reply.
        if (/^\d{3}(?: |$)/.test(line)) {
          const reply = { code: Number(line.slice(0, 3)), lines: pending };
          pending = [];
          const next = waiting;
          waiting = null;
          next?.(reply);
        }
      }
    };
    const attach = (next: NodeNet.Socket) => {
      next.on("data", onData);
      next.on("error", (error) => finish(error));
      next.on("close", () => finish(new Error("SMTP connection closed")));
      // An idle socket for this long means the server stopped answering.
      next.setTimeout(timeoutMs, () => finish(new Error("SMTP timed out")));
    };
    const read = () =>
      new Promise<{ code: number; lines: Array<string> }>((done) => {
        waiting = done;
      });
    const command = async (line: string, expect: ReadonlyArray<number>, shown = line) => {
      socket.write(`${line}\r\n`);
      const reply = await read();
      if (!expect.includes(reply.code)) {
        throw new Error(`SMTP ${shown.split(" ")[0]} refused: ${reply.lines.join(" | ")}`);
      }
      return reply;
    };
    attach(socket);
    void (async () => {
      const greeting = await read();
      if (greeting.code !== 220) throw new Error(`SMTP greeting: ${greeting.lines.join(" | ")}`);
      let ehlo = await command(`EHLO ${helo}`, [250]);
      let secure = target.secure;
      if (!secure && ehlo.lines.some((line) => /^250[- ]STARTTLS/i.test(line))) {
        await command("STARTTLS", [220]);
        socket.removeAllListeners("data");
        socket.removeAllListeners("close");
        socket.removeAllListeners("error");
        socket = NodeTls.connect({ socket, servername: target.host });
        attach(socket);
        await new Promise<void>((ready) => socket.once("secureConnect", () => ready()));
        secure = true;
        ehlo = await command(`EHLO ${helo}`, [250]);
      }
      if (target.user !== null) {
        if (!secure && !isLocalHost(target.host)) {
          throw new Error("SMTP server offers no TLS; refusing to send the password in clear");
        }
        const auth = ehlo.lines.find((line) => /^250[- ]AUTH/i.test(line))?.toUpperCase() ?? "";
        const password = target.password ?? "";
        if (auth.includes("PLAIN") || !auth.includes("LOGIN")) {
          const token = Buffer.from(`\u0000${target.user}\u0000${password}`).toString("base64");
          await command(`AUTH PLAIN ${token}`, [235], "AUTH PLAIN");
        } else {
          await command("AUTH LOGIN", [334]);
          await command(Buffer.from(target.user).toString("base64"), [334], "AUTH user");
          await command(Buffer.from(password).toString("base64"), [235], "AUTH password");
        }
      }
      await command(`MAIL FROM:<${mailAddress(from)}>`, [250]);
      await command(`RCPT TO:<${mailAddress(mail.to)}>`, [250, 251]);
      await command("DATA", [354]);
      const body = buildMimeMessage(from, mail, options.dateHeader)
        .split("\r\n")
        .map((line) => (line.startsWith(".") ? `.${line}` : line))
        .join("\r\n");
      await command(`${body}\r\n.`, [250], "DATA body");
      socket.write("QUIT\r\n");
      finish();
    })().catch((error: unknown) =>
      finish(error instanceof Error ? error : new Error(String(error))),
    );
  });

// ── Google Apps Script mail API ────────────────────────────────────────────

export interface AppsScriptTarget {
  readonly url: string;
  readonly key: string;
}

/** A failure worth one more try: Apps Script /exec intermittently 404/500s on its own redirect. */
export class RetryableMailError extends Error {}

type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; redirect: "follow" },
) => Promise<{ readonly ok: boolean; readonly status: number; text(): Promise<string> }>;

/**
 * One sendEmail call: POST a JSON string as text/plain (application/json makes Google answer
 * with an HTML page), follow the 302 to googleusercontent, read `{ ok, error }`. Messages never
 * carry the URL or the key.
 */
export const appsScriptSend = async (
  target: AppsScriptTarget,
  mail: OutgoingMail,
  fetchImpl: FetchLike,
): Promise<void> => {
  const scrub = (text: string) =>
    text.replaceAll(target.url, "<url>").replaceAll(target.key, "<key>").slice(0, 200);
  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetchImpl(target.url, {
      method: "POST",
      headers: { "content-type": "text/plain;charset=utf-8" },
      body: JSON.stringify({
        apiKey: target.key,
        action: "sendEmail",
        to: mail.to,
        subject: mail.subject,
        body: mail.text,
        htmlBody: mail.html,
      }),
      redirect: "follow",
    });
  } catch (error) {
    throw new RetryableMailError(scrub(`request failed: ${String(error)}`));
  }
  if (!response.ok) throw new RetryableMailError(`Apps Script answered HTTP ${response.status}`);
  const raw = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new RetryableMailError("Apps Script answered with a non-JSON page");
  }
  const result = (parsed ?? {}) as { readonly ok?: unknown; readonly error?: unknown };
  if (result.ok !== true) {
    throw new Error(scrub(`Apps Script refused: ${String(result.error ?? "no reason given")}`));
  }
};

const DEFAULT_FROM = "LogicPacks <invites@logicpacks.io>";

/** RFC 5322 date, e.g. "Sun, 01 Nov 2026 09:30:00 +0000". */
export const mailDateHeader = (now: DateTime.Utc) =>
  DateTime.toDateUtc(now).toUTCString().replace("GMT", "+0000");

export const makeMailer = (input: {
  readonly smtpUrl: string;
  readonly from: string;
  readonly appsScriptUrl?: string | undefined;
  readonly appsScriptKey?: string | undefined;
  readonly fetch?: FetchLike | undefined;
  readonly retrySpacing?: Duration.Input | undefined;
}) => {
  const target = input.smtpUrl.trim().length > 0 ? parseSmtpUrl(input.smtpUrl) : null;
  const appsUrl = input.appsScriptUrl?.trim() ?? "";
  const appsKey = input.appsScriptKey?.trim() ?? "";
  const apps: AppsScriptTarget | null =
    appsUrl.startsWith("https://") && appsKey.length > 0 ? { url: appsUrl, key: appsKey } : null;
  const fetchImpl: FetchLike =
    // @effect-diagnostics-next-line globalFetch:off -- one POST, swappable in tests; no HttpClient layer needed.
    input.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const from = input.from.trim() || DEFAULT_FROM;
  const logOnly = (mail: OutgoingMail, reason: string) =>
    Effect.logInfo("LogicPacks share invite (not emailed)", {
      to: mail.to,
      subject: mail.subject,
      reason,
      text: mail.text,
    }).pipe(Effect.as<MailResult>({ delivered: false, via: "log", reason }));
  const failed = (via: MailTransport, mail: OutgoingMail, error: Cause.UnknownError) => {
    const reason = error.cause instanceof Error ? error.cause.message : "send failed";
    return Effect.logWarning("LogicPacks could not email a share invite", {
      to: mail.to,
      via,
      error: reason,
    }).pipe(Effect.as<MailResult>({ delivered: false, via, reason }));
  };
  const viaSmtp = Effect.fn("ShareMailer.smtp")(function* (smtp: SmtpTarget, mail: OutgoingMail) {
    const dateHeader = mailDateHeader(yield* DateTime.now);
    return yield* Effect.tryPromise(() => smtpSend(smtp, from, mail, { dateHeader })).pipe(
      Effect.as<MailResult>({ delivered: true, via: "smtp" }),
      Effect.catch((error) => failed("smtp", mail, error)),
    );
  });
  const viaAppsScript = Effect.fn("ShareMailer.appsScript")(function* (
    script: AppsScriptTarget,
    mail: OutgoingMail,
  ) {
    return yield* Effect.tryPromise(() => appsScriptSend(script, mail, fetchImpl)).pipe(
      Effect.retry({
        times: 2,
        schedule: Schedule.spaced(input.retrySpacing ?? "1500 millis"),
        while: (error) => error.cause instanceof RetryableMailError,
      }),
      Effect.as<MailResult>({ delivered: true, via: "apps-script" }),
      Effect.catch((error) => failed("apps-script", mail, error)),
    );
  });
  const unparsed =
    input.smtpUrl.trim().length > 0
      ? "LOGICPACKS_SMTP_URL does not parse"
      : "no mail transport configured";
  return ShareMailer.of({
    mode: apps !== null ? "apps-script" : target !== null ? "smtp" : "log",
    send: Effect.fn("ShareMailer.send")(function* (mail) {
      if (apps !== null) return yield* viaAppsScript(apps, mail);
      return yield* target === null ? logOnly(mail, unparsed) : viaSmtp(target, mail);
    }),
  });
};

export const layer = Layer.effect(
  ShareMailer,
  Effect.gen(function* () {
    const smtpUrl = yield* Config.String("LOGICPACKS_SMTP_URL").pipe(
      Config.withDefault(""),
      Effect.orElseSucceed(() => ""),
    );
    const from = yield* Config.String("LOGICPACKS_MAIL_FROM").pipe(
      Config.withDefault(""),
      Effect.orElseSucceed(() => ""),
    );
    const appsScriptUrl = yield* Config.String("LOGICPACKS_MAIL_APPS_SCRIPT_URL").pipe(
      Config.withDefault(""),
      Effect.orElseSucceed(() => ""),
    );
    const appsScriptKey = yield* Config.String("LOGICPACKS_MAIL_APPS_SCRIPT_KEY").pipe(
      Config.withDefault(""),
      Effect.orElseSucceed(() => ""),
    );
    return makeMailer({ smtpUrl, from, appsScriptUrl, appsScriptKey });
  }),
);

/** For tests: records every mail instead of sending it. */
export const layerRecording = (sent: Array<OutgoingMail>) =>
  Layer.succeed(
    ShareMailer,
    ShareMailer.of({
      mode: "log",
      send: Effect.fn("ShareMailer.record")(function* (mail) {
        yield* Effect.sync(() => sent.push(mail));
        return { delivered: false, via: "log", reason: "test" } as MailResult;
      }),
    }),
  );
