---
name: kontrol-pty-messaging
description: Authenticated agent-to-WebUI messages, clarification and blocker replies, PTY credential scoping, delivery acknowledgement, and crash recovery for Kontrol PTY workers.
version: 0.1.0
---

# Kontrol PTY Messaging

The PTY relay is a worker-to-reviewer communication channel. It never grants the worker review authority, and messages are never approvals.

## The two review-delivery paths (do not conflate them)

- **Path A — native ACP worker.** The adapter event or terminal result flows through the run/event store into a review submission or durable agent message. Native workers do not hold Kontrol MCP tools and may not run inside a Kontrol-managed PTY.
- **Path B — PTY-originated worker.** The authenticated worker in `exec_command(tty=true, agentPty=true)` uses its generation-bound credential with the review/message CLI, reaching the same durable reviewer authority. Never pretend a Path A message originated from a PTY, or vice versa.

## Tool roles

| Tool | Callable by | Purpose |
|------|-------------|---------|
| `post_agent_message` | worker only | Worker sends a message (clarification, blocker) toward the reviewer thread |
| `await_agent_reply` | worker or client | Worker blocks for the reviewer's reply; timeout means still-pending, not failure |
| `get_pending_agent_replies` | worker or client | Recovery read after timeout or reconnect |
| `ack_agent_reply` | worker or client | Acknowledge a reply, bound to its `deliveryAttemptId` |
| `resolve_agent_message` | reviewer only | Reviewer answers a worker message |

`submit_for_review` and `await_review_feedback` are the review-submission pair, not the messaging pair. A clarification, progress note, retry, or duplicate transport delivery never counts as a review round.

## PTY credential scope

A connection authenticated with a PTY review credential exposes exactly the bounded relay set: `submit_for_review`, `await_review_feedback`, `post_agent_message`, `await_agent_reply`. No reviewer-only tool and no other general-catalog tool is available over that credential.

Every relay action verifies the complete identity tuple: work session, workspace session, run, agent, owner principal, process session, process generation, and workspace lease nonce. A shared workspace path is never sufficient authorization. A PTY may not write to another session, post to another thread, consume another worker's replies, or renew a credential after its process generation ends.

## Delivery and recovery rules

- Delivery is proven by acknowledgement (`ack_agent_reply` with the matching attempt ID), never by appending text to the terminal log.
- No duplicate messages after retried requests: retries carry stable message IDs and idempotency keys; reply correlation is by ID, and ordering is preserved per thread.
- Cancellation while awaiting a reply, safe timeout with recovery, and Kontrol restart during pending delivery must all leave exactly-once semantics intact.
- Never expose credentials in argv, environment dumps, logs, review messages, or browser transcripts. Credential files stay private with the existing renewal mechanism.

## Crash and lifecycle behavior

Prove, do not assume: delivery after temporary WebUI disconnection, recovery after worker reconnect, correct handling of truncated output, explicit cursor gaps when retained output is evicted, and distinct state transitions for output observation vs message delivery vs review submission.

## Authority boundaries (do not cross these)

- Messages request attention; they do not approve, reject, or authorize anything. Only `provide_review_feedback` / `approve_supervised_work` through authenticated MCP tools commit decisions.
- The worker side never calls reviewer-only tools. Cross-work-session reads, cross-PTY reply consumption, and replayed expired credentials all fail closed.

## When to Use This Skill

- Sending or answering a worker clarification or blocker through the PTY relay
- Recovering a timed-out or reconnected `await_agent_reply`
- Auditing PTY credential scope or message-delivery exactly-once behavior
- Distinguishing a message from a review submission or verdict
