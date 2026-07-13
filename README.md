<p align="center">
  <picture>
    <img src="https://raw.githubusercontent.com/BAMN/devdesktop/main/docs/assets/devdesktop-logo-light.png" alt="Dev Desktop logo" width="140">
  </picture>
</p>

<h1 align="center">Dev Desktop</h1>

<p align="center">A self-hosted MCP server that lets any AI coding agent read, edit, search, and run code in your local projects — with structured human review loops and policy controls.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@bamn/devdesktop"><img alt="npm" src="https://img.shields.io/npm/v/%40bamn%2Fdevdesktop?style=flat-square" /></a>
  <a href="https://github.com/BAMN/devdesktop/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/BAMN/devdesktop/ci.yml?style=flat-square&branch=main" /></a>
  <a href="https://github.com/BAMN/devdesktop/blob/main/LICENSE"><img alt="License" src="https://img.shields.io/npm/l/%40bamn%2Fdevdesktop?style=flat-square" /></a>
</p>

[![Dev Desktop connected to a coding agent](https://raw.githubusercontent.com/BAMN/devdesktop/main/docs/assets/devdesktop-screenshot.png)](https://raw.githubusercontent.com/BAMN/devdesktop/main/docs/assets/devdesktop-screenshot.png)

**Any MCP-capable agent. Your machine. Your projects. Your rules.**

Dev Desktop is a self-hosted MCP server that exposes your local project files to any AI coding agent — ChatGPT, Claude, Codex, Cursor, or whatever speaks MCP over Streamable HTTP. It adds an event-driven review loop so humans can inspect and approve agent work, and a policy engine so you control which tools and paths require approval.

You run it on your machine, expose it through a tunnel you control, and connect any MCP client.

## What Makes It Different

Most MCP file-server bridges stop at "read/write/edit." Dev Desktop adds three layers on top:

**Ralphie Muntz Loop** — Agents submit work for human review. The review surface (WebUI or any MCP client) shows the diff. Human approves, requests changes, or rejects. The agent continues from durable feedback state — even if the agent process died and restarted.

**Continuation Outbox** — Every review decision generates a structured continuation packet with verdict, required actions, and resumption instructions. The packet crosses from the review surface to the next agent turn, so work continues without losing context.

**Policy Mode** — Per-tool and per-path approval rules. A dangerous command can require a one-time approval, or you can approve it for an entire workspace session. Read-only inspection stays fast; destructive ops pause for human judgment.

Underneath it all is an **event-sourced architecture**: every submission, feedback, approval, and continuation is an immutable event in an SQLite log. State is a projection. Live waiters are just one subscriber.

## Installation

Dev Desktop requires Node `>=22.19 <27`.

```bash
npm install -g @bamn/devdesktop
```

Then initialize and start:

```bash
devdesktop init
devdesktop serve
```

Or without a global install:

```bash
npx @bamn/devdesktop init
npx @bamn/devdesktop serve
```

During setup, Dev Desktop asks for:

- the local project folders agents are allowed to open
- the local port, usually `7676`
- your public HTTPS base URL from Cloudflare Tunnel, ngrok, Pinggy, Tailscale Funnel, or another reverse proxy

Use the public origin without `/mcp`:

```text
https://your-tunnel-host.example.com
```

When the client connects, Dev Desktop opens an Owner password approval page. Enter the password printed by `devdesktop init`. It's also stored in:

```text
~/.devdesktop/auth.json
```

Keep that password private.

## Connect Any MCP Client

The default local endpoint:

```text
http://127.0.0.1:7676/mcp
```

Most users connect through a public HTTPS tunnel:

```text
https://your-tunnel-host.example.com/mcp
```

Dev Desktop speaks standard MCP over Streamable HTTP. Any compatible client works: ChatGPT, Claude, Codex, Cursor, Windsurf, custom tooling.

## OpenAI Secure MCP Tunnel

To connect Dev Desktop to ChatGPT without exposing an inbound port, run it locally and
route ChatGPT through an [OpenAI Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels). In that setup use `DEVDESKTOP_AUTH_MODE=tunnel`: Dev Desktop binds a loopback address and **disables its own auth gate** on `/mcp`, so ChatGPT connects with **No Authentication**. Access control is delegated to the tunnel and to the OpenAI workspace that owns it. OAuth (the default for public deployments) is intentionally off here, because its authorization server is not reachable through the tunnel.

```bash
DEVDESKTOP_AUTH_MODE=tunnel
HOST=127.0.0.1
PORT=7676
npx @bamn/devdesktop serve
```

Register the server in the tunnel client with **No Authentication**, pointing at the loopback origin:

```bash
tunnel-client run \
  --mcp.server-url "http://127.0.0.1:7676/mcp"
```

The review WebUI is served as a self-contained MCP App resource (its CSS and JS are
inlined into a single `workspace-app.html`), so the ChatGPT iframe needs no localhost
fetches. See [Configuration Reference](docs/configuration.md#mcp-authentication-modes)
for the full security rules.

## What Agents Can Do

Once connected, an agent can open an approved project folder as a workspace and:

- read, write, and edit files
- search code and inspect directories
- run shell commands for tests, builds, git, and package scripts
- use isolated Git worktrees for parallel sessions
- follow project instructions from `AGENTS.md` and `CLAUDE.md`
- discover local agent skills from your skill folders
- show tool cards and optional change summaries in ChatGPT Apps-compatible hosts
- submit work for human review and continue from feedback

## Ralphie Muntz Loop

The review loop is event-driven and provider-agnostic:

```
Agent submits work → DevDesktop captures diff, emits ReviewRequested
     ↓
Human reviews diff in WebUI / any MCP client
     ↓
Human approves, requests changes, or rejects
     ↓
DevDesktop persists feedback event + generates continuation packet
     ↓
If agent is live: it unblocks and continues
If agent stopped: it reads feedback when it resumes
```

This loop lives in Dev Desktop's event log, not in any specific host. You can review submissions from the same interface you use to chat, from a terminal, or from a future tool.

## Policy Mode

Control which operations require human approval:

```bash
# Require approval for bash, allow file edits freely
DEVDESKTOP_POLICY_TOOL_BASH=ask DEVDESKTOP_POLICY_TOOL_WRITE=allow

# Deny access to sensitive paths (structured JSON — the per-rule env format
# `DEVDESKTOP_POLICY_PATH_<glob>` is no longer supported; it is not valid
# shell assignment syntax)
DEVDESKTOP_POLICY_PATH_RULES='[{"pattern":"/etc/ssh/**","mode":"deny"}]'

# Default: ask for anything not explicitly allowed
DEVDESKTOP_POLICY_MODE=ask
```

Modes:

| Mode   | Behavior                                              |
|--------|-------------------------------------------------------|
| allow  | Tool or path is always permitted                      |
| deny   | Tool or path is always blocked                        |
| ask    | Blocks the call until a human approves or denies it   |

When a call requires approval, the agent's tool invocation blocks (long-poll) until a human decides. "Approve for work session" caches the decision for the rest of the work session so repeat operations don't re-prompt; "Approve for workspace" caches until the workspace closes; "Approve once" does not cache.

## Mental Model

Dev Desktop is a **durable review mailbox and policy authority**, not just a file server.

You decide which roots are allowed. You decide which tools require approval. The agent does its work, submits for review, and continues from structured feedback. The event log is the source of truth; every surface (CLI, WebUI, MCP tool) reads and writes events.

For a normal session:

1. Start your tunnel.
2. Run `devdesktop serve`.
3. Connect your MCP agent to the public `/mcp` URL.
4. Approve the connection with the Owner password.
5. Ask the agent to open a project inside one of your allowed roots.
6. Review submissions as they come in.

## Documentation

- [Setup Guide](https://github.com/BAMN/devdesktop/blob/main/docs/setup.md)
- [Coding Workflow](https://github.com/BAMN/devdesktop/blob/main/docs/chatgpt-coding-workflow.md)
- [Configuration Reference](https://github.com/BAMN/devdesktop/blob/main/docs/configuration.md)
- [Security Model](https://github.com/BAMN/devdesktop/blob/main/docs/security.md)
- [Troubleshooting](https://github.com/BAMN/devdesktop/blob/main/docs/gotchas.md)

## Platform Support

| Platform                                          | Status            | Notes                                          |
| ------------------------------------------------- | ----------------- | ---------------------------------------------- |
| Linux                                             | Supported         | Requires Node, npm, Git, and Bash.             |
| macOS                                             | Supported         | Requires Node, npm, Git, and Bash.             |
| Windows with Git Bash, WSL, MSYS2, or Cygwin Bash | Supported         | Git Bash is the simplest native Windows setup. |
| Windows PowerShell or `cmd.exe` only              | Not supported yet | Install Git Bash or use WSL.                   |

```bash
devdesktop doctor
```

## Built by B-A-M-N

I'm B-A-M-N. Dev Desktop is an opinionated take on how local coding agents and desktop environments can be extended novelly.

## Local Development

```bash
npm install --include=dev
npm run dev
npm run typecheck
npm test
npm run build
npm run start
```
