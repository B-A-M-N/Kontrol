# Security Model

Kontrol exposes local coding capabilities over MCP. Treat it as remote access
to your development machine.

The security model is simple:

- you choose a narrow filesystem allowlist
- the MCP endpoint requires OAuth approval with your Owner password
- Host headers are allowlisted from the configured public URL
- every coding action happens through explicit MCP tool calls

## Filesystem Allowlist

Kontrol only opens workspaces under configured roots.

Good examples:

```text
~/work
~/personal/open-source
```

Avoid broad roots:

```text
~
/
C:\
```

The narrower the root, the easier it is to reason about what the MCP client can
reach.

## Owner Password

`kontrol init` generates an Owner password and stores it in:

```text
~/.kontrol/auth.json
```

When an MCP client connects, Kontrol shows an approval page. Enter the Owner
password only when you intentionally want that client to access this server.

For env-driven deployments, set a long random value:

```bash
KONTROL_OAUTH_OWNER_TOKEN="$(openssl rand -base64 32)"
```

## Public URL And Host Allowlist

Kontrol needs `KONTROL_PUBLIC_BASE_URL` so MCP clients can discover OAuth
metadata and connect to the correct resource.

The value should be the origin only:

```text
https://your-tunnel-host.example.com
```

Do not include `/mcp` in `KONTROL_PUBLIC_BASE_URL`.

By default, Kontrol derives allowed Host headers from the local host and public
URL. Use `KONTROL_ALLOWED_HOSTS=*` only for intentional local debugging.

## Tunnels

Kontrol does not manage tunnels. Your tunnel or reverse proxy should point to:

```text
http://127.0.0.1:7676
```

Prefer adding Cloudflare Access, Tailscale identity controls, or equivalent
protection in front of public tunnels. Kontrol OAuth still protects the MCP
endpoint, but the tunnel URL should not be treated as a secret.

## Shell Access

The shell tool is powerful by design. It is meant for tests, builds, git, and
package scripts.

Filesystem path containment and `KONTROL_POLICY_PATH_RULES` apply to Kontrol's
structured file tools (`read`, `write`, `edit`, `grep`, `glob`, `ls`, and
`apply_patch`). They do not inspect arbitrary shell command text or make shell
execution a filesystem sandbox. Shell commands run as local commands and can do
what your user account can do. Gate shell independently with
`KONTROL_POLICY_TOOL_BASH=ask` or `deny`, and use an external OS sandbox when a
shell command must be confined to a directory. `kontrol doctor` warns when path
rules are configured while shell remains allowed.

## Child Processes And Verification

Commands launched through process sessions and mission verification receive an
explicit ordinary-environment allowlist. Kontrol/ACP/OAuth/tunnel/secret,
token, cookie, and credential variables are stripped before a project command
starts; ownership and workspace checks are enforced separately from that
environment boundary.

Mission verification is allowlisted to non-shell executables and rejects shell
metacharacters and path escapes. For unattended verification, set
`KONTROL_VERIFY_SANDBOX=1` on Linux. Kontrol then requires Bubblewrap, disables
network and host namespaces, binds only the workspace, clears the environment,
and applies CPU, address-space, process, file-descriptor, and output limits. If
the sandbox primitive is unavailable, verification fails closed instead of
falling back to unsandboxed execution. Without that setting, verification is a
reviewer-declared trusted command and still runs with the non-secret child
environment allowlist.

ACP workers are bound to their registered opaque agent ID and the durable run
ID; an agent cannot post events, approval decisions, or stdin operations for a
different run. Cancellation first records a durable `cancelling` state and
requests remote stop, then releases the workspace lease only after the worker
has stopped or the remote endpoint is confirmed gone.

## Worktrees

Managed worktrees reduce accidental edits to your active checkout, but they are
not a security boundary. They are a workflow boundary for isolated coding
sessions.

## Logs

By default, Kontrol logs requests and tool calls. Shell command previews are
disabled unless `KONTROL_LOG_SHELL_COMMANDS=1`.

Do not enable shell command logging if commands may contain secrets.

High-volume worker output is buffered and coalesced for transport efficiency.
The synchronous result is an explicit non-durable receipt until the event is
committed. Lifecycle, review, policy, approval, and cancellation events remain
the durable audit record; old output/thought telemetry may be compacted into a
checkpoint after retention.
