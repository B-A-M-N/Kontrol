# Scheduled-job correctness audit handoff

Branch: `audit-k02-k04`
Starting HEAD: `29cebb0479bf87d60bfbac2416d2ec7bf228816c`

## Scope

This work implements the attached Kontrol scheduled-job correctness audit. Existing dirty adapter, bounded-publication, scheduler, and UI-lifecycle work was preserved and included. The live Kontrol database was not edited, and no deployment or push was performed.

## Implemented

- Added forward migrations v89 and v90. V89 repairs the historical `mission_contracts.outcome_evidence` and `review_routes.warning_acknowledged_at` drift. V90 stores per-dispatch failure class, reason, probe result, and retry eligibility.
- Added a Drizzle-to-SQLite table/column schema contract after migration and to readiness. It reports the expected schema version, missing tables/columns, and deployed build identity; migration fixtures cover v88 repair, data preservation, idempotence, and fail-closed drift.
- Kept ordinary scheduled execution receipts readable if mission-ledger receipt construction fails. Receipts expose explicit verification/evidence limitations and bounded dispatch-attempt and worker-failure evidence.
- Persisted sanitized, byte-bounded worker failure evidence on terminal lifecycle events and retrieve it by exact job, attempt, and ACP run identity.
- Fixed scheduler diagnostics to read `event_log.payload`; made phase failures durable and restart-visible; isolated recoverable lifecycle projection failures from unrelated due dispatch; bounded wakeups and retry deadlines.
- Added exact execution-mode preflight for registered agents, signed grant policy, sandbox and executable readiness, input contract, and accepted network policy.
- Added constrained scheduled verification profiles including `python3 -m pytest` and `cargo test`. Report-only work without a submission explicitly reports verification as unavailable/not performed.
- Updated CRUSH to use a fixed positional instruction while keeping task content on stdin. The adapter integration fixture now checks empty-task rejection, large multiline task delivery without truncation, task secrecy in argv/logs, captured completion output, and unchanged confinement.
- Updated the Hermes native runner for the refactored upstream public ACP v1 SDK and retained the detached-child, signed-grant, and durable-receipt boundaries.

## Verification

Passed:

- `npm run typecheck`
- `npm run test:adapters` with host permission after sandbox loopback/namespace restrictions blocked the first run
- CRUSH and Hermes read-only adapter integration, including the large multiline stdin case
- scheduled result, scheduled dispatch, scheduled-job runtime/restart, verification profile, and migration tests
- CLI test in isolation and every remaining unit-test command in the declared `test:unit` sequence
- `git diff --check`

The aggregate `npm run test:unit` invocation was interrupted while its serial CLI subprocess test was taking several minutes. The CLI test then passed separately, and all subsequent tests in that script passed in sequence. The earlier portion of the aggregate run passed through OAuth.

The installed CRUSH CLI help confirms that `crush run` accepts a positional prompt and piped stdin. Adapter tests validate the complete task-to-child-to-result path with a controlled CLI fixture; no real model invocation was made.

## Release qualification still required

The audit's final convergence gate is not complete. In particular:

1. Back up the production database and deploy an immutable release through the normal deployment controller so migrations v89/v90 apply. Do not manually edit the live SQLite file.
2. Run one scheduled read-only audit through a real supported coding agent, then retrieve its result over a fresh MCP connection.
3. Qualify distinct failed execution, rejection, cancellation, interrupted dispatch, and unavailable-sandbox receipts.
4. Run independent verification against the submitted snapshot and prove the source checkout remains unchanged.
5. Restart Kontrol and verify receipts, evidence, dispatch identity, and diagnostics through a fresh transport.

No production database mutation, deployment, external model request, or push was performed.
