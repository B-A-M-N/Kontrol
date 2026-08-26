# Multi-Model Coding Agent Workflow

## Slot-to-Model Mapping

| Slot    | Actual Model     | Role                              |
| ------- | ---------------- | --------------------------------- |
| Haiku   | Qwen             | Cheap gatekeeper, grounding, verify |
| Sonnet  | Kimi 2.7-code    | Mid-tier review, code review       |
| Main    | DeepSeek         | Default implementer, decomposition  |
| Opus    | MiniMax M3       | Architecture, design, deep reasoning |
| Fable   | GLM 5.2          | Nuclear option, critical escalation |

Tier 2 and Tier 3 finish with a bounded Completion phase. The
`completion-controller` runs deterministic checks from numeric exit codes,
compares the diff with task criteria, fixes medium-or-higher findings, and
emits criteria coverage. If it changed the diff (or the task is Tier 3), the
independent `completion-reviewer` performs a staggered second pass. Model prose
such as “tests pass” is never evidence, and goal lifecycle remains user-owned.
Final reports carry an explicit `reportDepth` (`concise`, `standard`,
`detailed`, or `exhaustive`) without weakening the evidence contract.

## ON/OFF

- **ON (default):** Auto-escalating workflow. Routes through slots by tier. Start cheap, escalate when stuck.
- **OFF (`:bypass`):** Everything runs on [Main] (DeepSeek). No routing, no orchestration.

## The 3 Tiers

### Tier 1 (Quick)
*For: simple bugs, typos, single-file fixes*

```
[Haiku]  diagnose
[Haiku]  implement fix
[Haiku]  verify (compile + ground)
  → pass: DONE
  → fail: escalate to Tier 2
```

**Calls:** 2-3 Haiku
**Latency:** ~15-30s

---

### Tier 2 (Standard — DEFAULT)
*For: features, moderate refactors, most tasks*

```
[Opus]   architecture/design sketch
[Main]   implement from design
[Haiku]  progressive checks:
         1. syntax (tool, 0 calls)
         2. compile (tool, 0 calls)
         3. test (tool, 0 calls)
         4. grounding check
  → pass: DONE
  → fail: [Sonnet] reviews findings
          [Main] re-implements
          [Haiku] re-verifies
          → still fail: escalate to Tier 3
```

**Calls:** 1 Haiku + 1 Opus + 1-2 Main + 1 Haiku = 4-5
**Latency:** ~1-3min

---

### Tier 3 (Deep)
*For: architecture changes, risky refactors, complex features*

```
[Opus]   full architecture/design
[Main]   implement
[Haiku]  progressive checks:
         1. syntax (tool)
         2. compile (tool)
         3. test (tool)
         4. grounding check
[Sonnet] multi-lens review
[Opus]   repair guidance or re-architecture
[Main]   re-implement
[Haiku]  re-verify
[Opus]   final quality gate
[Fable]  **only if Opus stuck** — critical escalation
```

**Calls:** 2 Opus + 2 Main + 2 Haiku + 1 Sonnet + (1 Fable if escalated) = 7-8
**Latency:** ~3-8min

## User Override Flags

Add any to the task prompt:

| Flag     | Effect                              |
| -------- | ----------------------------------- |
| `:quick`    | Force Tier 1, never escalate        |
| `:standard` | Force Tier 2, cap at Tier 2         |
| `:deep`     | Skip classification, go to Tier 3   |
| `:bypass`   | Run on [Main] only, no workflow     |

Absent any flag → auto-escalate, default Tier 2.

## Escalation Chain

```
Tier 1 (Haiku)  → pass → DONE
                → fail → Tier 2

Tier 2 (Opus → Main → Haiku)
                → pass → DONE
                → minor fail → Main fixes → Haiku re-checks → DONE
                → major fail → Tier 3

Tier 3 (Opus → Main → Haiku → Sonnet → Opus → Fable?)
                → pass → DONE
                → MiniMax repair → GLM if stuck → human if GLM can't
```

## Philosophy

- **Design gets the best model (Opus) even at Tier 2.** Mistakes are cheapest to fix at design time.
- **Cheap gates run first.** Haiku grounds before Sonnet reviews. Tools run before any model call.
- **Auto-escalate, never ask.** Start cheap, get more thorough only when the cheap path fails.
- **Quality over cost for design decisions.** Spend Opus tokens there, save 10x rework later.
