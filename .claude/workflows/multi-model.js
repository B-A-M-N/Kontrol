export const meta = {
  name: 'mwf',
  description: 'Multi-model coding workflow with auto-escalation. Routes through haiku-reviewer, opus-architect, main-implementer, sonnet-reviewer, and fable-critical-gate based on task complexity.',
  phases: [
    { title: 'Classify', detail: 'Determine tier and route to appropriate model chain' },
    { title: 'Implement', detail: 'Architecture + code generation' },
    { title: 'Verify', detail: 'Progressive verification chain' },
    { title: 'Review', detail: 'Code review and repair' },
    { title: 'Gate', detail: 'Final quality gate (Opus / Fable)' },
  ],
}

// ── Helpers ──────────────────────────────────────────────────────────

const TIER_KEYWORDS = {
  tier3: ['migrate', 'redesign', 'architecture', 'security', 'breaking change', 'data migration'],
  tier2: ['feature', 'implement', 'refactor', 'add support', ':standard'],
  tier1: ['typo', 'rename', 'format', 'simple fix', 'bug', ':quick'],
}

const TIER_OVERRIDES = {
  ':quick': 1,
  ':standard': 2,
  ':deep': 3,
  ':bypass': 0,
}

const CHECK_REPORT_SCHEMA = {
  type: 'object',
  required: ['checks'],
  properties: {
    checks: { type: 'array', items: { type: 'object', required: ['command', 'exitCode'], properties: { command: { type: 'string' }, exitCode: { type: 'integer' }, failureSignature: { type: 'string' } } } },
    findings: { type: 'array' },
    status: { type: 'string' },
  },
}

function detectOverride(task) {
  for (const [flag, tier] of Object.entries(TIER_OVERRIDES)) {
    if (task.toLowerCase().includes(flag)) return tier
  }
  return null
}

// ── Main ─────────────────────────────────────────────────────────────

const override = detectOverride(args?.task || '')

if (override === 0) {
  log('Bypass mode — running directly on main model, no routing')
  return { mode: 'bypass', message: 'Task runs directly on main conversation model' }
}

if (override) {
  log(`Override flag detected — forcing Tier ${override}`)
}

// Phase: Classify
phase('Classify')

// Local classification keeps routing deterministic and within this workflow.
function routeTier(task) {
  if (override !== null) return override
  const normalized = task.toLowerCase()
  if (TIER_KEYWORDS.tier3.some((keyword) => normalized.includes(keyword))) return 3
  if (TIER_KEYWORDS.tier1.some((keyword) => normalized.includes(keyword))) return 1
  return 2
}

function deterministicChecksPass(report) {
  return Boolean(report && Array.isArray(report.checks) && report.checks.length > 0 && report.checks.every((check) => Number(check.exitCode) === 0))
}

function completionEvidencePass(report) {
  if (!deterministicChecksPass(report)) return false
  const status = String(report.status || '').toLowerCase()
  if (['blocked', 'failed', 'incomplete', 'needs_review', 'needs-repair'].includes(status)) return false
  const findings = Array.isArray(report.findings) ? report.findings : []
  return !findings.some((finding) => {
    if (!finding || typeof finding !== 'object') return false
    const severity = String(finding.severity || finding.priority || '').toLowerCase()
    return ['blocker', 'critical', 'high'].includes(severity) && finding.resolved !== true
  })
}

const REPORT_DEPTHS = ['concise', 'standard', 'detailed', 'exhaustive']

function reportDepthFor(tier) {
  const requested = typeof args?.reportDepth === 'string' ? args.reportDepth.toLowerCase() : ''
  return REPORT_DEPTHS.includes(requested) ? requested : (tier === 3 ? 'detailed' : 'standard')
}

function completionFailureSignature(report) {
  if (!report || !Array.isArray(report.checks)) return 'missing-check-report'
  const failures = report.checks
    .filter((check) => Number(check?.exitCode) !== 0)
    .map((check) => `${check.command || 'unknown'}:${check.failureSignature || check.exitCode}`)
  return failures.join('|') || 'clean'
}

async function runCompletionPhase(task, tier, prior) {
  phase('Completion')
  const reportDepth = reportDepthFor(tier)
  const depthInstruction = reportDepth === 'concise'
    ? 'Keep the final report concise while retaining every check, finding, and criterion result.'
    : reportDepth === 'exhaustive'
      ? 'Include complete criteria coverage, changed-file rationale, verification evidence, residual risks, and follow-up actions.'
      : reportDepth === 'detailed'
        ? 'Include detailed criteria coverage, changed-file rationale, verification evidence, and residual risks.'
        : 'Include a clear summary of criteria coverage, verification evidence, and any residual risk.'
  const deterministic = prior?.verification || prior?.reVerification || prior?.finalVerify
  const prefilter = await agent(
    `Run the cheap grounding pre-filter for Tier ${tier}. Task: ${task}\nPrior evidence: ${JSON.stringify(deterministic)}\n\nDo not rerun broad tests. Inspect the diff and criteria only. Decide whether a completion controller is needed. Return JSON with checks copied from prior evidence using numeric exitCode values, findings, criteriaCoverage, needsController, and status. Set needsController=false only when the prior checks pass and the diff is grounded with no unresolved medium-or-higher finding.`,
    { label: 'completion-grounding-prefilter', agentType: 'haiku-reviewer', schema: { type: 'object', required: ['checks', 'findings', 'criteriaCoverage', 'needsController', 'status'], properties: { checks: { type: 'array' }, findings: { type: 'array' }, criteriaCoverage: { type: 'array' }, needsController: { type: 'boolean' }, status: { type: 'string' } } } }
  )
  if (deterministicChecksPass(deterministic) && completionEvidencePass(prefilter) && prefilter.needsController === false) {
    return { status: 'approved', reportDepth, prefilter, evidence: deterministic }
  }

  const controllerReports = []
  let controller
  let postVerification
  let previousFailure = ''
  for (let cycle = 1; cycle <= 2; cycle++) {
    controller = await agent(
      `Run completion-controller cycle ${cycle}/2 for Tier ${tier}. Task: ${task}\nPrior workflow result: ${JSON.stringify(prior)}\nGrounding pre-filter: ${JSON.stringify(prefilter)}\nPrevious failure signature: ${previousFailure || 'none'}\n\nReport depth: ${reportDepth}. ${depthInstruction}\nDiagnose and fix medium-or-higher findings. Return structured JSON with reportDepth, checks containing numeric exitCode values, findings, changedFiles, criteriaCoverage, and status.`,
      { label: `completion-controller-${cycle}`, agentType: 'completion-controller', schema: { type: 'object', required: ['reportDepth', 'checks', 'findings', 'criteriaCoverage', 'status'], properties: { reportDepth: { type: 'string', enum: REPORT_DEPTHS }, checks: { type: 'array', items: { type: 'object', required: ['command', 'exitCode'], properties: { command: { type: 'string' }, exitCode: { type: 'integer' }, failureSignature: { type: 'string' } } } }, findings: { type: 'array' }, changedFiles: { type: 'array' }, criteriaCoverage: { type: 'array' }, status: { type: 'string' } } } }
    )
    controllerReports.push(controller)
    postVerification = await agent(
      `Run deterministic completion verification after controller cycle ${cycle} for task ${task}. Use the actual command exit codes, not prose. Return JSON with checks containing numeric exitCode values, findings, criteriaCoverage, and status.`,
      { label: `completion-verification-${cycle}`, agentType: 'haiku-reviewer', schema: CHECK_REPORT_SCHEMA }
    )
    if (completionEvidencePass(controller) && completionEvidencePass(postVerification)) break
    const signature = completionFailureSignature(postVerification)
    if (signature === previousFailure) break
    previousFailure = signature
  }

  if (!completionEvidencePass(controller) || !completionEvidencePass(postVerification)) {
    const fable = await agent(
      `You are the critical completion escalator. The bounded controller loop did not converge for task ${task}.\nController reports: ${JSON.stringify(controllerReports)}\nFinal deterministic verification: ${JSON.stringify(postVerification)}\n\nChoose OVERRIDE only if the deterministic evidence is actually clean, REDIRECT if a concrete repair is needed, or ABORT if the task cannot be completed. Return JSON with status and reason.`,
      { label: 'completion-fable-gate', agentType: 'fable-critical-gate', schema: { type: 'object', required: ['status', 'reason'], properties: { status: { type: 'string' }, reason: { type: 'string' } } } }
    )
    return { status: 'blocked', reportDepth, prefilter, controllerReports, controller, postVerification, fable }
  }

  const changed = Array.isArray(controller?.changedFiles) && controller.changedFiles.length > 0
  if (!changed && tier < 3) return { status: 'approved', reportDepth, prefilter, controllerReports, controller, postVerification }
  const review = await agent(
    `Independently review this completion-controller result for task ${task}. Use report depth ${reportDepth}. Check the diff and criteria, then return JSON with checks containing numeric exitCode values, findings, reportDepth, and status.`,
    { label: 'completion-reviewer', agentType: 'completion-reviewer', schema: { type: 'object', required: ['checks', 'findings', 'status'], properties: { checks: { type: 'array' }, findings: { type: 'array' }, reportDepth: { type: 'string', enum: REPORT_DEPTHS }, status: { type: 'string' } } } }
  )
  return completionEvidencePass(review)
    ? { status: 'approved', reportDepth, prefilter, controllerReports, controller, postVerification, review }
    : { status: 'blocked', reportDepth, prefilter, controllerReports, controller, postVerification, review }
}

const tier = routeTier(args?.task || '')
log(`Assigned Tier ${tier}: ${tier === 1 ? 'Quick (Haiku only)' : tier === 2 ? 'Standard (Opus → Main → Haiku)' : 'Deep (full pipeline)'}`)

// ── Tier 1: Quick (Haiku only) ─────────────────────────────────────
if (tier === 1) {
  const task = args?.task || ''

  const result = await agent(
    `You are haiku-reviewer. Handle this task completely: ${task}

     1. Diagnose the root cause
     2. Apply the fix (you CAN write code for Tier 1)
     3. Verify: check syntax, compile, run tests, ground the fix against requirements
     4. Report what you changed and whether verification passed.

     If you cannot handle this task confidently in one shot, report that it needs escalation.`,
    { label: 'haiku-reviewer', agentType: 'haiku-reviewer', schema: CHECK_REPORT_SCHEMA }
  )

  return { tier: 1, result }
}

// ── Tier 2: Standard ───────────────────────────────────────────────
if (tier === 2) {
  const task = args?.task || ''

  phase('Design')
  const design = await agent(
    `You are opus-architect. Given this task: "${task}"

     Produce a JSON architecture plan with:
     - Steps in order (with files to touch per step)
     - Risks identified
     - Acceptance criteria

     Be precise and concise. The implementer needs to follow this exactly.`,
    { label: 'opus-architect', agentType: 'opus-architect', schema: { type: 'object', required: ['steps', 'risks', 'acceptance'], properties: { steps: { type: 'array', items: { type: 'object', properties: { order: { type: 'integer' }, description: { type: 'string' }, files: { type: 'array', items: { type: 'string' } }, risk: { type: 'string', enum: ['low', 'medium', 'high'] } }, required: ['order', 'description', 'files', 'risk'] } }, risks: { type: 'array', items: { type: 'string' } }, acceptance: { type: 'array', items: { type: 'string' } }, designNotes: { type: 'string' } } } }
  )

  phase('Implement')
  const implementation = await agent(
    `You are main-implementer. Implement the following architecture plan:

     ${JSON.stringify(design, null, 2)}

     Task description: "${task}"

     Follow the plan exactly. After implementing each file, verify it compiles.
     After all files are done, report what changed and whether compilation passes.`,
    { label: 'main-implementer', agentType: 'main-implementer' }
  )

  phase('Verify')
  const verification = await agent(
    `You are haiku-reviewer. Perform verification on this implementation:

     Task: "${task}"
     Architecture plan: ${JSON.stringify(design)}
     Implementation results: ${implementation}

     1. Check syntax (Bash)
     2. Check compilation (Bash)
     3. Run tests (Bash)
     4. Grounding check: does the diff actually address the task requirements?

     Return JSON with checks containing numeric exitCode values and specific findings. Never infer pass/fail from prose.`,
    { label: 'haiku-reviewer', agentType: 'haiku-reviewer', schema: CHECK_REPORT_SCHEMA }
  )

  const passed = deterministicChecksPass(verification)

  if (passed) {
    log(`Tier 2 complete — all checks passed`)
    const completion = await runCompletionPhase(task, tier, { design, implementation, verification })
    return { tier: 2, design, implementation, verification, completion, status: completion.status === 'approved' ? 'approved' : 'blocked' }
  }

  // Verification failed — attempt repair
  log('Verification failed — attempting repair')

  phase('Review')
  const review = await agent(
    `You are sonnet-reviewer. Review the implementation against the verification failure:

     Task: "${task}"
     Architecture: ${JSON.stringify(design)}
     Implementation: ${implementation}
     Verification failure: ${verification}

     Classify each finding: is it a real issue in the code? Minor or major?
     For major issues, specify file:line and what needs to change.`,
    { label: 'sonnet-reviewer', agentType: 'sonnet-reviewer' }
  )

  const repair = await agent(
    `You are main-implementer. Fix the issues found in review:

     Review findings: ${review}
     Architecture plan: ${JSON.stringify(design)}

     Apply targeted fixes. Then re-verify compilation and tests.`,
    { label: 'main-implementer', agentType: 'main-implementer' }
  )

  const reVerification = await agent(
    `You are haiku-reviewer. Re-verify after repairs:

     Original task: "${task}"
     Repair results: ${repair}

     1. Does it compile? (Bash)
     2. Do tests pass? (Bash)
     3. Grounding check: does the fix address all acceptance criteria?

     Return JSON with checks containing numeric exitCode values and findings. If still failing, recommend escalation to Tier 3.`,
  { label: 'haiku-reviewer', agentType: 'haiku-reviewer', schema: CHECK_REPORT_SCHEMA }
  )

  const rePassed = deterministicChecksPass(reVerification)

  if (rePassed) {
    log('Tier 2 complete after repair')
    const completion = await runCompletionPhase(task, tier, { design, implementation, verification, review, repair, reVerification })
    return { tier: 2, design, implementation, verification, review, repair, reVerification, completion, status: completion.status === 'approved' ? 'approved' : 'blocked' }
  }

  log('Tier 2 repair failed — escalating to Tier 3')
}

// ── Tier 3: Deep ────────────────────────────────────────────────────
phase('Design')
const archDesign = await agent(
  `You are opus-architect. Full architecture design for: "${args?.task}"

   Produce a detailed decomposition and architecture plan. Include:
   - Complete file list with changes per file
   - Interface contracts
   - Data flow
   - Acceptance criteria per component
   - Risk assessment
   - Rollback strategy`,
  { label: 'opus-architect', agentType: 'opus-architect' }
)

phase('Implement')
const archImpl = await agent(
  `You are main-implementer. Implement this architecture:

   ${archDesign}

   Task: "${args?.task}"

   Implement all files. Verify compilation after each file.`,
  { label: 'main-implementer', agentType: 'main-implementer' }
)

phase('Verify')
const archVerify = await agent(
  `You are haiku-reviewer. Full verification:

   Task: "${args?.task}"
   Implementation: ${archImpl}

   Run: syntax → compile → test → ground check
   Report each step's result.`,
  { label: 'haiku-reviewer', agentType: 'haiku-reviewer' }
)

phase('Review')
const archReview = await agent(
  `You are sonnet-reviewer. Multi-lens review of:

   Implementation: ${archImpl}
   Verification results: ${archVerify}

   Review for:
   1. Correctness (logic errors, edge cases)
   2. Completeness (error handling, null checks)
   3. Consistency (matches project patterns)
   4. Acceptance criteria coverage

   Report structured findings with file:line references and severity.`,
  { label: 'sonnet-reviewer', agentType: 'sonnet-reviewer' }
)

// Repair
const archRepair = await agent(
  `You are main-implementer. Address all review findings:

   Review findings: ${archReview}
   Original architecture: ${archDesign}

   Apply targeted fixes. Re-verify after each fix.`,
  { label: 'main-implementer', agentType: 'main-implementer' }
)

const finalVerify = await agent(
  `You are haiku-reviewer. Final verification after repairs:

   Task: "${args?.task}"
   Repair results: ${archRepair}

   Run: compile → test → ground check
   Report pass/fail.`,
  { label: 'haiku-reviewer', agentType: 'haiku-reviewer' }
)

phase('Gate')
const qualityGate = await agent(
  `You are opus-architect. Final quality gate for:

   Task: "${args?.task}"
   Implementation: ${archRepair}
   Verification: ${finalVerify}

   Check:
   1. All acceptance criteria met?
   2. Diff minimal (no unrelated changes)?
   3. No regression risk?

   Return JSON with status `approved` or `rejected`, specific reasons, and a checks array whose entries contain numeric exitCode values.
   If you cannot resolve concerns, flag for Fable escalation.`,
  { label: 'opus-architect', agentType: 'opus-architect' }
)

const approved = deterministicChecksPass(finalVerify) && typeof qualityGate === 'object' && qualityGate?.status === 'approved'

if (approved) {
  log('Tier 3 complete — approved by Opus quality gate')
  const completion = await runCompletionPhase(args?.task || '', tier, { archDesign, archImpl, archVerify, archReview, archRepair, finalVerify, qualityGate })
  return { tier: 3, archDesign, archImpl, archVerify, archReview, archRepair, finalVerify, qualityGate, completion, status: completion.status === 'approved' ? 'approved' : 'blocked' }
}

log('Opus quality gate flagged concerns — escalating to Fable critical gate')

const fableRuling = await agent(
  `You are fable-critical-gate. The Opus quality gate had concerns that could not be resolved. Make a binding decision.

   Task: "${args?.task}"
   Full session history:
   - Design: ${archDesign}
   - Implementation: ${archImpl}
   - Verification: ${archVerify}
   - Review: ${archReview}
   - Repair: ${archRepair}
   - Re-verify: ${finalVerify}
   - Quality gate: ${qualityGate}

   Options:
   1. OVERRIDE — approve despite concerns. Provide reason.
   2. REDIRECT — fundamental approach is wrong. Provide guidance for redesign.
   3. ABORT — task infeasible with current approach. Document why.

   This is the final model gate. If you cannot decide, it goes to human.`,
  { label: 'fable-critical-gate', agentType: 'fable-critical-gate' }
)

log(`Fable ruling: ${fableRuling}`)

return { tier: 3, archDesign, archImpl, archVerify, archReview, archRepair, finalVerify, qualityGate, fableRuling, completion: { status: 'blocked', reason: 'Fable escalation requires human review before completion evidence is bound' }, status: 'fable_resolved' }
