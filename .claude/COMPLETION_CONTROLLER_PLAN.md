# Completion Controller — Design Plan (LOCKED)

## Goal

A multi-agent **completion controller** that runs last in the `mwf` workflow,
validates the Git diff against quality/compliance/best-practice standards,
diagnoses issues, applies fixes, and binds evidence to `/goal` — producing
robust, fully-implemented working code as cheaply and quickly as possible.

## Confirmed model architecture (5 distinct models)

`fable` IS a valid Claude Code `model:` alias (confirmed in current docs +
live feature flags: `tengu-fable-off-switch: activated:false`,
`claude-fable: true`, `Fable 5` in overage-included list). The upstream
agent-stack README that omitted it is stale.

| Role            | Model            | Slot mechanism        | Job                                  |
|-----------------|------------------|-----------------------|--------------------------------------|
| Implementation  | DeepSeek V4 Flash| `model: inherit` (main)| Writes code                         |
| Grounding/Verify| Qwen 3.6 35B     | `model: haiku`        | Tools, ground diff→task, pre-filter  |
| Semantic review | Kimi 2.7-code    | `model: sonnet`       | Staggered completion reviewer        |
| Architecture/Gate| MiniMax M3      | `model: opus`         | Design + final quality gate          |
| Escalation      | GLM-5.2          | `model: fable`        | Critical-gate nuclear option         |

Diversity at every handoff: each transition is a different backend doing a
different job. No model reviews its own work.

## Robustness defense (cheap-first ordering)

"Tests pass" and "code is correct" are different axes. Defend all of them,
cheapest signal that can resolve each first:

| Failure mode                 | Counter (cost)                          |
|------------------------------|-----------------------------------------|
| Model lies about test run    | exit-code-derived pass/fail (free)      |
| No tests for changed code    | coverage/existence check (free)         |
| Tests game the metric (.skip)| static anti-gaming scan (free, grep)    |
| Happy-path-only tests        | criteria coverage map (cheap, Qwen)     |
| Collusion (same model wrote) | independent derivation (expensive, diff model, Tier 3 only) |

**Hard rule:** pass/fail is derived from process exit code, NEVER from model
prose (`verification.includes("pass")` is replaced). Mirrors
`mission-verifier.ts` + opencode plugin.

## Completion phase order (cheap → expensive)

```
1. [free]   deterministic: tsc, lint, test, git diff --check
            capture test pass-count baseline + ONE failure signature
            (sha256(normalize(compile_errors + test_failure_names)))
2. [cheap]  Qwen pre-filter (haiku): carries TASK + criteria + diff
            (a) does diff address the criteria? (b) anything ≥ medium wrong?
            → clean & grounded → SKIP phase, report clean
3. [expensive] MiniMax ocp-completion-controller: diagnose latent issues,
            apply fixes ≥ medium (Edit/Write)
4. [free]   re-run deterministic; compare test count (no-regression);
            recompute failure signature
            → same signature as step 1 = STUCK → escalate
5. [conditional] Kimi staggered reviewer (sonnet), ONLY if step 3 changed
            the diff OR tier 3. Independent review + corrections.
6. [free]   final verify + criteria coverage map vs /goal criteria
            → coverage complete + no-regression → bind evidence to /goal
            → else → escalate
```

## Escalation policy (scoped to Completion phase)

One failure signature per cycle (NOT per-finding — O(1), no added latency).
Parallel to existing tier escalation; never interferes with it.

```
[Controller: MiniMax/ocp-controller]  diagnose + fix + verify
   → passes → DONE
   → fails  ─────────────────────────────────┐
                                              ▼
[Reviewer: Kimi]  independent 2nd pass
   → resolves → DONE
   → still fails OR same signature 2 cycles → ┐
                                               ▼
[Fable: GLM-5.2]  OVERRIDE / REDIRECT / ABORT
   → cannot decide → HUMAN  (surface as /goal blocked)
```

| Trigger                                       | Action                |
|-----------------------------------------------|-----------------------|
| Controller fix introduces compile error       | re-enter controller   |
| Controller + Reviewer agree, fix can't resolve| → Fable               |
| Same failure signature across 2 cycles        | → Fable (stuck)       |
| 2 controller↔reviewer cycles, no convergence  | → Fable (cycle limit) |
| Fable cannot decide                           | → HUMAN               |

`CONTROLLER_MAX_CYCLES = 2` (tighter than mission `maxCycles:10` — completion
is a polish phase, not long-running).

## /goal integration

- Workflow invokes `/goal` start when a goal is active (task begin).
- Controller's report + coverage map bind to goal via `update_goal`.
- `/goal complete`, `/goal blocked`, `/goal clear` = **user-direct only**;
  never auto-called. Mirrors opencode plugin contract.
- Controller owns scope/evidence/verification; lifecycle is user authority.

## Files to create

| File | Purpose |
|------|---------|
| `.claude/agents/completion-controller.md` | MiniMax/ocp-controller; diagnose+fix+verify; model: opus |
| `.claude/agents/completion-reviewer.md` | Kimi staggered reviewer; model: sonnet |

## Files to modify

| File | Change |
|------|--------|
| `.claude/workflows/multi-model.js` | (1) retain deterministic tier classification; (2) add `phase('Completion')` block after Gate on Tier 2 success + Tier 2 repair + Tier 3, with cheap-first ordering + scoped escalation; (3) replace prose pass/fail with exit-code-derived verdict |
| `.claude/MULTI_MODEL_WORKFLOW.md` | Add 6-model mapping table; document Completion phase, escalation chain, /goal tie-in, exit-code verification |
| `.claude/settings.local.json` | Add Bash perms for controller: `git diff *`, `npx tsc *`, `npx vitest *`, lint, coverage |

## What does NOT change

- Existing tier escalation (Tier 1↔2↔3↔Fable) untouched.
- Existing agent definitions (haiku/sonnet/opus/main/fable) untouched.
- `model: fable` confirmed valid — fable-critical-gate.md stays as-is.
- Tier 1 (`:quick`) and trivial paths skip the completion phase.

## Wiring decisions (user-confirmed)

| Decision | Value |
|----------|-------|
| Insertion point | After quality gate (new phase) |
| Agent pattern | Hybrid: Model 1 (single call, diagnose+fix) + Model 2 (staggered async reviewer) |
| Repair path | Both Tier 2 success AND repair paths |
| /goal integration | Controller binds evidence; lifecycle user-direct |
| Tier coverage | Tier 2 + Tier 3 only |
| GLM wiring | `model: fable` (valid alias) — escalation |
| Diff source | `git diff HEAD` (or explicit baseline) |
| Fix threshold | severity ≥ medium; < medium = info only |
| Fingerprint | 1 failure signature per cycle (O(1)) |
| Verification | exit-code-derived, never prose |
