# Security policy

Kontrol exposes local development workspaces and process execution over MCP.
Treat deployments as remote access to the host and report suspected security
issues privately to the project maintainers rather than publishing exploit
details first.

Include the affected version or commit, deployment mode, reproduction steps,
and any logs that do not contain credentials. Never include owner tokens,
OAuth tokens, tunnel credentials, adapter secrets, or private project data.

See [the security model](docs/security.md) for filesystem, authentication,
process, tunnel, and review-boundary guidance.
