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

## Verification

Passed:

- `npm run typecheck`
- `npm run test:adapters` with host permission after sandbox loopback/namespace restrictions blocked the first run
- `node --import tsx scripts/scheduled-readonly-adapters-e2e.mjs` (CRUSH and Hermes confined adapter fixtures)
- `node --import tsx scripts/scheduled-job-unattended-e2e.mjs` (scheduled dispatch, terminal report persistence, restart recovery, and fresh-MCP snapshot)
- `npm run test:schedule-result` and `npx tsx src/scheduling/scheduled-job-dispatch.test.ts` (receipt projections and exact mode preflight)
- Candidate migration against a disposable clone of the production v88 backup: schema advanced to v90, 16 mission rows preserved, repair columns present, original database untouched
- CRUSH and Hermes read-only adapter integration, including the large multiline stdin case
- scheduled result, scheduled dispatch, scheduled-job runtime/restart, verification profile, and migration tests
- CLI test in isolation and every remaining unit-test command in the declared `test:unit` sequence
- `git diff --check`
- `node scripts/hermes-execution-mode.test.mjs` and `node --check scripts/acp-hermes-native-adapter.mjs`
- Final immutable candidate build and isolated boot/MCP probe; normal `./restart-kontrol.sh` prepare/activate deployment; `start-all.sh` MCP App, CRUSH, Hermes, configured-agent, tunnel, and readiness checks
- Live `GET /core-readyz` and Hermes adapter `GET /health`: ready, reconciled, not degraded, signed-grant confinement available, and Hermes toolchain available

The aggregate `npm run test:unit` invocation was interrupted while its serial CLI subprocess test was taking several minutes. The CLI test then passed separately, and all subsequent tests in that script passed in sequence. The earlier portion of the aggregate run passed through OAuth.

The installed CRUSH CLI help confirms that `crush run` accepts a positional prompt and piped stdin. Adapter tests validate the complete task-to-child-to-result path with a controlled CLI fixture. `hermes acp --check` passes against the refactored upstream checkout.

## Deployed release and live qualification

The normal deployment controller backed up the live database at `/home/bamn/.local/share/kontrol/deployment-databases/audit-20261020-pre-candidate/kontrol.sqlite.pre-activation-v90.bak`, then applied migrations v89/v90. Schema validation passed and all 16 mission rows were preserved. No manual SQLite edits were made.

The active immutable artifact is `/home/bamn/devspace/releases/e6656319c8f13b31` (build `e6656319c8f13b31`, content identity `d415b450620d8075`, source commit `c584ae32164667bfa931807588e411c126430d9b`), generation `gen-1792534407-686915`. The current runtime uses the `tmux-stack` launcher. The local ignored `.env` allowlists the upstream Hermes Python/toolchain paths and points to the private filtered profile at `/home/bamn/.local/share/kontrol/hermes-readonly-profile`; no credentials or `.env` contents were committed. Production read-only network policy remains disabled.

One authorized real, synthetic Hermes read-only scheduled run was attempted against the final release, using an isolated temporary server, scratch workspace containing only a marker, and a filtered Nous profile. Hermes accepted the adapter dispatch (`transport_status=accepted`) and the job was still `running` at the last status read; no terminal receipt or report was retrieved before the 240-second harness deadline. The harness then stopped its isolated processes and removed its temporary database and workspace. **No provider rejection was captured, and provider completion is inconclusive. This was not a confirmed provider rejection, and no inference retry was made.** No repository source contents were sent to the model.

The remaining convergence gaps are live-receipt retrieval for a completed real-agent run, live qualification of failure/rejection/pending and confirmed cancellation/interrupted-dispatch/unavailable-sandbox projections (currently covered by tests and fixtures), and independent verification against an actual submitted snapshot. The active release and adapter health checks pass; the real model-backed scheduled result remains unqualified. No push was performed.
