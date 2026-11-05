// P0 — shared process control surface across tool modes.
//
// A non-Codex (minimal-mode) MCP client must be able to launch (explicit
// TTY/timeout/idempotency/policy), observe (read-only cursor), and — when
// authorized — interact (stdin/resize under separate authorization), while a
// pure observer cannot inject input. All assertions exercise the public MCP
// surface in KONTROL_TOOL_MODE=minimal with KONTROL_POLICY_MODE=ask.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./server.js";
import { loadConfig } from "./config.js";

const root = mkdtempSync(join(tmpdir(), "kontrol-process-control-modes-root-"));
const stateDir = mkdtempSync(join(tmpdir(), "kontrol-process-control-modes-state-"));
const worktreeRoot = mkdtempSync(join(tmpdir(), "kontrol-process-control-modes-worktrees-"));
const reviewerToken = "process-control-modes-reviewer-token-long-enough";
const config = loadConfig({
  KONTROL_CONFIG_DIR: mkdtempSync(join(tmpdir(), "kontrol-process-control-modes-config-")),
  KONTROL_ALLOWED_ROOTS: root,
  KONTROL_STATE_DIR: stateDir,
  KONTROL_WORKTREE_ROOT: worktreeRoot,
  KONTROL_AUTH_MODE: "tunnel",
  KONTROL_ACP_ENABLED: "false",
  KONTROL_TOOL_MODE: "minimal",
  KONTROL_POLICY_MODE: "ask",
  KONTROL_LOG_LEVEL: "error",
  KONTROL_LOG_REQUESTS: "0",
  KONTROL_OAUTH_OWNER_TOKEN: reviewerToken,
  KONTROL_ACP_REVIEWER_SECRET: reviewerToken,
  KONTROL_DIAGNOSTICS_SECRET: "process-control-modes-secret",
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
  options: { sessionId?: string; conversationId?: string; reviewer?: boolean } = {},
): Promise<{ response: Response; payload?: any; sessionId?: string }> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(options.sessionId ? { "mcp-session-id": options.sessionId } : {}),
      ...(!options.reviewer && options.conversationId ? { "x-kontrol-conversation-id": options.conversationId } : {}),
      ...(options.reviewer ? { "x-kontrol-reviewer-token": reviewerToken } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++nextId, method, params }),
  });
  const text = await response.text();
  return {
    response,
    payload: text.trim() ? parseRpc(text) : undefined,
    sessionId: response.headers.get("mcp-session-id") ?? options.sessionId,
  };
}

async function openSession(conversationId: string, reviewer = false): Promise<{ sessionId: string; workspaceId?: string }> {
  const initialized = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "process-control-modes-test", version: "1.0.0" },
  }, { conversationId, reviewer });
  assert.equal(initialized.response.status, 200, JSON.stringify(initialized.payload));
  const sessionId = initialized.sessionId;
  assert.ok(sessionId, "initialize did not return mcp-session-id");
  await rpc("notifications/initialized", {}, { sessionId, conversationId, reviewer });
  if (reviewer) return { sessionId };
  const opened = await rpc("tools/call", {
    name: "open_workspace",
    arguments: { path: root, mode: "checkout" },
  }, { sessionId, conversationId });
  assert.equal(opened.response.status, 200, JSON.stringify(opened.payload));
  const workspaceId = opened.payload?.result?.structuredContent?.workspaceId;
  assert.equal(typeof workspaceId, "string", JSON.stringify(opened.payload));
  return { sessionId, workspaceId };
}

async function waitForApproval(reviewerSessionId: string, workspaceId: string, timeoutMs = 8000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const listing = await rpc("tools/call", {
      name: "list_pending_approvals",
      arguments: { workspaceId },
    }, { sessionId: reviewerSessionId, reviewer: true });
    const card = listing.payload?.result?.structuredContent?.approvals?.[0];
    if (card?.approvalId) return card.approvalId;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail("no approval card appeared for the process control operation");
}

async function approve(reviewerSessionId: string, approvalId: string): Promise<void> {
  const result = await rpc("tools/call", {
    name: "provide_policy_approval",
    arguments: { approvalId, decision: "approve", reason: "process-control-modes test" },
  }, { sessionId: reviewerSessionId, reviewer: true });
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  assert.notEqual(result.payload?.result?.isError, true, JSON.stringify(result.payload));
}

function structuredContent(payload: any): any {
  return payload?.result?.structuredContent;
}

try {
  const worker = await openSession("process-control-conversation");
  const reviewerSessionId = (await openSession("process-control-reviewer", true)).sessionId;
  const workspaceId = worker.workspaceId!;

  // The launch/interact tools are registered outside Codex mode.
  const catalog = await rpc("tools/list", {}, { sessionId: worker.sessionId });
  const names = (catalog.payload?.result?.tools ?? []).map((tool: any) => tool.name);
  assert.ok(names.includes("exec_command"), "minimal mode lists exec_command");
  assert.ok(names.includes("write_stdin"), "minimal mode lists write_stdin");
  assert.ok(names.includes("poll_process"), "minimal mode lists poll_process");

  // Launch with an explicit TTY choice is policy-gated in minimal mode.
  const launchArgs = {
    workspaceId,
    cmd: "sleep 30",
    tty: true,
    columns: 80,
    rows: 24,
    yieldTimeMs: 500,
    clientMutationId: "process-control-launch-1",
  };
  const gated = await rpc("tools/call", { name: "exec_command", arguments: launchArgs }, { sessionId: worker.sessionId });
  assert.equal(gated.response.status, 200, JSON.stringify(gated.payload));
  assert.equal(structuredContent(gated.payload)?.status, "approval_required", "TTY launch needs authorization");
  assert.equal(structuredContent(gated.payload)?.retryable, true);

  // Reviewer approval authorizes the exact launch; the retry runs it.
  await approve(reviewerSessionId, await waitForApproval(reviewerSessionId, workspaceId));
  const launched = await rpc("tools/call", { name: "exec_command", arguments: launchArgs }, { sessionId: worker.sessionId });
  assert.equal(launched.response.status, 200, JSON.stringify(launched.payload));
  assert.notEqual(structuredContent(launched.payload)?.status, "approval_required", JSON.stringify(launched.payload));
  const sessionId = structuredContent(launched.payload)?.sessionId
    ?? launched.payload?.result?.structuredContent?.session?.sessionId;
  assert.equal(typeof sessionId, "string", `launch must return a process session: ${JSON.stringify(launched.payload)}`);

  // Read-only observation needs no command approval.
  const observed = await rpc("tools/call", {
    name: "poll_process",
    arguments: { workspaceId, sessionId, yieldTimeMs: 500, maxOutputTokens: 100 },
  }, { sessionId: worker.sessionId });
  assert.equal(observed.response.status, 200, JSON.stringify(observed.payload));
  assert.notEqual(structuredContent(observed.payload)?.status, "approval_required", "pure observation stays read-only");

  // A PTY resize carries no input but still steers the session: it needs
  // its own authorization, separate from stdin.
  const resizeArgs = { workspaceId, sessionId, columns: 100, rows: 30 };
  const resizeGated = await rpc("tools/call", { name: "write_stdin", arguments: resizeArgs }, { sessionId: worker.sessionId });
  assert.equal(resizeGated.response.status, 200, JSON.stringify(resizeGated.payload));
  assert.equal(structuredContent(resizeGated.payload)?.status, "approval_required", "resize-only write_stdin needs authorization");
  await approve(reviewerSessionId, await waitForApproval(reviewerSessionId, workspaceId));
  const resized = await rpc("tools/call", { name: "write_stdin", arguments: resizeArgs }, { sessionId: worker.sessionId });
  assert.equal(resized.response.status, 200, JSON.stringify(resized.payload));
  assert.notEqual(structuredContent(resized.payload)?.status, "approval_required", JSON.stringify(resized.payload));

  // Writing stdin is authorized separately from launching and resizing.
  const inputArgs = { workspaceId, sessionId, chars: "status\n" };
  const inputGated = await rpc("tools/call", { name: "write_stdin", arguments: inputArgs }, { sessionId: worker.sessionId });
  assert.equal(inputGated.response.status, 200, JSON.stringify(inputGated.payload));
  assert.equal(structuredContent(inputGated.payload)?.status, "approval_required", "stdin needs its own authorization");
  await approve(reviewerSessionId, await waitForApproval(reviewerSessionId, workspaceId));
  const written = await rpc("tools/call", { name: "write_stdin", arguments: inputArgs }, { sessionId: worker.sessionId });
  assert.equal(written.response.status, 200, JSON.stringify(written.payload));
  assert.notEqual(structuredContent(written.payload)?.status, "approval_required", JSON.stringify(written.payload));

  // The session survives observation: a later poll still addresses it.
  const repoll = await rpc("tools/call", {
    name: "poll_process",
    arguments: { workspaceId, sessionId, yieldTimeMs: 500, maxOutputTokens: 100 },
  }, { sessionId: worker.sessionId });
  assert.equal(repoll.response.status, 200, JSON.stringify(repoll.payload));

  async function decide(approvalId: string, decision: string): Promise<void> {
    const result = await rpc("tools/call", {
      name: "provide_policy_approval",
      arguments: { approvalId, decision, reason: "process-control-modes cross-tool test" },
    }, { sessionId: reviewerSessionId, reviewer: true });
    assert.equal(result.response.status, 200, JSON.stringify(result.payload));
    assert.notEqual(result.payload?.result?.isError, true, JSON.stringify(result.payload));
  }
  // Cross-tool authorization separation: the same shell command expressed
  // through bash and exec_command lives on separate approval tracks, so a
  // decision on one track never authorizes the other.
  const crossCmd = "sleep 30";
  const bashAttempt = await rpc("tools/call", {
    name: "bash",
    arguments: { workspaceId, command: crossCmd, timeout: 30, clientMutationId: "process-control-cross-bash-1" },
  }, { sessionId: worker.sessionId });
  assert.equal(structuredContent(bashAttempt.payload)?.status, "approval_required", JSON.stringify(bashAttempt.payload));
  const bashApprovalId = structuredContent(bashAttempt.payload)?.approvalId;
  const execAttempt = await rpc("tools/call", {
    name: "exec_command",
    arguments: { workspaceId, cmd: crossCmd, tty: false, yieldTimeMs: 500, clientMutationId: "process-control-cross-exec-1" },
  }, { sessionId: worker.sessionId });
  assert.equal(structuredContent(execAttempt.payload)?.status, "approval_required", JSON.stringify(execAttempt.payload));
  const execApprovalId = structuredContent(execAttempt.payload)?.approvalId;
  assert.ok(bashApprovalId && execApprovalId && bashApprovalId !== execApprovalId,
    "the same command through bash and exec_command gets separate approval tracks");

  // Denying the bash track authorizes nothing: exec_command still needs its
  // own human decision and is never auto-allowed.
  await decide(bashApprovalId, "deny");
  const execAfterDeny = await rpc("tools/call", {
    name: "exec_command",
    arguments: { workspaceId, cmd: crossCmd, tty: false, yieldTimeMs: 500, clientMutationId: "process-control-cross-exec-2" },
  }, { sessionId: worker.sessionId });
  assert.equal(structuredContent(execAfterDeny.payload)?.status, "approval_required",
    "a bash denial must not authorize the same command through exec_command");
  assert.equal(structuredContent(execAfterDeny.payload)?.sessionId, undefined,
    "no process session leaks from a gated attempt");
  // Its own approval authorizes the exec track...
  await decide(execApprovalId, "approve");
  const execLaunched = await rpc("tools/call", {
    name: "exec_command",
    arguments: { workspaceId, cmd: crossCmd, tty: false, yieldTimeMs: 500, clientMutationId: "process-control-cross-exec-3" },
  }, { sessionId: worker.sessionId });
  const crossSessionId = structuredContent(execLaunched.payload)?.sessionId;
  assert.equal(typeof crossSessionId, "string", `approved exec track launches: ${JSON.stringify(execLaunched.payload)}`);
  // ...while the denied bash track stays denied and prompts anew.
  const bashRetry = await rpc("tools/call", {
    name: "bash",
    arguments: { workspaceId, command: crossCmd, timeout: 30, clientMutationId: "process-control-cross-bash-2" },
  }, { sessionId: worker.sessionId });
  assert.equal(structuredContent(bashRetry.payload)?.status, "approval_required",
    "the denied bash track must prompt anew, never inherit the exec approval");
  assert.notEqual(structuredContent(bashRetry.payload)?.approvalId, bashApprovalId,
    "the bash retry opens a fresh approval, not the denied one");

  // Cross-session recovery stays fail-closed: a process launched in one MCP
  // transport cannot be observed from an unrelated transport with no owner
  // continuity — output must not leak across sessions.
  const stranger = await openSession("process-control-stranger");
  const foreignPoll = await rpc("tools/call", {
    name: "poll_process",
    arguments: { workspaceId, sessionId: crossSessionId, yieldTimeMs: 500, maxOutputTokens: 100 },
  }, { sessionId: stranger.sessionId });
  assert.equal(foreignPoll.response.status, 200, JSON.stringify(foreignPoll.payload));
  assert.equal(foreignPoll.payload?.result?.isError, true,
    `a foreign session must be refused process access: ${JSON.stringify(foreignPoll.payload)}`);
  // The owning session still observes its own process.
  const ownerPoll = await rpc("tools/call", {
    name: "poll_process",
    arguments: { workspaceId, sessionId: crossSessionId, yieldTimeMs: 500, maxOutputTokens: 100 },
  }, { sessionId: worker.sessionId });
  assert.equal(ownerPoll.response.status, 200, JSON.stringify(ownerPoll.payload));
  assert.notEqual(ownerPoll.payload?.result?.isError, true, JSON.stringify(ownerPoll.payload));

  console.log("mcp-process-control-modes.test.ts: all assertions passed");
} finally {
  await running.drain();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
}
