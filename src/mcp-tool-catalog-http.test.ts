import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./server.js";
import { loadConfig } from "./config.js";
import {
  fingerprintToolCatalog,
  TOOL_CATALOG_ACK_CAPABILITY,
  TOOL_CATALOG_ACK_METHOD,
} from "./mcp/tool-catalog-handshake.js";

const workspaceRoot = mkdtempSync(join(tmpdir(), "kontrol-catalog-ack-workspace-"));
const stateDir = mkdtempSync(join(tmpdir(), "kontrol-catalog-ack-state-"));
const configDir = mkdtempSync(join(tmpdir(), "kontrol-catalog-ack-config-"));
const worktreeRoot = mkdtempSync(join(tmpdir(), "kontrol-catalog-ack-worktrees-"));
mkdirSync(workspaceRoot, { recursive: true });
mkdirSync(join(workspaceRoot, "src"), { recursive: true });
mkdirSync(join(workspaceRoot, "scripts"), { recursive: true });
writeFileSync(join(workspaceRoot, "README.md"), "catalog ack test\n");
writeFileSync(join(workspaceRoot, "package.json"), "{}\n");
writeFileSync(join(workspaceRoot, "AGENTS.md"), "# Test workspace\n");
writeFileSync(join(workspaceRoot, "src", "index.ts"), "export {};\n");
const diagnosticsSecret = "catalog-ack-test-diagnostics-secret";
const tunnelReviewerSecret = "catalog-ack-test-tunnel-reviewer-secret-32chars";
writeFileSync(join(configDir, "tunnel-reviewer.secret"), tunnelReviewerSecret, { mode: 0o600 });
let config = loadConfig({
  KONTROL_CONFIG_DIR: configDir,
  KONTROL_ALLOWED_ROOTS: workspaceRoot,
  KONTROL_STATE_DIR: stateDir,
  KONTROL_WORKTREE_ROOT: worktreeRoot,
  KONTROL_AUTH_MODE: "tunnel",
  KONTROL_ACP_ENABLED: "true",
  KONTROL_ACP_AGENT_SECRET: "catalog-ack-test-agent-secret-32chars",
  KONTROL_ACP_REVIEWER_SECRET: "catalog-ack-test-reviewer-secret-32chars",
  KONTROL_ACP_ADAPTER_SECRET: "catalog-ack-test-adapter-secret-32chars",
  KONTROL_TUNNEL_REVIEWER_SECRET: tunnelReviewerSecret,
  KONTROL_POLICY_MODE: "allow",
  KONTROL_TOOL_MODE: "full",
  KONTROL_LOG_LEVEL: "error",
  KONTROL_DIAGNOSTICS_SECRET: diagnosticsSecret,
  KONTROL_BUILD_ID: "catalog-ack-build-test",
  KONTROL_MCP_SSE_HEARTBEAT_MS: "1000",
  KONTROL_MCP_REQUIRE_TOOL_CATALOG_ACK: "1",
});

let running = createServer(config);
let httpServer = running.app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => httpServer.once("listening", resolve));
let address = httpServer.address();
assert.ok(address && typeof address === "object");
let url = `http://127.0.0.1:${address.port}/mcp`;
let nextId = 0;

async function rpc(method: string, params: Record<string, unknown>, sessionId?: string): Promise<{ response: Response; payload?: any; sessionId?: string }> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "x-kontrol-tunnel-reviewer": tunnelReviewerSecret,
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++nextId, method, params }),
  });
  const body = await response.text();
  const eventData = body.split(/\r?\n/).filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim()).join("\n");
  return {
    response,
    payload: body.trim() ? JSON.parse(eventData || body) : undefined,
    sessionId: response.headers.get("mcp-session-id") ?? sessionId,
  };
}

async function notification(method: string, params: Record<string, unknown>, sessionId: string): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-session-id": sessionId,
      "x-kontrol-tunnel-reviewer": tunnelReviewerSecret,
    },
    body: JSON.stringify({ jsonrpc: "2.0", method, params }),
  });
}

try {
  const initialized = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: { extensions: { [TOOL_CATALOG_ACK_CAPABILITY]: { contractVersion: 1 } } },
    clientInfo: { name: "catalog-ack-http-test", version: "1.0.0" },
  });
  assert.equal(initialized.response.status, 200, JSON.stringify(initialized.payload));
  const sessionId = initialized.sessionId;
  assert.ok(sessionId, "initialize must return the MCP session ID");
  await notification("notifications/initialized", {}, sessionId);

  const beforeAck = await rpc("tools/call", {
    name: "open_workspace",
    arguments: { path: workspaceRoot, mode: "checkout" },
  }, sessionId);
  assert.equal(beforeAck.response.status, 200);
  assert.equal(beforeAck.payload?.id, nextId, "strict-mode rejection must correlate to the originating JSON-RPC request");
  assert.equal(beforeAck.payload?.error?.code, -32012, JSON.stringify(beforeAck.payload));

  const listed = await rpc("tools/list", {}, sessionId);
  assert.equal(listed.response.status, 200, JSON.stringify(listed.payload));
  const fingerprint = fingerprintToolCatalog(listed.payload?.result);
  assert.ok(fingerprint, "server catalog must produce a canonical fingerprint");
  const serverVersion = initialized.payload?.result?.serverInfo?.version;
  const ackResponse = await notification(TOOL_CATALOG_ACK_METHOD, {
    contractVersion: 1,
    serverVersion,
    captureId: "catalog-ack-capture-test",
    hostCatalogSha256: fingerprint.sha256,
    hostToolCount: fingerprint.toolCount,
  }, sessionId);
  assert.ok([200, 202].includes(ackResponse.status), `ack notification returned HTTP ${ackResponse.status}`);

  const unsupportedClient = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "catalog-ack-http-unsupported-client", version: "1.0.0" },
  });
  assert.equal(unsupportedClient.response.status, 200, JSON.stringify(unsupportedClient.payload));
  const unsupportedSessionId = unsupportedClient.sessionId;
  assert.ok(unsupportedSessionId, "fresh initialization must return a session ID");
  await notification("notifications/initialized", {}, unsupportedSessionId);
  const unsupportedListed = await rpc("tools/list", {}, unsupportedSessionId);
  const unsupportedFingerprint = fingerprintToolCatalog(unsupportedListed.payload?.result);
  assert.ok(unsupportedFingerprint, "fresh transport catalog must be fingerprintable");
  await notification(TOOL_CATALOG_ACK_METHOD, {
    contractVersion: 1,
    serverVersion: unsupportedClient.payload?.result?.serverInfo?.version,
    hostCatalogSha256: unsupportedFingerprint.sha256,
    hostToolCount: unsupportedFingerprint.toolCount,
  }, unsupportedSessionId);
  const unsupportedCall = await rpc("tools/call", {
    name: "open_workspace",
    arguments: { path: workspaceRoot, mode: "checkout" },
  }, unsupportedSessionId);
  assert.equal(unsupportedCall.payload?.error?.code, -32012,
    "strict catalog mode must fail closed for clients missing the acknowledgement extension");

  const opened = await rpc("tools/call", {
    name: "open_workspace",
    arguments: { path: workspaceRoot, mode: "checkout" },
  }, sessionId);
  assert.equal(opened.response.status, 200, JSON.stringify(opened.payload));
  assert.notEqual(opened.payload?.result?.isError, true, JSON.stringify(opened.payload));
  const workspaceId = (opened.payload?.result?.structuredContent ?? opened.payload?.result)?.workspaceId;
  assert.equal(typeof workspaceId, "string", "open_workspace must return the workspace id used by the SSE evidence call");
  const sseCall = await rpc("tools/call", {
    name: "await_workspace_events",
    arguments: { workspaceId, afterSeq: 0, timeoutMs: 1_000 },
  }, sessionId);
  assert.equal(sseCall.response.status, 200, JSON.stringify(sseCall.payload));
  const sseOperationId = sseCall.response.headers.get("x-kontrol-operation-id");
  assert.ok(sseOperationId, "completed SSE tool responses must expose their exact server operation ID");

  const diagnosticsResponse = await fetch(new URL("/diagnostics", url), {
    headers: { "x-kontrol-diagnostics": diagnosticsSecret },
  });
  assert.equal(diagnosticsResponse.status, 200);
  const diagnostics = await diagnosticsResponse.json() as any;
  const sessionHash = createHash("sha256").update(sessionId).digest("hex");
  const session = diagnostics.mcpSessionMetrics.sessions.find((item: any) => item.sessionIdSha256 === sessionHash);
  assert.equal(session?.toolCatalogHandshake?.status, "accepted");
  assert.equal(session?.toolCatalogHandshake?.serverCatalogSha256, fingerprint.sha256);
  assert.equal(session?.toolCatalogHandshake?.hostCatalogSha256, fingerprint.sha256);
  assert.equal(session?.toolCatalogParity?.status, "matched");
  assert.equal(session?.toolCatalogParity?.degraded, false);
  const unsupportedSessionHash = createHash("sha256").update(unsupportedSessionId).digest("hex");
  const unsupportedDiagnostic = diagnostics.mcpSessionMetrics.sessions.find((item: any) => item.sessionIdSha256 === unsupportedSessionHash);
  assert.equal(unsupportedDiagnostic?.toolCatalogHandshake?.status, "rejected");
  assert.equal(unsupportedDiagnostic?.toolCatalogHandshake?.reason, "client_capability_missing");
  assert.equal(unsupportedDiagnostic?.toolCatalogParity?.status, "mismatch");
  assert.equal(unsupportedDiagnostic?.toolCatalogParity?.degraded, true);
  assert.equal(diagnostics.mcpSessionMetrics.toolCatalogParity.status, "degraded");
  assert.equal(diagnostics.mcpSessionMetrics.toolCatalogParity.degradedSessions, 1);

  const badFingerprintClient = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: { extensions: { [TOOL_CATALOG_ACK_CAPABILITY]: { contractVersion: 1 } } },
    clientInfo: { name: "catalog-ack-http-bad-fingerprint-client", version: "1.0.0" },
  });
  assert.equal(badFingerprintClient.response.status, 200, JSON.stringify(badFingerprintClient.payload));
  const badFingerprintSessionId = badFingerprintClient.sessionId;
  assert.ok(badFingerprintSessionId, "bad-fingerprint initialization must return a session ID");
  await notification("notifications/initialized", {}, badFingerprintSessionId);
  const badFingerprintList = await rpc("tools/list", {}, badFingerprintSessionId);
  const badFingerprintCatalog = fingerprintToolCatalog(badFingerprintList.payload?.result);
  assert.ok(badFingerprintCatalog);
  const wrongFingerprint = badFingerprintCatalog.sha256 === "0".repeat(64) ? "1".repeat(64) : "0".repeat(64);
  await notification(TOOL_CATALOG_ACK_METHOD, {
    contractVersion: 1,
    serverVersion: badFingerprintClient.payload?.result?.serverInfo?.version,
    hostCatalogSha256: wrongFingerprint,
    hostToolCount: badFingerprintCatalog.toolCount,
  }, badFingerprintSessionId);
  const badFingerprintCall = await rpc("tools/call", {
    name: "open_workspace",
    arguments: { path: workspaceRoot, mode: "checkout" },
  }, badFingerprintSessionId);
  assert.equal(badFingerprintCall.payload?.error?.code, -32012,
    "strict-mode tools/call must fail closed after an incorrect catalog fingerprint");
  const badFingerprintDiagnostics = await fetch(new URL("/diagnostics", url), {
    headers: { "x-kontrol-diagnostics": diagnosticsSecret },
  }).then((response) => response.json()) as any;
  const badFingerprintSessionHash = createHash("sha256").update(badFingerprintSessionId).digest("hex");
  const badFingerprintHandshake = badFingerprintDiagnostics.mcpSessionMetrics.sessions
    .find((item: any) => item.sessionIdSha256 === badFingerprintSessionHash)?.toolCatalogHandshake;
  assert.equal(badFingerprintHandshake?.status, "rejected");
  assert.equal(badFingerprintHandshake?.reason, "host_catalog_fingerprint_mismatch");

  const evidenceUrl = new URL("/diagnostics", url);
  evidenceUrl.searchParams.set("qEvidence", "1");
  evidenceUrl.searchParams.set("qBuild", "catalog-ack-build-test");
  evidenceUrl.searchParams.set("qSession", sessionHash);
  const evidenceResponse = await fetch(evidenceUrl, {
    headers: { "x-kontrol-diagnostics": diagnosticsSecret },
  });
  assert.equal(evidenceResponse.status, 200);
  const evidenceDiagnostics = await evidenceResponse.json() as any;
  const evidenceRecords = evidenceDiagnostics.mcpSessionMetrics.qualificationEvidence.records;
  const persistedAck = evidenceRecords.find((item: any) => item.recordType === "catalog_acknowledgement"
    && item.captureId === "catalog-ack-capture-test");
  assert.equal(persistedAck?.status, "accepted");
  assert.equal(persistedAck?.serverBuildId, "catalog-ack-build-test");
  assert.equal(persistedAck?.sessionIdSha256, sessionHash);
  assert.match(persistedAck?.contentSha256 ?? "", /^[a-f0-9]{64}$/);
  const persistedSse = evidenceRecords.find((item: any) => item.recordType === "external_sse"
    && item.operationId === sseOperationId);
  assert.ok(persistedSse, "completed external SSE operation metadata must be stored outside the in-memory ring");
  assert.equal(persistedSse?.sessionIdSha256, sessionHash);
  assert.equal(persistedSse?.serverBuildId, "catalog-ack-build-test");
  const unsupportedEvidenceUrl = new URL(evidenceUrl);
  unsupportedEvidenceUrl.searchParams.set("qSession", unsupportedSessionHash);
  const unsupportedEvidenceResponse = await fetch(unsupportedEvidenceUrl, {
    headers: { "x-kontrol-diagnostics": diagnosticsSecret },
  });
  assert.equal(unsupportedEvidenceResponse.status, 200);
  const unsupportedEvidence = await unsupportedEvidenceResponse.json() as any;
  assert.ok(unsupportedEvidence.mcpSessionMetrics.qualificationEvidence.records.some((item: any) =>
    item.recordType === "catalog_acknowledgement" && item.status === "rejected"
      && item.sessionIdSha256 === unsupportedSessionHash),
  "rejected acknowledgements remain available as server-observed evidence");
  const badFingerprintEvidenceUrl = new URL(evidenceUrl);
  badFingerprintEvidenceUrl.searchParams.set("qSession", badFingerprintSessionHash);
  const badFingerprintEvidence = await fetch(badFingerprintEvidenceUrl, {
    headers: { "x-kontrol-diagnostics": diagnosticsSecret },
  }).then((response) => response.json()) as any;
  assert.ok(badFingerprintEvidence.mcpSessionMetrics.qualificationEvidence.records.some((item: any) =>
    item.recordType === "catalog_acknowledgement" && item.status === "rejected"
      && item.rejectionReason === "host_catalog_fingerprint_mismatch"
      && item.sessionIdSha256 === badFingerprintSessionHash),
  "incorrect catalog fingerprints remain durably classified as rejected");

  await fetch(url, { method: "DELETE", headers: { "mcp-session-id": sessionId } }).catch(() => {});
  await fetch(url, { method: "DELETE", headers: { "mcp-session-id": unsupportedSessionId } }).catch(() => {});
  await fetch(url, { method: "DELETE", headers: { "mcp-session-id": badFingerprintSessionId } }).catch(() => {});
  const evidenceAfterClose = await fetch(evidenceUrl, {
    headers: { "x-kontrol-diagnostics": diagnosticsSecret },
  });
  assert.equal(evidenceAfterClose.status, 200);
  const afterCloseDiagnostics = await evidenceAfterClose.json() as any;
  assert.ok(afterCloseDiagnostics.mcpSessionMetrics.qualificationEvidence.records.some((item: any) => item.recordId === persistedAck.recordId),
    "qualification acknowledgement evidence must survive session closure");
  assert.ok(afterCloseDiagnostics.mcpSessionMetrics.qualificationEvidence.records.some((item: any) => item.recordId === persistedSse.recordId),
    "completed SSE evidence must survive session closure");

  await running.drain();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  await running.close();
  running = createServer(config);
  httpServer = running.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => httpServer.once("listening", resolve));
  address = httpServer.address();
  assert.ok(address && typeof address === "object");
  url = `http://127.0.0.1:${address.port}/mcp`;
  const diagnosticsBaseUrl = new URL("/diagnostics", url);
  diagnosticsBaseUrl.search = evidenceUrl.search;
  const evidenceAfterRestart = await fetch(diagnosticsBaseUrl, {
    headers: { "x-kontrol-diagnostics": diagnosticsSecret },
  });
  assert.equal(evidenceAfterRestart.status, 200);
  const restartedDiagnostics = await evidenceAfterRestart.json() as any;
  const restartedRecords = restartedDiagnostics.mcpSessionMetrics.qualificationEvidence.records;
  assert.ok(restartedRecords.some((item: any) => item.recordId === persistedAck.recordId),
    "catalog acknowledgement evidence remains correlated after a Kontrol restart");
  assert.ok(restartedRecords.some((item: any) => item.recordId === persistedSse.recordId),
    "completed SSE evidence remains correlated after a Kontrol restart");
  assert.ok(!restartedDiagnostics.mcpSessionMetrics.sessions.some((item: any) => item.sessionIdSha256 === sessionHash),
    "the post-restart evidence lookup does not depend on retaining the MCP session");

  // Model a release transition that materially changes callable descriptors.
  // A host reconnects through the supported MCP path, sees the new catalog,
  // and must acknowledge that catalog before strict-mode calls resume.
  await running.drain();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  await running.close();
  config = loadConfig({
    KONTROL_CONFIG_DIR: configDir,
    KONTROL_ALLOWED_ROOTS: workspaceRoot,
    KONTROL_STATE_DIR: stateDir,
    KONTROL_WORKTREE_ROOT: worktreeRoot,
    KONTROL_AUTH_MODE: "tunnel",
    KONTROL_ACP_ENABLED: "true",
    KONTROL_ACP_AGENT_SECRET: "catalog-ack-test-agent-secret-32chars",
    KONTROL_ACP_REVIEWER_SECRET: "catalog-ack-test-reviewer-secret-32chars",
    KONTROL_ACP_ADAPTER_SECRET: "catalog-ack-test-adapter-secret-32chars",
    KONTROL_TUNNEL_REVIEWER_SECRET: tunnelReviewerSecret,
    KONTROL_POLICY_MODE: "allow",
    KONTROL_TOOL_MODE: "codex",
    KONTROL_LOG_LEVEL: "error",
    KONTROL_DIAGNOSTICS_SECRET: diagnosticsSecret,
    KONTROL_BUILD_ID: "catalog-ack-build-test-release-b",
    KONTROL_MCP_SSE_HEARTBEAT_MS: "1000",
    KONTROL_MCP_REQUIRE_TOOL_CATALOG_ACK: "1",
  });
  running = createServer(config);
  httpServer = running.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => httpServer.once("listening", resolve));
  address = httpServer.address();
  assert.ok(address && typeof address === "object");
  url = `http://127.0.0.1:${address.port}/mcp`;

  const releaseBInitialize = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: { extensions: { [TOOL_CATALOG_ACK_CAPABILITY]: { contractVersion: 1 } } },
    clientInfo: { name: "catalog-ack-release-transition", version: "1.0.0" },
  });
  assert.equal(releaseBInitialize.response.status, 200, JSON.stringify(releaseBInitialize.payload));
  const releaseBSessionId = releaseBInitialize.sessionId;
  assert.ok(releaseBSessionId, "release B reconnect must create a fresh MCP session");
  await notification("notifications/initialized", {}, releaseBSessionId);
  const releaseBToolsList = await rpc("tools/list", {}, releaseBSessionId);
  const releaseBCatalog = fingerprintToolCatalog(releaseBToolsList.payload?.result);
  assert.ok(releaseBCatalog, "release B must expose a fingerprintable callable catalog");
  assert.notEqual(releaseBCatalog.sha256, fingerprint.sha256,
    "release B's materially changed descriptor set must differ from release A");
  assert.ok(releaseBToolsList.payload?.result?.tools?.some((tool: any) => tool.name === "exec_command"),
    "the release B catalog must include its newly registered Codex tool");
  const staleReleaseAAcknowledgement = await notification(TOOL_CATALOG_ACK_METHOD, {
    contractVersion: 1,
    serverVersion,
    hostCatalogSha256: fingerprint.sha256,
    hostToolCount: fingerprint.toolCount,
  }, releaseBSessionId);
  assert.ok([200, 202].includes(staleReleaseAAcknowledgement.status));
  const staleReleaseBCall = await rpc("tools/call", {
    name: "open_workspace",
    arguments: { path: workspaceRoot, mode: "checkout" },
  }, releaseBSessionId);
  assert.equal(staleReleaseBCall.payload?.error?.code, -32012,
    "a catalog captured from release A must not authorize strict-mode calls on release B");
  const releaseBAcknowledgement = await notification(TOOL_CATALOG_ACK_METHOD, {
    contractVersion: 1,
    serverVersion: releaseBInitialize.payload?.result?.serverInfo?.version,
    captureId: "release-transition-b",
    hostCatalogSha256: releaseBCatalog.sha256,
    hostToolCount: releaseBCatalog.toolCount,
  }, releaseBSessionId);
  assert.ok([200, 202].includes(releaseBAcknowledgement.status));

  const refreshController = new AbortController();
  const refreshStream = await fetch(url, {
    method: "GET",
    headers: {
      accept: "text/event-stream",
      "mcp-session-id": releaseBSessionId,
      "x-kontrol-tunnel-reviewer": tunnelReviewerSecret,
    },
    signal: refreshController.signal,
  });
  assert.equal(refreshStream.status, 200, "the connected host can use the normal GET stream refresh path");
  const refreshReader = refreshStream.body?.getReader();
  assert.ok(refreshReader);
  let refreshBytes = "";
  try {
    const deadline = Date.now() + 5_000;
    while (!refreshBytes.includes("notifications/tools/list_changed") && Date.now() < deadline) {
      const chunk: ReadableStreamReadResult<Uint8Array> = await Promise.race([
        refreshReader.read(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out waiting for release B catalog refresh")), 5_000)),
      ]);
      assert.equal(chunk.done, false, "the refresh stream remains open while carrying notifications");
      refreshBytes += new TextDecoder().decode(chunk.value);
    }
    assert.match(refreshBytes, /notifications\/tools\/list_changed/,
      "release B sends the supported tools/list_changed refresh pulse over the existing GET stream");
  } finally {
    refreshController.abort();
    await refreshStream.body?.cancel().catch(() => {});
    refreshReader.releaseLock();
  }
  const releaseBHandshake = await rpc("tools/call", {
    name: "open_workspace",
    arguments: { path: workspaceRoot, mode: "checkout" },
  }, releaseBSessionId);
  assert.notEqual(releaseBHandshake.payload?.result?.isError, true,
    "fresh release B registration and acknowledgement restore ordinary calls");
  const releaseBHash = createHash("sha256").update(releaseBSessionId).digest("hex");
  const releaseBDiagnostics = await fetch(new URL("/diagnostics", url), {
    headers: { "x-kontrol-diagnostics": diagnosticsSecret },
  }).then((response) => response.json()) as any;
  const releaseBSession = releaseBDiagnostics.mcpSessionMetrics.sessions
    .find((item: any) => item.sessionIdSha256 === releaseBHash);
  assert.equal(releaseBSession?.toolCatalogHandshake?.status, "accepted");
  assert.ok((releaseBSession?.catalogRefresh?.toolListRefreshSuccesses ?? 0) >= 1,
    "authenticated diagnostics distinguish a successful refresh notification from a client registry capture");

  const probeChild = spawn(process.execPath, [
    "scripts/probe-mcp-tunnel.mjs",
    "--url", url.replace(/\/mcp$/, ""),
    "--dual",
    "--cycles", "1",
    "--workspace", workspaceRoot,
    "--watcher-timeout-ms", "1000",
    "--heartbeat-interval-ms", "1000",
    "--heartbeat-count", "1",
    "--heartbeat-timeout-ms", "5000",
    "--resource-load-reads", "2",
    "--minimum-drain-events", "0",
    "--tool-name", "exec_command",
    "--tool-command", "printf tunnel-regression-ok",
    "--diagnostics-secret", diagnosticsSecret,
    "--tunnel-reviewer-file", join(configDir, "tunnel-reviewer.secret"),
  ], {
    cwd: process.cwd(),
    env: { PATH: process.env.PATH ?? "", KONTROL_MCP_SSE_HEARTBEAT_MS: "1000" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let probeStdout = "";
  let probeStderr = "";
  probeChild.stdout.setEncoding("utf8").on("data", (chunk: string) => { probeStdout += chunk; });
  probeChild.stderr.setEncoding("utf8").on("data", (chunk: string) => { probeStderr += chunk; });
  const probeResult = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    const timeout = setTimeout(() => probeChild.kill("SIGTERM"), 60_000);
    probeChild.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    probeChild.once("close", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });
  assert.equal(probeResult.code, 0,
    `strict-mode dual probe must complete its initial and replacement sessions; signal=${probeResult.signal}; stderr=${probeStderr}; stdout=${probeStdout}`);
  const probeReport = JSON.parse(probeStdout.trim().split(/\r?\n/).at(-1) ?? "{}");
  assert.equal(probeReport.ok, true);
  assert.ok(probeReport.probeClientAcknowledgements.length >= 3,
    "both dual sessions and the replacement session must acknowledge independently");
  assert.ok(probeReport.probeClientAcknowledgements.every((item: any) =>
    item.source === "kontrol_probe_client" && item.status === "accepted"
      && /^[a-f0-9]{64}$/.test(item.sessionIdSha256)),
  "probe-client acknowledgements must be accepted and labeled separately from external-host evidence");
  assert.equal(new Set(probeReport.probeClientAcknowledgements.map((item: any) => item.sessionIdSha256)).size,
    probeReport.probeClientAcknowledgements.length,
  "each replacement transport must acknowledge its own catalog session");
  console.log("mcp-tool-catalog-http.test.ts: strict-mode handshake passed");
} finally {
  await running.drain();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  await running.close();
  rmSync(workspaceRoot, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(configDir, { recursive: true, force: true });
  rmSync(worktreeRoot, { recursive: true, force: true });
}
