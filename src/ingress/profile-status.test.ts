import assert from "node:assert/strict";
import type { IngressProfile } from "./types.js";
import {
  buildIngressPlan,
  buildIngressReport,
  classifyProfile,
  defaultLocalProbe,
  normalizeLocalTarget,
  validationContextFromConfig,
  type IngressConfigSource,
} from "./profile-status.js";
import type { ServeMapping, TailscaleFacts } from "./tailscale-status.js";

let nextId = 0;
function profile(overrides: Partial<IngressProfile> = {}): IngressProfile {
  nextId++;
  return {
    id: `p${nextId}`,
    kind: "tailscale_serve",
    audience: "peer",
    externalOrigin: "https://node.ts.net:8443",
    target: "peer_listener",
    enabled: true,
    managedByKontrol: false,
    allowedHosts: ["node.ts.net:8443"],
    ...overrides,
  };
}

function config(profiles: IngressProfile[], overrides: Partial<IngressConfigSource> = {}): IngressConfigSource {
  return {
    authMode: "oauth",
    publicBaseUrl: "https://kontrol.example.com",
    peer: { port: 7677 },
    publicMcp: { port: 7678 },
    ingress: { profiles },
    ...overrides,
  };
}

function facts(overrides: Partial<TailscaleFacts> = {}): TailscaleFacts {
  return {
    cliVersion: "1.102.2",
    backendState: "Running",
    dnsName: "node.tail8d285a.ts.net",
    serveMappings: [],
    funnelMappings: [],
    warnings: [],
    ...overrides,
  };
}

const servePeer = profile({ id: "serve-peer" });

// --- normalizeLocalTarget ---
assert.equal(normalizeLocalTarget("http://127.0.0.1:7677"), "http://127.0.0.1:7677");
assert.equal(normalizeLocalTarget("http://localhost:7677"), "http://127.0.0.1:7677");
assert.equal(normalizeLocalTarget("http://[::1]:7677"), "http://127.0.0.1:7677");
assert.equal(normalizeLocalTarget("http://10.0.0.5:7677"), null);
assert.equal(normalizeLocalTarget("not a url"), null);

// --- classification matrix via buildIngressReport ---
{
  const matched = buildIngressReport(
    config([servePeer]),
    facts({ serveMappings: [{ port: "443", path: "/", proxyTarget: "http://127.0.0.1:7677" }] }),
    new Map([[7677, true]]),
  ).profiles[0];
  assert.equal(matched.classification, "MATCHED");
  assert.deepEqual(matched.observed, { port: "443", path: "/", proxyTarget: "http://127.0.0.1:7677" });
  assert.equal(matched.expectedLocalTarget, "http://127.0.0.1:7677");
  assert.equal(matched.privacy, "TAILNET_PRIVATE");
  assert.ok(matched.notes.some((note) => note.includes("cannot be verified from tailscale status output alone")), "MATCHED documents the origin-verification limit");
}
{
  // loopback spellings localhost / [::1] all match the 127.0.0.1 expectation
  for (const target of ["http://localhost:7677", "http://[::1]:7677"]) {
    const report = buildIngressReport(
      config([servePeer]),
      facts({ serveMappings: [{ port: "443", path: "/", proxyTarget: target }] }),
      new Map([[7677, true]]),
    );
    assert.equal(report.profiles[0].classification, "MATCHED", target);
  }
}
{
  const down = buildIngressReport(
    config([servePeer]),
    facts({ serveMappings: [{ port: "443", path: "/", proxyTarget: "http://127.0.0.1:7677" }] }),
    new Map([[7677, false]]),
  ).profiles[0];
  assert.equal(down.classification, "LOCAL_DOWN", "unreachable expected port wins before mapping checks");
}
{
  const noMapping = buildIngressReport(config([servePeer]), facts({}), new Map([[7677, true]])).profiles[0];
  assert.equal(noMapping.classification, "NO_MAPPING");
  assert.equal(noMapping.observed, null);
}
{
  // MISMATCH (a): route to the expected local port via a non-loopback host
  const mismatchHost = buildIngressReport(
    config([servePeer]),
    facts({ serveMappings: [{ port: "443", path: "/", proxyTarget: "http://10.0.0.5:7677" }] }),
    new Map([[7677, true]]),
  ).profiles[0];
  assert.equal(mismatchHost.classification, "MISMATCH");
  assert.deepEqual(mismatchHost.observed, { port: "443", path: "/", proxyTarget: "http://10.0.0.5:7677" }, "MISMATCH reports the route that caused it");
}
{
  // MISMATCH (b): the origin's tailscale listen port is routed, but to a
  // different local target port
  const mismatchTarget = buildIngressReport(
    config([servePeer]),
    facts({ serveMappings: [{ port: "8443", path: "/", proxyTarget: "http://127.0.0.1:9999" }] }),
    new Map([[7677, true]]),
  ).profiles[0];
  assert.equal(mismatchTarget.classification, "MISMATCH");
  assert.deepEqual(mismatchTarget.observed, { port: "8443", path: "/", proxyTarget: "http://127.0.0.1:9999" }, "MISMATCH reports the route that caused it");
}
{
  const disabled = buildIngressReport(
    config([profile({ id: "standby", enabled: false })]),
    facts({}),
    new Map([[7677, false]]),
  ).profiles[0];
  assert.equal(disabled.classification, "DISABLED");
  assert.ok(disabled.notes.some((note) => note.includes("disabled (standby)")));
}
{
  // UPSTREAM FACT: `funnel status --json` renders the SAME ipn.ServeConfig as
  // `serve status --json` (shared runServeStatus). So a funnel profile must
  // match ONLY routes explicitly marked allowFunnel: true — never a route
  // that merely appears in the funnel bucket, and never a serve-only route.
  const funnelPeer = profile({ id: "funnel-peer", kind: "tailscale_funnel", externalOrigin: "https://funnel.ts.net:8443", allowedHosts: ["funnel.ts.net:8443"] });
  const mapped = buildIngressReport(
    config([funnelPeer]),
    facts({ funnelMappings: [{ port: "8443", path: "/", proxyTarget: "http://127.0.0.1:7677", allowFunnel: true }] }),
    new Map([[7677, true]]),
  ).profiles[0];
  assert.equal(mapped.classification, "MATCHED");

  // (a) The production case: BOTH buckets carry the same route, but the
  // document never marks it funnel-enabled -> NO_MAPPING, never MATCHED.
  const serveOnlyRoute = { port: "8443", path: "/", proxyTarget: "http://127.0.0.1:7677" };
  const notFunnelEnabled = buildIngressReport(
    config([funnelPeer]),
    facts({ serveMappings: [serveOnlyRoute], funnelMappings: [serveOnlyRoute] }),
    new Map([[7677, true]]),
  ).profiles[0];
  assert.equal(notFunnelEnabled.classification, "NO_MAPPING", "a route without an AllowFunnel entry must not satisfy a funnel profile even when the funnel command lists it");

  // (b) A serve route in BOTH buckets WITH allowFunnel: true (the real
  // funnel-on state upstream renders) -> MATCHED.
  const funnelEnabled = buildIngressReport(
    config([funnelPeer]),
    facts({ serveMappings: [{ ...serveOnlyRoute, allowFunnel: true }], funnelMappings: [{ ...serveOnlyRoute, allowFunnel: true }] }),
    new Map([[7677, true]]),
  ).profiles[0];
  assert.equal(funnelEnabled.classification, "MATCHED", "an AllowFunnel-marked route satisfies a funnel profile regardless of bucket");

  // (c) allowFunnel: false in the document -> NO_MAPPING (never inferred).
  const explicitlyOff = buildIngressReport(
    config([funnelPeer]),
    facts({ funnelMappings: [{ ...serveOnlyRoute, allowFunnel: false }] }),
    new Map([[7677, true]]),
  ).profiles[0];
  assert.equal(explicitlyOff.classification, "NO_MAPPING");
}
{
  // serve profile + funnel-ENABLED matched route -> MISMATCH + mandatory
  // exposure note: a public route must never be a healthy MATCHED for a
  // tailnet-private profile (mirrors the plan-path refusal).
  const servePriv = profile({ id: "serve-priv", kind: "tailscale_serve", externalOrigin: "https://priv.ts.net:8443", allowedHosts: ["priv.ts.net:8443"] });
  const exposed = buildIngressReport(
    config([servePriv]),
    facts({ serveMappings: [{ port: "443", path: "/", proxyTarget: "http://127.0.0.1:7677", allowFunnel: true }] }),
    new Map([[7677, true]]),
  ).profiles[0];
  assert.equal(exposed.classification, "MISMATCH", "a funnel-enabled route must never be a clean MATCHED for a serve profile");
  assert.ok(exposed.notes.some((note) => note.includes("exposed to the PUBLIC internet")), "the exposure must be called out in notes");
  assert.equal(exposed.observed?.allowFunnel, true, "the observed route carries the funnel flag");
  const off = buildIngressReport(
    config([servePriv]),
    facts({ serveMappings: [{ port: "443", path: "/", proxyTarget: "http://127.0.0.1:7677", allowFunnel: false }] }),
    new Map([[7677, true]]),
  ).profiles[0];
  assert.equal(off.classification, "MATCHED", "an explicitly funnel-off route stays MATCHED");
  // The exposure scan covers ALL target-matching routes, not just the first:
  // upstream may list several hosts proxying one local port.
  const secondRouteExposed = buildIngressReport(
    config([servePriv]),
    facts({ serveMappings: [
      { port: "443", path: "/", proxyTarget: "http://127.0.0.1:7677" },
      { port: "443", path: "/x", proxyTarget: "http://127.0.0.1:7677", allowFunnel: true },
    ] }),
    new Map([[7677, true]]),
  ).profiles[0];
  assert.equal(secondRouteExposed.classification, "MISMATCH", "a funnel-enabled route to the same local port is caught even when it is not the first match");
  assert.equal(secondRouteExposed.observed?.allowFunnel, true, "observed prefers the exposed route");
  // P3-E: an unmarked funnel-bucket route earns the shape-drift note.
  const funnelPriv = profile({ id: "funnel-priv", kind: "tailscale_funnel", externalOrigin: "https://priv.ts.net:8443", allowedHosts: ["priv.ts.net:8443"] });
  const unmarked = buildIngressReport(
    config([funnelPriv]),
    facts({ funnelMappings: [{ port: "8443", path: "/", proxyTarget: "http://127.0.0.1:7677" }] }),
    new Map([[7677, true]]),
  ).profiles[0];
  assert.equal(unmarked.classification, "NO_MAPPING");
  assert.ok(unmarked.notes.some((note) => note.includes("may have changed shape")), "an unmarked funnel-bucket route earns a diagnostic note");
}
{
  // non-tailscale kinds: informational, no tailscale observation applies
  const tunnel = profile({ id: "tunnel-1", kind: "secure_mcp_tunnel", audience: "owner_public", target: "secure_tunnel_listener", externalOrigin: "https://kontrol.example.com", allowedHosts: ["kontrol.example.com"] });
  const tunnelStatus = buildIngressReport(config([tunnel]), facts({}), new Map()).profiles[0];
  assert.equal(tunnelStatus.classification, "NO_MAPPING");
  assert.equal(tunnelStatus.expectedLocalTarget, null, "secure_tunnel_listener gets no mapping and no probe");
  assert.ok(tunnelStatus.notes.some((note) => note.includes("deliberately not observed or probed")));
  const bridge = profile({ id: "bridge-1", kind: "https_bridge", audience: "owner_public", target: "public_oauth_listener", externalOrigin: "https://kontrol.example.com", allowedHosts: ["kontrol.example.com"] });
  const bridgeStatus = buildIngressReport(config([bridge]), facts({}), new Map()).profiles[0];
  assert.equal(bridgeStatus.classification, "NO_MAPPING");
  assert.ok(bridgeStatus.notes.some((note) => note.includes("bridge deployment files arrive in a later PR")));
}
{
  // target listener not enabled -> nothing to observe locally
  const publicProfile = profile({ id: "serve-public", audience: "owner_public", target: "public_oauth_listener", externalOrigin: "https://kontrol.example.com", allowedHosts: ["kontrol.example.com"] });
  const status = buildIngressReport(config([publicProfile], { publicMcp: undefined }), facts({})).profiles[0];
  assert.equal(status.classification, "NO_MAPPING");
  assert.equal(status.expectedLocalTarget, null);
  assert.ok(status.notes.some((note) => note.includes("not enabled in this deployment")));
}
{
  // facts-layer warnings are echoed into every profile's notes
  const warningFacts = facts({ warnings: ["tailscale serve status --json failed (exit 1): boom"] });
  const report = buildIngressReport(config([servePeer]), warningFacts, new Map([[7677, true]]));
  assert.deepEqual(report.profiles[0].notes.slice(-1), ["tailscale serve status --json failed (exit 1): boom"]);
  assert.equal(report.cliVersion, "1.102.2");
  assert.equal(report.backendState, "Running");
  assert.equal(report.dnsName, "node.tail8d285a.ts.net");
}

// --- classifyProfile directly (used by the report builder) ---
assert.equal(classifyProfile({ profile: { ...servePeer, enabled: false }, facts: facts({}), expectedLocalPort: 7677 }), "DISABLED");
assert.equal(
  classifyProfile({ profile: servePeer, facts: facts({ serveMappings: [{ port: "443", path: "/", proxyTarget: "http://127.0.0.1:7677" }] }), expectedLocalPort: 7677 }),
  "MATCHED",
);

// --- redaction: exact key sets, nothing else ---
{
  const tunnel = profile({ id: "tunnel-1", kind: "secure_mcp_tunnel", audience: "owner_public", target: "secure_tunnel_listener", externalOrigin: "https://kontrol.example.com", allowedHosts: ["kontrol.example.com"] });
  const report = buildIngressReport(
    config([servePeer, tunnel]),
    facts({ warnings: ["tailscale version failed (exit 1): boom"] }),
    new Map([[7677, true]]),
  );
  assert.deepEqual(
    Object.keys(report).sort(),
    ["backendState", "cliVersion", "dnsName", "profiles"],
    "the report must contain ONLY the whitelisted top-level fields",
  );
  for (const status of report.profiles) {
    assert.deepEqual(
      Object.keys(status).sort(),
      ["audience", "classification", "enabled", "expectedLocalTarget", "externalOrigin", "id", "kind", "notes", "observed", "privacy", "target"],
      "each profile status must contain ONLY the whitelisted fields",
    );
  }
  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /credentialFile|allowedPeers|KONTROL_[A-Z]/, "no env values, credential paths, or raw env names in the report");
  assert.doesNotMatch(serialized, /nodekey|PrivateKey|UserProfile/, "no tailscale output beyond the whitelisted fields");
}

// --- plan: command exactness ---
{
  const entries = buildIngressPlan(config([servePeer]));
  assert.deepEqual(entries, [{
    id: "serve-peer",
    kind: "tailscale_serve",
    privacy: "TAILNET_PRIVATE",
    command: "tailscale serve --bg --https=8443 http://127.0.0.1:7677",
    targetPort: 7677,
  }]);
}
{
  const funnelPublic = profile({ id: "funnel-public", kind: "tailscale_funnel", audience: "owner_public", target: "public_oauth_listener", externalOrigin: "https://kontrol.example.com:8443", allowedHosts: ["kontrol.example.com:8443"] });
  const entries = buildIngressPlan(config([funnelPublic], { publicBaseUrl: "https://kontrol.example.com:8443" }));
  assert.deepEqual(entries, [{
    id: "funnel-public",
    kind: "tailscale_funnel",
    privacy: "PUBLIC_INTERNET",
    command: "tailscale funnel --bg --https=8443 http://127.0.0.1:7678",
    targetPort: 7678,
  }]);
}
{
  // default external port 443 when the origin has no explicit port; serve to
  // the public OAuth listener is allowed but must carry the OAuth-mode note
  const servePublic = profile({ id: "serve-public", audience: "owner_public", target: "public_oauth_listener", externalOrigin: "https://kontrol.example.com", allowedHosts: ["kontrol.example.com"] });
  const entries = buildIngressPlan(config([servePublic]));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].command, "tailscale serve --bg --https=443 http://127.0.0.1:7678");
  assert.equal(entries[0].refused, undefined);
  assert.ok(entries[0].note?.includes("one-canonical-owner-public rule"), "serve->public_oauth_listener must note the OAuth-mode rules");
}

// --- plan: refusals ---
{
  const funnelPeer = profile({ id: "funnel-peer", kind: "tailscale_funnel", externalOrigin: "https://funnel.ts.net:8443", allowedHosts: ["funnel.ts.net:8443"] });
  const entries = buildIngressPlan(config([funnelPeer]));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].command, undefined);
  assert.equal(entries[0].refused, "public peer-bearer exposure is not supported in this build (needs P0-05 edge hardening first)");
}
{
  const tunnel = profile({ id: "tunnel-1", kind: "secure_mcp_tunnel", audience: "owner_public", target: "secure_tunnel_listener", externalOrigin: "https://kontrol.example.com", allowedHosts: ["kontrol.example.com"] });
  const entries = buildIngressPlan(config([tunnel]));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].command, undefined);
  assert.equal(entries[0].refused, "tunnel-mode owner listener is unauthenticated at the app layer; never proxy it through Tailscale");
}
{
  // target listener not enabled -> refusal, never a half-specified command
  const servePublic = profile({ id: "serve-public", audience: "owner_public", target: "public_oauth_listener", externalOrigin: "https://kontrol.example.com", allowedHosts: ["kontrol.example.com"] });
  const entries = buildIngressPlan(config([servePublic], { publicMcp: undefined }));
  assert.equal(entries[0].command, undefined);
  assert.match(entries[0].refused ?? "", /public OAuth listener/);
}

// --- plan: disabled skip + bridge informational ---
{
  const entries = buildIngressPlan(config([
    profile({ id: "standby", enabled: false }),
    profile({ id: "bridge-1", kind: "https_bridge", audience: "owner_public", target: "public_oauth_listener", externalOrigin: "https://kontrol.example.com", allowedHosts: ["kontrol.example.com"] }),
  ]));
  assert.equal(entries.length, 2);
  assert.equal(entries[0].command, undefined);
  assert.equal(entries[0].refused, undefined);
  assert.match(entries[0].note ?? "", /disabled \(standby\)/);
  assert.equal(entries[1].command, undefined);
  assert.equal(entries[1].refused, undefined);
  assert.match(entries[1].note ?? "", /informational/);
}

// --- plan: validation failure propagates with the stable prefix ---
{
  assert.throws(
    () => buildIngressPlan(config([
      profile({ id: "dup" }),
      profile({ id: "dup", externalOrigin: "https://other.ts.net:8443", allowedHosts: ["other.ts.net:8443"] }),
    ])),
    (error: Error) => {
      assert.match(error.message, /^ingress_profiles_invalid: duplicate profile id/);
      return true;
    },
  );
}

// --- validation context mirrors the startup builder ---
assert.deepEqual(
  validationContextFromConfig(config([], { peer: undefined })),
  { authMode: "oauth", peerEnabled: false, hasPeerCredentials: false, publicBaseUrl: "https://kontrol.example.com" },
);

// --- default local probe: refuses a dead loopback port (bounded, no throw) ---
{
  const up = await defaultLocalProbe(7677).catch(() => false);
  assert.equal(typeof up, "boolean", "the probe resolves a boolean even when the connection fails");
  const dead = await defaultLocalProbe(1); // port 1: nothing listens, fails fast
  assert.equal(dead, false, "a closed loopback port must resolve false, never throw");
}

console.log("profile-status: all assertions passed");
