# Historical Feature Accounting — Kontrol Reconciliation

Generated 2026-11-06 against reconciliation HEAD `a7dd5f8c` (branch
`integration/reconcile-20261106`), previous qualified baseline
`be6aed73` (`main`). Every entry below was verified against source at
writing time; "Current code location" cites exact paths in HEAD.

## Feature ledger

| Feature | Historical origin | Intended contract | Current code location | Integration path | Behavioral evidence | Disposition | Remaining action |
|---|---|---|---|---|---|---|---|
| Lease-fenced approval | branch pre-slices (missing invariant) | Conflicting/cleanup-pending/peer-job checkout lease blocks approval; reviewed-session `modify` lease allowed; reject/changes ungated | `src/review-workflow.ts` (`approvalLeaseBlock`, in-transaction re-check) | `provideFeedback` → lease view → feedback transaction | `src/review-workflow.lease.test.ts` (5-case matrix) | **Recovered** (`862d0776`) | None |
| Approval-time live coverage | branch pre-slices | Fresh coverage assessment + exact-snapshot check inside the shared workspace-mutation boundary through commit | `src/review-workflow.ts` (`withWorkspaceBoundary`, fresh `checkpointCoverage`); `src/mutation-version.ts` (`workspaceMutationLockKey`); structured tools take the workspace key (`src/mcp/tools/mutation.ts`) | Approve path only; reject/changes bypass | `src/review-workflow.fresh-coverage.test.ts` | **Recovered** (`2c6e3c5f`) | None. Boundary is process-local: safe only while all structured writers serialize through one process (deployment note). |
| Unknown-provenance reassessment | `a5889031`/`0c3ac429`/`32c71468` line (incomplete: ledger-clear laundered unknown→complete) | Unknown rows preserved; audited reviewer reassessment supersedes; replacement approvable only after | `src/review-checkpoints.ts` (`reassessUnknownProvenance`, supersession in `checkpointCoverage`); migration 117 `review_mutation_reassessments`; `src/review-workflow.ts` (`reassessUnknownProvenance`) | Reviewer principal or supervisor runtime only; pending never superseded | `src/review-workflow.reassess.test.ts` (6-case matrix) | **Recovered** (`5a97c786`) | None |
| State adoption + state-directory ownership | `2686c25d` (assurance branches, never merged) | Profile/launcher-bound state dirs; atomic `state-owner.json`; refuse implicit adoption; explicit adoption with backup+ledger+journal | `src/state-directory.ts`, `src/state-adoption.ts`; `src/config.ts` (`stateAccess`); `src/db/client.ts` (claim before writable open); `src/server.ts`; `kontrol service adopt-state` (`src/service.ts`) | Systemd exports `KONTROL_LAUNCHER=systemd` (existing unit env); dev/qual get per-project hashed dirs | `src/state-directory.test.ts`, `src/state-adoption.test.ts` (historical suite, schema 117) | **Recovered** (`dd8d0415`) | Ops: run `adopt-state` once against production before the fence opens the live DB (services currently inactive; deployment is a separate authorization). |
| Build-source gate | `67e73cc0` (assurance branches) | Build refuses mismatched commit / dirty tree under release qualification; source rechecked before publish | `scripts/build-atomic.mjs` (`assertBuildSource`, `KONTROL_EXPECTED_SOURCE_SHA`, `KONTROL_RELEASE_QUALIFICATION`) | Build entrypoint; downstream gate/release-verify still enforce | Gate immutable-candidate-build phase; syntax + gate evidence | **Recovered** (`a47bfce4`) | None |
| Installed-artifact tree-hash verification | `67e73cc0` (`src/release-integrity.mjs`) | Tampered files under intact metadata fail install | `src/release-integrity.ts` (`assertArtifactContent`); wired in `copyRelease` (source, copy, destination) | `src/service.ts` install/upgrade path | `src/release-integrity.test.ts` (tamper + symlink matrix); `src/service.test.ts` fixtures seal real identities | **Recovered** (`a47bfce4`) | None |
| Release-verify content binding | `67e73cc0` | Receipt bound to artifact bytes, not metadata alone | `scripts/lib/release-verify.mjs` (`verifyReleaseArtifact` + receipt content identity) | Publish path (`package-stage --publish`) | Release-retention suite; gate publish coupling | **Recovered** (`a47bfce4`) | None |
| Rollback-window completion | `e70aa942` (`markMigrationRollbackWindowComplete`) | Window closes only after committed deployment + live schema matches candidate; fail-retain otherwise | `src/db/deployment-backup.ts`; called at systemd commit point in `src/service.ts` | Upgrade commit path | `src/db/deployment-backup.test.ts` (window-close regression); `src/service.test.ts` | **Recovered** (`6363c10f`) | None |
| Hermetic runtime-test isolation | `8d836ecb` + hermetic commits (partially propagated) | Tests never read operator `~/.kontrol` config/auth; explicit config dir + auth mode | `scripts/lib/tool-environment.mjs` + `src/process-environment.ts` (spawn harness, already in HEAD); 9 `loadConfig` test sites pinned (`KONTROL_CONFIG_DIR`) | In-process test config resolution (`src/config.ts` fallback chain) | Touched suites pass; `scripts/lib/tool-environment.test.mjs` | **Recovered** (`b35246e1`) | `release-publish.test.mjs` intentionally still reads the operator Git identity: the machine's Git identity guard enforces the canonical identity (`B-A-M-N <benevolentjoker@gmail.com>`) and rejects synthetic fixture identities (verified live). **Rejected** sub-item with evidence. |
| Adapter dispatch-receipt ordering | `e1ec7bb0`, `6b3d7174`, `d674e94b` | One key→one immutable run; ack-gated retention; crash-safe reconcile; spool ordering | `scripts/lib/adapter-dispatch-receipts.mjs`, `scripts/lib/adapter-event-spool.mjs`, `src/bridge/dispatch-service.ts`, `src/acp-gateway.ts`, `src/acp-registry.ts` | ACP dispatch path (3 adapters consume) | `scripts/lib/adapter-dispatch-receipts.test.mjs`, `adapter-event-spool.test.mjs`, `src/dispatch-outbox.test.ts` | **Integrated** | Deferred: thread a stable `dispatchIdempotencyKey` from `dispatch-service` (workSession+feedback epoch) so caller-less calls cannot create duplicate attempts. Current guards (session status + checkout lease) are timing-dependent but no duplicate-run defect is demonstrated. |
| Worker/installation conversation binding | No historical proposal exists (searched all 36 branches). Closest: `c5ddbc25` cross-conversation ownership, `8375d0f3` durable principal, `1536f436` opaque resume | Bind conversations to worker/installation identity beyond owner/profile/thread/epoch | Owner context `src/mcp/owner-context.ts`; route binding `src/review-handoff/route-store.ts`; thread binding `src/review-thread/thread-store.ts`; work-session principal `src/work-sessions/session-store.ts` | MCP transport + route/thread stores | `src/owner-context-isolation.test.ts` (conversations cannot see each other's sessions) | **Deferred** (explicit) | No demonstrated hole: cross-installation confusion requires an attacker holding the principal credential + conversation header, against which a self-asserted installation ID adds nothing. Accept narrow `reviewResumeId`-style opaque reattach handle + audit-only `deploymentId` persistence as the cheap gap; revisit only with a written multi-install threat model. |
| Browser review / handoff / human-visible continuity | Dirty trees `handoff-reconcile-review-loop`, `devspace-review-browser` (uncommitted) | Submission→routing→claim→presentation→ack→feedback→correction→reconnect→terminalization all durable + human-visible | Dirty substance already superseded by HEAD (manual-auth, health, skill provenance, review-browser, reattach — all present); new: browser-turn/supersede events (`src/review-thread/reviewer-job-store.ts`, `src/review-handoff/route-store.ts`, `src/server.ts` wiring) + reducer status map (`src/ui/workspace-event-reducer.ts`, `src/ui/session-view-types.ts`) | Event store → WebUI reducer | `src/review-thread/browser-turn-events.test.ts`; `src/review-thread/review-thread.test.ts`, `review-thread-mcp.test.ts` | **Recovered** (`a7dd5f8c`) for visibility; dirty trees' substance **Superseded** | In-place `maxReviewRounds` propagation from one dirty tree is a **Rejected** design (HEAD supersedes the route generation instead — safer). |
| Qualification tiers | `3ae0b7c1` (diagnostic tiers), `32f7063d` (ingress tiers) | Code vs deployment tiers; candidate identity; dirty rejection; receipt consistency; promotion authority | `scripts/beta-gate.mjs`, `scripts/lib/qualification-evaluator.mjs`, `scripts/beta-gate-final.mjs`, `scripts/lib/release-verify.mjs`, `scripts/build-atomic.mjs`, `src/ingress/evidence-tier.ts` | Gate + publish coupling (`package-stage`, `prepublishOnly`) | Gate receipt (`qualified:true`, 14 phases incl. evidence) | **Integrated** | Diagnostic `qualificationLevels` reporting (explicitly non-gating) **Deferred** as low-value. Unified deployment reconciliation (`2686c25d` `deployment-reconciliation.ts` v2) **Deferred** — HEAD keeps the older `inspectDeploymentReconciliation`, sufficient for current flows. |
| Peer-job durability, approval expiry, terminal fencing, lease recovery, migration authority, checkpoint baseline | Assurance branches (38-commit core) | Peer reservations immutable on terminalization; expired approvals never reusable; crash-fenced sessions; migration authority | Phase-2 recovery slices (`fb9cccea`, `9c8ec212`, `be6aed73`, `3ac5879e`, `c39e95ab`, `7caa25e2`, `a9a220ee`) + this continuation's slices | Review/lease/peer stores | Respective suites (lease, peer, expiry, checkpoint) | **Superseded** (absorbed into HEAD via recovery slices) | None |
| Hermetic fixtures + review durability (release candidate) | `muse/release-candidate` (17) | Hermetic tests; skill budgets; staged recovery; partials; terminal outcomes | Re-based as migrations 114–116 (`record_reviewer_browser_outcome`, `recordPartialObservation` present); hermetic HOME isolation | Migration chain + test harness | `src/review-browser-handoff-integration.test.ts`, contracts tests | **Superseded** (re-based) | None |
| Windows/cross-platform CI stabilization | `codex/p0-recovery-stabilization-2026-10-27` (60) | Windows path canonicalization; peer grant fail-closed | Peer guards in HEAD (`peerWorkspaceDenied` etc.); Linux-only deployment line | Peer workspace guard | `src/peer-mutation.test.ts` | **Superseded / not applicable** (Windows CI only; peer fail-closed present) | None |
| Pre-integration reverts | `codex/restore-main-after-integration-2026-10-26` (3) | Revert wave to pre-integration tree | N/A | N/A | N/A | **Rejected** (not a feature) | None |

## Branch disposition appendix (36 branches, HEAD `a7dd5f8c`)

Contained or patch-equivalent (0 unique ahead): `main`, `integration/phase2-recovery`,
`integration/reconcile-20261106`, `integration/reconcile-20261105`,
`backup/main-before-realign-20261105`, `backup/main-before-ci-sync-2026-10-05`,
`harden/control-plane`, `audit-k02-k04`, `codex/merge-all-branches-2026-10-26`,
`codex/repaired-main-candidate-2026-10-29`, `codex/repair-46e1105-integration`,
`codex/schema111-candidate-2026-10-30`, `codex/reviewer-browser-auth-handoff`,
`codex/review-thread-candidate`, `codex/review-thread-qualification`,
`codex/reviewer-browser-actuator`, `muse/verified-acp-pty-skills`,
`muse/session-01a19b5e-e8f2-7140-8ecd-ce26810e0981`, all `handoff/*` (5).

Unique-ahead (preserve; classified above): p0-recovery-stabilization (60),
assurance-p0-verified (38), env-handoff-stable (29), muse/release-candidate (18),
muse/rc-hermetic-fixtures (18), assurance-p0-followup (11),
assurance-p0-2026-10-29 (10), restore-main-after-integration (3),
qual/quant-reliability-candidate (2, controller-lease temp-dir — already in HEAD
`scripts/beta-gate.mjs`), systemd-env-handoff (1),
recovery-regression-stabilization (1), candidate-terminal-outcome (1).

## Worktree disposition appendix (23 worktrees)

All preserved untouched. Dirty historical worktrees require patch + untracked
whitelist preservation before any future retirement:
`devspace-review-browser` (15), `handoff-reconcile-review-loop` (17),
`p0-recovery-stabilization-2026-10-27` (8), `handoff-browser-restore-cleanup` (3),
`handoff-qualify-browser-feedback` (3), `handoff-migration-test-baseline` (1),
`handoff-package-hermes-dependency` (1), `kontrol-assurance-followup` (1),
`kontrol-f486-probe` (1). Clean: all others, including the active
`/tmp/kontrol-reconcile-20261106`. Detached: `devspace-5f420827`,
`kontrol-f486-probe`.

Preservation set (`/home/bamn/kontrol-preservation-20261106/`, 9 dirty trees):
verified 2026-11-06 — tracked patches cover all modified files; untracked
captures byte-identical (SHA-256 checked, incl. `src/review-browser/` 11 files).
`.tmp-ui/` (in `handoff-qualify-browser-feedback`) contains a single generated
`workspace-app.html` (3.5 MB build artifact) — disposable, correctly excluded
from preservation. `.tmp-*` directories in the main checkout are full
verification/count trees and scratch scripts — disposable, not source.

## Schema 117 rehearsal (disposable copy of production DB)

- Production (read-only): schema 116, `pragma integrity_check` ok,
  329 `review_mutation_provenance` rows (all `unknown`).
- Disposable copy (SQLite backup API, sha256
  `402063d714ae59545450729fc4aa392fd2e2b392cecded4969ff3bf9bd3955e0`):
  candidate `migrateDatabase` 116→117, `review_mutation_reassessments`
  created, counts preserved (submissions 33, feedback 7, provenance 329,
  event_log 11880, leases 3), unknown rows preserved, contract ok
  (53 tables), second run idempotent.
- Candidate artifact `1dd252501f7d3533` boots against the migrated copy:
  `/healthz` ok, `/core-readyz` ready (schema ok). Production was never opened
  writable; services remain inactive.

## Deployment notes

- The approval mutation-serialization boundary is process-local: sufficient
  only while all structured workspace mutations serialize through the same
  process, or other enforcement prevents independent writers.
- Rollback after a 117 migration requires a build whose `maxReadableSchemaVersion`
  ≥ 117; the installed 116 build refuses the migrated DB by design. Downgrade
  path is versioned-backup restore. Retained production release:
  `49c4fcf54e32bb16` (schema 116, `~/.local/share/kontrol/service.json`),
  previous `faa7fa41f8b2d9f3` in `~/.local/share/kontrol/releases/`.
- Production adoption (`service adopt-state`) is an explicit ops step that
  must precede any deployment of this branch.
