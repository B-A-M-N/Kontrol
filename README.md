<p align="center">
  <picture>
    <img src="https://raw.githubusercontent.com/B-A-M-N/Kontrol/main/docs/assets/kontrol-logo-light.png" alt="Kontrol logo" width="140">
  </picture>
</p>

<h1 align="center">Kontrol</h1>

<p align="center">A local control plane for WebUI and CLI coding agents: MCP workspace access, ACP worker dispatch, human review gates, and policy authority.</p>

[![Kontrol control plane overview](https://raw.githubusercontent.com/B-A-M-N/Kontrol/main/docs/assets/kontrol-control-plane.png)](https://raw.githubusercontent.com/B-A-M-N/Kontrol/main/docs/assets/kontrol-control-plane.png)

**Your machine. Your agents. Your approval gate.**

Kontrol is a self-hosted control plane for extending WebUI and CLI coding agents in a specific, review-gated way. It exposes your local project files over MCP, dispatches bounded work to registered ACP agents, routes results back through human review, and enforces policy around the tools and paths agents can touch.

You run it on your machine, expose it through a tunnel you control, and decide which agents get to operate, what they can do, and when their work is allowed to land.

## What Makes It Different

Most MCP file-server bridges stop at "read/write/edit." Kontrol adds three layers on top:

**Ralphie Muntz Loop** — Agents submit work for human review. The review surface (WebUI or any MCP client) shows the diff. Human approves, requests changes, or rejects. The agent continues from durable feedback state — even if the agent process died and restarted.

**Continuation Outbox** — Every review decision generates a structured continuation packet with verdict, required actions, and resumption instructions. The packet crosses from the review surface to the next agent turn, so work continues without losing context.

**Policy Mode** — Per-tool and per-path approval rules. A dangerous command can require a one-time approval, or you can approve it for an entire workspace session. Read-only inspection stays fast; destructive ops pause for human judgment.

Underneath it all is **transactional workflow state with an append-only event log**: submissions, feedback, approvals, continuations, runs, and policy decisions are persisted in SQLite, and the event stream wakes WebUI watchers and blocked agents.

## Installation

Kontrol requires Node `>=22.19 <27`.

The npm package name is reserved for `@b-a-m-n/kontrol`, but the public package is not published yet. Install from GitHub for now:

```bash
npm install -g git+ssh://git@github.com/B-A-M-N/Kontrol.git
kontrol init
kontrol serve
```

If you do not use SSH keys with GitHub, use the HTTPS URL:

```bash
npm install -g git+https://github.com/B-A-M-N/Kontrol.git
```

For source development, clone the repo and link the CLI locally:

```bash
git clone git@github.com:B-A-M-N/Kontrol.git
cd Kontrol
npm install --include=dev
npm run build
npm link
kontrol init
kontrol serve
```

During setup, Kontrol asks for:

- the local project folders agents are allowed to open
- the local port, usually `7676`
- your public HTTPS base URL from Cloudflare Tunnel, ngrok, Pinggy, Tailscale Funnel, or another reverse proxy

Use the public origin without `/mcp`:

```text
https://your-tunnel-host.example.com
```

When the client connects, Kontrol opens an Owner password approval page. Enter the password printed by `kontrol init`. It's also stored in:

```text
~/.kontrol/auth.json
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

Kontrol speaks standard MCP over Streamable HTTP. Any compatible client works: ChatGPT, Claude, Codex, Cursor, Windsurf, custom tooling.

## OpenAI Secure MCP Tunnel

To connect Kontrol to ChatGPT without exposing an inbound port, run it locally and
route ChatGPT through an [OpenAI Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels). In that setup use `KONTROL_AUTH_MODE=tunnel`: Kontrol binds a loopback address and **disables its own auth gate** on `/mcp`, so ChatGPT connects with **No Authentication**. Access control is delegated to the tunnel and to the OpenAI workspace that owns it. OAuth (the default for public deployments) is intentionally off here, because its authorization server is not reachable through the tunnel.

```bash
KONTROL_AUTH_MODE=tunnel
HOST=127.0.0.1
PORT=7676
kontrol serve
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
Agent submits work → Kontrol captures diff, emits ReviewRequested
     ↓
Human reviews diff in WebUI / any MCP client
     ↓
Human approves, requests changes, or rejects
     ↓
Kontrol persists feedback event + generates continuation packet
     ↓
If agent is live: it unblocks and continues
If agent stopped: it reads feedback when it resumes
```

This loop lives in Kontrol's event log, not in any specific host. You can review submissions from the same interface you use to chat, from a terminal, or from a future tool.

## Skill Names

![Kontrol Ralphie and Nelson skill loop](https://raw.githubusercontent.com/B-A-M-N/Kontrol/main/docs/assets/kontrol-skill-loop.png)

The project ships a few deliberately memorable Agent Skills. The names are not the product surface; they are protocol handles for the loop:

- `ralphie-muntz-loop` is the worker-side contract. The CLI agent does bounded work, submits a diff, waits for feedback, and resumes only from durable review state.
- `nelson-wiggum-loop` is the reviewer-side contract. The WebUI or MCP reviewer starts work, inspects the submission, and is the only side allowed to say the work is done.
- `kontrol-supervised-mission` is the mission-control contract. It adds objective, criteria, findings, evidence, work orders, and approval blockers on top of the transport loop.

The joke names make the rendezvous easy to remember. The authority model is serious: workers do not approve themselves, review is bound to the exact submission and workspace snapshot, and completion is gated by the reviewer or mission predicate.

## Policy Mode

Control which operations require human approval:

```bash
# Require approval for bash, allow file edits freely
KONTROL_POLICY_TOOL_BASH=ask KONTROL_POLICY_TOOL_WRITE=allow

# Deny access to sensitive paths (structured JSON — the per-rule env format
# `KONTROL_POLICY_PATH_<glob>` is no longer supported; it is not valid
# shell assignment syntax)
KONTROL_POLICY_PATH_RULES='[{"pattern":"/etc/ssh/**","mode":"deny"}]'

# Default: ask for anything not explicitly allowed
KONTROL_POLICY_MODE=ask
```

Modes:

| Mode   | Behavior                                              |
|--------|-------------------------------------------------------|
| allow  | Tool or path is always permitted                      |
| deny   | Tool or path is always blocked                        |
| ask    | Blocks the call until a human approves or denies it   |

When a call requires approval, the agent's tool invocation blocks (long-poll) until a human decides. "Approve for work session" caches the decision for the rest of the work session so repeat operations don't re-prompt; "Approve for workspace" caches until the workspace closes; "Approve once" does not cache.

## Mental Model

Kontrol is a **durable review mailbox and policy authority**, not just a file server.

You decide which roots are allowed. You decide which tools require approval. The agent does its work, submits for review, and continues from structured feedback. Durable workflow state and the append-only event log are the authority every surface reads from: CLI, WebUI, MCP tools, and ACP adapters.

For a normal session:

1. Start your tunnel.
2. Run `kontrol serve`.
3. Connect your MCP agent to the public `/mcp` URL.
4. Approve the connection with the Owner password.
5. Ask the agent to open a project inside one of your allowed roots.
6. Review submissions as they come in.

## Documentation

- [Setup Guide](https://github.com/B-A-M-N/Kontrol/blob/main/docs/setup.md)
- [Coding Workflow](https://github.com/B-A-M-N/Kontrol/blob/main/docs/chatgpt-coding-workflow.md)
- [Configuration Reference](https://github.com/B-A-M-N/Kontrol/blob/main/docs/configuration.md)
- [Security Model](https://github.com/B-A-M-N/Kontrol/blob/main/docs/security.md)
- [Troubleshooting](https://github.com/B-A-M-N/Kontrol/blob/main/docs/gotchas.md)

## Platform Support

| Platform                                          | Status            | Notes                                          |
| ------------------------------------------------- | ----------------- | ---------------------------------------------- |
| Linux                                             | Supported         | Requires Node, npm, Git, and Bash.             |
| macOS                                             | Supported         | Requires Node, npm, Git, and Bash.             |
| Windows with Git Bash, WSL, MSYS2, or Cygwin Bash | Supported         | Git Bash is the simplest native Windows setup. |
| Windows PowerShell or `cmd.exe` only              | Not supported yet | Install Git Bash or use WSL.                   |

```bash
kontrol doctor
```

## Attribution

Kontrol grew out of an idea I had been kicking around for a while, then side-binned because the local MCP/workspace layer was the hard part to get right. When I saw that [Waishnav had built DevSpace](https://github.com/Waishnav/devspace), I used that MCP implementation as the base and extended it in the direction I had been trying to reach.

The original DevSpace project is distributed under the MIT License. Kontrol keeps that attribution while adding ACP worker dispatch, durable review loops, supervised missions, policy approvals, and adapter integrations. I can see how this style of local, review-gated agent control plane might be useful beyond my own setup, so the fork now has its own name and product direction.

## Local Development

```bash
npm install --include=dev
npm run dev
npm run typecheck
npm test
npm run build
npm run start
```
