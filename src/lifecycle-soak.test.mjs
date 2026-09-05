// Stable-beta gate: accelerated process-level lifecycle soak.
//
// The scheduler intervals below compress multiple maintenance periods into a
// few seconds. The integrity worker is deliberately held for >5 seconds while
// a real server and its real supervisor continue serving liveness/readiness.
// This is intentionally black-box: the only control-plane observations are
// HTTP/MCP responses and durable diagnostic/status files.

import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const root = mkdtempSync(join(tmpdir(), "kontrol-lifecycle-soak-root-"));
const stateDir = mkdtempSync(join(tmpdir(), "kontrol-lifecycle-soak-state-"));
const worktreeRoot = mkdtempSync(join(tmpdir(), "kontrol-lifecycle-soak-worktrees-"));
const configDir = mkdtempSync(join(tmpdir(), "kontrol-lifecycle-soak-config-"));
const envFile = join(configDir, "soak.env");
const diagnosticsSecret = "lifecycle-soak-diagnostics-secret";
const reviewerToken = "lifecycle-soak-reviewer-token-that-is-long-enough";
writeFileSync(join(root, "marker.txt"), "lifecycle-soak-marker\n");
writeFileSync(envFile, [
  `KONTROL_CONFIG_DIR=${configDir}`,
  `KONTROL_ALLOWED_ROOTS=${root}`,
  `KONTROL_STATE_DIR=${stateDir}`,
  `KONTROL_WORKTREE_ROOT=${worktreeRoot}`,
  "KONTROL_AUTH_MODE=tunnel",
  "HOST=127.0.0.1",
  "KONTROL_ACP_ENABLED=false",
  "KONTROL_TOOL_MODE=full",
  "KONTROL_POLICY_MODE=allow",
  "KONTROL_POLICY_TOOL_WRITE=ask",
  "KONTROL_POLICY_TOOL_BASH=ask",
  "KONTROL_LOG_LEVEL=error",
  "KONTROL_LOG_REQUESTS=0",
  `KONTROL_ACP_REVIEWER_SECRET=${reviewerToken}`,
  `KONTROL_DIAGNOSTICS_SECRET=${diagnosticsSecret}`,
  // 1 maintenance tick represents roughly one five-minute production period.
  "KONTROL_MAINTENANCE_INTERVAL_MS=40",
  "KONTROL_MAINTENANCE_BUDGET_MS=10",
  // The integrity worker is intentionally slower than the old supervisor
  // probe timeout and is still diagnostic-only.
  "KONTROL_INTEGRITY_INTERVAL_MS=100",
  "KONTROL_INTEGRITY_DEADLINE_MS=7000",
  "KONTROL_INTEGRITY_TEST_DELAY_MS=5200",
  "KONTROL_POLICY_DIRECT_REATTACH_GRACE_MS=100",
  // Accelerated human approval TTL: a direct card stays decidable past its
  // reattachment window and expires only on this clock.
  "KONTROL_POLICY_DIRECT_APPROVAL_TTL_MS=900",
  "KONTROL_POLICY_APPROVAL_TIMEOUT_MS=10000",
  "KONTROL_PROCESS_IDLE_TIMEOUT_MS=150",
  "KONTROL_PROCESS_REAPER_INTERVAL_MS=25",
  "KONTROL_MCP_SESSION_REAPER_INTERVAL_MS=1000",
].join("\n") + "\n");

const delay = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

async function listen(server) {
  await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return address.port;
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(25);
  }
  throw new Error(`timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ""}`);
}

function parseRpc(text) {
  const data = text.split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .join("\n");
  return JSON.parse(data || text);
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    once(child, "exit"),
    delay(5000),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

let tunnelMode = "healthy";
const tunnel = createHttpServer((request, response) => {
  if (request.url === "/healthz") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
    return;
  }
  if (request.url === "/readyz") {
    if (tunnelMode === "transient") {
      response.writeHead(429, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: false, error: "control plane rate limited" }));
      return;
    }
    if (tunnelMode === "stale_route") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: false, error: "route not registered" }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
    return;
  }
  response.writeHead(404);
  response.end();
});

let serverChild;
let supervisorChild;
let competitorStateDir;
let nextRpcId = 0;
let baseUrl;
let diagnosticsUrl;

async function httpStatus(path) {
  const response = await fetch(`${baseUrl}${path}`, { signal: AbortSignal.timeout(1000) });
  return response.status;
}

async function diagnostics() {
  const response = await fetch(diagnosticsUrl, {
    headers: { "x-kontrol-diagnostics": diagnosticsSecret },
    signal: AbortSignal.timeout(2000),
  });
  assert.equal(response.status, 200);
  return response.json();
}

async function rpc(method, params, { sessionId, conversationId, reviewer = false } = {}) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    ...(!reviewer && conversationId ? { "x-kontrol-conversation-id": conversationId } : {}),
    ...(reviewer ? { "x-kontrol-reviewer-token": reviewerToken } : {}),
  };
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: ++nextRpcId, method, params }),
    signal: AbortSignal.timeout(5000),
  });
  const text = await response.text();
  return {
    response,
    payload: text.trim() ? parseRpc(text) : undefined,
    sessionId: response.headers.get("mcp-session-id") ?? sessionId,
  };
}

async function openSession(conversationId, reviewer = false) {
  const initialized = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: reviewer ? "lifecycle-soak-reviewer" : "lifecycle-soak-client", version: "1.0.0" },
  }, { conversationId, reviewer });
  assert.equal(initialized.response.status, 200, JSON.stringify(initialized.payload));
  const sessionId = initialized.sessionId;
  assert.ok(sessionId, "initialize did not return mcp-session-id");
  const initializedNotification = await rpc("notifications/initialized", {}, { sessionId, conversationId, reviewer });
  assert.ok([200, 202].includes(initializedNotification.response.status));
  return sessionId;
}

async function closeSession(sessionId) {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "DELETE",
    headers: { "mcp-session-id": sessionId },
  });
  assert.ok([200, 202, 204].includes(response.status), `session close returned ${response.status}`);
}

async function listApprovals(reviewerSessionId, workspaceId) {
  const result = await rpc("tools/call", {
    name: "list_pending_approvals",
    arguments: { workspaceId },
  }, { sessionId: reviewerSessionId, reviewer: true });
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  return result.payload?.result?.structuredContent?.approvals ?? [];
}

try {
  const tunnelPort = await listen(tunnel);
  const reservedServer = createHttpServer();
  const serverPort = await listen(reservedServer);
  // Reserve a real OS-selected port, then close only that reservation before
  // the child binds it. There is no user-facing server exposed in between.
  await new Promise((resolvePromise) => reservedServer.close(resolvePromise));
  baseUrl = `http://127.0.0.1:${serverPort}`;
  diagnosticsUrl = `${baseUrl}/diagnostics`;

  const serverEnv = {
    ...process.env,
    KONTROL_ENV_FILE: envFile,
    KONTROL_CONFIG_DIR: configDir,
    KONTROL_ALLOWED_ROOTS: root,
    KONTROL_STATE_DIR: stateDir,
    KONTROL_WORKTREE_ROOT: worktreeRoot,
    KONTROL_AUTH_MODE: "tunnel",
    KONTROL_ACP_ENABLED: "false",
    KONTROL_TOOL_MODE: "full",
    KONTROL_POLICY_MODE: "allow",
    KONTROL_POLICY_TOOL_WRITE: "ask",
    KONTROL_POLICY_TOOL_BASH: "ask",
    KONTROL_LOG_LEVEL: "error",
    KONTROL_LOG_REQUESTS: "0",
    KONTROL_ACP_REVIEWER_SECRET: reviewerToken,
    KONTROL_DIAGNOSTICS_SECRET: diagnosticsSecret,
    KONTROL_MAINTENANCE_INTERVAL_MS: "40",
    KONTROL_MAINTENANCE_BUDGET_MS: "10",
    KONTROL_INTEGRITY_INTERVAL_MS: "100",
    KONTROL_INTEGRITY_DEADLINE_MS: "7000",
    KONTROL_INTEGRITY_TEST_DELAY_MS: "5200",
    KONTROL_POLICY_DIRECT_REATTACH_GRACE_MS: "100",
    KONTROL_POLICY_DIRECT_APPROVAL_TTL_MS: "900",
    KONTROL_POLICY_APPROVAL_TIMEOUT_MS: "10000",
    KONTROL_PROCESS_IDLE_TIMEOUT_MS: "150",
    KONTROL_PROCESS_REAPER_INTERVAL_MS: "25",
    KONTROL_MCP_SESSION_REAPER_INTERVAL_MS: "1000",
    KONTROL_LAUNCHER: "serve",
    KONTROL_LAUNCH_GENERATION_ID: "lifecycle-soak-generation",
    KONTROL_ARTIFACT_PATH: join(repoRoot, "src"),
    PORT: String(serverPort),
  };
  serverChild = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", "serve"], {
    cwd: repoRoot,
    env: serverEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverOutput = "";
  serverChild.stdout.on("data", (chunk) => { serverOutput = (serverOutput + chunk).slice(-6000); });
  serverChild.stderr.on("data", (chunk) => { serverOutput = (serverOutput + chunk).slice(-6000); });

  await waitFor(async () => {
    if (serverChild.exitCode !== null) throw new Error(`server exited ${serverChild.exitCode}: ${serverOutput}`);
    return (await httpStatus("/healthz")) === 200;
  }, 15000, `server liveness${serverOutput ? `: ${serverOutput}` : ""}`);
  assert.equal(await httpStatus("/core-readyz"), 200);

  const runtimeLock = JSON.parse(readFileSync(join(stateDir, "runtime.lock"), "utf8"));
  const firstIdentity = readFileSync(join(stateDir, "server.identity.json"), "utf8");

  // A second process using the already-held generation lock is still useful
  // as a bind-race regression: it must report EADDRINUSE and must not remove
  // or replace the first server's authoritative identity on failed startup.
  // Give the bind-race process its own database/lock state. Sharing the live
  // SQLite connection can block it before it reaches listen(), which would
  // test database contention rather than the write-after-bind identity rule.
  competitorStateDir = mkdtempSync(join(tmpdir(), "kontrol-lifecycle-bind-race-state-"));
  const competitor = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", "serve"], {
    cwd: repoRoot,
    env: {
      ...serverEnv,
      KONTROL_STATE_DIR: competitorStateDir,
      KONTROL_INTEGRITY_TEST_DELAY_MS: "0",
      KONTROL_INTEGRITY_INTERVAL_MS: "60000",
      KONTROL_INTEGRITY_DEADLINE_MS: "1000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let competitorOutput = "";
  competitor.stdout.on("data", (chunk) => { competitorOutput += chunk; });
  competitor.stderr.on("data", (chunk) => { competitorOutput += chunk; });
  const competitorExit = once(competitor, "exit");
  const competitorOutcome = await Promise.race([
    competitorExit.then(([code, signal]) => ({ code, signal, timedOut: false })),
    // A full aggregate run can have several cold tsx children competing for
    // CPU at once. Keep a bounded startup budget, but do not turn that
    // contention into an opaque null exitCode assertion.
    delay(30000).then(() => ({ code: null, signal: null, timedOut: true })),
  ]);
  if (competitorOutcome.timedOut) {
    competitor.kill("SIGKILL");
    await competitorExit;
    assert.fail(`competing launch did not report its bind failure within 30s: ${competitorOutput}`);
  }
  assert.equal(competitorOutcome.signal, null, `competing launch did not exit normally: ${competitorOutput}`);
  assert.equal(competitorOutcome.code, 1, `competing launch unexpectedly succeeded: ${competitorOutput}`);
  assert.match(competitorOutput, /EADDRINUSE/);
  assert.equal(readFileSync(join(stateDir, "server.identity.json"), "utf8"), firstIdentity,
    "failed second bind must leave the live server identity untouched");
  rmSync(competitorStateDir, { recursive: true, force: true });
  competitorStateDir = undefined;

  const supervisorStatusFile = join(stateDir, "soak-supervisor-status.json");
  supervisorChild = spawn(process.execPath, [
    "scripts/kontrol-supervisor.mjs",
    "--root", repoRoot,
    "--kontrol-url", baseUrl,
    "--tunnel-url", `http://127.0.0.1:${tunnelPort}`,
    "--status-file", supervisorStatusFile,
    "--state-dir", stateDir,
    "--generation-id", "lifecycle-soak-generation",
    "--expected-build-id", "dev",
    "--artifact-path", join(repoRoot, "src"),
    "--runtime-lock-token", runtimeLock.lockToken,
    "--interval-ms", "50",
    "--start-crush", "false",
    "--start-hermes", "false",
  ], {
    cwd: repoRoot,
    env: { ...serverEnv, KONTROL_ENV_FILE: envFile },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let supervisorOutput = "";
  supervisorChild.stdout.on("data", (chunk) => { supervisorOutput = (supervisorOutput + chunk).slice(-3000); });
  supervisorChild.stderr.on("data", (chunk) => { supervisorOutput = (supervisorOutput + chunk).slice(-3000); });

  await waitFor(async () => {
    if (supervisorChild.exitCode !== null) throw new Error(`supervisor exited ${supervisorChild.exitCode}: ${supervisorOutput}`);
    try {
      return JSON.parse(readFileSync(supervisorStatusFile, "utf8")).state === "healthy";
    } catch {
      return false;
    }
  }, 10000, "supervisor healthy state");

  // A remote control-plane throttle must degrade the tunnel only. The real
  // core remains live and no tunnel/core restart budget is consumed.
  tunnelMode = "transient";
  await waitFor(async () => {
    const snapshot = JSON.parse(readFileSync(supervisorStatusFile, "utf8"));
    return snapshot.state === "degraded" && snapshot.components.tunnel.lastExternalProbeResult.failureClass === "transient";
  }, 3000, "transient tunnel degradation");
  assert.equal(await httpStatus("/healthz"), 200);
  assert.equal(await httpStatus("/core-readyz"), 200);
  const transientSupervisor = JSON.parse(readFileSync(supervisorStatusFile, "utf8"));
  assert.equal(transientSupervisor.components.tunnel.restartCount, 0, "a remote throttle must not restart the tunnel process");
  assert.equal(transientSupervisor.components.kontrol.restartCount, 0, "a remote throttle must not restart the core");
  tunnelMode = "healthy";
  await waitFor(async () => JSON.parse(readFileSync(supervisorStatusFile, "utf8")).state === "healthy", 3000, "tunnel recovery");

  // Keep probing throughout the deliberately slow diagnostic. This is the
  // regression guard for the old synchronous quick_check/event-loop stall.
  const diagnosticWindowEnds = Date.now() + 5200;
  let responsiveProbes = 0;
  while (Date.now() < diagnosticWindowEnds) {
    const startedAt = performance.now();
    const statuses = await Promise.all([httpStatus("/healthz"), httpStatus("/core-readyz")]);
    assert.deepEqual(statuses, [200, 200]);
    assert.ok(performance.now() - startedAt < 1000, "health/readiness exceeded the local liveness budget during integrity scan");
    responsiveProbes++;
    await delay(100);
  }
  assert.ok(responsiveProbes >= 30, `too few responsive probes during integrity scan: ${responsiveProbes}`);
  await waitFor(async () => {
    const snapshot = await diagnostics();
    return snapshot.databaseIntegrity?.checkedAt && snapshot.databaseIntegrity.durationMs >= 5000;
  }, 5000, "slow integrity diagnostic completion");

  const workerConversation = "lifecycle-soak-conversation";
  const workerSession = await openSession(workerConversation);
  const listedResources = await rpc("resources/list", {}, { sessionId: workerSession, conversationId: workerConversation });
  assert.equal(listedResources.response.status, 200, JSON.stringify(listedResources.payload));
  const appResource = (listedResources.payload?.result?.resources ?? []).find((resource) => typeof resource.uri === "string");
  assert.ok(appResource?.uri, "resources/list did not advertise an app resource");
  const appRead = await rpc("resources/read", { uri: appResource.uri }, { sessionId: workerSession, conversationId: workerConversation });
  assert.equal(appRead.response.status, 200, JSON.stringify(appRead.payload));

  const opened = await rpc("tools/call", {
    name: "open_workspace",
    arguments: { path: root, mode: "checkout" },
  }, { sessionId: workerSession, conversationId: workerConversation });
  assert.equal(opened.response.status, 200, JSON.stringify(opened.payload));
  const workspaceId = opened.payload?.result?.structuredContent?.workspaceId ?? opened.payload?.result?.workspaceId;
  assert.equal(typeof workspaceId, "string");

  const reviewerSession = await openSession(undefined, true);
  const firstWrite = await rpc("tools/call", {
    name: "write",
    arguments: { workspaceId, path: "approved.txt", content: "approved by soak\n" },
  }, { sessionId: workerSession, conversationId: workerConversation });
  assert.equal(firstWrite.payload?.result?.structuredContent?.status, "approval_required", JSON.stringify(firstWrite.payload));
  assert.equal(firstWrite.payload?.result?.structuredContent?.retryable, true);
  const approvalId = firstWrite.payload.result.structuredContent.approvalId;
  await waitFor(async () => (await listApprovals(reviewerSession, workspaceId)).some((card) => card.approvalId === approvalId), 3000, "approval card");
  const pendingCard = (await listApprovals(reviewerSession, workspaceId)).find((card) => card.approvalId === approvalId);
  assert.equal(pendingCard.origin, "direct_mcp");
  assert.equal(pendingCard.conversationId, workerConversation);
  assert.equal(pendingCard.liveWaiterCount, 0);
  await closeSession(workerSession);

  const retrySession = await openSession(workerConversation);
  const retryWrite = await rpc("tools/call", {
    name: "write",
    arguments: { workspaceId, path: "approved.txt", content: "approved by soak\n" },
  }, { sessionId: retrySession, conversationId: workerConversation });
  assert.equal(retryWrite.payload?.result?.structuredContent?.approvalId, approvalId);
  assert.equal((await listApprovals(reviewerSession, workspaceId)).length, 1, "retry created a duplicate approval card");
  const approve = await rpc("tools/call", {
    name: "provide_policy_approval",
    arguments: { approvalId, decision: "approve" },
  }, { sessionId: reviewerSession, reviewer: true });
  assert.equal(approve.response.status, 200, JSON.stringify(approve.payload));
  const approvedRetry = await rpc("tools/call", {
    name: "write",
    arguments: { workspaceId, path: "approved.txt", content: "approved by soak\n" },
  }, { sessionId: retrySession, conversationId: workerConversation });
  assert.notEqual(approvedRetry.payload?.result?.isError, true, JSON.stringify(approvedRetry.payload));

  // A direct approval is a PENDING HUMAN DECISION, not an orphan: with zero
  // live waiters it must remain listed and decidable well past its short
  // reattachment window, then leave the pending set only on its own human TTL
  // (accelerated to 900ms here).
  const abandonSession = await openSession("lifecycle-abandon-conversation");
  const abandoned = await rpc("tools/call", {
    name: "write",
    arguments: { workspaceId, path: "abandoned.txt", content: "never approved\n" },
  }, { sessionId: abandonSession, conversationId: "lifecycle-abandon-conversation" });
  assert.equal(abandoned.payload?.result?.structuredContent?.status, "approval_required");
  const abandonedId = abandoned.payload.result.structuredContent.approvalId;
  await closeSession(abandonSession);
  await delay(250); // comfortably past the 100ms reattachment window
  const survivedCard = (await listApprovals(reviewerSession, workspaceId)).find((card) => card.approvalId === abandonedId);
  assert.ok(survivedCard, "a direct approval must stay decidable past its reattachment window");
  assert.equal(survivedCard.state, "pending_human_approval",
    `zero live waiters is a pending human decision; got ${JSON.stringify(survivedCard)}`);
  await waitFor(async () => !(await listApprovals(reviewerSession, workspaceId)).some((card) => card.approvalId === abandonedId), 5000, "direct approval human-TTL expiry");

  // Eight accelerated maintenance periods represent more than a working day
  // of the production five-minute scheduler. Each round exercises a fresh
  // transport, app resource fetch, and ordinary read against the same server.
  for (let round = 0; round < 8; round++) {
    const conversation = `lifecycle-round-${round}`;
    const session = await openSession(conversation);
    const tools = await rpc("tools/list", {}, { sessionId: session, conversationId: conversation });
    assert.equal(tools.response.status, 200);
    const resources = await rpc("resources/list", {}, { sessionId: session, conversationId: conversation });
    assert.equal(resources.response.status, 200);
    const resource = (resources.payload?.result?.resources ?? []).find((candidate) => typeof candidate.uri === "string");
    assert.ok(resource?.uri);
    const readResource = await rpc("resources/read", { uri: resource.uri }, { sessionId: session, conversationId: conversation });
    assert.equal(readResource.response.status, 200);
    const read = await rpc("tools/call", {
      name: "read",
      arguments: { workspaceId, path: "marker.txt" },
    }, { sessionId: session, conversationId: conversation });
    assert.equal(read.response.status, 200, JSON.stringify(read.payload));
    await closeSession(session);
  }

  const finalDiagnostics = await waitFor(async () => {
    const snapshot = await diagnostics();
    return snapshot.maintenance?.cycles >= 8 ? snapshot : null;
  }, 5000, "accelerated maintenance cycles");
  assert.ok(finalDiagnostics.maintenance.cycles >= 8);
  // Snapshot GC advances in bounded slices rather than blocking the server:
  // the snapshot-store maintenance stage runs to a completed pass within the
  // accelerated maintenance cycles above, while the server stayed responsive to
  // the health probes and the 8 RPC rounds interleaved with those cycles.
  assert.ok(finalDiagnostics.snapshotStore, "diagnostics must surface the snapshot store after maintenance");
  assert.ok(
    typeof finalDiagnostics.snapshotStore.blobs === "number" &&
      typeof finalDiagnostics.snapshotStore.manifests === "number" &&
      typeof finalDiagnostics.snapshotStore.orphanEstimate === "number",
    "snapshot store diagnostics report blob/manifest/orphan counts",
  );
  assert.ok(finalDiagnostics.snapshotStore.lastGcCompletedAt, "snapshot GC completed a full pass during the accelerated maintenance cycles");
  assert.equal(finalDiagnostics.mcpSessionMetrics.policyWaiters.activePolicyWaiters, 0);
  assert.equal(finalDiagnostics.mcpSessionMetrics.policyWaiters.pendingApprovalRows, 0);
  assert.equal(finalDiagnostics.mcpSessionMetrics.executionAdmission.activeWeight, 0);
  assert.equal(finalDiagnostics.databaseIntegrity.status, "healthy");

  const finalSupervisor = JSON.parse(readFileSync(supervisorStatusFile, "utf8"));
  assert.equal(finalSupervisor.state, "healthy", JSON.stringify(finalSupervisor));
  assert.equal(finalSupervisor.restartCount, 0, JSON.stringify(finalSupervisor));
  assert.equal(finalSupervisor.components.kontrol.restartCount, 0, JSON.stringify(finalSupervisor));
  assert.equal(finalSupervisor.components.kontrol.consecutiveFailures, 0, JSON.stringify(finalSupervisor));

  // Crash-point proof: durable workspace state must survive an abrupt core
  // death, and the next process must recover the stale runtime lock and serve
  // a fresh MCP transport without a manual database repair.
  await stopChild(supervisorChild);
  supervisorChild = undefined;
  const crashedExit = once(serverChild, "exit");
  serverChild.kill("SIGKILL");
  const [crashCode, crashSignal] = await crashedExit;
  assert.equal(crashCode, null);
  assert.equal(crashSignal, "SIGKILL");
  serverChild = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", "serve"], {
    cwd: repoRoot,
    env: serverEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let recoveryOutput = "";
  serverChild.stdout.on("data", (chunk) => { recoveryOutput = (recoveryOutput + chunk).slice(-6000); });
  serverChild.stderr.on("data", (chunk) => { recoveryOutput = (recoveryOutput + chunk).slice(-6000); });
  await waitFor(async () => {
    if (serverChild.exitCode !== null) throw new Error(`crash recovery server exited ${serverChild.exitCode}: ${recoveryOutput}`);
    return (await httpStatus("/healthz")) === 200 && (await httpStatus("/core-readyz")) === 200;
  }, 15000, "post-crash server recovery");
  const recoveredSession = await openSession("lifecycle-post-crash");
  const recoveredRead = await rpc("tools/call", {
    name: "read",
    arguments: { workspaceId, path: "marker.txt" },
  }, { sessionId: recoveredSession, conversationId: "lifecycle-post-crash" });
  assert.equal(recoveredRead.response.status, 200, JSON.stringify(recoveredRead.payload));
  await closeSession(recoveredSession);

  console.log("lifecycle-soak.test.mjs: accelerated lifecycle, integrity, reconnect, and SIGKILL recovery gate passed");
} finally {
  if (competitorStateDir) rmSync(competitorStateDir, { recursive: true, force: true });
  await stopChild(supervisorChild);
  await stopChild(serverChild);
  await new Promise((resolvePromise) => tunnel.close(resolvePromise));
}
