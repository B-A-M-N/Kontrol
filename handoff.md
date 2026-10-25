# Kontrol Multipath Ingress — Continuation Handoff

Updated: 2026-10-25

## Goal

Implement the requirements in `/home/bamn/.codex/attachments/458e9b15-a1ec-4247-aa20-19ec878f9be9/pasted-text-1.txt` for the Kontrol multipath ingress audit. Keep the full scope: security/correctness, lifecycle control, durable evidence, independent endpoint recovery, operator UI, and adversarial end-to-end qualification. Source tests alone do not qualify live routes.

Repository: `/home/bamn/devspace`
Branch: `audit-k02-k04`
Starting HEAD observed this turn: `5e19e7d30ed467f954f2bfe5086dd1b85f568187`
The branch was 64 commits ahead and 0 behind `origin/audit-k02-k04`. No history rewrite or push is intended. Preserve untracked `.tmp-scratch/`.

## Implemented in source

The current task changes include:

- Exact Tailscale Serve/Funnel route identities and classification, stricter profile/audience/listener validation, strict host policy, and distinct mapping versus application qualification.
- Peer credential reload/auth/session authorization fencing and fail-closed peer job/worktree recovery changes.
- Receipt-backed profile-specific Tailscale apply/disable/reconcile, bounded redacted ingress health observations, bridge qualification probes, owner and worker endpoint bridge separation, endpoint qualification/circuit failover, WireGuard/Tailscale Caddy templates, and packaged bridge asset hashes.
- An authenticated `ingress_management` MCP tool and Workspace App panel showing configured profile, listener, local observation, mapping, external TLS/auth checks, health evidence tier, operation, and recent failures. Its controls require user confirmation; route actions also require server confirmation. `/diagnostics` includes the same projection as `kontrol ingress doctor`.
- The owner-public stdio bridge now persists a complete endpoint preference ordering in an owner-only atomic file (`~/.kontrol/bridge-endpoint-preferences.json`, overridable with `KONTROL_BRIDGE_PREFERENCE_FILE`). The Workspace App exposes this control only when the app is connected through the owner bridge and `ingress_management` is allowed by the endpoint profile. Preference changes affect subsequent connection attempts and do not migrate a live MCP transport. Worker bridges cannot change the preference.
- `handoff.md` is this continuation record; uppercase `HANDOFF.md` is a separate file and was left unchanged.

## Verification performed for the current changes

Passed:

- `npm run typecheck`
- `npm run test:ui` including the ingress panel DOM case, Workspace App bundle/contract checks, and Chromium assertions
- `npm run test:syntax` after an unchanged host-permission retry; sandbox initially denied its loopback probe with `EPERM`
- `npm run test:package` including packed-install validation
- `node scripts/lib/mcp-endpoint-selector.test.mjs`
- `node --import tsx src/ingress/ingress-tools.test.ts`
- `node --import tsx src/ui/ingress-management.dom.test.ts`
- `node --check scripts/mcp-stdio-bridge.mjs`
- `node --check scripts/lib/mcp-endpoint-selector.mjs`
- `git diff --check`

UI and syntax tests required host permission because the sandbox blocked local IPC or loopback binds. The authorized retries passed. These checks validate source and packaged artifacts, not a deployed endpoint.

## Remaining work before the audit can be called complete

1. **Real deployment evidence:** Run a valid tailnet client against the configured Serve route and an external non-tailnet client against the public bridge/Funnel route. Capture exact build/config hashes, TLS identity, principal, listener, operation/session correlation, protocol result, and failure classification in the bounded health receipts.
2. **Effective bridge qualification:** On the deployed bridge, run `caddy adapt` and `caddy validate` against the exact packaged/deployed configuration. Test forbidden paths with a controlled upstream that returns success on every path; test forwarded and `X-Kontrol-*` header stripping, bounded connections/headers, direct-listener denial, authenticated SSE heartbeats over time, long POST, and fresh initialize after connection loss. No Caddy binary or external bridge was available in the local checks.
3. **Owner preference runtime proof:** Exercise the owner stdio bridge end to end with two separately authorized OAuth resources. Change the preferred endpoint in the Workspace App, restart the bridge to prove persistence, force a transport loss, and verify the next qualified transport uses the selected route and correct origin-specific credential. Confirm ambiguous mutations are not replayed. The selector/store and panel controls have unit/DOM coverage; this deployment chain has not yet been exercised.
4. **Adversarial matrix:** Run the attachment's full matrix, especially wrong Serve host/port/path/exposure, stopped Tailscale, rejected Funnel-to-peer topology, mid-SSE path loss, peer credential revocation on an existing session, wrong OAuth resource, upstream bridge outage without core restart, corrupt peer-job state, concurrent route switching, multi-listener restart recovery, and 45-second POST idle-timeout cases.
5. **Live qualification boundary:** Keep `unit`, `local_integration`, `real_tailnet`, `public_internet`, and `operational` evidence tiers distinct. A lower tier cannot qualify a higher one; no source test or template hash substitutes for external evidence.
6. **Repository state:** The ingress-audit implementation and this lowercase handoff file are committed together at the current branch HEAD. `.tmp-scratch/` was intentionally excluded and remains untouched. The commit is local only; do not push without separate authorization.

The objective remains active until the code, package/deployment behavior, and required external qualification evidence are all proven against the attachment, requirement by requirement.
