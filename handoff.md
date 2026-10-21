# DevSpace Ralphie Muntz Review Loop Handoff

Updated: 2026-10-21

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
