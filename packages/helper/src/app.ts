// oxlint-disable logicpacks/no-global-process-runtime -- plain Node CLI shipped as one file; there is no Effect runtime to inject.
/**
 * `lp app`: semantic ops on the apps the host shares (Blender, DaVinci Resolve,
 * any macOS app). Every op lands in the project's action log under your agent's
 * name. Ops that change something need the host, or control granted by the host.
 */
import { callHost, gitInfo } from "./client.ts";
import { loadConfig } from "./store.ts";

const say = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

export const APP_HELP = `lp app: work in the apps shared on the host (Blender, DaVinci Resolve, any app).

  lp app ops                         every op, and what is shared right now
  lp app run <op> [args...]          run one, e.g. lp app run blender.move Vase z 1.24
  lp app log                         the project's action log
  options: --project <id> (default: this folder's project), --agent <name>, --json, --no-snapshot
`;

interface OpSpec {
  readonly name: string;
  readonly usage: string;
  readonly summary: string;
  readonly mutates: boolean;
  readonly app: string;
}

const takeFlag = (args: string[], name: string, hasValue = true): string | true | null => {
  const index = args.indexOf(`--${name}`);
  if (index < 0) return null;
  const value = hasValue ? (args[index + 1] ?? null) : true;
  args.splice(index, hasValue ? 2 : 1);
  return value;
};

export async function appCommand(input: ReadonlyArray<string>): Promise<void> {
  const args = [...input];
  const sub = args.shift() ?? "help";
  const projectId = takeFlag(args, "project");
  const agent = takeFlag(args, "agent");
  const asJson = takeFlag(args, "json", false) === true;
  const noSnapshot = takeFlag(args, "no-snapshot", false) === true;
  const config = loadConfig();
  const cwd = process.cwd();
  const git = gitInfo(cwd);
  const target =
    typeof projectId === "string"
      ? { projectId }
      : { location: { cwd, gitRoot: git.root, gitRemote: git.remote } };
  const query =
    typeof projectId === "string"
      ? `projectId=${encodeURIComponent(projectId)}`
      : `cwd=${encodeURIComponent(git.root ?? cwd)}`;

  switch (sub) {
    case "ops": {
      const out = await callHost<{
        projectId: string;
        canControl: boolean;
        shared: { appName: string; title: string; recipeId: string | null } | null;
        ops: OpSpec[];
        guide?: string;
      }>(config, `/api/lp/apps/ops?${query}`);
      if (asJson) return say(JSON.stringify(out, null, 2));
      if (out.guide) say(`${out.guide}\n`);
      say(
        out.shared
          ? `Shared now: ${out.shared.appName} (${out.shared.title})${out.shared.recipeId ? `, recipe ${out.shared.recipeId}` : ""}`
          : "Nothing is shared right now. The host picks an app with Share an app.",
      );
      say(
        out.canControl
          ? "You can run every op."
          : "You can run read-only ops. Ops marked * need control from the host.",
      );
      let group = "";
      for (const op of out.ops) {
        if (op.app !== group) {
          group = op.app;
          say(
            `\n${group === "any" ? "Any app" : group === "blender" ? "Blender" : "DaVinci Resolve"}`,
          );
        }
        say(`  ${op.mutates ? "*" : " "} ${op.usage.padEnd(52)} ${op.summary}`);
      }
      return;
    }
    case "run": {
      const op = args.shift();
      if (!op) return say("Usage: lp app run <op> [args...]. See lp app ops.");
      const out = await callHost<{
        ok: boolean;
        result: unknown;
        entry: { actor: string; op: string; detail: string };
        autoSnapshot?: string;
      }>(config, "/api/lp/apps/run", {
        body: {
          ...target,
          op,
          args,
          ...(typeof agent === "string" ? { agent } : {}),
          ...(noSnapshot ? { noSnapshot: true } : {}),
        },
        timeoutMs: 180_000,
      });
      if (asJson) return say(JSON.stringify(out, null, 2));
      if (out.autoSnapshot) say(`Snapshot first: ${out.autoSnapshot}`);
      say(`${out.entry.actor}: ${out.entry.op} ${out.entry.detail}`.trim());
      if (out.result !== undefined) say(JSON.stringify(out.result, null, 2));
      return;
    }
    case "log": {
      if (typeof projectId !== "string") {
        const ops = await callHost<{ projectId: string }>(config, `/api/lp/apps/ops?${query}`);
        return printLog(config, ops.projectId, asJson);
      }
      return printLog(config, projectId, asJson);
    }
    default:
      return say(APP_HELP);
  }
}

async function printLog(config: ReturnType<typeof loadConfig>, projectId: string, asJson: boolean) {
  const out = await callHost<{
    entries: Array<{ atMs: number; actor: string; op: string; detail: string; ok: boolean }>;
  }>(config, `/api/lp/apps/log?projectId=${encodeURIComponent(projectId)}`);
  if (asJson) return say(JSON.stringify(out, null, 2));
  if (out.entries.length === 0) return say("No actions yet.");
  for (const entry of out.entries) {
    say(
      `${new Date(entry.atMs).toLocaleTimeString()}  ${entry.actor}: ${entry.op} ${entry.detail}${entry.ok ? "" : "  (failed)"}`,
    );
  }
}
