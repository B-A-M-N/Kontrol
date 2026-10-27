# Kontrol public HTTPS bridge (PR-D, P1-09)

Self-hosted, vendor-independent public ingress for clients that cannot join
the tailnet: a VPS you control terminates public HTTPS for your own domain,
runs Tailscale as a dedicated bridge node, and proxies ONLY the Kontrol MCP
+ OAuth surface to a private Tailscale Serve upstream on the Kontrol host.

```
Hosted MCP client -> https://kontrol.example.com/mcp
  -> internet-facing Caddy on this VPS (TLS, this directory Caddyfile.example)
  -> private Tailscale Serve upstream https://...:9443 [bridge-node-only ACL]
  -> HTTP 127.0.0.1:7678 on the Kontrol host (KONTROL_PUBLIC_MCP listener)
  -> audience-validated OAuth -> the ONE Kontrol runtime
```

## What this bridge is NOT

- It is NOT an approval authority. Every call is independently authenticated
  by the Kontrol public OAuth listener (bearer tokens, audience-bound).
- It is NOT the Secure MCP Tunnel (topology D). That provider relay remains a
  separate transport with its own contract.
- It is NOT a generic proxy. Only the allowlisted MCP/OAuth routes pass;
  everything else returns 404.
- It does NOT enable automatic hosted-client failover. There is exactly ONE
  canonical public origin for owner-facing OAuth (the KONTROL_PUBLIC_BASE_URL
  origin). Moving between a Funnel origin and this bridge origin requires
  reconfiguring the canonical URL, fresh OAuth discovery/client consent, and
  a fresh MCP transport.
- This Caddy public OAuth bridge is not a worker-bridge failover endpoint.
  The stdio worker bridge accepts only `principal: "worker"` profiles. The
  separate `scripts/mcp-owner-stdio-bridge.mjs` can use independently
  authorized public OAuth profiles with distinct bearer files and resource
  identities. See `docs/ingress.md` and `.env.example` for the private worker
  profile example. Hosted owner-client migration remains an explicit
  reconfiguration.

## Proving route isolation

A probe that checks "a forbidden path returns 404" proves nothing when the
upstream also returns 404 for that path: a proxy that forwards EVERY path
passes that check. Route isolation is proven the other way round, against a
controlled upstream that answers 200 on every path:

```sh
node scripts/bridge-route-isolation.mjs --config /etc/caddy/Caddyfile \
  --build-id "$BUILD_ID" --receipt /var/lib/kontrol/bridge-isolation.json
```

The harness runs the configuration under test in a real Caddy instance and
asserts that:

- an allowlisted route reaches the controlled upstream;
- every forbidden route still returns the bridge's OWN 404, even though the
  upstream answered 200 on the same path;
- no forged authority header (`X-Kontrol-*`, `X-Forwarded-*`,
  `Tailscale-User-*`, `Forwarded`) reaches the upstream;
- `Authorization`, `Mcp-Session-Id`, and `Last-Event-ID` survive the
  edge;
- the upstream sees the PINNED Host, never the client's Host.

The receipt is redacted and records the configuration hash, the Caddy
version, the allowlist, and every observation.

## VPS prerequisites

1. A Linux VPS with its own domain (kontrol.example.com) and ports 80/443
   reachable from the internet (80 for ACME, 443 for traffic).
2. Tailscale installed and joined to YOUR tailnet with a dedicated tag, e.g.
   tag:kontrol-bridge. Do NOT enable subnet routing or exit-node features.
3. On the Kontrol host, restrict the tailnet ACL so ONLY the bridge node can
   reach TCP 9443; no other peer may connect.
4. On the Kontrol host run BY HAND: tailscale serve --bg --https=9443
   http://127.0.0.1:7678 (Kontrol itself performs ZERO Tailscale mutations).
5. Kontrol runs with KONTROL_AUTH_MODE=oauth and KONTROL_PUBLIC_MCP_ENABLED=1
   (public listener on loopback 127.0.0.1:7678, KONTROL_PUBLIC_MCP_PORT).
6. Set the canonical public origin KONTROL_PUBLIC_BASE_URL to
   https://kontrol.example.com and enable an owner_public ingress profile of
   kind https_bridge with target "public_oauth_listener" and that origin.
   allowedHosts MUST contain BOTH the public origin hostname AND the exact
   upstream tailnet DNS name the Caddyfile pins the Host to: the public
   listener enforces an exact Host allowlist and rejects every bridged
   request with 403 otherwise (the Caddyfile pins Host to
   {upstream_hostport}, so the listener sees the tailnet DNS name). Example:
   "allowedHosts":["kontrol.example.com","kontrol-node.tail-scale.ts.net"].
   The listener matches the hostname-only form, so an explicit ":9443" port
   in the Caddyfile upstream is fine.

## Deployment (Caddy)

1. Install Caddy from the official repository. Keep it patched.
2. Copy Caddyfile.example to /etc/caddy/Caddyfile (or an included site
   file). Edit BOTH the site domain and the upstream host
   (kontrol-node.tail-scale.ts.net) to YOUR real values. Use the exact
   .ts.net DNS name displayed by tailscale status --json (Self.DNSName,
   trailing dot removed) - never a fabricated host.
3. Audit the diff. The file must retain, unchanged:
   - the full request header strip list (parity with BRIDGE_STRIP_HEADERS
     and the X-Kontrol-* prefix rule in src/ingress/proxy-context.ts);
   - header_up Host with the upstream_hostport placeholder (Host/SNI pinned
     to the upstream);
   - flush_interval -1 and streaming-safe timeouts (MCP SSE heartbeats
     every KONTROL_MCP_SSE_HEARTBEAT_MS seconds, 15 by default, and POST
     responses can legitimately last 45+ seconds; never insert an idle or
     response cutoff below that);
   - upstream TLS verification (no tls_insecure_skip_verify, ever);
   - request_body max_size and the 404 catch-all.
   - global max_header_size 32KiB and reverse_proxy max_conns_per_host 128.
4. Validate and receipt the exact installed configuration before reloading:

       node scripts/qualify-caddy-bridge.mjs \
         --config /etc/caddy/Caddyfile \
         --bridge-node tag:kontrol-bridge \
         --public-host kontrol.example.com \
         --upstream kontrol-node.tail-scale.ts.net:9443 \
         --build-id BUILD_ID \
         --receipt /var/lib/kontrol/bridge-qualification.json

   The command runs `caddy version`, `caddy validate`, and `caddy adapt` on
   that exact file. It checks the adapted proxy count, route allowlist,
   upstream authority, Host pin, TLS verification, and 404 fallback, then
   records both the source-file and adapted-configuration hashes, Kontrol
   build ID, and deployment identities. The receipt
   explicitly leaves route isolation unproven; that requires the controlled
   upstream negative test and the public-host probes below. Reload Caddy only
   after validation succeeds.
5. systemd hardening (typical of the Caddy package): NoNewPrivileges,
   ProtectSystem=strict, PrivateTmp, capability bounding to net_bind_service.
   Do not grant the bridge more.

## Header policy

- Client-supplied Forwarded, X-Forwarded-*, X-Real-IP, CF-Connecting-IP,
  True-Client-IP, Tailscale-User-*, and every X-Kontrol-* header are
  DELETED before proxying (the strip list). Caddy re-derives only its own
  diagnostic X-Forwarded-* values at the trusted edge; the Kontrol public
  listener treats forwarded headers as never-authorizing data.
- The Host header is pinned to the upstream host:port. A caller-supplied
  Host can never influence OAuth redirects or token audience.

  CONSEQUENCE:
  the public listener's Host allowlist (the enabled owner_public ingress
  profile's allowedHosts, see step 6) must include the upstream tailnet DNS
  name, or every bridged request is rejected with 403 before auth.
- Do not add client identity headers (the bridge has no identity to assert).

## Route allowlist

Only these paths are proxied: /mcp, /.well-known/*, /authorize, /token,
/register, /revoke, /healthz. Everything else 404s. Never proxy: /acp,
diagnostics or readiness internals, Workspace App assets, host shell or
filesystem endpoints, or any admin surface.

## Qualification

Run the bridge probe against the PUBLIC origin (not the upstream directly):

    node scripts/probe-ingress-bridge.mjs --url https://kontrol.example.com
      --authorization-file FILE --workspace-path /approved/workspace
      --profile-id public-main --state-dir /var/lib/kontrol
      --build-id BUILD_ID [--heartbeat-ms MS] [--long-post-ms 45000]

The probe asserts, end to end at the bridge:

- /healthz liveness through the bridge;
- an unauthenticated /mcp initialize receives a proper 401/OAuth challenge
  (no operation ever runs without a valid token);
- forged authority headers (Forwarded, X-Forwarded-For, X-Kontrol-Role,
  Tailscale-User-Login) do NOT alter authorization outcomes;
- a non-allowlisted path returns 404 at the bridge (LIMITATION: every
  probed path is also 404 at the upstream listener itself, so a bridge that
  proxies EVERYTHING still passes the probe; route isolation is proven by
  auditing the deployed Caddyfile against the audited example - step 3);
- the OAuth discovery document is reachable and consistent with the
  canonical origin;
- an authenticated initialize, tools/list, and a GET SSE stream that delivers
  multiple heartbeat frames within the expected cadence;
- with workspace and authorization options, an authenticated long-running POST
  to await_workspace_events. It must span at least 45 seconds, observe three heartbeat frames, and return
  the matching MCP response. The server wait includes one extra heartbeat
  interval so the final heartbeat is observed before the response completes.

When `--profile-id`, `--state-dir`, and `--build-id` are supplied together,
the probe records a bounded, redacted observation in
`<state-dir>/ingress-health.json`. The receipt includes profile, listener,
build, origin, principal class, checks, failure count, timestamp, and a hash of
the MCP session identity. It never stores credentials or response bodies.
`kontrol ingress doctor` displays the latest observation per profile. This is
a one-shot qualification record; it does not run a monitoring loop.

Real-host qualification also requires (do these by hand, record receipts):
- from a NON-tailnet host: the bridge is reachable and authenticated;
- from the tailnet: the bridge upstream port 9443 is NOT reachable by any
  node except the bridge;
- the Secure MCP Tunnel and owner flows continue to work unchanged
  (regression: scripts/probe-mcp-tunnel.mjs).

The --authorization-file must contain the RAW Authorization header value
including the "Bearer " prefix - the same convention as
scripts/probe-mcp-tunnel.mjs and KONTROL_MCP_CANARY_AUTH_FILE. A bare token
yields 401 at authenticated-initialize.
The workspace path must be within the public listener's configured workspace
roots. Keep the state directory writable only by the Kontrol operator.

## Rate limiting through the bridge

Through the Serve hop the public listener's socket peer is loopback, so
every bridged client shares ONE per-IP edge bucket (the OAuth-surface cap,
the /mcp cap, and the authorize-attempt throttle). Size
KONTROL_PUBLIC_MCP_EDGE_* for that shared budget; one client can otherwise
exhaust the authorize throttle and lock out every other public client.
(Tailscale Serve does not forward the client IP, and proxyPeerIps cannot
recover it through this hop; the collapsed bucket is inherent to the
topology. The same applies to a Funnel origin.)

## Failure isolation

An upstream outage (tailscaled down, Serve mapping removed, Kontrol host
unreachable) must degrade ONLY this bridge: Caddy returns 502/504 while the
Kontrol core, its other ingress paths, and review/session ledgers remain
healthy. Never restart Kontrol core because the bridge relay is down.

## Optional Tailscale and WireGuard private paths

For an independently operated private route, use
`Caddyfile.multipath.example` at the public edge and
`KontrolGateway.Caddyfile.example` on the Kontrol host. The topology is:

```
Public Caddy -> Tailscale IP:9444 ─┐
                                   ├-> host HTTPS gateway -> 127.0.0.1:7678
Public Caddy -> WireGuard IP:9444 ─┘
```

Both interface addresses terminate the same host gateway and Kontrol runtime.
The gateway binds only the configured Tailscale and WireGuard addresses. It
requires a bridge client certificate signed by its private client CA and also
checks the exact bridge source addresses. The public Caddy client verifies the
gateway certificate against its dedicated CA file, checks the shared
`kontrol-gateway.internal` TLS identity, and presents its mTLS client
certificate. The gateway forwards only the public MCP/OAuth allowlist to the
loopback public listener and pins the Host to
`kontrol-gateway.internal:9444`; add `kontrol-gateway.internal` to that
listener's exact `allowedHosts` list.

Provision WireGuard independently of Kontrol. Permit only the bridge peer and
the host gateway address in `AllowedIPs`; do not enable forwarding, subnet
routing, or an exit node. Host and bridge firewalls must default-deny the
gateway port and permit only the exact Tailscale/WireGuard bridge addresses.
Keep gateway certificates, CA files, and private keys outside the checkout,
readable only by Caddy, and rotate the client certificate and CA as a planned
two-sided change. The template does not bind a wildcard address and must not
be changed to do so.

The public-edge template uses ordered `first` selection with active `/healthz`
checks. It has no Caddy request retry directives: when a backend dies during
an MCP POST, that operation remains uncertain and the client must reconcile
before retrying. Health checks move new requests to WireGuard after Tailscale
is classified unhealthy; the next MCP transport still initializes a fresh
session against the same runtime. Verify the adapted configuration before
reload:

    node scripts/qualify-caddy-bridge.mjs \
      --config /etc/caddy/Caddyfile \
      --bridge-node tag:kontrol-bridge \
      --public-host kontrol.example.com \
      --upstream 100.64.0.2:9444,10.74.0.2:9444 \
      --upstream-host kontrol-gateway.internal:9444 \
      --build-id BUILD_ID \
      --receipt /var/lib/kontrol/bridge-qualification.json

The receipt records both ordered upstreams and states that retries are
disabled. This validates the effective Caddy configuration; it does not prove
the WireGuard handshake, firewall policy, certificate deployment, or live
route failover. Exercise each link independently and during an active SSE
stream, retain the results with the same build and config hashes, and confirm
that the bridge degrades without restarting Kontrol. Caddy's current
`reverse_proxy` contract documents first-available selection, active health
checks, and request retry behavior in its
[official reverse proxy documentation](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy).

## Files in this directory

- Caddyfile.example - the audited reverse-proxy policy (enforced by
  src/ingress/bridge-asset.test.ts against the Kontrol source contracts).
- Caddyfile.multipath.example - optional public edge using independently
  health-checked Tailscale and WireGuard private paths.
- KontrolGateway.Caddyfile.example - exact-interface host gateway with source
  allowlists, mTLS, and the public listener route allowlist.
- README.md - this document.

The packaged deployment qualification tool is
`scripts/qualify-caddy-bridge.mjs`. It validates and receipts the installed
Caddy configuration; it does not claim live route-isolation evidence.
