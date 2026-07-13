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
KONTROL_CONFIG_DIR=/path/to/config npx @b-a-m-n/kontrol serve
```

## Commands

```bash
npx @b-a-m-n/kontrol init
npx @b-a-m-n/kontrol serve
npx @b-a-m-n/kontrol doctor
npx @b-a-m-n/kontrol config get
npx @b-a-m-n/kontrol config set publicBaseUrl https://kontrol.example.com
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
| `KONTROL_TUNNEL_TOKEN` | Optional bearer token for `tunnel` mode. When set, the OpenAI tunnel hop must present `Authorization: Bearer <token>` on every `/mcp` call. Set via `--mcp.extra-headers` on the tunnel-client. Leave unset for no-token tunnel mode. |
| `KONTROL_WORKTREE_ROOT` | Directory for managed Git worktrees. Defaults to `~/.kontrol/worktrees`. |
| `KONTROL_STATE_DIR` | Directory for SQLite state. Defaults to `~/.local/share/kontrol`. |

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
- By default no per-call credential is required on `/mcp` (the OpenAI tunnel +
  workspace identity is the access boundary). For defense-in-depth, set
  `KONTROL_TUNNEL_TOKEN` (≥16 chars) and inject it from tunnel-client with:
  `--mcp.extra-headers "Authorization: Bearer $KONTROL_TUNNEL_TOKEN"`. The token
  is compared with a constant-time check and is never logged.

Example:

```bash
KONTROL_AUTH_MODE=tunnel
HOST=127.0.0.1
PORT=7676
npx @b-a-m-n/kontrol serve
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
npx @b-a-m-n/kontrol serve
```

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
npx @b-a-m-n/kontrol serve
```

The environment assignments must be part of the same command invocation, or
exported first.
