import assert from "node:assert/strict";
import type { IngressProfile } from "./types.js";
import { kindPrivacy } from "./types.js";
import { parseIngressProfilesEnv, validateIngressProfiles } from "./validate.js";

const oauthCtx = { authMode: "oauth" as const, peerEnabled: true, hasPeerCredentials: true, publicBaseUrl: "https://kontrol.example.com" };
const tunnelCtx = { authMode: "tunnel" as const, peerEnabled: true, hasPeerCredentials: true };
const noPeerCtx = { authMode: "oauth" as const, peerEnabled: false, hasPeerCredentials: false, publicBaseUrl: "https://kontrol.example.com" };

let nextId = 0;
function baseProfile(overrides: Partial<IngressProfile> = {}): IngressProfile {
  nextId++;
  return {
    id: `p${nextId}`,
    kind: "tailscale_serve",
    audience: "peer",
    externalOrigin: "https://node.tail-scale.ts.net:8443",
    target: "peer_listener",
    enabled: true,
    managedByKontrol: false,
    allowedHosts: ["node.tail-scale.ts.net:8443"],
    ...overrides,
  };
}

const throwsIngress = (fn: () => void, pattern: RegExp, message?: string) =>
  assert.throws(fn, (error: Error) => {
    assert.match(error.message, /^ingress_profiles_invalid: /, message);
    if (pattern) assert.match(error.message, pattern, message);
    return true;
  });

// --- kindPrivacy ---
assert.equal(kindPrivacy("tailscale_serve"), "TAILNET_PRIVATE");
assert.equal(kindPrivacy("tailscale_funnel"), "PUBLIC_INTERNET");
assert.equal(kindPrivacy("https_bridge"), "PUBLIC_INTERNET");
assert.equal(kindPrivacy("secure_mcp_tunnel"), "PROVIDER_RELAY");

// 1. duplicate ids
assert.doesNotThrow(() => validateIngressProfiles([baseProfile({ id: "a", externalOrigin: "https://a.ts.net:8443", allowedHosts: ["a.ts.net:8443"] }), baseProfile({ id: "b", externalOrigin: "https://b.ts.net:8443", allowedHosts: ["b.ts.net:8443"] })], oauthCtx));
throwsIngress(() => validateIngressProfiles([baseProfile({ id: "a" }), baseProfile({ id: "a" })], oauthCtx), /duplicate profile id/);

// 2. serve/funnel same external node+port
assert.doesNotThrow(() => validateIngressProfiles([
  baseProfile({ id: "serve", kind: "tailscale_serve", externalOrigin: "https://node.ts.net:8443", allowedHosts: ["node.ts.net:8443"] }),
  baseProfile({ id: "funnel", kind: "tailscale_funnel", externalOrigin: "https://other.ts.net:8443", allowedHosts: ["other.ts.net:8443"] }),
], oauthCtx));
throwsIngress(
  () => validateIngressProfiles([
    baseProfile({ id: "serve", kind: "tailscale_serve", externalOrigin: "https://node.ts.net:8443", allowedHosts: ["node.ts.net:8443"] }),
    baseProfile({ id: "funnel", kind: "tailscale_funnel", externalOrigin: "https://node.ts.net:8443", allowedHosts: ["node.ts.net:8443"] }),
  ], oauthCtx),
  /cannot share a tailnet port/,
);

// 3. wildcard public host
throwsIngress(
  () => validateIngressProfiles([baseProfile({ allowedHosts: ["*.example.com"] })], oauthCtx),
  /invalid host entry/,
);
throwsIngress(
  () => validateIngressProfiles([baseProfile({ allowedHosts: ["*"] })], oauthCtx),
  /invalid host entry/,
);

// 4. invalid URLs / scheme
assert.doesNotThrow(() => validateIngressProfiles([baseProfile()], oauthCtx), "valid https serve profile accepted");
throwsIngress(
  () => validateIngressProfiles([baseProfile({ externalOrigin: "http://node.tail-scale.ts.net:8443" })], oauthCtx),
  /must use https/,
);
throwsIngress(
  () => validateIngressProfiles([baseProfile({ kind: "https_bridge", externalOrigin: "http://bridge.example.com", allowedHosts: ["bridge.example.com"], target: "public_oauth_listener", audience: "owner_public" })], oauthCtx),
  /must use https/,
);
throwsIngress(
  () => validateIngressProfiles([baseProfile({ externalOrigin: "not-a-url" })], oauthCtx),
  /not a valid absolute URL/,
);
throwsIngress(
  () => validateIngressProfiles([baseProfile({ externalOrigin: "https://user:pass@node.ts.net" })], oauthCtx),
  /userinfo|not a valid absolute URL/,
);
throwsIngress(
  () => validateIngressProfiles([baseProfile({ externalOrigin: "https://node.ts.net/path#frag" })], oauthCtx),
  /path|fragment|not a valid absolute URL/,
);

// 5. funnel port constraint
assert.doesNotThrow(() => validateIngressProfiles(
  [baseProfile({ kind: "tailscale_funnel", externalOrigin: "https://node.ts.net:8443", allowedHosts: ["node.ts.net:8443"] })],
  oauthCtx,
), "funnel port 8443 OK");
assert.doesNotThrow(() => validateIngressProfiles(
  [baseProfile({ kind: "tailscale_funnel", externalOrigin: "https://node.ts.net:10000", allowedHosts: ["node.ts.net:10000"] })],
  oauthCtx,
), "funnel port 10000 OK");
throwsIngress(
  () => validateIngressProfiles([baseProfile({ kind: "tailscale_funnel", externalOrigin: "https://node.ts.net:5000", allowedHosts: ["node.ts.net:5000"] })], oauthCtx),
  /must be 443, 8443, or 10000/,
);

// 6. target/audience/kind mismatches
throwsIngress(
  () => validateIngressProfiles([baseProfile({ audience: "peer", target: "public_oauth_listener" })], oauthCtx),
  /peer audience must target peer_listener/,
);
throwsIngress(
  () => validateIngressProfiles([baseProfile({ kind: "https_bridge", audience: "owner_public", target: "secure_tunnel_listener", externalOrigin: "https://bridge.example.com", allowedHosts: ["bridge.example.com"] })], oauthCtx),
  /only secure_mcp_tunnel profiles may use that target/,
);
throwsIngress(
  () => validateIngressProfiles([baseProfile({ kind: "secure_mcp_tunnel", target: "peer_listener", externalOrigin: "https://tunnel.example.com", allowedHosts: ["tunnel.example.com"] })], oauthCtx),
  /must target secure_tunnel_listener/,
);
assert.doesNotThrow(() => validateIngressProfiles(
  [baseProfile({ kind: "secure_mcp_tunnel", audience: "owner_public", target: "secure_tunnel_listener", externalOrigin: "https://kontrol.example.com", allowedHosts: ["kontrol.example.com"] })],
  oauthCtx,
), "secure tunnel targeting secure_tunnel_listener accepted");

// 7. deployment-mode gating
throwsIngress(
  () => validateIngressProfiles(
    [baseProfile({ audience: "owner_public", target: "public_oauth_listener", externalOrigin: "https://kontrol.example.com", allowedHosts: ["kontrol.example.com"] })],
    tunnelCtx,
  ),
  /public ingress requires OAuth mode/,
);
throwsIngress(
  () => validateIngressProfiles([baseProfile()], noPeerCtx),
  /peer listener is not enabled with credentials/,
);

// 8. canonical OAuth resource uniqueness (enabled vs standby)
assert.doesNotThrow(() => validateIngressProfiles(
  [baseProfile({ audience: "owner_public", target: "public_oauth_listener", externalOrigin: "https://kontrol.example.com", allowedHosts: ["kontrol.example.com"] })],
  oauthCtx,
), "enabled owner_public origin matching canonical accepted");
throwsIngress(
  () => validateIngressProfiles(
    [baseProfile({ audience: "owner_public", target: "public_oauth_listener", externalOrigin: "https://other.example.com", allowedHosts: ["other.example.com"] })],
    oauthCtx,
  ),
  /does not equal the canonical publicBaseUrl/,
);
assert.doesNotThrow(() => validateIngressProfiles(
  [baseProfile({ enabled: false, audience: "owner_public", target: "public_oauth_listener", externalOrigin: "https://standby.example.com", allowedHosts: ["standby.example.com"] })],
  oauthCtx,
), "disabled standby profile is exempt from canonical origin check");

// 9. host syntax / 11. nonempty allowedHosts for enabled profiles
assert.doesNotThrow(() => validateIngressProfiles([baseProfile({ enabled: false, allowedHosts: [] })], oauthCtx),
  "disabled profile may have empty allowlist");
throwsIngress(
  () => validateIngressProfiles([baseProfile({ allowedHosts: [] })], oauthCtx),
  /must declare at least one exact allowedHosts entry/,
);
throwsIngress(
  () => validateIngressProfiles([baseProfile({ allowedHosts: ["bad host"] })], oauthCtx),
  /invalid host entry/,
);
assert.doesNotThrow(() => validateIngressProfiles(
  [baseProfile({ allowedHosts: ["Kontrol-Node.Example.TS.net:8443", "kontrol-node.example.ts.net:8443"] })],
  oauthCtx,
), "IDNA-normalized duplicate dedupes and passes");

// 10. proxyPeerIps
assert.doesNotThrow(() => validateIngressProfiles([baseProfile({ proxyPeerIps: ["100.64.0.1", "::1"] })], oauthCtx));
throwsIngress(
  () => validateIngressProfiles([baseProfile({ proxyPeerIps: ["100.64.0.0/10"] })], oauthCtx),
  /not an exact IPv4\/IPv6 literal/,
);
throwsIngress(
  () => validateIngressProfiles([baseProfile({ proxyPeerIps: ["10.0.0.5-10"] })], oauthCtx),
  /not an exact IPv4\/IPv6 literal/,
);

// --- parseIngressProfilesEnv ---
assert.equal(parseIngressProfilesEnv(undefined), undefined, "unset -> undefined");
assert.equal(parseIngressProfilesEnv(""), undefined, "empty -> undefined");
assert.equal(parseIngressProfilesEnv("   "), undefined, "whitespace -> undefined");

const goodJson = JSON.stringify([
  {
    id: "serve-1",
    kind: "tailscale_serve",
    audience: "peer",
    externalOrigin: "https://node.ts.net:8443",
    target: "peer_listener",
    enabled: false,
    allowedHosts: ["node.ts.net:8443"],
  },
]);
assert.deepEqual(parseIngressProfilesEnv(goodJson), {
  profiles: [{
    id: "serve-1",
    kind: "tailscale_serve",
    audience: "peer",
    externalOrigin: "https://node.ts.net:8443",
    target: "peer_listener",
    enabled: false,
    managedByKontrol: false,
    allowedHosts: ["node.ts.net:8443"],
  }],
}, "profile parsed with managedByKontrol defaulting to false");
assert.equal(parseIngressProfilesEnv("[]")?.profiles.length, 0, "empty array parses");

// managedByKontrol explicit
const managed = parseIngressProfilesEnv(JSON.stringify([{ ...JSON.parse(goodJson)[0], managedByKontrol: true }]));
assert.equal(managed?.profiles[0].managedByKontrol, true);

// exact-shape: unknown field rejected
throwsIngress(
  () => parseIngressProfilesEnv(JSON.stringify([{ ...JSON.parse(goodJson)[0], extra: 1 }])),
  /unknown field "extra"/,
);
// malformed JSON
throwsIngress(() => parseIngressProfilesEnv("{not json"), /not valid JSON/);
throwsIngress(() => parseIngressProfilesEnv("{}"), /must be a JSON array/);
// missing required enabled
throwsIngress(
  () => parseIngressProfilesEnv(JSON.stringify([{ ...JSON.parse(goodJson)[0], enabled: undefined }])),
  /missing required field "enabled"/,
);
// invalid enum
throwsIngress(
  () => parseIngressProfilesEnv(JSON.stringify([{ ...JSON.parse(goodJson)[0], kind: "magic" }])),
  /invalid kind/,
);

// --- regression (PR-C smoke): funnel on the DEFAULT port 443 must validate.
// WHATWG URL drops explicitly-written default ports, so both spellings below
// produce an empty url.port and must be checked by EFFECTIVE port.
{
  const base = {
    id: "funnel-443",
    kind: "tailscale_funnel" as const,
    audience: "owner_public" as const,
    target: "public_oauth_listener" as const,
    enabled: true,
    managedByKontrol: false,
  };
  for (const externalOrigin of ["https://node.ts.net", "https://node.ts.net:443"]) {
    validateIngressProfiles(
      [{ ...base, id: "funnel-443" + (externalOrigin.endsWith(":443") ? "-explicit" : ""), externalOrigin, allowedHosts: [externalOrigin.slice("https://".length)] }],
      { authMode: "oauth", peerEnabled: false, hasPeerCredentials: false, publicBaseUrl: "https://node.ts.net" },
    );
  }
  // 8443 remains valid; 8080 is still rejected.
  validateIngressProfiles(
    [{ ...base, externalOrigin: "https://node.ts.net:8443", allowedHosts: ["node.ts.net:8443"] }],
    { authMode: "oauth", peerEnabled: false, hasPeerCredentials: false, publicBaseUrl: "https://node.ts.net:8443" },
  );
  assert.throws(
    () =>
      validateIngressProfiles(
        [{ ...base, externalOrigin: "https://node.ts.net:8080", allowedHosts: ["node.ts.net:8080"] }],
        { authMode: "oauth", peerEnabled: false, hasPeerCredentials: false, publicBaseUrl: "https://node.ts.net:8080" },
      ),
    /must be 443, 8443, or 10000/,
  );
}

console.log("validate: all assertions passed");
