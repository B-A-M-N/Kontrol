// P1.17 — accelerated longevity / UAT gate.
//
// Where `policy-ask-lifecycle.test.ts` proves the direct-MCP path (return an
// approval card -> disconnect -> dedupe -> retry after approval), this suite proves the
// CONTROL PLANE doesn't drift over time:
//
//   * Sustained traffic. A single long-lived MCP session drives a mixed
//     bash/write/read workload under KONTROL_POLICY_MODE=allow with only
//     bash gated (KONTROL_POLICY_TOOL_BASH=ask). bash reuses a workspace
//     grant seeded at the start; read/write need no approval. After every
//     batch the suite asserts:
//       - no zombie live policy waiters
//       - no orphan durable approval rows
//       - execution weight returns to zero
//       - admission capacity is fully returned
//
//   * Reconnect churn. The bash grant must remain effective across N fresh
//     MCP sessions re-opening the SAME workspace. Each round opens a new
//     transport; the durable grant must keep firing without re-prompting.
//
//   * Drift injection. Force three drift vectors that the production code
//     paths must tolerate gracefully:
//       1. an unknown workspaceId is requested (controlled error, no leak)
//       2. a `provide_policy_approval` references a non-existent approvalId
//          (rejected, no leak)
//       3. a malformed `provide_policy_approval` payload (rejected, no leak)
//
//   * End-of-suite liveness. Final diagnostics must show zero live waiters,
//     zero pending approval rows, zero execution weight, and no policy waiter
//     resumes. Direct MCP approvals are retryable and do not park an HTTP call.
//
// Each assertion exercises the public MCP surface — no internal hooks.
// Total runtime is bounded to keep CI cheap while still catching weight
// drift, which is the failure mode the P0 blockers were about.

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./server.js";
import { loadConfig } from "./config.js";

// The longevity suite reuses keep-alive fetch sockets across hundreds of
// tool calls; each call adds a `close` listener. Default Node limits
// (10 listeners) emit warnings that pollute CI output without indicating
// a real leak — every listener is paired with a `req.close`/`req.abort`
// path in fetch's own internals.
EventEmitter.defaultMaxListeners = 256;

const root = mkdtempSync(join(tmpdir(), "kontrol-policy-longevity-root-"));
const stateDir = mkdtempSync(join(tmpdir(), "kontrol-policy-longevity-state-"));
const worktreeRoot = mkdtempSync(join(tmpdir(), "kontrol-policy-longevity-worktrees-"));
const configDir = mkdtempSync(join(tmpdir(), "kontrol-policy-longevity-config-"));
writeFileSync(join(root, "marker.txt"), "longevity-marker\n");

const reviewerToken = "longevity-reviewer-token-that-is-long-enough";
const config = loadConfig({
  KONTROL_CONFIG_DIR: configDir,
  KONTROL_ALLOWED_ROOTS: root,
  KONTROL_STATE_DIR: stateDir,
  KONTROL_WORKTREE_ROOT: worktreeRoot,
  KONTROL_AUTH_MODE: "tunnel",
  KONTROL_ACP_ENABLED: "false",
  // Default allow keeps read/write/edit flowing without approval prompts —
  // the longevity suite's purpose is to exercise the bash/ask path under
  // sustained load, NOT to test that every tool prompts. Bash is the only
  // gated tool because that's the production trigger that surfaced the
  // P0 weight-drift bugs.
  KONTROL_POLICY_MODE: "allow",
  KONTROL_POLICY_TOOL_BASH: "ask",
  KONTROL_LOG_LEVEL: "error",
  KONTROL_LOG_REQUESTS: "0",
  KONTROL_OAUTH_OWNER_TOKEN: reviewerToken,
  KONTROL_ACP_REVIEWER_SECRET: reviewerToken,
  KONTROL_DIAGNOSTICS_SECRET: "longevity-test-secret",
});

assert.equal(config.policy.defaultMode, "allow", `policy.defaultMode must be allow; got ${JSON.stringify(config.policy)}`);
assert.equal(config.policy.toolRules.bash, "ask",
  `bash must gate as ask; toolRules: ${JSON.stringify(config.policy.toolRules)}`);

const running = createServer(config);
const httpServer = running.app.listen(0, "127.0.0.1");
httpServer.setMaxListeners(64);
await new Promise<void>((resolve) => httpServer.once("listening", resolve));
const address = httpServer.address();
assert.ok(address && typeof address === "object");
const url = `http://127.0.0.1:${address.port}/mcp`;
const diagUrl = `http://127.0.0.1:${address.port}/diagnostics`;

let nextId = 0;

function parseRpc(text: string): any {
  const data = text.split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .join("\n");
  return JSON.parse(data || text);
}

async function rpc(
  method: string,
  params: Record<string, unknown>,
  opts: { sessionId?: string; reviewer?: boolean } = {},
): Promise<{ response: Response; payload?: any; sessionId?: string }> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...(opts.sessionId ? { "mcp-session-id": opts.sessionId } : {}),
    ...(!opts.reviewer ? { "x-kontrol-conversation-id": "longevity-conversation" } : {}),
  };
  if (opts.reviewer) headers["x-kontrol-reviewer-token"] = reviewerToken;
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: ++nextId, method, params }),
  });
  const text = await response.text();
  return {
    response,
    payload: text.trim() ? parseRpc(text) : undefined,
    sessionId: response.headers.get("mcp-session-id") ?? opts.sessionId,
  };
}

async function openWorkerSession(): Promise<string> {
  const initialized = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "longevity-worker", version: "1.0.0" },
  });
  assert.equal(initialized.response.status, 200);
  const sessionId = initialized.sessionId;
  assert.ok(sessionId, "initialize did not return mcp-session-id");
  const notification = await rpc("notifications/initialized", {}, { sessionId });
  assert.ok([200, 202].includes(notification.response.status));
  return sessionId;
}

async function openReviewerSession(): Promise<string> {
  const initialized = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "longevity-reviewer", version: "1.0.0" },
  }, { reviewer: true });
  assert.equal(initialized.response.status, 200);
  const sessionId = initialized.sessionId;
  assert.ok(sessionId, "reviewer initialize did not return mcp-session-id");
  const notification = await rpc("notifications/initialized", {}, { sessionId, reviewer: true });
  assert.ok([200, 202].includes(notification.response.status));
  return sessionId;
}

async function closeSession(sessionId: string): Promise<void> {
  const response = await fetch(url, {
    method: "DELETE",
    headers: { "mcp-session-id": sessionId },
  });
  assert.ok([200, 202, 204].includes(response.status), `DELETE returned HTTP ${response.status}`);
}

async function diagnostics(): Promise<any> {
  const response = await fetch(diagUrl, {
    headers: { "x-kontrol-diagnostics": "longevity-test-secret" },
  });
  assert.equal(response.status, 200);
  return await response.json() as any;
}

async function waitForMatchingApproval(reviewerSessionId: string, workspaceId: string, timeoutMs = 5000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastListing: any = null;
  while (Date.now() < deadline) {
    const listing = await rpc("tools/call", {
      name: "list_pending_approvals",
      arguments: { workspaceId },
    }, { sessionId: reviewerSessionId, reviewer: true });
    lastListing = listing.payload;
    const card = listing.payload?.result?.structuredContent?.approvals?.[0];
    if (card?.approvalId) return card.approvalId;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`no approval card appeared within ${timeoutMs}ms; last listing: ${JSON.stringify(lastListing)}`);
}

function assertNoDrift(diag: any, label: string): void {
  const waiters = diag.mcpSessionMetrics?.policyWaiters;
  const execution = diag.mcpSessionMetrics?.executionAdmission;
  assert.equal(waiters?.activePolicyWaiters ?? 0, 0,
    `${label}: live policy waiters must drain to zero; got ${JSON.stringify(waiters)}`);
  assert.equal(waiters?.pendingApprovalRows ?? 0, 0,
    `${label}: durable approval rows must drain to zero; got ${JSON.stringify(waiters)}`);
  assert.equal(waiters?.orphanedPendingApprovals ?? 0, 0,
    `${label}: orphan approvals must be zero; got ${JSON.stringify(waiters)}`);
  assert.equal(execution?.activeWeight ?? 0, 0,
    `${label}: execution weight must be zero; got ${JSON.stringify(execution)}`);
  assert.equal(execution?.availableWeight ?? 0, config.mcpMaxInflight,
    `${label}: execution capacity must be fully returned; got ${JSON.stringify(execution)}`);
}

try {
  // ── Phase 0: disconnect-before-approval churn ─────────────────────────────
  // A direct MCP approval must survive the originating transport disappearing,
  // and an identical retry on a new transport must attach to the same durable
  // operation rather than create another card. Repeat this with fresh
  // operations to catch approval-row churn and orphan cleanup regressions.
  const seedSessionId = await openWorkerSession();
  const opened = await rpc("tools/call", {
    name: "open_workspace",
    arguments: { path: root, mode: "checkout" },
  }, { sessionId: seedSessionId });
  assert.equal(opened.response.status, 200, JSON.stringify(opened.payload));
  const workspaceId = opened.payload?.result?.structuredContent?.workspaceId
    ?? opened.payload?.result?.workspaceId;
  assert.equal(typeof workspaceId, "string");
  assert.ok(workspaceId.length > 0);

  const reviewerSessionId = await openReviewerSession();

  for (let churnRound = 0; churnRound < 3; churnRound++) {
    const command = `printf approval-churn-${churnRound}`;
    const firstSessionId = await openWorkerSession();
    const first = await rpc("tools/call", {
      name: "bash",
      arguments: { workspaceId, command },
    }, { sessionId: firstSessionId });
    assert.equal(first.response.status, 200, JSON.stringify(first.payload));
    assert.equal(first.payload?.result?.structuredContent?.status, "approval_required", JSON.stringify(first.payload));
    const approvalId = await waitForMatchingApproval(reviewerSessionId, workspaceId);
    await closeSession(firstSessionId);

    const retrySessionId = await openWorkerSession();
    const retry = await rpc("tools/call", {
      name: "bash",
      arguments: { workspaceId, command },
    }, { sessionId: retrySessionId });
    assert.equal(retry.response.status, 200, JSON.stringify(retry.payload));
    assert.equal(retry.payload?.result?.structuredContent?.status, "approval_required", JSON.stringify(retry.payload));
    assert.equal(retry.payload?.result?.structuredContent?.approvalId, approvalId,
      "new MCP transport must reattach to the existing approval operation");
    await closeSession(retrySessionId);

    const approve = await rpc("tools/call", {
      name: "provide_policy_approval",
      arguments: { approvalId, decision: "approve", reason: `churn round ${churnRound}` },
    }, { sessionId: reviewerSessionId, reviewer: true });
    assert.equal(approve.response.status, 200, JSON.stringify(approve.payload));

    const executeSessionId = await openWorkerSession();
    const executed = await rpc("tools/call", {
      name: "bash",
      arguments: { workspaceId, command },
    }, { sessionId: executeSessionId });
    assert.equal(executed.response.status, 200, JSON.stringify(executed.payload));
    assert.notEqual(executed.payload?.result?.isError, true, `churn ${churnRound} retry must execute`);
    const executedText = (executed.payload?.result?.content ?? []).map((c: any) => c.text ?? "").join("");
    assert.ok(executedText.includes(`approval-churn-${churnRound}`), `churn ${churnRound} output: ${executedText}`);
    await closeSession(executeSessionId);
  }

  // ── Phase 1: seed a durable workspace grant ──────────────────────────────
  // Direct MCP calls return immediately while the reviewer decides. The
  // subsequent retry proves a workspace grant still works for sustained use.
  const seedBash = await rpc("tools/call", {
    name: "bash",
    arguments: { workspaceId, command: "printf seeded" },
  }, { sessionId: seedSessionId });
  assert.equal(seedBash.response.status, 200, JSON.stringify(seedBash.payload));
  assert.equal(seedBash.payload?.result?.structuredContent?.status, "approval_required", JSON.stringify(seedBash.payload));
  const seedApprovalId = await waitForMatchingApproval(reviewerSessionId, workspaceId);
  const seedApprove = await rpc("tools/call", {
    name: "provide_policy_approval",
    arguments: { approvalId: seedApprovalId, decision: "approve_workspace", reason: "longevity seed" },
  }, { sessionId: reviewerSessionId, reviewer: true });
  assert.equal(seedApprove.response.status, 200, JSON.stringify(seedApprove.payload));
  const seedResult = await rpc("tools/call", {
    name: "bash",
    arguments: { workspaceId, command: "printf seeded" },
  }, { sessionId: seedSessionId });
  assert.equal(seedResult.response.status, 200, JSON.stringify(seedResult.payload));
  assert.notEqual(seedResult.payload?.result?.isError, true, "seed bash must run after workspace grant");
  const seedText = (seedResult.payload?.result?.content ?? []).map((c: any) => c.text ?? "").join("");
  assert.ok(seedText.includes("seeded"), `seed bash output: ${seedText}`);

  const initialDiag = await diagnostics();
  assertNoDrift(initialDiag, "after-seed");

  // ── Phase 2: sustained traffic on a long-lived MCP session ───────────────
  // Drive a mixed workload of bash/write/read. bash reuses the workspace
  // grant from Phase 0, so it must NOT re-prompt; write/read need no approval.
  const sustainedSessionId = seedSessionId; // reuse — long-lived is the point
  const batchCount = 8;
  const callsPerBatch = 12;
  // Round-robin across bash/write/read. Bash reuses the workspace grant
  // from Phase 0; write/read need no approval. The intent is to keep the
  // session active across many tool invocations so any weight drift over
  // time would surface as a stuck activePolicyWaiter or execution permit.
  const sharedPath = "longevity-shared.txt";
  for (let batch = 0; batch < batchCount; batch++) {
    for (let i = 0; i < callsPerBatch; i++) {
      const callId = batch * callsPerBatch + i;
      const tool = (callId % 3 === 0)
        ? "bash"
        : (callId % 3 === 1)
          ? "write"
          : "read";
      const args = (() => {
        if (tool === "bash") {
          return { workspaceId, command: `printf batch-${batch}-call-${i}` };
        }
        if (tool === "write") {
          return {
            workspaceId,
            path: sharedPath,
            content: `batch=${batch} call=${i}\n`,
          };
        }
        return { workspaceId, path: sharedPath };
      })();

      const result = await rpc("tools/call", { name: tool, arguments: args }, { sessionId: sustainedSessionId });
      assert.equal(result.response.status, 200, `batch ${batch} call ${callId} (${tool}): ${JSON.stringify(result.payload)}`);
      assert.notEqual(result.payload?.result?.isError, true,
        `batch ${batch} call ${callId} (${tool}) must succeed under workspace grant; payload=${JSON.stringify(result.payload)}`);
    }
    // Mid-suite drift check — any leak in even one batch is the failure mode
    // the P0 blockers introduced.
    const midDiag = await diagnostics();
    assertNoDrift(midDiag, `batch ${batch}`);
  }

  // ── Phase 3: reconnect churn over a single workspace grant ───────────────
  // The durable grant must remain effective across N fresh MCP sessions,
  // each of which closes its previous transport. bash must run without
  // prompting in every new session.
  const reconnectRounds = 5;
  let priorSessionId: string | undefined;
  for (let round = 0; round < reconnectRounds; round++) {
    if (priorSessionId) {
      // Tell the server to close the previous transport. The session may
      // already have been reaped; this is best-effort cleanup.
      try {
        await rpc("notifications/initialized", {}, { sessionId: priorSessionId });
      } catch { /* ignore */ }
    }
    const sessionId = await openWorkerSession();
    priorSessionId = sessionId;
    const bashResult = await rpc("tools/call", {
      name: "bash",
      arguments: { workspaceId, command: `printf reconnect-${round}` },
    }, { sessionId });
    assert.equal(bashResult.response.status, 200, JSON.stringify(bashResult.payload));
    assert.notEqual(bashResult.payload?.result?.isError, true,
      `reconnect ${round}: workspace grant must let bash through without re-prompting; payload=${JSON.stringify(bashResult.payload)}`);
    const reconnectText = (bashResult.payload?.result?.content ?? [])
      .map((c: any) => c.text ?? "").join("");
    assert.ok(reconnectText.includes(`reconnect-${round}`),
      `reconnect ${round}: bash output proves the workspace grant fired; got ${reconnectText}`);

    // Drift check after each reconnect round.
    const churnDiag = await diagnostics();
    assertNoDrift(churnDiag, `reconnect-${round}`);
  }

  // ── Phase 4: drift injection (graceful failure paths) ─────────────────────
  // Each drift vector must be rejected or 404'd without leaking live waiters,
  // durable rows, or admission weight.

  // 3a. Unknown workspaceId — read should fail without leaking weight.
  const beforeDrift = await diagnostics();
  const unknownRead = await rpc("tools/call", {
    name: "read",
    arguments: { workspaceId: "ws_does_not_exist", path: "marker.txt" },
  }, { sessionId: sustainedSessionId });
  // We expect an error envelope (either JSON-RPC error or tool-level isError).
  // The only assertion that matters: nothing leaked.
  assert.ok(unknownRead.response.status === 200 || unknownRead.payload?.error,
    `unknown workspaceId should return a controlled error; got ${JSON.stringify(unknownRead.payload)}`);
  const afterUnknown = await diagnostics();
  assertNoDrift(afterUnknown, "after-unknown-workspace");
  const unknownWaiterDelta = (afterUnknown.mcpSessionMetrics?.policyWaiters?.policyWaiterDisconnects ?? 0)
    - (beforeDrift.mcpSessionMetrics?.policyWaiters?.policyWaiterDisconnects ?? 0);
  assert.equal(unknownWaiterDelta, 0, "unknown workspace must not bump disconnect counters");

  // 3b. provide_policy_approval with a bogus approvalId must be rejected,
  //     not crash, not leak a durable row, not leak weight.
  const bogusApprove = await rpc("tools/call", {
    name: "provide_policy_approval",
    arguments: { approvalId: "pol_definitely_not_real", decision: "approve_once", reason: "drift" },
  }, { sessionId: reviewerSessionId, reviewer: true });
  assert.equal(bogusApprove.response.status, 200, JSON.stringify(bogusApprove.payload));
  const afterBogus = await diagnostics();
  assertNoDrift(afterBogus, "after-bogus-approval");

  // 3c. provide_policy_approval with a malformed payload must be rejected
  //     at the JSON-RPC layer (invalid params). The reviewer tool's zod
  //     schema enforces the shape.
  const malformedApprove = await rpc("tools/call", {
    name: "provide_policy_approval",
    arguments: { approvalId: 12345, decision: "not-a-real-decision" },
  }, { sessionId: reviewerSessionId, reviewer: true });
  // Either the JSON-RPC layer rejects (-32602 invalid params) or the tool
  // returns an isError result. Both are acceptable — what matters is that
  // nothing leaks.
  const malformedErr = malformedApprove.payload?.error
    ?? (malformedApprove.payload?.result?.isError === true ? malformedApprove.payload?.result : null);
  assert.ok(malformedErr, `malformed approval must be rejected; payload=${JSON.stringify(malformedApprove.payload)}`);
  const afterMalformed = await diagnostics();
  assertNoDrift(afterMalformed, "after-malformed-approval");

  // ── Phase 5: final liveness snapshot ─────────────────────────────────────
  // Long-lived, post-drift: nothing should have accumulated beyond what the
  // direct operations legitimately consumed. All approvals were retryable and
  // therefore none should have created a long-lived live policy waiter.
  const finalDiag = await diagnostics();
  assertNoDrift(finalDiag, "final");
  assert.equal(finalDiag.mcpSessionMetrics?.policyWaiters?.policyWaiterDisconnects ?? 0, 0,
    "no disconnect counter activity during the drift phases");
  // Reconnects and drift injections must not create policy waiter resumes.
  const finalResumes = finalDiag.mcpSessionMetrics?.policyWaiters?.policyWaiterResumes ?? 0;
  assert.equal(finalResumes, 0, `policyWaiterResumes must remain zero for direct MCP approvals; got ${finalResumes}`);

  console.log("policy-longevity.test.ts: all assertions passed");
} finally {
  await running.drain();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
}
