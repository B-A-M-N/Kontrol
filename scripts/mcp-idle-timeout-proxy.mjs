#!/usr/bin/env node
// Small localhost-only intermediary harness for MCP watcher qualification.
// It forwards HTTP requests and closes a response that receives no bytes for
// the configured interval, matching the failure mode of an idle-reaping
// proxy. It intentionally has no authentication or public-listener behavior;
// use the real tunnel for external acceptance.
import { request as httpRequest, createServer } from "node:http";
import { request as httpsRequest } from "node:https";

const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

const target = new URL(option("--target", "http://127.0.0.1:7676"));
const host = String(option("--host", "127.0.0.1"));
const port = Number(option("--port", "8787"));
const idleTimeoutMs = Number(option("--idle-timeout-ms", "25000"));

if (!/^https?:$/.test(target.protocol)) throw new Error("--target must use http or https");
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("--port must be an integer between 1 and 65535");
if (!Number.isInteger(idleTimeoutMs) || idleTimeoutMs < 1_000 || idleTimeoutMs > 300_000) {
  throw new Error("--idle-timeout-ms must be an integer between 1000 and 300000");
}

const requestImpl = target.protocol === "https:" ? httpsRequest : httpRequest;

const server = createServer((clientRequest, clientResponse) => {
  const upstreamUrl = new URL(clientRequest.url || "/", target);
  const headers = { ...clientRequest.headers, host: upstreamUrl.host };
  const upstream = requestImpl({
    protocol: upstreamUrl.protocol,
    hostname: upstreamUrl.hostname,
    port: upstreamUrl.port || undefined,
    method: clientRequest.method,
    path: `${upstreamUrl.pathname}${upstreamUrl.search}`,
    headers,
  });

  let timer;
  let settled = false;
  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  const arm = () => {
    clear();
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      upstream.destroy(new Error(`idle response exceeded ${idleTimeoutMs}ms`));
      if (!clientResponse.headersSent) {
        clientResponse.writeHead(504, { "content-type": "text/plain; charset=utf-8" });
        clientResponse.end("intermediary idle timeout\n");
      } else {
        clientResponse.destroy();
      }
    }, idleTimeoutMs);
    timer.unref?.();
  };

  upstream.once("response", (upstreamResponse) => {
    if (settled) return;
    clientResponse.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
    arm();
    upstreamResponse.on("data", arm);
    upstreamResponse.once("end", () => {
      settled = true;
      clear();
    });
    upstreamResponse.once("aborted", () => {
      settled = true;
      clear();
      clientResponse.destroy();
    });
    upstreamResponse.pipe(clientResponse);
  });
  upstream.once("error", (error) => {
    if (settled) return;
    settled = true;
    clear();
    if (!clientResponse.headersSent) {
      clientResponse.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      clientResponse.end(`upstream error: ${error instanceof Error ? error.message : String(error)}\n`);
    } else {
      clientResponse.destroy();
    }
  });
  clientRequest.once("aborted", () => {
    settled = true;
    clear();
    upstream.destroy();
  });
  clientResponse.once("close", () => {
    clear();
    if (!settled) {
      settled = true;
      upstream.destroy();
    }
  });
  // This covers the interval before upstream sends response headers.
  arm();
  clientRequest.pipe(upstream);
});

server.listen(port, host, () => {
  console.log(JSON.stringify({
    ok: true,
    proxy: `http://${host}:${port}`,
    target: target.origin,
    idleTimeoutMs,
  }));
});

function close() {
  server.close(() => process.exit(0));
}
process.once("SIGINT", close);
process.once("SIGTERM", close);
