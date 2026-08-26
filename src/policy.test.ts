import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openDatabase, databasePath } from "./db/client.js";
import { createPolicyEngine, parseMode, loadPolicyConfig } from "./policy.js";
import { createSqliteGrantStore } from "./policy-grants.js";
import { createEventStore } from "./event-log.js";
import { createWorkSessionManager } from "./work-sessions.js";
import { createPolicyEnforcer } from "./policy-enforcement.js";
import { createApprovalRequestManager } from "./approval-requests.js";

const root = mkdtempSync(join(tmpdir(), "kontrol-policy-test-"));
const db = openDatabase(root);
const eventStore = createEventStore(db);
const workSessions = createWorkSessionManager(db);
const grantStore = createSqliteGrantStore(db);
const approvalRequests = createApprovalRequestManager(db);

const WS = "ws-test";

function seedWorkspace(dir: string, id: string): void {
  const sqlite = new Database(databasePath(dir));
  sqlite.pragma("foreign_keys = OFF");
  sqlite.exec(
    `insert into workspace_sessions (id, root, status, mode, managed, created_at, last_used_at) ` +
    `values ('${id}', '/tmp', 'active', 'checkout', 'false', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')`,
  );
  sqlite.close();
}

// ── Test 1: parseMode / loadPolicyConfig ──

assert.equal(parseMode("allow"), "allow");
assert.equal(parseMode("deny"), "deny");
assert.equal(parseMode("ask"), "ask");
assert.equal(parseMode("ALLOW"), "allow");
assert.equal(parseMode("Ask"), "ask");
assert.equal(parseMode("invalid"), undefined);
assert.equal(parseMode(undefined), undefined);

const baseEnv = {
  KONTROL_CONFIG_DIR: root,
  KONTROL_ALLOWED_ROOTS: process.cwd(),
  KONTROL_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
};

assert.throws(
  () => loadPolicyConfig({ ...baseEnv, KONTROL_POLICY_MODE: "asks" }),
  /KONTROL_POLICY_MODE must be one of allow\|deny\|ask/,
);
assert.doesNotThrow(
  () => loadPolicyConfig({ ...baseEnv, KONTROL_POLICY_TOOL_WRITE: "asks" }),
  "invalid tool mode is ignored, not thrown",
);
const cfgWithBadTool = loadPolicyConfig({ ...baseEnv, KONTROL_POLICY_TOOL_WRITE: "asks" });
// An invalid explicit tool rule is ignored, so the secure-baseline `ask`
// applies to the mutating tool rather than silently allowing it.
assert.equal(cfgWithBadTool.toolRules.write, "ask", "invalid tool mode ignored; secure baseline applies");

const cfg = loadPolicyConfig(baseEnv);
assert.equal(cfg.defaultMode, "allow");

// Secure-by-default baseline: a zero-policy environment must NOT silently
// grant arbitrary shell/write authority — mutating tools gate behind `ask`
// while read-only inspection stays frictionless.
const zeroPolicy = loadPolicyConfig({ ...baseEnv, KONTROL_POLICY_TOOL_BASH: "" });
assert.equal(zeroPolicy.toolRules.bash, "ask", "bash must default to ask");
assert.equal(zeroPolicy.toolRules.write, "ask", "write must default to ask");
assert.equal(zeroPolicy.toolRules.edit, "ask", "edit must default to ask");
assert.equal(zeroPolicy.toolRules.apply_patch, "ask", "apply_patch must default to ask");
const zeroEngine = createPolicyEngine(zeroPolicy);
assert.equal(zeroEngine.evaluate("bash", undefined, "ws").mode, "ask", "zero-policy bash evaluates to ask");
assert.equal(zeroEngine.evaluate("exec_command", undefined, "ws").mode, "ask", "exec_command alias gates as bash -> ask");
assert.equal(zeroEngine.evaluate("kontrol-shell", undefined, "ws").mode, "ask", "kontrol-shell alias gates as bash -> ask");
assert.equal(zeroEngine.evaluate("write", "/tmp/x", "ws").mode, "ask", "zero-policy write evaluates to ask");
assert.equal(zeroEngine.evaluate("read", "/tmp/x", "ws").mode, "allow", "read stays frictionless under the baseline");
assert.equal(zeroEngine.evaluate("grep", undefined, "ws").mode, "allow", "grep stays frictionless under the baseline");

// Explicit per-tool rules win over the baseline.
const explicitBash = loadPolicyConfig({ ...baseEnv, KONTROL_POLICY_TOOL_BASH: "allow" });
assert.equal(explicitBash.toolRules.bash, "allow", "operator may explicitly promote bash");

// Explicit global mode overrides the baseline entirely (operator decision).
const explicitGlobal = loadPolicyConfig({ ...baseEnv, KONTROL_POLICY_MODE: "allow" });
assert.deepEqual(explicitGlobal.toolRules, {}, "explicit global allow suppresses the baseline");

// Path rules via JSON
const envWithPathRules = {
  ...baseEnv,
  KONTROL_POLICY_PATH_RULES: JSON.stringify([
    { pattern: "/etc/ssh/**", mode: "deny" },
    { pattern: "**/.env", mode: "ask" },
  ]),
};
const cfg2 = loadPolicyConfig(envWithPathRules);
assert.equal(cfg2.pathRules.length, 2);
assert.equal(cfg2.pathRules[0].pattern, "/etc/ssh/**");
assert.equal(cfg2.pathRules[0].mode, "deny");
assert.equal(cfg2.pathRules[1].mode, "ask");

assert.throws(
  () => loadPolicyConfig({ ...baseEnv, KONTROL_POLICY_PATH_RULES: "not json" }),
  /KONTROL_POLICY_PATH_RULES is not valid JSON/,
);
assert.throws(
  () => loadPolicyConfig({ ...baseEnv, KONTROL_POLICY_PATH_RULES: "[{}]" }),
  /each entry needs a "pattern" and a valid "mode"/,
);

// ── Test 2: evaluate returns canonical approval keys ──

const policy = createPolicyEngine(
  { defaultMode: "ask", toolRules: { write: "ask" }, pathRules: [{ pattern: "src/**", mode: "ask" }] },
  grantStore,
);

const d1 = policy.evaluate("write", "src/server.ts", WS);
assert.equal(d1.mode, "ask");
assert.equal(d1.approvalKey, "path:src/**");
assert.equal(d1.source, "path");

const d2 = policy.evaluate("write", "other/file.ts", WS);
assert.equal(d2.mode, "ask");
assert.equal(d2.approvalKey, "tool:write");
assert.equal(d2.source, "tool");

// Path rules match both canonical spellings and the most-specific rule wins,
// regardless of declaration order.
const specificPolicy = createPolicyEngine({
  defaultMode: "allow",
  toolRules: {},
  pathRules: [
    { pattern: "src/**", mode: "deny" },
    { pattern: "src/private/**", mode: "allow" },
  ],
});
const specificDecision = specificPolicy.evaluate("write", {
  relativePath: "src/private/credentials.ts",
  absolutePath: "/workspace/src/private/credentials.ts",
}, WS);
assert.equal(specificDecision.mode, "allow");
assert.equal(specificDecision.approvalKey, "path:src/private/**");

const policyDefault = createPolicyEngine({ defaultMode: "ask", toolRules: {}, pathRules: [] });
const d3 = policyDefault.evaluate("write", "unmatched.ts", WS);
assert.equal(d3.mode, "ask");
assert.equal(d3.approvalKey, "default:write");
assert.equal(d3.source, "default");

// ── Test 3b: policy asks survive a manager/engine restart ──

const durablePolicy = createPolicyEngine(
  { defaultMode: "ask", toolRules: { write: "ask" }, pathRules: [] },
  undefined,
  approvalRequests,
);
durablePolicy.addPending({
  id: "pol_durable_restart",
  principalId: "principal-durable",
  workspaceId: WS,
  workSessionId: "wsess-durable",
  tool: "write",
  path: "durable.txt",
  requestedAt: new Date().toISOString(),
});
const approvalManagerAfterRestart = createApprovalRequestManager(db);
const restartedPolicy = createPolicyEngine(
  { defaultMode: "ask", toolRules: { write: "ask" }, pathRules: [] },
  undefined,
  approvalManagerAfterRestart,
);
assert.equal(restartedPolicy.getPendingApprovals(WS)[0]?.id, "pol_durable_restart");
assert.ok(
  approvalManagerAfterRestart.get("pol_durable_restart")?.options.some((option) => option.id === "approve_workspace"),
  "policy approval cards must offer durable workspace approval",
);
restartedPolicy.resolvePending("pol_durable_restart", "approved", "test restart recovery");
assert.equal(approvalManagerAfterRestart.get("pol_durable_restart")?.status, "approved");

// ── Test 3: isApproved uses canonical keys ──

policy.recordApproval("principal-1", "path:src/**", "work_session", { workspaceId: WS, workSessionId: "wsess-1" });
const approved = policy.isApproved("principal-1", "path:src/**", { workspaceId: WS, workSessionId: "wsess-1" });
assert.equal(approved, true, "same principal+scope+key is approved");

const approved2 = policy.isApproved("principal-1", "path:src/**", { workspaceId: WS, workSessionId: "wsess-2" });
assert.equal(approved2, false, "work_session approval does not leak to another work session");

// ── Test 4: scopes are isolated ──

policy.recordApproval("principal-2", "tool:write", "work_session", { workspaceId: WS, workSessionId: "wsess-A" });
assert.equal(policy.isApproved("principal-2", "tool:write", { workspaceId: WS, workSessionId: "wsess-B" }), false);
policy.recordApproval("principal-2", "tool:write", "workspace", { workspaceId: WS, workSessionId: "wsess-C" });
assert.equal(policy.isApproved("principal-2", "tool:write", { workspaceId: WS, workSessionId: "wsess-D" }), true);

// ── P1.12: workspace grants are strictly scoped to one workspace ──
// A workspace grant in WS must NOT cross over into a different workspace,
// even for the same principal and same approval key. The P1.10 durable
// workspace grant is intentionally narrow; if this ever regressed, a
// reviewer granting trust in workspace A would silently unlock privileged
// operations in workspace B.
policy.recordApproval("principal-boundary", "tool:write", "workspace", {
  workspaceId: WS,
  workSessionId: "wsess-boundary-A",
});
assert.equal(policy.isApproved("principal-boundary", "tool:write", {
  workspaceId: WS, workSessionId: "wsess-boundary-A",
}), true, "workspace grant applies inside its own workspace");
assert.equal(policy.isApproved("principal-boundary", "tool:write", {
  workspaceId: WS, workSessionId: "wsess-boundary-B",
}), true, "workspace grant covers any work session within the workspace");
assert.equal(policy.isApproved("principal-boundary", "tool:write", {
  workspaceId: `${WS}-other`, workSessionId: "wsess-boundary-A",
}), false, "workspace grant does NOT cross into a different workspace");
assert.equal(policy.isApproved("principal-boundary", "tool:write", {
  workspaceId: "ws-arbitrary", workSessionId: "wsess-boundary-A",
}), false, "workspace grant does NOT cross into an unrelated workspace");
const boundaryGrant = grantStore.listEffective().find((g) => g.principalId === "principal-boundary");
assert.ok(boundaryGrant);
assert.equal(boundaryGrant.scope, "workspace");
assert.equal(boundaryGrant.scopeId, WS, "grant scopeId is the granting workspace");

// Work-session grants require an actual session and can be revoked without
// restarting the policy engine. IDs are intentionally opaque so re-approval
// after revocation cannot collide with a historical row.
policy.recordApproval("principal-revoke", "tool:write", "work_session", { workspaceId: WS });
assert.equal(policy.isApproved("principal-revoke", "tool:write", { workspaceId: WS, workSessionId: "missing" }), false);
policy.recordApproval("principal-revoke", "tool:write", "work_session", { workspaceId: WS, workSessionId: "wsess-revoke" });
const firstGrant = grantStore.listEffective().find((g) => g.principalId === "principal-revoke");
assert.ok(firstGrant);
policy.revokeScope("work_session", "wsess-revoke");
assert.equal(policy.isApproved("principal-revoke", "tool:write", { workspaceId: WS, workSessionId: "wsess-revoke" }), false);
policy.recordApproval("principal-revoke", "tool:write", "work_session", { workspaceId: WS, workSessionId: "wsess-revoke" });
const secondGrant = grantStore.listEffective().find((g) => g.principalId === "principal-revoke");
assert.ok(secondGrant);
assert.notEqual(firstGrant.id, secondGrant.id);

// ── Test 5: durable grant store survives restart ──

const grant = grantStore.listEffective().find(g => g.principalId === "principal-1" && g.approvalKey === "path:src/**");
assert.ok(grant, "grant is persisted to store");

const db2 = openDatabase(root);
const grantStore2 = createSqliteGrantStore(db2);
const policy2 = createPolicyEngine(
  { defaultMode: "ask", toolRules: { write: "ask" }, pathRules: [] },
  grantStore2,
);
assert.equal(policy2.isApproved("principal-1", "path:src/**", { workspaceId: WS, workSessionId: "wsess-1" }), true);
db2.close();

// ── Test 6: approve_once does not cache ──

const policy3 = createPolicyEngine({ defaultMode: "ask", toolRules: {}, pathRules: [] });
assert.equal(policy3.isApproved("p", "tool:read", { workspaceId: WS }), false);
policy3.recordApproval("p", "tool:read", "once", { workspaceId: WS });
assert.equal(policy3.isApproved("p", "tool:read", { workspaceId: WS }), false);

// ── Test 7: policy enforcer integration ──

const enforcerPolicy = createPolicyEngine({ defaultMode: "ask", toolRules: { write: "ask" }, pathRules: [] }, grantStore);
const enforcer = createPolicyEnforcer(enforcerPolicy, eventStore, { timeoutMs: 100 });

// First call: no approval -> blocks (timeout)
const r1 = await enforcer.enforce({
  principalId: "test-principal",
  principalRole: "worker",
  workspaceId: WS,
  workSessionId: "wsess-1",
  runId: "run-1",
  tool: "write",
  path: "x.txt",
});
assert.equal(r1.allowed, false);
assert.equal(r1.decision.mode, "ask");

// Manually record the approval on the policy engine (simulating reviewer decision)
enforcerPolicy.recordApproval("test-principal", r1.decision.approvalKey!, "work_session", { workspaceId: WS, workSessionId: "wsess-1" });

// Second call: should be allowed now
const r2 = await enforcer.enforce({
  principalId: "test-principal",
  principalRole: "worker",
  workspaceId: WS,
  workSessionId: "wsess-1",
  runId: "run-1",
  tool: "write",
  path: "x.txt",
});
assert.equal(r2.allowed, true);

// Blocking policy approval must not silently fall back to the old five-minute
// request lifetime. The server may supply a deployment-specific backstop, but
// the library default is deliberately long-lived and caller disconnects are a
// separate cancellation path.
const longWaitPolicy = createPolicyEngine({ defaultMode: "ask", toolRules: {}, pathRules: [] });
const longWaitEnforcer = createPolicyEnforcer(longWaitPolicy, eventStore);
const originalLongWait = eventStore.waitForMatchingEventAfter;
let observedDefaultTimeout = 0;
(eventStore as any).waitForMatchingEventAfter = async (...args: any[]) => {
  observedDefaultTimeout = args[3];
  return null;
};
try {
  await longWaitEnforcer.enforce({
    principalId: "long-lived-principal",
    principalRole: "client",
    workspaceId: WS,
    tool: "write",
    path: "long-lived.txt",
  });
} finally {
  (eventStore as any).waitForMatchingEventAfter = originalLongWait;
}
assert.ok(observedDefaultTimeout > 5 * 60_000, "default approval wait must exceed five minutes");

// A disconnected originating request cancels only its own parked approval.
// P0.3: the durable approval row is RETAINED (only the live waiter is
// detached) so a reconnecting invocation with the same row key can still
// attach to it.
const cancellationPolicy = createPolicyEngine({ defaultMode: "ask", toolRules: {}, pathRules: [] });
const cancellationEnforcer = createPolicyEnforcer(cancellationPolicy, eventStore);
const cancellation = new AbortController();
const cancellationResult = cancellationEnforcer.enforce({
  principalId: "disconnecting-principal",
  principalRole: "client",
  workspaceId: WS,
  tool: "write",
  path: "disconnecting.txt",
  mcpSessionId: "mcp-cancel-session",
  mcpRequestId: "mcp-cancel-request-1",
  signal: cancellation.signal,
});
await new Promise((resolve) => setTimeout(resolve, 0));
cancellation.abort();
const cancelled = await cancellationResult;
assert.equal(cancelled.allowed, false);
assert.equal(cancelled.outcome, "caller_gone");
const cancellationRow = cancellationPolicy.getPendingApprovals()[0];
assert.ok(cancellationRow, "durable approval row survives caller_gone");
assert.equal(cancellationPolicy.countLiveWaiters(cancellationRow.id), 0, "live waiter is detached even though durable row survives");

// ── Test 8: identical concurrent invocations remain independently approved ──

const duplicatePolicy = createPolicyEngine({ defaultMode: "ask", toolRules: { write: "ask" }, pathRules: [] });
const duplicateEnforcer = createPolicyEnforcer(duplicatePolicy, eventStore, { timeoutMs: 1_000 });
const duplicateInvocation = {
  principalId: "reconnecting-client",
  principalRole: "client" as const,
  workspaceId: WS,
  tool: "write",
  path: "same-file.txt",
  command: undefined,
};
const firstReplay = duplicateEnforcer.enforce(duplicateInvocation);
const secondReplay = duplicateEnforcer.enforce(duplicateInvocation);
await new Promise((resolve) => setTimeout(resolve, 0));
const pendingReplays = duplicatePolicy.getPendingApprovals();
assert.equal(pendingReplays.length, 2, "approve-once must not merge separate identical invocations");
for (const pending of pendingReplays) {
  eventStore.appendEvent({
    type: "policy.approval.provided",
    sessionId: WS,
    payload: { approvalId: pending.id, decision: "approve", scope: "once" },
  });
}
assert.deepEqual((await Promise.all([firstReplay, secondReplay])).map((result) => result.allowed), [true, true]);

// ── Test 8b: same live MCP request retrying re-attaches to the durable row ──

const reattachPolicy = createPolicyEngine({ defaultMode: "ask", toolRules: { write: "ask" }, pathRules: [] });
const reattachEnforcer = createPolicyEnforcer(reattachPolicy, eventStore, { timeoutMs: 1_000 });
const reattachInvocation = {
  principalId: "reconnecting-client",
  principalRole: "client" as const,
  workspaceId: WS,
  tool: "write",
  path: "same-file.txt",
  mcpSessionId: "mcp-reattach-session",
  mcpRequestId: "mcp-reattach-request-1",
};
const firstAttempt = reattachEnforcer.enforce(reattachInvocation);
await new Promise((resolve) => setTimeout(resolve, 0));
const firstRow = reattachPolicy.getPendingApprovals()[0];
assert.ok(firstRow, "first attempt created a durable approval row");
assert.equal(reattachPolicy.countLiveWaiters(firstRow.id), 1, "first attempt attached a live waiter");

// The MCP caller died; only the LIVE waiter detached, the durable row stays.
reattachPolicy.detachLiveWaiter(firstRow.id, "mcp-reattach-request-1");
assert.equal(reattachPolicy.countLiveWaiters(firstRow.id), 0, "detach removes the live waiter but preserves the durable row");
assert.equal(reattachPolicy.getPendingApprovals().length, 1, "durable row survives the dead live waiter");

// A reconnecting invocation with the SAME (mcpSessionId, mcpRequestId) reuses
// the durable row; the liveWaiterId is recomputed from mcpRequestId, which
// means the test uses the SAME mcpRequestId so the row key matches.
const retryInvocation = { ...reattachInvocation };
const secondAttempt = reattachEnforcer.enforce(retryInvocation);
await new Promise((resolve) => setTimeout(resolve, 0));
const allPending = reattachPolicy.getPendingApprovals();
assert.equal(allPending.length, 1, "retry reattaches to the same durable row, no duplicate");
const reusedRow = allPending[0];
assert.equal(reusedRow.id, firstRow.id, "durable approvalId is reused for the reconnecting live invocation");
assert.equal(reattachPolicy.countLiveWaiters(reusedRow.id), 1, "retry attached a fresh live waiter to the existing row");

// Reviewer decides once — both invocations observe the same durable resolution.
eventStore.appendEvent({
  type: "policy.approval.provided",
  sessionId: WS,
  payload: { approvalId: reusedRow.id, decision: "approve", scope: "workspace" },
});
assert.equal((await Promise.all([firstAttempt, secondAttempt])).every((r) => r.allowed), true, "single reviewer decision resolves both the dead first attempt and the live retry");
assert.equal(reattachPolicy.getPendingApprovals().length, 0, "durable row cleared after the resolution");

// ── P1.10: authoritative approval options are carried in the event payload ──
// Rehydrating clients (e.g. via list_pending_approvals) must reconcile
// against the server-authored options, never invent their own. The
// policy.approval_requested event carries the canonical list.
{
  const eventOptionsPolicy = createPolicyEngine(
    { defaultMode: "ask", toolRules: { write: "ask" }, pathRules: [] },
    undefined,
    approvalRequests,
  );
  const eventOptionsEnforcer = createPolicyEnforcer(eventOptionsPolicy, eventStore, { timeoutMs: 200 });
  const observer = (event: { type: string; payload: { options?: unknown[] } }): void => {
    if (event.type !== "policy.approval_requested") return;
    observedOptions = event.payload.options as Array<{ id: string; effect: string; scope?: string }>;
  };
  const unsubscribe = eventStore.subscribe("wsess-event-options", observer);
  let observedOptions: Array<{ id: string; effect: string; scope?: string }> | undefined;
  try {
    const eventRequest = eventOptionsEnforcer.enforce({
      principalId: "event-options-principal",
      principalRole: "worker",
      workspaceId: WS,
      workSessionId: "wsess-event-options",
      tool: "write",
      path: "event-options.txt",
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    const row = eventOptionsPolicy.getPendingApprovals(WS).find((p) => p.workSessionId === "wsess-event-options");
    assert.ok(row, "policy approval row created");
    eventStore.appendEvent({
      type: "policy.approval.provided",
      sessionId: "wsess-event-options",
      payload: { approvalId: row.id, decision: "approve", scope: "once" },
    });
    await eventRequest;
    assert.ok(observedOptions, "policy.approval_requested was observed");
    const ids = observedOptions!.map((option) => option.id).sort();
    assert.deepEqual(ids, ["approve", "approve_session", "approve_workspace", "deny"],
      `event payload carries Approve Once / Approve Session / Approve Workspace / Deny: ${ids.join(",")}`);
    // Approve Session only appears when a work session is bound.
    const sessionOption = observedOptions!.find((option) => option.id === "approve_session");
    assert.ok(sessionOption, "approve_session present when workSessionId is bound");
    assert.equal(sessionOption?.scope, "work_session");
    // Approve Workspace is the durable cross-session grant.
    const workspaceOption = observedOptions!.find((option) => option.id === "approve_workspace");
    assert.equal(workspaceOption?.scope, "workspace", "approve_workspace scoped to workspace");
  } finally {
    unsubscribe();
  }
}

// ── Test 9: approval emitted in the append/wait gap is not lost ──

const racePolicy = createPolicyEngine({ defaultMode: "ask", toolRules: { write: "ask" }, pathRules: [] });
const raceEnforcer = createPolicyEnforcer(racePolicy, eventStore, { timeoutMs: 250 });
const originalDurableWait = eventStore.waitForMatchingEventAfter;
let injectedRaceApproval = false;
(eventStore as any).waitForMatchingEventAfter = async (
  sessionId: string,
  afterSeq: number,
  predicate: (event: any) => boolean,
  timeoutMs: number,
) => {
  if (!injectedRaceApproval) {
    injectedRaceApproval = true;
    const request = racePolicy.getPendingApprovals("ws-race")[0];
    assert.ok(request);
    eventStore.appendEvent({
      type: "policy.approval.provided",
      sessionId,
      payload: { approvalId: request.id, decision: "approve", scope: "once" },
    });
  }
  return originalDurableWait(sessionId, afterSeq, predicate, timeoutMs);
};
try {
  const raceResult = await raceEnforcer.enforce({
    principalId: "race-principal",
    principalRole: "client",
    workspaceId: "ws-race",
    tool: "write",
    path: "race.txt",
  });
  assert.equal(raceResult.allowed, true, "durable reread catches an approval emitted before waiter setup");
  assert.equal(raceResult.outcome, "approved");
} finally {
  (eventStore as any).waitForMatchingEventAfter = originalDurableWait;
}

db.close();

// ── P0 #1 regression: shell aliases must produce IDENTICAL decisions ──
// default=allow + bash=deny: exec_command/kontrol-shell evaluate to bash.
{
  const denyBash = createPolicyEngine({ defaultMode: "allow", toolRules: { bash: "deny" }, pathRules: [] });
  for (const alias of ["bash", "exec_command", "kontrol-shell"]) {
    const decision = denyBash.evaluate(alias, undefined, WS);
    assert.equal(decision.mode, "deny", `alias ${alias} must be gated by the bash rule`);
    assert.equal(decision.approvalKey, "tool:bash", `alias ${alias} must use the canonical bash approval key`);
  }
  // default=allow + bash=ask: same canonical key so one approval covers all aliases.
  const askBash = createPolicyEngine({ defaultMode: "allow", toolRules: { bash: "ask" }, pathRules: [] });
  const viaBash = askBash.evaluate("bash", undefined, WS);
  const viaExec = askBash.evaluate("exec_command", undefined, WS);
  const viaShell = askBash.evaluate("kontrol-shell", undefined, WS);
  assert.equal(viaBash.mode, "ask");
  assert.equal(viaExec.mode, "ask", "exec_command inherits the bash ask rule");
  assert.equal(viaShell.mode, "ask", "kontrol-shell inherits the bash ask rule");
  assert.equal(viaBash.approvalKey, viaExec.approvalKey);
  assert.equal(viaBash.approvalKey, viaShell.approvalKey);
}

// ── P1.11: denial must NEVER be weakened into an approval ──
// If policy evaluates to deny, the enforcer must return allowed=false
// without consulting any approval state — even when the caller already
// holds a workspace grant for the same key. The new live-vs-durable
// separation must not silently promote a denied decision into an
// approval-worthy wait.
{
  const strictPolicy = createPolicyEngine({ defaultMode: "allow", toolRules: { bash: "deny" }, pathRules: [] });
  const strictEnforcer = createPolicyEnforcer(strictPolicy, eventStore, { timeoutMs: 100 });
  // Even with a pre-existing workspace grant, a freshly evaluated deny must
  // short-circuit before the wait path is even considered.
  strictPolicy.recordApproval("strict-principal", "tool:bash", "workspace", { workspaceId: WS });
  const denial = await strictEnforcer.enforce({
    principalId: "strict-principal",
    principalRole: "client",
    workspaceId: WS,
    tool: "bash",
  });
  assert.equal(denial.allowed, false, "denial never waits");
  assert.equal(denial.decision.mode, "deny", "decision.mode stays deny under the new live-vs-durable split");
  assert.equal(denial.outcome, undefined, "denial has no PolicyWaitOutcome (it never reached the wait)");

  // Path-rule deny is similarly immune to grants.
  const pathPolicy = createPolicyEngine(
    { defaultMode: "allow", toolRules: {}, pathRules: [{ pattern: "/etc/**", mode: "deny" }] },
  );
  const pathEnforcer = createPolicyEnforcer(pathPolicy, eventStore, { timeoutMs: 100 });
  const pathDenial = await pathEnforcer.enforce({
    principalId: "strict-principal",
    principalRole: "client",
    workspaceId: WS,
    tool: "write",
    path: "/etc/shadow",
  });
  assert.equal(pathDenial.allowed, false);
  assert.equal(pathDenial.decision.mode, "deny");
}

console.log("policy.test.ts: all assertions passed");
