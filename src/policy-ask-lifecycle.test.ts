// P0.5 — ask-mode end-to-end approval lifecycle through createServer.
//
// Walks the same path the production WebUI exercises:
//   1. worker (default principalRole) opens an MCP session over the wire
//   2. worker invokes `bash` against a workspace whose defaultMode is "ask"
//   3. request returns a durable retryable approval card
//   4. reviewer sees the card via list_pending_approvals (reviewer header)
//   5. reviewer provides a one-shot approval
//   6. the parked bash invocation unblocks and runs
//   7. a fresh operation receives a workspace-scoped approval and survives a
//      reconnect without prompting again
//
// All assertions exercise the public MCP surface — no internal hooks.

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./server.js";
import { loadConfig } from "./config.js";

// The resume-identity block opens a SECOND workspace; a shared parent root
// lets one KONTROL_ALLOWED_ROOTS entry cover both.
const rootParent = mkdtempSync(join(tmpdir(), "kontrol-policy-ask-parent-"));
const root = mkdtempSync(join(rootParent, "primary-ws"));
const resumeRoot = mkdtempSync(join(rootParent, "resume-ws"));
const stateDir = mkdtempSync(join(tmpdir(), "kontrol-policy-ask-state-"));
const worktreeRoot = mkdtempSync(join(tmpdir(), "kontrol-policy-ask-worktrees-"));
const configDir = mkdtempSync(join(tmpdir(), "kontrol-policy-ask-config-"));
writeFileSync(join(root, "marker.txt"), "ask-mode-marker\n");

const reviewerToken = "ask-mode-reviewer-token-that-is-long-enough";
const config = loadConfig({
  KONTROL_CONFIG_DIR: configDir,
  KONTROL_ALLOWED_ROOTS: rootParent,
  KONTROL_STATE_DIR: stateDir,
  KONTROL_WORKTREE_ROOT: worktreeRoot,
  KONTROL_AUTH_MODE: "tunnel",
  KONTROL_ACP_ENABLED: "false",
  // The whole point of this test: KONTROL_POLICY_MODE=ask, not allow.
  KONTROL_POLICY_MODE: "ask",
  KONTROL_LOG_LEVEL: "error",
  KONTROL_LOG_REQUESTS: "0",
  KONTROL_OAUTH_OWNER_TOKEN: reviewerToken,
  KONTROL_ACP_REVIEWER_SECRET: reviewerToken,
  KONTROL_DIAGNOSTICS_SECRET: "ask-mode-test-secret",
});

// Sanity: secure baseline should NOT silently suppress ask.
assert.equal(config.policy.defaultMode, "ask", `policy.defaultMode must be ask; got ${JSON.stringify(config.policy)}`);
assert.equal(config.policy.toolRules.bash ?? "ask", "ask", `bash must gate as ask; toolRules: ${JSON.stringify(config.policy.toolRules)}`);

const running = createServer(config);
const httpServer = running.app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => httpServer.once("listening", resolve));
const address = httpServer.address();
assert.ok(address && typeof address === "object");
const url = `http://127.0.0.1:${address.port}/mcp`;

assert.equal(config.policy.defaultMode, "ask", `policy default mode must be ask; got ${JSON.stringify(config.policy)}`);

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
    ...(!opts.reviewer ? { "x-kontrol-conversation-id": "ask-mode-conversation" } : {}),
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

async function openWorkspace(label = "ask-mode-test-client", path = root): Promise<{ sessionId: string; workspaceId: string }> {
  const initialized = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: label, version: "1.0.0" },
  });
  assert.equal(initialized.response.status, 200);
  const sessionId = initialized.sessionId;
  assert.ok(sessionId, "initialize did not return mcp-session-id");
  const notification = await rpc("notifications/initialized", {}, { sessionId });
  assert.ok([200, 202].includes(notification.response.status));
  const opened = await rpc("tools/call", {
    name: "open_workspace",
    arguments: { path, mode: "checkout" },
  }, { sessionId });
  assert.equal(opened.response.status, 200, JSON.stringify(opened.payload));
  const workspaceId = opened.payload?.result?.structuredContent?.workspaceId
    ?? opened.payload?.result?.workspaceId;
  assert.equal(typeof workspaceId, "string");
  return { sessionId, workspaceId };
}

async function openReviewerSession(): Promise<string> {
  const initialized = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "ask-mode-reviewer", version: "1.0.0" },
  }, { reviewer: true });
  assert.equal(initialized.response.status, 200);
  const sessionId = initialized.sessionId;
  assert.ok(sessionId, "reviewer initialize did not return mcp-session-id");
  const notification = await rpc("notifications/initialized", {}, { sessionId, reviewer: true });
  assert.ok([200, 202].includes(notification.response.status));
  return sessionId;
}

async function waitForMatchingApproval(reviewerSessionId: string, workspaceId: string, timeoutMs = 5000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastListing: any = null;
  let lastDiagnostics: any = null;
  while (Date.now() < deadline) {
    const listing = await rpc("tools/call", {
      name: "list_pending_approvals",
      arguments: { workspaceId },
    }, { sessionId: reviewerSessionId, reviewer: true });
    lastListing = listing.payload;
    const card = listing.payload?.result?.structuredContent?.approvals?.[0];
    if (card?.approvalId) return card.approvalId;
    lastDiagnostics = await diagnostics();
    if ((lastDiagnostics?.mcpSessionMetrics?.pendingApprovalRows ?? 0) > 0
      || (lastDiagnostics?.mcpSessionMetrics?.activePolicyWaiters ?? 0) > 0) {
      // Some approval state exists; keep waiting.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`no approval card appeared within ${timeoutMs}ms; last listing: ${JSON.stringify(lastListing)}; diagnostics: ${JSON.stringify(lastDiagnostics?.mcpSessionMetrics)}`);
}

async function diagnostics(): Promise<any> {
  const response = await fetch(new URL("/diagnostics", url), {
    headers: { "x-kontrol-diagnostics": "ask-mode-test-secret" },
  });
  assert.equal(response.status, 200);
  return await response.json() as any;
}

async function waitFor<T>(predicate: () => Promise<T | null | undefined>, timeoutMs = 2000, message = "predicate"): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value as T;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`timed out waiting for ${message} after ${timeoutMs}ms`);
}

try {
  const { sessionId, workspaceId } = await openWorkspace();
  const reviewerSessionId = await openReviewerSession();
  assert.ok(workspaceId.length > 0, "workspaceId returned from open_workspace");

  // Direct MCP policy prompts are durable, non-blocking operations. The first
  // call returns the retry card immediately; a new transport can attach to
  // the same operation before a reviewer decides.
  const firstBash = await rpc("tools/call", {
    name: "bash",
    arguments: { workspaceId, command: "printf ask-mode-runs" },
  }, { sessionId });
  assert.equal(firstBash.response.status, 200, JSON.stringify(firstBash.payload));
  assert.equal(firstBash.payload?.result?.structuredContent?.status, "approval_required", JSON.stringify(firstBash.payload));
  assert.equal(firstBash.payload?.result?.structuredContent?.retryable, true, JSON.stringify(firstBash.payload));

  // Reviewer should see a durable approval card with the canonical options.
  const approvalId = await waitForMatchingApproval(reviewerSessionId, workspaceId);
  assert.ok(approvalId.startsWith("pol_"), `approval id is server-generated: ${approvalId}`);

  // Simulate the original HTTP transport disappearing and the host retrying
  // on a fresh MCP session while approval is still pending. The durable
  // operation fingerprint must prevent a duplicate approval row.
  const reconnectInit = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "ask-mode-reconnect", version: "1.0.0" },
  });
  assert.equal(reconnectInit.response.status, 200);
  const reconnectSessionId = reconnectInit.sessionId!;
  assert.ok(reconnectSessionId, "reconnect initialize did not return mcp-session-id");
  await rpc("notifications/initialized", {}, { sessionId: reconnectSessionId });
  const retryBeforeApproval = await rpc("tools/call", {
    name: "bash",
    arguments: { workspaceId, command: "printf ask-mode-runs" },
  }, { sessionId: reconnectSessionId });
  assert.equal(retryBeforeApproval.response.status, 200, JSON.stringify(retryBeforeApproval.payload));
  assert.equal(retryBeforeApproval.payload?.result?.structuredContent?.status, "approval_required");
  assert.equal(retryBeforeApproval.payload?.result?.structuredContent?.approvalId, approvalId);
  const pendingAfterRetry = await rpc("tools/call", {
    name: "list_pending_approvals",
    arguments: { workspaceId },
  }, { sessionId: reviewerSessionId, reviewer: true });
  assert.equal(pendingAfterRetry.payload?.result?.structuredContent?.count, 1, "retry must not create a duplicate card");

  // Reviewer approves this durable operation once. The subsequent retry must
  // consume the resolved operation result exactly once.
  const approveResult = await rpc("tools/call", {
    name: "provide_policy_approval",
    arguments: { approvalId, decision: "approve", reason: "approved for this operation" },
  }, { sessionId: reviewerSessionId, reviewer: true });
  assert.equal(approveResult.response.status, 200, JSON.stringify(approveResult.payload));
  assert.notEqual(approveResult.payload?.result?.isError, true, "approve once must succeed");

  // The retry executes after the reviewer approves the durable operation.
  const finalBash = await rpc("tools/call", {
    name: "bash",
    arguments: { workspaceId, command: "printf ask-mode-runs" },
  }, { sessionId: reconnectSessionId });
  assert.equal(finalBash.response.status, 200, JSON.stringify(finalBash.payload));
  assert.notEqual(finalBash.payload?.result?.isError, true, `bash invocation should have run after approval: ${JSON.stringify(finalBash.payload)}`);
  // The bash command writes "ask-mode-runs" — verify the actual command output
  // appears in the response payload.
  const outputText = (finalBash.payload?.result?.content ?? [])
    .map((chunk: any) => chunk.text ?? "")
    .join("");
  assert.ok(outputText.includes("ask-mode-runs"), `bash output proves execution ran: ${outputText}`);

  // A different operation still needs a decision, proving that the one-shot
  // result above did not accidentally become a broad workspace grant.
  const secondBashPending = await rpc("tools/call", {
    name: "bash",
    arguments: { workspaceId, command: "printf second-run" },
  }, { sessionId });
  assert.equal(secondBashPending.response.status, 200, JSON.stringify(secondBashPending.payload));
  assert.equal(secondBashPending.payload?.result?.structuredContent?.status, "approval_required", JSON.stringify(secondBashPending.payload));
  const workspaceApprovalId = await waitForMatchingApproval(reviewerSessionId, workspaceId);
  const workspaceApproval = await rpc("tools/call", {
    name: "provide_policy_approval",
    arguments: { approvalId: workspaceApprovalId, decision: "approve_workspace", reason: "trusted for this workspace" },
  }, { sessionId: reviewerSessionId, reviewer: true });
  assert.notEqual(workspaceApproval.payload?.result?.isError, true, "approve workspace must succeed");
  const secondBash = await rpc("tools/call", {
    name: "bash",
    arguments: { workspaceId, command: "printf second-run" },
  }, { sessionId });
  assert.equal(secondBash.response.status, 200, JSON.stringify(secondBash.payload));
  assert.notEqual(secondBash.payload?.result?.isError, true, `second bash call must reuse the workspace grant: ${JSON.stringify(secondBash.payload)}`);
  const secondText = (secondBash.payload?.result?.content ?? [])
    .map((chunk: any) => chunk.text ?? "")
    .join("");
  assert.ok(secondText.includes("second-run"), `second bash output proves the workspace grant fired: ${secondText}`);

  // ── P0.6: proxy-timeout / reconnect regression ────────────────────────────
  // A scripted upstream proxy that closed the socket (e.g. tunnel timed out
  // and the call resumed on a new TCP connection) used to leave the parked
  // approval row waiting forever. With the req.socket close hook the live
  // waiter detaches, but the durable card stays. The workspace grant
  // recorded above must remain effective for a fresh MCP session opened
  // against the same workspace.
  // The reconnecting session is in the same workspace; the workspace grant
  // recorded above must let this invocation through without a new approval
  // card. If the durable grant were lost on reconnect this would block.
  const reconnectBash = await rpc("tools/call", {
    name: "bash",
    arguments: { workspaceId, command: "printf post-reconnect" },
  }, { sessionId: reconnectSessionId });
  assert.equal(reconnectBash.response.status, 200, JSON.stringify(reconnectBash.payload));
  assert.notEqual(reconnectBash.payload?.result?.isError, true,
    `reconnect must reuse the workspace grant, not re-prompt: ${JSON.stringify(reconnectBash.payload)}`);
  const reconnectText = (reconnectBash.payload?.result?.content ?? [])
    .map((chunk: any) => chunk.text ?? "")
    .join("");
  assert.ok(reconnectText.includes("post-reconnect"), `reconnect bash ran: ${reconnectText}`);

  // No zombie policy waiters or orphan durable cards remain.
  const finalDiag = await diagnostics();
  assert.equal(finalDiag.mcpSessionMetrics?.policyWaiters?.activePolicyWaiters ?? 0, 0,
    `no zombie policy waiters survive reconnect/approval: ${JSON.stringify(finalDiag.mcpSessionMetrics?.policyWaiters)}`);
  assert.equal(finalDiag.mcpSessionMetrics?.policyWaiters?.pendingApprovalRows ?? 0, 0,
    `durable card resolved after reviewer decision: ${JSON.stringify(finalDiag.mcpSessionMetrics?.policyWaiters)}`);

  // ── P0.2 (unit-level): transport-cancellation → caller_gone ────────────────
  // The full socket-close path is exercised in src/policy.test.ts via the
  // AbortController + signal injection. Here we only need to confirm that
  // the MCP transport wires the live waiter's signal up to the requestAbort
  // stream, so that any disconnect downstream (proxy timeout, tunnel drop,
  // browser refresh) cancels the waiter. The diagnostics show the count
  // reaches 0 after the lifecycle above — no zombie waiters.

  // ── P1: explicit opaque operation-resume identity ─────────────────────────
  // A second workspace keeps this isolated from the workspace grant recorded
  // above (grants never cross workspaceIds). Here the host reconnects WITHOUT
  // the x-kontrol-conversation-id header, so the operation fingerprint would
  // normally change and the human's original "Approve Once" would be lost —
  // the exact gap the resume identity exists to close.
  {
    // A dedicated root guarantees a distinct workspaceId — opening the same
    // path returns the durable existing workspace, which would inherit the
    // earlier workspace grant and bypass the prompt this block must see.
    writeFileSync(join(resumeRoot, "marker.txt"), "resume-marker\n");
    const resumeWs = await openWorkspace("ask-mode-resume-client", resumeRoot);
    const resumeSessionId = resumeWs.sessionId;
    const resumeWorkspaceId = resumeWs.workspaceId;

    const resumeFirst = await rpc("tools/call", {
      name: "bash",
      arguments: { workspaceId: resumeWorkspaceId, command: "printf resume-runs" },
    }, { sessionId: resumeSessionId });
    assert.equal(resumeFirst.response.status, 200, JSON.stringify(resumeFirst.payload));
    assert.equal(resumeFirst.payload?.result?.structuredContent?.status, "approval_required");
    const resumeApprovalId = resumeFirst.payload?.result?.structuredContent?.approvalId;
    assert.ok(typeof resumeApprovalId === "string" && resumeApprovalId.startsWith("pol_"));

    // Reviewer approves ONCE before the reconnect.
    const resumeApprove = await rpc("tools/call", {
      name: "provide_policy_approval",
      arguments: { approvalId: resumeApprovalId, decision: "approve", reason: "resume-once" },
    }, { sessionId: reviewerSessionId, reviewer: true });
    assert.notEqual(resumeApprove.payload?.result?.isError, true, "resume approve-once must succeed");

    // Reconnect WITHOUT the conversation header and retry with the echoed
    // approvalResumeId. Without the resume token this retry would fingerprint
    // as a brand-new operation and prompt again despite the human decision.
    const resumeReconnectInit = await rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "ask-mode-resume-reconnect", version: "1.0.0" },
    });
    assert.equal(resumeReconnectInit.response.status, 200);
    const resumeReconnectSessionId = resumeReconnectInit.sessionId!;
    await rpc("notifications/initialized", {}, { sessionId: resumeReconnectSessionId });
    const resumeRetry = await rpc("tools/call", {
      name: "bash",
      arguments: {
        workspaceId: resumeWorkspaceId,
        command: "printf resume-runs",
        approvalResumeId: resumeApprovalId,
      },
    }, { sessionId: resumeReconnectSessionId });
    assert.equal(resumeRetry.response.status, 200, JSON.stringify(resumeRetry.payload));
    assert.notEqual(resumeRetry.payload?.result?.isError, true,
      `resumed retry must consume the original approval without re-prompting: ${JSON.stringify(resumeRetry.payload)}`);
    const resumeText = (resumeRetry.payload?.result?.content ?? [])
      .map((chunk: any) => chunk.text ?? "")
      .join("");
    assert.ok(resumeText.includes("resume-runs"), `resumed retry executed: ${resumeText}`);

    // The one-shot result is consumed: a second resumed retry prompts again.
    const resumeSecond = await rpc("tools/call", {
      name: "bash",
      arguments: {
        workspaceId: resumeWorkspaceId,
        command: "printf resume-runs",
        approvalResumeId: resumeApprovalId,
      },
    }, { sessionId: resumeReconnectSessionId });
    assert.equal(resumeSecond.payload?.result?.structuredContent?.status, "approval_required",
      "one-shot approval must not survive a second resumed retry");

    // Content binding: the SAME id with a DIFFERENT command never adopts the
    // original decision — it prompts as its own fresh operation.
    const resumeTamper = await rpc("tools/call", {
      name: "bash",
      arguments: {
        workspaceId: resumeWorkspaceId,
        command: "printf tampered-operation",
        approvalResumeId: resumeApprovalId,
      },
    }, { sessionId: resumeReconnectSessionId });
    assert.equal(resumeTamper.payload?.result?.structuredContent?.status, "approval_required",
      "tampered resume content must re-prompt");
    assert.notEqual(resumeTamper.payload?.result?.structuredContent?.approvalId, resumeApprovalId,
      "tampered resume must create its own durable row");
  }

  console.log("policy-ask-lifecycle.test.ts: all assertions passed");
} finally {
  await running.drain();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
}
