// Loopback forwarder to AgentOS.
//
// AgentOS refuses write APIs from a non-loopback origin. Verified against
// 0.7.6 from a separate service on the overlay network:
//
//   GET  /api/operations   → 200   (safe methods bypass the origin guard)
//   POST /api/mission      → 403   "Unsafe remote mutation blocked. Use
//                                   same-origin localhost or configure an exact
//                                   HTTPS origin with AGENTOS_TRUSTED_OPERATOR_ORIGINS"
//
// The alternative — TLS plus an exact allowed origin — means certificates and a
// host match for traffic that never leaves the overlay. Forwarding a loopback
// port is the same trick POC-1 already uses for AgentOS → Gateway
// (images/agentos/loopback-proxy.mjs), so the pattern is established rather
// than invented here.
import { createConnection, createServer } from "node:net";

export function startLoopbackForwarder({ port = 3000, upstreamHost, upstreamPort = 3000 } = {}) {
  if (!upstreamHost) throw new Error("loopback forwarder needs an upstream host");

  if (typeof Bun !== "undefined") {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port,
      async fetch(request) {
        const source = new URL(request.url);
        const target = new URL(`${source.pathname}${source.search}`, `http://${upstreamHost}:${upstreamPort}`);
        const init = {
          method: request.method,
          headers: request.headers,
          redirect: "manual",
        };
        if (!['GET', 'HEAD'].includes(request.method)) init.body = request.body;
        return fetch(target, init);
      },
    });
    return Promise.resolve({
      origin: `http://127.0.0.1:${server.port}`,
      port: server.port,
      close: async () => server.stop(true),
    });
  }

  const server = createServer((socket) => {
    const upstream = createConnection({ host: upstreamHost, port: upstreamPort });
    let connected = false;
    upstream.on("connect", () => {
      connected = true;
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    // A refused upstream must close the client socket rather than leave the
    // caller hanging until its own timeout.
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
    upstream.on("close", () => (connected ? socket.end() : socket.destroy()));
    socket.on("close", () => upstream.end());
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    // Bound to 127.0.0.1 only: this port grants operator-scope access to
    // AgentOS and must not be reachable from the overlay.
    const listenPort = port === 0 && typeof Bun !== "undefined"
      ? 20_000 + crypto.getRandomValues(new Uint16Array(1))[0] % 30_000
      : port;
    server.listen(listenPort, "127.0.0.1", () => {
      resolve({
        origin: `http://127.0.0.1:${server.address().port}`,
        port: server.address().port,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}
