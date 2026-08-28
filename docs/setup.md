# Setup Guide

This guide is for users who want ChatGPT or another MCP host to work in local
projects through Kontrol.

## Requirements

- Node `>=22.19 <27`
- npm
- Git
- Bash, including Git Bash or WSL on Windows
- a public HTTPS URL that forwards to the local Kontrol server

Kontrol does not create the public tunnel for you. Use Cloudflare Tunnel,
ngrok, Pinggy, Tailscale Funnel, or your own HTTPS reverse proxy.

## Install And Configure

Install the CLI from GitHub, then run setup:

```bash
npm install -g git+ssh://git@github.com/B-A-M-N/Kontrol.git
kontrol init
```

Without GitHub SSH keys:

```bash
npm install -g git+https://github.com/B-A-M-N/Kontrol.git
kontrol init
```

The setup flow asks one question at a time.

### Project Roots

Choose the folders ChatGPT is allowed to open through Kontrol. Keep this
narrow.

Examples:

```text
~/personal,~/work
```

```text
/Users/alice/dev,/Users/alice/work
```

```text
C:\Users\alice\dev,C:\Users\alice\work
```

### Local Port

The default is `7676`.

The local MCP URL is:

```text
http://127.0.0.1:7676/mcp
```

### Public Base URL

Start your tunnel or reverse proxy before entering this value. Point the tunnel
at:

```text
http://127.0.0.1:7676
```

Enter the public origin without `/mcp`:

```text
https://your-tunnel-host.example.com
```

Configure the MCP client with the full MCP endpoint:

```text
https://your-tunnel-host.example.com/mcp
```

## Start The Server

Run:

```bash
kontrol serve
```

If your tunnel URL changes for one run, override it without rewriting config:

```bash
KONTROL_PUBLIC_BASE_URL="https://new-tunnel.example.com" kontrol serve
```

For a stable public URL, persist it:

```bash
kontrol config set publicBaseUrl https://kontrol.example.com
kontrol serve
```

## Approve The Client

When ChatGPT, Claude, or another MCP client connects, Kontrol shows an Owner
password approval page. Enter the Owner password printed during setup.

The default config files are:

```text
~/.kontrol/config.json
~/.kontrol/auth.json
```

Keep `auth.json` private.

## Check Your Setup

Run:

```bash
kontrol doctor
```

The doctor command reports the resolved config, Node version, Node ABI, platform,
Git, Bash, public URL, allowed hosts, and SQLite native dependency status.

## Running From A Local Checkout

If you are running from a local checkout instead of a global GitHub install:

```bash
npm install --include=dev
npm run build
npm link
kontrol up
```

`kontrol up` starts the full local development stack from the checkout. It uses
the checkout's `.env`, so configure that file before launching. Use
`kontrol serve` when only the MCP server is needed.

For a restart from a checkout, use `./restart-kontrol.sh`. It prepares and
validates an immutable candidate while the current generation remains serving,
then performs a readiness-gated handoff. Failed activation stops only
Kontrol-owned sessions started by that invocation and restores the previous
immutable release when one is available. Once ready, a persistent supervisor
continues probing KONTROL, adapters, and the tunnel and applies thresholded
component recovery.

Before a stable-beta deployment, run the canonical release gate from a clean
checkout:

```bash
npm run gate:beta:code
```

Then run the real soak against the exact candidate build reported by
`beta-code-qualification.json`, followed by the final evidence join:

```bash
npm run soak:beta -- --hours 12 --build-id CANDIDATE_BUILD_ID --diagnostics-secret "$KONTROL_DIAGNOSTICS_SECRET" --tunnel-url http://127.0.0.1:8080
npm run gate:beta:final
```

Inspect `beta-code-qualification.json`, `beta-soak.json`,
`beta-qualification.json`, and `beta-fault-matrix.json` before deployment.
The final gate requires clean end-state evidence, matching candidate/source
identity, and a passing soak; local accelerated checks do not substitute for
the multi-hour real-stack soak required for a persistent installation.

For the required real wall-clock soak, choose the duration explicitly (12
hours is the minimum enforced by the canonical stable-beta gate) and inspect
its metrics report when it finishes:

```bash
npm run soak:beta -- --hours 12 --url http://127.0.0.1:7676 --build-id CANDIDATE_BUILD_ID --diagnostics-secret "$KONTROL_DIAGNOSTICS_SECRET" --tunnel-url http://127.0.0.1:8080
```

Use `--workspace-path` (and `--read-path` when the workspace lacks
`AGENTS.md`) for an allowed read on every fresh MCP transport. Stop the runner
only when the intended soak window is complete; an interrupted run is recorded
as non-passing.

The local liveness endpoint is `GET /healthz`; startup infrastructure
readiness is `GET /core-readyz`; strict operational readiness is `GET /readyz`.
A successful checkout startup also runs
`scripts/probe-kontrol-readiness.mjs`, exercising initialize, agent discovery,
workspace opening, and file reading. It exercises bash execution as well when
the operator explicitly allows bash (`KONTROL_POLICY_MODE=allow` or
`KONTROL_POLICY_TOOL_BASH=allow`); the secure default requires interactive
approval and is therefore not suitable for a boot-time probe.

The same setup rules apply.
