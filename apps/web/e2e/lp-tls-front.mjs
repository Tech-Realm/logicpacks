// Real https in front of local servers, as Cloudflare does in production, so a browser sees real
// origins and real Secure and __Host- cookie rules. Self-signed for *.<baseDomain> on loopback.
// route(hostname) names the upstream port for a request; everything gets x-forwarded-proto: https.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";

export function startTlsFront({ dir, baseDomain, port, route }) {
  NodeFS.mkdirSync(dir, { recursive: true });
  const key = NodePath.join(dir, "k.pem");
  const cert = NodePath.join(dir, "c.pem");
  NodeChildProcess.execFileSync(
    "openssl",
    ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", key, "-out", cert, "-days", "2", "-subj", `/CN=*.${baseDomain}`, "-addext", `subjectAltName=DNS:*.${baseDomain}`],
    { stdio: "ignore" },
  );
  const upstreamOf = (req) => route((req.headers.host ?? "").split(":")[0]);
  const server = NodeHttps.createServer(
    { key: NodeFS.readFileSync(key), cert: NodeFS.readFileSync(cert) },
    (req, res) => {
      const upstream = NodeHttp.request(
        { host: "127.0.0.1", port: upstreamOf(req), path: req.url, method: req.method, headers: { ...req.headers, "x-forwarded-proto": "https" }, agent: false },
        (answer) => {
          res.writeHead(answer.statusCode, answer.headers);
          answer.pipe(res);
        },
      );
      upstream.on("error", () => res.destroy());
      req.pipe(upstream);
    },
  );
  server.keepAliveTimeout = 120_000;
  server.headersTimeout = 125_000;
  server.on("upgrade", (req, socket, head) => {
    const upstream = NodeNet.connect(upstreamOf(req), "127.0.0.1", () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`, "x-forwarded-proto: https"];
      for (let index = 0; index < req.rawHeaders.length; index += 2) {
        if (req.rawHeaders[index].toLowerCase() !== "x-forwarded-proto") lines.push(`${req.rawHeaders[index]}: ${req.rawHeaders[index + 1]}`);
      }
      upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head.length > 0) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    socket.on("error", () => upstream.destroy());
    upstream.on("error", () => socket.destroy());
  });
  server.listen(port, "127.0.0.1");
  return {
    close: () => {
      server.closeAllConnections?.();
      server.close();
    },
  };
}
