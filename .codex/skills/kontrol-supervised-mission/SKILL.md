---
name: kontrol-supervised-mission
description: Mission-led Kontrol ACP supervision. Use when starting or continuing enhanced project work with begin_supervised_work, inspect_supervised_work, continue_supervised_work, approve_supervised_work, acceptance criteria, evidence, findings, work orders, or mission approval gates.
version: 0.1.0
---

# Kontrol Supervised Mission

Kontrol can run a coding agent through a mission contract instead of a loose task. The mission contract is the control plane: objective, desired outcome, constraints, non-goals, required acceptance criteria, evidence, findings, work orders, correction rounds, and approval blockers.

Use this skill when the user wants Kontrol to drive work to completion, not merely dispatch one task.

## Core Rule

A supervised mission is not complete because the worker says it is done. It is complete only when `approve_supervised_work` succeeds against the current submission, current snapshot, required criteria, evidence, and open findings.

## Tools

| Tool | Purpose |
|------|---------|
| `begin_supervised_work` | Create the mission contract, create a work session, dispatch the preferred ACP worker, and return the supervisor packet. |
| `inspect_supervised_work` | Read the current mission packet: session, mission, criteria, findings, work orders, evidence, approval predicate, and diff summaries. |
| `continue_supervised_work` | Persist reviewer findings/evidence/criterion updates, create the next bounded work order, and request changes. |
| `approve_supervised_work` | Approve only when the mission predicate allows it; otherwise returns concrete blocker reasons. |

## Start Pattern

When creating a mission, include at least one required acceptance criterion. Prefer criteria that can be verified by command output, runtime probe, code inspection, or manual reviewer attestation.

Example shape:

```json
{
  "workspaceSessionId": "...",
  "objective": "Implement the supervisor dashboard",
  "desiredOutcome": "A reviewer can see criteria, findings, evidence, current work order, and approval blockers without using raw MCP tools.",
  "constraints": ["Preserve existing MCP tool contracts", "Do not weaken reviewer authority"],
  "nonGoals": ["Do not redesign the entire UI shell"],
  "acceptanceCriteria": [
    {
      "description": "Mission dashboard renders objective, criteria, findings, evidence, and blockers",
      "priority": "required",
      "verification": "DOM/component test plus manual review"
    }
  ],
  "workOrder": {
    "objectiveForThisTurn": "Build the first usable mission dashboard surface",
    "requiredVerification": ["npm run typecheck", "npm test", "npm run build"]
  }
}
```

## Review Pattern

After a worker submission, call `inspect_supervised_work` before deciding. Check:

- Required criteria status
- Current evidence and whether it is bound to the latest submission and snapshot
- Open high/blocker findings
- Active work order deliverables
- Incremental diff and cumulative mission diff
- Approval predicate reasons

If the work is not acceptable, use `continue_supervised_work`, not generic `provide_review_feedback`, so the correction round is structured and auditable.

## Changes Requested

A good continuation includes:

```json
{
  "workSessionId": "...",
  "comments": "The dashboard shows criteria but not evidence binding or blockers.",
  "findings": [
    {
      "severity": "high",
      "scope": "in_scope",
      "description": "Approval blockers are not rendered before approval."
    }
  ],
  "workOrder": {
    "objectiveForThisTurn": "Render approval blockers and evidence binding for the latest submission.",
    "requiredActions": ["Add blocker panel", "Show submissionId and snapshotCommit for evidence", "Add regression coverage"],
    "prohibitedActions": ["Do not bypass approve_supervised_work"],
    "requiredVerification": ["npm run typecheck", "npm test"]
  }
}
```

## Approval Pattern

Use `approve_supervised_work` only after required criteria have current non-agent evidence and blocking findings are resolved or explicitly waived with reasons.

If approval is blocked, report the returned reasons and continue with a bounded work order. Do not call generic approval tools to bypass the mission predicate.

## Evidence Rules

- `agent_claim` evidence is useful context but does not satisfy required criteria by itself.
- Required criteria need current evidence tied to the latest submission and snapshot.
- Manual reviewer inspection is acceptable evidence when no command can prove the criterion.
- Waived findings require a reason.

## Relationship To Ralph/Nelson

Ralph/Nelson is the transport loop: submit, wait, continue, approve. The supervised mission is the product loop: define success, gather evidence, manage findings, and approve only when the durable predicate passes.
