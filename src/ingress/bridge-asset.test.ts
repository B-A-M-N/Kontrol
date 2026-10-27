/**
 * PR-D static asset gates: deploy/bridge/Caddyfile.example must implement
 * EXACTLY the bridge contract the Kontrol source defines - the
 * BRIDGE_STRIP_HEADERS list plus the X-Kontrol-* prefix rule from
 * src/ingress/proxy-context.ts, an upstream Host pin, streaming-safe
 * settings, upstream TLS verification, and the public MCP listener route
 * allowlist. A drifted asset is a security defect (headers a public edge
 * lets through become authority-bearing at the listener).
 *
 * Structural gates pin WHERE the header rules live: header_up is a
 * reverse_proxy subdirective (Caddy rejects it elsewhere), so the strip
 * list and Host pin must sit inside the ONE reverse_proxy block, and no
 * second proxy route may exist.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BRIDGE_STRIP_HEADERS, isBridgeStrippedHeader } from "./proxy-context.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const caddyfile = readFileSync(repoRoot + "/deploy/bridge/Caddyfile.example", "utf8");
const caddyLines = caddyfile.split(/\r?\n/);

// --- 1. Strip-list parity: every BRIDGE_STRIP_HEADERS entry is deleted in
// the Caddyfile, and nothing authority-bearing is allowed to be SET.
for (const header of BRIDGE_STRIP_HEADERS) {
	assert.match(
		caddyfile,
		new RegExp("^[ \t]*header_up -" + header.replace(/-/g, "\\-") + "[ \t]*$", "m"),
		"Caddyfile must delete " + header + " (BRIDGE_STRIP_HEADERS parity)",
	);
}

// The set of header_up DELETES must be exactly BRIDGE_STRIP_HEADERS: an
// extra delete (e.g. -Authorization) would pass the parity gate above
// while silently breaking every authenticated call.
const deletedNames = caddyLines
	.map((line) => line.match(/^[ \t]*header_up -([A-Za-z][A-Za-z0-9_-]*)[ \t]*$/))
	.filter((match) => match !== null)
	.map((match) => match[1]!);
assert.deepEqual(
	[...deletedNames].map((name) => name.toLowerCase()).sort(),
	[...BRIDGE_STRIP_HEADERS].map((name) => name.toLowerCase()).sort(),
	"the header_up delete set must equal BRIDGE_STRIP_HEADERS exactly (no extras, none missing)",
);

// The X-Kontrol-* prefix rule must be present as a suffix-wildcard delete.
assert.match(caddyfile, /^[ \t]*header_up -X-Kontrol-[*][ \t]*$/m, "Caddyfile must delete the whole X-Kontrol-* prefix (isBridgeStrippedHeader parity)");

// No authority-bearing header may be SET (which would inject rather than
// delete). The only permitted header_up set is the Host pin (gate 4).
// Split on REAL newlines and match per line: a split that never matches
// (e.g. on a literal backslash-n) makes this gate vacuous.
const setLines = caddyLines.filter((line) => /^[ \t]*header_up [^-]/.test(line) && !/^[ \t]*header_up Host /.test(line));
assert.deepEqual(setLines, [], "Caddyfile must never SET an authority-bearing header (only delete): " + setLines.join("; "));

// --- 2. Structure: exactly ONE reverse_proxy directive and TWO handle
// blocks (allowlist + 404 catch-all); no second proxy route may exist.
assert.match(caddyfile, /^[ \t]*handle @mcp_or_auth [{][ \t]*$/m, "the route allowlist must be bound to an explicit handle @mcp_or_auth block (a bare handle would proxy everything)");
const proxyCount = (caddyfile.match(/^[ \t]*reverse_proxy /gm) ?? []).length;
assert.equal(proxyCount, 1, "Caddyfile must contain exactly ONE reverse_proxy directive, found " + proxyCount);
const handleCount = (caddyfile.match(/^[ \t]*handle( [^{]*)?[{][ \t]*$/gm) ?? []).length;
assert.equal(handleCount, 2, "Caddyfile must contain exactly TWO handle blocks (allowlist + 404 catch-all), found " + handleCount);

// --- 3. The strip list and the Host pin must live INSIDE the
// reverse_proxy block: header_up is a reverse_proxy subdirective and
// Caddy rejects it elsewhere (the example would not even load).
const proxyStart = caddyLines.findIndex((line) => /^[ \t]*reverse_proxy /.test(line));
assert.ok(proxyStart !== -1, "reverse_proxy directive must exist");
const indentOf = (line: string): number => line.length - line.trimStart().length;
const proxyIndent = indentOf(caddyLines[proxyStart]!);
let proxyEnd = -1;
for (let i = proxyStart + 1; i < caddyLines.length; i++) {
	const line = caddyLines[i]!;
	const trimmed = line.trim();
	if (trimmed === "}" && indentOf(line) === proxyIndent) { proxyEnd = i; break; }
}
assert.ok(proxyEnd !== -1, "reverse_proxy block must be closed");
const proxyBody = caddyLines.slice(proxyStart, proxyEnd);
// Direct-child indent: one level deeper than the reverse_proxy directive.
// Excludes lines nested deeper (e.g. inside transport http {}), where
// Caddy would reject a header_up subdirective.
const childIndent = proxyIndent + 1;
for (const header of BRIDGE_STRIP_HEADERS) {
	assert.ok(
		proxyBody.some((line) => {
			if (indentOf(line) !== childIndent) return false;
			return new RegExp("^[ \t]*header_up -" + header.replace(/-/g, "\\-") + "[ \t]*$").test(line);
		}),
		"header_up -" + header + " must live INSIDE the reverse_proxy block (Caddy subdirective)",
	);
}
assert.ok(proxyBody.some((line) => indentOf(line) === childIndent && /^[ \t]*header_up Host [{]upstream_hostport[}][ \t]*$/.test(line)), "the Host pin must live INSIDE the reverse_proxy block at direct-child indent");
assert.ok(proxyBody.some((line) => indentOf(line) === childIndent && /^[ \t]*header_up -X-Kontrol-[*][ \t]*$/.test(line)), "the X-Kontrol-* delete must live INSIDE the reverse_proxy block at direct-child indent");

// --- 4. Upstream Host pin: client-supplied Host must never pass through.
assert.match(caddyfile, /^[ \t]*header_up Host [{]upstream_hostport[}][ \t]*$/m, "Caddyfile must pin the upstream Host to the upstream_hostport placeholder");

// --- 5. Streaming: flush_interval -1 and no cutoff that could fire below
// the 15-second SSE heartbeat or the 45-second POST response lifetime.
// (Caddy has no idle_timeout directive; the real risks are stream_timeout
// and a timeouts block with write_response.)
assert.match(caddyfile, /^[ \t]*flush_interval -1[ \t]*$/m, "Caddyfile must stream responses unbuffered (flush_interval -1)");
assert.doesNotMatch(caddyfile, /idle_timeout|stream_timeout/, "Caddyfile must not introduce a stream/idle cutoff");
assert.doesNotMatch(caddyfile, /timeouts [{]/, "Caddyfile must not add a timeouts block (write_response could cut off 45s POST responses)");
const readTimeout = caddyfile.match(/read_timeout ([0-9]+)s/);
assert.ok(readTimeout !== null && Number(readTimeout[1]) >= 60, "transport read_timeout must be at least 60s (SSE heartbeat 15s, POST responses 45s)");
const writeTimeout = caddyfile.match(/write_timeout ([0-9]+)s/);
assert.ok(writeTimeout !== null && Number(writeTimeout[1]) >= 60, "transport write_timeout must be at least 60s");
assert.match(caddyfile, /^[ \t]*max_header_size 32KiB[ \t]*$/m, "the public edge must cap incoming request headers");
assert.match(caddyfile, /^[ \t]*max_conns_per_host 128[ \t]*$/m, "the public edge must bound upstream connection concurrency");

// --- 6. Upstream TLS must never be weakened.
assert.doesNotMatch(caddyfile, /tls_insecure_skip_verify/, "Caddyfile must never skip upstream TLS verification");
assert.match(caddyfile, new RegExp("reverse_proxy https:"), "the reverse_proxy upstream must be HTTPS");

// --- 7. Route allowlist: exactly the public MCP listener surface. The
// matcher must be a strict path list and the file must 404 everything else.
const matcher = caddyfile.match(/@mcp_or_auth path (.+)$/m);
assert.ok(matcher !== null, "Caddyfile must define the @mcp_or_auth path matcher");
const allowedPaths = matcher![1]!.trim().split(/[ \t]+/);
assert.deepEqual(
	allowedPaths,
	["/mcp", "/.well-known/*", "/authorize", "/token", "/register", "/revoke", "/healthz"],
	"the bridge route allowlist must be exactly the public MCP listener surface",
);
assert.match(caddyfile, /^[ \t]*handle [{][ \t]*$[\s\S]*?respond 404/m, "everything outside the allowlist must 404");

// Gate 5's catch-all regex is non-greedy across a single file scan; this
// bound check proves the 404 catch-all contains NO reverse_proxy (a proxy
// here would leak every privileged path to the upstream).
const catchAllStart = caddyLines.findIndex((line) => line.trim() === "handle {");
assert.ok(catchAllStart !== -1, "404 catch-all handle block must exist");
let catchAllEnd = -1;
for (let i = catchAllStart + 1; i < caddyLines.length; i++) {
	// Depth-tracked close: nested blocks inside the catch-all must not
	// truncate the bound check before a later reverse_proxy.
	if (caddyLines[i]!.trim() === "}") { catchAllEnd = i; break; }
}
assert.ok(catchAllEnd !== -1, "catch-all handle block must be closed");
const catchAllBody = caddyLines.slice(catchAllStart, catchAllEnd).join("\n");
assert.ok(!catchAllBody.includes("reverse_proxy"), "the 404 catch-all must never contain a reverse_proxy");

// --- 8. No privileged route may appear anywhere in the allowlist.
for (const forbidden of ["/acp", "/diagnostics", "/readyz", "/core-readyz", "/workspaces", "/ui"]) {
	assert.ok(
		!allowedPaths.includes(forbidden),
		"the route allowlist must never include the privileged route " + forbidden,
	);
}

// --- 9. isBridgeStrippedHeader contract sanity (the rule the Caddyfile
// mirrors): the X-Kontrol prefix matches arbitrary suffixes, exact names
// match case-insensitively, and non-authority headers do not match.
assert.equal(isBridgeStrippedHeader("X-Kontrol-Role"), true);
assert.equal(isBridgeStrippedHeader("x-kontrol-operation-id"), true);
assert.equal(isBridgeStrippedHeader("tailscale-user-login"), true);
assert.equal(isBridgeStrippedHeader("Mcp-Session-Id"), false);
assert.equal(isBridgeStrippedHeader("Last-Event-ID"), false);
assert.equal(isBridgeStrippedHeader("Accept"), false);

// --- 10. Body limit and HSTS present (edge hardening). The edge cap must
// match the public listener's own MCP body bound (8MB,
// src/server/mcp-session-state.ts) so a request accepted at the edge is
// not rejected only at the bridge.
const maxSize = caddyfile.match(/max_size ([0-9]+)MB/);
assert.ok(maxSize !== null && Number(maxSize[1]) >= 8, "edge max_size must be at least the listener's 8MB MCP body bound");
assert.match(caddyfile, /Strict-Transport-Security/, "Caddyfile must set HSTS");

// Optional independent private-link route. Both edge paths terminate the same
// host gateway; retries remain disabled so an uncertain MCP POST is never replayed.
const multipath = readFileSync(repoRoot + "/deploy/bridge/Caddyfile.multipath.example", "utf8");
const gateway = readFileSync(repoRoot + "/deploy/bridge/KontrolGateway.Caddyfile.example", "utf8");
assert.match(multipath, /reverse_proxy https:\/\/100\.64\.0\.2:9444 https:\/\/10\.74\.0\.2:9444/);
assert.match(multipath, /lb_policy first/);
assert.match(multipath, /health_uri \/healthz/);
assert.doesNotMatch(multipath, /lb_retries|lb_try_duration|lb_retry_match/);
assert.match(multipath, /tls_server_name kontrol-gateway\.internal/);
assert.match(multipath, /tls_trust_pool file \/etc\/caddy\/pki\/kontrol-gateway-ca\.pem/);
assert.match(multipath, /tls_client_auth \/etc\/caddy\/pki\/bridge-client\.crt \/etc\/caddy\/pki\/bridge-client\.key/);
assert.match(multipath, /header_up Host kontrol-gateway\.internal:9444/);
for (const header of BRIDGE_STRIP_HEADERS) assert.match(multipath, new RegExp("^[ \\t]*header_up -" + header.replace(/-/g, "\\-") + "[ \\t]*$", "m"));
assert.match(gateway, /bind 100\.64\.0\.2 10\.74\.0\.2/);
assert.match(gateway, /mode require_and_verify/);
assert.match(gateway, /trust_pool file \/etc\/kontrol\/gateway\/bridge-client-ca\.pem/);
assert.match(gateway, /@bridge remote_ip 100\.64\.0\.3 10\.74\.0\.3/);
assert.match(gateway, /reverse_proxy 127\.0\.0\.1:7678/);
assert.doesNotMatch(gateway, /tls_insecure_skip_verify/);
assert.equal((multipath.match(/^[ \t]*reverse_proxy /gm) ?? []).length, 1);
assert.equal((gateway.match(/^[ \t]*reverse_proxy /gm) ?? []).length, 1);
