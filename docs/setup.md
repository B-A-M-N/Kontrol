# Setup Guide

This guide is for users who want ChatGPT or another MCP host to work in local
projects through Kontrol.

## Requirements

- Node 22.19+, 24.x, or 26.x
- npm
- Git
- Bash, including Git Bash or WSL on Windows
- a public HTTPS URL that forwards to the local Kontrol server

Kontrol does not create the public tunnel for you. Use Cloudflare Tunnel,
ngrok, Pinggy, Tailscale Funnel, or your own HTTPS reverse proxy.

## Install And Configure

Install the CLI package, then run setup:

```bash
npm install -g @b-a-m-n/kontrol@1.0.4
kontrol init
```

The setup flow asks one question at a time.

### Connection Mode

The first setup question is how MCP clients will reach this server:

- **Public URL (OAuth)** — the default. Kontrol is reachable over the internet
  through a reverse proxy or public tunnel, and clients authenticate with the
  OAuth Owner password. Setup asks for the public base URL.
- **OpenAI Secure MCP Tunnel** — loopback-only. Kontrol binds `127.0.0.1` (or
  another loopback address) with no local bearer gate; the OpenAI tunnel owns
  access control, and ChatGPT connects with "No Authentication". Setup asks
  for a reviewer assertion secret (32+ characters, `openssl rand -base64 32`)
  stored in `auth.json`; the managed tunnel forwards it as
  `X-Kontrol-Tunnel-Reviewer` so review/approval tools have reviewer
  authority. Start the tunnel with `scripts/kontrol-tunnel.sh run` — see
  [Configuration](configuration.md#tunnel-mode-openai-secure-mcp-tunnel).

The chosen mode is written to `config.json` as `authMode`; the environment
variable `KONTROL_AUTH_MODE` overrides it per-invocation. Setup validates the
complete generated configuration before finishing and rolls the files back if
validation fails.

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
npm run soak:beta -- --hours 12 --url "$KONTROL_PUBLIC_BASE_URL" --workspace-path "$PWD" --build-id CANDIDATE_BUILD_ID --diagnostics-secret "$KONTROL_DIAGNOSTICS_SECRET" --tunnel-url http://127.0.0.1:8080
npm run probe:tunnel -- --url "$KONTROL_PUBLIC_BASE_URL" --workspace "$PWD" --dual --cycles 1 \
  --watcher-timeout-ms 18000 --heartbeat-count 2 --minimum-drain-events 2 \
  --resource-load-reads 2 --diagnostics-secret "$KONTROL_DIAGNOSTICS_SECRET" \
  --host-catalog-file external-tools-list.json \
  --expected-mcp-version VERSION_PLUS_CONTENT_SHA \
  --expected-build-id CANDIDATE_BUILD_ID \
  --result-file beta-external-catalog.json
npm run gate:beta:final
```

Capture `external-tools-list.json` from the connected MCP host after the
candidate deployment. It must be one envelope containing `capturedAt`, a
`captureId`, the fresh `initialize` response, and the matching authoritative
`tools/list` response. The host capture is operator-supplied evidence; the
receipt labels it as such and does not claim Kontrol machine-verified the host
exchange. The probe independently opens a fresh server transport, records its
server version and catalog as machine-verified evidence, exercises two live
SSE heartbeat cycles under concurrent Workspace App resource reads, and
requires two observed drain recoveries. A localhost or idle-proxy run cannot
write a qualification receipt. Capture the host snapshot during the candidate
soak and run the probe after the soak ends.

For a reported ChatGPT stream interruption, preserve the browser HAR, the
authenticated diagnostics snapshot, Kontrol JSON logs, and any intermediary
delivery logs. Compare them with:

    node scripts/analyze-mcp-stream-failure.mjs --har chatgpt.har --kontrol-log kontrol.jsonl --diagnostics diagnostics.json --tunnel-log tunnel.jsonl --output stream-correlation.json

The report separates exact external-ID matches from timestamp proximity. HAR
cannot expose all ChatGPT server-side tool dispatch, and a Kontrol response
finishing proves only local response-stream completion.

Inspect `beta-code-qualification.json`, `beta-soak.json`,
`beta-external-catalog.json`, `beta-qualification.json`, and
`beta-fault-matrix.json` before deployment.
The final gate requires clean end-state evidence, matching candidate/source
identity, a passing soak, and a fresh external host catalog receipt for that
same deployment. Local accelerated checks do not substitute for the
multi-hour real-stack soak required for a persistent installation.

For the required real wall-clock soak, choose the duration explicitly (12
hours is the minimum enforced by the canonical stable-beta gate) and inspect
its metrics report when it finishes:

```bash
npm run soak:beta -- --hours 12 --url "$KONTROL_PUBLIC_BASE_URL" --workspace-path "$PWD" --build-id CANDIDATE_BUILD_ID --diagnostics-secret "$KONTROL_DIAGNOSTICS_SECRET" --tunnel-url http://127.0.0.1:8080
```

Use `--workspace-path` (and `--read-path` when the workspace lacks
`AGENTS.md`) for an allowed read on every fresh MCP transport. Stop the runner
only when the intended soak window is complete; an interrupted run is recorded
as non-passing.

For the post-incident multi-day qualification, keep the exact deployed
`buildId` fixed and repeat the same command with separate reports for at least
26 hours (preferably 48 hours), followed by a 72-hour stability run before
claiming multi-day reliability:

```bash
npm run soak:beta -- --hours 26 --url "$KONTROL_PUBLIC_BASE_URL" --workspace-path "$PWD" --report beta-soak-26h.json --build-id CANDIDATE_BUILD_ID \
  --diagnostics-secret "$KONTROL_DIAGNOSTICS_SECRET" --tunnel-url "$KONTROL_BETA_TUNNEL_URL"
npm run soak:beta -- --hours 72 --url "$KONTROL_PUBLIC_BASE_URL" --workspace-path "$PWD" --report beta-soak-72h.json --build-id CANDIDATE_BUILD_ID \
  --diagnostics-secret "$KONTROL_DIAGNOSTICS_SECRET" --tunnel-url "$KONTROL_BETA_TUNNEL_URL"
```

During that qualification, place the dual-session probe behind the real
intermediary and run at least an hour of 18-second watcher heartbeats. Supply
the fresh external host `tools/list` snapshot so catalog drift fails closed:

```bash
# Terminal A: local reproduction of a 25-second idle-response intermediary.
npm run probe:idle-proxy -- --target http://127.0.0.1:7676 \
  --port 8787 --idle-timeout-ms 25000

# Terminal B: use the proxy URL for the bounded one-hour dual-watcher run.
npm run probe:tunnel -- --url "$KONTROL_PUBLIC_BASE_URL" --workspace "$PWD" \
  --dual --cycles 120 --watcher-timeout-ms 18000 \
  --host-catalog-file external-tools-list.json \
  --expected-mcp-version VERSION_PLUS_CONTENT_SHA
```

For the local harness, replace `KONTROL_PUBLIC_BASE_URL` with
`http://127.0.0.1:8787`. The real-tunnel run remains necessary because the
harness verifies intermediary idle handling, not tunnel or host behavior.

The 12-hour stable-beta receipt remains the publication gate. These longer
runs are additional operational evidence for the reported multi-day failure;
they do not turn an interrupted or locally simulated run into qualification.

The local liveness endpoint is `GET /healthz`; startup infrastructure
readiness is `GET /core-readyz`; strict operational readiness is `GET /readyz`.
A successful checkout startup also runs
`scripts/probe-kontrol-readiness.mjs`, exercising initialize, agent discovery,
workspace opening, and file reading. It exercises bash execution as well when
the operator explicitly allows bash (`KONTROL_POLICY_MODE=allow` or
`KONTROL_POLICY_TOOL_BASH=allow`); the secure default requires interactive
approval and is therefore not suitable for a boot-time probe.

The same setup rules apply.
