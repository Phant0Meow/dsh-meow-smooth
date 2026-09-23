// src/compress-proxy.ts
import http from "node:http";
import zlib from "node:zlib";
function resolveTargetPort() {
  const argv = process.argv;
  const idx = argv.indexOf("--port");
  if (idx !== -1 && idx + 1 < argv.length) {
    const value = Number(argv[idx + 1]);
    if (Number.isFinite(value) && value > 0 && value < 65536) return value;
  }
  return 3080;
}
function startCompressProxy(options) {
  const { port, targetPort } = options;
  let mode = options.mode ?? "gzip";
  const server = http.createServer((req, res) => {
    const upstream = http.request(
      {
        host: "127.0.0.1",
        port: targetPort,
        path: req.url,
        method: req.method,
        // Host/Origin/Accept-Encoding 等全部原样透传：信任围栏按原 Host 校验，
        // 手机域名（node.tailxxxx.ts.net:8443）在 trusted-host 白名单内放行。
        headers: { ...req.headers }
      },
      (up) => {
        const contentType = up.headers["content-type"] ?? "";
        const wantsGzip = (req.headers["accept-encoding"] ?? "").includes("gzip");
        const isUnaryJson = req.method === "POST" && (req.url ?? "").startsWith("/api/") && contentType.includes("application/json");
        const upstreamEncoded = up.headers["content-encoding"] !== void 0;
        if (mode === "gzip" && isUnaryJson && wantsGzip && !upstreamEncoded) {
          const headers = { ...up.headers };
          delete headers["content-length"];
          res.writeHead(up.statusCode ?? 200, { ...headers, "content-encoding": "gzip", "vary": "accept-encoding" });
          up.pipe(zlib.createGzip()).pipe(res);
        } else {
          res.writeHead(up.statusCode ?? 200, up.headers);
          up.pipe(res);
        }
      }
    );
    upstream.on("error", (error) => {
      res.writeHead(502, { "content-type": "text/plain" });
      res.end(`meow-smooth compress-proxy: upstream error: ${error.message}`);
    });
    req.pipe(upstream);
  });
  server.on("upgrade", (req, socket, head) => {
    const upstream = http.request({
      host: "127.0.0.1",
      port: targetPort,
      path: req.url,
      method: req.method,
      // 显式 Upgrade/Connection 头：Node http.request 默认按 keep-alive 管理
      // connection，不显式传会把 Upgrade 请求降级成普通请求（上游 426）。
      headers: { ...req.headers, connection: "Upgrade", upgrade: "websocket" }
    });
    upstream.on("upgrade", (upRes, upSocket, upHead) => {
      socket.write(`HTTP/1.1 101 Switching Protocols\r
${Object.entries(upRes.headers).map(([key, value]) => `${key}: ${value}`).join("\r\n")}\r
\r
`);
      if (upHead.length > 0) socket.write(upHead);
      socket.pipe(upSocket).pipe(socket);
    });
    upstream.on("response", (upRes) => {
      socket.write(`HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage ?? ""}\r
\r
`);
      socket.end();
      upRes.resume();
    });
    upstream.on("error", () => socket.destroy());
    upstream.end();
  });
  server.on("error", (error) => {
    if (error.code === "EADDRINUSE") {
      console.warn(`[meow-smooth] compress proxy port ${port} already in use \u2014 set proxy.port in config`);
    } else {
      console.warn(`[meow-smooth] compress proxy error: ${error.message}`);
    }
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(`[meow-smooth] compress proxy on 127.0.0.1:${port} -> 127.0.0.1:${targetPort} (mode: ${mode})`);
  });
  return {
    server,
    setMode(next) {
      if (mode === next) return;
      mode = next;
      console.log(`[meow-smooth] compress proxy mode switched to ${next} (zero downtime, same server)`);
    }
  };
}
async function detectOfficialGzip(targetPort, attempts = 6, delayMs = 150) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    const verdict = await new Promise((resolve) => {
      const req = http.get(
        { host: "127.0.0.1", port: targetPort, path: "/plugins/meow-smooth/client.js", headers: { "accept-encoding": "gzip" } },
        (res) => {
          res.resume();
          if (res.statusCode !== 200) {
            resolve("unready");
            return;
          }
          resolve(res.headers["content-encoding"] === "gzip" ? "gzip" : "plain");
        }
      );
      req.setTimeout(1e3, () => {
        req.destroy(new Error("detect timeout"));
      });
      req.on("error", () => resolve("unready"));
    });
    if (verdict === "gzip") return true;
    if (verdict === "plain") return false;
  }
  return false;
}
export {
  detectOfficialGzip,
  resolveTargetPort,
  startCompressProxy
};
