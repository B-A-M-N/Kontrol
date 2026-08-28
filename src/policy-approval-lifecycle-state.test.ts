// P1 — honest lifecycle classification for direct MCP approvals.
//
// A direct (non-blocking) approval returns approval_required immediately, so
// liveWaiterCount 0 is its EXPECTED shape: it is pending_human_approval, not
// orphaned. The card must stay decidable for its normal approval TTL; only
// after its reattachment window actually elapses (no retry arrived) is it an
// abandoned operation. Diagnostics must report the three concepts separately
// instead of collapsing "no live waiter" into "orphaned".
//
// All assertions exercise the public MCP surface — no internal hooks.

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./server.js";
import { loadConfig } from "./config.js";

const root = mkdtempSync(join(tmpdir(), "kontrol-approval-state-root-"));
const stateDir = mkdtempSync(join(tmpdir(), "kontrol-approval-state-state-"));
const worktreeRoot = mkdtempSync(join(tmpdir(), "kontrol-approval-state-worktrees-"));
const configDir = mkdtempSync(join(tmpdir(), "kontrol-approval-state-config-"));
writeFileSync(join(root, "marker.txt"), "approval-state-marker\n");

const reviewerToken = "approval-state-reviewer-token-that-is-long-enough";
const config = loadConfig({
  KONTROL_CONFIG_DIR: configDir,
  KONTROL_ALLOWED_ROOTS: root,
  KONTROL_STATE_DIR: stateDir,
  KONTROL_WORKTREE_ROOT: worktreeRoot,
  KONTROL_AUTH_MODE: "tunnel",
  KONTROL_ACP_ENABLED: "false",
  KONTROL_POLICY_MODE: "ask",
  KONTROL_LOG_LEVEL: "error",
  KONTROL_LOG_REQUESTS: "0",
  KONTROL_OAUTH_OWNER_TOKEN: reviewerToken,
  KONTROL_ACP_REVIEWER_SECRET: reviewerToken,
  KONTROL_DIAGNOSTICS_SECRET: "approval-state-test-secret",
});

const running = createServer(config);
const httpServer = running.app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => httpServer.once("listening", resolve));
const address = httpServer.address();
assert.ok(address && typeof address === "object");
const url = `http://127.0.0.1:${address.port}/mcp`;

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
    ...(!opts.reviewer ? { "x-kontrol-conversation-id": "approval-state-conversation" } : {}),
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

async function openWorkspaceSession(): Promise<{ sessionId: string; workspaceId: string }> {
  const initialized = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "approval-state-test-client", version: "1.0.0" },
  });
  assert.equal(initialized.response.status, 200);
  const sessionId = initialized.sessionId;
  assert.ok(sessionId, "initialize did not return mcp-session-id");
  const notification = await rpc("notifications/initialized", {}, { sessionId });
  assert.ok([200, 202].includes(notification.response.status));
  const opened = await rpc("tools/call", {
    name: "open_workspace",
    arguments: { path: root, mode: "checkout" },
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
    clientInfo: { name: "approval-state-reviewer", version: "1.0.0" },
  }, { reviewer: true });
  assert.equal(initialized.response.status, 200);
  const sessionId = initialized.sessionId;
  assert.ok(sessionId, "reviewer initialize did not return mcp-session-id");
  const notification = await rpc("notifications/initialized", {}, { sessionId, reviewer: true });
  assert.ok([200, 202].includes(notification.response.status));
  return sessionId;
}

async function listApprovals(reviewerSessionId: string, workspaceId: string): Promise<any[]> {
  const listing = await rpc("tools/call", {
    name: "list_pending_approvals",
    arguments: { workspaceId },
  }, { sessionId: reviewerSessionId, reviewer: true });
  assert.equal(listing.response.status, 200, JSON.stringify(listing.payload));
  return listing.payload?.result?.structuredContent?.approvals ?? [];
}

async function diagnostics(): Promise<any> {
  const response = await fetch(new URL("/diagnostics", url), {
    headers: { "x-kontrol-diagnostics": "approval-state-test-secret" },
  });
  assert.equal(response.status, 200);
  return await response.json() as any;
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 5_000, label = "predicate"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`timed out waiting for ${label} after ${timeoutMs}ms`);
}

try {
  const { sessionId, workspaceId } = await openWorkspaceSession();
  const reviewerSessionId = await openReviewerSession();

  // A direct approval returns immediately: zero live waiters is normal.
  const blocked = await rpc("tools/call", {
    name: "bash",
    arguments: { workspaceId, command: "printf approval-state-runs" },
  }, { sessionId });
  assert.equal(blocked.response.status, 200, JSON.stringify(blocked.payload));
  const approvalId = blocked.payload?.result?.structuredContent?.approvalId;
  assert.equal(typeof approvalId, "string");

  await waitFor(
    async () => (await listApprovals(reviewerSessionId, workspaceId)).some((card) => card.approvalId === approvalId),
    5_000,
    "approval card",
  );
  const card = (await listApprovals(reviewerSessionId, workspaceId)).find((entry) => entry.approvalId === approvalId);
  assert.ok(card, "approval card is listed for the reviewer");
  assert.equal(card.origin, "direct_mcp");
  assert.equal(card.liveWaiterCount, 0, "a direct approval has no parked waiter by design");
  // The classification must say "awaiting a human", not "orphaned".
  assert.equal(card.state, "pending_human_approval",
    `zero live waiters must not be misreported as orphaned; got ${JSON.stringify(card)}`);
  // P1: a direct card is BORN pending_human_approval — no orphan timestamp,
  // no reattachment deadline. Its lifetime is the human approval TTL, so
  // nothing about being brand-new may look abandoned.
  assert.equal(card.orphanedAt ?? null, null,
    `a fresh direct approval must not carry an orphan timestamp; got ${JSON.stringify(card)}`);
  assert.equal(card.reattachDeadline ?? null, null,
    `a fresh direct approval must not carry a reattachment deadline; got ${JSON.stringify(card)}`);

  // Diagnostics report the three lifecycle concepts separately.
  const diag = await diagnostics();
  const waiters = diag.mcpSessionMetrics?.policyWaiters;
  assert.ok(waiters, "policy waiter diagnostics are exposed");
  assert.equal(waiters.activePolicyWaiters, 0, "direct approvals park no live waiter");
  assert.ok((waiters.pendingApprovalRows ?? 0) >= 1, "the durable direct card is pending");
  assert.ok((waiters.pendingHumanApproval ?? 0) >= 1,
    `pendingHumanApproval must count the awaiting-human direct card; got ${JSON.stringify(waiters)}`);
  assert.equal(waiters.detachedLiveWaiters, 0, "no work-session waiter detached");
  // Retained for compatibility with the existing longevity gate, but it must
  // agree with the abandoned-operation count, not with "no live waiter".
  assert.equal(waiters.orphanedPendingApprovals, waiters.abandonedOperations,
    "orphanedPendingApprovals must mean abandoned operations, not zero-waiter direct cards");

  // The card is still decidable well after any short "reattach" heuristic
  // would have fired, and approving it resolves cleanly.
  const approve = await rpc("tools/call", {
    name: "provide_policy_approval",
    arguments: { approvalId, decision: "deny", reason: "denied after honest classification" },
  }, { sessionId: reviewerSessionId, reviewer: true });
  assert.equal(approve.response.status, 200, JSON.stringify(approve.payload));
  assert.notEqual(approve.payload?.result?.isError, true, "reviewer decision must succeed on a zero-waiter direct card");

  await waitFor(
    async () => !(await listApprovals(reviewerSessionId, workspaceId)).some((entry) => entry.approvalId === approvalId),
    5_000,
    "resolved card removal",
  );
  const afterResolve = await diagnostics();
  assert.equal(afterResolve.mcpSessionMetrics?.policyWaiters?.pendingApprovalRows ?? 0, 0,
    `resolved direct card leaves no pending row: ${JSON.stringify(afterResolve.mcpSessionMetrics?.policyWaiters)}`);

  console.log("policy-approval-lifecycle-state.test.ts: all assertions passed");
} finally {
  await running.drain();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
}
