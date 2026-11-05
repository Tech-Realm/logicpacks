import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

/** The key file the app's server writes next to server-runtime.json (see helperHttp.ts). */
export const LOCAL_HELPER_KEY_FILE = "helper-local.key";

export const OPEN_THE_APP =
  "Open the LogicPacks app (download: https://logicpacks.io/download), then run lp login again. LogicPacks cloud is coming soon.";

export const NOT_CONNECTED = `LogicPacks is not connected on this computer. Run lp login. ${OPEN_THE_APP}`;

export interface LocalHost {
  readonly origin: string;
  /** The folder holding server-runtime.json and the key file. */
  readonly stateDir: string;
}

const alive = (pid: number) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** Data folders the app may run from: LOGICPACKS_HOME, then ~/.logicpacks. */
const stateDirs = (env: Readonly<Record<string, string | undefined>>, home: string) => {
  const homes = [env.LOGICPACKS_HOME, NodePath.join(home, ".logicpacks")];
  const dirs: Array<string> = [];
  for (const base of homes) {
    if (!base) continue;
    for (const name of ["userdata", "dev"]) dirs.push(NodePath.join(base, name));
  }
  return dirs;
};

/** The LogicPacks app server running on this machine, found from its runtime file. */
export const discoverLocalHost = (
  env: Readonly<Record<string, string | undefined>> = process.env,
  home: string = NodeOS.homedir(),
): LocalHost | null => {
  for (const stateDir of stateDirs(env, home)) {
    try {
      const runtime = JSON.parse(
        NodeFS.readFileSync(NodePath.join(stateDir, "server-runtime.json"), "utf8"),
      ) as { pid?: unknown; origin?: unknown; port?: unknown };
      const origin =
        typeof runtime.origin === "string"
          ? runtime.origin
          : typeof runtime.port === "number"
            ? `http://127.0.0.1:${runtime.port}`
            : null;
      if (origin === null || !alive(Number(runtime.pid))) continue;
      if (!/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(origin)) continue;
      return { origin, stateDir };
    } catch {}
  }
  return null;
};

export const readLocalKey = (host: LocalHost): string | null => {
  try {
    const key = NodeFS.readFileSync(
      NodePath.join(host.stateDir, LOCAL_HELPER_KEY_FILE),
      "utf8",
    ).trim();
    return key.length > 0 ? key : null;
  } catch {
    return null;
  }
};

export const isLocalOrigin = (server: string | null) =>
  server !== null && /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\/?$/.test(server);
