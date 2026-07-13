---
name: nelson-wiggum-loop
description: WebUI-side review rendezvous for Kontrol ACP — the WebUI submits work to the CLI coding agent, the agent works and submits back, and the loop only completes when the WebUI signs off "A-okay". The mirror of ralphie-muntz-loop. Use when wiring the review WebUI, the submit_to_coding_agent tool, or the agent↔WebUI completion gate.
version: 0.1.0
---

# Nelson Wiggum Loop

> "A-okay!" — Nelson Wiggum, the only voice that ends the loop.

The WebUI-side counterpart to `ralphie-muntz-loop`. The CLI coding agent is the
**ACP agent** (the worker). The WebUI is the **ACP client / reviewer** (Nelson
Wiggum). The WebUI can push work *to* the agent; the agent pushes work *back* for
review; and — critically — **the loop is not complete until the WebUI signs off
"A-okay"** via `provide_review_feedback` with verdict `approve`.

**No polling. No busy loops. The WebUI's "A-okay" is the single completion criterion.**

## Topology (registry roles)

The agent registry makes the split explicit:

| Name | Role | Meaning |
|------|------|---------|
| `cli-coding-agent` | `agent` | The worker. Registers itself at runtime via `POST /acp/agents/register`. Executes tasks, submits work for review. |
| `webui` | `client` | The reviewer. Seeded by Kontrol as a well-known `role: "client"` entry. Submits tasks to the agent; is the only signer of "A-okay". |

Kontrol is the **broker** that hosts both the WebUI's client tool
(`submit_to_coding_agent`) and the WebUI-facing ACP agent
(`kontrol-submit-work-to-webui`).

## The Pattern

```
WebUI (Nelson)                    Kontrol Server                 CLI Coding Agent (Ralphie)
    │                                    │                                │
    ├─ submit_to_coding_agent ──────────►│                                │
    │   (task from the human)            ├─ forward over ACP ─────────────►│
    │                                    │                                ├─ start_work_session
    │                                    │                                ├─ [do work: edit, shell, test]
    │                                    │◄─ submit_for_review ───────────┤
    │                                    │   (or kontrol-submit-work-to-webui via ACP) │
    │                                    ├─ status: awaiting_review        │
    │◄── diff card + feedback form ──────┤                                │
    │                                    │                                ├─ await_review_feedback (BLOCKS)
    │                                    │                                │
    │   human reviews, clicks A-okay ───►├─ provide_review_feedback        │
    │   (verdict: approve)               ├─ feedback committed             │
    │                                    ├─ waiter resolved ──────────────►│
    │                                    │                                ├─ finish, summarize
    │                                    │                                │
    ├── COMPLETION: only when WebUI says "A-okay" ────────────────────────┤
```

## Tools

### WebUI → Agent (Nelson initiates)

| Tool | Purpose |
|------|---------|
| `submit_to_coding_agent` | WebUI submits a task/instruction to the `cli-coding-agent` over ACP. The agent executes and returns its result. (Nelson Wiggum: WebUI → agent.) |

### Agent → WebUI (Ralphie submits back)

| Tool | Purpose |
|------|---------|
| `submit_for_review` | (MCP) Capture git diff, submit for human review. |
| `kontrol-submit-work-to-webui` | (ACP) The coding agent submits completed work to the WebUI for review. Ralphie Muntz terminus. |

### The Completion Gate (WebUI sign-off)

| Tool | Purpose |
|------|---------|
| `provide_review_feedback` | WebUI commits the verdict. **`approve` = "A-okay" = the only valid completion.** `changes_requested` loops back; `reject` terminates. |
| `await_review_feedback` | (Agent side) Blocks until the WebUI's feedback arrives. |

## WebUI Instructions

When the WebUI is the active surface in a work session:

1. The human can type a task into the "Send a task to the coding agent" bar → calls `submit_to_coding_agent`.
2. When a `submit_for_review` / `kontrol-submit-work-to-webui` card arrives, render the diff and the feedback form.
3. The human reviews. The available verdicts are `approve`, `changes_requested`, `reject`.
4. **`approve` is the "A-okay"** — it is the sole signal that the loop is complete. Only emit it when the work is genuinely acceptable.
5. `changes_requested` returns control to the agent with comments; the loop continues.
6. `reject` ends the session; the agent must stop modifying files.

## Completion Criterion

```
NOT complete
  UNTIL  provide_review_feedback(verdict: "approve")

complete  := verdict == "approve"
loop      := verdict == "changes_requested"
terminate := verdict == "reject"
```

The CLI agent MUST NOT declare a session complete while it is `awaiting_review`.
The WebUI MUST NOT emit "A-okay" unless the diff is genuinely acceptable. The
"A-okay" is a human judgment, not a default.

## Session State Machine

```
drafting
  → awaiting_review
  → review_in_progress
  → changes_requested
  → drafting            (loop back)
  → awaiting_review
  → approved (A-okay)   (terminal — COMPLETE)
  → rejected            (terminal)
```

## Architecture

```
┌─────────────────────────────────────────────────┐
│                  MCP Bridge                      │
│                                                  │
│  submit_to_coding_agent()                        │
│    → agentRegistry.ensure("cli-coding-agent")    │
│    → callRemoteAgent(agentUrl, task)             │
│    → returns agent output to WebUI               │
│                                                  │
│  kontrol-submit-work-to-webui (ACP)              │
│    → reviewCheckpoints.reviewChanges()           │
│    → workSessions.submitForReview()              │
│    → eventStore.appendEvent("review.submitted") │
│    → WebUI renders diff + feedback form         │
│                                                  │
│  provide_review_feedback()                       │
│    → workSessions.submitFeedback()               │
│    → ReviewWaiter.publish(event)                 │
│    → resolves blocked await_review_feedback      │
└─────────────────────────────────────────────────┘
```

The registry (`agent_registry` table, `role` column) records both participants:
`cli-coding-agent` (role `agent`) and `webui` (role `client`).

## When to Use This Skill

- Wiring the review WebUI's "send task to agent" affordance
- Implementing the WebUI ↔ coding-agent completion gate
- Explaining why a session is "stuck" in `awaiting_review`
- Designing agent-to-human review rendezvous patterns
- When someone suggests the agent can self-declare "done" without WebUI sign-off (it can't)

## Mission-Led Work

For enhanced project supervision with acceptance criteria, evidence, findings, and approval blockers, use the kontrol-supervised-mission skill. Ralph/Nelson remains the transport loop; the mission skill defines the completion predicate.
