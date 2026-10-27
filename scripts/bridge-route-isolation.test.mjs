import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  evaluateIsolationObservation,
  leakedAuthorityHeaders,
  missingPreservedHeaders,
  renderIsolationConfig,
} from "./bridge-route-isolation.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const caddyfile = readFileSync(repoRoot + "/deploy/bridge/Caddyfile.example", "utf8");

// --- the render touches ONLY the site address and the upstream target ---
{
  const rendered = renderIsolationConfig(caddyfile, { siteAddress: "http://127.0.0.1:19482", upstreamUrl: "http://127.0.0.1:9999" });
  assert.match(rendered, /^http:\/\/127\.0\.0\.1:19482 \{$/m, "the site address is rebound for the test");
  assert.match(rendered, /reverse_proxy http:\/\/127\.0\.0\.1:9999 \{/, "the upstream is retargeted at the controlled upstream");
  assert.ok(!rendered.includes("kontrol.example.com {"), "the production site block is gone");
  assert.ok(!rendered.includes("kontrol-node.tail-scale.ts.net:9443"), "the production upstream is gone");
  // Every route/header/handle directive survives byte for byte.
  for (const directive of [
    "@mcp_or_auth path /mcp /.well-known/* /authorize /token /register /revoke /healthz",
    "handle @mcp_or_auth {",
    "header_up -X-Kontrol-*",
    "header_up -X-Forwarded-Host",
    "header_up Host {upstream_hostport}",
    "handle {",
    "respond 404",
    "max_header_size 32KiB",
    "max_conns_per_host 128",
    "max_size 8MB",
  ]) {
    assert.ok(rendered.includes(directive), "the rendered config keeps: " + directive);
  }
  // The upstream TLS timeout cannot survive a plain-HTTP upstream, and it
  // governs TLS only — never routing or headers.
  assert.ok(!rendered.includes("tls_timeout"), "the upstream TLS timeout is dropped for the plain-HTTP controlled upstream");
}

// --- a plain-HTTP upstream keeps the transport block otherwise intact ---
{
  const rendered = renderIsolationConfig(caddyfile, { siteAddress: "http://127.0.0.1:19482", upstreamUrl: "https://127.0.0.1:9999" });
  assert.ok(rendered.includes("tls_timeout 10s"), "an HTTPS controlled upstream keeps the upstream TLS timeout");
}

// --- a configuration without a site block is refused ---
assert.throws(
  () => renderIsolationConfig("# no site block here\n", { siteAddress: "http://127.0.0.1:1", upstreamUrl: "http://127.0.0.1:2" }),
  /no site block/,
);
assert.throws(
  () => renderIsolationConfig("example.com {\n\trespond 404\n}\n", { siteAddress: "http://127.0.0.1:1", upstreamUrl: "http://127.0.0.1:2" }),
  /no reverse_proxy directive/,
);

// --- the isolation decision distinguishes the bridge's 404 from the upstream's ---
{
  const forbidden = evaluateIsolationObservation({ path: "/diagnostics", bridgeStatus: 404, upstreamStatus: 200 });
  assert.equal(forbidden.ok, true, "the bridge's own 404 wins even when the controlled upstream answered 200");
  const forwarded = evaluateIsolationObservation({ path: "/diagnostics", bridgeStatus: 200, upstreamStatus: 200 });
  assert.equal(forwarded.ok, false, "a proxy that forwards a forbidden path fails the isolation check");
  const allowed = evaluateIsolationObservation({ path: "/mcp", bridgeStatus: 200, upstreamStatus: 200 });
  assert.equal(allowed.ok, true, "an allowlisted route must reach the upstream");
  const allowedBroken = evaluateIsolationObservation({ path: "/mcp", bridgeStatus: 502, upstreamStatus: 0 });
  assert.equal(allowedBroken.ok, false, "an allowlisted route that never reached the upstream fails");
}

// --- authority headers must never reach the upstream ---
{
  const seen = { host: "127.0.0.1:9999", authorization: "Bearer x", "mcp-session-id": "s", "last-event-id": "1", accept: "application/json", "content-type": "application/json" };
  assert.deepEqual(leakedAuthorityHeaders(seen), [], "a clean upstream request leaks nothing");
  assert.deepEqual(missingPreservedHeaders(seen), [], "the MCP contract headers survive the edge");
  assert.deepEqual(
    leakedAuthorityHeaders({ ...seen, "x-kontrol-role": "reviewer" }),
    ["x-kontrol-role"],
    "a forged authority header is detected",
  );
  assert.deepEqual(
    missingPreservedHeaders({ ...seen, authorization: undefined }),
    ["authorization"],
    "a stripped authorization header is detected",
  );
}

console.log("bridge-route-isolation.test.mjs: isolation decision assertions passed");
