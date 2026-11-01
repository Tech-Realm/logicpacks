// oxlint-disable logicpacks/no-global-process-runtime -- plain Node CLI shipped as one file; there is no Effect runtime to inject.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";

import { callHost, gitInfo, RejectedError } from "./client.ts";
import { agentsHelp, DEFAULT_HOST, globalBlockBody, setupPrompt } from "./connectText.ts";
import {
  beginFileSession,
  describeBackups,
  describeSession,
  endFileSession,
  unifiedDiff,
} from "./fileOps.ts";
import { findHarness, HARNESSES } from "./harnesses.ts";
import { formatAgents, formatInbox, type AgentEntry, type InboxItem } from "./inbox.ts";
import { outcomeLine, runSetup } from "./setup.ts";
import { discoverLocalHost, isLocalOrigin, OPEN_THE_APP, readLocalKey } from "./localHost.ts";
import { type HelperConfig, loadConfig, saveConfig } from "./store.ts";

/**
 * The agent-facing commands of `lp`: plain shell commands that print readable text, or
 * JSON with --json, so an agent in any harness can share a project, invite people, talk
 * to other agents and read its inbox without the LogicPacks app.
 */

// ── Arguments ──

export interface ParsedArgs {
  readonly command: string;
  readonly positionals: ReadonlyArray<string>;
  readonly flags: ReadonlyMap<string, string | true>;
}

/** Flags that never take a value, so `--json foo` keeps `foo` as a positional. */
const BOOLEAN_FLAGS = new Set([
  "json",
  "dry-run",
  "yes",
  "project-only",
  "off",
  "follow",
  "all",
  "workspace",
  "installed",
  "no-open",
  "cloud",
  "no-mcp",
  "list",
  "once",
  "verbose",
  "start",
  "finish",
  "insist",
  "no-push",
  "help",
]);

export const parseArgs = (argv: ReadonlyArray<string>): ParsedArgs => {
  const positionals: Array<string> = [];
  const flags = new Map<string, string | true>();
  let command: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (arg.startsWith("--") && arg.length > 2) {
      const eq = arg.indexOf("=");
      if (eq > 0) {
        flags.set(arg.slice(2, eq), arg.slice(eq + 1));
        continue;
      }
      const name = arg.slice(2);
      const next = argv[index + 1];
      if (!BOOLEAN_FLAGS.has(name) && next !== undefined && !next.startsWith("--")) {
        flags.set(name, next);
        index += 1;
      } else {
        flags.set(name, true);
      }
      continue;
    }
    if (command === null) command = arg;
    else positionals.push(arg);
  }
  return { command: command ?? "help", positionals, flags };
};

export const flagValue = (args: ParsedArgs, name: string): string | null => {
  const value = args.flags.get(name);
  return typeof value === "string" ? value : null;
};

export const hasFlag = (args: ParsedArgs, name: string) => args.flags.has(name);

// ── Context ──

export interface Output {
  readonly text: string;
  readonly json: unknown;
  /** Non-zero for a refusal the agent should read. */
  readonly exitCode?: number;
}

export interface Context {
  readonly cwd: string;
  /** The home folder paths resolve against; the user's own when absent. */
  readonly home?: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly loadConfig: () => HelperConfig;
  readonly saveConfig: (config: HelperConfig) => void;
  readonly call: <A>(
    config: Pick<HelperConfig, "server" | "token">,
    path: string,
    options?: { readonly body?: unknown; readonly timeoutMs?: number; readonly auth?: boolean },
  ) => Promise<A>;
  readonly run: (command: string, args: ReadonlyArray<string>, cwd: string) => RunResult;
  readonly print: (line: string) => void;
  readonly sleep: (ms: number) => Promise<void>;
}

export interface RunResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

export const defaultContext = (): Context => ({
  cwd: process.cwd(),
  env: process.env,
  loadConfig,
  saveConfig,
  call: callHost,
  run: (command, args, cwd) => {
    const result = NodeChildProcess.spawnSync(command, [...args], {
      cwd,
      encoding: "utf8",
      timeout: 120_000,
      // git and gh are real executables on every OS (git.exe, gh.exe), so no shell is needed
      // and paths with spaces pass through as single arguments.
      windowsHide: true,
    });
    return {
      ok: result.status === 0,
      stdout: (result.stdout ?? "").trim(),
      stderr: (result.stderr ?? result.error?.message ?? "").trim(),
    };
  },
  print: (line) => process.stdout.write(`${line}\n`),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
});

const refuse = (text: string, json: Record<string, unknown> = {}): Output => ({
  text,
  json: { ok: false, error: text, ...json },
  exitCode: 1,
});

const signedIn = (ctx: Context) => {
  const config = ctx.loadConfig();
  if (!config.server || !config.token) {
    throw new RejectedError(
      401,
      `LogicPacks is not connected on this computer. Run lp login (lp login --host <url> for your team's host). ${OPEN_THE_APP}`,
    );
  }
  return config;
};

const location = (ctx: Context) => {
  const git = gitInfo(ctx.cwd);
  return { cwd: ctx.cwd, gitRoot: git.root, gitRemote: git.remote, branch: git.branch };
};

/** The harness this `lp` runs under: --harness, LP_HARNESS, the environment, or what lp setup chose. */
export const detectHarness = (
  env: Readonly<Record<string, string | undefined>>,
  config: HelperConfig,
  given: string | null = null,
): string => {
  const named = given ?? env.LP_HARNESS ?? null;
  if (named) return findHarness(named)?.name ?? named;
  if (env.CLAUDECODE === "1" || env.CLAUDE_CODE_ENTRYPOINT) return "Claude Code";
  if (env.CODEX_SANDBOX || env.CODEX_THREAD_ID || env.CODEX_MANAGED_BY_NPM) return "Codex CLI";
  if (env.GEMINI_CLI === "1") return "Gemini CLI";
  if (env.OPENCODE === "1") return "OpenCode";
  if (env.CURSOR_TRACE_ID || env.CURSOR_AGENT) return "Cursor";
  if (env.TERM_PROGRAM === "vscode") return "VS Code";
  return config.harness ?? "Terminal";
};

const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 24) || "agent";

/** One agent session per harness, device and folder, so its thread stays the same across runs. */
export const agentSessionId = (harness: string, device: string | null, root: string) =>
  `${slug(harness)}-${NodeCrypto.createHash("sha1")
    .update(`${device ?? ""}\0${root}`)
    .digest("hex")
    .slice(0, 12)}`;

interface Registration {
  readonly projectId: string;
  readonly projectTitle: string;
  readonly workspaceId: string | null;
  readonly threadId: string;
  readonly harness: string;
}

/** This folder's project and this agent's own thread in it. */
const register = async (ctx: Context, args: ParsedArgs, task: string | null = null) => {
  const config = signedIn(ctx);
  const where = location(ctx);
  const harness = detectHarness(ctx.env, config, flagValue(args, "harness"));
  try {
    return await ctx.call<Registration>(config, "/api/lp/connect/register", {
      body: {
        cwd: where.cwd,
        gitRoot: where.gitRoot,
        gitRemote: where.gitRemote,
        branch: where.branch,
        device: config.device,
        harness,
        sessionId: agentSessionId(harness, config.device, where.gitRoot ?? where.cwd),
        ...(task ? { task } : {}),
      },
      timeoutMs: 15_000,
    });
  } catch (error) {
    if (error instanceof RejectedError && error.status === 404) {
      throw new RejectedError(
        404,
        `${error.message}\nThis folder is not shared on LogicPacks yet. Run lp share to share it.`,
      );
    }
    throw error;
  }
};

const output = (text: string, json: unknown): Output => ({ text, json });

// ── Commands ──

/** Pair with the app server on this machine using its key file. Null when no app is running. */
const loginLocal = async (ctx: Context, config: HelperConfig): Promise<Output | null> => {
  const host = discoverLocalHost(ctx.env, ctx.home);
  if (host === null) return null;
  try {
    await ctx.call({ server: host.origin, token: null }, "/api/lp/helper/pair/local", {
      auth: false,
      timeoutMs: 4000,
    });
    const key = readLocalKey(host);
    if (key === null) return null;
    const paired = await ctx.call<{ token: string; who: string }>(
      { server: host.origin, token: null },
      "/api/lp/helper/pair/local",
      { body: { key, device: config.device }, auth: false, timeoutMs: 8000 },
    );
    ctx.saveConfig({
      ...ctx.loadConfig(),
      server: host.origin,
      token: paired.token,
      who: paired.who,
      pending: null,
    });
    return output(`Connected to the LogicPacks app on this computer as ${paired.who}.`, {
      ok: true,
      server: host.origin,
      who: paired.who,
      local: true,
    });
  } catch {
    return null;
  }
};

export const loginCommand = async (ctx: Context, args: ParsedArgs): Promise<Output> => {
  const config = ctx.loadConfig();
  const finishOnly = hasFlag(args, "finish");
  const named =
    flagValue(args, "host") ??
    flagValue(args, "server") ??
    ctx.env.LP_SERVER ??
    (hasFlag(args, "cloud") ? DEFAULT_HOST : null);
  const tokenGiven = flagValue(args, "token") ?? ctx.env.LP_TOKEN ?? null;
  // By default `lp login` joins the LogicPacks app on this computer; the cloud is opt-in (--cloud / --host).
  if (named === null && tokenGiven === null && !finishOnly && !config.pending) {
    if (config.server === null || isLocalOrigin(config.server)) {
      const local = await loginLocal(ctx, config);
      if (local) return local;
      return refuse(OPEN_THE_APP, { reason: "app_not_running" });
    }
  }
  // --finish completes the pairing --start began, on the host it began on.
  const server = (
    named ??
    (finishOnly ? config.pending?.server : undefined) ??
    config.server ??
    DEFAULT_HOST
  ).replace(/\/+$/, "");
  const token = tokenGiven;
  if (token) {
    const me = await ctx.call<{ who: string }>({ server, token }, "/api/lp/helper/whoami");
    ctx.saveConfig({ ...config, server, token, who: me.who, pending: null });
    return output(`Connected to ${server} as ${me.who}.`, { ok: true, server, who: me.who });
  }
  let pending = config.pending ?? null;
  if (finishOnly && (pending === null || pending.server !== server)) {
    return refuse(`No sign-in is waiting for ${server}. Run lp login --start first.`);
  }
  if (!finishOnly || pending === null) {
    const started = await ctx.call<{ code: string; pollToken: string; approvePath: string }>(
      { server, token: null },
      "/api/lp/helper/pair/start",
      { body: { device: config.device }, auth: false },
    );
    pending = {
      server,
      code: started.code,
      pollToken: started.pollToken,
      url: `${server}${started.approvePath}`,
    };
    ctx.saveConfig({ ...ctx.loadConfig(), pending });
    if (hasFlag(args, "start")) {
      return output(
        [
          `Ask your user to open this link and approve the code ${pending.code}:`,
          `  ${pending.url}`,
          "Then run: lp login --finish",
        ].join("\n"),
        { ok: true, status: "pending", url: pending.url, code: pending.code, server },
      );
    }
    ctx.print(`Open this link and approve the code ${pending.code}:\n  ${pending.url}`);
    if (!hasFlag(args, "no-open") && process.platform === "darwin" && ctx.env.LP_NO_OPEN !== "1") {
      NodeChildProcess.spawn("open", [pending.url], { stdio: "ignore", detached: true }).unref();
    }
  }
  const timeoutMs = Number(flagValue(args, "timeout") ?? 600) * 1000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const polled = await ctx
      .call<{ status: string; token?: string; who?: string }>(
        { server, token: null },
        "/api/lp/helper/pair/poll",
        { body: { pollToken: pending.pollToken }, auth: false },
      )
      .catch(() => ({ status: "pending" }) as { status: string; token?: string; who?: string });
    if (polled.status === "approved" && polled.token) {
      ctx.saveConfig({
        ...ctx.loadConfig(),
        server,
        token: polled.token,
        who: polled.who ?? null,
        pending: null,
      });
      return output(`Connected to ${server} as ${polled.who ?? "you"}.`, {
        ok: true,
        server,
        who: polled.who ?? null,
      });
    }
    if (polled.status === "expired") break;
    await ctx.sleep(1500);
  }
  return refuse(
    Date.now() >= deadline
      ? `Not approved yet. Approve ${pending.url} (code ${pending.code}), then run lp login --finish.`
      : "The code expired before it was approved. Run lp login again.",
    { url: pending.url, code: pending.code },
  );
};

export const whoamiCommand = async (ctx: Context): Promise<Output> => {
  const config = signedIn(ctx);
  const me = await ctx.call<{ who: string; kind: string }>(config, "/api/lp/helper/whoami");
  const profile = await ctx
    .call<{ user: { email: string; displayName: string } | null }>(config, "/api/lp/me")
    .catch(() => ({ user: null }));
  const email = profile.user?.email ?? null;
  return output(`${me.who}${email ? ` <${email}>` : ""} on ${config.server}`, {
    who: me.who,
    email,
    kind: me.kind,
    server: config.server,
    harness: detectHarness(ctx.env, config),
  });
};

interface ProjectRow {
  readonly id: string;
  readonly title: string;
  readonly role: string;
  readonly synced: boolean;
}

export const projectsCommand = async (ctx: Context): Promise<Output> => {
  const config = signedIn(ctx);
  const { projects } = await ctx.call<{ projects: Array<ProjectRow> }>(config, "/api/lp/projects");
  return output(
    projects.length === 0
      ? "No projects yet. Run lp share in a folder to share it."
      : projects
          .map(
            (project) =>
              `${project.title}  [${project.id}]  ${project.role}${project.synced ? ", synced" : ""}`,
          )
          .join("\n"),
    { projects },
  );
};

export type InviteScope = "project" | "workspace";

export const SCOPE_TEXT: Record<InviteScope, string> = {
  project: "grants access to this project only",
  workspace: "grants access to every project in the workspace",
};

interface LinkView {
  readonly enabled: boolean;
  readonly path: string;
  readonly expiry: string;
}

/**
 * The project's own share link (only this project), switched on if it was off. Owners only;
 * null when the host has no project links or the caller does not own the project.
 */
const projectLink = async (ctx: Context, config: HelperConfig, projectId: string) => {
  try {
    const overview = await ctx.call<{ canManage: boolean; link: LinkView | null }>(
      config,
      `/api/lp/shares?projectId=${encodeURIComponent(projectId)}`,
    );
    if (!overview.canManage) return null;
    let link = overview.link;
    if (link === null || !link.enabled) {
      link = (
        await ctx.call<{ link: LinkView }>(config, "/api/lp/shares/link", {
          body: { projectId, enabled: true },
        })
      ).link;
    }
    return new URL(link.path, config.server!).toString();
  } catch (error) {
    if (error instanceof RejectedError && error.status === 401) throw error;
    return null;
  }
};

/** The link `lp share` and `lp invite` print: this project's by default, --workspace for all. */
const scopedLink = async (
  ctx: Context,
  config: HelperConfig,
  args: ParsedArgs,
  project: { readonly projectId: string; readonly workspaceId: string | null },
): Promise<{ link: string | null; scope: InviteScope; note: string | null }> => {
  if (hasFlag(args, "workspace")) {
    return {
      link: await inviteLink(ctx, config, project.workspaceId),
      scope: "workspace",
      note: null,
    };
  }
  const link = await projectLink(ctx, config, project.projectId);
  return {
    link,
    scope: "project",
    note:
      link === null
        ? "Only the project's owner can make its invite link. Ask them, or add people by email: lp invite <email>."
        : null,
  };
};

const linkLine = (label: string, scoped: { link: string | null; scope: InviteScope }) =>
  scoped.link === null ? null : `${label} (${SCOPE_TEXT[scoped.scope]}): ${scoped.link}`;

const inviteLink = async (ctx: Context, config: HelperConfig, workspaceId: string | null) => {
  if (workspaceId === null) return null;
  const { path } = await ctx.call<{ path: string }>(
    config,
    `/api/lp/workspaces/invite?workspaceId=${encodeURIComponent(workspaceId)}`,
  );
  return new URL(path, config.server!).toString();
};

const repoName = (root: string) =>
  NodePath.basename(root)
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "project";

export const shareCommand = async (ctx: Context, args: ParsedArgs): Promise<Output> => {
  const config = signedIn(ctx);
  const steps: Array<string> = [];
  let root = gitInfo(ctx.cwd).root;
  const git = (...gitArgs: Array<string>) => ctx.run("git", gitArgs, root ?? ctx.cwd);
  if (root === null) {
    const init = ctx.run("git", ["init"], ctx.cwd);
    if (!init.ok) return refuse(`git init failed: ${init.stderr}`);
    root = ctx.cwd;
    steps.push("Started a git repository here.");
  }
  if (!git("rev-parse", "--verify", "HEAD").ok) {
    git("add", "-A");
    const commit = git("commit", "-m", "Share with LogicPacks", "--allow-empty");
    if (!commit.ok) return refuse(`git commit failed: ${commit.stderr}`);
    steps.push("Made a first commit.");
  }
  let remote = flagValue(args, "remote") ?? gitInfo(root).remote;
  if (remote === null) {
    remote = git("config", "--get", "remote.origin.url").stdout || null;
  }
  if (remote === null) {
    const name = flagValue(args, "repo") ?? repoName(root);
    const created = ctx.run(
      "gh",
      ["repo", "create", name, "--private", "--source", root, "--remote", "origin", "--push"],
      root,
    );
    if (!created.ok) {
      return refuse(
        [
          "This folder has no git remote, and creating a GitHub repository with gh failed:",
          created.stderr || "gh is not installed or not signed in (gh auth login).",
          "Add a remote yourself (git remote add origin <url>) and run lp share again.",
        ].join("\n"),
      );
    }
    remote = git("config", "--get", "remote.origin.url").stdout;
    steps.push(`Created the private GitHub repository ${name} and pushed.`);
  } else if (flagValue(args, "remote") !== null && !gitInfo(root).remote) {
    git("remote", "add", "origin", remote);
  }
  if (!hasFlag(args, "no-push")) {
    const push = git("push", "-u", "origin", "HEAD");
    if (!push.ok && !/Everything up-to-date/.test(push.stderr)) {
      return refuse(`git push failed: ${push.stderr}`);
    }
    steps.push(`Pushed to ${remote}.`);
  }
  const title = flagValue(args, "title") ?? repoName(root);
  const imported = await ctx.call<{ kind: string; projectId: string }>(
    config,
    "/api/lp/sync/import",
    { body: { remoteUrl: remote, title }, timeoutMs: 120_000 },
  );
  steps.push(
    imported.kind === "imported"
      ? `Registered "${title}" on ${config.server}.`
      : `"${title}" was already on ${config.server}.`,
  );
  const project = await ctx.call<{ workspaceId: string | null; title: string }>(
    config,
    `/api/lp/connect/project?projectId=${encodeURIComponent(imported.projectId)}`,
  );
  const scoped = await scopedLink(ctx, config, args, {
    projectId: imported.projectId,
    workspaceId: project.workspaceId,
  });
  const registration = await register(ctx, args).catch(() => null);
  return output(
    [
      ...steps,
      linkLine("Invite link", scoped) ?? scoped.note ?? "No invite link.",
      "Send the link to teammates, or add someone directly: lp invite <email or name>.",
      scoped.scope === "project"
        ? "For every project in the workspace instead: lp invite --workspace."
        : "",
    ]
      .filter(Boolean)
      .join("\n"),
    {
      ok: true,
      projectId: imported.projectId,
      title: project.title,
      remote,
      inviteLink: scoped.link,
      inviteScope: scoped.scope,
      threadId: registration?.threadId ?? null,
    },
  );
};

const currentProject = async (ctx: Context, args: ParsedArgs) => {
  const registration = await register(ctx, args);
  return registration;
};

export const inviteCommand = async (ctx: Context, args: ParsedArgs): Promise<Output> => {
  const config = signedIn(ctx);
  const who = args.positionals.join(" ").trim();
  const project = await currentProject(ctx, args);
  const workspace = hasFlag(args, "workspace") && project.workspaceId !== null;
  const scoped = await scopedLink(ctx, config, args, project);
  const scopeData = {
    inviteLink: scoped.link,
    inviteScope: scoped.scope,
    projectId: project.projectId,
  };
  if (who.length === 0) {
    return output(
      linkLine(`Invite link for ${project.projectTitle}`, scoped) ??
        scoped.note ??
        "No invite link.",
      scopeData,
    );
  }
  if (!workspace) {
    // A project share: an existing account becomes a member of this project only; anyone
    // else gets a pending invite for this project (emailed when the host can send mail).
    try {
      const shared = await ctx.call<{
        kind: "member" | "invited";
        member?: { user: { displayName: string; email: string } };
        invite?: { email: string; path: string };
        emailSent?: boolean;
      }>(config, "/api/lp/shares", { body: { projectId: project.projectId, user: who } });
      if (shared.kind === "member" && shared.member) {
        return output(
          `Added ${shared.member.user.displayName} to ${project.projectTitle} (this project only).`,
          { ok: true, added: shared.member.user, ...scopeData },
        );
      }
      const link = shared.invite ? new URL(shared.invite.path, config.server!).toString() : null;
      return output(
        [
          `Invited ${shared.invite?.email ?? who} to ${project.projectTitle} (this project only)${shared.emailSent ? "; they got an email" : ""}.`,
          link ? `Their personal invite link: ${link}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
        { ok: true, added: null, invited: shared.invite ?? null, ...scopeData },
      );
    } catch (error) {
      // An older host without project shares answers 404: fall back to adding a project member.
      if (!(error instanceof RejectedError) || error.status !== 404) throw error;
    }
  }
  try {
    const added = await ctx.call<{ member: { user: { displayName: string; email: string } } }>(
      config,
      workspace ? "/api/lp/workspaces/members" : "/api/lp/members",
      {
        body: workspace
          ? { workspaceId: project.workspaceId, user: who }
          : { projectId: project.projectId, user: who },
      },
    );
    return output(
      `Added ${added.member.user.displayName} (${workspace ? "every project in the workspace" : "this project only"}).`,
      { ok: true, added: added.member.user, ...scopeData },
    );
  } catch (error) {
    if (!(error instanceof RejectedError) || error.status === 403) throw error;
    return output(
      [
        `${who} has no LogicPacks account yet (or none by that name).`,
        linkLine("Send them this invite link", scoped) ?? scoped.note ?? "",
      ]
        .filter(Boolean)
        .join("\n"),
      { ok: true, added: null, invitee: who, ...scopeData },
    );
  }
};

interface MemberRow {
  readonly user: { readonly userId: string; readonly displayName: string; readonly email: string };
  readonly role: string;
}

const matchPerson = (rows: ReadonlyArray<MemberRow>, who: string) => {
  const wanted = who.trim().toLowerCase();
  const exact = rows.filter(
    (row) =>
      row.user.email.toLowerCase() === wanted ||
      row.user.displayName.toLowerCase() === wanted ||
      row.user.userId === who,
  );
  if (exact.length > 0) return exact;
  return rows.filter((row) => row.user.displayName.toLowerCase().split(/\s+/)[0] === wanted);
};

/**
 * `lp remove <person>`: takes someone's access away. They leave this project, and the
 * workspace too (workspace members can open every project in it) unless --project-only.
 * --dry-run says what would be removed.
 */
export const removeCommand = async (ctx: Context, args: ParsedArgs): Promise<Output> => {
  const config = signedIn(ctx);
  const who = args.positionals.join(" ").trim();
  if (who.length === 0)
    return refuse("Usage: lp remove <email or name> [--project-only] [--dry-run]");
  const project = await currentProject(ctx, args);
  const { members } = await ctx.call<{ members: Array<MemberRow> }>(
    config,
    `/api/lp/members?projectId=${encodeURIComponent(project.projectId)}`,
  );
  let workspaceMembers: Array<MemberRow> = [];
  if (project.workspaceId !== null && !hasFlag(args, "project-only")) {
    workspaceMembers = (
      await ctx
        .call<{ members: Array<MemberRow> }>(
          config,
          `/api/lp/workspaces/members?workspaceId=${encodeURIComponent(project.workspaceId)}`,
        )
        .catch(() => ({ members: [] as Array<MemberRow> }))
    ).members;
  }
  const inProject = matchPerson(members, who);
  const inWorkspace = matchPerson(workspaceMembers, who);
  const people = new Map([...inProject, ...inWorkspace].map((row) => [row.user.userId, row.user]));
  if (people.size === 0)
    return refuse(`Nobody called ${who} is in ${project.projectTitle}. Run lp members.`);
  if (people.size > 1) {
    return refuse(
      `${who} matches ${[...people.values()].map((user) => `${user.displayName} <${user.email}>`).join(", ")}. Use their email.`,
    );
  }
  const person = [...people.values()][0]!;
  const steps: Array<string> = [];
  const projectRow = inProject.find((row) => row.user.userId === person.userId);
  const workspaceRow = inWorkspace.find((row) => row.user.userId === person.userId);
  if (projectRow?.role === "owner" || workspaceRow?.role === "owner") {
    return refuse(
      `${person.displayName} owns this project or workspace; an owner cannot be removed here.`,
    );
  }
  if (projectRow)
    steps.push(`remove ${person.displayName} from the project ${project.projectTitle}`);
  if (workspaceRow) {
    steps.push(`remove ${person.displayName} from the workspace (every project in it)`);
  }
  if (hasFlag(args, "dry-run")) {
    return output(`Would ${steps.join(", and ")}. Nothing changed.`, {
      ok: true,
      dryRun: true,
      user: person,
      steps,
    });
  }
  if (projectRow) {
    await ctx.call(config, "/api/lp/members/remove", {
      body: { projectId: project.projectId, userId: person.userId },
    });
  }
  if (workspaceRow) {
    await ctx.call(config, "/api/lp/workspaces/members/remove", {
      body: { workspaceId: project.workspaceId, userId: person.userId },
    });
  }
  const stillThere = hasFlag(args, "project-only") && project.workspaceId !== null;
  return output(
    [
      `Removed ${person.displayName}: ${steps.map((step) => step.replace(/^remove \S+( \S+)? from /, "")).join("; ")}.`,
      stillThere
        ? "If they are also a workspace member they can still open it: run without --project-only."
        : "Their agents can no longer read or write this project. Run lp revoke-invite if they still have the invite link.",
    ].join("\n"),
    { ok: true, removed: person, steps },
  );
};

/**
 * `lp revoke-invite`: turns off this project's invite link and makes a new one (the old one stops
 * working). `--off` leaves it off; `<email>` cancels that person's pending invite;
 * `--workspace` resets the workspace link instead.
 */
export const revokeInviteCommand = async (ctx: Context, args: ParsedArgs): Promise<Output> => {
  const config = signedIn(ctx);
  const project = await currentProject(ctx, args);
  const email = args.positionals.join(" ").trim();
  const dry = hasFlag(args, "dry-run");
  if (hasFlag(args, "workspace")) {
    if (project.workspaceId === null) return refuse("This project has no workspace invite link.");
    if (dry)
      return output(
        "Would turn off the workspace invite link and make a new one. Nothing changed.",
        { ok: true, dryRun: true },
      );
    const { path } = await ctx.call<{ path: string }>(config, "/api/lp/workspaces/invite/reset", {
      body: { workspaceId: project.workspaceId },
    });
    const link = new URL(path, config.server!).toString();
    return output(
      `The old workspace invite link no longer works. New link (${SCOPE_TEXT.workspace}): ${link}`,
      { ok: true, inviteLink: link, inviteScope: "workspace" },
    );
  }
  if (email.length > 0) {
    const overview = await ctx.call<{ invites: Array<{ inviteId: string; email: string }> }>(
      config,
      `/api/lp/shares?projectId=${encodeURIComponent(project.projectId)}`,
    );
    const invite = overview.invites.find(
      (entry) => entry.email.toLowerCase() === email.toLowerCase(),
    );
    if (invite === undefined) return refuse(`No pending invite for ${email}.`);
    if (dry)
      return output(`Would cancel the pending invite for ${invite.email}. Nothing changed.`, {
        ok: true,
        dryRun: true,
      });
    await ctx.call(config, "/api/lp/shares/invites/revoke", {
      body: { projectId: project.projectId, inviteId: invite.inviteId },
    });
    return output(`Cancelled the pending invite for ${invite.email}; their link no longer works.`, {
      ok: true,
      revoked: invite.email,
    });
  }
  if (dry) {
    return output(
      hasFlag(args, "off")
        ? "Would turn off this project's invite link. Nothing changed."
        : "Would turn off this project's invite link and make a new one. Nothing changed.",
      { ok: true, dryRun: true },
    );
  }
  if (hasFlag(args, "off")) {
    await ctx.call(config, "/api/lp/shares/link", {
      body: { projectId: project.projectId, enabled: false },
    });
    return output("This project's invite link is off. lp invite turns a new one on.", {
      ok: true,
      inviteLink: null,
    });
  }
  const { link } = await ctx.call<{ link: LinkView }>(config, "/api/lp/shares/link/reset", {
    body: { projectId: project.projectId },
  });
  const url = new URL(link.path, config.server!).toString();
  return output(`The old invite link no longer works. New link (${SCOPE_TEXT.project}): ${url}`, {
    ok: true,
    inviteLink: url,
    inviteScope: "project",
  });
};

export const joinCommand = async (ctx: Context, args: ParsedArgs): Promise<Output> => {
  const config = signedIn(ctx);
  const link = args.positionals[0] ?? "";
  const invite = (() => {
    try {
      return new URL(link).searchParams.get("invite") ?? link;
    } catch {
      return link;
    }
  })();
  if (invite.length === 0) return refuse("Pass the invite link: lp join <link>");
  if (link.includes("/lp/join/project")) {
    const joined = await ctx.call<{ projectId: string }>(config, "/api/lp/join/project", {
      body: { invite, mode: "session" },
    });
    return output("Joined the project (this project only). Run lp projects to see it.", {
      ok: true,
      projectId: joined.projectId,
      scope: "project",
    });
  }
  const joined = await ctx.call<{ workspace: { name: string; workspaceId: string } }>(
    config,
    "/api/lp/join",
    { body: { invite, mode: "session" } },
  );
  return output(
    `Joined the workspace ${joined.workspace.name}. Run lp projects to see its projects.`,
    {
      ok: true,
      workspace: joined.workspace,
    },
  );
};

export const membersCommand = async (ctx: Context, args: ParsedArgs): Promise<Output> => {
  const config = signedIn(ctx);
  const project = await currentProject(ctx, args);
  const { members } = await ctx.call<{
    members: Array<{ user: { displayName: string; email: string }; role: string }>;
  }>(config, `/api/lp/members?projectId=${encodeURIComponent(project.projectId)}`);
  return output(
    [
      `${project.projectTitle}:`,
      ...members.map(
        (member) => `  ${member.user.displayName} <${member.user.email}>  ${member.role}`,
      ),
    ].join("\n"),
    { projectId: project.projectId, members },
  );
};

const ledgerTool = async (
  ctx: Context,
  tool: string,
  toolArgs: Record<string, unknown>,
  args: ParsedArgs,
) => {
  const config = signedIn(ctx);
  const where = location(ctx);
  const harness = detectHarness(ctx.env, config, flagValue(args, "harness"));
  return ctx.call<{ text: string; projectId: string; threadId: string | null }>(
    config,
    "/api/lp/helper/ledger",
    {
      body: {
        cwd: where.cwd,
        gitRoot: where.gitRoot,
        gitRemote: where.gitRemote,
        source: "agent",
        sessionId: agentSessionId(harness, config.device, where.gitRoot ?? where.cwd),
        tool,
        args: toolArgs,
      },
      timeoutMs: 15_000,
    },
  );
};

export const whoCommand = async (ctx: Context, args: ParsedArgs): Promise<Output> => {
  await register(ctx, args);
  const query = args.positionals.join(" ").trim();
  const reply = await ledgerTool(
    ctx,
    query.length === 0 ? "threads" : "who_is_working_on",
    query.length === 0 ? {} : { query },
    args,
  );
  return output(reply.text, { query: query || null, text: reply.text, projectId: reply.projectId });
};

export const agentsCommand = async (ctx: Context, args: ParsedArgs): Promise<Output> => {
  const config = signedIn(ctx);
  const me = await register(ctx, args, flagValue(args, "task"));
  const query = new URLSearchParams({ projectId: me.projectId });
  if (hasFlag(args, "workspace")) query.set("workspace", "1");
  if (hasFlag(args, "all")) query.set("all", "1");
  const { agents } = await ctx.call<{ agents: Array<AgentEntry> }>(
    config,
    `/api/lp/connect/agents?${query}`,
  );
  return output(formatAgents(agents, me.threadId, Date.now()), {
    projectId: me.projectId,
    you: me.threadId,
    agents,
  });
};

const resolveProjectId = async (ctx: Context, config: HelperConfig, given: string) => {
  const { projects } = await ctx.call<{ projects: Array<ProjectRow> }>(config, "/api/lp/projects");
  const lower = given.toLowerCase();
  return (
    projects.find((project) => project.id === given) ??
    projects.find((project) => project.title.toLowerCase() === lower) ??
    null
  )?.id;
};

const sendMessage = async (
  ctx: Context,
  args: ParsedArgs,
  kind: "ask" | "send",
): Promise<Output> => {
  const config = signedIn(ctx);
  const [to, ...rest] = args.positionals;
  const text = rest.join(" ").trim();
  if (!to || text.length === 0) {
    return refuse(`Usage: lp ${kind} <person> "<${kind === "ask" ? "question" : "message"}>"`);
  }
  const me = await register(ctx, args);
  const projectArg = flagValue(args, "project");
  const projectId = projectArg === null ? null : await resolveProjectId(ctx, config, projectArg);
  if (projectArg !== null && !projectId) {
    return refuse(`You have no access to a project called ${projectArg}.`);
  }
  const sent = await ctx.call<{
    message: { id: string; toThreadId: string };
    to: string | null;
    projectTitle: string;
  }>(config, "/api/lp/connect/send", {
    body: {
      fromThreadId: me.threadId,
      to,
      text,
      kind,
      ...(projectId ? { projectId } : {}),
    },
  });
  const who = sent.to ?? to;
  return output(
    kind === "ask"
      ? `Asked ${who} (${sent.message.id}) in ${sent.projectTitle}. Their agent gets it on its next turn or lp inbox; the answer comes back to your lp inbox.`
      : `Sent to ${who} (${sent.message.id}) in ${sent.projectTitle}.`,
    { ok: true, id: sent.message.id, to: who, toThreadId: sent.message.toThreadId, kind },
  );
};

export const sendCommand = (ctx: Context, args: ParsedArgs) => sendMessage(ctx, args, "send");
export const askCommand = (ctx: Context, args: ParsedArgs) => sendMessage(ctx, args, "ask");

const fetchInbox = async (ctx: Context, config: HelperConfig, all: boolean) =>
  (
    await ctx.call<{ items: Array<InboxItem> }>(
      config,
      `/api/lp/connect/inbox${all ? "?all=1" : ""}`,
      { timeoutMs: 15_000 },
    )
  ).items;

const listOf = (args: ParsedArgs, name: string) =>
  (flagValue(args, name) ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

export const replyCommand = async (ctx: Context, args: ParsedArgs): Promise<Output> => {
  const config = signedIn(ctx);
  const [id, ...rest] = args.positionals;
  const text = rest.join(" ").trim();
  if (!id || (text.length === 0 && !flagValue(args, "keep") && !flagValue(args, "drop"))) {
    return refuse('Usage: lp reply <id> "<text>"');
  }
  const items = await fetchInbox(ctx, config, true);
  const item = items.find((entry) => entry.id === id);
  if (item?.kind === "negotiation") {
    // A negotiation is answered with a position: what this side keeps, changes and drops.
    const reply = await ledgerTool(
      ctx,
      "propose_merge",
      {
        action: "position",
        negotiationId: id,
        keep: listOf(args, "keep"),
        change: listOf(args, "change"),
        drop: listOf(args, "drop"),
        insist: hasFlag(args, "insist"),
        note: text,
      },
      args,
    );
    return output(reply.text, { ok: true, id, kind: "negotiation", text: reply.text });
  }
  if (item?.kind === "conflict") {
    return refuse(
      `A conflict is answered by negotiating it: lp who ${item.people.join(", ")}, then tell your user. To start merging both sides, ask the other agent with lp ask.`,
    );
  }
  const me = await register(ctx, args);
  const sent = await ctx.call<{ message: { id: string }; to: string | null }>(
    config,
    "/api/lp/connect/send",
    { body: { fromThreadId: me.threadId, text, replyTo: id, kind: "send" } },
  );
  return output(`Replied to ${sent.to ?? "them"} (${sent.message.id}).`, {
    ok: true,
    id: sent.message.id,
    replyTo: id,
    to: sent.to,
  });
};

export const decideCommand = async (ctx: Context, args: ParsedArgs): Promise<Output> => {
  const config = signedIn(ctx);
  const [id, choice] = args.positionals;
  const choices = ["accept", "mine", "theirs", "both"];
  if (!id || !choice || !choices.includes(choice)) {
    return refuse("Usage: lp decide <negotiation id> accept|mine|theirs|both");
  }
  const items = await fetchInbox(ctx, config, true);
  const item = items.find((entry) => entry.id === id && entry.kind === "negotiation");
  if (item === undefined || item.kind !== "negotiation") {
    return refuse(`No negotiation ${id} in your inbox.`);
  }
  const decided = await ctx.call<{ negotiation: { state: string } }>(
    config,
    "/api/lp/ledger/decide",
    { body: { negotiationId: id, threadId: item.threadId, choice } },
  );
  return output(`Recorded "${choice}". The negotiation is ${decided.negotiation.state}.`, {
    ok: true,
    id,
    state: decided.negotiation.state,
  });
};

export const doneCommand = async (ctx: Context, args: ParsedArgs): Promise<Output> => {
  const config = signedIn(ctx);
  if (args.positionals.length === 0) return refuse("Usage: lp done <id> [<id>...]");
  const { dismissed } = await ctx.call<{ dismissed: number }>(config, "/api/lp/connect/seen", {
    body: { ids: args.positionals },
  });
  return output(`Dismissed ${dismissed} item(s).`, { ok: true, dismissed });
};

export const inboxCommand = async (ctx: Context, args: ParsedArgs): Promise<Output> => {
  const config = signedIn(ctx);
  const all = hasFlag(args, "all");
  if (!hasFlag(args, "follow")) {
    const items = await fetchInbox(ctx, config, all);
    return output(formatInbox(items, Date.now()), { items });
  }
  // --follow: a watcher for harnesses that can run one in the background. Prints only new items.
  const interval = Number(flagValue(args, "interval") ?? 5) * 1000;
  const seen = new Set<string>();
  const json = hasFlag(args, "json");
  for (;;) {
    const items = await fetchInbox(ctx, config, all).catch(() => null);
    const fresh = (items ?? []).filter((item) => !seen.has(`${item.kind}:${item.id}:${item.atMs}`));
    for (const item of fresh) seen.add(`${item.kind}:${item.id}:${item.atMs}`);
    if (fresh.length > 0) {
      ctx.print(
        json
          ? fresh.map((item) => JSON.stringify(item)).join("\n")
          : formatInbox(fresh, Date.now()),
      );
    }
    if (hasFlag(args, "once")) return output("", { items: fresh });
    await ctx.sleep(interval);
  }
};

/**
 * `lp editing <files>`: an outside agent tells the project which files it is changing. They
 * show in lp who and lp agents, and two agents on one file get an overlap notice in lp inbox.
 */
export const editingCommand = async (ctx: Context, args: ParsedArgs): Promise<Output> => {
  const config = signedIn(ctx);
  if (args.positionals.length === 0) return refuse("Usage: lp editing <file> [<file>...]");
  const me = await register(ctx, args);
  const where = location(ctx);
  const harness = detectHarness(ctx.env, config, flagValue(args, "harness"));
  const files = args.positionals.map((file) => NodePath.resolve(ctx.cwd, file));
  const at = new Date().toISOString();
  await ctx.call(config, "/api/lp/helper/ingest", {
    body: {
      cwd: where.cwd,
      gitRoot: where.gitRoot,
      gitRemote: where.gitRemote,
      source: "agent",
      harness,
      device: config.device,
      sessionId: agentSessionId(harness, config.device, where.gitRoot ?? where.cwd),
      events: [
        {
          uid: `editing-${NodeCrypto.randomUUID()}`,
          at,
          type: "tool",
          tool: {
            name: "Edit",
            kind: "file_change",
            input: args.positionals.join(", "),
            status: "completed",
            files,
          },
        },
      ],
    },
  });
  return output(
    `Teammates now see you editing ${args.positionals.join(", ")} in ${me.projectTitle}.`,
    { ok: true, files: args.positionals, projectId: me.projectId },
  );
};

// ── Request assistance ──

interface ExpertRow {
  readonly id: string;
  readonly name: string;
  readonly headline?: string;
  readonly specialties?: ReadonlyArray<string>;
}

export const assistCommand = async (ctx: Context, args: ParsedArgs): Promise<Output> => {
  const config = signedIn(ctx);
  const [sub = "list", ...rest] = args.positionals;
  if (sub === "experts") {
    const { experts } = await ctx.call<{ experts: Array<ExpertRow> }>(config, "/api/lp/experts");
    return output(
      experts
        .map(
          (expert) =>
            `${expert.id}  ${expert.name}${expert.headline ? `: ${expert.headline}` : ""}`,
        )
        .join("\n") || "No experts in the catalog.",
      { experts },
    );
  }
  const me = await register(ctx, args);
  if (sub === "request") {
    const brief = rest.join(" ").trim();
    if (brief.length < 10) return refuse('Say what you need: lp assist request "<brief>"');
    let expertId = flagValue(args, "expert");
    if (expertId === null) {
      const { experts } = await ctx.call<{ experts: Array<ExpertRow> }>(config, "/api/lp/experts");
      const words = brief.toLowerCase();
      const match =
        experts.find((expert) =>
          (expert.specialties ?? []).some((specialty) => words.includes(specialty.toLowerCase())),
        ) ?? experts[0];
      if (match === undefined) return refuse("No experts are available on this host.");
      expertId = match.id;
    }
    const created = await ctx.call<{
      request: { id: string; status: string; expert?: { name: string } };
    }>(config, "/api/lp/experts/requests", {
      body: { projectId: me.projectId, expertId, brief, fromThreadId: me.threadId },
    });
    return output(
      `Requested assistance (${created.request.id}) from ${created.request.expert?.name ?? expertId}. Status: ${created.request.status}. Follow it with lp assist list.`,
      { ok: true, request: created.request },
    );
  }
  if (sub === "list") {
    const { requests } = await ctx.call<{
      requests: Array<{ id: string; status: string; brief: string; expert?: { name: string } }>;
    }>(config, `/api/lp/experts/requests?projectId=${encodeURIComponent(me.projectId)}`);
    return output(
      requests.length === 0
        ? "No assistance requests in this project."
        : requests
            .map(
              (request) =>
                `${request.id}  ${request.status}  ${request.expert?.name ?? ""}: ${request.brief.slice(0, 80)}`,
            )
            .join("\n"),
      { requests },
    );
  }
  if (sub === "end") {
    const requestId = rest[0];
    if (!requestId) return refuse("Usage: lp assist end <request id>");
    await ctx.call(config, "/api/lp/experts/end", { body: { requestId } });
    return output(`Ended ${requestId}; the expert's access is revoked.`, { ok: true, requestId });
  }
  return refuse("Usage: lp assist request|list|experts|end");
};

// ── Packs ──

export const packsCommand = async (ctx: Context, args: ParsedArgs): Promise<Output> => {
  const config = signedIn(ctx);
  const [sub = "list", ...rest] = args.positionals;
  const me = await register(ctx, args);
  if (sub === "list") {
    const { packs } = await ctx.call<{
      packs: Array<{ pack: { id: string; name: string; description?: string } }>;
    }>(config, `/api/lp/packs?projectId=${encodeURIComponent(me.projectId)}`);
    return output(
      packs.length === 0
        ? 'No packs in this project yet. Save one with lp packs save "<name>".'
        : packs.map(({ pack }) => `${pack.id}  ${pack.name}`).join("\n"),
      { packs: packs.map(({ pack }) => pack) },
    );
  }
  if (sub === "save") {
    const name = rest.join(" ").trim();
    const saved = await ctx.call<{ pack: { id: string; name: string } }>(
      config,
      "/api/lp/packs/save",
      {
        body: { threadId: me.threadId, ...(name ? { name } : {}) },
        timeoutMs: 30_000,
      },
    );
    return output(`Saved pack ${saved.pack.name} (${saved.pack.id}).`, {
      ok: true,
      pack: saved.pack,
    });
  }
  if (sub === "use") {
    const packId = rest[0];
    if (!packId) return refuse("Usage: lp packs use <id> [--to <person>]");
    let targetThreadId = me.threadId;
    const to = flagValue(args, "to");
    if (to !== null) {
      const { agents } = await ctx.call<{ agents: Array<AgentEntry> }>(
        config,
        `/api/lp/connect/agents?projectId=${encodeURIComponent(me.projectId)}&all=1`,
      );
      const target = agents.find((agent) => agent.person?.toLowerCase() === to.toLowerCase());
      if (target === undefined) return refuse(`No thread for ${to} in this project.`);
      targetThreadId = target.threadId;
    }
    await ctx.call(config, "/api/lp/packs/use", {
      body: { projectId: me.projectId, packId, targetThreadId },
    });
    return output(
      `Handed pack ${packId} to ${to ?? "your thread"}; the agent reads it on its next turn.`,
      {
        ok: true,
        packId,
        targetThreadId,
      },
    );
  }
  return refuse("Usage: lp packs save|list|use");
};

// ── Goals (beta) ──

export const GOALS_UNAVAILABLE = "Goals are not available on this host yet.";

const DUE_WORDS =
  /\s+(?:by|due)\s+((?:today|tomorrow|tonight|(?:next\s+)?(?:mon|tues|wednes|thurs|fri|satur|sun)day|end of (?:day|week)|in \d+ (?:days?|weeks?)|\d{4}-\d{2}-\d{2}))\.?$/i;

/**
 * One milestone as an agent writes it on the command line: "Omar: build the footer by
 * friday". The name before the colon is the assignee; a trailing "by <day>" is the due date.
 */
export const parseMilestone = (text: string) => {
  const colon = text.indexOf(":");
  if (colon <= 0) return null;
  const assignee = text.slice(0, colon).trim();
  let title = text.slice(colon + 1).trim();
  const due = DUE_WORDS.exec(title);
  if (due !== null) title = title.slice(0, due.index).trim();
  if (assignee.length === 0 || title.length === 0) return null;
  return { title, assignee, ...(due === null ? {} : { due: due[1]!.toLowerCase() }) };
};

const splitList = (value: string | null) =>
  value === null
    ? undefined
    : value
        .split(/;|\n/)
        .map((entry) => entry.trim())
        .filter(Boolean);

/** A host without Goals refuses the ledger tool (400) or has no route (404). */
const goalsMissing = (error: unknown) =>
  error instanceof RejectedError &&
  (error.status === 404 || error.status === 400 || error.status === 503) &&
  !/no goal|not found\. run lp goals/i.test(error.message);

const GOALS_USAGE = [
  'lp goals plan "<goal>" "<person>: <task> [by <day>]" ... [--outcome "<text>"] [--criteria "<a; b>"] [--paths "<a; b>"] [--avoid "<a; b>"]',
  "lp goals list | show <id> | confirm <goal> | cancel <goal>",
  'lp goals start|blocked|done <milestone> [--note "<text>"]',
  'lp goals review | decide <id> <action> [--note "<text>"]',
].join("\n");

export const goalsCommand = async (ctx: Context, args: ParsedArgs): Promise<Output> => {
  const config = signedIn(ctx);
  const [sub = "list", ...rest] = args.positionals;
  try {
    return await goalsAction(ctx, config, args, sub, rest);
  } catch (error) {
    if (goalsMissing(error)) {
      return refuse(`${GOALS_UNAVAILABLE} (lp goals ${sub})`, { available: false });
    }
    throw error;
  }
};

const goalsAction = async (
  ctx: Context,
  config: HelperConfig,
  args: ParsedArgs,
  sub: string,
  rest: ReadonlyArray<string>,
): Promise<Output> => {
  const me = await register(ctx, args);
  const goalsCall = (body: Record<string, unknown>) =>
    ctx.call<{
      goals?: Array<{ id: string }>;
      goal?: { id: string; title: string; state: string };
    }>(config, "/api/lp/connect/goals", { body });
  switch (sub) {
    case "list":
    case "show": {
      const goalId = sub === "show" ? rest[0] : undefined;
      if (sub === "show" && !goalId) return refuse("Usage: lp goals show <goal id>");
      const reply = await ledgerTool(ctx, "goals", goalId ? { goalId } : {}, args);
      const { goals = [] } = await goalsCall({ op: "list", projectId: me.projectId });
      return output(reply.text, {
        projectId: me.projectId,
        text: reply.text,
        goals: goalId ? goals.filter((goal) => goal.id === goalId) : goals,
      });
    }
    case "plan": {
      const [title, ...lines] = rest;
      const fromJson = flagValue(args, "plan");
      if (fromJson !== null) {
        const plan = JSON.parse(fromJson) as Record<string, unknown>;
        const reply = await ledgerTool(ctx, "goal_plan", { ...plan, ...goalRef(args) }, args);
        return output(reply.text, { text: reply.text });
      }
      const milestones = lines.map((line) => ({ line, parsed: parseMilestone(line) }));
      const bad = milestones.filter((entry) => entry.parsed === null).map((entry) => entry.line);
      if (!title || milestones.length === 0 || bad.length > 0) {
        return refuse(
          [
            bad.length > 0
              ? `Write each milestone as "<person>: <task> [by <day>]": ${bad.join(", ")}`
              : "",
            "Usage:",
            GOALS_USAGE,
            'Example: lp goals plan "Launch the pricing page" "Omar: build the footer by friday" "Priya: write the tests"',
          ]
            .filter(Boolean)
            .join("\n"),
        );
      }
      const criteria = splitList(flagValue(args, "criteria"));
      const paths = splitList(flagValue(args, "paths"));
      const avoid = splitList(flagValue(args, "avoid"));
      const outcome = flagValue(args, "outcome") ?? undefined;
      const reply = await ledgerTool(
        ctx,
        "goal_plan",
        {
          title,
          ...(outcome === undefined ? {} : { outcome }),
          ...goalRef(args),
          milestones: milestones.map(({ parsed }) => ({
            ...parsed!,
            ...(criteria === undefined ? {} : { criteria }),
            ...(paths === undefined && avoid === undefined
              ? {}
              : { scope: { ...(paths ? { paths } : {}), ...(avoid ? { avoid } : {}) } }),
          })),
        },
        args,
      );
      const goalId = /Draft goal (\S+)/.exec(reply.text)?.[1] ?? null;
      const text = reply.text.replace(
        /Nothing is sent yet:.*$/m,
        goalId === null
          ? "Nothing is sent yet: your user confirms it."
          : `Nothing is sent yet. Show your user the plan; when they agree, run lp goals confirm ${goalId} (or they confirm it in LogicPacks Goals).`,
      );
      return output(text, { goalId, text });
    }
    case "confirm":
    case "cancel": {
      const goalId = rest[0];
      if (!goalId) return refuse(`Usage: lp goals ${sub} <goal id>`);
      const { goal } = await goalsCall({ op: sub, goalId });
      return output(
        sub === "confirm"
          ? `Confirmed "${goal?.title}". Each milestone goes to its person's agent now; progress shows in lp goals list.`
          : `Cancelled "${goal?.title}".`,
        { goal },
      );
    }
    case "start":
    case "blocked":
    case "done": {
      const milestoneId = rest[0];
      if (!milestoneId) return refuse(`Usage: lp goals ${sub} <milestone id> [--note "<text>"]`);
      const note = flagValue(args, "note") ?? rest.slice(1).join(" ");
      const reply = await ledgerTool(
        ctx,
        "goal_update",
        {
          milestoneId,
          status: sub === "start" ? "in_progress" : sub,
          ...(note ? { note } : {}),
        },
        args,
      );
      return output(reply.text, { milestoneId, text: reply.text });
    }
    case "review": {
      const items = (await fetchInbox(ctx, config, false)).filter(
        (item) => item.kind === "drift" || item.kind === "review" || item.kind === "goal",
      );
      return output(
        items.length === 0 ? "Nothing to review or decide." : formatInbox(items, Date.now()),
        { items },
      );
    }
    case "decide": {
      const [decisionId, action] = rest;
      if (!decisionId || !action)
        return refuse('Usage: lp goals decide <id> <action> [--note "<text>"]');
      const note = flagValue(args, "note") ?? undefined;
      const { goal } = await goalsCall({
        op: "decide",
        decisionId,
        action,
        ...(note === undefined ? {} : { note }),
      });
      return output(`Recorded "${action}" on ${decisionId} (goal "${goal?.title}").`, { goal });
    }
    default:
      return refuse(`Usage:\n${GOALS_USAGE}`);
  }
};

const goalRef = (args: ParsedArgs) => {
  const goalId = flagValue(args, "goal");
  return goalId === null ? {} : { goalId };
};

// ── Setup ──

/**
 * `lp setup --agent <id>`: shows the exact diff first. Without --yes nothing is written, so an
 * agent shows the diff to its user and runs it again with --yes once they approve. With
 * --yes each changed file is backed up first (`<file>.lp-backup-<stamp>`).
 */
export const setupCommand = (ctx: Context, args: ParsedArgs): Output => {
  if (hasFlag(args, "list") || (!flagValue(args, "agent") && args.positionals.length === 0)) {
    return output(
      [
        "lp setup --agent <id> [--file <path>] [--project] [--dry-run | --yes]",
        "",
        ...HARNESSES.map((harness) => `  ${harness.id.padEnd(14)}${harness.name}`),
      ].join("\n"),
      { harnesses: HARNESSES.map(({ id, name }) => ({ id, name })) },
    );
  }
  const agent = flagValue(args, "agent") ?? args.positionals[0]!;
  const apply = hasFlag(args, "yes") && !hasFlag(args, "dry-run");
  const run = () =>
    runSetup({
      agent,
      file: flagValue(args, "file"),
      project: hasFlag(args, "project"),
      cwd: ctx.cwd,
      env: ctx.env,
      ...(ctx.home === undefined ? {} : { home: ctx.home, platform: "linux" as const }),
    });
  beginFileSession(!apply);
  let result: ReturnType<typeof runSetup>;
  try {
    result = run();
  } catch (error) {
    endFileSession();
    throw error;
  }
  const session = endFileSession()!;
  const changes = session.changes.map((change) => ({
    file: change.file,
    diff: unifiedDiff(change),
  }));
  const handSteps =
    result.steps.length > 0
      ? ["", "Do this by hand:", ...result.steps.map((step) => `  - ${step}`)]
      : [];
  const noShell = result.harness.shell
    ? []
    : [
        "",
        `${result.harness.name} does not run commands on its own: run the lp commands it suggests.`,
      ];
  if (!apply) {
    const again = ["lp setup", `--agent ${result.harness.id}`];
    const file = flagValue(args, "file");
    if (file) again.push(`--file ${JSON.stringify(file)}`);
    if (hasFlag(args, "project")) again.push("--project");
    again.push("--yes");
    return output(
      [
        `${result.harness.name}: nothing written yet. This is exactly what would change:`,
        "",
        describeSession(session),
        ...handSteps,
        ...noShell,
        "",
        session.changes.length === 0
          ? "Nothing to do."
          : `Show this to your user. When they approve, run: ${again.join(" ")}`,
      ].join("\n"),
      {
        ok: true,
        dryRun: true,
        harness: result.harness.id,
        changes,
        commands: session.commands,
        steps: result.steps,
        apply: again.join(" "),
      },
    );
  }
  const config = ctx.loadConfig();
  ctx.saveConfig({ ...config, harness: result.harness.name });
  const backups = describeBackups(session);
  const lines = [
    `${result.harness.name}:`,
    ...result.changes.map((change) => `  ${outcomeLine(change)}`),
    ...(backups ? ["", backups] : []),
    ...handSteps,
    ...noShell,
  ];
  return output(lines.join("\n"), {
    ok: true,
    harness: result.harness.id,
    changes: result.changes,
    backups: session.backups,
    steps: result.steps,
  });
};

export const setupPromptCommand = (args: ParsedArgs): Output => {
  const text = setupPrompt(hasFlag(args, "installed") ? "installed" : "new");
  return output(text, { prompt: text });
};

export const setupBlockCommand = (): Output => {
  const block = `<!-- logicpacks:start -->\n${globalBlockBody()}\n<!-- logicpacks:end -->`;
  return output(block, { block });
};

export const helpAgentsCommand = (): Output => output(agentsHelp(), { help: agentsHelp() });

/** Every agent-facing command, by name. */
export const CONNECT_COMMANDS: Record<
  string,
  (ctx: Context, args: ParsedArgs) => Promise<Output> | Output
> = {
  whoami: whoamiCommand,
  projects: projectsCommand,
  share: shareCommand,
  invite: inviteCommand,
  join: joinCommand,
  members: membersCommand,
  remove: removeCommand,
  "revoke-invite": revokeInviteCommand,
  who: whoCommand,
  agents: agentsCommand,
  send: sendCommand,
  ask: askCommand,
  reply: replyCommand,
  decide: decideCommand,
  done: doneCommand,
  inbox: inboxCommand,
  editing: editingCommand,
  assist: assistCommand,
  packs: packsCommand,
  goals: goalsCommand,
  setup: setupCommand,
  "setup-prompt": (_ctx, args) => setupPromptCommand(args),
  "setup-block": () => setupBlockCommand(),
};

/** Prints an Output as text or JSON and sets the exit code. */
export const emit = (ctx: Context, args: ParsedArgs, result: Output) => {
  if (hasFlag(args, "json")) ctx.print(JSON.stringify(result.json, null, 2));
  else if (result.text.length > 0) ctx.print(result.text);
  if (result.exitCode) process.exitCode = result.exitCode;
};

/** Errors as an agent should read them: one line, plus JSON when asked. */
export const emitError = (ctx: Context, args: ParsedArgs, error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  if (hasFlag(args, "json")) ctx.print(JSON.stringify({ ok: false, error: message }, null, 2));
  else ctx.print(message);
  process.exitCode = 1;
};
