# Scheduled-job correctness audit handoff

Branch: `audit-k02-k04`
Starting HEAD: `29cebb0479bf87d60bfbac2416d2ec7bf228816c`

## Scope

This work implements the attached Kontrol scheduled-job correctness audit. Existing dirty adapter, bounded-publication, scheduler, and UI-lifecycle work was preserved and included. The live Kontrol database was backed up and migrated through the normal immutable-release deployment path. No push was performed.

## Implemented

- Added forward migrations v89 and v90. V89 repairs the historical `mission_contracts.outcome_evidence` and `review_routes.warning_acknowledged_at` drift. V90 stores per-dispatch failure class, reason, probe result, and retry eligibility.
- Added a Drizzle-to-SQLite table/column schema contract after migration and to readiness. It reports the expected schema version, missing tables/columns, and deployed build identity; migration fixtures cover v88 repair, data preservation, idempotence, and fail-closed drift.
- Kept ordinary scheduled execution receipts readable if mission-ledger receipt construction fails. Receipts expose explicit verification/evidence limitations and bounded dispatch-attempt and worker-failure evidence.
- Added durable cancellation request, prior-state, timing, and last-confirmed-remote-state fields to scheduled result receipts.
- Persisted sanitized, byte-bounded worker failure evidence on terminal lifecycle events and retrieve it by exact job, attempt, and ACP run identity.
- Fixed scheduler diagnostics to read `event_log.payload`; made phase failures durable and restart-visible; isolated recoverable lifecycle projection failures from unrelated due dispatch; bounded wakeups and retry deadlines.
- Added exact execution-mode preflight for registered agents, signed grant policy, sandbox and executable readiness, input contract, and accepted network policy.
- Added constrained scheduled verification profiles including `python3 -m pytest` and `cargo test`. Report-only work without a submission explicitly reports verification as unavailable/not performed.
- Updated CRUSH to use a fixed positional instruction while keeping task content on stdin. The adapter integration fixture now checks empty-task rejection, large multiline task delivery without truncation, task secrecy in argv/logs, captured completion output, and unchanged confinement.
- Updated the Hermes native runner for the refactored upstream public ACP v1 SDK and retained the detached-child, signed-grant, and durable-receipt boundaries.
- Projected the Hermes ACP SDK package into its read-only Bubblewrap runtime, with explicit verification-toolchain allowlisting and fail-closed health/preflight reporting. Optional Hermes config and auth are copied from a filtered private profile into per-run scratch; the host `.hermes` directory is never mounted.
- Changed Hermes Python resolution to prefer the upstream isolated `venv/bin/python` over its unrelated `.venv` Miniconda interpreter. The adapter health check now reports the public ACP contract and confirms the approved executable and package toolchain are available.
- Kept adapter event delivery failures diagnosable with HTTP status and machine error code only; no event payload is logged.
- Corrected the synthetic scheduler lifecycle fixture to advertise the exact mode and correlated receipt, carry a terminal event through two server restarts, and retrieve the result plus work-session snapshot through a fresh MCP transport. It remains separate from real bundled-adapter and real-model qualification.
- Fixed a live result-retrieval contract mismatch: scheduled receipts can persist `no_output` and `unavailable` finalization states, so the MCP output schema now accepts those alongside `pending` and `completed`. Added a result test that validates each successful receipt against the declared MCP output schema.
- Added backward-compatible recovery of sanitized stderr from legacy terminal events when structured failure evidence is absent. Recovery requires exact job, dispatch attempt, and ACP run identity; empty later events do not mask an earlier matching diagnostic.

## Verification

Passed:

- `npm run typecheck`
- `npm run test:adapters` with host permission after sandbox loopback/namespace restrictions blocked the first run
- `node --import tsx scripts/scheduled-readonly-adapters-e2e.mjs` (CRUSH and Hermes confined adapter fixtures)
- `node --import tsx scripts/scheduled-job-unattended-e2e.mjs` (scheduled dispatch, terminal report persistence, restart recovery, and fresh-MCP snapshot)
- `npm run test:schedule-result` validates every report-finalization variant and every successful result receipt against its output schema; `npx tsx src/scheduling/scheduled-job-dispatch.test.ts` covers receipt projections and exact mode preflight
- Candidate migration against a disposable clone of the production v88 backup: schema advanced to v90, 16 mission rows preserved, repair columns present, original database untouched
- CRUSH and Hermes read-only adapter integration, including the large multiline stdin case
- scheduled result, scheduled dispatch, scheduled-job runtime/restart, verification profile, and migration tests
- CLI test in isolation and every remaining unit-test command in the declared `test:unit` sequence
- `git diff --check`
- `node scripts/hermes-execution-mode.test.mjs` and `node --check scripts/acp-hermes-native-adapter.mjs`
- Final immutable candidate build and isolated boot/MCP probe; normal `./restart-kontrol.sh` prepare/activate deployment; `start-all.sh` MCP App, CRUSH, Hermes, configured-agent, tunnel, and readiness checks
- Live `GET /core-readyz` and Hermes adapter `GET /health`: ready, reconciled, not degraded, signed-grant confinement available, and Hermes toolchain available

The aggregate `npm run test:unit` invocation was interrupted while its serial CLI subprocess test was taking several minutes. The CLI test then passed separately, and all subsequent tests in that script passed in sequence. The earlier portion of the aggregate run passed through OAuth.

The installed CRUSH CLI help confirms that `crush run` accepts a positional prompt and piped stdin. Adapter tests validate the complete task-to-child-to-result path with a controlled CLI fixture. The upstream refactored Hermes checkout's `hermes-acp --check` passes with an isolated temporary `HOME` and `HERMES_HOME`; it warns that source-update completion is still running and uses previous dependencies. No provider inference was part of this check. The host `.hermes` directory was inspected for the synthetic marker from the isolated run; no matching log entry was found.

## Deployed release and live qualification

The normal deployment controller backed up the live database at `/home/bamn/.local/share/kontrol/deployment-databases/audit-20261020-pre-candidate/kontrol.sqlite.pre-activation-v90.bak`, then applied migrations v89/v90. Schema validation passed and all 16 mission rows were preserved. No manual SQLite edits were made.

The active immutable artifact is `/home/bamn/devspace/releases/f2e0261f11ff9fbf` (content identity `a0e6e3b9da0dcea7`, source commit `e703732f5427912718aa73199d9820567fee709b`), generation `gen-1792535957-895714`. The current runtime uses the `tmux-stack` launcher. `systemctl --user status kontrol-core.service` reports that the unit is not installed, so this qualifies the transactional checkout/tmux deployment path, not the Linux systemd production lifecycle. The local ignored `.env` allowlists the upstream Hermes Python/toolchain paths and points to the private filtered profile at `/home/bamn/.local/share/kontrol/hermes-readonly-profile`; no credentials or `.env` contents were committed. Production read-only network policy remains disabled.

The original live Athena job is now retrievable through a fresh MCP call after the receipt-schema repair. Its receipt reports `status=failed`, `executionStatus=failed`, `workerCompleted=false`, `reportAvailability=no_output`, and `reportFinalizationStatus=no_output`. Exact-run legacy event recovery exposes the CRUSH stderr `No prompt provided.` with exit code 1. This is a CRUSH prompt-delivery failure before provider inference; it is not a provider rejection. The earlier MCP error was a separate Kontrol output-schema rejection because `no_output` was not an allowed enum value. The receipt remains readable now, but it contains no generated report.

One authorized real, synthetic Hermes read-only scheduled inference attempt was also made with an isolated temporary server, scratch workspace containing only a marker, and a filtered Nous profile. Hermes accepted the adapter dispatch (`transport_status=accepted`) and the job was still `running` at the last status read; no terminal receipt, provider response, or report was retrieved before the 240-second harness deadline. The harness then stopped its isolated processes and removed its temporary database and workspace. **No provider rejection was captured; that inference attempt remains inconclusive, and no retry was made.** No repository source contents were sent to the model.

The remaining convergence gaps are Linux systemd service qualification, a completed real-agent run with a generated report, live provider-rejection/pending/cancellation/interrupted-dispatch/unavailable-sandbox receipts (the available fixtures and tests do not replace these live cases), and independent verification against an actual submitted snapshot. The original live CRUSH failure is confirmed and its receipt survives result retrieval, while the real Hermes inference and generated-result path remain unqualified. No push was performed.
