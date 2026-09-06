# Security policy

Kontrol exposes local development workspaces and process execution over MCP.
Treat deployments as remote access to the host and report suspected security
issues privately through the channel below rather than publishing exploit
details first.

## Reporting a vulnerability

**Preferred: GitHub Private Vulnerability Reporting.** Open the repository
(<https://github.com/B-A-M-N/Kontrol>), go to **Security → Report a
vulnerability**, and file a private report. This reaches the maintainers
directly, keeps the thread private, and lets us coordinate disclosure and
credit with you.

If Private Vulnerability Reporting is unavailable for your account, open a
GitHub issue titled only `security: request private contact` — without any
technical detail — and the maintainers will follow up to arrange a private
channel.

Please do **not** open a public issue, discussion, or pull request with
exploit details.

## What to include

- The affected version **or** commit SHA, and how you run Kontrol (npm
  package, source checkout, start-all.sh, systemd service).
- Deployment mode: `oauth` or `tunnel`; local-only or externally reachable.
- Reproduction steps — a minimal proof of concept is enough; you do not need
  a weaponized exploit.
- Impact assessment: what an attacker could reach (filesystem, processes,
  credentials, other sessions).
- Any logs that do not contain credentials.

**Never include** owner tokens, OAuth tokens, tunnel credentials, adapter
secrets, reviewer secrets, or private project data.

## Supported versions

Only the latest published release receives security fixes. Check
<https://www.npmjs.com/package/@b-a-m-n/kontrol> for the current version and
upgrade before reporting; the maintainers will confirm whether an issue
affects it. The pre-release source tree on `main` is in scope for reports,
but behavior there may change without notice.

## Response targets

- Acknowledgement: within 7 days.
- Triage decision and severity: within 14 days.
- Fix or mitigation timeline: shared with you once triaged; critical issues
  are prioritized for an immediate release.

## Security model

See [the security model](docs/security.md) for filesystem, authentication,
process, tunnel, and review-boundary guidance.
