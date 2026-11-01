---
name: kontrol-acp-harness
description: Healthy role=agent dispatch for Hermes, Muse Code, and MuseFI through Kontrol ACP. Use when delegating bounded work to a registered coding-agent harness, checking harness health, or diagnosing dispatch failures.
version: 0.1.0
---

# Kontrol ACP Harness

Dispatch bounded work to independent ACP worker harnesses. `webui` is a reviewer and is never dispatchable. Hermes, Muse Code, and MuseFI are independent workers with independent identities — never aliases for one session, process, port, credential, or adapter.

## Dispatch precondition (every time)

1. Call `discover_agents` first.
2. Dispatch only to a currently `dispatchable`, healthy `role: "agent"` peer.
3. Dispatch explicitly by `agentName`. A task requested for MuseFI must never silently run on Muse Code or Hermes, and vice versa.
4. If no healthy worker is available, return to direct workspace work. Do not try an alternate ACP path, and do not treat absence as proof of anything.

## The three profiles

| Profile | Transport | Notes |
|---------|-----------|-------|
| Hermes | Native ACP adapter (`acp-hermes-native-adapter`) | Ordinary delegation uses worker/run identity plus a valid workspace mutation lease. Signed execution grants apply only to the restricted modes: read-only audit and bounded-file-write execution. |
| Muse Code | Generic stdio duplex adapter, `muse acp`, ACP v1 | Requires the experimental gate in the launched agent environment. Default to ACP v1; never send ACP v2 methods unless negotiated. |
| MuseFI | Separately configured adapter instance | A wrapper around the same Muse binary with isolated config/session persistence. Verify the actual executable and route belong to the MuseFI profile, not standard Muse Code. |

Registration is not success until the adapter is reachable, authenticated, and able to negotiate the required ACP interface. A profile may be registered but unavailable — report that distinction visibly instead of dispatching into it.

## Session continuity

ACP provider sessions bind durably to the work session, selected agent, workspace, and provider generation. Continuations reload that exact session and fail closed when it is missing, mismatched, or unsupported. An ACP v1 agent without session-restore support is explicitly non-resumable — never silently start a fresh session and call it a continuation.

Only `end_turn` counts as successful completion. Cancellation, refusal, limits, missing stop reasons, and unknown outcomes do not.

## Failure diagnosis and bounded retry

- Identical retries return the existing dispatch receipt; a retry with changed payload is a conflict. Never redispatch uncertain accepted work.
- Distinguish dispatch acceptance, worker start/stop outcome, and reviewer approval — they are separate lifecycle events. A rejected pre-spawn attempt or a failed worker never reports `workerCompleted: true`.
- Use bounded retry with backoff and jitter for transient transport failures. Terminal authorization failures are not retried; no unlimited reconnect loops.
- Record the last failure category (timeout, spawn failure, protocol refusal, provider authentication, missing stop reason) with the run identity.

## Live proof vs mock evidence

A healthy HTTP endpoint, a successful `--check`, or a synthetic adapter smoke proves transport only — never real inference. Marking a profile functional requires at least one real provider-backed delegated task, completed and independently observed end to end.

## Authority boundaries (do not cross these)

- Dispatch tools (`submit_to_coding_agent`, `call_acp_agent`, `discover_agents`) are reviewer-only. A worker calling them gets `Forbidden`.
- Workers cannot approve their own submissions, claim reviewer authority, or alter their dispatch routing.
- Never weaken sandbox, grant, or lease checks to make dispatch succeed.

## When to Use This Skill

- Delegating a bounded task to Hermes, Muse Code, or MuseFI
- Checking whether a harness is registered, healthy, and dispatchable
- Diagnosing a failed, refused, or uncertain dispatch
- Distinguishing live provider qualification from synthetic smoke
