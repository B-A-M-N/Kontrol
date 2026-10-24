import assert from "node:assert/strict";
import {
  BRIDGE_STRIP_HEADERS,
  TS_IDENTITY_HEADERS,
  extractUntrustedTailscaleIdentity,
  isBridgeStrippedHeader,
  isIpLiteral,
  normalizeIpLiteral,
  normalizeTrustedPeers,
  resolveClientIp,
} from "./proxy-context.js";
import type { ResolveClientIpInput } from "./proxy-context.js";

const direct = (input: Omit<ResolveClientIpInput, "policy">) => resolveClientIp({ ...input, policy: { mode: "direct" } });

// --- direct mode spoof resistance ---
{
  const result = direct({ remoteAddress: "10.0.0.5", xForwardedFor: "1.2.3.4" });
  assert.deepEqual(result, { ip: "10.0.0.5", proxied: false, chainLength: 0, rejectedForwarded: true },
    "direct mode ignores XFF and reports rejection");
}
{
  const result = direct({ remoteAddress: "10.0.0.5", cfConnectingIp: "1.2.3.4" });
  assert.equal(result.ip, "10.0.0.5", "direct mode ignores CF-Connecting-IP");
  assert.equal(result.rejectedForwarded, true);
}
{
  const result = direct({ remoteAddress: "10.0.0.5" });
  assert.equal(result.rejectedForwarded, false, "no forwarded headers present");
}

// --- exact_peers ---
const peers = { mode: "exact_peers" as const, peers: ["100.64.0.1", "fd7a:115c:a1e0::1"], maxChainLength: 3 };
{
  const result = resolveClientIp({
    remoteAddress: "100.64.0.1",
    xForwardedFor: "203.0.113.7, 100.64.0.9",
    policy: peers,
  });
  assert.deepEqual(result, { ip: "203.0.113.7", proxied: true, chainLength: 2, rejectedForwarded: false },
    "trusted peer chain resolves to original client");
}
{
  const result = resolveClientIp({ remoteAddress: "9.9.9.9", xForwardedFor: "203.0.113.7", policy: peers });
  assert.deepEqual(result, { ip: "9.9.9.9", proxied: false, chainLength: 0, rejectedForwarded: true },
    "untrusted remoteAddress: forwarded headers rejected");
}
{
  const result = resolveClientIp({
    remoteAddress: "100.64.0.1",
    xForwardedFor: "1.1.1.1, 2.2.2.2, 3.3.3.3, 4.4.4.4",
    policy: peers,
  });
  assert.deepEqual(result, { ip: "100.64.0.1", proxied: false, chainLength: 4, rejectedForwarded: true },
    "chain exceeding maxChainLength is fail-closed rejected");
}
{
  // Empty entries in the chain are dropped by split/trim; a header containing
  // only empties carries no usable chain, so nothing was "present and not
  // honored" — rejectedForwarded is false under the corrected semantics.
  const result = resolveClientIp({ remoteAddress: "100.64.0.1", xForwardedFor: "  ,  ", policy: peers });
  assert.equal(result.rejectedForwarded, false);
  assert.equal(result.ip, "100.64.0.1");
}
{
  // Trusted peer with NO forwarded headers: nothing was rejected.
  const result = resolveClientIp({ remoteAddress: "100.64.0.1", policy: peers });
  assert.deepEqual(result, { ip: "100.64.0.1", proxied: false, chainLength: 0, rejectedForwarded: false },
    "empty/absent forwarded headers -> rejectedForwarded false");
}
{
  // IPv6 peer match accepted.
  const result = resolveClientIp({ remoteAddress: "fd7a:115c:a1e0::1", cfConnectingIp: "203.0.113.9", policy: peers });
  assert.deepEqual(result, { ip: "203.0.113.9", proxied: true, chainLength: 1, rejectedForwarded: false });
}

// --- isIpLiteral ---
for (const good of ["127.0.0.1", "100.64.0.1", "0.0.0.0", "::1", "fd7a:115c:a1e0::1", "2001:db8::8a2e:370:7334"]) {
  assert.equal(isIpLiteral(good), true, `literal accepted: ${good}`);
}
for (const bad of ["100.64.0.0/10", "10.0.0.0/8", "10.0.0.1-20", "*", "", "example.com", "100.64.0.256", "not-an-ip"]) {
  assert.equal(isIpLiteral(bad), false, `non-literal rejected: ${bad}`);
}

// --- IPv4-mapped IPv6 normalization ---
assert.equal(normalizeIpLiteral("::ffff:100.64.0.1"), "100.64.0.1", "mapped IPv6 reduced to IPv4");
assert.equal(normalizeIpLiteral("::FFFF:100.64.0.1"), "100.64.0.1", "case-insensitive mapping prefix");
assert.equal(normalizeIpLiteral("100.64.0.1"), "100.64.0.1", "plain IPv4 unchanged");
assert.equal(normalizeIpLiteral("fd7a:115c:a1e0::1"), "fd7a:115c:a1e0::1", "ordinary IPv6 unchanged");
assert.deepEqual(
  normalizeTrustedPeers(["::ffff:100.64.0.1", "fd7a:115c:a1e0::1"]),
  ["100.64.0.1", "fd7a:115c:a1e0::1"],
  "peer set normalized at construction",
);
assert.throws(() => normalizeTrustedPeers(["100.64.0.0/10"]), /not an exact IPv4\/IPv6 literal/, "normalizeTrustedPeers stays strict");
{
  // Mapped remoteAddress matches an IPv4 peer entry.
  const result = resolveClientIp({
    remoteAddress: "::ffff:100.64.0.1",
    xForwardedFor: "203.0.113.7",
    policy: { mode: "exact_peers", peers: ["100.64.0.1"], maxChainLength: 3 },
  });
  assert.deepEqual(result, { ip: "203.0.113.7", proxied: true, chainLength: 1, rejectedForwarded: false },
    "IPv4-mapped remoteAddress matches IPv4 peer");
}

// --- TS identity headers ---
assert.deepEqual(
  [...TS_IDENTITY_HEADERS].sort(),
  ["Tailscale-User", "Tailscale-User-Login", "Tailscale-User-Name", "Tailscale-User-Profile-Pic"].sort(),
  "exact TS identity header set",
);
assert.equal(extractUntrustedTailscaleIdentity({ "tailscale-user-login": "alice@example.ts" })?.["Tailscale-User-Login"], "alice@example.ts",
  "identity collected case-insensitively for logging");
assert.equal(extractUntrustedTailscaleIdentity({}), undefined, "no identity headers -> undefined");
assert.equal(extractUntrustedTailscaleIdentity({ "tailscale-user-login": ["a", "b"] })?.["Tailscale-User-Login"], "a, b");

// --- strip list ---
const expectedStrip = [
  "Forwarded", "X-Forwarded-For", "X-Forwarded-Host", "X-Forwarded-Proto", "X-Forwarded-Port",
  "X-Forwarded-Protocol", "X-Forwarded-Scheme", "X-Real-IP", "CF-Connecting-IP", "True-Client-IP",
  ...TS_IDENTITY_HEADERS,
];
assert.deepEqual([...BRIDGE_STRIP_HEADERS], expectedStrip, "strip list is exactly authority-bearing headers + TS identity");
for (const name of expectedStrip) assert.equal(isBridgeStrippedHeader(name), true, `stripped: ${name}`);
assert.equal(isBridgeStrippedHeader("X-Kontrol-Owner"), true, "X-Kontrol-* prefix stripped");
assert.equal(isBridgeStrippedHeader("x-kontrol-anything"), true);
assert.equal(isBridgeStrippedHeader("x-kontrolfoo"), false, "prefix must match with hyphen");
assert.equal(isBridgeStrippedHeader("X-Forwarded-Xx"), false, "lookalike not stripped");
assert.equal(isBridgeStrippedHeader("Content-Type"), false, "ordinary header not stripped");

console.log("proxy-context: all assertions passed");
