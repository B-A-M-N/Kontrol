export const meta = {
  name: 'kontrol-approval-remediation',
  description: 'Remediate the Kontrol approval/audit findings (P0.1-P0.5, cross-conversation ownership, P1s): DeepSeek implements, Qwen reviews, MiniMax signs off only remediated items.',
  whenToUse: 'Run after the 2026-08 approval-audit paste when the P0 approval-delivery defects need fixing on branch harden/control-plane.',
  phases: [
    { title: 'Implement', detail: 'DeepSeek (main-implementer) implements one work group each' },
    { title: 'Review', detail: 'Qwen (haiku-reviewer) reviews each group diff, verdict-gated' },
    { title: 'Remediate', detail: 'DeepSeek fixes findings only when review says needs_remediation' },
    { title: 'Sign-off', detail: 'MiniMax (opus-architect) single sign-off on remediated diffs only' },
    { title: 'Verify', detail: 'typecheck + focused test suites' },
  ],
}

// ---------------------------------------------------------------------------
// Shared context injected into every prompt.
// ---------------------------------------------------------------------------
const CONTEXT = `
Repository: /home/bamn/devspace (Kontrol). Branch: harden/control-plane. Work on the current checkout; DO NOT commit, DO NOT run npm run build or any deploy/package script, DO NOT touch dist/.

Ground rules (from the project owner):
- The tunnel/local "accept all" behavior is INTENTIONAL and must stay. KONTROL_AUTH_MODE=tunnel binds loopback, disables second bearer-auth layer, delegates ingress auth to the Secure MCP Tunnel. Do not "fix" that.
- The architecture list that must stay untouched: disposable MCP transport IDs, fresh initialize after stale route, durable workspace/work-session IDs, separate transport vs application idle, SSE heartbeat not extending app idle, reaper protections, 24h reusable transport TTL, soft/hard caps, memory-pressure adaptation, waiter admission pool, durable workspace grants, work-session grant revocation, process reaping, trusted logical continuity, generic clientInfo fallback NOT receiving trusted continuity, loopback-only tunnel mode, no second local bearer challenge, secret-backed reviewer assertion, tunnel restart backoff, stale-registration reconciliation, immutable-generation machinery.
- Match surrounding code style, comment density, and naming. Every behavioral change needs a regression test in the same style as existing *.test.ts files (plain node:test + tsx, see src/policy-ask-lifecycle.test.ts and src/policy-longevity.test.ts for patterns).

Verified anchors (already ground-checked against the working tree):
- src/server.ts:632 shouldAttachWidget  (P0.1)
- src/server.ts:847 policyFailureResponse, call sites ~1140,1235,1680,1784,1894,2012,2181,2273,2364,2469  (P0.2)
- src/ui/workspace-app.tsx:306 APPROVAL_CENTER_ID; :578,:587 ensureWorkSessionView(APPROVAL_CENTER_ID,...); :1337-1352 renderSessionSwitcher; :1718 workspaceEventTargetSessionId  (P0.3/P0.4/P0.5)
- src/server.ts:348 logicalClientIdentity; :4519 clientIdentity; processSessionOwnerId in src/server.ts (search)  (cross-conversation ownership)
- src/policy-tools.ts:60,85,113 liveWaiterCount  (orphaned semantics)
- scripts/probe-kontrol-readiness.mjs exists  (reviewer readiness probe)
- config: src/config.ts (tunnelReviewerSecret falls back KONTROL_TUNNEL_REVIEWER_SECRET ?? KONTROL_ACP_REVIEWER_SECRET)
`

const IMPLEMENT_SCHEMA = {
  type: 'object',
  required: ['changedFiles', 'summary'],
  properties: {
    changedFiles: { type: 'array', items: { type: 'string' }, description: 'Repo-relative paths actually modified or created' },
    summary: { type: 'string', description: 'What was implemented, per finding ID' },
    testsAdded: { type: 'array', items: { type: 'string' }, description: 'Test files created/extended' },
    checksRun: { type: 'string', description: 'Commands run and their exit codes' },
    concerns: { type: 'string', description: 'Anything ambiguous, skipped, or risky' },
  },
  additionalProperties: false,
}

const REVIEW_SCHEMA = {
  type: 'object',
  required: ['verdict', 'summary', 'findings'],
  properties: {
    verdict: { type: 'string', enum: ['clean', 'needs_remediation'] },
    summary: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['severity', 'file', 'issue'],
        properties: {
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          file: { type: 'string' },
          line: { type: 'integer' },
          issue: { type: 'string' },
          suggestedFix: { type: 'string' },
        },
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
}

const SIGNOFF_SCHEMA = {
  type: 'object',
  required: ['approved', 'summary'],
  properties: {
    approved: { type: 'boolean' },
    summary: { type: 'string' },
    requiredFixes: { type: 'array', items: { type: 'string' } },
  },
  additionalProperties: false,
}

// ---------------------------------------------------------------------------
// Work groups. Grouped so no two parallel implementers touch the same file.
// A = server.ts-centric, B = UI-centric, C = config/scripts-centric.
// ---------------------------------------------------------------------------
const GROUPS = [
  {
    key: 'server-core',
    scope: `You own the server-side approval-delivery + identity defects. Touch ONLY: src/server.ts, src/policy-enforcement.ts, src/policy-tools.ts, plus new test files. Other agents own the UI and config/scripts.

P0.1 — Policy-aware widget attachment (src/server.ts:632 shouldAttachWidget).
Do NOT simply force KONTROL_WIDGETS=full. In "changes" mode, additionally attach the Workspace App descriptor for any tool whose effective policy can produce an ask outcome: at minimum bash/exec_command (shell), write, edit, apply_patch, and read/search/list tools (read/grep/glob/ls) if path rules can place them in ask. Suggested helper: toolCanRequireInteractiveApproval(config, tool). "off" stays off; allow-mode-only installations keep current lightweight behavior. Regression test: KONTROL_WIDGETS=changes + bash=ask -> blocked bash result carries the workspace app descriptor.

P0.2 — policyFailureResponse (src/server.ts:847) lacks _meta.tool.
Refactor it to carry full operation context (result, tool, workspaceId, path, command). When approvalRequired it must return _meta: { tool, card: { tool, workspaceId, status: "approval_required", approvalId, ... } } so src/ui/workspace-app.tsx toolNameFromMeta()/isToolResultCard() can render it (read those UI helpers first and make the payload a legitimate ToolResultCard). Update ALL call sites (~1140, 1235, 1680, 1784, 1894, 2012, 2181, 2273, 2364, 2469) to pass tool context. Test: blocked bash under ask returns _meta.tool and a renderable card.

P0/P1 — Cross-conversation logical ownership (src/server.ts:348 logicalClientIdentity, processSessionOwnerId).
Separate authenticationPrincipal / logicalContinuityIdentity / conversationIdentity. For reconnectable interactive ownership derive, when a conversation ID is present: logicalContinuityId = trustedPrincipal + "|conversation:" + conversationId (same for x-kontrol-client-instance identity). Use it for direct process ownership and logical continuity. The conversation value partitions an already-authenticated principal — it must NOT broaden authorization. Tests: (1) two conversations, same OAuth client: conversation A starts proc_123, conversation B write_stdin(proc_123) => denied; (2) fresh transport for conversation A => allowed.

P1 — Per-client session cap 20-session dead-end (search src/server.ts for mcpSessionMaxPerClient / forceClientId reaper path).
The forced-cap path only reclaims toolCallCount <= 1 sessions and the second pass sees count(20) > max(20) == false, so a 21st connection 503s until the 24h TTL. When forceClientId is supplied compute needed = currentCount - max + 1 and reclaim that many eligible idle sessions, priority: zero-tool, one-tool, oldest idle reusable non-worker. Never evict: active request, active SSE, long poll, active policy waiter, durable worker responsibility. Regression test: 20 trusted idle multi-tool sessions, initialize #21 succeeds with one LRU reclaimed, count stays <= 20.

P1 — transport.onclose relies on transport.sessionId (src/server.ts ~4571 onsessioninitialized captures newSessionId as authoritative, but transport.onclose later reads transport?.sessionId).
Capture boundSessionId in the onsessioninitialized closure and prefer it: boundSessionId ?? transport?.sessionId. Centralize the duplicated cleanup (waiter cancellation, continuity detach, process ownership cleanup, metric recording, mcpSessions.delete, transports.delete) into one finalizeMcpSession(sessionId, reason) primitive used by both normal close and the reaper. Test: cleanup succeeds using the callback-bound ID when transport.sessionId is unavailable.

P1 — Premature "orphaned" semantics for direct approvals (src/policy-tools.ts:60,85,113 liveWaiterCount; server maintenance path).
Direct non-blocking approvals return approval_required immediately, so liveWaiterCount 0 is EXPECTED, not orphaned. Separate concepts: pending_human_approval vs detached_live_waiter vs abandoned_operation. A direct approval starts as pending_human_approval with liveWaiters 0 and stays available until its normal 10-minute approval TTL; do not set orphanedAt/reattachDeadline from zero waiters alone. Keep diagnostics honest.`,
  },
  {
    key: 'ui-approval-state',
    scope: `You own the WebUI approval-state defects. Touch ONLY: src/ui/workspace-app.tsx, src/ui/workspace-app.dom.test.tsx, and any new UI test files. Other agents own src/server.ts and config/scripts.

P0.3 — Direct approvals not surfaced. workspaceEventTargetSessionId (workspace-app.tsx:1718) routes approval events to the approval center but never SELECTS it, so a blocking human action can sit unseen behind session A. Add explicit global gating state: on a direct approval arrival, create/update the workspace approval center, show a prominent "Needs approval" banner in every current Kontrol surface, and auto-switch to the approval center unless doing so destroys active reviewer input (if an input/textarea currently has focus, retain focus and show the high-priority banner/button instead). Track the previous non-approval selection and restore it after resolution. Test (DOM): deliver policy.approval_requested; assert an approval action is visible without manually discovering the pseudo-session.

P0.4 — One global approval center reused across workspaces (APPROVAL_CENTER_ID at workspace-app.tsx:306; :578,:587 ensureWorkSessionView(APPROVAL_CENTER_ID, workspaceId, "") mutates the existing view's workspaceSessionId without clearing policyApprovals — workspace A approvals can render under workspace B). Make approval-center identity workspace-scoped: approvalCenterId(workspaceId) e.g. __approval_center__:ws_abc, or Map<workspaceId, ApprovalCenterState>. Never mutate one center between workspaces.

P0.5 — Session switcher not workspace-filtered (:1337-1352 renderSessionSwitcher filters only workSessionId !== APPROVAL_CENTER_ID). Every visible projection must filter view.workspaceSessionId === activeWorkspaceId. On workspace transition: invalidate selectedWorkSessionId if it belongs to another workspace, start on the newest/current workspace surface, never render another workspace's direct approvals, keep old state internally for fast return but never render it. Treat as an isolation invariant. Test: workspace A has a pending approval -> switch to B -> A's approval cannot render in B -> switch back restores it. Note P0.4 and P0.5 interact: design the workspace-scoped center id and the switcher filter together.

P0 — Phantom approvals after reconnect. rehydrateActiveSessions() merges list_pending_approvals results via mergePendingApproval(...) but never removes approvals no longer pending server-side (e.g. Approve committed, response transport died, callServerToolChecked correctly refuses to re-mutate). For each workspace approval-center hydration treat the server listing as the authoritative pending set: delete local ids absent from serverIds before merging. Apply the same reconciliation to other mutable projections rebuilt after reconnect. Test: server records approval, response transport fails -> reconnect -> list omits it -> stale card disappears.

P1 — Approval recovery failures silently swallowed. The list_pending_approvals catch block around rehydration discards the exact failure that makes approvals unusable. Keep hydration resilient but surface a separate control-plane state: approvalRecoveryState: "healthy" | "degraded" | "forbidden" | "disconnected", rendered as an "Approval recovery unavailable / Reviewer authorization failed / Retry" indicator.`,
  },
  {
    key: 'config-probes',
    scope: `You own configuration gating + readiness/diagnostics. Touch ONLY: src/config.ts, src/config.test.ts, scripts/probe-kontrol-readiness.mjs, scripts/kontrol-tunnel.sh, plus new/extended tests (src/auth-tunnel.test.ts and src/policy.test.ts are in scope if needed). Other agents own src/server.ts and the UI.

P0/P1 — Tunnel config can enable ask with no reviewer. The strong startup requirement for tunnelReviewerSecret (KONTROL_TUNNEL_REVIEWER_SECRET ?? KONTROL_ACP_REVIEWER_SECRET) is tied to ACP, so KONTROL_AUTH_MODE=tunnel + policy ask + ACP disabled + no reviewer secret yields approvals the WebUI can never act on (open_approval_center / list_pending_approvals / provide_policy_approval reject non-reviewers) — a deadlocked config. Add a helper like policyCanAsk(config.policy) and fail configuration/server startup when: tunnel mode AND policy can produce ask AND tunnelReviewerSecret is absent. The requirement must NOT depend on ACP. Global allow configs stay valid (no interactive policy decisions). scripts/kontrol-tunnel.sh must likewise refuse to launch an ask-capable config without a reviewer assertion. Test: tunnel + ask + missing reviewer assertion => configuration/startup failure; tunnel + allow + missing reviewer => valid.

P1 — Readiness does not prove the reviewer path. scripts/probe-kontrol-readiness.mjs proves health/ready/MCP initialize/discovery/workspace open/read, but not that the WebUI transport has reviewer authority. Add a second reviewer-capable MCP initialization using the same header mechanism the real tunnel uses, then call open_approval_center. Acceptance: HTTP 200 and isError != true. When effective policy contains ask, startup must not declare the full stack healthy unless this passes. Test (see src/start-all.test.mjs / probe patterns for how probes are tested): ask policy -> probe fails when reviewer path broken; allow policy -> reviewer step skipped or advisory.

P1 — Approval-continuity identity diagnostics. approvalRowKey()/identity plumbing can fall back to session or client_info_fallback identity, and nothing surfaces whether real traffic actually has a trusted conversation/client-instance correlation. Expose in diagnostics: identitySource, approvalContinuityCapable: true/false, conversationCorrelationPresent: true/false (server-side surfaces are owned by the server-core agent — keep your change to config/scripts and test-visible output, e.g. probe/soak assertion hooks; coordinate by reading, not editing, src/server.ts). If the server-core group's diagnostics land after yours, leave a clear seam (config flag or probe check) rather than editing src/server.ts.`,
  },
]

const COMMON_IMPL_RULES = `
Process:
1. Read every file you will touch BEFORE editing. Read the anchor sites and their tests first.
2. Implement exactly the findings assigned to your group. Do not refactor beyond what the findings require. Do not edit files outside your declared scope.
3. Add the regression tests named in your findings, in the existing test style.
4. Run focused verification and report real exit codes: npm run typecheck, then the specific test files you touched via tsx (e.g. npx tsx src/policy-ask-lifecycle.test.ts) or node for .mjs tests. Do NOT run npm run test:runtime (the full suite runs in the Verify phase).
5. If a required edit is impossible or ambiguous, implement what is safe and record it in concerns rather than guessing at a security invariant.
Your final output is consumed by a machine, not a human.`

const COMMON_REVIEW_RULES = `
You are reviewing a remediation diff on branch harden/control-plane in /home/bamn/devspace. The implementer's claim follows below. Rules:
1. Run: git diff --stat and git diff on the group's scoped files to see the actual change (scoped files: see below). Read the changed code in full context.
2. Verify each finding was actually fixed — not claimed fixed. Check the specific acceptance behaviors and that the named regression tests exist and pass: run npx tsx <test file> (or node for .mjs) and report exit codes. Also run npm run typecheck.
3. Enforce the ground rules: tunnel accept-all behavior untouched; the keep-list architecture untouched; no scope creep into other groups' files; test integrity (no weakened assertions, no skipped tests).
4. Security invariants are high severity: cross-conversation process isolation, workspace approval isolation, reviewer gating.
5. verdict "clean" only if no high/medium findings remain. Anything high/medium that is concretely fixable => "needs_remediation" with actionable suggestedFix per finding. Low findings alone do not block.
Your final output is consumed by a machine, not a human.`

// ---------------------------------------------------------------------------
// Sequential per-group chains. The implementation stage runs ONE group at a
// time: concurrent main-implementer agents share one model slot and a parallel
// launch died to rate_limit before doing any work (run wf_eeb00d43-091).
// Within a group, implement -> review -> (remediate -> signoff) still flow
// without barriers.
//
// MODEL ROUTING (per user directive 2026-08-28, verified against
// ~/.config/claude-code/freeinference/model-topology.json):
//   implement + remediate -> deepseek-v4-flash (explicit model override; the
//     main-implementer agent def says model:inherit, which resolves to the
//     session model glm-5.2 — NOT DeepSeek, as run wf_bacbd51e-986 proved)
//   review -> qwen3.6-35b via haiku-reviewer agent type (correct already)
//   sign-off -> minimax-m3 via explicit model override on opus-architect
//     (agent def targets the opus slot = kimi-k2.7-code, which the user
//     excluded; MiniMax is the sonnet slot)
// ---------------------------------------------------------------------------
const done = []
for (const group of GROUPS) {
  phase('Implement')
  const impl = await agent(`${CONTEXT}\n\n== YOUR WORK GROUP: ${group.key} ==\n${group.scope}\n${COMMON_IMPL_RULES}`, {
    label: `impl:${group.key}`,
    phase: 'Implement',
    agentType: 'main-implementer',
    model: 'deepseek-v4-flash',
    schema: IMPLEMENT_SCHEMA,
  })
  if (!impl) {
    log(`group ${group.key}: implementer died, skipping chain`)
    continue
  }

  phase('Review')
  const review = await agent(
    `${CONTEXT}\n\n== REVIEW WORK GROUP: ${group.key} ==\nGroup scope files: ${group.scope.match(/Touch ONLY:[^\n]+/)?.[0] ?? 'see scope below'}\n\n${group.scope}\n${COMMON_REVIEW_RULES}\n\n== IMPLEMENTER CLAIM ==\nchangedFiles: ${JSON.stringify(impl.changedFiles)}\nsummary: ${impl.summary}\ntestsAdded: ${JSON.stringify(impl.testsAdded)}\nchecksRun: ${impl.checksRun ?? 'none reported'}\nconcerns: ${impl.concerns ?? 'none'}`,
    { label: `review:${group.key}`, phase: 'Review', agentType: 'haiku-reviewer', schema: REVIEW_SCHEMA },
  )

  let state = { group, impl, review, remediation: null, signoff: null }
  if (review?.verdict === 'needs_remediation') {
    const items = review.findings
      .filter((f) => f.severity === 'high' || f.severity === 'medium')
      .map((f) => `- [${f.severity}] ${f.file}${f.line ? ':' + f.line : ''} — ${f.issue}\n  Fix: ${f.suggestedFix ?? 'use judgment, minimal change'}`)
      .join('\n')
    phase('Remediate')
    const remediation = await agent(
      `${CONTEXT}\n\n== REMEDIATION FOR WORK GROUP: ${group.key} ==\nOriginal scope:\n${group.scope}\n\nThe reviewer found these high/medium issues in your earlier change (changedFiles: ${JSON.stringify(impl.changedFiles)}):\n${items}\n\nApply the minimal correct fixes within the group's file scope. Keep all prior work intact unless a finding says otherwise. Re-run the focused tests you touch plus npm run typecheck; report real exit codes. Do not expand scope. Do not commit.\n${COMMON_IMPL_RULES}`,
      { label: `remediate:${group.key}`, phase: 'Remediate', agentType: 'main-implementer', model: 'deepseek-v4-flash', schema: IMPLEMENT_SCHEMA },
    )
    if (remediation) {
      state.remediation = remediation
      phase('Sign-off')
      state.signoff = await agent(
        `${CONTEXT}\n\n== FINAL SIGN-OFF: ${group.key} ==\nThis group's diff was remediated after review. You are the single sign-off authority; review ONLY the remediated state, do not re-litigate settled design.\n1. git diff the group's scoped files; focus on the reviewer findings below and whether the remediation actually resolved each one without breaking the security invariants (cross-conversation process isolation, workspace approval isolation, reviewer gating, tunnel accept-all preserved).\n2. Run the group's key regression tests and npm run typecheck; report exit codes.\n3. approved=true only if no high/medium issue remains. Otherwise approved=false with concrete requiredFixes.\nFindings that drove remediation: ${JSON.stringify(review.findings.filter((f) => f.severity !== 'low'))}\nRemediation claim: ${remediation.summary}\nchangedFiles: ${JSON.stringify(remediation.changedFiles)}\nchecksRun: ${remediation.checksRun ?? 'none reported'}`,
        { label: `signoff:${group.key}`, phase: 'Sign-off', agentType: 'opus-architect', model: 'minimax-m3', schema: SIGNOFF_SCHEMA },
      )
    }
  }
  done.push(state)
  log(`group ${group.key}: review=${review?.verdict ?? 'died'}${state.signoff ? ` signoff=${state.signoff.approved ? 'approved' : 'REJECTED'}` : ''}`)
}
log(`${done.length}/${GROUPS.length} groups completed`)

// ---------------------------------------------------------------------------
// Verify: full runtime suite on the combined diff. Needs ALL groups -> barrier
// is genuinely required here.
// ---------------------------------------------------------------------------
phase('Verify')
const verify = await agent(
  `${CONTEXT}\n\n== FINAL VERIFICATION ==\nAll three work groups (server-core, ui-approval-state, config-probes) have landed changes on the working tree. Verify the combined result:\n1. git status and git diff --stat to see the full combined diff; confirm no group edited another group's scoped files (server-core: src/server.ts, src/policy-enforcement.ts, src/policy-tools.ts; ui: src/ui/*; config-probes: src/config.ts, scripts/probe-kontrol-readiness.mjs, scripts/kontrol-tunnel.sh, src/auth-tunnel.test.ts, src/policy.test.ts).\n2. npm run typecheck — report exit code.\n3. Run the full runtime suite: npm run test:runtime — report exit code and, on failure, the exact failing test names and a short stderr tail. If the failure is flaky-looking, re-run that single file once to confirm.\n4. Do NOT fix anything — you are a verifier. Report failures precisely.`,
  { label: 'verify:full-suite', phase: 'Verify', agentType: 'haiku-reviewer', schema: {
    type: 'object',
    required: ['typecheckPassed', 'suitePassed', 'report'],
    properties: {
      typecheckPassed: { type: 'boolean' },
      suitePassed: { type: 'boolean' },
      report: { type: 'string', description: 'Exit codes, failing tests if any, scope violations if any' },
    },
    additionalProperties: false,
  } },
)

return {
  groups: done.map((s) => ({
    key: s.group.key,
    changedFiles: s.remediation?.changedFiles ?? s.impl.changedFiles,
    summary: s.remediation ? `REMEDIATED — ${s.remediation.summary}` : s.impl.summary,
    reviewVerdict: s.review?.verdict,
    reviewFindings: s.review?.findings?.filter((f) => f.severity !== 'low') ?? [],
    signoff: s.signoff ? { approved: s.signoff.approved, requiredFixes: s.signoff.requiredFixes ?? [] } : null,
    concerns: s.remediation?.concerns ?? s.impl.concerns,
  })),
  verification: verify,
}
