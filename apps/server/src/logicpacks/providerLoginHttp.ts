// @effect-diagnostics nodeBuiltinImport:off -- a PATH lookup for the install hint.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerSettings as ServerSettingsData,
  type ServerSettingsError,
} from "@logicpacks/contracts";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpRouter } from "effect/http";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { cloudAgentsAllowed, cloudLoginGate } from "./cloudAgents.ts";
import { FeatureAccess } from "./FeatureAccess.ts";
import { json, queryParam, readBody, resolveCaller } from "./http.ts";
import { LogicPacksAccess } from "./LogicPacksAccess.ts";
import { forgetProviderLogin } from "./loginVault.ts";
import {
  findClaudeToken,
  geminiCredsPath,
  isCodexHomeConnected,
  isLoginHomeConnected,
  isMemberLoginProvider,
  memberProviderHome,
  MemberLogins,
  openCodeAuthPath,
  publicRun,
  readableOutput,
} from "./memberLogin.ts";
import {
  isMemberProviderKind,
  MEMBER_PROVIDER_KINDS,
  memberInstanceId,
  type MemberProviderKind,
} from "./memberProviders.ts";

/**
 * Connecting a member's own Claude, Codex, OpenCode or Gemini CLI as a per-member provider
 * instance (`<kind>-lp-<hash>`): a browser login, OpenCode's free models, or an API key.
 * A CLI missing on the host gets an install hint, never a fake login.
 */

export type MemberProviderMethod = "browser" | "token" | "api-key" | "free";

export const PROVIDER_INFO: Record<
  MemberProviderKind,
  {
    readonly label: string;
    readonly binary: string;
    readonly install: string;
    readonly driver: string;
    readonly methods: ReadonlyArray<MemberProviderMethod>;
  }
> = {
  claude: {
    label: "Claude",
    binary: "claude",
    install: "npm install -g @anthropic-ai/claude-code",
    driver: "claudeAgent",
    methods: ["browser", "token"],
  },
  codex: {
    label: "Codex",
    binary: "codex",
    install: "npm install -g @openai/codex",
    driver: "codex",
    methods: ["browser", "api-key"],
  },
  opencode: {
    label: "OpenCode",
    binary: "opencode",
    install: "npm install -g opencode-ai",
    driver: "opencode",
    methods: ["free", "browser", "api-key"],
  },
  gemini: {
    label: "Gemini CLI",
    binary: "gemini",
    install: "npm install -g @google/gemini-cli",
    driver: "acpRegistry",
    methods: ["browser", "api-key"],
  },
};

/** A command on the host's PATH, or null. */
export const findOnPath = (command: string, pathEnv = process.env.PATH ?? ""): string | null => {
  if (command.includes("/")) {
    try {
      NodeFS.accessSync(command, NodeFS.constants.X_OK);
      return command;
    } catch {
      return null;
    }
  }
  for (const dir of pathEnv.split(NodePath.delimiter)) {
    if (dir.length === 0) continue;
    const candidate = NodePath.join(dir, command);
    try {
      NodeFS.accessSync(candidate, NodeFS.constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
};

const memberClaudeBinary = Config.String("LOGICPACKS_MEMBER_CLAUDE_BINARY").pipe(
  Config.withDefault(""),
);
/** Pins the Codex CLI members log in with, as LOGICPACKS_MEMBER_CLAUDE_BINARY does for Claude. */
const memberCodexBinary = Config.String("LOGICPACKS_MEMBER_CODEX_BINARY").pipe(
  Config.withDefault(""),
);
const memberGeminiBinary = Config.String("LOGICPACKS_MEMBER_GEMINI_BINARY").pipe(
  Config.withDefault(""),
);
const memberOpenCodeBinary = Config.String("LOGICPACKS_MEMBER_OPENCODE_BINARY").pipe(
  Config.withDefault(""),
);
const PINNED_BINARY: Record<MemberProviderKind, Config.Config<string>> = {
  claude: memberClaudeBinary,
  codex: memberCodexBinary,
  gemini: memberGeminiBinary,
  opencode: memberOpenCodeBinary,
};

const binaryFor = Effect.fn("logicpacks.providers.binaryFor")(function* (kind: MemberProviderKind) {
  const pinned = (yield* PINNED_BINARY[kind].pipe(Effect.orElseSucceed(() => ""))).trim();
  return pinned.length > 0 ? pinned : PROVIDER_INFO[kind].binary;
});

export interface MemberProviderStatus {
  readonly kind: MemberProviderKind;
  readonly label: string;
  readonly instanceId: string;
  readonly connected: boolean;
  readonly installed: boolean;
  readonly installHint: string;
  readonly methods: ReadonlyArray<MemberProviderMethod>;
  /** Another member's login this member may use through a grant, in some project. */
  readonly granted?: boolean;
}

/** The four agents for one member: connected, installed, how to connect. */
export const memberProviderStatuses = Effect.fn("logicpacks.providers.statuses")(function* (
  userId: string,
  settings: ServerSettingsData,
) {
  const config = yield* ServerConfig.ServerConfig;
  const statuses: Array<MemberProviderStatus> = [];
  for (const kind of MEMBER_PROVIDER_KINDS) {
    const instanceId = memberInstanceId(kind, userId);
    const hasInstance = Object.hasOwn(settings.providerInstances ?? {}, instanceId);
    const connected =
      kind === "codex"
        ? hasInstance && isCodexHomeConnected(memberProviderHome(config.stateDir, userId, "codex"))
        : hasInstance;
    statuses.push({
      kind,
      label: PROVIDER_INFO[kind].label,
      instanceId,
      connected,
      installed: findOnPath(yield* binaryFor(kind)) !== null,
      installHint: PROVIDER_INFO[kind].install,
      methods: PROVIDER_INFO[kind].methods,
    });
  }
  return statuses;
});

/** The host's own logins, for the operator's picker: any enabled instance of the driver. */
export const hostProviderStatuses = Effect.fn("logicpacks.providers.hostStatuses")(function* (
  settings: ServerSettingsData,
) {
  const instances = Object.entries(settings.providerInstances ?? {});
  const statuses: Array<MemberProviderStatus> = [];
  for (const kind of MEMBER_PROVIDER_KINDS) {
    const driver = PROVIDER_INFO[kind].driver;
    const found = instances.find(
      ([, instance]) =>
        instance.driver === driver &&
        (kind !== "gemini" || JSON.stringify(instance.config ?? {}).includes("gemini")),
    );
    statuses.push({
      kind,
      label: PROVIDER_INFO[kind].label,
      instanceId: found?.[0] ?? kind,
      connected: found !== undefined,
      installed: findOnPath(yield* binaryFor(kind)) !== null,
      installHint: PROVIDER_INFO[kind].install,
      methods: [],
    });
  }
  return statuses;
});

const settingsError = (error: ServerSettingsError) =>
  Effect.succeed(json({ error: "settings", message: error.message }, 500));

/** Writes (or replaces) the member's instance for `kind`. */
export const upsertMemberInstance = Effect.fn("logicpacks.providers.upsertMemberInstance")(
  function* (input: {
    readonly userId: string;
    readonly displayName: string;
    readonly kind: MemberProviderKind;
    readonly secret?: { readonly name: string; readonly value: string } | undefined;
    /** Gemini: signed in with Google (cached OAuth) rather than an API key. */
    readonly method?: "browser" | "api-key" | "free" | undefined;
  }) {
    const config = yield* ServerConfig.ServerConfig;
    const settings = yield* ServerSettings.ServerSettingsService;
    const home = memberProviderHome(config.stateDir, input.userId, input.kind);
    const binary = yield* binaryFor(input.kind);
    const environment =
      input.secret === undefined
        ? []
        : [{ name: input.secret.name, value: input.secret.value, sensitive: true }];
    // Every driver's own `enabled` is set: OpenCode's defaults to off, and a member's
    // OpenCode instance came up disabled ("No provider available" in the composer).
    const driverConfig: Record<string, unknown> =
      input.kind === "claude"
        ? { homePath: home, ...(binary === "claude" ? {} : { binaryPath: binary }) }
        : input.kind === "codex"
          ? { homePath: home }
          : input.kind === "opencode"
            ? binary === "opencode"
              ? {}
              : { binaryPath: binary }
            : {
                source: "local",
                commandPath: findOnPath(binary) ?? binary,
                // `--experimental-acp` is deprecated since Gemini CLI 0.5x.
                commandArgs: ["--acp"],
                // Named rather than guessed: Gemini lists Google login first, and with no
                // cached Google credentials it waits for a browser that never comes.
                authMethodId: input.method === "browser" ? "oauth-personal" : "gemini-api-key",
              };
    const instanceConfig = { ...driverConfig, enabled: true };
    // OpenCode and Gemini keep their own state under XDG/HOME; point those at the member's.
    const extraEnv =
      input.kind === "opencode"
        ? [{ name: "XDG_DATA_HOME", value: home, sensitive: false }]
        : input.kind === "gemini"
          ? [{ name: "GEMINI_CLI_HOME", value: home, sensitive: false }]
          : [];
    yield* settings.updateProviderInstance({
      operation: "upsert",
      instanceId: ProviderInstanceId.make(memberInstanceId(input.kind, input.userId)),
      instance: {
        driver: ProviderDriverKind.make(PROVIDER_INFO[input.kind].driver),
        displayName: `${PROVIDER_INFO[input.kind].label} (${input.displayName})`,
        enabled: true,
        environment: [...environment, ...extraEnv],
        config: instanceConfig,
      },
    } as Parameters<typeof settings.updateProviderInstance>[0]);
  },
);

let logins: MemberLogins | null = null;
const loginsFor = Effect.fn("logicpacks.providers.logins")(function* () {
  if (logins !== null) return logins;
  const config = yield* ServerConfig.ServerConfig;
  logins = new MemberLogins(config.stateDir, undefined, {
    claude: yield* binaryFor("claude"),
    codex: yield* binaryFor("codex"),
    gemini: yield* binaryFor("gemini"),
    opencode: yield* binaryFor("opencode"),
  });
  return logins;
});

const memberCaller = Effect.gen(function* () {
  const caller = yield* resolveCaller;
  if (caller.kind !== "member") return null;
  const access = yield* LogicPacksAccess;
  const user = yield* access.getUser(caller.userId).pipe(Effect.orElseSucceed(() => null));
  return user;
});

const membersOnly = json({ error: "members_only", message: "Sign in to connect your agent." }, 403);

const ProviderBody = Schema.Struct({ provider: Schema.String });
const StartBody = Schema.Struct({
  provider: Schema.String,
  /** OpenCode: sign in with GitHub Copilot (default) or ChatGPT. */
  via: Schema.optionalKey(Schema.Literals(["copilot", "chatgpt"])),
});
const CodeBody = Schema.Struct({
  provider: Schema.String,
  code: Schema.String,
  loginId: Schema.optionalKey(Schema.String),
});
const KeyBody = Schema.Struct({
  provider: Schema.String,
  key: Schema.String,
  /** OpenCode: which model provider the key is for. */
  keyProvider: Schema.optionalKey(Schema.Literals(["anthropic", "openai", "openrouter"])),
});

/** All four agents with their status, for the picker and onboarding. */
const statusRoute = HttpRouter.add(
  "GET",
  "/api/lp/providers/status",
  Effect.gen(function* () {
    const caller = yield* resolveCaller;
    if (caller.kind === "anonymous") return json({ error: "unauthenticated" }, 401);
    const settings = yield* ServerSettings.ServerSettingsService;
    const current = yield* settings.getSettings;
    if (caller.kind === "operator") {
      const features = yield* FeatureAccess;
      return json({
        scope: "host",
        cloudAgents: features.isCloudHost,
        providers: yield* hostProviderStatuses(current),
      });
    }
    const access = yield* LogicPacksAccess;
    const user = yield* access.getUser(caller.userId).pipe(Effect.orElseSucceed(() => null));
    return json({
      scope: "member",
      cloudAgents: user === null ? false : yield* cloudAgentsAllowed(user),
      providers: yield* memberProviderStatuses(caller.userId, current),
    });
  }).pipe(Effect.catchTags({ ServerSettingsError: settingsError })),
);

/** Starts a browser login: the link (and Codex's device code) come back once printed. */
const startRoute = HttpRouter.add(
  "POST",
  "/api/lp/providers/login/start",
  Effect.gen(function* () {
    const user = yield* memberCaller;
    if (user === null) return membersOnly;
    const body = yield* readBody(StartBody);
    if (body === null || !isMemberLoginProvider(body.provider)) {
      return json(
        { error: "bad_request", message: "Log in with Claude, Codex, OpenCode or Gemini CLI." },
        400,
      );
    }
    const locked = yield* cloudLoginGate(user, body.provider);
    if (locked !== null) return locked;
    const binary = yield* binaryFor(body.provider);
    if (findOnPath(binary) === null) {
      return json(
        {
          error: "not_installed",
          message: `${PROVIDER_INFO[body.provider].label} is not installed on this host.`,
          installHint: PROVIDER_INFO[body.provider].install,
        },
        409,
      );
    }
    const manager = yield* loginsFor();
    const run = manager.start(
      user.userId,
      body.provider,
      body.via === undefined ? {} : { via: body.via },
    );
    yield* Effect.promise(() => manager.waitForPrompt(run));
    return json(publicRun(run));
  }),
);

/** Where a login stands. Device logins finish on their own once the person approves the code. */
const loginStatusRoute = HttpRouter.add(
  "GET",
  "/api/lp/providers/login/status",
  Effect.gen(function* () {
    const user = yield* memberCaller;
    if (user === null) return membersOnly;
    const provider = yield* queryParam("provider");
    if (!isMemberLoginProvider(provider)) return json({ error: "bad_request" }, 400);
    const manager = yield* loginsFor();
    const run = manager.current(user.userId, provider);
    if (run === undefined) return json({ running: false, connected: false });
    // The CLI wrote its credential into the member's home: that is the connection.
    // (Codex's auth.json, OpenCode's auth.json, Gemini's cached Google credentials.)
    let connected = false;
    if (provider !== "claude" && isLoginHomeConnected(provider, run.home)) {
      yield* upsertMemberInstance({
        userId: user.userId,
        displayName: user.displayName,
        kind: provider,
        method: "browser",
      });
      connected = true;
      // Gemini's interactive session stays open after signing in; it has done its job.
      if (!run.done) manager.cancel(user.userId, provider);
    }
    return json({ running: !run.done, connected, ...publicRun(run) });
  }).pipe(Effect.catchTags({ ServerSettingsError: settingsError })),
);

/**
 * Claude's and Google's sign-in pages hand back a code; it is typed into the waiting CLI
 * (`claude setup-token`, or Gemini CLI's "Enter the authorization code").
 */
const codeRoute = HttpRouter.add(
  "POST",
  "/api/lp/providers/login/code",
  Effect.gen(function* () {
    const user = yield* memberCaller;
    if (user === null) return membersOnly;
    const body = yield* readBody(CodeBody);
    if (
      body === null ||
      (body.provider !== "claude" && body.provider !== "gemini") ||
      body.code.trim().length === 0
    ) {
      return json(
        { error: "bad_request", message: "Paste the code the sign-in page showed you." },
        400,
      );
    }
    const locked = yield* cloudLoginGate(user, body.provider);
    if (locked !== null) return locked;
    const provider = body.provider;
    const manager = yield* loginsFor();
    const run = manager.current(user.userId, provider);
    if (run === undefined || run.done) {
      return json({ error: "no_login", message: "Start the login again." }, 409);
    }
    // A code typed against a login that has since been replaced would land in the wrong one.
    if (body.loginId !== undefined && body.loginId !== run.loginId) {
      return json(
        { error: "replaced", message: "This login was restarted. Use the new link." },
        409,
      );
    }
    const before = run.output;
    yield* Effect.promise(() => manager.typeCode(run, body.code.trim()));
    if (provider === "gemini") {
      const connected = yield* Effect.promise(() => manager.waitForConnected(run));
      if (connected) {
        yield* upsertMemberInstance({
          userId: user.userId,
          displayName: user.displayName,
          kind: "gemini",
          method: "browser",
        });
        manager.cancel(user.userId, "gemini");
      }
      const fresh = readableOutput(run.output.slice(before.length));
      return json({
        connected,
        accepted: connected,
        failed: !connected && /(fail|error|invalid)/i.test(fresh),
        output: fresh.slice(-1_500),
      });
    }
    const settled = yield* Effect.promise(() => manager.waitForAnswer(run, before));
    const token = findClaudeToken(run.output);
    if (token !== null) {
      yield* upsertMemberInstance({
        userId: user.userId,
        displayName: user.displayName,
        kind: "claude",
        secret: { name: "CLAUDE_CODE_OAUTH_TOKEN", value: token },
      });
      manager.cancel(user.userId, "claude");
    }
    return json({
      connected: token !== null,
      accepted: settled === "accepted",
      failed: settled === "failed" && token === null,
      // Whether a credential was obtained, never the credential.
      output: readableOutput(run.output).slice(-1_500),
    });
  }).pipe(Effect.catchTags({ ServerSettingsError: settingsError })),
);

const cancelRoute = HttpRouter.add(
  "POST",
  "/api/lp/providers/login/cancel",
  Effect.gen(function* () {
    const user = yield* memberCaller;
    if (user === null) return membersOnly;
    const body = yield* readBody(ProviderBody);
    if (body === null || !isMemberLoginProvider(body.provider))
      return json({ error: "bad_request" }, 400);
    const manager = yield* loginsFor();
    return json({ cancelled: manager.cancel(user.userId, body.provider) });
  }),
);

const KEY_ENV: Record<string, string> = {
  codex: "OPENAI_API_KEY",
  gemini: "GEMINI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

/**
 * OpenCode with no login: its free models (OpenCode Zen's `opencode/*-free` and Big Pickle)
 * need no account. The member still gets their own instance and home.
 */
const freeRoute = HttpRouter.add(
  "POST",
  "/api/lp/providers/free",
  Effect.gen(function* () {
    const user = yield* memberCaller;
    if (user === null) return membersOnly;
    const body = yield* readBody(ProviderBody);
    if (body === null || body.provider !== "opencode") {
      return json({ error: "bad_request", message: "Only OpenCode has free models." }, 400);
    }
    const locked = yield* cloudLoginGate(user, "opencode");
    if (locked !== null) return locked;
    const binary = yield* binaryFor("opencode");
    if (findOnPath(binary) === null) {
      return json(
        {
          error: "not_installed",
          message: `${PROVIDER_INFO.opencode.label} is not installed on this host.`,
          installHint: PROVIDER_INFO.opencode.install,
        },
        409,
      );
    }
    yield* upsertMemberInstance({
      userId: user.userId,
      displayName: user.displayName,
      kind: "opencode",
      method: "free",
    });
    return json({ connected: true, instanceId: memberInstanceId("opencode", user.userId) });
  }).pipe(Effect.catchTags({ ServerSettingsError: settingsError })),
);

/** OpenCode, Gemini (and Codex, optionally) connect with an API key the member pastes. */
const keyRoute = HttpRouter.add(
  "POST",
  "/api/lp/providers/key",
  Effect.gen(function* () {
    const user = yield* memberCaller;
    if (user === null) return membersOnly;
    const body = yield* readBody(KeyBody);
    if (body === null || !isMemberProviderKind(body.provider) || body.provider === "claude") {
      return json({ error: "bad_request" }, 400);
    }
    const locked = yield* cloudLoginGate(user, body.provider);
    if (locked !== null) return locked;
    const key = body.key.trim();
    if (key.length < 16 || /\s/.test(key)) {
      return json({ error: "bad_request", message: "That does not look like an API key." }, 400);
    }
    const binary = yield* binaryFor(body.provider);
    if (findOnPath(binary) === null) {
      return json(
        {
          error: "not_installed",
          message: `${PROVIDER_INFO[body.provider].label} is not installed on this host.`,
          installHint: PROVIDER_INFO[body.provider].install,
        },
        409,
      );
    }
    const envName =
      body.provider === "opencode"
        ? KEY_ENV[body.keyProvider ?? "anthropic"]!
        : KEY_ENV[body.provider]!;
    yield* upsertMemberInstance({
      userId: user.userId,
      displayName: user.displayName,
      kind: body.provider,
      secret: { name: envName, value: key },
      method: "api-key",
    });
    return json({ connected: true, instanceId: memberInstanceId(body.provider, user.userId) });
  }).pipe(Effect.catchTags({ ServerSettingsError: settingsError })),
);

const removeRoute = HttpRouter.add(
  "POST",
  "/api/lp/providers/remove",
  Effect.gen(function* () {
    const user = yield* memberCaller;
    if (user === null) return membersOnly;
    const body = yield* readBody(ProviderBody);
    if (body === null || !isMemberProviderKind(body.provider))
      return json({ error: "bad_request" }, 400);
    const settings = yield* ServerSettings.ServerSettingsService;
    yield* settings.updateProviderInstance({
      operation: "remove",
      instanceId: ProviderInstanceId.make(memberInstanceId(body.provider, user.userId)),
    });
    // Disconnecting forgets the login too, not just the instance that points at it.
    const config = yield* ServerConfig.ServerConfig;
    const home = memberProviderHome(config.stateDir, user.userId, body.provider);
    // Shreds the sealed login and any plaintext copy (Claude's token goes with its instance's
    // secret, which the secret store shreds on remove).
    forgetProviderLogin(home);
    return json({ connected: false });
  }).pipe(Effect.catchTags({ ServerSettingsError: settingsError })),
);

export const layer = Layer.mergeAll(
  statusRoute,
  startRoute,
  loginStatusRoute,
  codeRoute,
  cancelRoute,
  freeRoute,
  keyRoute,
  removeRoute,
);
