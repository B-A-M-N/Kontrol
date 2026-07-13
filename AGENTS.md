# Dev Desktop

This project exposes local development workspaces over MCP so ChatGPT, Claude,
or another MCP-capable host can operate on this machine's approved development
directories. It supports two complementary workflows:

- Direct MCP workspace operations, where the host calls tools that read files,
  edit files, search code, and run shell commands against an opened workspace.
- Delegated ACP worker runs, where DevSpace dispatches a bounded task to a
  registered local coding agent and routes completion through a human-reviewed
  Ralph/Nelson loop.

Pi's SDK is currently used as the backend adapter for mature local coding
primitives such as read, edit, write, grep, find, ls, and bash. Dev Desktop wraps
those primitives behind a remote Streamable HTTP MCP interface, suitable for use
through a Cloudflare Tunnel.

The model-facing workflow is workspace based. MCP clients should call
`open_workspace` once per local project directory or worktree, then reuse the
returned `workspaceId` for subsequent tool calls in that same folder. Do not
call `open_workspace` again for the same folder unless the `workspaceId` is
rejected as unknown, the client switches folders/worktrees or checkout/worktree
mode, or the user explicitly asks to reopen. `AGENTS.md` files are returned
automatically by `open_workspace` and by later tool calls when the requested path
enters a directory with instructions that have not been loaded for that
workspace.

ACP review workflow:

- Reviewer tools and worker tools are separate. Workers must never approve their
  own work or operate on a work session they are not bound to.
- `submit_to_coding_agent` and supervised mission tools create durable work
  sessions. A worker submits changes with `submit_for_review`, then blocks on
  `await_review_feedback`.
- A reviewer provides approval, rejection, or structured change requests through
  the WebUI/MCP tools. Change requests create durable continuations; approval is
  bound to the exact submission hash, review epoch, and workspace snapshot.
- `begin_supervised_work`, `inspect_supervised_work`,
  `continue_supervised_work`, and `approve_supervised_work` are the mission
  control plane for acceptance-criterion-driven work.
- Cancellation is terminal. It must stop the logical work session, supersede
  pending continuations, and request cancellation from the remote worker.

Worktree and concurrency guidance:

- A single checkout can run one modifying supervised work session at a time
  unless the user explicitly accepts shared-working-tree risk.
- Prefer managed Git worktrees for parallel delegated work or long-running
  supervised missions.
- Do not let one session's review checkpoint, continuation, or cancellation
  mutate another session's state.

Core constraints:

- Treat this as remote access to the local machine; security is part of the
  core design, not a later add-on.
- Start with a narrow filesystem allowlist.
- Prefer explicit, inspectable tool calls and durable review barriers over
  open-ended autonomous loops.
- Keep delegated work bounded by mission criteria, review checkpoints,
  continuation records, and human approval.
