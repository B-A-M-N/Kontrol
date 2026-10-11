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
- `npm run build` — immutable candidate `c97f59b097f8821a` built, schema v64
- `node src/beta-gate-final.test.mjs` — candidate, soak, and fresh external catalog qualification passed
