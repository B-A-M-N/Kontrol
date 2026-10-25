import assert from "node:assert/strict";
import { createCaddyQualificationReceipt } from "./qualify-caddy-bridge.mjs";

const paths = ["/mcp", "/.well-known/*", "/authorize", "/token", "/register", "/revoke", "/healthz"];
const configText = `kontrol.example.com {
\trequest_body { max_size 8MB }
\theader { Strict-Transport-Security "max-age=31536000" }
\tmax_header_size 32KiB
\t@mcp_or_auth path ${paths.join(" ")}
\thandle @mcp_or_auth {
\t\treverse_proxy https://kontrol-node.tail-scale.ts.net:9443 {
\t\t\theader_up -Forwarded
\t\t	header_up -X-Kontrol-*
\t\t	header_up Host {upstream_hostport}
\t\t	max_conns_per_host 128
\t\t}
\t}
\thandle { respond 404 }
}`;
function adapted({ upstream = "kontrol-node.tail-scale.ts.net:9443", upstreams, host = "{http.reverse_proxy.upstream.hostport}", paths: routePaths = paths, insecure = false } = {}) {
  return {
    apps: { http: { servers: { srv: { routes: [
      { match: [{ path: routePaths }], handle: [{ handler: "subroute", routes: [{ handle: [{
        handler: "reverse_proxy",
        upstreams: (upstreams ?? [upstream]).map((dial) => ({ dial })),
        headers: { request: { set: { Host: [host] } } },
        transport: insecure ? { tls: { insecure_skip_verify: true } } : { tls: {} },
      }] }] }] },
      { handle: [{ handler: "static_response", status_code: 404 }] },
    ] } } } },
  };
}

const receipt = createCaddyQualificationReceipt({
  configText,
  configPath: "/etc/caddy/Caddyfile",
  caddyVersion: "v2.9.1 h1:example",
  bridgeNode: "tag:kontrol-bridge",
  publicHost: "kontrol.example.com",
  expectedUpstream: "kontrol-node.tail-scale.ts.net:9443",
  buildId: "build-test-1",
  requiredStripHeaders: ["Forwarded"],
  adaptedConfig: adapted(),
  qualifiedAt: "2026-10-25T12:00:00.000Z",
});
assert.equal(receipt.schemaVersion, 1);
assert.equal(receipt.evidenceTier, "config_validated");
assert.equal(receipt.routeIsolation, "not_proven_by_config_validation");
assert.equal(receipt.configSha256.length, 64);
assert.throws(() => createCaddyQualificationReceipt({ configText, configPath: "/etc/caddy/Caddyfile", caddyVersion: "v2", bridgeNode: "bridge", publicHost: "evil.example.com", expectedUpstream: "kontrol-node.tail-scale.ts.net:9443", buildId: "build-test-1", requiredStripHeaders: ["Forwarded"], adaptedConfig: adapted() }), /public host/);
assert.throws(() => createCaddyQualificationReceipt({ configText, configPath: "/etc/caddy/Caddyfile", caddyVersion: "v2", bridgeNode: "bridge", publicHost: "kontrol.example.com", expectedUpstream: "evil.example:9443", buildId: "build-test-1", requiredStripHeaders: ["Forwarded"], adaptedConfig: adapted() }), /upstream or Host pin/);
assert.throws(() => createCaddyQualificationReceipt({ configText, configPath: "/etc/caddy/Caddyfile", caddyVersion: "v2", bridgeNode: "bridge", publicHost: "kontrol.example.com", expectedUpstream: "kontrol-node.tail-scale.ts.net:9443", buildId: "build-test-1", requiredStripHeaders: ["Forwarded"], adaptedConfig: adapted({ paths: ["/"] }) }), /route paths/);
assert.throws(() => createCaddyQualificationReceipt({ configText, configPath: "/etc/caddy/Caddyfile", caddyVersion: "v2", bridgeNode: "bridge", publicHost: "kontrol.example.com", expectedUpstream: "kontrol-node.tail-scale.ts.net:9443", buildId: "build-test-1", requiredStripHeaders: ["Forwarded"], adaptedConfig: adapted({ insecure: true }) }), /TLS verification/);

const multipathConfig = configText
  .replace("reverse_proxy https://kontrol-node.tail-scale.ts.net:9443 {", "reverse_proxy https://100.64.0.2:9444 https://10.74.0.2:9444 {")
  .replace("\t\t\theader_up Host {upstream_hostport}", "\t\t\tlb_policy first\n\t\t\thealth_uri /healthz\n\t\t\ttransport http {\n\t\t\t\ttls_server_name kontrol-gateway.internal\n\t\t\t\ttls_trust_pool file /etc/caddy/pki/kontrol-gateway-ca.pem\n\t\t\t\ttls_client_auth /etc/caddy/pki/bridge-client.crt /etc/caddy/pki/bridge-client.key\n\t\t\t}\n\t\t\theader_up Host kontrol-gateway.internal:9444");
const multipathReceipt = createCaddyQualificationReceipt({
  configText: multipathConfig,
  configPath: "/etc/caddy/Caddyfile",
  caddyVersion: "v2.11.0 h1:example",
  bridgeNode: "tag:kontrol-bridge",
  publicHost: "kontrol.example.com",
  expectedUpstream: "100.64.0.2:9444,10.74.0.2:9444",
  expectedHost: "kontrol-gateway.internal:9444",
  buildId: "build-test-2",
  requiredStripHeaders: ["Forwarded"],
  adaptedConfig: adapted({ upstreams: ["100.64.0.2:9444", "10.74.0.2:9444"], host: "kontrol-gateway.internal:9444" }),
});
assert.deepEqual(multipathReceipt.upstreams, ["100.64.0.2:9444", "10.74.0.2:9444"]);
assert.equal(multipathReceipt.upstreamSelection, "first_healthy_active_check");
assert.equal(multipathReceipt.automaticRetries, false);
assert.throws(() => createCaddyQualificationReceipt({
  configText: multipathConfig.replace("lb_policy first", "lb_policy first\n\t\t\tlb_retries 1"),
  configPath: "/etc/caddy/Caddyfile", caddyVersion: "v2.11.0", bridgeNode: "bridge", publicHost: "kontrol.example.com",
  expectedUpstream: "100.64.0.2:9444,10.74.0.2:9444", expectedHost: "kontrol-gateway.internal:9444", buildId: "build-test-2",
  requiredStripHeaders: ["Forwarded"], adaptedConfig: adapted({ upstreams: ["100.64.0.2:9444", "10.74.0.2:9444"], host: "kontrol-gateway.internal:9444" }),
}), /must not retry/);
console.log("Caddy bridge qualification tests passed");
