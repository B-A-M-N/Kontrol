# Ingress profiles and route lifecycle

Kontrol describes how external origins are expected to reach its listeners as
a strict JSON profile list in `KONTROL_INGRESS_PROFILES` (see `.env.example`
for the exact schema). The `kontrol ingress` CLI exposes read-only
observation/planning and an explicitly authorized, receipt-backed
Serve/Funnel lifecycle for eligible Tailscale profiles.

## Mutation boundary

`kontrol ingress inspect`, `plan`, and `doctor` do not mutate Tailscale.
`apply` and `disable` require `--confirm`, persist an operation intent before
changing a route, and save bounded before/after evidence in
`<stateDir>/ingress-operations.json`. An interrupted operation remains
visible until `reconcile` observes its outcome. Nonzero command results are
uncertain and are never retried automatically.

`kontrol ingress doctor` also projects the latest explicit qualification
observation from `<stateDir>/ingress-health.json`. The public bridge probe can
write a redacted observation when given `--profile-id`, `--state-dir`, and
`--build-id`; include `--authorization-file`, `--workspace-path`, and
`--long-post-ms 45000` to qualify the authenticated MCP catalog, SSE, and
long-running POST. These are timestamped one-shot observations, not a live
monitor or automatic failover signal.

## Workspace App panel

Calling the authenticated `ingress_management` tool with `action: "inspect"`
opens the Workspace App ingress panel. It uses the same exact mapping report,
health observations, and operation receipts as `kontrol ingress doctor`; a
local TCP observation, external TLS probe, and authenticated MCP qualification
are displayed as separate evidence. The panel exports only this redacted
projection. `apply` and `disable` require an owner/reviewer principal, an
explicit confirmation in the UI, and a second server-side confirmation flag.
They change a Kontrol-owned Tailscale route; enabling or disabling a profile in
configuration remains a separate deployment change.

When the Workspace App is opened through the owner-facing stdio bridge, the
bridge adds its local endpoint preference state to the ingress projection and
supports `set_preference` for a complete ordered list of the configured
endpoint IDs. The order is persisted atomically in an owner-only
`~/.kontrol/bridge-endpoint-preferences.json` file, or the absolute path in
`KONTROL_BRIDGE_PREFERENCE_FILE`. The preference takes effect on subsequent
connection attempts; it does not move an already active MCP transport. Only
the owner-facing bridge exposes this control. Worker bridges cannot change
endpoint preference. Add `ingress_management` to each owner profile's
`allowedCapabilities` to use the panel and this control. If endpoint profile
IDs change, update or remove the saved preference file before restarting the
bridge.

## Worker bridge endpoint failover

The stdio worker bridge accepts an ordered JSON list in
`KONTROL_BRIDGE_ENDPOINTS`. Each entry identifies one exact `/mcp` endpoint,
TLS authority, worker principal, private/public classification, worker tool
capabilities, resource URIs, authentication method, and bounded circuit
policy. This bridge requires `principal: "worker"` on every entry. Public
OAuth `owner_public` credentials must use a separate owner-facing client and
are rejected here; the Caddy edge intentionally strips worker attribution
headers.

For explicit independent OAuth identities, the packaged
`scripts/mcp-owner-stdio-bridge.mjs` entrypoint is separate from the worker
bridge. It requires public `owner_public` profiles with an endpoint-specific
owner-only bearer file and exact resource identity for each origin. The
operator must authorize each origin independently and provide its own token
file; tokens are never shared across origins. A route switch therefore uses
the credential already assigned to that exact OAuth resource and does not
silently reuse the previous origin's token. This does not change the server's
single canonical origin for interactive OAuth registration; use the owner
bridge only where each endpoint is independently provisioned and authorized.

Before an endpoint becomes ready, the bridge checks the endpoint-specific
authorization source, fetches same-origin OAuth protected-resource metadata
when configured, opens a fresh MCP session, checks server identity, and
retrieves `tools/list`. The effective downstream catalog is the intersection
of the bridge worker allowlist, the profile capabilities, and that upstream
catalog. Resource discovery and reads are limited to exact profile URIs.
Candidate failures open that profile's circuit after its configured threshold;
recovery uses a fresh qualification attempt after the cooldown. Endpoint
switches send downstream tool/resource list-changed notifications.

The bridge keeps its downstream stdio server alive while reconnecting, but it
does not replay calls. A call already sent when a route fails has an uncertain
outcome and is returned as an error; the caller must reconcile the result
before deciding what to do next. Reconnection establishes a new MCP session.
After a worker `open_workspace` succeeds, the bridge reattaches that same
bound checkout to a fresh transport session and verifies the workspace ID
before accepting the candidate. It never creates a worktree during recovery
or replays an uncertain `open_workspace` call. The caller must reconcile
uncertain calls and must not blindly replay mutations, submissions, or other
state-changing calls. `KONTROL_BRIDGE_URL` remains supported as a legacy
single-endpoint configuration. The example in `.env.example` shows two private
worker Serve endpoints; endpoint reachability and independent failure domains
still require deployment-specific qualification.

The controller only issues profile-specific `serve` or `funnel` commands. It
never invokes a global reset. It refuses a route already using the selected
node and HTTPS port and refuses `disable` unless a matching Kontrol ownership
receipt exists. Existing routes without a Kontrol receipt are operator owned.
Unsupported status schemas and node identities fail closed.

## Profile kinds, audiences, targets, privacy

| kind                 | audience        | target                  | privacy class     | inspected? | planned? |
|----------------------|-----------------|-------------------------|-------------------|------------|----------|
| `tailscale_serve`    | peer            | `peer_listener`         | TAILNET_PRIVATE   | yes        | yes      |
| `tailscale_serve`    | owner_public    | `public_oauth_listener` | TAILNET_PRIVATE   | yes        | yes (note) |
| `tailscale_funnel`   | peer            | `peer_listener`         | PUBLIC_INTERNET   | yes        | REFUSED  |
| `tailscale_funnel`   | owner_public    | `public_oauth_listener` | PUBLIC_INTERNET   | yes        | yes      |
| `https_bridge`       | any             | any                     | PUBLIC_INTERNET   | informational | informational (see below) |
| `secure_mcp_tunnel`  | owner_public    | `secure_tunnel_listener`| PROVIDER_RELAY    | never probed | REFUSED |

## The one-canonical-owner-public rule

There is exactly ONE canonical public origin for owner-facing MCP traffic: the
`publicBaseUrl` origin. Every ENABLED `owner_public` profile must use that
exact origin (disabled standby profiles are exempt). Public ingress must also
always land on the **OAuth-authenticated public listener**.

> **WARNING: never expose the tunnel-mode owner listener.** In tunnel mode
> (`KONTROL_AUTH_MODE=tunnel`) the owner listener is UNAUTHENTICATED at the
> app layer — access control is delegated to the OpenAI Secure MCP Tunnel.
> Public ingress (Tailscale Funnel or an HTTPS bridge) must NEVER proxy to it.
> The planner refuses any such mapping; `kontrol ingress inspect` never probes
> that listener.

## Inspect

`kontrol ingress inspect [--json]` compares each profile against live
Tailscale state and (for enabled tailscale profiles) a bounded loopback MCP
initialize probe. The local probe requires the expected OAuth or peer
authentication challenge; a TCP-open port alone is not considered ready.
Classification per profile:

- `DISABLED` — standby profile, nothing applies.
- `LOCAL_DOWN` — the expected local target port is not connectable.
- `NO_MAPPING` — no matching route in the observed tailscale mappings.
- `MISMATCH` — a route exists for this profile's port but its proxy target
  differs, OR a serve profile's matching route is funnel-enabled (the route
  is exposed to the public internet while the profile expects a
  tailnet-private route; the notes call this out and the human view marks
  the observed route FUNNEL-EXPOSED).
  - `MAPPING_MATCHED` — the observed Tailscale node, HTTPS port, handler path,
  upstream scheme/host/port/path, backend state, and Serve/Funnel exposure all
  match the configured route. This proves mapping only; it does not prove
  authenticated MCP readiness or external reachability.
  - `UNKNOWN` — the status schema or node identity cannot prove the route.

An enabled Tailscale profile must use the node's Tailscale-managed `.ts.net`
name. `MAPPING_MATCHED` requires that exact name to agree with `Self.DNSName`;
unsupported status formats remain inconclusive. `READY` is reserved for an
authenticated MCP protocol probe over the intended route.

Exit code: 0 only when every enabled tailscale profile is MAPPING_MATCHED and the
tailscale facts could be read; otherwise 1 (problems are always printed).

```sh
KONTROL_INGRESS_PROFILES='[{"id":"serve-1","kind":"tailscale_serve","audience":"peer","externalOrigin":"https://node.tail8d285a.ts.net:8443","target":"peer_listener","enabled":true,"allowedHosts":["node.tail8d285a.ts.net:8443"]}]' kontrol ingress inspect
```

## Plan

`kontrol ingress plan [--json]` is a PURE dry-run planner: no probes, no
subprocesses. It prints, per enabled tailscale profile, the exact command an
operator would run by hand, for example:

    plan only — nothing was executed
      [serve-1] tailscale_serve (TAILNET_PRIVATE)
        command: tailscale serve --bg --https=8443 http://127.0.0.1:7677

It REFUSES (prints a reason, never a command) when:

- the profile targets `secure_tunnel_listener` — the tunnel-mode owner
  listener is unauthenticated at the app layer and must never be proxied
  through Tailscale;
- a funnel would target `peer_listener` — public peer-bearer exposure is not
  supported in this build (needs P0-05 edge hardening first);
- the profile's target listener is not enabled in this deployment.

Disabled profiles are listed as skipped; https_bridge profiles appear as
informational entries with no command: a bridge is NOT a Tailscale mapping
but a reverse-proxy deployment on your own VPS. Its audited asset lives in
deploy/bridge/Caddyfile.example (with deploy/bridge/README.md), and it is
qualified END TO END with scripts/probe-ingress-bridge.mjs against the
PUBLIC origin - 401 challenge on unauthenticated /mcp, forged-authority
header resistance, 404 catch-all, OAuth discovery origin binding, and SSE
heartbeat cadence. Tailscale status cannot observe the bridge, so inspect
always reports NO_MAPPING for this kind. A secure_mcp_tunnel profile is REFUSED, not informational: its
target owner listener is unauthenticated at the app layer, so plan never
suggests a command for it.

Exit code: 0 only when every enabled tailscale profile got a command and no
profile was refused; otherwise 1.

## Apply, disable, reconcile, and doctor

`kontrol ingress apply <profile-id> --confirm` applies an enabled Serve or
Funnel profile only after verifying the local listener's MCP authentication
boundary, Tailscale backend, node DNS identity, and recognized route schema.
It refuses to overwrite any route already using the configured node and
HTTPS port. The explicit `--confirm` authorizes the route change, including
Funnel's public exposure.

`kontrol ingress disable <profile-id> --confirm` removes only the root route
with a matching durable Kontrol apply receipt. It passes the exact HTTPS port
and root path to Tailscale's `off` command; it never resets other mappings.
If the route is already absent, disable resolves from observed state.

`kontrol ingress reconcile <profile-id>` reads the durable operation record
and current Tailscale facts. It does not execute route commands or retry an
uncertain operation. `kontrol ingress doctor [--json]` shows profile
classification and recent receipts. `MAPPING_MATCHED` proves the route tuple;
an authenticated external probe is still required for end-to-end readiness.

## Environment

- `KONTROL_INGRESS_PROFILES` — the profile list (JSON array; see
  `.env.example`).
- `KONTROL_TAILSCALE_BIN` — optional override for the tailscale binary
  (default: `tailscale` resolved on PATH).

## Packaged bridge asset

Published packages include `deploy/bridge/`. The staging packer writes
`deploy/bridge/ingress-config-manifest.json` with the SHA-256 of the exact
packaged `Caddyfile.example`; deployments should copy and validate that
packaged file, then retain its hash with the deployment receipt. The source
tree asset test alone does not qualify an installed bridge.

The bridge operator owns public DNS and ports 80/443 on the VPS; Caddy owns
public TLS issuance and renewal. Kontrol's public OAuth listener remains on
its configured loopback port, while Tailscale Serve owns the private upstream
HTTPS port. Rotate OAuth credentials through Kontrol's normal credential
workflow, keep them out of Caddy configuration, and verify a fresh OAuth
authorization after rotation. Before changing the deployed Caddyfile, retain
the current file and its hash; validate the candidate with `caddy adapt` and
`caddy validate`, then reload. Roll back by restoring only that saved file and
revalidating it. Never reset unrelated Tailscale routes as part of bridge
rollback.

An optional independent private route is documented in
`deploy/bridge/Caddyfile.multipath.example` and
`deploy/bridge/KontrolGateway.Caddyfile.example`. The host gateway is bound
only to the configured Tailscale and WireGuard interface addresses and
requires mTLS plus exact source-IP checks. Public Caddy verifies its
certificate authority and shared service identity. Active health checks
select the first healthy route for new requests; request retries remain
disabled so an uncertain MCP POST cannot be replayed. The package manifest
hashes both templates. Configuration validation is not evidence of a running
WireGuard peer or successful path failover; those require real-host probes.
