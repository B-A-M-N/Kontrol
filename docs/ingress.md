# Ingress profiles: inspect and plan (P1-08)

Kontrol describes how external origins are expected to reach its listeners as
a strict JSON profile list in `KONTROL_INGRESS_PROFILES` (see `.env.example`
for the exact schema). The `kontrol ingress` CLI commands are READ-ONLY
observation and dry-run planning tools for those profiles.

## Zero-mutation guarantee

This build performs **zero Tailscale mutations**. `kontrol ingress inspect`
and `kontrol ingress plan` never start, stop, or reconfigure Tailscale: they
run only the read-only `tailscale version`, `tailscale status --json`,
`tailscale serve status --json`, and `tailscale funnel status --json`
commands. The `apply` and `disable` subcommands **do not exist yet** — a later
PR may add them behind explicit operator consent.

## Profile kinds, audiences, targets, privacy

| kind                 | audience        | target                  | privacy class     | inspected? | planned? |
|----------------------|-----------------|-------------------------|-------------------|------------|----------|
| `tailscale_serve`    | peer            | `peer_listener`         | TAILNET_PRIVATE   | yes        | yes      |
| `tailscale_serve`    | owner_public    | `public_oauth_listener` | TAILNET_PRIVATE   | yes        | yes (note) |
| `tailscale_funnel`   | peer            | `peer_listener`         | PUBLIC_INTERNET   | yes        | REFUSED  |
| `tailscale_funnel`   | owner_public    | `public_oauth_listener` | PUBLIC_INTERNET   | yes        | yes      |
| `https_bridge`       | any             | any                     | PUBLIC_INTERNET   | informational | informational (PR-D) |
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
Tailscale state and (for enabled tailscale profiles) a bounded loopback
connect probe of the expected local target port. Classification per profile:

- `DISABLED` — standby profile, nothing applies.
- `LOCAL_DOWN` — the expected local target port is not connectable.
- `NO_MAPPING` — no matching route in the observed tailscale mappings.
- `MISMATCH` — a route exists for this profile's port but its proxy target
  differs, OR a serve profile's matching route is funnel-enabled (the route
  is exposed to the public internet while the profile expects a
  tailnet-private route; the notes call this out and the human view marks
  the observed route FUNNEL-EXPOSED).
- `MATCHED` — an observed route proxies to
  `http://127.0.0.1:<expected port>`. For funnel profiles the route
  must also be explicitly funnel-enabled: upstream tailscale renders the
  SAME status document for the serve and funnel status commands, so
  Kontrol matches funnel profiles only against routes carrying an
  explicit AllowFunnel:true for that exact host:port (never inferred
  from the port or the command bucket).

Note that external Host/origin equality cannot be verified from tailscale
status output alone: Tailscale terminates TLS and the mapping does not carry
the HTTP origin. Origin correctness is enforced at plan/config time (the
canonical-origin rule above), not at inspect time.

Exit code: 0 only when every enabled tailscale profile is MATCHED and the
tailscale facts could be read; otherwise 1 (problems are always printed).

```sh
KONTROL_INGRESS_PROFILES=[{"id":"serve-1","kind":"tailscale_serve","audience":"peer","externalOrigin":"https://node.tail8d285a.ts.net:8443","target":"peer_listener","enabled":true,"allowedHosts":["node.tail8d285a.ts.net:8443"]}] kontrol ingress inspect
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
informational entries with no command (bridge deployment files arrive in
PR-D). A secure_mcp_tunnel profile is REFUSED, not informational: its
target owner listener is unauthenticated at the app layer, so plan never
suggests a command for it.

Exit code: 0 only when every enabled tailscale profile got a command and no
profile was refused; otherwise 1.

## Environment

- `KONTROL_INGRESS_PROFILES` — the profile list (JSON array; see
  `.env.example`).
- `KONTROL_TAILSCALE_BIN` — optional override for the tailscale binary
  (default: `tailscale` resolved on PATH).
