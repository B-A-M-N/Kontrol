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

## Implemented in this continuation

- **Canonical evidence tiers** (`src/ingress/evidence-tier.ts`). The five tiers — `unit`, `local_integration`, `real_tailnet`, `public_internet`, `operational` — now have ONE authority, and the tier of an observation is DERIVED from the origin it was collected against instead of being asserted. A loopback run can no longer be recorded as public-internet evidence, and an operational tailnet observation can no longer qualify a public origin. The health store validates tiers through that authority; the management projection derives the qualification scope from the recorded probe origin.
- **The adversarial qualification matrix** (`src/ingress/qualification-matrix.ts`, `scripts/ingress-qualification-matrix.mjs`). All 18 audit rows are a scenario catalog with a required tier/scope, a canonical source-level guard, and one evaluation rule. Each guard runs as an isolated child process; the report is bounded and redacted. A passing source guard is reported as `source_verified` (a regression guard), never as a qualification: only evidence whose derived scope and tier satisfy the requirement marks a scenario `pass`. Exit code 0 = qualified, 1 = a scenario failed, 2 = evidence is still missing. `npm run qualify:ingress`.
- **Operator evidence ingestion.** The harness consumes the durable health store (`--evidence-state-dir`) — the exact artifact the probes write — so an operator never restates a field by hand.
- **Bridge route isolation proven** (`scripts/bridge-route-isolation.mjs`). The audit's P1-01 required testing against a controlled upstream that deliberately responds on forbidden paths. The harness runs the packaged configuration under a real Caddy instance against an upstream that answers 200 on EVERY path, and asserts the bridge still answers forbidden routes with its own 404, that forged authority headers never reach the upstream, that the MCP contract headers survive the edge, and that the upstream sees the pinned Host. Only the site address and upstream target are rewritten; the allowlist, header rules, and handle blocks are the exact bytes under test.
- **Tailnet Serve qualification probe** (`scripts/probe-ingress-serve.mjs`). Reads the OBSERVED route from the real Tailscale status document, compares it with the CONFIGURED tuple through the same exact-tuple classifier the server and CLI use, then exercises an authenticated initialize, tools/list, the SSE heartbeat cadence, and a fresh initialize after the stream ends. It records the build/config identity, profile, listener, observed route, principal class, session identity hash, operation id, observed result, failure class, and time — with no credential material.
- **Owner preference runtime proof** (`scripts/lib/mcp-owner-bridge.integration.test.mjs`). The owner stdio bridge is now exercised end to end against two real HTTPS origins with distinct bearer credentials: the preference change persists atomically (owner-only file), a forced transport loss fails over to the SELECTED route with that origin's own credential, the preference survives a bridge restart, and an ambiguous mutation is reported as uncertain and never replayed.
- **Bridge upstream recovery fix** (`scripts/mcp-stdio-bridge.mjs`). The proof above exposed a real defect: an MCP transport error does not close the client, so the upstream manager never observed `onclose` and the bridge stayed READY against a dead transport. The client now closes itself on a transport error, which is the connection loss the manager already recovers from.
- **Startup validation completeness** (`src/ingress/validate-config.test.ts`). Every invalid matrix combination now fails in `loadConfig()`, not only in the pure validator. The runtime-mode and listener-availability requirements apply to ENABLED profiles, so a disabled standby profile stays possible without the deployment it would eventually need.
- **Observed-failure classification** (`src/ingress/health-store.ts`). An external check that failed is DOWN; only a check that was never performed is UNVERIFIED.
- **Actionable route-command failures** (`src/ingress/controller.ts`, `src/cli.ts`). The Tailscale `serve` command HANGS when the tailnet has Serve disabled, and the controller discarded the command output entirely. Failures are now classified from the command's own output (`command_timed_out`, `serve_not_enabled`, `command_failed`), the reason is kept in the operator message, the class is recorded in the durable receipt, and the CLI prints it.
- **Evidence tier derived in the bridge probe** (`scripts/probe-ingress-bridge.mjs`). The probe no longer hardcodes `public_internet` for every observation.

## Verification performed for the current changes

Passed:

- `npm run typecheck`
- `node scripts/test-manifest.mjs` (192 test files, all reachable from the canonical chain)
- `npm run test:syntax` (including the new bridge isolation, serve probe, and matrix checks)
- `npm run test:integration` — the whole chain, including the two new integration tests
- the remaining `test:unit` chain, run from the catalog-refresh test onward (see the pre-existing failure note below)
- the new ingress source tests: `evidence-tier`, `qualification-matrix`, `validate-config`, `validate`, `profile-status`, `tailscale-status`, `health-store`, `ingress-tools`, `controller`, `bridge-asset`
- `src/ingress/qualification.integration.test.ts` — a bridge upstream failure degrades only the bridge profile; core readiness stays bit-identical and the running generation is not replaced
- `scripts/lib/mcp-owner-bridge.integration.test.mjs` — the owner preference runtime proof
- `scripts/probe-ingress-serve.test.mjs`, `scripts/probe-ingress-bridge.test.mjs`, `scripts/bridge-route-isolation.test.mjs`, `scripts/qualify-caddy-bridge.test.mjs`
- `npm run test:package` (release bundle, publish, and a packed-install of the release artifact)
- `npm run qualify:ingress` — 11 of 18 matrix rows PASS at their required tier; 6 remain `source_verified` (they need real deployment evidence); 0 fail

### Pre-existing failure (not caused by this work)

`src/mcp-tool-catalog-http.test.ts` fails at the "release B sends the supported
tools/list_changed refresh pulse over the existing GET stream" assertion. It
was reproduced against the ORIGINAL branch HEAD (`9818473`) in a separate
worktree, so it is not a regression from this continuation. Because the
canonical `test:unit` chain is sequential, that one failure stops the chain
before the remaining tests; the rest of the chain was therefore run
separately and passed.

The route-isolation harness was also run against the packaged `deploy/bridge/Caddyfile.example` with Caddy v2.10.2: every allowlisted route reached the controlled upstream, every forbidden route returned the bridge's own 404 while the upstream answered 200, and no forged authority header reached the upstream.

## Remaining work before the audit can be called complete

1. **Real deployment evidence:** Run a valid tailnet client against the configured Serve route and an external non-tailnet client against the public bridge/Funnel route. Capture exact build/config hashes, TLS identity, principal, listener, operation/session correlation, protocol result, and failure classification in the bounded health receipts. The tools exist now (`npm run probe:serve`, `scripts/probe-ingress-bridge.mjs`); the missing piece is the deployment.
2. **Effective bridge qualification:** On the deployed bridge, run `caddy adapt` and `caddy validate` against the exact packaged/deployed configuration, then the route-isolation harness against the DEPLOYED file. The local equivalent is proven against the packaged example.
3. **Owner preference runtime proof:** DONE in this continuation (see above).
4. **Adversarial matrix:** The harness is implemented and repeatable. The six deployment-tier rows stay `source_verified` until real tailnet/public evidence exists; a source test can never substitute for it.
5. **Live qualification boundary:** DONE in this continuation — the five tiers are distinct, the tier is derived from the observed origin, and a lower tier can never satisfy a higher claim.
6. **Repository state:** The ingress-audit implementation and the continuation work are committed in coherent slices on `audit-k02-k04`. `.tmp-scratch/` was intentionally excluded and remains untouched. The commits are local only; do not push without separate authorization.

### Environment notes for the next operator

- This tailnet has **Serve disabled**: `tailscale serve --bg --https=8443 …` hangs until it times out and prints `Serve is not enabled on your tailnet`. Enabling it requires a browser visit to the tailnet's serve URL, so the real_tailnet rows cannot be qualified from this host until an operator enables it.
- The `tailscale serve` command does not fail fast in that state. That is why the controller now classifies the failure instead of reporting an opaque exit code.
- A static Caddy binary was downloaded to `/tmp/caddy` for the local route-isolation run. It is not part of the repository; `KONTROL_CADDY_BIN` selects it.

The objective remains active until the code, package/deployment behavior, and required external qualification evidence are all proven against the attachment, requirement by requirement.
