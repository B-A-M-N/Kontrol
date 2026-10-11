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
