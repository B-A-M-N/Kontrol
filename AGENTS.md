# Kontrol

This project exposes local development workspaces over MCP so ChatGPT, Claude,
or another MCP-capable host can operate on this machine's approved development
directories. It supports two complementary workflows:

- Direct MCP workspace operations, where the host calls tools that read files,
  edit files, search code, and run shell commands against an opened workspace.
- Delegated ACP worker runs, where Kontrol dispatches a bounded task to a
  registered local coding agent and routes completion through a human-reviewed
  Ralph/Nelson loop.

Pi's SDK is currently used as the backend adapter for mature local coding
primitives such as read, edit, write, grep, find, ls, and bash. Kontrol wraps
those primitives behind a remote Streamable HTTP MCP interface, suitable for use
through a Cloudflare Tunnel.

Workspace records identify the shared project/root and checkpoint state;
conversation-sensitive instruction discovery, skill activation, active
work-session attribution, and UI selection belong to the owning MCP session
context. A shared workspace ID must not cross that boundary.

The model-facing workflow is workspace based. MCP clients should call
`open_workspace` once per local project directory or worktree, then reuse the
returned `workspaceId` for subsequent tool calls in that same folder. Do not
call `open_workspace` again for the same folder unless the `workspaceId` is
rejected as unknown, the client switches folders/worktrees or checkout/worktree
mode, or the user explicitly asks to reopen. `AGENTS.md` files are returned
automatically by `open_workspace` and by later tool calls when the requested path
enters a directory with instructions that have not been loaded for that
workspace.

ACP review workflow:

- Reviewer tools and worker tools are separate. Workers must never approve their
  own work or operate on a work session they are not bound to.
- Reviewer and delegation routing: the active WebUI model is the primary
  reviewer, orchestrator, and inspector. Review, audit, diagnosis, architecture,
  and code-edit work starts directly in the opened workspace. ACP workers are
  optional bounded assistance only; call `discover_agents` before delegation,
  dispatch only a currently dispatchable healthy `role: agent` peer, and when
  optional assistance is unavailable return to direct workspace work without
  trying an alternate ACP path. When the caller platform is identifiable,
  prefer its healthy registered native harness (for example ChatGPT/OpenAI to
  Codex); otherwise use any healthy registered ACP peer. `agentName` is an
  explicit override. The platform hint affects routing only, never authority.
  A normal review must not enter supervised work.
  Ordinary non-Git directories are valid checkout workspaces; Git is required
  only for managed worktrees.
- Review checkpoints are backend-neutral: Git workspaces use immutable Git
  snapshots, while ordinary directories use content-addressed filesystem
  snapshots without initializing or mutating Git. Submissions, approval, and
  verification bind to `snapshotKind` plus `snapshotRef`; any patch is only a
  bounded presentation of that exact snapshot. Structured read-only `read`,
  `grep`, `glob`, and `ls` remain public even in codex tool mode.
- `submit_to_coding_agent` and supervised mission tools create durable work
  sessions. A worker submits changes with `submit_for_review`, then blocks on
  `await_review_feedback`.
- A reviewer provides approval, rejection, or structured change requests through
  the WebUI/MCP tools. Change requests create durable continuations; approval is
  bound to the exact submission hash, review epoch, and workspace snapshot.
- `begin_supervised_work`, `inspect_supervised_work`,
  `continue_supervised_work`, and `approve_supervised_work` are the mission
  control plane for acceptance-criterion-driven work.
- Cancellation is durable and must stop the logical work session, supersede
  pending continuations, and request cancellation from the remote worker. The
  record remains in `cancelling` until worker shutdown or a confirmed missing
  remote run, then becomes terminal; workspace leases stay fenced meanwhile.

Worktree and concurrency guidance:

- A single checkout can run one modifying supervised work session at a time
  unless the user explicitly accepts shared-working-tree risk.
- Prefer managed Git worktrees for parallel delegated work or long-running
  supervised missions.
- Do not let one session's review checkpoint, continuation, or cancellation
  mutate another session's state.

Core constraints:

- Treat this as remote access to the local machine; security is part of the
  core design, not a later add-on.
- Start with a narrow filesystem allowlist.
- Prefer explicit, inspectable tool calls and durable review barriers over
  open-ended autonomous loops.
- Keep delegated work bounded by mission criteria, review checkpoints,
  continuation records, and human approval.

Project scope boundary:

- FI-flow and its model/router integrations are not part of Kontrol/devspace.
  Do not add them to the project workflow, runtime, documentation, or review
  gates.

Current implementation contracts:

- Scheduled cancellation records one durable request ID and the
  `cancellation_requested` state before contacting a worker. Missing remote
  metadata and termination acknowledgements are not proof of shutdown. A job
  becomes terminal only after confirmed non-dispatch, confirmed remote absence,
  or worker cancellation; workspace leases remain fenced until then. A
  cancelling work session fences new worker actions, handoffs, and continuation
  dispatches while already-waiting workers may drain the cancellation signal.
- Unauthenticated liveness/readiness responses expose boolean status only.
  Build, process, session, and workflow diagnostics require the appropriate
  internal readiness or authenticated diagnostics boundary.
- `/healthz` is process/event-loop liveness only. `/core-readyz` checks bounded
  core serviceability, schema, admission, and runtime/build identity;
  `/readyz` adds operational dependencies. `PRAGMA quick_check` and other
  expensive integrity scans run as single-flight, deadline-bounded diagnostic
  work off the serving event loop and never make a functioning core fail
  liveness.
- The resolved state directory contains one exclusive `runtime.lock` for the
  active launcher/generation. `start-all.sh`, `restart-kontrol.sh`,
  `kontrol serve`, the systemd core service, and the dev watcher must acquire
  or validate it. A running generation records its exact immutable artifact
  path; supervisors must restart that artifact, never a mutable generic
  `dist/`. Runtime identity is published only after successful socket bind.
- The resolved state directory also contains an independent exclusive
  `deployment.lock`. It serializes candidate preparation, stop, activation,
  commit, and rollback without blocking the serving runtime lock. Candidate
  and `deployment.<deploymentId>.json` records are transaction-scoped and
  retain inspectable prepare/stop/activate/rollback/commit state. Once a healthy generation is intentionally
  stopped, recovery ownership remains with the deployment controller or is
  delegated to a fresh controller that restores the exact committed release;
  no post-stop exit path may leave ownership unassigned.
- Project-controlled child processes receive an explicit non-secret
  environment allowlist. Mission verification is allowlisted and can be made
  fail-closed sandboxed with `KONTROL_VERIFY_SANDBOX=1`; additional ordinary
  names require `KONTROL_CHILD_ENV_ALLOWLIST`, and approved user toolchains
  require `KONTROL_VERIFY_TOOLCHAIN_PATHS` when sandboxed.
- Review submissions persist structured checkpoint file metadata. Verification
  uses those paths for affected-area selection and never parses unified diff
  headers as a path protocol; legacy submissions without metadata are
  conservative and cannot skip affected checks.
- Policy grants are durable and reviewer-revocable. Work-session grants are
  revoked at terminal session state (including startup reconciliation), while
  workspace grants survive restart until explicitly revoked. A session grant
  is never offered without a concrete work-session ID.
- Native-CDP reviewer authentication uses a separate durable auth state. Manual
  sign-in runs in official Chrome without remote debugging, then the same
  private profile is relaunched under loopback CDP and ChatGPT session readiness
  is verified before conversation binding. Credentials and cookies never enter
  MCP or Kontrol storage. Expired browser dispatch leases requeue only attempts
  known to be before the send boundary; later attempts remain fenced for exact
  conversation reconciliation. Shutdown drains the dispatcher before closing
  CDP or SQLite.
- An expired post-dispatch browser attempt remains fenced until authenticated
  feedback commits or the active reviewer explicitly inspects the exact bound
  conversation and confirms the immutable prompt is absent. Recovery records
  the reviewer principal and a hash of the inspection note before requeueing
  the same immutable reviewer message; uncertain prompts are never auto-retried.
- `outcome_verified` mission observations are recorded only by the authenticated
  reviewer workflow and bind the exact submission, review epoch, snapshot,
  contract-declared expected behavior, observer principal, and external-evidence
  hash. `canApprove` consumes only matching receipts. `operationally_stable`
  remains unsupported until its durability window and signed qualification
  receipt exist.
- Ordinary `bash` in minimal/full tool modes starts through
  `ProcessSessionManager` with a bounded request yield and an independent child
  timeout; a still-running command returns a process session for the read-only
  `poll_process` tool. Exact owner-scoped launches may include
  `clientMutationId`; the process manager keeps the launch fingerprint and
  existing session/result for bounded retry recovery, rejecting reuse with
  different command content.
- The Workspace App process card keeps the command visible while a session is
  running, shows `Running · <elapsed>`, and exposes the latest polled output.
- The Workspace App approval center visibly lists effective workspace policy
  grants and provides reviewer-only revocation controls; refreshing the active
  workspace rehydrates that grant list from `list_policy_grants`.
- ACP outbound webhooks are disabled by default and require an explicit enable
  flag plus an exact host allowlist (or an explicit `*` policy). Delivery
  maintenance is single-flight and drained before server database shutdown.
- Linux is the supported production lifecycle platform through the systemd
  user service. macOS and Windows are development/integration platforms; no
  bundled launchd or Windows Service manager is claimed.
- Supervisor completion is evidence-driven: the persisted progress vector and
  stagnation/failure-fingerprint policy govern normal stopping; `maxCycles` is
  only an emergency cycle ceiling. Independent work sessions use the bounded
  `KONTROL_SUPERVISOR_MAX_INFLIGHT` pool, while each work session remains
  single-flight.
- Mission verification binds to the exact submitted tree, schedules dependency
  aware read-only checks with the bounded `KONTROL_VERIFY_MAX_INFLIGHT` pool,
  and may reuse evidence only when submission, snapshot, command version,
  environment, and verifier policy match.
- Mission evidence is authoritative only when its server-assigned source
  matches the criterion's verification type. Current criterion state is
  derived from qualifying evidence bound to the active submission, normalized
  snapshot identity, and review epoch; persisted status fields are hints only.
  `verified_resolved` findings require independent evidence against the exact
  current submission. `snapshotKind` plus `snapshotRef` is canonical;
  `snapshotCommit` is accepted only as a matching compatibility alias.
- Mission contract validation and identity, evidence qualification, finding
  transitions, effective outcome evaluation, and correction-loop policy are
  owned by `src/mission/` authority modules. `src/mission-ledger.ts` persists
  records and assembles packets; callers must consume its effective projections
  rather than infer completion from stored status fields.
- Both supervised public entry paths use the same mission contract and
  reviewer-gated completion policy. Correction rounds are separate from the
  supervisor emergency cycle ceiling. Baseline capture is required before a
  mission is created. Stable-beta qualification includes a
  `supervised-mission-loop` fault case and requires that case's receipt for the
  exact build in the soak assertion set.
- Native Hermes supervision distinguishes idle control-plane silence from a
  known child operation or pending permission. `KONTROL_HERMES_MAX_RUN_SECONDS`
  remains the absolute safety ceiling, and `KONTROL_HERMES_DEADMAN_IDLE_MS`
  controls only the idle watchdog.
- Hermes provider sessions are durably bound to the work session, selected
  agent, workspace, and provider generation before the first prompt executes.
  Continuations load that exact ACP session and fail closed when it is missing,
  mismatched, or unsupported. Per-work-session Hermes homes are private
  directories outside the checkout; confined runs mount only that session
  directory writable while keeping the workspace and runtime projections
  read-only. Only ACP `end_turn` counts as successful completion; cancellation,
  refusal, limits, missing stop reasons, and unknown reasons do not.
- Confined Hermes launches bind only the selected ACP executable and its
  expected sibling Python interpreter, then run the exact selected entrypoint's
  `--check` inside Bubblewrap before accepting the worker. A launcher that
  cannot resolve that interpreter fails as `sandbox_unavailable`.
- Tunnel supervision distinguishes local daemon liveness from remote
  control-plane state. Transient throttling, authentication, and upstream
  outages remain degraded without restarting a healthy tunnel/core; a local
  stale-registration response may consume a bounded tunnel-only
  reconciliation restart. The external connector must establish a fresh MCP
  transport after a stale route; Kontrol never treats an old transport ID as
  durable continuity.
- Adapter startup reconciles durable detached-child ownership before reporting
  `READY`; inability to terminate an orphan or persist ownership is fail-closed.
  CRUSH output events are coalesced and serialized so terminal lifecycle events
  cannot overtake queued telemetry. Terminal events are spooled durably before
  network delivery.
- The generic stdio ACP adapter launches agents through ACP v1 `initialize`,
  `session/new`, and `session/prompt`; custom nonstandard dispatch methods must
  be explicitly configured. A scheduled `read_only_audit` uses a signed,
  attempt-bound `read_only_execution_grant`, never a mutation lease. Bundled
  adapters verify the grant against the local registered agent identity before
  launch and require Linux bubblewrap to mount the canonical workspace
  read-only and provide private scratch; unavailable confinement fails as
  `sandbox_unavailable`. Network access is disabled by default. An operator may
  set `KONTROL_READ_ONLY_NETWORK_POLICY=host` to share host networking for model
  inference; that choice is signed into each grant and returned in its receipt,
  and the agent cannot elevate it. Read-only agent environment additions require
  `KONTROL_READ_ONLY_AGENT_ENV_ALLOWLIST`.
- Adapter dispatch receipts bind the idempotency key to a canonical request
  fingerprint and execution identity before worker launch. Identical retries
  return the existing receipt, conflicting content is rejected, startup
  reconciles receipts with owned-child records, and unresolved receipts are
  retained until terminal evidence permits pruning. CRUSH, Hermes, and generic
  stdio workers wait behind a closed launch gate until the wrapper process and
  durable start intent are recorded. A `dispatching` receipt is authoritatively
  `unstarted` only while there is evidence that the gate never opened; after
  `start_requested`, recovery terminates the owned process group and fails the
  run rather than risking duplicate execution. Adapters report `running` only
  after confirming the agent child spawned.
- Direct MCP policy approval returns a durable, retryable `approval_required`
  result immediately; it must not depend on an hours-long HTTP request.
  Controlled ACP/work-session approval may remain blocking. Durable approval
  identity is a canonical operation fingerprint, not transient MCP session or
  request IDs. Direct orphan cards have a bounded reattachment grace period;
  live waiters are separate and cleaned up on disconnect or resolution.
- Approval-required MCP responses remain valid against the gated tool's
  declared output schema, including tool-specific preview fields such as
  `apply_patch` additions, removals, and files.
- The Linux systemd deployment is named `kontrol-core.service` and owns the
  MCP core only. `start-all.sh` is the full development/integration launcher;
  these paths share the runtime lock and cannot own one generation together.
- Checkout restarts are two-phase: `restart-kontrol.sh` prepares and validates
  an immutable candidate while the current tmux generation remains serving,
  then activates it through readiness-gated handoff and rollback. An independent
  deployment lock serializes the complete prepare/stop/activate/rollback
  transaction; its `--prepare-only` and `--activate-existing` phases must not
  be collapsed into a stop-then-build sequence. Candidate checks require the
  complete current Workspace App renderer metadata; rollback readiness may
  accept an older release without the ChatGPT `openai/outputTemplate` field
  only when its hashed modern renderer and exact listed Skybridge resource
  still serve correctly.
- `scripts/build-atomic.mjs` produces only a release-local, independently
  loadable candidate and a build-result record; it never changes `dist/`,
  `dist.previous`, or the committed generation. A candidate must pass static
  release-local import validation (including absolute/file-URL and repository
  layout escapes) plus an isolated load/boot/MCP smoke before activation.
  `build-meta.json` keeps the executable-tree `contentSha256` separate from
  the immutable build ID, which also binds source provenance and build time;
  stale metadata cannot be reused for a new release identity.
  `generation.json` owns active, previous, and last-known-good artifacts; those
  pointers rotate only after readiness is proven.
- The MCP tool surface has a mandatory structured inspection contract:
  `read`, `grep`, `glob`, `ls`, `git_status`, `git_log`, `git_diff`, and
  `git_show` are registered and verified in every tool mode. `git_show` with a
  validated `path` returns the file or tree object at `<revision>:<path>`;
  without a path it returns revision metadata and stats. The server
  version includes the immutable artifact content identity; `open_workspace`,
  authenticated diagnostics, and `generation.json` expose the surface
  identity. A stale host catalog receives bounded list-changed notifications
  after initialize and when a GET SSE stream is established; clients must
  establish a fresh MCP initialize if their tool catalog remains stale.
  The `kontrol.dev/tool-catalog-ack-v1` receipt fingerprints exact server and
  host `tools/list` descriptors and immutable server version. Authenticated
  diagnostics expose pending or rejected parity as a machine-readable
  degradation; beta release qualification requires a fresh exact external-host
  parity receipt. Clients without the extension remain visibly unqualified,
  and strict deployments reject tool calls until an exact receipt is accepted.
- Workspace App resources use content-hashed HTML identities. Retain up to 64
  prior releases for 30 days as lazy immutable references; each historical
  modern URI and `.skybridge.html` alias must return the exact bytes matching
  its hash. Unknown hashes return bounded errors and never alias the current
  app. `show_workspace_ui`, `show_changes`, and `open_approval_center` are
  renderer entry points and advertise both `_meta.ui.resourceUri` and the
  matching `openai/outputTemplate`; `open_workspace` and app-callable data
  tools remain renderer-free.
- Structured inspection results have a 48,000-byte text cap. `read` defaults
  to and is capped at 600 lines, returns `offset`, `returnedLines`,
  `truncated`, and `nextOffset` when applicable, and hashes the complete file
  bytes. `grep`, `glob`, `ls`, and Git output use the shared byte bound and
  report truncation. Ordinary tool cards do not copy result content into
  `_meta`; the Workspace App renders `result.content` when a compact card has
  no payload copy.
- `glob` uses Pi's `fd` integration when available and falls back to Node's
  built-in globber when `fd` is absent or rejects `--no-require-git`; both
  paths keep `.git` and `node_modules` out of results.
- Interactive MCP requests and Workspace App resource reads wait at most
  `KONTROL_MCP_INTERACTIVE_ADMISSION_TIMEOUT_MS` (default 8 seconds) for
  admission, with a per-session queued-request cap of 16. Durable authenticated
  workers retain the long admission timeout. Capacity rejections include
  `Retry-After: 1`.
- Every MCP `text/event-stream` response, including POST tool responses, sends
  bounded SSE comment heartbeats every 15 seconds by default with proxy
  buffering disabled. Operation diagnostics count `heartbeatBytes` separately
  from JSON-RPC `responseBytes`.
- SSE responses track writer stalls and terminate only the affected response
  after `KONTROL_MCP_SSE_MAX_STALL_MS` (30 seconds by default). A stalled
  response does not close the MCP transport or change the authoritative state
  of its unfinished operation; stall timeout, recovery, and stream abort have
  distinct diagnostics.
- Workspace App reconnects are limited to classified transport, expired-session,
  and transient-availability failures. Tool, protocol, and authorization errors
  do not invalidate a healthy App transport. Mutations with an ambiguous
  outcome are reconciled and never blindly replayed; stale App generations
  cannot initiate a second reconnect.
- The stdio bridge retains its downstream MCP server during upstream
  interruptions and rebuilds a fresh upstream session through a bounded,
  single-flight reconnect lifecycle. It preserves worker attribution headers,
  fences callbacks by connection generation, and never replays an operation
  whose outcome is unknown.
- An MCP handler that outlives its HTTP response deadline retains its admission
  ownership until it actually settles. Cancellation moves through
  `CANCELLING` to visible `STUCK` state after
  `KONTROL_MCP_OPERATION_CANCEL_GRACE_MS`; diagnostics expose stuck age and
  admission weight. Shutdown stops new admission and waits up to
  `KONTROL_MCP_SHUTDOWN_DRAIN_MS`; if an execution remains active, its transport,
  stores, and runtime ownership remain fenced for a later drain retry. Once
  executions quiesce, passive MCP watchers may be woken by closing their
  transports before dependent stores are closed.
- `read` returns content and the SHA-256 version of the complete file bytes
  from the same byte observation, including when returning a partial line
  range. `write` and `edit` accept an optional `expectedContentSha256`, while Codex
  `apply_patch` accepts `expectedContentSha256ByPath`; supplied preconditions
  are checked under a process-wide, path-keyed mutation coordinator immediately
  before mutation, so overlapping same-version edits serialize and a
  `file_version_conflict` response leaves all files unchanged.
- Scheduled dispatch keeps uncertain attempts active until authoritative
  reconciliation. Kontrol persists the dispatch idempotency key before outbound
  ACP traffic and uses direct local lookup plus adapter-side lookup after
  response loss; it never blindly redelivers an uncertain launch. A server-owned
  event projection advances a durable per-job event cursor and treats worker
  turn completion, reviewer approval, rejection, failure, and cancellation as
  distinct lifecycle outcomes.
- Scheduled jobs are durably owned by authenticated principal and remain
  recoverable from a fresh MCP transport for that principal; foreign principals
  cannot read or cancel them. `get_scheduled_job_result` is a read-only receipt
  over existing ACP runs, submissions, and mission evidence, with paged report
  retrieval and explicit execution, review, verification, snapshot, and
  cancellation request/remote-confirmation fields.
  Scheduler history and recovery use SQL limits and cursors, bounded dispatch
  concurrency, and diagnostics for due age, uncertain launches, unreconciled
  attempt age, and dispatch throughput.
- Scheduled job capability metadata describes both `read_only_audit` and
  `bounded_file_write`; host catalog availability and a real bounded-write
  receipt still require current external qualification evidence.
- Scheduled worker completion is derived only from authenticated lifecycle
  evidence bound to the authoritative dispatch attempt. Dispatch acceptance,
  worker start/stop outcome, and reviewer approval remain separate; a rejected
  pre-spawn attempt or a failed worker cannot produce `workerCompleted: true`.
- Available terminal worker failure details are projected into bounded,
  redacted reason, exit code, signal, and stderr-tail evidence for the exact run
  and attempt. Explicit timeout and protocol reasons take precedence over
  signal and exit-code fallback classes. Raw adapter diagnostic fields are
  removed before event persistence.
- Scheduled failure receipts may project pre-structured terminal events only
  when run, attempt, and dispatch identities match the current attempt. Legacy
  stderr is redacted and byte-bounded before it is exposed.
- Scheduled result getters never persist artifacts or otherwise mutate durable
  state. Lifecycle projection records a durable report-finalization obligation
  before persisting the immutable report; bounded reconciliation retries any
  incomplete finalization after failure or restart. Result receipts accept every
  persisted finalization state: `pending`, `completed`, `no_output`, or
  `unavailable`.
- Scheduled verification execution has a durable reviewer-request idempotency
  claim bound to job, work session, submission, review epoch, canonical snapshot,
  policy, commands, and deadline. Identical retries reuse the running or
  completed execution, conflicting reuse fails closed, expired executions
  become durable failures, and a new reviewer request creates a separate
  immutable report. The job receipt projects only evidence for the exact active
  submission and snapshot; a newer failed report cannot be hidden by an older
  passing report, and a scheduled pass alone does not claim independent outcome
  verification.
- Temporary scheduled-dispatch blockers use persisted exponential backoff with
  bounded jitter and retain retry count, next eligible time, blocker, and last
  attempted agent across restart. Permanent configuration blockers become
  `blocked` and require a reviewer retry after correction; they are not retried
  automatically.
- Beta qualification records scheduled control-plane lifecycle evidence
  separately from bundled-adapter security evidence. The
  `scheduled-job-unattended-e2e.mjs` fixture does not qualify adapter
  confinement; `scheduled-readonly-adapters-e2e.mjs`,
  `acp-readonly-adapters.integration.test.mjs`, and
  `adapter-launch-recovery.test.mjs` provide the named bundled-adapter,
  signed-grant/receipt, and crash-recovery evidence.
- Scheduled worker runtime deadlines stop when execution stops and do not count
  human review waiting. Lifecycle events bind to the active dispatch attempt,
  logical run, attempt number, and remote run where available; stale attempts
  cannot resolve current cancellation. `operator_intervention` keeps the
  original attempt reconcilable and prohibits automatic redispatch. Scheduler
  phase failures are durably attributed and exposed through authenticated
  serviceability diagnostics.
- Scheduled verification commands must be declared and allowlisted before
  dispatch. A reviewer starts them against the exact submitted snapshot in a
  disposable, network-isolated bubblewrap workspace; the source checkout stays
  read-only. Verification reports are immutable, content-hashed artifacts with
  bounded UTF-8-safe pagination.
- Periodic and startup reconciliation is bounded by pages/cursors so runtime
  state, approval expiry, direct-approval orphan cleanup, and telemetry work
  cannot become an unbounded synchronous serving-thread sweep.
- Durable telemetry ingress coalesces only contiguous compatible fragments.
  Committed event-ID tombstones are pruned in bounded pages after
  `KONTROL_TELEMETRY_INGRESS_RETENTION_MS` (30 days by default); pending
  ingress is never pruned.
- Workspace event reads and subscriptions resolve workspace sessions through the
  same project scope, and review/tool cursors use stable timestamp-plus-ID
  ordering. Older pending reviews are discoverable through an explicit stale
  history filter rather than silently disappearing from the active surface.
- Historical pending-review UI uses the server's descending timestamp-plus-ID
  keyset cursor, keeps loading state visible, and reports when the history is
  exhausted. Workspace changes discard the prior history cursor.
- `changes_requested` review feedback requires nonempty agent instructions.
  Durable bridge and policy mutations accept an optional authenticated
  principal-scoped `clientMutationId`; canonical request receipts replay
  completed outcomes and fail closed on conflicting, pending, corrupt, or
  unfinalizable reuse. Receipt maintenance is bounded and retains pending rows
  for reconciliation.
- `npm run test:ui` includes a real Chromium pass over the built single-file
  Workspace UI, covering responsive layout, focus-visible controls, host theme
  tokens, and live-versus-stale session status presentation. The agent submit
  bar is one persistent per-app instance with a multiline draft; Ctrl/Cmd+Enter
  submits, reference-only ChatGPT placeholders remain visible with a warning,
  and Copy Raw uses original payload text with a manual textarea fallback when
  the host denies clipboard-write permission. `KONTROL_UI_SCREENSHOT_DIR`
  opt-in captures deterministic Chromium evidence for before/current visual
  comparison without expanding the test's workspace authority.
- `npm run test:runtime` builds the Workspace App in a temporary artifact
  directory and passes its exact path to child checks. It must not leave a
  partial `dist/` projection in the checkout. CI sets a local Git identity for
  synthetic repository fixtures.
- `npm run uat:release` packs and installs through `scripts/package-stage.mjs`
  so its end-to-end checks exercise an immutable candidate built from the
  current source instead of a potentially stale checkout `dist/` projection.
- Workspace App event waits default to 18 seconds so the watcher remains below
  common intermediary idle limits; reconnect retries recreate the host `App`
  transport while preserving the durable UI projection and draft state.
  Reconnect ownership is single-flight and teardown-cancellable; diagnostics
  classify response closure, DELETE, stale-session 404, admission exhaustion,
  idle eviction, stalled SSE, transport closure, watcher completion/abort, and
  trusted reconnect attempt/success with generation and duration buckets.
- Worker-bound MCP transports are protected by the associated nonterminal,
  actively owned work session rather than by an unbounded TTL. Detached or
  terminal worker sessions become reclaimable after their normal grace period.
- Scheduled read-only execution mode is persisted on the logical ACP run before
  the adapter request is sent. Lifecycle events may bypass checkout mutation
  lease renewal only when that persisted mode and a signed grant for the exact
  current attempt both match; scheduled-job work-session linkage can lag the
  first adapter event and is not lifecycle authority.
- `kontrol-supervisor.mjs` contains probe/status exceptions, opens a
  cooldown-backed per-component circuit after repeated failed recovery, and
  publishes generation/PID/start-token identity. `start-all.sh` validates that
  identity before transferring runtime-lock ownership.
- When `KONTROL_MCP_CANARY_URL` or `KONTROL_PUBLIC_BASE_URL` is configured,
  the supervisor independently runs a lower-frequency fresh MCP initialize,
  tools/list, and lightweight read canary. Canary failures are recorded in
  `supervisor-status.json` and diagnostics without restarting healthy local
  components. Credentialed probes use `KONTROL_MCP_CANARY_AUTH_FILE`, passed
  as a path to the scrubbed probe child; the secret is never placed in the
  supervisor command line or inherited child environment.
- Authenticated `mcpSessionMetrics.operationDiagnostics` is a bounded,
  body-free request correlation surface. It records operation/request IDs,
  generation and session prefix, method/tool, timing, HTTP status, locally
  written response bytes, close classification, admission/execution timing,
  and connection/resource counters; it never records auth headers, arguments,
  or response bodies. Responses echo safe request correlation IDs and include
  Kontrol operation/request IDs. Local response bytes do not establish
  intermediary delivery or ChatGPT acceptance. External interruption reports
  should correlate a browser HAR, Kontrol diagnostics/logs, and tunnel delivery
  logs with `scripts/analyze-mcp-stream-failure.mjs`, which keeps exact-ID
  matches separate from timestamp proximity.
- Authenticated MCP connection diagnostics expose a bounded lifecycle timeline
  with request/operation IDs, generation, session prefix, outcome class, and
  timing only. It excludes request bodies, tool arguments, and credentials;
  local response-write evidence does not prove host delivery or acceptance.
- External MCP qualification persists accepted/rejected catalog acknowledgements
  and completed `await_workspace_events` POST SSE observations in SQLite.
  Records contain content hashes, immutable build/version, full session SHA-256,
  exact operation ID for SSE, capture ID when supplied, timing, byte counts,
  and close classification; they never contain raw session IDs, arguments,
  response bodies, bearer tokens, or conversation data. Authenticated diagnostics
  can retrieve bounded evidence with exact build/capture/session/operation
  filters. Evidence is retained for 90 days and the journal is capped at 20,000
  records so qualification survives session eviction and process restart.
- Reviewer-submitted host observations and handoff attachments are content
  addressed and always `operator_reported`; `tools/list` plus an acknowledgement
  cannot prove the host's internal callable registry. Until a genuine host
  integration supplies that registry, `hostRegistrationVerified` stays false.
  Secure MCP Tunnel's Kontrol-side SSE evidence is distinct from the
  operator-reported host-facing HTTPS tunnel observation. List-changed pulses
  prove only server notification delivery, not client registry refresh.
- `scripts/probe-mcp-tunnel.mjs --dual` validates both fresh catalogs, uses
  reviewer authority for Workspace App event watchers when supplied, exercises
  an 18-second empty watcher heartbeat, reads actual repeated SSE heartbeat
  bytes, completes eight concurrent bounded inspections, applies concurrent
  Workspace App resource load, and can run a 45-second POST SSE tool call that
  requires repeated heartbeat comments plus clean operation diagnostics. Its
  HTTP request deadline must exceed the watcher interval and POST wait.
  Catalog extraction accepts one
  authoritative `tools/list` result and rejects ambiguous envelopes rather
  than merging arrays. A qualification capture has `capturedAt`, `captureId`,
  `initialize`, and the matching `toolsList`; the receipt labels the host
  exchange operator-supplied and Kontrol's live server exchange
  machine-verified. Qualification supports two mutually exclusive endpoint
  profiles: a hosted public HTTPS origin with `KONTROL_AUTH_MODE=oauth`, or
  OpenAI Secure MCP Tunnel with `KONTROL_AUTH_MODE=tunnel` and a loopback MCP
  origin. `start-all.sh --qualify` derives the profile from auth mode unless
  `KONTROL_BETA_SOAK_TRANSPORT` selects it explicitly, validates URL/profile
  agreement before running the code gate or changing the generation, and
  rejects local-only HTTP qualification. A single running generation and its
  receipt bind to one endpoint profile; qualify the other profile in its own
  run and retain its matching code, soak, and host-catalog evidence.
  Qualification requires the deployed HTTPS intermediary,
  at least two GET heartbeat bytes per session, two observed drain recoveries,
  eight bounded inspections per cycle, a near-complete 45-second POST heartbeat
  with separately counted diagnostics, and concurrent resource reads;
  localhost idle-proxy runs cannot create receipts. Secure MCP Tunnel
  qualification keeps Kontrol on loopback HTTP, binds the operator-supplied
  HTTPS transport to the exact tunnel ID and soak, and requires authenticated
  diagnostics to correlate the same host session's completed 45-second SSE
  tool call and heartbeat bytes.
  Pass `--host-catalog-file` to fail closed on missing/extra invocable tools
  and stale `serverInfo.version`.
  The default receipt path is `beta-external-catalog.json`; override it with
  `KONTROL_BETA_EXTERNAL_CATALOG_RECEIPT` when running the final gate.
  `beta-gate:final` requires its fresh parity receipt to target the soak origin,
  match the candidate's immutable MCP version and transport identity, be
  captured during the soak, and be probed again after the soak ends with
  streaming evidence present.
- `npm run probe:idle-proxy` is a localhost-only intermediary harness for the
  25-second idle-response acceptance scenario; it does not substitute for the
  real tunnel or ChatGPT host. Run the dual probe through it with the 18-second
  watcher interval before external qualification.
- MCP shutdown is one shared retry-safe close operation: each subsystem phase
  is bounded, later phases still run after an earlier failure, and repeated
  `close()` calls observe the same completion result.
- For the systemd core unit, `restart` means restart the installed immutable
  release; `upgrade` selects the latest immutable build candidate (falling
  back to the checkout `dist/` projection), verifies readiness, and restores
  the previous unit if activation fails.
- `npm run gate:beta:code` is the code/evidence stage and writes an ignored
  `beta-code-qualification.json`; `npm run soak:beta -- --hours 12
  --workspace-path WORKSPACE --build-id BUILD_ID` must then exercise that exact
  deployed build with diagnostics, tunnel monitoring, hourly paired Workspace
  App resource reads, resource-admission recovery, and expired-handler
  accounting; the receipt must contain the complete required assertion set.
  A fresh host catalog probe must also match that
  build after the soak; `npm run gate:beta:final` joins all evidence into
  `beta-qualification.json`. `npm run gate:beta` is the one-shot equivalent
  that runs the code stage and requires matching soak and external catalog
  receipts.
  The canonical gate enforces a 12-hour minimum (an environment override may
  only require longer). End-state SHA/cleanliness and candidate identity must
  still match. `--allow-dirty` is an evidence-collection override only: a
  dirty checkout can never produce a qualified receipt. The accelerated
  lifecycle checks do not replace the required multi-hour operational soak.
- `npm run soak:beta -- --hours 12` is the explicit real wall-clock soak
  command. It opens and closes fresh MCP transports, exercises liveness,
  readiness, initialize, tools/list, and optionally workspace read traffic,
  persists latency/failure metrics in `beta-soak.json`, and must be run
  against the intended deployment before claiming persistent-runtime support.

MCP context isolation:

- Treat each MCP transport session as an isolated conversation context. Never
  pool or reuse a transport because clients share a logical name such as
  `mcp:openai-mcp@1.0.0`.
- MCP transport/session IDs are disposable. The server may retain a bounded,
  in-memory continuity index for trusted OAuth, client-instance, or explicit
  conversation identities so a fresh initialize can be observed as a
  reconnect after socket loss. This metadata is not an authorization boundary,
  does not replay requests, and never merges or reuses transport state.
- Preserve the MCP session identity and any explicit upstream conversation
  correlation in diagnostics and event telemetry. Reject an explicit
  conversation-context mismatch on an existing transport.
- Do not enforce aggressive per-client session eviction using only generic
  `clientInfo.name/version`; when no trusted instance, conversation, or OAuth
  identity exists, use the global bound instead.
- Track transport activity separately from meaningful application activity;
  keep-alive/SSE activity must not extend application idle policy. Never reap
  active requests, streams, long polls, policy waiters, or durable work-session
  responsibilities. A single GET SSE response ending only releases that
  stream; it must not close the shared MCP transport or invalidate concurrent
  requests. Generic direct process ownership may end with its
  transport; trusted logical continuity can own interactive direct processes,
  and durable work-session ownership survives transport reconnect. When trusted
  continuity expires or is pressure-evicted, its logical direct process owner
  is terminated; a transport disconnect alone does not terminate that owner.
- Link workspaces, reviews, continuations, and missions through their explicit
  durable IDs. Do not infer that separate MCP transports represent the same
  conversation, even when they access the same project concurrently.
- Workspace event cursors advance across every inspected workspace event,
  including events filtered out by conversation ownership. Conversation-scoped
  reviewers receive only their own work-session surface; ownerless reviewers
  retain the explicit global recovery surface. Real HTTP reviewer connections
  must resolve a live transport identity; event waiters cancel their
  subscriptions when the request aborts.
- Unsupported widget resource hashes are rejected. The retained static widget
  cache is bounded by entries and bytes and is reported in diagnostics.
- `write`, `edit`, and `apply_patch` return `instructions_required` with the
  full nested instruction contents and content hash before any mutation when
  governing instructions have not been acknowledged by that transport.
- Review loops keep one Kontrol reviewer-thread identity per route epoch,
  separate from each immutable submission handoff. A one-time expiring
  activation grant is principal-scoped and stored only as a hash; reviewer
  claims require the activated principal and authenticated context. Host
  conversation IDs are correlation data and remain unverified unless a trusted
  host adapter attests them. Handoff messages track preparation, presentation,
  claim, and committed feedback separately. Pausing suppresses queued delivery
  while preserving the thread binding; route-epoch changes fence old claims.
  `completedReviewRounds` counts committed review feedback, while
  `admittedReviewRounds` enforces the immutable submission ceiling. MCP does
  not create or message a new ChatGPT conversation in the background; ChatGPT
  review activation requires an explicit user-opened context and grant. Once
  activated, the Workspace App event watcher may deliver queued review packets
  into that same conversation through MCP Apps `ui/message` when the host
  advertises messaging support. Delivery is acknowledged only after the host
  accepts the message; an ambiguous response stays fenced for inspection and is
  not blindly resent. The WebUI model reviews and submits feedback through the
  existing handoff tools, while human approval remains in the existing approval
  center. Review delivery may also use an explicitly selected, principal-owned
  private Chromium profile. The reviewer must open ChatGPT, choose the exact
  existing conversation, and bind that tab to the active review thread. Kontrol
  never creates a ChatGPT conversation. Native CDP sends only the bounded,
  hashed review packet and observes prompt acceptance as transport evidence.
  The browser attempt remains active until authenticated feedback commits; page
  generation is not a review outcome. Browser and worker-reply dispatchers wake
  from post-commit outbox notifications, reconcile durable work at startup, and
  use a deadline timer only for scheduled retries. Only authenticated review
  tools commit feedback and wake the agent. Login or
  verification screens require human action; uncertain sends remain fenced
  until reconciled.
- Clarification replies remain authoritative in the durable agent-reply store.
  The `agent.reply.ready` outbox event wakes native-resume handling once; an
  MCP waiter consumes replies through its subscribe-before-query wait and can
  recover unacknowledged replies after reconnect. Outbox wake events are not
  kept cycling as a substitute for reply persistence.
- In native-CDP review mode, worker clarification and blocker messages are
  queued to that route's bound conversation as advisory requests. Their replies
  settle the browser turn and return through the durable agent-reply path; they
  cannot commit a review verdict or grant workspace permissions.
- Review handoff claims carry a bounded 15-minute lease. Feedback commit checks
  the exact claim, principal, context, route epoch, pending submission, snapshot,
  and unexpired lease in its authoritative transaction. A reviewer can renew an
  expired claim through compare-and-swap; release clears all claim identity.
- The generic stdio ACP adapter persists provider-native session IDs by durable
  work-session identity. A continuation reloads that same session only when
  the ACP agent advertises `loadSession`; otherwise it fails closed instead of
  starting an unrelated conversation. ACP worker identity, the review WebUI
  thread, and the Kontrol work session remain separate identities.

## Child DOX Index

| Path | Purpose |
|------|---------|
| `src/review-thread/` | Persistent reviewer-thread identity, activation authority, and message lifecycle |
| `src/review-browser/` | Private Chromium profile lifecycle, exact ChatGPT conversation binding, and bounded review packet transport |
| `src/server/` | Startup recovery, bounded reconciliation, and ordered server shutdown |
| `src/ui/` | Workspace App hydration, event replay, and reviewer-visible recovery state |
| `src/mission-ledger.ts` | Durable mission evidence, exact-snapshot approval projection, and external outcome receipts |
