# Configuration Reference

Kontrol can be configured through `kontrol init`, persisted config files, or
environment variables.

The default files are:

```text
~/.kontrol/config.json
~/.kontrol/auth.json
```

Use another config directory with:

```bash
KONTROL_CONFIG_DIR=/path/to/config kontrol serve
```

## Commands

```bash
kontrol init
kontrol serve
kontrol doctor
kontrol config get
kontrol config set publicBaseUrl https://kontrol.example.com
```

## Core Environment Variables

| Variable | Purpose |
| --- | --- |
| `HOST` | Local bind host. Defaults to `127.0.0.1`. |
| `PORT` | Local port. Defaults to `7676`. |
| `KONTROL_ALLOWED_ROOTS` | Comma-separated local roots that workspaces may open. |
| `KONTROL_PUBLIC_BASE_URL` | Public origin for the server, without `/mcp`. |
| `KONTROL_ALLOWED_HOSTS` | Optional Host header allowlist override. |
| `KONTROL_OAUTH_OWNER_TOKEN` | Owner password for OAuth approval. Must be at least 16 characters. |
| `KONTROL_AUTH_MODE` | MCP auth mode: `oauth` (default) or `tunnel`. |
| `KONTROL_TUNNEL_TOKEN` | Legacy compatibility variable. Ignored in tunnel mode; do not forward it as an MCP header. Authentication belongs to the Secure MCP Tunnel. |
| `KONTROL_TUNNEL_PROFILE` | tunnel-client profile name used by the managed launcher. Defaults to `sample_mcp_with_dcr`. |
| `KONTROL_TUNNEL_ID` | Optional explicit tunnel registration ID passed to tunnel-client, overriding the profile’s ID. Use this after creating/rebinding a tunnel. |
| `KONTROL_TUNNEL_DOCTOR` | Run `tunnel-client doctor` with the effective runtime profile/ID before launch. Defaults to `true`; it uses an ephemeral health port. |
| `KONTROL_ACP_AGENTS` | Required worker registrations as `name=url,name=url`; the managed launcher derives its adapter URLs for the current generation. |
| `KONTROL_DIAGNOSTICS_SECRET` | Header-only credential for loopback `/diagnostics`; when unset, diagnostics are disabled. |
| `KONTROL_MCP_MAX_INFLIGHT` | Global concurrent MCP request limit. Defaults to `32`. |
| `KONTROL_MCP_MAX_INFLIGHT_PER_SESSION` | Per-session concurrent MCP request limit. Defaults to `8`. |
| `KONTROL_MCP_MAX_QUEUE` | Maximum queued MCP requests waiting for admission. Defaults to `128`. |
| `KONTROL_MCP_REQUEST_DEADLINE_MS` | Maximum time a request waits for admission. Defaults to `120000`. |
| `KONTROL_MCP_UNUSED_SESSION_IDLE_MS` | Idle TTL for initialized sessions with no tool calls. Defaults to `120000`, allowing model-side setup time. |
| `KONTROL_MCP_EPHEMERAL_SESSION_IDLE_MS` | Grace TTL for non-worker sessions with exactly one tool call. Defaults to `300000`; one completed tool call does not mean the model is finished. |
| `KONTROL_MCP_REUSABLE_SESSION_IDLE_MS` | Idle TTL for reusable or multi-tool sessions. Defaults to `900000`. |
| `KONTROL_MCP_SESSION_REAPER_INTERVAL_MS` | Session reaper interval. Defaults to `15000`. |
| `KONTROL_MCP_SESSION_MAX_PER_CLIENT` | Per-logical-client session cap. Defaults to `20`. |
| `KONTROL_MCP_SESSION_SOFT_CAP` | Global session soft cap for LRU pressure cleanup. Defaults to `150`. |
| `KONTROL_MCP_SESSION_HARD_CAP` | Global session admission hard cap. Defaults to `200`. |
| `KONTROL_WORKTREE_ROOT` | Directory for managed Git worktrees. Defaults to `~/.kontrol/worktrees`. |
| `KONTROL_STATE_DIR` | Directory for SQLite state. Defaults to `~/.local/share/kontrol`. |
| `KONTROL_SUPERVISOR_INTERVAL_MS` | Probe interval for the managed component supervisor. Defaults to `5000`. |
| `KONTROL_OPERATIONAL_UAT` | Set `true` to run the disposable real-agent startup UAT. Defaults to `false`. |
| `KONTROL_RELEASE_MODE` | Set `true` to refuse dirty source trees unless `KONTROL_ALLOW_DIRTY_RELEASE=true`. |
| `KONTROL_HARPOON_INCLUDE_LOOPBACK` | Passed to tunnel-client; defaults to `false` so Harpoon does not auto-register KONTROL's local HTTP OAuth metadata URLs. |

MCP transports are isolated by their `mcp-session-id`. The logical client label
(for example `mcp:openai-mcp@1.0.0`) is aggregate telemetry only and is never a
transport-pooling or authorization key. If an upstream explicitly forwards a
conversation identifier, diagnostics label the transport with it and reject a
later explicit mismatch. Durable workspace, review, continuation, and mission
identity comes from their explicit IDs, so separate conversations can use
Kontrol concurrently against the same project without sharing transport
context.

## Liveness And Readiness

`GET /healthz` only proves that KONTROL is serving HTTP and returns the
immutable build identity (`buildId`, commit, dirty state, schema hash, and
build timestamp). During startup, `GET /core-readyz` checks KONTROL's own
database, MCP, workspace, review, ACP, and runtime-build infrastructure before
adapters register. `GET /readyz` is the fail-closed operational check: it also
requires every configured worker agent to be alive at its expected URL and
returns HTTP 503 while any required check is unavailable.

Readiness uses a cheap database probe and a cached integrity result. The full
SQLite `quick_check` runs in background maintenance rather than blocking every
readiness request. The managed checkout launcher starts a persistent supervisor
after readiness; its state is written to
`$KONTROL_STATE_DIR/supervisor-status.json` and includes failure counts,
restart counts, and the last external probe result.

When diagnostics are enabled, access `/diagnostics` from loopback with the
`X-Kontrol-Diagnostics` header. Credentials in query strings are not accepted.

The managed tunnel launcher keeps OAuth protected-resource discovery enabled but
disables Harpoon loopback auto-registration by default. Set
`KONTROL_HARPOON_INCLUDE_LOOPBACK=true` only when a separate Harpoon use case
requires private loopback targets and the corresponding HTTPS configuration is
available.

The checkout launcher calls `scripts/probe-kontrol-readiness.mjs` after the
adapters register. That probe performs a real MCP initialize, discovers the
registered agents, opens the configured workspace, reads `package.json`, and
runs `pwd`; it also verifies that the listening build ID equals the build just
produced.

## OAuth

Kontrol uses a single-user OAuth approval flow.

| Variable | Default |
| --- | --- |
| `KONTROL_OAUTH_ACCESS_TOKEN_TTL_SECONDS` | `3600` |
| `KONTROL_OAUTH_REFRESH_TOKEN_TTL_SECONDS` | `2592000` |
| `KONTROL_OAUTH_SCOPES` | `kontrol` |
| `KONTROL_OAUTH_ALLOWED_REDIRECT_HOSTS` | `chatgpt.com,localhost,127.0.0.1` |

MCP clients discover metadata from:

```text
/.well-known/oauth-protected-resource/mcp
/.well-known/oauth-authorization-server
```

## MCP Authentication Modes

`KONTROL_AUTH_MODE` selects how the `/mcp` endpoint authenticates clients.

| Mode | Behavior |
| --- | --- |
| `oauth` | Default. Standard OAuth 2.1 bearer flow. Required for any public or internet-reachable deployment. The OAuth owner token (`KONTROL_OAUTH_OWNER_TOKEN`) is required. |
| `tunnel` | Local-only. Kontrol binds a loopback address and **disables its own auth gate entirely**; `/mcp` requires no bearer token. Access control is delegated to the OpenAI Secure MCP Tunnel (and to the OpenAI workspace that owns the tunnel). ChatGPT connects with "No Authentication". The OAuth owner token is not required in this mode. |

### `tunnel` mode (OpenAI Secure MCP Tunnel)

Use this when Kontrol is reached only through an OpenAI Secure MCP Tunnel. The
tunnel authenticates `tunnel-client` to OpenAI and proxies ChatGPT's MCP calls
over a workspace-authorized channel, so Kontrol does not need its own
authentication on `/mcp`. OAuth is intentionally not used here because the
authorization server is not reachable through the tunnel, so ChatGPT cannot
complete a browser OAuth flow.

Requirements:

- `HOST` must be a loopback address (`127.0.0.1`, `::1`, or `localhost`). Binding
  to a non-loopback interface is rejected at startup — tunnel mode must only be
  reachable through the tunnel, never directly from the network.
- No per-call credential is required on `/mcp`: the OpenAI tunnel + workspace
  identity is the access boundary. Kontrol deliberately does not forward or
  validate a second `Authorization` header in this mode.

Example:

```bash
KONTROL_AUTH_MODE=tunnel
HOST=127.0.0.1
PORT=7676
kontrol serve
```

In the OpenAI tunnel client, register this server with **No Authentication** and
point it at the loopback origin:

```bash
tunnel-client run \
  --mcp.server-url "http://127.0.0.1:7676/mcp"
```

The review WebUI is served as a self-contained MCP App resource (its CSS and JS
are inlined into a single `workspace-app.html`), so the ChatGPT iframe needs no
localhost fetches.

## Tool Modes

`KONTROL_TOOL_MODE` controls the tool surface.

| Value | Behavior |
| --- | --- |
| `minimal` | Default. Exposes `open_workspace`, `read`, `write`, `edit`, and `bash`. Clients use `bash` with tools such as `rg`, `find`, and `ls` for inspection. |
| `full` | Exposes the minimal tools plus dedicated `grep`, `glob`, and `ls` tools. |
| `codex` | Experimental. Exposes `open_workspace`, `read`, `apply_patch`, `exec_command`, and `write_stdin`. Existing mutation and shell tools are hidden. |

`KONTROL_MINIMAL_TOOLS` remains a backward-compatible alias when
`KONTROL_TOOL_MODE` is unset: `1` selects `minimal` and `0` selects `full`.
The `codex` mode must be selected through `KONTROL_TOOL_MODE` and always uses
its fixed short tool names regardless of `KONTROL_TOOL_NAMING`.

Codex-mode commands run without a PTY by default. Set `tty: true` on
`exec_command` for interactive terminal programs. PTY support uses the optional
`node-pty` dependency; `write_stdin` can send input, poll output, and resize PTY
sessions.

## Widgets

`KONTROL_WIDGETS` controls ChatGPT Apps iframe usage.

| Value | Behavior |
| --- | --- |
| `full` | Default. Widget UI is attached to exposed workspace, file, edit, and shell tools. |
| `changes` | Enables the aggregate `show_changes` tool and attaches widget UI to `open_workspace` and `show_changes`. |
| `off` | Disables widget UI. |

## Skills

| Variable | Purpose |
| --- | --- |
| `KONTROL_SKILLS` | Set to `0` to hide skills. Enabled by default. |
| `KONTROL_AGENT_DIR` | Defaults to `~/.codex`; its `skills` child is loaded for compatibility. |
| `KONTROL_SKILL_PATHS` | Optional comma-separated additional skill directories. |

Kontrol discovers standard Agent Skills from:

- `~/.agents/skills`
- project `.agents/skills`

It also keeps compatibility with:

- `KONTROL_AGENT_DIR/skills`, defaulting to `~/.codex/skills`
- additional paths from `KONTROL_SKILL_PATHS`

Legacy project paths such as `.pi/skills` can be added through `KONTROL_SKILL_PATHS` when needed.

Example:

```bash
KONTROL_SKILL_PATHS="$HOME/.claude/skills,$HOME/company/skills" \
kontrol serve
```

Kontrol's bundled skills use memorable names for the two halves of the review
rendezvous:

- `ralphie-muntz-loop`: worker-side submit, wait, resume.
- `nelson-wiggum-loop`: reviewer-side start, inspect, approve or redirect.
- `kontrol-supervised-mission`: objective, acceptance criteria, evidence,
  findings, work orders, and mission approval blockers.

Those names are local Agent Skill identifiers. The enforced authority boundary
is role based: workers can submit and continue work, reviewers can approve, and
mission approval is checked against durable evidence and the current snapshot.

## ACP Stdio Duplex Adapter

Kontrol includes a generic stdio JSON-RPC ACP adapter for agents that speak the
duplex Agent Client Protocol directly over stdin/stdout:

```bash
ACP_STDIO_AGENT_NAME=my-agent \
ACP_STDIO_COMMAND=/path/to/agent \
ACP_STDIO_ARGS_JSON='["acp"]' \
ACP_STDIO_DISPATCH_METHOD=session/prompt \
ACP_STDIO_ADAPTER_PORT=9921 \
node scripts/acp-stdio-duplex-adapter.mjs
```

The adapter registers as a normal Kontrol ACP peer and uses the reusable
`createAcpDuplex` transport. Agent-initiated `session/request_permission` calls
are converted into Kontrol approval requests and parked until the reviewer
decides. Hermes currently uses `scripts/acp-hermes-native-adapter.mjs`, which
bridges Hermes's Python ACP client into the same Kontrol approval/event system.

## Logging

| Variable | Default |
| --- | --- |
| `KONTROL_LOG_LEVEL` | `info` |
| `KONTROL_LOG_FORMAT` | `json` |
| `KONTROL_LOG_REQUESTS` | `1` |
| `KONTROL_LOG_ASSETS` | `0` |
| `KONTROL_LOG_TOOL_CALLS` | `1` |
| `KONTROL_LOG_SHELL_COMMANDS` | `0` |
| `KONTROL_TRUST_PROXY` | `0` |

Set `KONTROL_LOG_FORMAT=pretty` for local debugging.

Set `KONTROL_LOG_SHELL_COMMANDS=1` only when you intentionally want command
previews in logs.

## Env-Only Example

```bash
KONTROL_OAUTH_OWNER_TOKEN="$(openssl rand -base64 32)" \
KONTROL_ALLOWED_ROOTS="$HOME/personal,$HOME/work" \
KONTROL_PUBLIC_BASE_URL="https://kontrol.example.com" \
KONTROL_WORKTREE_ROOT="$HOME/.kontrol/worktrees" \
KONTROL_TOOL_MODE="minimal" \
KONTROL_WIDGETS="full" \
kontrol serve
```

The environment assignments must be part of the same command invocation, or
exported first.
