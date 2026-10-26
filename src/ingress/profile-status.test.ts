import assert from "node:assert/strict";
import { createServer } from "node:http";
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
    publicBaseUrl: "https://kontrol-node.tail-scale.ts.net",
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
    serveStatusSchemaSupported: true,
    serveFunnelAttributionComplete: true,
    funnelFunnelAttributionComplete: true,
    funnelStatusSchemaSupported: true,
    warnings: [],
    ...overrides,
  };
}

const servePeer = profile({ id: "serve-peer", externalOrigin: "https://node.tail8d285a.ts.net:8443", allowedHosts: ["node.tail8d285a.ts.net:8443"] });
function mapping(overrides: Partial<ServeMapping> = {}): ServeMapping {
  return {
    port: "8443",
    path: "/",
    proxyTarget: "http://127.0.0.1:7677",
    hostPort: "node.tail8d285a.ts.net:8443",
    allowFunnel: false,
    identity: {
      hostname: "node.tail8d285a.ts.net",
      listenPort: "8443",
      handlerPath: "/",
      upstreamScheme: "http",
      upstreamHost: "127.0.0.1",
      upstreamPort: "7677",
      upstreamPath: "/",
      allowFunnel: false,
    },
    ...overrides,
  };
}

/** A route that differs from the configured profile in its upstream port. */
const differentPort = mapping({
  proxyTarget: "http://127.0.0.1:9999",
  identity: { ...mapping().identity!, upstreamPort: "9999" },
});

// --- normalizeLocalTarget ---
assert.equal(normalizeLocalTarget("http://127.0.0.1:7677"), "http://127.0.0.1:7677/");
assert.equal(normalizeLocalTarget("http://localhost:7677"), "http://127.0.0.1:7677/");
assert.equal(normalizeLocalTarget("http://[::1]:7677"), "http://127.0.0.1:7677/");
assert.equal(normalizeLocalTarget("https://127.0.0.1:7677"), "https://127.0.0.1:7677/");
assert.equal(normalizeLocalTarget("http://127.0.0.1:7677/path"), null, "upstream path must not be discarded");
assert.equal(normalizeLocalTarget("http://127.0.0.1:7677/?x=1"), null, "upstream query must not be discarded");
assert.equal(normalizeLocalTarget("http://10.0.0.5:7677"), null);
assert.equal(normalizeLocalTarget("not a url"), null);

// --- classification matrix via buildIngressReport ---
{
  const matched = buildIngressReport(
    config([servePeer]),
    facts({ serveMappings: [mapping()] }),
    new Map([[7677, true]]),
  ).profiles[0];
  assert.equal(matched.classification, "MAPPING_MATCHED");
  assert.deepEqual(matched.observed, mapping());
  assert.equal(matched.expectedLocalTarget, "http://127.0.0.1:7677/");
  assert.equal(matched.privacy, "TAILNET_PRIVATE");
  assert.ok(matched.notes.some((note) => note.includes("authenticated protocol probe")), "MAPPING_MATCHED must not claim end-to-end readiness");
}
{
  // loopback spellings localhost / [::1] all match the 127.0.0.1 expectation
  for (const target of ["http://localhost:7677", "http://[::1]:7677"]) {
    const route = mapping({ proxyTarget: target, identity: { ...mapping().identity!, upstreamHost: "127.0.0.1" } });
    const report = buildIngressReport(
      config([servePeer]),
      facts({ serveMappings: [route] }),
      new Map([[7677, true]]),
    );
    assert.equal(report.profiles[0].classification, "MAPPING_MATCHED", target);
  }
}
{
  const down = buildIngressReport(
    config([servePeer]),
    facts({ serveMappings: [mapping()] }),
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
    facts({ serveMappings: [mapping({ proxyTarget: "http://10.0.0.5:7677", identity: { ...mapping().identity!, upstreamHost: "10.0.0.5" } })] }),
    new Map([[7677, true]]),
  ).profiles[0];
  assert.equal(mismatchHost.classification, "MISMATCH");
  assert.deepEqual(mismatchHost.observed, mapping({ proxyTarget: "http://10.0.0.5:7677", identity: { ...mapping().identity!, upstreamHost: "10.0.0.5" } }), "MISMATCH reports the route that caused it");
}
{
  // MISMATCH (b): the origin's tailscale listen port is routed, but to a
  // different local target port
  const mismatchTarget = buildIngressReport(
    config([servePeer]),
    facts({ serveMappings: [mapping({ proxyTarget: "http://127.0.0.1:9999", identity: { ...mapping().identity!, upstreamPort: "9999" } })] }),
    new Map([[7677, true]]),
  ).profiles[0];
  assert.equal(mismatchTarget.classification, "MISMATCH");
  assert.deepEqual(mismatchTarget.observed, mapping({ proxyTarget: "http://127.0.0.1:9999", identity: { ...mapping().identity!, upstreamPort: "9999" } }), "MISMATCH reports the route that caused it");
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
  // `serve status --json`. Positive matching requires an exact recognized
  // identity with allowFunnel proven; anything else is inconclusive.
  const funnelPeer = profile({ id: "funnel-peer", kind: "tailscale_funnel", externalOrigin: "https://node.tail8d285a.ts.net:8443", allowedHosts: ["node.tail8d285a.ts.net:8443"] });
  const exactFunnel = mapping({
    allowFunnel: true,
    identity: { ...mapping().identity!, allowFunnel: true },
  });
  const mapped = buildIngressReport(
    config([funnelPeer]),
    facts({ funnelMappings: [exactFunnel] }),
    new Map([[7677, true]]),
  ).profiles[0];
  assert.equal(mapped.classification, "MAPPING_MATCHED");

  // A route without an AllowFunnel entry is unrecognized and cannot satisfy a
  // funnel profile, even when the funnel command lists it.
  const serveOnlyRoute = { port: "8443", path: "/", proxyTarget: "http://127.0.0.1:7677" };
  const notFunnelEnabled = buildIngressReport(
    config([funnelPeer]),
    facts({ serveMappings: [serveOnlyRoute], funnelMappings: [serveOnlyRoute] }),
    new Map([[7677, true]]),
  ).profiles[0];
  assert.equal(notFunnelEnabled.classification, "NO_MAPPING", "a route without an AllowFunnel entry must not satisfy a funnel profile even when the funnel command lists it");

  // Explicit allowFunnel: true satisfies a funnel profile.
  const funnelEnabled = buildIngressReport(
    config([funnelPeer]),
    facts({ serveMappings: [exactFunnel], funnelMappings: [exactFunnel] }),
    new Map([[7677, true]]),
  ).profiles[0];
  assert.equal(funnelEnabled.classification, "MAPPING_MATCHED", "an AllowFunnel-marked route satisfies a funnel profile regardless of bucket");

  // Explicit allowFunnel: false cannot satisfy a funnel profile.
  const explicitlyOff = buildIngressReport(
    config([funnelPeer]),
    facts({ funnelMappings: [mapping({ allowFunnel: false, identity: { ...mapping().identity!, allowFunnel: false } })] }),
    new Map([[7677, true]]),
  ).profiles[0];
  assert.equal(explicitlyOff.classification, "MISMATCH");
}
{
  // A funnel-enabled route to the same local port is a public-exposure
  // contradiction for a tailnet-private serve profile.
  const servePriv = profile({ id: "serve-priv", kind: "tailscale_serve", externalOrigin: "https://node.tail8d285a.ts.net:8443", allowedHosts: ["node.tail8d285a.ts.net:8443"] });
  const exposedRoute = mapping({
    hostPort: "priv.tail8d285a.ts.net:8443",
    allowFunnel: true,
    identity: { ...mapping().identity!, hostname: "priv.tail8d285a.ts.net", allowFunnel: true },
  });
  const exposed = buildIngressReport(
    config([servePriv]),
    facts({ serveMappings: [exposedRoute] }),
    new Map([[7677, true]]),
  ).profiles[0];
  assert.equal(exposed.classification, "MISMATCH", "a funnel-enabled route must never satisfy a serve profile");
  assert.ok(exposed.notes.some((note) => note.includes("exposed to the PUBLIC internet")), "the exposure earns a diagnostic note");
  // The human view marks the SAME route with the FUNNEL-EXPOSED marker. The
  // marker is derived from the observed route's allowFunnel flag, so the
  // observed mapping must carry it - otherwise the operator sees a
  // tailnet-private route with no public-exposure warning.
  assert.equal(exposed.observed?.allowFunnel, true, "the observed route carries the funnel-exposure flag the human view marks");
  const privateRoute = buildIngressReport(
    config([servePriv]),
    facts({ serveMappings: [mapping({ allowFunnel: false, identity: { ...mapping().identity!, allowFunnel: false } })] }),
    new Map([[7677, true]]),
  ).profiles[0];
  assert.notEqual(privateRoute.observed?.allowFunnel, true, "a tailnet-private route is not marked as funnel-exposed");
}
{
  // The exposure attribution is unproven, so a tailnet-private profile
  // must NOT report a positive match. The route identity carries
  // allowFunnel: false, which without this gate would read as a proven
  // private route even when the route may in fact be publicly exposed.
  const serveUnproven = profile({ id: "serve-unproven", kind: "tailscale_serve", externalOrigin: "https://node.tail8d285a.ts.net:8443", allowedHosts: ["node.tail8d285a.ts.net:8443"] });
  const unproven = buildIngressReport(
    config([serveUnproven]),
    facts({ serveMappings: [mapping()], serveFunnelAttributionComplete: false }),
    new Map([[7677, true]]),
  ).profiles[0];
  assert.notEqual(unproven.classification, "MAPPING_MATCHED", "an unproven exposure must never be reported as a proven private route");
  assert.equal(unproven.classification, "UNKNOWN", "an unproven exposure is inconclusive, not a mismatch and not a match");
}
{
  // The exposure attribution is unproven AND the observed route differs from
  // the configured profile. The difference is real, but it was derived from a
  // route identity whose exposure could not be read, so it may be the
  // exposure that differs rather than the route. A dropped signal proves
  // nothing in either direction, so the classification stays UNKNOWN instead
  // of reporting a positive MISMATCH.
  const serveUnprovenDiffers = profile({
    id: "serve-unproven-differs",
    kind: "tailscale_serve",
    externalOrigin: "https://node.tail8d285a.ts.net:8443",
    allowedHosts: ["node.tail8d285a.ts.net:8443"],
  });
  const unprovenDiffers = buildIngressReport(
    config([serveUnprovenDiffers]),
    facts({ serveMappings: [differentPort], serveFunnelAttributionComplete: false }),
    new Map([[7677, true]]),
  ).profiles[0];
  assert.equal(unprovenDiffers.classification, "UNKNOWN", "an unproven exposure never yields a positive mismatch");
  assert.notEqual(unprovenDiffers.classification, "MISMATCH", "a dropped exposure signal proves no difference");
}
{
  // The same shape for a FUNNEL profile, whose attribution completeness is
  // read from the funnel document: an unproven funnel attribution must not
  // yield a positive mismatch either.
  const funnelUnprovenDiffers = profile({
    id: "funnel-unproven-differs",
    kind: "tailscale_funnel",
    externalOrigin: "https://node.tail8d285a.ts.net:8443",
    allowedHosts: ["node.tail8d285a.ts.net:8443"],
  });
  const unprovenFunnel = buildIngressReport(
    config([funnelUnprovenDiffers]),
    facts({ funnelMappings: [differentPort], funnelFunnelAttributionComplete: false }),
    new Map([[7677, true]]),
  ).profiles[0];
  assert.equal(unprovenFunnel.classification, "UNKNOWN", "an unproven funnel exposure never yields a positive mismatch");
  assert.notEqual(unprovenFunnel.classification, "MISMATCH", "a dropped funnel exposure signal proves no difference");
}
{
  // With the attribution COMPLETE, the same difference is a real mismatch.
  // The gate must not swallow a genuine finding.
  const serveCompleteDiffers = profile({
    id: "serve-complete-differs",
    kind: "tailscale_serve",
    externalOrigin: "https://node.tail8d285a.ts.net:8443",
    allowedHosts: ["node.tail8d285a.ts.net:8443"],
  });
  const completeDiffers = buildIngressReport(
    config([serveCompleteDiffers]),
    facts({ serveMappings: [differentPort] }),
    new Map([[7677, true]]),
  ).profiles[0];
  assert.equal(completeDiffers.classification, "MISMATCH", "a complete attribution still reports a genuine mismatch");
}
{
  // non-tailscale kinds: informational, no tailscale observation applies
  const tunnel = profile({ id: "tunnel-1", kind: "secure_mcp_tunnel", audience: "owner_public", target: "secure_tunnel_listener", externalOrigin: "https://kontrol-node.tail-scale.ts.net", allowedHosts: ["kontrol-node.tail-scale.ts.net"] });
  const tunnelStatus = buildIngressReport(config([tunnel]), facts({}), new Map()).profiles[0];
  assert.equal(tunnelStatus.classification, "NO_MAPPING");
  assert.equal(tunnelStatus.expectedLocalTarget, null, "secure_tunnel_listener gets no mapping and no probe");
  assert.ok(tunnelStatus.notes.some((note) => note.includes("deliberately not observed or probed")));
  const bridge = profile({ id: "bridge-1", kind: "https_bridge", audience: "owner_public", target: "public_oauth_listener", externalOrigin: "https://kontrol-node.tail-scale.ts.net", allowedHosts: ["kontrol-node.tail-scale.ts.net"] });
  const bridgeStatus = buildIngressReport(config([bridge]), facts({}), new Map()).profiles[0];
  assert.equal(bridgeStatus.classification, "EXTERNAL_UNVERIFIED", "a bridge is configured but cannot be positively verified by Tailscale status");
  assert.ok(bridgeStatus.notes.some((note) => note.includes("qualify the bridge with scripts/probe-ingress-bridge.mjs")));
}
{
  // target listener not enabled -> nothing to observe locally
  const publicProfile = profile({ id: "serve-public", audience: "owner_public", target: "public_oauth_listener", externalOrigin: "https://kontrol-node.tail-scale.ts.net", allowedHosts: ["kontrol-node.tail-scale.ts.net"] });
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
  classifyProfile({ profile: servePeer, facts: facts({ serveMappings: [mapping()] }), expectedLocalPort: 7677 }),
  "MAPPING_MATCHED",
);

// --- redaction: exact key sets, nothing else ---
{
  const tunnel = profile({ id: "tunnel-1", kind: "secure_mcp_tunnel", audience: "owner_public", target: "secure_tunnel_listener", externalOrigin: "https://kontrol-node.tail-scale.ts.net", allowedHosts: ["kontrol-node.tail-scale.ts.net"] });
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
  const funnelPublic = profile({ id: "funnel-public", kind: "tailscale_funnel", audience: "owner_public", target: "public_oauth_listener", externalOrigin: "https://kontrol-node.tail-scale.ts.net:8443", allowedHosts: ["kontrol-node.tail-scale.ts.net:8443"] });
  const entries = buildIngressPlan(config([funnelPublic], { publicBaseUrl: "https://kontrol-node.tail-scale.ts.net:8443" }));
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
  const servePublic = profile({ id: "serve-public", audience: "owner_public", target: "public_oauth_listener", externalOrigin: "https://kontrol-node.tail-scale.ts.net", allowedHosts: ["kontrol-node.tail-scale.ts.net"] });
  const entries = buildIngressPlan(config([servePublic]));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].command, "tailscale serve --bg --https=443 http://127.0.0.1:7678");
  assert.equal(entries[0].refused, undefined);
  assert.ok(entries[0].note?.includes("one-canonical-owner-public rule"), "serve->public_oauth_listener must note the OAuth-mode rules");
}

// --- plan: refusals ---
{
  const funnelStandby = profile({ id: "funnel-standby", kind: "tailscale_funnel", audience: "owner_public", target: "public_oauth_listener", externalOrigin: "https://kontrol-node.tail-scale.ts.net:8443", allowedHosts: ["kontrol-node.tail-scale.ts.net:8443"], enabled: false });
  const entries = buildIngressPlan(config([funnelStandby]));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].command, undefined);
  assert.match(entries[0].note ?? "", /disabled/);
}
{
  const tunnel = profile({ id: "tunnel-1", kind: "secure_mcp_tunnel", audience: "owner_public", target: "secure_tunnel_listener", externalOrigin: "https://kontrol-node.tail-scale.ts.net", allowedHosts: ["kontrol-node.tail-scale.ts.net"] });
  const entries = buildIngressPlan(config([tunnel], { authMode: "tunnel" }));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].command, undefined);
  assert.equal(entries[0].refused, "tunnel-mode owner listener is unauthenticated at the app layer; never proxy it through Tailscale");
}
{
  // target listener not enabled -> refusal, never a half-specified command
  const servePublic = profile({ id: "serve-public", audience: "owner_public", target: "public_oauth_listener", externalOrigin: "https://kontrol-node.tail-scale.ts.net", allowedHosts: ["kontrol-node.tail-scale.ts.net"] });
  const entries = buildIngressPlan(config([servePublic], { publicMcp: undefined }));
  assert.equal(entries[0].command, undefined);
  assert.match(entries[0].refused ?? "", /public OAuth listener/);
}

// --- plan: disabled skip + bridge informational ---
{
  const entries = buildIngressPlan(config([
    profile({ id: "standby", enabled: false }),
    profile({ id: "bridge-1", kind: "https_bridge", audience: "owner_public", target: "public_oauth_listener", externalOrigin: "https://kontrol-node.tail-scale.ts.net", allowedHosts: ["kontrol-node.tail-scale.ts.net"] }),
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
  { authMode: "oauth", peerEnabled: false, hasPeerCredentials: false, publicBaseUrl: "https://kontrol-node.tail-scale.ts.net" },
);

// --- default local probe: refuses a dead loopback port (bounded, no throw) ---
{
  const up = await defaultLocalProbe(7677).catch(() => false);
  assert.equal(typeof up, "boolean", "the probe resolves a boolean even when the connection fails");
  const dead = await defaultLocalProbe(1); // port 1: nothing listens, fails fast
  assert.equal(dead, false, "a closed loopback port must resolve false, never throw");

  const fakeListener = createServer((_request, response) => {
    response.writeHead(401, { "www-authenticate": 'Bearer resource_metadata="http://127.0.0.1/.well-known/oauth-protected-resource/mcp"' });
    response.end(JSON.stringify({ error: "unauthorized" }));
  });
  await new Promise<void>((resolve) => fakeListener.listen(0, "127.0.0.1", resolve));
  const address = fakeListener.address();
  assert.ok(address && typeof address === "object");
  assert.equal(await defaultLocalProbe(address.port), true, "a valid MCP auth challenge proves the expected local listener protocol is serving");
  fakeListener.close();
}

console.log("profile-status: all assertions passed");
