/**
 * True unattended scheduled-job lifecycle qualification (K07).
 *
 * Proves the production server's own scheduler wakes a publicly scheduled job,
 * a disposable ACP lifecycle fixture completes a bounded task with an
 * independently checkable artifact, and the job reaches its terminal state
 * with artifact and work-session correlation intact. This qualifies scheduler
 * lifecycle behavior, not bundled adapter confinement; the separate
 * scheduled-readonly-adapters-e2e fixture covers that boundary.
 *
 * Distinct from scripts/scheduled-job-e2e.mjs (dispatch-acceptance only):
 *   1. Boot the real Kontrol core with ACP enabled.
 *   2. Register a disposable loopback ACP fixture via the production
 *      /agents/register route; stand up its /runs endpoint to complete a
 *      bounded task and emit an artifact with independently checkable
 *      contents.
 *   3. Create a due job through the public authorized scheduling tool (MCP),
 *      NOT direct SQLite insert.
 *   4. Leave the production server's own scheduler responsible for firing it.
 *   5. Verify the job reaches a terminal state with artifact/correlation.
 *   6. Restart before launch, after launch, and with a lost acknowledgement.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const root = mkdtempSync(join(tmpdir(), "kontrol-unattended-root-"));
const stateDir = mkdtempSync(join(tmpdir(), "kontrol-unattended-state-"));
const configDir = mkdtempSync(join(tmpdir(), "kontrol-unattended-config-"));
const envFile = join(configDir, "unattended.env");
const artifactPath = join(root, "unattended-audit-artifact.json");
const artifactContents = JSON.stringify({ auditStatus: "clean", checkedPaths: 3 }, null, 2);
const reviewerToken = "unattended-e2e-reviewer-token-long";
const agentSecret = "unattended-e2e-agent-secret-long";
const adapterSecret = "unattended-e2e-adapter-secret-long";
async function findFreeLoopbackPort(excludedPorts = new Set()) {
  for (;;) {
    const probe = createHttpServer();
    await new Promise((resolveListen, reject) => {
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", resolveListen);
    });
    const address = probe.address();
    if (!address || typeof address === "string") throw new Error("Could not allocate a loopback fixture port.");
    await new Promise((resolveClose, reject) => probe.close((error) => error ? reject(error) : resolveClose()));
    if (!excludedPorts.has(address.port)) return address.port;
  }
}
const PORT = await findFreeLoopbackPort();
const AGENT_PORT = await findFreeLoopbackPort(new Set([PORT]));
let agentRuns = 0;
let agentIdentity;
let pendingCompletion;
let server;
const serverOutput = new WeakMap();

writeFileSync(join(root, "tracked.txt"), "baseline\n");
writeFileSync(envFile, [
  `KONTROL_CONFIG_DIR=${configDir}`,
  `KONTROL_ALLOWED_ROOTS=${root}`,
  `KONTROL_STATE_DIR=${stateDir}`,
  "HOST=127.0.0.1",
  "KONTROL_ACP_ENABLED=true",
  "KONTROL_READ_ONLY_NETWORK_POLICY=host",
  "KONTROL_TOOL_MODE=full",
  "KONTROL_POLICY_MODE=allow",
  "KONTROL_AUTH_MODE=tunnel",
  "KONTROL_LOG_LEVEL=error",
  "KONTROL_LOG_REQUESTS=0",
  `KONTROL_ACP_AGENT_SECRET=${agentSecret}`,
  `KONTROL_ACP_REVIEWER_SECRET=${reviewerToken}`,
  `KONTROL_ACP_ADAPTER_SECRET=${adapterSecret}`,
  `PORT=${PORT}`,
].join("\n") + "\n");

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function startAgent() {
  const agent = createHttpServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        executionCapabilities: {
          read_only_audit: {
            // Synthetic contract for scheduler lifecycle coverage only. This
            // fixture does not provide evidence of adapter confinement.
            supported: true,
            grantPolicy: "kontrol_signed_attempt_bound",
            confinementAvailable: true,
            executableAvailable: true,
            cliInputContract: "hermes_public_acp_v1_session_prompt",
            networkPolicies: ["host"],
          },
        },
      }));
      return;
    }
    if (req.method === "POST" && req.url === "/runs") {
      const chunks = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      agentRuns += 1;
      // Disposable execution fixture: write a checkable artifact and retain
      // the run for terminal delivery after the server restart boundary.
      writeFileSync(artifactPath, artifactContents);
      const remoteRunId = `remote-unattended-${agentRuns}`;
      const grant = body.read_only_execution_grant;
      assert.ok(grant?.signature, "scheduled read-only dispatch carries a signed execution grant");
      pendingCompletion = { body, remoteRunId, grant };
      const executionReceipt = {
        mode: "read_only_audit",
        execution_grant: grant,
        issuer: "kontrol",
        work_session_id: body.session_id,
        workspace_session_id: body.workspace_session_id,
        parent_run_id: body.parent_run_id,
        remote_run_id: remoteRunId,
        attempt_number: body.attempt_number,
        dispatch_idempotency_key: body.dispatch_idempotency_key,
        grant_expires_at: grant.expiresAt,
        grant_fingerprint: createHash("sha256").update(grant.signature).digest("hex"),
        network_policy: grant.networkPolicy,
        confinement: grant.networkPolicy === "host" ? "bubblewrap-read-only-workspace-host-network" : "bubblewrap-read-only-workspace-no-network",
      };
      res.writeHead(202, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        run_id: remoteRunId,
        remote_run_id: remoteRunId,
        accepted: true,
        status: "running",
        dispatch_idempotency_key: body.dispatch_idempotency_key,
        execution_receipt: executionReceipt,
        output: [],
      }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise((r) => agent.listen(AGENT_PORT, "127.0.0.1", r));
  return agent;
}

async function startServer() {
  const serverEnv = {
    ...process.env,
    KONTROL_ENV_FILE: envFile,
    KONTROL_CONFIG_DIR: configDir,
    KONTROL_ALLOWED_ROOTS: root,
    KONTROL_STATE_DIR: stateDir,
    KONTROL_AUTH_MODE: "tunnel",
    KONTROL_ACP_ENABLED: "true",
    KONTROL_READ_ONLY_NETWORK_POLICY: "host",
    KONTROL_TOOL_MODE: "full",
    KONTROL_POLICY_MODE: "allow",
    KONTROL_LOG_LEVEL: "error",
    KONTROL_LOG_REQUESTS: "0",
    KONTROL_ACP_AGENT_SECRET: agentSecret,
    KONTROL_ACP_REVIEWER_SECRET: reviewerToken,
    KONTROL_ACP_ADAPTER_SECRET: adapterSecret,
    PORT: String(PORT),
  };
  const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", "serve"], {
    cwd: repoRoot, env: serverEnv, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  serverOutput.set(child, () => output.slice(-4_000));
  child.stdout.on("data", (c) => { output += String(c); });
  child.stderr.on("data", (c) => { output += String(c); });
  child.once("exit", (code) => {
    if (code !== 0 && code !== null) console.error("[unattended-e2e] server exited", { code, output: output.slice(-2000) });
  });
  return child;
}

async function waitForHealth(timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/healthz`);
      if (res.ok) return true;
    } catch { /* retry */ }
    await delay(150);
  }
  const exit = server?.exitCode;
  const output = server && serverOutput.get(server)?.();
  throw new Error(`server health timeout (pid=${server?.pid ?? "unknown"}${exit === null || exit === undefined ? "" : `, exit=${exit}`})${output ? `\n${output}` : ""}`);
}

async function registerAgent() {
  const res = await fetch(`http://127.0.0.1:${PORT}/acp/agents/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${agentSecret}` },
    body: JSON.stringify({
      name: "unattended-audit-agent",
      url: `http://127.0.0.1:${AGENT_PORT}`,
      role: "agent",
      capabilities: ["code", "scheduled:read_only_audit"],
      ttlSeconds: 600,
    }),
  });
  if (!res.ok) throw new Error(`agent registration failed: ${res.status} ${await res.text()}`);
  const body = await res.json();
  assert.ok(body.id, "agent registration returns an id");
  assert.ok(body.agentCredential, "agent registration returns an event credential");
  agentIdentity = { id: body.id, credential: body.agentCredential };
}

async function deliverPendingCompletion() {
  assert.ok(pendingCompletion, "fixture has an accepted run to complete");
  assert.ok(agentIdentity, "fixture has a registered agent identity");
  const { body, remoteRunId, grant } = pendingCompletion;
  const event = {
    event_id: `${remoteRunId}:1`,
    event_sequence: 1,
    type: "completed",
    remote_run_id: remoteRunId,
    work_session_id: body.session_id,
    attempt_number: body.attempt_number,
    dispatch_idempotency_key: body.dispatch_idempotency_key,
    read_only_execution_grant: grant,
    payload: {
      status: "completed",
      final_output: "Read-only audit complete. The disposable fixture artifact was written and checked.",
    },
  };
  const url = `http://127.0.0.1:${PORT}/acp/runs/${encodeURIComponent(body.parent_run_id)}/events`;
  let lastFailure = "no response";
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${agentSecret}`,
          "x-kontrol-agent-id": agentIdentity.id,
          "x-kontrol-agent-credential": agentIdentity.credential,
        },
        body: JSON.stringify(event),
      });
      const result = await response.json().catch(() => ({}));
      if (response.ok && result.dispatch_receipt_acknowledged === true) return result;
      lastFailure = `HTTP ${response.status} ${result.error?.code ?? "unacknowledged"}`;
      if (response.status >= 400 && response.status < 500 && response.status !== 404) break;
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }
    await delay(250);
  }
  throw new Error(`fixture terminal event was not durably acknowledged: ${lastFailure}`);
}

let mcpSessionId;
let requestId = 0;

async function rpc(method, params, { withSession = true } = {}) {
  const headers = {
    "content-type": "application/json",
    "accept": "application/json, text/event-stream",
  };
  headers.authorization = `Bearer ${reviewerToken}`;
  headers["x-kontrol-reviewer-token"] = reviewerToken;
  if (withSession && mcpSessionId) headers["mcp-session-id"] = mcpSessionId;
  const response = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
    method: "POST", headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, params }),
  });
  const text = await response.text();
  if (process.env.KONTROL_UNATTENDED_DEBUG) console.error(`[unattended-e2e] ${method} raw: ${text.slice(0, 500)}`);
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    const jsonLine = text.split("\n").find((line) => line.startsWith("data:"));
    payload = JSON.parse(jsonLine?.slice(5) ?? "{}");
  }
  if (method === "initialize") {
    mcpSessionId = response.headers.get("mcp-session-id") ?? mcpSessionId;
    console.error(`[unattended-e2e] session: ${mcpSessionId}`);
  }
  if (payload.error) throw new Error(`${method}: ${payload.error.message}`);
  return payload.result;
}

async function mcpCall(name, args) {
  if (!mcpSessionId) {
    await rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "unattended-e2e", version: "1" },
    }, { withSession: false });
  }
  return rpc("tools/call", { name, arguments: args });
}

async function main() {
  const agent = await startAgent();

  // ── Restart before launch ──
  let first = await startServer();
  server = first;
  try {
    await waitForHealth();
    await registerAgent();
    first.kill("SIGTERM");
    await once(first, "exit").catch(() => {});
    first = await startServer();
    server = first;
    await waitForHealth();

    // ── Public authorized scheduling tool ──
    // Call schedule_job via MCP (not direct SQLite insert).
    // The production server's own scheduler is responsible for firing it.
    // We do not call drainOnce() anywhere in this script.
    const runAt = new Date(Date.now() + 5000).toISOString();
    // Establish the MCP session once, then use it for all tool calls.
    const workspaceResult = await mcpCall("open_workspace", { path: root });
    const toolsList = await rpc("tools/list", {});
    const toolNames = (toolsList?.tools ?? []).map((t) => t.name);
    assert.ok(toolNames.includes("schedule_job"), `schedule_job is in the tool catalog: ${toolNames.join(",")}`);
    const workspaceId = workspaceResult?.structuredContent?.workspaceId ?? workspaceResult?.workspaceId;
    assert.ok(workspaceId, `open_workspace returned an ID: ${JSON.stringify(workspaceResult)}`);
    const scheduleResult = await mcpCall("schedule_job", {
      workspaceId,
      runAt,
      instructions: "Read-only audit: inspect tracked files and emit artifact.",
      executionMode: "read_only_audit",
      maxRuntimeMinutes: 1,
      agentName: "unattended-audit-agent",
    });
    const jobId = scheduleResult?.structuredContent?.scheduledJobId;
    if (!jobId) console.error("[unattended-e2e] schedule_job result:", JSON.stringify(scheduleResult, null, 2));
    assert.ok(jobId, `schedule_job returned a job ID: ${JSON.stringify(scheduleResult)}`);

    // Wait for the server's own scheduler to wake the job.
    const deadline = Date.now() + 30000;
    let jobStatus = "pending";
    while (Date.now() < deadline) {
      const jobs = await mcpCall("get_scheduled_job", { scheduledJobId: jobId });
      jobStatus = jobs?.structuredContent?.status ?? "pending";
      if (["running", "awaiting_approval", "completed", "failed", "cancelled", "blocked"].includes(jobStatus)) break;
      await delay(200);
    }
    const dispatchReceipt = await mcpCall("get_scheduled_job_result", { scheduledJobId: jobId });
    assert.notEqual(jobStatus, "pending", `production scheduler fired the job (status=${jobStatus})`);
    assert.equal(jobStatus, "running", `the scheduled ACP attempt was accepted and remains observable; receipt=${JSON.stringify(dispatchReceipt?.structuredContent?.resultReceipt ?? dispatchReceipt).slice(0, 2_000)}`);
    assert.equal(dispatchReceipt?.structuredContent?.resultReceipt?.executionReceipt?.issuer, "kontrol",
      "the accepted scheduled dispatch preserves its exact read-only execution receipt");
    assert.match(dispatchReceipt.structuredContent.resultReceipt.executionReceipt.grant_fingerprint, /^[a-f0-9]{64}$/);
    assert.equal(dispatchReceipt.structuredContent.resultReceipt.executionReceipt.network_policy, "host",
      "the configured network policy is bound into the scheduled execution receipt");
    assert.equal(dispatchReceipt.structuredContent.resultReceipt.verificationLevel, "not_performed",
      "an accepted worker run is not represented as independently verified work");

    assert.ok(existsSync(artifactPath), "the unattended fixture wrote its artifact");
    const persisted = readFileSync(artifactPath, "utf8");
    assert.equal(JSON.parse(persisted).auditStatus, "clean", "artifact has independently checkable contents");

    // ── Restart after launch ──
    first.kill("SIGTERM");
    await once(first, "exit").catch(() => {});
    server = undefined;
    const second = await startServer();
    server = second;
    await waitForHealth();
    mcpSessionId = undefined;

    // ── Lost acknowledgement restart ──
    // Simulate the server dying after dispatch but before terminal projection.
    // The fixture already wrote its artifact, so restart must recover the
    // accepted launch without a duplicate remote request.
    second.kill("SIGTERM");
    await once(second, "exit").catch(() => {});
    server = undefined;
    const third = await startServer();
    server = third;
    await waitForHealth();
    mcpSessionId = undefined;

    const terminalAck = await deliverPendingCompletion();
    assert.equal(terminalAck.remote_run_id, pendingCompletion.remoteRunId);

    const finalJobs = await mcpCall("list_scheduled_jobs", { limit: 10 });
    const finalList = finalJobs?.structuredContent?.jobs ?? [];
    assert.ok(finalList.length > 0, "scheduled job survived restart");
    assert.equal(agentRuns, 1, `no duplicate dispatch after lost acknowledgement (got ${agentRuns})`);
    let finalReceiptResult;
    let finalReceipt;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      finalReceiptResult = await mcpCall("get_scheduled_job_result", { scheduledJobId: jobId });
      finalReceipt = finalReceiptResult?.structuredContent?.resultReceipt;
      if (finalReceipt?.workerCompleted && finalReceipt.reportAvailability === "available") break;
      await delay(200);
    }
    assert.equal(finalReceipt?.workerCompleted, true, "fresh MCP transport retrieves completed worker evidence after restart");
    assert.equal(finalReceipt?.reportAvailability, "available", "terminal report finalization survives restart");
    assert.equal(finalReceipt?.reviewApproved, false, "worker completion does not imply reviewer approval");
    assert.equal(finalReceipt?.verificationStatus, "not_performed", "report-only fixture does not imply verification");
    const snapshot = await mcpCall("get_work_session_snapshot", { sessionId: finalReceipt.workSessionId });
    const sessionSnapshot = snapshot?.structuredContent;
    assert.equal(sessionSnapshot?.sessionId, finalReceipt.workSessionId);
    assert.equal(sessionSnapshot?.runId, finalReceipt.runId);
    assert.ok(sessionSnapshot?.lastSeq > 0, "fresh MCP session snapshot includes durable lifecycle activity");

    third.kill("SIGTERM");
    await once(third, "exit").catch(() => {});
    server = undefined;
  } finally {
    if (server?.exitCode === null) {
      server.kill("SIGTERM");
      await once(server, "exit").catch(() => {});
    }
    await new Promise((r) => agent.close(r));
  }

  console.log("scripts/scheduled-job-unattended-e2e.mjs: passed");
}

try {
  await main();
} finally {
  rmSync(root, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(configDir, { recursive: true, force: true });
}
