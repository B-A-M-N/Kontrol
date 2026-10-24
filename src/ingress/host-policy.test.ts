import assert from "node:assert/strict";
import {
  hostFromRequestHeader,
  isLoopbackHostValue,
  normalizeHostAllowlist,
  normalizeHostEntry,
} from "./host-policy.js";

// --- normalizeHostEntry ---
assert.equal(normalizeHostEntry("  Kontrol-Node.Example.TS.net  "), "kontrol-node.example.ts.net", "trim + lowercase");
assert.equal(normalizeHostEntry("münchen.example"), normalizeHostEntry("MÜNCHEN.example"), "IDNA normalization via URL is deterministic");
assert.equal(normalizeHostEntry("MÜNCHEN.example").startsWith("xn--"), true, "punycode produced");
assert.equal(normalizeHostEntry("host.example:443"), "host.example", "default https port stripped");
assert.equal(normalizeHostEntry("host.example:8443"), "host.example:8443", "non-default port kept");
assert.equal(normalizeHostEntry("HOST.example:80"), "host.example", "port 80 stripped");
assert.throws(() => normalizeHostEntry(""), /invalid host entry/, "empty rejected");
assert.throws(() => normalizeHostEntry("   "), /invalid host entry/, "whitespace-only rejected");
assert.throws(() => normalizeHostEntry("a b.example"), /invalid host entry/, "embedded whitespace rejected");
assert.throws(() => normalizeHostEntry("*"), /invalid host entry/, "bare wildcard rejected");
assert.throws(() => normalizeHostEntry("*.example.com"), /invalid host entry/, "leading wildcard rejected");
assert.throws(() => normalizeHostEntry("host/../evil"), /invalid host entry/, "path rejected");
assert.throws(() => normalizeHostEntry("user@host.example"), /invalid host entry/, "userinfo rejected");

// --- normalizeHostAllowlist ---
assert.deepEqual(
  normalizeHostAllowlist(["B.example", "a.example", "b.example:443", "a.example"]),
  ["b.example", "a.example"],
  "dedupe preserving first-occurrence order (after canonicalization)",
);
assert.throws(() => normalizeHostAllowlist(["a.example", "*"]), /invalid host entry/, "wildcard anywhere throws");
assert.deepEqual(normalizeHostAllowlist([]), [], "empty allowlist allowed (validator enforces nonempty for enabled profiles)");

// --- hostFromRequestHeader ---
const ok = hostFromRequestHeader("Example.COM:8443", ["Example.COM:8443"]);
assert.deepEqual(ok, { host: "example.com:8443" }, "single host normalized");
{
  const result = hostFromRequestHeader("a.example", ["a.example", "b.example"]);
  assert.ok("error" in result && result.error.includes("multiple Host headers"), "multiple Host entries rejected");
}
{
  const result = hostFromRequestHeader("https://a.example/", ["https://a.example/"]);
  assert.ok("error" in result && result.error.includes("absolute-form"), "absolute-form rejected");
}
{
  const result = hostFromRequestHeader("a.example\r\nX-Evil: 1", ["a.example"]);
  assert.ok("error" in result && result.error.includes("whitespace"), "CR/LF rejected");
}
{
  const result = hostFromRequestHeader(undefined, []);
  assert.ok("error" in result && result.error.includes("missing Host"), "missing host rejected");
}

// --- isLoopbackHostValue ---
assert.equal(isLoopbackHostValue("127.0.0.1"), true);
assert.equal(isLoopbackHostValue("::1"), true);
assert.equal(isLoopbackHostValue("localhost"), true);
assert.equal(isLoopbackHostValue("example.com"), false);
assert.equal(isLoopbackHostValue("127.0.0.2"), false);

console.log("host-policy: all assertions passed");
