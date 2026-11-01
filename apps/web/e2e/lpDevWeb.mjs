// The Vite dev client in front of an E2E server, for runs without a built apps/web/dist:
// the scripts take `--web-port <port>` and open pages through it (single-origin dev proxies
// /api, /ws and /lp to the server).
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";

export function webPortArg(args) {
  const index = args.indexOf("--web-port");
  const value = index === -1 ? null : Number(args[index + 1]);
  return value && Number.isFinite(value) ? value : null;
}

export function startDevWeb({ repo, serverPort, webPort }) {
  const child = NodeChildProcess.spawn(NodePath.join(repo, "node_modules/.bin/vp"), ["dev"], {
    cwd: NodePath.join(repo, "apps/web"),
    env: {
      ...process.env,
      LOGICPACKS_SINGLE_ORIGIN_DEV: "1",
      LOGICPACKS_PORT: String(serverPort),
      PORT: String(webPort),
      HOST: "127.0.0.1",
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  let log = "";
  const ready = new Promise((resolve, reject) => {
    const onData = (chunk) => {
      log += chunk;
      if (log.length > 200_000) log = log.slice(-100_000);
      if (log.includes("ready in") || log.includes("Local:")) resolve();
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code) => reject(new Error(`vite dev exited (${code})\n${log.slice(-2000)}`)));
  });
  const stop = () => {
    for (const signal of ["SIGTERM", "SIGKILL"]) {
      try {
        process.kill(-child.pid, signal);
      } catch {
        return;
      }
    }
  };
  return { url: `http://127.0.0.1:${webPort}`, ready, stop };
}
