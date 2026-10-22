# DevSpace Ralphie Muntz Review Loop Handoff

Updated: 2026-10-21 (reconcile pass in isolated worktree `handoff/reconcile-review-loop`)

> Reconciliation pass: this document was updated after the remaining review-loop
> fixes were implemented in an isolated worktree and compared against the
> alternate feature branch rather than copied. The reconciled implementation is
> UNCOMMITTED and awaits review. See "Reconcile pass (this worktree)" below.

## Goal and boundaries

Complete the DevSpace review loop so an implementing agent can submit a bounded
work packet to its already-bound WebUI reviewer context, receive authenticated
review feedback, and continue. The WebUI is the reviewer and orchestrator.
Human approvals stay in the existing Approval Center. There is no reviewer
dashboard, and Kontrol does not create a new ChatGPT conversation. MAO is out of
scope.

## Implemented in the live checkout

The implementation and its tests are included in the pending local commit from
`/home/bamn/devspace`:

- Durable reviewer-thread identity is scoped to a route and route epoch. One-
  time activation grants are expiring, principal-scoped, and persisted only as
  hashes. Claims and feedback commits bind to the authorized principal,
  transport context, submission, snapshot, epoch, and lease.
- Review packets are bounded and content-addressed. Handoff preparation,
  presentation, claim, and committed feedback have distinct durable states.
  Host conversation IDs are correlation data unless a trusted host adapter
  verifies them.
- MCP Apps delivery can send a queued packet into the explicitly activated
  existing WebUI conversation. Native CDP delivery binds to an explicitly
  selected ChatGPT profile and exact conversation target. Neither route creates
  a conversation. Authentication and verification screens stop for human
  action.
- Browser delivery is transport only. Prompt acceptance and page generation do
  not count as a verdict. Only authenticated review tools commit feedback and
  wake the agent. Ambiguous sends remain fenced for inspection.
- Clarification and blocker messages can wake the bound native-CDP conversation
  as advisory requests. Replies return through the durable agent-reply store and
  cannot approve work or grant permissions.
- Browser and reply dispatchers reconcile durable outbox work at startup, wake
  from post-commit events, and use a single deadline timer for retries instead
  of polling.
- Agent session continuations preserve provider-native identity. Hermes and
  generic stdio ACP session bindings are persisted and fail closed when they
  are missing or mismatched. Hermes per-session homes are isolated; only ACP
  `end_turn` is successful completion. Confined Hermes launches bind the
  selected executable and sibling interpreter.
- Workspace session state and event projections expose review progress without
  adding a reviewer dashboard. Root and subtree `AGENTS.md` contracts document
  the authority, delivery, and UI boundaries.

## Verification already performed

These checks passed during implementation; they were not rerun while preparing
this handoff or commit:

- `npm run typecheck -- --pretty false`
- `npx tsx src/bridge/reply-dispatcher.test.ts`
- `npx tsx src/bridge/reply-flow.test.ts`
- `npx tsx src/dispatch-outbox.test.ts`
- `npm run test:review-thread`
- `npm run test:review-browser`

No end-to-end ChatGPT sign-in, reviewer packet delivery, or feedback round trip
has been qualified against a live authenticated ChatGPT conversation.

## Remaining work

1. **Update Chrome before retrying sign-in.** The installed package was
   `150.0.7871.114-1`; apt offered `156.0.8078.47-1`. The failed sign-in page
   reported Chrome was out of date. Installation was blocked because this
   session has no sudo password. Run:

   ```sh
   sudo apt-get install --only-upgrade google-chrome-stable
   ```

2. **Reopen and authenticate.** After the update, reopen ChatGPT with the
   dedicated persistent profile at
   `/home/bamn/.local/share/devspace/chatgpt-reviewer-chrome`. The profile
   remains on disk, but Chrome is currently closed and the prior CDP endpoint is
   gone. The user must complete sign-in.

3. **Bind the exact conversation.** In ChatGPT, select the intended existing
   conversation and explicitly activate/bind its tab to the current review
   thread. Verify the route, target, and principal bindings before sending. Do
   not create a new conversation or send a packet until the exact binding is
   established.

4. **Qualify the full loop.** Verify one actual bounded packet reaches that
   conversation, the WebUI returns structured authenticated feedback through
   the existing handoff tools, and the agent receives the continuation. Also
   verify that browser acceptance alone leaves the review pending and that
   approval remains in the existing Approval Center.

5. **Reconcile the alternate feature branch before integration.** The worktree
   `/home/bamn/.devdesktop/worktrees/devspace-review-browser` is on
   `codex/reviewer-browser-actuator` at `2b64ecc`; it is six commits ahead of
   the live checkout's base (`7a44879`) and has additional dirty edits. Its
   changes overlap the live checkout's uncommitted implementation. Compare the
   complete diffs before cherry-picking or merging; do not combine them
   blindly.

6. **Decide the stale worktree records.** Preserve the clean detached
   `/home/bamn/.devdesktop/worktrees/devspace-5f420827` at `a0c1311` as a
   historical checkpoint. `/tmp/devspace-review-qualification` is a dirty
   alternate candidate at `2b64ecc`, not the selected source. The registered
   `/tmp/devspace-hermes-session` worktree is marked prunable because its gitdir
   target is missing. None was cleaned or pruned.

7. **No remote publication has happened.** The live branch `audit-k02-k04` was
   31 commits ahead of `origin/audit-k02-k04` at handoff time. Do not push or
   merge without explicit authorization.

## Repository state at handoff

- Authoritative working checkout: `/home/bamn/devspace`, branch
  `audit-k02-k04`, pre-commit HEAD `7a448794af6d73cc87a5ff9235f5514fe9d1e1df`.
- The live checkout contained a broad, internally related set of DevSpace
  review-loop, ACP continuation, Hermes isolation, UI projection, test, and
  instruction changes. These changes and this handoff are committed together
  locally; no unrelated worktree was staged.
- No MAO files or ActiveTab application files were changed. ActiveTab was
  inspected read-only for its persistent-profile and exact-target patterns.
- The dedicated ChatGPT profile is outside the repository and is not part of
  the commit. No credentials or review packet were sent.

---

## Reconcile pass (this worktree)

Implemented in isolated worktree
`/home/bamn/.local/share/opencode/worktrees/devspace/handoff-reconcile-review-loop`
on branch `handoff/reconcile-review-loop` (base `132d4aa`). All changes are
UNCOMMITTED and await review. The alternate feature branch
`/home/bamn/.devdesktop/worktrees/devspace-review-browser` at `2b64ecc` was
used as a read-only reference — its superior typed `DeliveryOutcome`,
`getActivationTarget` preflight, and `setRouteStatus` `pending_activation` guard
were adapted to this branch's structure, not copied verbatim.

### Reconciled items

1. **Activation renderer metadata + identity, scoped activation event, reducer
   pre-session drain.** `activate_review_thread` now returns
   `workspaceAppRenderToolMeta()` `_meta` and `tool`/`threadId`/`reviewThreadId`/
   `workspaceId` output; the `review.thread.activated` event carries
   `workspaceSessionId`. `workspace-event-reducer.ts` drains queued review
   messages for `review.thread.activated`, `review.thread.reattached`, and
   `review.thread.delivery_requeued` even before a session card exists.
2. **`reattach_review_thread` with preflight.** New tool consumes an owner-issued
   one-time recovery grant; `threads.getActivationTarget()` preflights
   grant+route+thread WITHOUT consuming it, and `activate(reattachOnly)` fails
   closed when no existing distinct binding exists, so an unresolved workspace
   never burns the grant. Uncertain presenting packets remain fenced.
3. **`renew_review_handoff_claim`.** `route-store.renewHandoffClaim()` requires
   same principal/context/revision/route epoch + unexpired lease, clamps each
   renewal to 60s–30m and caps cumulative claim at 2h from `claimedAt`; new
   `review.handoff.claim_renewed` event; MCP tool `renew_review_handoff_claim`.
4. **Required review-thread manifest in release + tunnel probes.** New
   `scripts/lib/review-thread-tool-manifest.mjs` (+ `.d.mts`) lists the 8
   reviewer-thread tools; `probe-release.mjs` asserts them on the candidate
   tools/list, adds activate/reattach to renderer tools, and enables the
   isolated probe-only bridge (`KONTROL_ACP_ENABLED=true` + `randomBytes(48)`
   ACP secrets); `probe-mcp-tunnel.mjs` requires the manifest tools.
5. **Typed delivery outcomes.** `review-thread-delivery.ts` now returns
   `DeliveryOutcome` = `unsupported | empty | accepted | rejected | uncertain |
   tool_error`; authenticated verdict separation is preserved (transport
   acceptance never asserts the model read the packet).
6. **`setRouteStatus` preserves `pending_activation`.** A route status change
   does not fabricate an active thread when no reviewer principal/context
   binding exists.

### Fresh evidence (run in this worktree)

- `npm run typecheck -- --pretty false` — clean.
- `npm run test:review-thread` — all 7 suites pass, including the new
  `src/ui/review-thread-event-trigger.test.ts` (pre-session drain) and the
  rewritten `review-thread-mcp.test.ts` (manifest, renderer meta, preflight
  fail-closed leaving grant intact, reattach).
- `review-thread-delivery.test.ts` asserts every typed `DeliveryOutcome`
  (`unsupported`, `empty`, `accepted`, `rejected`, `uncertain`, `tool_error`).
- `review-thread.test.ts` asserts `setRouteStatus` preserves `pending_activation`
  for an unbound thread (active and paused).
- `src/bridge/handoff-tools.test.ts`, `src/review-handoff/route-store.test.ts`
  — renewal success / stalled-revision / wrong-principal / expired / reclaim
  all passing.
- `npm run test:ui` — full Chromium UI chain (build + size + contract +
  responsive/focus/theme/status render) passes, exercising the reducer change.
- UI unit tests: `workspace-app-contract`, `tool-display`, `server-tool-call`,
  `workspace-app-host-lifecycle` all pass.
- `npm run test:syntax` — clean, including `node --check` on
  `probe-release.mjs`, `probe-mcp-tunnel.mjs`, and the new manifest.
- `dist/` was rebuilt (`npm run build:app`) so `review-thread-mcp.test.ts`
  (which requires the built Workspace App artifact) can run.

### Remaining live prerequisites (NOT completed here)

- The full `probe-release.mjs` candidate boot and the live `probe-mcp-tunnel.mjs`
  catalog parity are deployment gates; they were syntax/import checked but not
  executed against a deployed candidate/tunnel in this session.
- No end-to-end ChatGPT sign-in, packet delivery, or feedback round trip was
  qualified against a live authenticated conversation.
- The original handoff's remaining work (Chrome update, re-auth, bind
  conversation, qualify full loop, decide stale worktrees, no remote publish)
  is unchanged and still applies.

### Boundary

No edits were made to `/home/bamn/devspace` or any other worktree. Nothing was
pushed or merged, no service was restarted, no browser/profile was touched, and
no secret was read. Working diff only — **do not commit until review**.

---

## Integration candidate (composed worktree)

Composed into the `handoff/integration-candidate` worktree (base `132d4aa`) by
reproducing the exact `git diff 132d4aa` from each source worktree (reconcile
review loop, browser-restore-cleanup, package-hermes-dependency, and
qualify-browser-feedback) and copying the new files verbatim (md5-verified, no
drift). All changes remain UNCOMMITTED on this branch.

### Wiring decisions (documented)

- `test:review-browser` now runs `contracts.test.ts && browser-restore-cleanup.test.ts`
  (fixes the browser-restore-cleanup P2 wiring into a runnable script).
- Added a NEW standalone script `test:review-loop-integration`:
  `KONTROL_WORKSPACE_APP_HTML_PATH=./dist/ui/workspace-app.html node --import tsx src/review-browser-handoff-integration.test.ts`.
- It was NOT added to the canonical `npm test` / `test:runtime` chain and NOT
  appended to `test:review-thread`. Reason: the canonical runtime runner
  (`scripts/run-runtime-tests.mjs`) builds the Workspace App to a temporary
  artifact directory and sets `KONTROL_WORKSPACE_APP_HTML_PATH` to its `ui/`
  subfolder — it never produces `./dist/ui/workspace-app.html` in the checkout,
  and the integration test fails fast (by design) when the artifact path is
  absent. So it stays a standalone, artifact-gated script; run `npm run build:app`
  (or build via `test:runtime` into a known artifact) before
  `npm run test:review-loop-integration`.
- The `handoff-package-hermes-dependency` change (adds
  `scripts/lib/hermes-stop-reason.mjs` to npm `files`) was merged with the
  reconcile package.json change; both coexist (files array + the
  `test:review-thread` script line).

### Non-conflict verification

`handoff-reconcile-review-loop` modifies `src/bridge/handoff-tools.ts`;
`handoff-qualify-browser-feedback` modifies `src/bridge/review-tools.ts`. These
are DIFFERENT files — no edit conflict. All four patch files applied cleanly via
`git apply --check` and no hunks overlapped.
