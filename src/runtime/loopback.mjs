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
    server.listen(port, "127.0.0.1", () => {
      resolve({
        origin: `http://127.0.0.1:${server.address().port}`,
        port: server.address().port,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}
