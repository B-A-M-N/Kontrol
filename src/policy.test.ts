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
assert.equal(cfgWithBadTool.toolRules.write, undefined);

const cfg = loadPolicyConfig(baseEnv);
assert.equal(cfg.defaultMode, "allow");

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

console.log("policy.test.ts: all assertions passed");
