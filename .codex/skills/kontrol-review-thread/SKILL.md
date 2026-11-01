---
name: kontrol-review-thread
description: Fresh verified ChatGPT reviewer conversation per review loop, stable thread within the loop, skill-locked iteration budget, and isolation for Kontrol WebUI review threads.
version: 0.1.0
---

# Kontrol Review Thread

A new review loop receives a new reviewer conversation. All authorized iterations within that loop stay in that same conversation. A new database thread record alone never proves a fresh host conversation.

## Loop creation contract

At the start of the loop, the durable configuration records: review-loop ID, skill ID and version, work session, owner and reviewer principals, route and route epoch, thread ID, host conversation ID, `maxReviewRounds`, admitted and completed rounds, and status (`requested → creating_thread → awaiting_host_activation → bound_and_verified → active → completed | exhausted | rejected | cancelled`).

Failures enter recoverable blocked states. Never silently substitute another conversation.

## Fresh conversation, two cases

The MCP Apps host adapter declares `createThread: false`: `ui/message` can send into the active host conversation but cannot mint a new ChatGPT conversation by itself.

- **Case A — authorized automatic creation.** If the selected reviewer-host transport provides a supported, authorized way to create a conversation (for example an operator-enabled browser workflow), create through that host adapter with explicit operator authorization and independent verification. A new browser tab alone is not proof.
- **Case B — explicit activation (the normal path).** Persist the pending thread, have the operator open a new ChatGPT conversation, and activate it with the existing one-time principal-bound grant (`prepare_review_thread_activation` → `activate_review_thread`). Never reuse the old conversation. Never send review content to an arbitrary open tab. Never invent a ChatGPT API.

## Binding validation

Before delivering review content, require proof that: the host conversation differs from every conversation owned by another active loop; it belongs to the intended reviewer principal; the host adapter holds an authenticated live binding; the route epoch matches; the activation grant was consumed exactly once; and no existing thread already owns that conversation. Reject unknown, mismatched, or unverified bindings. A later reconnect restores only the exact bound conversation.

Caller conversation IDs are correlation data, never authority. Reviewer binding is principal plus the server-issued MCP transport session.

## Skill-locked iteration budget

`maxReviewRounds` comes from the governing review-loop skill's validated configuration and is locked to the loop generation at activation. The worker cannot change it; ordinary route updates cannot silently change it. An intentional operator change is an explicit audited reconfiguration that creates a new loop generation (and a new reviewer thread when the fresh-thread contract requires it). Historical budgets stay auditable. Never silently clamp an unsupported count — validate and return a useful error.

One review round is one newly admitted, immutable submission for review. Clarifications, progress messages, retries, duplicate deliveries, and feedback reads never consume a round.

## Loop lifecycle

Worker submits → immutable snapshot captured → round admitted → bound WebUI thread receives the review packet → reviewer commits authenticated feedback. `approve` ends the loop; `changes_requested` resumes the original worker for the next round in the same conversation; `reject` terminates; exhaustion stops automated correction and asks the operator; `cancel` fences new submissions and continuations and closes the route after safe termination. Round exhaustion is never approval, and continuation within a loop never starts a replacement conversation.

## Evidence, not prose

Browser prompt acceptance is transport evidence, never reviewer approval. Generated prose never approves code. Only `provide_review_feedback` / `approve_supervised_work` through authenticated MCP tools commit a verdict, bound to the exact submission hash, snapshot, and review epoch — new changes invalidate an earlier approval.

## Isolation

Two simultaneous loops (different reviewers, same workspace, or same reviewer with two conversations) share nothing: no transcript, credential, reviewer context, or continuation state leaks across them. Paused routes, expired logins, browser reloads, and CDP disconnects suspend only their own thread's queued events until exact re-verification.

## When to Use This Skill

- Starting a review loop that needs a fresh verified reviewer conversation
- Binding, activating, or re-verifying a reviewer thread
- Enforcing or auditing the skill-locked iteration budget
- Diagnosing cross-thread leakage, stale bindings, or ambiguous acceptance states
