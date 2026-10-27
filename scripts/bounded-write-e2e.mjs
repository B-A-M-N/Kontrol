/**
 * §9 bounded-write e2e qualification.
 * Boots a fresh Kontrol core with the current branch, schedules a bounded
 * file-write job, and verifies the artifact appears with a publication receipt.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { createServer as createHttpServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = mkdtempSync(join(tmpdir(), "kontrol-bw-root-"));
const stateDir = mkdtempSync(join(tmpdir(), "kontrol-bw-state-"));
const configDir = mkdtempSync(join(tmpdir(), "kontrol-bw-config-"));
const envFile = join(configDir, "bw.env");
const artifactPath = join(root, "Hello-World.txt");
const artifactContent = "hello from bounded write\n";
const expectedSha256 = createHash("sha256").update(artifactContent).digest("hex");
const reviewerToken = "bw-e2e-reviewer-token-long-enough-for-policy";
const agentSecret = "bw-e2e-agent-secret-long-enough-for-policy";
const adapterSecret = "bw-e2e-adapter-secret-long-enough-for-policy";

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
].join("\n") + "\n");

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function findFreePort(excluded = new Set()) {
  for (;;) {
    const probe = createHttpServer();
    await new Promise((ok, fail) => { probe.once("error", fail); probe.listen(0, "127.0.0.1", ok); });
    const port = probe.address().port;
    await new Promise((ok) => probe.close(ok));
    if (!excluded.has(port)) return port;
  }
}
const PORT = await findFreePort();
const AGENT_PORT = await findFreePort(new Set([PORT]));
let agentRuns = 0;
const registeredAgent = { id: undefined, credential: undefined };
let server;
let agentServer;

async function sendLifecycleEvent(body, remoteRunId, type, payload = {}) {
  assert.ok(registeredAgent.id && registeredAgent.credential, "agent identity and credential are registered before dispatch");
  const eventId = `bounded-write-${remoteRunId}-${type}`;
  const response = await fetch(`http://127.0.0.1:${PORT}/acp/runs/${encodeURIComponent(body.parent_run_id)}/events`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      authorization: `Bearer ${agentSecret}`,
      "x-kontrol-agent-id": registeredAgent.id,
      "x-kontrol-agent-credential": registeredAgent.credential,
    },
    body: JSON.stringify({
      type,
      event_id: eventId,
      remote_run_id: remoteRunId,
      work_session_id: body.session_id,
      agent_id: registeredAgent.id,
      attempt_number: body.attempt_number,
      dispatch_idempotency_key: body.dispatch_idempotency_key,
      workspace_lease_nonce: body.workspace_lease_nonce,
      payload,
    }),
  });
  const responseBody = await response.json();
  assert.equal(response.status, 202, `lifecycle ${type} accepted: ${JSON.stringify(responseBody)}`);
  assert.equal(responseBody.accepted, true, `lifecycle ${type} durably acknowledged`);
  assert.equal(responseBody.event_id, eventId, "acknowledgment binds the stable event ID");
  if (type === "completed") {
    assert.equal(responseBody.dispatch_receipt_acknowledged, true, "terminal lifecycle acknowledgment is bound to the dispatch receipt");
    assert.equal(responseBody.dispatch_idempotency_key, body.dispatch_idempotency_key);
    assert.equal(responseBody.remote_run_id, remoteRunId);
    assert.equal(responseBody.attempt_number, body.attempt_number);
  }
  return responseBody;
}

// ── Agent fixture: bounded-write Hermes adapter that calls Kontrol MCP staged_file_write ──
async function startAgent() {
  const http = await import("node:http");
  const agent = http.createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/runs") {
      const chunks = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      agentRuns += 1;
      const grant = body.bounded_file_write_grant;
      const remoteRunId = `bw-${agentRuns}`;
      if (!grant?.signature || !body.session_id) {
        res.writeHead(403).end(JSON.stringify({ error: { code: "bounded_file_write_grant_invalid" } }));
        return;
      }
      // Dispatch acceptance is separate from worker completion. Return the
      // stable remote run identity before doing fixture work, then report the
      // terminal lifecycle outcome through the authenticated event endpoint.
      res.writeHead(202).end(JSON.stringify({
        run_id: remoteRunId,
        remote_run_id: remoteRunId,
        accepted: true,
        status: "running",
        dispatch_idempotency_key: body.dispatch_idempotency_key,
        attempt_number: body.attempt_number,
        execution_receipt: {
          mode: "bounded_file_write",
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
          confinement: grant.networkPolicy === "host"
            ? "bubblewrap-read-only-workspace-host-network"
            : "bubblewrap-read-only-workspace-no-network",
        },
      }));
      // Simulate the Hermes adapter/runner boundary: the runner derives its
      // signed MCP worker identity from the adapter's configured agent secret.
      try {
        const { signWorkerToken } = await import("./lib/acp-worker-token.mjs");
        const mcpUrl = `http://127.0.0.1:${PORT}/mcp`;
        const workerToken = signWorkerToken({
          role: "worker",
          workSessionId: body.session_id,
          workspaceSessionId: body.workspace_session_id,
          runId: body.parent_run_id,
          exp: Date.now() + 60_000,
        }, agentSecret);
        const workspaceSessionId = body.workspace_session_id;
        if (!mcpUrl || !workerToken) throw new Error("MCP env incomplete");

        const headers = {
          "Content-Type": "application/json",
          "Accept": "application/json, text/event-stream",
          "X-Kontrol-Worker-Token": workerToken,
        };
        let mcpSessionId;
        async function mcpRpc(method, params, notification = false) {
          const reqBody = { jsonrpc: "2.0", method };
          if (!notification) reqBody.id = `rpc-${agentRuns}-${Date.now()}`;
          if (params !== undefined) reqBody.params = params;
          const reqHeaders = { ...headers };
          if (mcpSessionId) reqHeaders["Mcp-Session-Id"] = mcpSessionId;
          const fetchResp = await fetch(mcpUrl, {
            method: "POST",
            headers: reqHeaders,
            body: JSON.stringify(reqBody),
          });
          if (fetchResp.headers.get("mcp-session-id")) mcpSessionId = fetchResp.headers.get("mcp-session-id");
          const raw = await fetchResp.text();
          if (!fetchResp.ok) throw new Error(`MCP ${method} failed with HTTP ${fetchResp.status}: ${raw}`);
          if (!raw.trim()) {
            if (notification) return null;
            throw new Error(`MCP ${method} returned an empty response`);
          }
          if (fetchResp.headers.get("content-type")?.includes("text/event-stream")) {
            const lines = raw.split("\n").filter((l) => l.startsWith("data: "));
            return JSON.parse(lines[lines.length - 1]?.slice(6) || "{}");
          }
          return JSON.parse(raw);
        }
        await mcpRpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "bw-fixture", version: "1.0.0" } });
        await mcpRpc("notifications/initialized", {}, true);
        const openResp = await mcpRpc("tools/call", { name: "open_workspace", arguments: { path: root } });
        const workspaceId = openResp?.result?.structuredContent?.workspaceId;
        if (!workspaceId) throw new Error(`open_workspace failed: ${JSON.stringify(openResp)}`);
        const writeResp = await mcpRpc("tools/call", {
          name: "staged_file_write",
          arguments: { workspaceId, path: "Hello-World.txt", content: artifactContent },
        });
        if (writeResp?.result?.isError) {
          throw new Error(`staged_file_write failed: ${JSON.stringify(writeResp)}`);
        }
        const sha = writeResp?.result?.structuredContent?.contentSha256;
        console.log(`[bw-e2e] agent published ${sha}`);
      } catch (error) {
        console.error("[bw-e2e] agent write failed:", error.message);
        try {
          await sendLifecycleEvent(body, remoteRunId, "failed", { error: error.message });
        } catch (eventError) {
          console.error("[bw-e2e] failed lifecycle event was not acknowledged:", eventError.message);
        }
        return;
      }
      try {
        const ack = await sendLifecycleEvent(body, remoteRunId, "completed", {
          final_output: "bounded write completed",
        });
        console.log(`[bw-e2e] durable terminal event acknowledged: ${ack.event_id}`);
      } catch (error) {
        console.error("[bw-e2e] completed lifecycle event was not acknowledged:", error.message);
      }
      return;
    }
    res.writeHead(200).end("{}");
  });
  await new Promise((r) => agent.listen(AGENT_PORT, "127.0.0.1", r));
  return agent;
}

async function startServer() {
  const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", "serve"], {
    env: {
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

    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => process.stdout.write(`[server] ${d}`));
  child.stderr.on("data", (d) => process.stderr.write(`[server:err] ${d}`));
  return child;
}

async function waitForHealth(timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/healthz`);
      if (res.ok) return;
    } catch {}
    await delay(200);
  }
  throw new Error("server did not become healthy");
}

// ── MCP session helpers ──
let mcpSessionId;
async function rpc(method, params, notification = false) {
  const headers = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
    "Authorization": `Bearer ${reviewerToken}`,
    "x-kontrol-tunnel-reviewer": reviewerToken,
  };
  if (mcpSessionId) headers["Mcp-Session-Id"] = mcpSessionId;
  const resp = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      method,
      ...(notification ? {} : { id: method }),
      ...(params === undefined ? {} : { params }),
    }),
  });
  if (resp.headers.get("mcp-session-id")) mcpSessionId = resp.headers.get("mcp-session-id");
  const raw = await resp.text();
  if (!resp.ok) throw new Error(`MCP ${method} failed with HTTP ${resp.status}: ${raw}`);
  if (!raw.trim()) {
    if (notification) return null;
    throw new Error(`MCP ${method} returned an empty response`);
  }
  if (resp.headers.get("content-type")?.includes("text/event-stream")) {
    const lines = raw.split("\n").filter((l) => l.startsWith("data: "));
    return JSON.parse(lines[lines.length - 1]?.slice(6) || "{}");
  }
  return JSON.parse(raw);
}
async function mcpCall(name, args) {
  const result = await rpc("tools/call", { name, arguments: args });
  return result?.result ?? result;
}

// ── Run ──
try {
  agentServer = await startAgent();
  server = await startServer();
  await waitForHealth();
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "bw-e2e", version: "1.0.0" } });
  await rpc("notifications/initialized", {}, true);
  const wsResult = await mcpCall("open_workspace", { path: root });
  const workspaceId = wsResult?.structuredContent?.workspaceId;
  assert.ok(workspaceId, `open_workspace returned workspaceId: ${JSON.stringify(wsResult)}`);

  // Register the bounded-write agent
  const registerResp = await fetch(`http://127.0.0.1:${PORT}/acp/agents/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", authorization: `Bearer ${agentSecret}` },
    body: JSON.stringify({
      name: "bw-agent",
      url: `http://127.0.0.1:${AGENT_PORT}`,
      description: "bounded-write fixture",
      role: "agent",
      capabilities: ["bounded-write"],
      ttlSeconds: 90,
    }),
  });
  const registerBody = await registerResp.json();
  assert.equal(registerResp.status, 201, `agent registration succeeds: ${JSON.stringify(registerBody)}`);
  assert.ok(registerBody.id && registerBody.agentCredential, `registration returns id and credential: ${JSON.stringify(registerBody)}`);
  registeredAgent.id = registerBody.id;
  registeredAgent.credential = registerBody.agentCredential;
  console.log("[bw-e2e] agent registered:", registeredAgent.id);

  // Schedule bounded_file_write
  const runAt = new Date(Date.now() + 3_000).toISOString();
  const scheduleResult = await mcpCall("schedule_job", {
    workspaceId,
    runAt,
    instructions: `Create the file Hello-World.txt with exactly: ${artifactContent}`,
    executionMode: "bounded_file_write",
    allowedOutputs: [{ path: "Hello-World.txt", operation: "create", expectedSha256, overwrite: "deny" }],
    maxRuntimeMinutes: 2,
    agentName: "bw-agent",
  });
  const jobId = scheduleResult?.structuredContent?.scheduledJobId;
  assert.ok(jobId, `schedule_job returned jobId: ${JSON.stringify(scheduleResult)}`);
  console.log("[bw-e2e] scheduled job:", jobId);

  // Wait for completion
  const deadline = Date.now() + 30_000;
  let jobStatus = "pending";
  while (Date.now() < deadline) {
    const jobs = await mcpCall("get_scheduled_job", { scheduledJobId: jobId });
    jobStatus = jobs?.structuredContent?.status ?? "pending";
    if (["completed", "failed", "cancelled", "blocked", "awaiting_approval"].includes(jobStatus)) break;
    await delay(500);
  }
  console.log("[bw-e2e] job status:", jobStatus);
  assert.equal(jobStatus, "completed", `bounded-write job should complete autonomously (got ${jobStatus})`);

  // Verify the file
  assert.ok(existsSync(artifactPath), "bounded-write file exists on disk");
  const content = readFileSync(artifactPath, "utf8");
  assert.equal(content, artifactContent, "file bytes match exactly");
  console.log("[bw-e2e] file content verified:", createHash("sha256").update(content).digest("hex") === expectedSha256);

  // Verify the result receipt
  const receipt = await mcpCall("get_scheduled_job_result", { scheduledJobId: jobId });
  const r = receipt?.structuredContent?.resultReceipt;
  assert.equal(r?.publicationStatus, "committed", "publication is committed");
  assert.equal(r?.outcomeObserved, true, "outcome is independently observed");
  assert.equal(r?.verificationStatus, "not_performed", "independent command verification is not claimed by this fixture");
  console.log("[bw-e2e] publication receipt verified");

  assert.equal(agentRuns, 1, "bounded-write E2E dispatched exactly one ACP attempt");
  const inspectionDb = new Database(join(stateDir, "kontrol.sqlite"), { readonly: true });
  try {
    const storedJob = inspectionDb.prepare(
      "select id, status, active_dispatch_attempt_id from scheduled_jobs where id = ?",
    ).get(jobId);
    assert.equal(storedJob?.status, "completed", "the SQLite scheduled-job row is terminal");
    const attempt = inspectionDb.prepare(`
      select id, dispatch_id, acp_run_id, acp_dispatch_id, acp_attempt_number, acp_remote_run_id,
             worker_execution_outcome, completed_at, publication_receipts_json
        from scheduled_job_attempts
       where job_id = ?
       order by started_at desc, id desc
       limit 1
    `).get(jobId);
    assert.ok(attempt?.acp_run_id, "the exact ACP run is durably bound to the attempt");
    assert.equal(attempt?.acp_dispatch_id, attempt?.dispatch_id, "the adapter dispatch key is durable on the same attempt");
    assert.equal(attempt?.acp_attempt_number, 1, "the exact ACP attempt number is durable");
    assert.equal(attempt?.acp_remote_run_id, "bw-1", "the remote worker identity is durable");
    assert.equal(attempt?.worker_execution_outcome, "completed", "authenticated lifecycle completion is projected");
    assert.ok(attempt?.completed_at, "the scheduled attempt has a durable completion timestamp");
    const publicationReceipts = JSON.parse(attempt.publication_receipts_json || "[]");
    assert.equal(publicationReceipts.length, 1, "exactly one publication receipt was persisted");
    assert.equal(publicationReceipts[0].outcome, "committed");
    assert.equal(publicationReceipts[0].attemptId, attempt.id, "receipt is bound to the active attempt");
    assert.equal(publicationReceipts[0].attemptNumber, attempt.acp_attempt_number);
    assert.equal(publicationReceipts[0].runId, attempt.acp_run_id, "receipt carries the exact ACP run identity");
    assert.equal(publicationReceipts[0].dispatchIdempotencyKey, attempt.acp_dispatch_id, "receipt carries the exact dispatch identity");
    assert.equal(publicationReceipts[0].readBackVerified, true);
    const terminalEvent = inspectionDb.prepare(
      "select id, type, payload from event_log where id = ?",
    ).get("bounded-write-bw-1-completed");
    assert.equal(terminalEvent?.type, "worker.turn.completed", "the exact authenticated terminal event is durable");
  } finally {
    inspectionDb.close();
  }
  console.log("[bw-e2e] SQLite confirms one attempt, one publication receipt, and one terminal event");

  await new Promise((resolveClose) => agentServer.close(resolveClose));
  server.kill("SIGTERM");
  await once(server, "exit").catch(() => {});
  console.log("bounded-write-e2e: passed");
} catch (error) {
  console.error("[bw-e2e] FAILED:", error.message);
  if (server) { server.kill("SIGKILL"); }
  process.exitCode = 1;
} finally {
  if (agentServer?.listening) await new Promise((resolveClose) => agentServer.close(resolveClose));
  if (server && server.exitCode === null) {
    const exited = once(server, "exit").catch(() => {});
    server.kill("SIGTERM");
    await exited;
  }
  if (!process.env.KONTROL_BW_KEEP) {
    rmSync(root, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  } else {
    console.log("kept:", root, stateDir, configDir);
  }
}
