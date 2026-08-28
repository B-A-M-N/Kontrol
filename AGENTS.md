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

- Cancellation records a durable intermediate `cancelling` phase, requests the
  remote worker stop, and becomes terminal only after worker shutdown or a
  confirmed missing remote run; workspace leases remain fenced until then.
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
- Native Hermes supervision distinguishes idle control-plane silence from a
  known child operation or pending permission. `KONTROL_HERMES_MAX_RUN_SECONDS`
  remains the absolute safety ceiling, and `KONTROL_HERMES_DEADMAN_IDLE_MS`
  controls only the idle watchdog.
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
- Direct MCP policy approval returns a durable, retryable `approval_required`
  result immediately; it must not depend on an hours-long HTTP request.
  Controlled ACP/work-session approval may remain blocking. Durable approval
  identity is a canonical operation fingerprint, not transient MCP session or
  request IDs. Direct orphan cards have a bounded reattachment grace period;
  live waiters are separate and cleaned up on disconnect or resolution.
- The Linux systemd deployment is named `kontrol-core.service` and owns the
  MCP core only. `start-all.sh` is the full development/integration launcher;
  these paths share the runtime lock and cannot own one generation together.
- Checkout restarts are two-phase: `restart-kontrol.sh` prepares and validates
  an immutable candidate while the current tmux generation remains serving,
  then activates it through readiness-gated handoff and rollback. An independent
  deployment lock serializes the complete prepare/stop/activate/rollback
  transaction; its `--prepare-only` and `--activate-existing` phases must not
  be collapsed into a stop-then-build sequence.
- `scripts/build-atomic.mjs` produces only a release-local, independently
  loadable candidate and a build-result record; it never changes `dist/`,
  `dist.previous`, or the committed generation. A candidate must pass static
  release-local import validation (including absolute/file-URL and repository
  layout escapes) plus an isolated load/boot/MCP smoke before activation.
  `generation.json` owns active, previous, and last-known-good artifacts; those
  pointers rotate only after readiness is proven.
- Periodic and startup reconciliation is bounded by pages/cursors so runtime
  state, approval expiry, direct-approval orphan cleanup, and telemetry work
  cannot become an unbounded synchronous serving-thread sweep.
- For the systemd core unit, `restart` means restart the installed immutable
  release; `upgrade` selects the latest immutable build candidate (falling
  back to the checkout `dist/` projection), verifies readiness, and restores
  the previous unit if activation fails.
- `npm run gate:beta:code` is the code/evidence stage and writes an ignored
  `beta-code-qualification.json`; `npm run soak:beta -- --hours 12
  --build-id BUILD_ID` must then exercise that exact deployed build with
  diagnostics and tunnel monitoring; the receipt must contain the complete
  required assertion set; `npm run gate:beta:final` joins the receipts into
  `beta-qualification.json`. `npm run gate:beta` is the one-shot equivalent
  that runs the code stage and requires an existing matching soak receipt.
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
  responsibilities. Generic direct process ownership may end with its
  transport; trusted logical continuity can own interactive direct processes,
  and durable work-session ownership survives transport reconnect. When trusted
  continuity expires or is pressure-evicted, its logical direct process owner
  is terminated; a transport disconnect alone does not terminate that owner.
- Link workspaces, reviews, continuations, and missions through their explicit
  durable IDs. Do not infer that separate MCP transports represent the same
  conversation, even when they access the same project concurrently.
