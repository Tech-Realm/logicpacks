import type { SessionEvent, ToolCall } from "./events.ts";

/**
 * What leaves this computer when a session streams into a project. Runs on every event before
 * it is sent or queued: secrets are redacted, MCP calls are reduced to their tool name (other
 * servers' data, such as messages or client records, is not the team's), and reads of secret
 * files are not streamed at all.
 */

export interface StreamOptions {
  /** Send MCP tool inputs and results too (opted in per folder with `lp stream --mcp-details on`). */
  readonly mcpDetails: boolean;
}

export const REDACTED = "[redacted]";

const SECRET_KEY =
  /(?:pass(?:word|wd|phrase)?|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|auth|credential|session[_-]?key|signing[_-]?key|bearer)/i;

/** Token shapes that are secrets wherever they appear. */
const TOKEN_PATTERNS: ReadonlyArray<RegExp> = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
  /\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g,
  /\bnpm_[A-Za-z0-9]{30,}/g,
  /\bhf_[A-Za-z0-9]{30,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
];

/**
 * Redacts secrets in free text: known token shapes, credentials in connection strings,
 * `Authorization:` headers, and KEY=VALUE / key: value / "key": "value" pairs whose key
 * looks secret.
 */
export const redactSecrets = (text: string): string => {
  let out = text;
  for (const pattern of TOKEN_PATTERNS) out = out.replace(pattern, REDACTED);
  // scheme://user:password@host
  out = out.replace(/\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):([^\s@/]+)@/gi, `$1:${REDACTED}@`);
  out = out.replace(
    /\b(authorization\s*[:=]\s*)(?:(bearer|basic|token)\s+)?[^\s"']+/gi,
    (_, lead, scheme) => `${lead}${scheme ? `${scheme} ` : ""}${REDACTED}`,
  );
  // KEY=VALUE, KEY: VALUE, "key": "value", --password value
  out = out.replace(
    /(["']?)([A-Za-z_][A-Za-z0-9_.-]*)\1(\s*[:=]\s*)(["']?)([^\s"'`,;]+)\4/g,
    (match, quote, key: string, sep, valueQuote, value: string) =>
      SECRET_KEY.test(key) &&
      value !== REDACTED &&
      !/^(?:bearer|basic|token)$/i.test(value) &&
      !/^\$\{?[A-Za-z_]/.test(value)
        ? `${quote}${key}${quote}${sep}${valueQuote}${REDACTED}${valueQuote}`
        : match,
  );
  out = out.replace(
    /(--?(?:password|passwd|token|api-key|apikey|secret|client-secret)(?:=|\s+))([^\s"']+)/gi,
    `$1${REDACTED}`,
  );
  return out;
};

const SENSITIVE_FILE =
  /(?:^|[\\/])(?:\.env(?:\.[^\\/]*)?|[^\\/]+\.(?:pem|key|p12|pfx|keystore|jks)|id_[a-z0-9_]+(?:\.pub)?|\.netrc|\.pgpass|\.npmrc|credentials(?:\.json)?)$|(?:^|[\\/])\.ssh[\\/]|(?:^|[\\/])\.aws[\\/]credentials$/i;

/** .env*, *.pem, *.key, id_* and anything under .ssh: their content is never streamed. */
export const isSensitivePath = (path: string) => SENSITIVE_FILE.test(path.trim());

/** Claude Code names MCP tools mcp__<server>__<tool>; the Codex parser does the same. */
export const mcpToolName = (name: string): string | null => {
  const match = /^mcp__(.+?)__(.+)$/.exec(name);
  return match ? `${match[1]}.${match[2]}` : null;
};

const scrubTool = (tool: ToolCall, options: StreamOptions): ToolCall => {
  const mcp = mcpToolName(tool.name);
  if (mcp !== null && !options.mcpDetails) {
    // Only that it happened: "mcp: whatsapp.send".
    return { name: `mcp: ${mcp}`, kind: "other", input: "", status: tool.status };
  }
  const paths = [
    ...(tool.files ?? []),
    ...tool.input.split(/\s+/).map((word) => word.replace(/^["']|["']$/g, "")),
  ];
  if (paths.some(isSensitivePath)) {
    const { output: _output, ...rest } = tool;
    return {
      ...rest,
      name: mcp === null ? tool.name : `mcp: ${mcp}`,
      input: `${tool.input.split(/\s/)[0] ?? ""} (secret file, content not shared)`.trim(),
    };
  }
  return {
    ...tool,
    name: mcp === null ? tool.name : `mcp: ${mcp}`,
    input: redactSecrets(tool.input),
    ...(tool.output === undefined ? {} : { output: redactSecrets(tool.output) }),
  };
};

/** The event as it may leave this computer. */
export const scrubEvent = (event: SessionEvent, options: StreamOptions): SessionEvent => {
  if (event.tool !== undefined) return { ...event, tool: scrubTool(event.tool, options) };
  if (event.text !== undefined) return { ...event, text: redactSecrets(event.text) };
  return event;
};
