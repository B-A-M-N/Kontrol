## Remediation status update — October 11, 2026

### Source-level remediations (implemented and committed)

| Finding | Status | Commit | Evidence |
| --- | --- | --- | --- |
| F01 — Earlier pass can override later failure | Fixed | 1d3a23f | `mission-ledger.test.ts` F01 falsification: pass→fail blocks, fail→pass restores. Durable `attempt` ordering added in schema v64. |
| F02 — Resolved findings stay resolved on new submission | Fixed | 1d3a23f + 31b6e5e | `mission-ledger.test.ts` F02 falsification: stale resolution blocks submission B approval. `mission-verifier.test.ts` proves stale findings rerun through verifier. |
| F03 — Manual verification bypasses sandbox | Fixed | 1d3a23f | `run_mission_verification` passes `serverConfig` verification settings; both paths consume `createVerificationExecutionContext`. |
| F04 — Manual correction declares premature convergence | Fixed | 1d3a23f | `correction-policy.ts` distinguishes convergence (missionApproved) from unresolved requirements (escalation). |
| F05 — Focused verification excludes dependencies | Fixed | 1d3a23f | `scopeAllows` uses `selectedWithDependencies`; transitive deps included. |
| F06 — Fingerprint omits criterion IDs | Fixed | 1d3a23f | IDs included in canonical fingerprint; changing ID produces explicit conflict. |
| F08 — No outcome evidence strength | Fixed | 3d3b4f7 | `outcomeEvidence` contract field with four levels; ≥integration_verified requires passing final report. |
| F11 — `..` prefix path false rejection | Fixed | 1d3a23f | `roots.ts` rejects exact `..` components only; `..cache` allowed. Tests added. |

### Operational items still open

- **F07** — Live candidate verification completed on October 11, 2026: isolated candidate `c97f59b097f8821a` started on loopback 7699 in tunnel auth mode. The `scripts/probe-mcp-tunnel.mjs` dual-cycle probe passed 5 cycles (37 correlated responses), and an explicit git-tools probe invoked `git_status`, `git_log`, `git_diff`, and `git_show` successfully (4/4). Together with the probe's concurrent `read`, `grep`, `glob`, and `ls` inspections, all eight required inspection tools plus `poll_process` are callable against the current candidate. A real fresh ChatGPT host connection remains the final external-parity check for full release qualification. A probe bug that misparsed single-chunk SSE JSON-RPC responses was also fixed in commit `f19abcf`.
- **F09/F10** — Operational soak, external catalog qualification, and real-host outcome efficacy require a running deployment and 12-hour wall-clock soak. The exact-candidate soak is the required next operational step after deploying the current build.

### Verification run (all green)

- `npm run test:unit` — 42 suites, zero assertion errors
- `npm run test:integration` — 15 suites including lifecycle soak, all passed
- `npx tsc --noEmit` — clean
- `npm run build` — immutable candidate `53fd2d5aa891fce1` built from clean `db430e8` (gitDirty: 0), schema v64
- `node src/beta-gate-final.test.mjs` — candidate, soak, and fresh external catalog qualification passed
- Independent falsification matrix now covers: evidence ordering (pass→fail, fail→pass), stale finding renewal (submission A→B), sandbox parity wiring, correction escalation vs convergence, dependency expansion (`["base","dependent"]`), criterion-id fingerprint conflict, path containment (`..cache` allowed, `..` rejected), and outcome-evidence strength gate

### Deployment status (October 11, 2026)

Candidate `7e00b709a84108c7` (clean source `1b6fe9f`, schema v64) passed preflight, build validation, and isolated boot smoke via `restart-kontrol.sh --prepare-only`. Activation could not complete because the host root filesystem remounted read-only (ext4 `errors=remount-ro`), making `/home/bamn/.local/share/kontrol` unwritable. The safe operator action is an offline `fsck` at reboot; the two-phase restart can then be rerun and the prepared candidate activated. All source-level remediation work remains committed and the checkout is clean.

### Re-review remediation (October 11, 2026, commit cec77fb)

Independent re-review findings addressed:
- **P0 finding resolution**: effective resolution now follows the latest qualifying attempt per required command. Pass→fail blocks, pass→inconclusive blocks, fail→pass restores.
- **P0 outcome evidence**: `outcome_verified`/`operationally_stable` are refused at creation until oracle support exists; empty passing reports cannot certify integration.
- **P1 fingerprint**: `outcomeEvidence` participates in the payload and stored reconstruction carries criterion IDs.
- **P2 evidence eligibility**: source filtering happens before newest-attempt selection; agent claims cannot displace verifier results.
- **P2 correction policy**: demonstrated progress earns bounded continuation; stagnation escalates.
- **P1 deployment**: `--activate-artifact` resumes a prepared candidate without re-preparing; all start-all behavior tests pass.

Clean candidate `0c9c6b34b4c1ccbe` (source `cec77fb`, schema v64, gitDirty 0). Operational soak/external-host qualification still pending filesystem recovery.

### Composition-boundary test closure (commit cdaf4ab, candidate cf37f9560fbe7be8)

- F03 fail-closed: a configured sandbox path that does not exist refuses execution; both entry paths consume the same execution context.
- F05 composition: failing dependency blocks the dependent; a final-only prerequisite excluded from the progressive phase makes the dependent inconclusive (not a scheduling error); unrelated criteria remain excluded from focused selection.
- F11 boundary: path-valued flag arguments and Windows separator traversal rejected; benign adjacent-dot names preserved.
- Full unit suite (42) green; clean candidate `cf37f9560fbe7be8` built from `cdaf4ab`.
- Filesystem blocker persists (root read-only); activation/soak pending recovery.

### Authoritative missionApproved (commit f7b67ba, candidate 0c4b1df96c2d0d82)

evaluateLoopExtension now derives missionApproved from the ledger's own
canApprove() result, not from caller input. A falsification test proves a
caller asserting approval cannot converge a denied mission. Full unit suite
(42) green; clean candidate built from f7b67ba. Root filesystem remains
read-only; activation and soak still pending recovery.

### Verification parity mapper (commit e194683, candidate c55d8746bbdbe61c)

missionVerificationOptionsFromConfig is the single mapping from parsed
server config to mission verification options; both the manual reviewer
path and supervised ACP runtime consume it, with a parity test asserting
identical sandbox, environment, toolchain, executable, and inflight
settings from the same configuration. Full unit suite (42) green; clean
candidate built from e194683. Root filesystem remains read-only; activation
and soak still pending recovery.

### Versioned fingerprint definition (commit 3680697, candidate 012f023b6409ed8a)

MISSION_CONTRACT_FINGERPRINT_VERSION participates in the canonical payload;
all fingerprints carry their definition version, and stored records keep
their historical identity until an explicit migration. Full unit suite (42)
green; clean candidate built from 3680697. Root filesystem remains
read-only; activation and soak still pending host recovery.

### Durable scheduling / messaging / review-loop remediation (October 11, 2026)

Implements the consolidated remediation plan's P0/P1 areas on top of the prior
`d93d76e` feature commit. All gates green: typecheck, unit, security,
integration, syntax, UI (Chromium), cold-start, scheduled-job E2E, build.

Source-level fixes (with falsification tests):

| Finding | Fix | Commit |
| --- | --- | --- |
| F01 outbox cross-consumer + unfenced completion | `claimNext` mints a claim token; `markCompleted`/`release`/`markFailed` CAS on (id, claimed, owner, token, unexpired lease). Event-type ownership test proves no foreign consumption. Stale/forged/wrong-owner transitions rejected. Schema v70. | `56766fe`, `2b9b858` |
| F02 unbound worker message authority | `requireWorkerDeliveryBinding` fails closed for post/list/await/ack; unbound or cross-session workers cannot touch messages. Bridge-flow scenario asserts no persistence. | `56766fe` |
| F03 duplicate resolution events | `resolve()` reports the open→resolved transition; repeat requests emit no event and return "already resolved". | `56766fe` |
| S02/S03 scheduler never dispatched | Scheduler runtime triggers the canonical ACP dispatch path; dispatch outcome (work-session id + real reason) persists on the job; single-flight drain; startup reconciliation re-arms lost triggers under the idempotent logical key. | `4bd90c7`, `1d3bcd0` |
| S04 idempotency + missing tools | `schedule_job` passes clientMutationId through; `list_scheduled_jobs`/`cancel_scheduled_job` registered. | `56766fe` |
| R06 review-workflow bypass | Route enforcement moved into `provideFeedback` (single chokepoint for MCP, ACP HTTP, mission tools): governed sessions require a CLAIMED handoff for the exact submission; a superseded routeEpoch is rejected; supervisor-runtime actions remain exempt under mission/autonomy policy. Owner-context normalization unified so claims satisfy gates. | `a091e3a`, `bf240f3` |
| L02/L03 round ceiling vs progress policy | Round maximum enforced at submission (createHandoff refuses a new round) AND at correction dispatch (onCorrect refuses when paused/exhausted), so progress-based convergence can never exceed the user limit. | `363a02c` |
| L04 lifecycle controls | `pause/resume/get_review_loop_status` tools + `kontrol review-loop` CLI; CAS-guarded status changes that never alter mode or budget. | `363a02c`, `7f4260a` |
| C04 oscillation | Unresolved-fingerprint recurrence (A→B→A) escalates to `awaiting_human` with `stallReason: oscillating_verification`; the consecutive counter alone masked it. Schema v71. | `61f636b` |
| C05 drift warning | `configure_review_loop` warns once when enabling a multi-round pinned review. | `e769d9a` |
| U01 lifecycle header | Workspace App renders routing mode, round/max, and handoff status; attachment vs decision are distinct; exhausted budget warns. | `3a618f6` |
| U02 no unsolicited host messages | Verified: no `sendMessage`/`updateModelContext` call sites exist. | audit |
| Generic ACP registration | `kontrol agent add|list|remove` persists any loopback HTTP ACP peer into durable config (the stdio duplex adapter supplies its HTTP URL), removing per-agent hand-editing. Loopback-only; `--require-healthy` fails closed. | `c8e1a55` |

End-to-end experiments (real processes, real hosts where applicable):

- Experiment A (`scripts/scheduled-job-e2e.mjs`): registers a loopback agent via
  the production `/acp/agents/register` route, drives a due job through the
  scheduler, asserts exactly one agent run with work-session correlation, and
  proves restart survival with no duplicate dispatch. Wired into `test:cold-start`.
- Experiment B (`scripts/cold-start-messaging-e2e.mjs`): real-process
  clarification→reply→acknowledge across a full core restart. Schema assertion
  advanced to v71.
- Experiments C/D/E (`bridge-flow.test.ts`): pinned 3-round ceiling with a
  blocked 4th automatic round; loop-OFF fresh isolated handoffs preserving the
  original work session; mid-flight route change superseding a stale claim.

Still operational (unchanged): 12-hour soak, external ChatGPT host catalog
qualification, and real-host delivery evidence require a running deployment and
are gated by `gate:beta`/`gate:beta:final`, not by this source work.
