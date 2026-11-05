---
name: ralphie-muntz-loop
description: Event-driven review rendezvous for Kontrol ACP — the CLI agent submits work to WebUI, blocks until feedback arrives, then continues. Replaces polling with a deterministic wake-up. Use when working with Kontrol work sessions, WebUI review loops, or ACP review feedback.
version: 0.1.0
---

# Ralphie Muntz Loop

> "I'm learnin'!" — Ralphie Muntz, until Nelson says not to anymore.

Event-driven review rendezvous pattern for Kontrol's ACP. The worker (CLI coding agent, Hermes/Muse/MuseFI ACP worker, or PTY-backed worker) submits work to WebUI, the MCP tool call blocks server-side until the human reviews and commits feedback, then the worker continues with the verdict.

**No polling. No busy loops. No 30-second timers.**

## The Pattern

```
CLI Agent                          Kontrol Server                    WebUI (Human)
    │                                    │                                │
    ├─ start_work_session ──────────────►│                                │
    ├─ [do work: edit, write, shell]     │                                │
    ├─ submit_for_review ───────────────►│                                │
    │   (workspace checkpoint captured) ├─ status: awaiting_review        │
    │                                    │                                │
    ├─ await_review_feedback ───────────►│  ← MCP call BLOCKS here        │
    │   (agent is parked)               │    (Promise, not polling)       │
    │                                    │                                │
    │                                    │         ◄── human reviews ─────┤
    │                                    │         ◄── clicks verdict ────┤
    │                                    │                                │
    │                                    ├─ feedback committed to DB      │
    │                                    ├─ ReviewWaiter.publish()        │
    │                                    ├─ waiter resolved               │
    │◄── feedback returned ──────────────│  ← MCP call UNBLOCKS           │
    │                                    │                                │
    ├─ if changes_requested:            │                                │
    │   read comments, apply fixes      │                                │
    │   submit_for_review ──────────────►│                                │
    │   await_review_feedback ──────────►│                                │
    │                                    │                                │
    ├─ if approved:                     │                                │
    │   finish, summarize               │                                │
    │                                    │                                │
    ├─ if rejected:                     │                                │
    │   stop                            │                                │
```

## Tools

### Primary (the loop)

| Tool | Purpose |
|------|---------|
| `start_work_session` | Create a session, begin tracking tool calls |
| `submit_for_review` | Capture the backend-neutral workspace checkpoint and submit it for human review |
| `await_review_feedback` | **Block until feedback arrives** (with timeout) |
| `get_work_session` | Read current session state and history |

### Recovery (after timeout or reconnect)

| Tool | Purpose |
|------|---------|
| `list_pending_reviews` | Find sessions awaiting review |
| `check_review_status` | Poll current status (fallback only) |
| `get_work_result` | Principal-scoped read-only result projection; re-read after reconnect instead of redispatching |
| `await_work_session_events` | Event-driven wait for session events (session-read scoped) |
| `cancel_work_session` | Abandon a session |

## Agent Instructions

When operating inside a work session that was delegated to you (or that you own as a standalone worker):

1. Call `start_work_session` before making substantial changes. Do not create a second work session for a task that already has one: if you were dispatched into an existing session, keep using it.
2. Perform the requested work using normal edit, shell, and test tools.
3. Call `submit_for_review` when the work is ready for WebUI review.
4. After submitting, call `await_review_feedback`. **Do not poll.**
5. If the verdict is `changes_requested`, read the review comments, apply fixes, and call `submit_for_review` again.
6. If the verdict is `approved`, finish and summarize what changed.
7. If the verdict is `rejected`, stop and do not continue modifying files.
8. If `await_review_feedback` times out, call `list_pending_reviews` or `get_work_session` to recover current state.
9. Never declare the session complete while the session status is `awaiting_review`.

## Session State Machine

```
drafting
  → awaiting_review
  → review_in_progress
  → changes_requested
  → drafting  (loop back)
  → awaiting_review
  → approved  (terminal)

or

awaiting_review
  → rejected  (terminal)

or

awaiting_review
  → stale  (timeout, resumable)
  → drafting  (resume)

or

any
  → cancelled  (terminal)
  → failed  (terminal)
```

## Verdict Structure

The WebUI returns structured feedback, not just prose:

```json
{
  "verdict": "changes_requested",
  "comments": "Add regression coverage for stale awaiting_review sessions.",
  "requiredActions": [
    "Add stale-session timeout test",
    "Verify await_review_feedback wakes after provide_review_feedback"
  ],
  "allowedNextActions": ["edit_files", "run_tests", "resubmit"]
}
```

The CLI agent should respect `requiredActions` as a checklist and `allowedNextActions` as guardrails.

## Timeout Behavior

`await_review_feedback` accepts a `timeoutMs` parameter (default 5 minutes, max 15 minutes).

On timeout:
- The MCP call returns `{ status: "timeout", sessionId }`
- A timeout means the review is still pending, not failed: do not treat it as rejection or completion
- The agent should call `list_pending_reviews` or `get_work_session` to check if feedback arrived while it was blocked
- If still no feedback, the agent can retry `await_review_feedback` or notify the user

## Architecture

```
┌─────────────────────────────────────────────────┐
│                  MCP Bridge                      │
│                                                  │
│  await_review_feedback()                         │
│    → ReviewWaiter.waitForFeedback(sessionId)     │
│    → returns Promise<ReviewEvent | null>         │
│                                                  │
│  provide_review_feedback()                       │
│    → workSessions.submitFeedback()               │
│    → ReviewWaiter.publish(event)                 │
│    → resolves blocked waiters                    │
│    → optional: webhook to external runners       │
└─────────────────────────────────────────────────┘

ReviewWaiter = in-memory Map<sessionId, Set<WaiterEntry>>
Each WaiterEntry = { callback, timeout, cleanup }
```

## Authority boundaries (do not cross these)

- The worker side never calls reviewer-only tools: `submit_to_coding_agent`, `call_acp_agent`, `discover_agents`, `provide_review_feedback`, and the supervised-work tools (`begin/continue/approve_supervised_work`) return `Forbidden` for a worker. The worker approves nothing, including its own work.
- A connection authenticated with a PTY review credential exposes exactly the bounded relay set: `submit_for_review`, `await_review_feedback`, `post_agent_message`, `await_agent_reply`. Do not promise any other tool over that credential.
- `check_review_status` is a recovery read only (after a timeout or reconnect), never an N-second polling loop. `await_review_feedback` is the event-driven wait.
- Browser or native-CDP output is transport evidence only, never a verdict. Only `provide_review_feedback` / `approve_supervised_work` through authenticated MCP tools commit decisions.

## When to Use This Skill

- Building or reviewing Kontrol ACP review workflows
- Implementing worker ↔ WebUI review loops
- Debugging review feedback not reaching the worker
- Designing agent-to-human review rendezvous patterns
- When someone suggests polling `check_review_status` every N seconds (don't)

## Mission-Led Work

For enhanced project supervision with acceptance criteria, evidence, findings, work orders, and approval blockers, use the kontrol-supervised-mission skill in addition to this loop. This skill handles the review rendezvous; the mission skill handles the completion predicate.
