#!/usr/bin/env node
// P0 regression: Hermes ordinary delegation must not require a signed
// execution grant, and idempotent replay must not throw.
//   - ordinary dispatch without a grant must pass the grant gate (it is
//     still fenced by the workspace-lease check) instead of 403
//     execution_grant_incomplete;
//   - retrying an accepted dispatch idempotency key must return the recorded
//     run identity (replayed:true) instead of throwing ReferenceError from
//     `run.workerToken` before `run` is declared.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";

// Run the adapter from the tree under test, never a hardcoded checkout path.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const root = mkdtempSync(join(tmpdir(), "kontrol-hermes-dispatch-regression-"));
const stateDir = join(root, "state");
const workspaceRoot = join(root, "workspace");
const { mkdirSync } = await import("node:fs");
mkdirSync(workspaceRoot, { recursive: true });

const ADAPTER_SECRET = "regression-adapter-secret";
const freePort = await new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => {
    const address = probe.address();
    probe.close(() => resolve(typeof address === "object" && address ? address.port : 0));
  });
});
assert.ok(freePort > 0, "a loopback probe port is available for the adapter under test");

// Minimal Kontrol stub: only registration + heartbeat. The adapter must run
// fully offline; no live core is contacted.
const stub = createServer((req, res) => {
  if (req.method === "POST" && req.url === "/agents/register") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ id: "agent-hermes-regression", agentCredential: "cred-regression" }));
    return;
  }
  if (req.method === "POST" && req.url === "/agents/agent-hermes-regression/heartbeat") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "stub: unknown route" }));
});
await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
const stubPort = stub.address().port;

const adapter = spawn(process.execPath, ["scripts/acp-hermes-native-adapter.mjs"], {
  cwd: repoRoot,
  env: {
    ...process.env,
    KONTROL_ACP_AGENT_SECRET: "regression-agent-secret",
    KONTROL_ACP_ADAPTER_SECRET: ADAPTER_SECRET,
    ACP_ADAPTER_PORT: String(freePort),
    KONTROL_ACP_URL: `http://127.0.0.1:${stubPort}`,
    KONTROL_STATE_DIR: stateDir,
    KONTROL_ACP_AGENT_STATE_FILE: join(stateDir, "agent-identity.json"),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let adapterOutput = "";
adapter.stdout.on("data", (chunk) => { adapterOutput += String(chunk); });
adapter.stderr.on("data", (chunk) => { adapterOutput += String(chunk); });

const adapterBase = `http://127.0.0.1:${freePort}`;
// Every adapter call carries a hard deadline: a hung provider must fail this
// test loudly instead of stalling the release gate forever.
async function postRuns(body) {
  const res = await fetch(`${adapterBase}/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json", authorization: `Bearer ${ADAPTER_SECRET}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  return { status: res.status, json: await res.json() };
}

function ordinaryBody(key, withLease) {
  return {
    workspace_root: workspaceRoot,
    parent_run_id: `regression-${key}`,
    session_id: `regression-session-${key}`,
    workspace_session_id: `regression-workspace-${key}`,
    agent_id: "hermes-agent",
    attempt_number: 1,
    dispatch_idempotency_key: key,
    ...(withLease ? {
      workspace_lease_nonce: "regression-lease",
      workspace_lease_expires_at: new Date(Date.now() + 120_000).toISOString(),
    } : {}),
    input: [{ parts: [{ content: "regression task" }] }],
  };
}

try {
  const readyDeadline = Date.now() + 15_000;
  for (;;) {
    try {
      const health = await fetch(`${adapterBase}/health`, { signal: AbortSignal.timeout(5_000) });
      if (health.ok || health.status === 503) break;
    } catch { /* still starting */ }
    if (Date.now() > readyDeadline) throw new Error(`adapter under test did not start (exit=${adapter.exitCode} signal=${adapter.signalCode}): ${adapterOutput.slice(-2000)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  // 1. Ordinary delegation without any execution grant must not be rejected
  // with 403 execution_grant_incomplete. Without a lease it is fenced by the
  // workspace-lease gate (409 workspace_lease_lost).
  const ordinary = await postRuns(ordinaryBody("regression-ordinary-1", false));
  assert.notEqual(ordinary.json?.error?.code, "execution_grant_incomplete",
    `ordinary delegation must not require a signed execution grant (got ${ordinary.status} ${JSON.stringify(ordinary.json).slice(0, 200)})`);
  assert.equal(ordinary.status, 409, "ordinary delegation without a lease stops at the lease fence");
  assert.equal(ordinary.json?.error?.code, "workspace_lease_lost");

  // 1b. A restricted read-only dispatch without a grant is still fenced at
  // the grant validator (403), not waved through by the ordinary path.
  const readOnlyNoGrant = await postRuns({
    ...ordinaryBody("regression-readonly-nogrant", true),
    agent_id: "agent-hermes-regression",
    scheduled_execution_policy: {
      executionMode: "read_only_audit",
      workspaceAccess: "read_only",
      mutate: false,
    },
  });
  assert.equal(readOnlyNoGrant.status, 403, "read-only audit without a grant stays fenced");
  assert.equal(readOnlyNoGrant.json?.error?.code, "read_only_grant_invalid");

  // 2. With a live lease the dispatch is accepted and persisted. Retrying the
  // identical payload must return the recorded run identity with
  // replayed:true instead of throwing.
  const key = "regression-replay-1";
  const first = await postRuns(ordinaryBody(key, true));
  assert.equal(first.status, 202, `leased ordinary dispatch is accepted (got ${first.status} ${JSON.stringify(first.json).slice(0, 300)})`);
  assert.ok(typeof first.json?.remote_run_id === "string" && first.json.remote_run_id.length > 0,
    "the accepted dispatch carries a remote run identity");
  const second = await postRuns(ordinaryBody(key, true));
  assert.equal(second.status, 202, `identical retry returns the existing receipt (got ${second.status} ${JSON.stringify(second.json).slice(0, 300)})`);
  assert.equal(second.json?.replayed, true, "the retry is marked as a replay, not a new run");
  assert.equal(second.json?.remote_run_id, first.json.remote_run_id,
    "the replay returns the original remote run identity");
  assert.ok(!("worker_token" in (second.json ?? {})) || typeof second.json.worker_token === "string",
    "the replay never leaks an undefined token field");

  // 3. Retrying the same idempotency key with different content conflicts
  // instead of launching a second run or overwriting the receipt.
  const conflict = await postRuns({
    ...ordinaryBody(key, true),
    input: [{ parts: [{ content: "a different task" }] }],
  });
  assert.equal(conflict.status, 409, "changed payload on a bound key conflicts");
  assert.equal(conflict.json?.error?.code, "dispatch_idempotency_conflict");

  console.log("acp-hermes-dispatch-regression.test.mjs: ordinary delegation + idempotent replay passed");
} catch (error) {
  // A failing body must surface the adapter transcript: without it an
  // adapter crash is indistinguishable from a test hang.
  console.error(`acp-hermes-dispatch-regression FAILED: ${error instanceof Error ? error.message : String(error)}`);
  console.error(`--- adapter transcript ---\n${adapterOutput.slice(-4000)}`);
  throw error;
} finally {
  // Bounded shutdown: when the adapter already exited (for example a fast
  // startup failure), its 'exit' event fired before any listener attached,
  // so an unbounded wait would hang the whole runtime chain forever.
  adapter.kill("SIGTERM");
  if (adapter.exitCode === null && adapter.signalCode === null) {
    await Promise.race([
      new Promise((resolve) => adapter.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
  }
  if (adapter.exitCode === null && adapter.signalCode === null) {
    adapter.kill("SIGKILL");
    await Promise.race([
      new Promise((resolve) => adapter.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
  }
  stub.closeAllConnections();
  await Promise.race([
    new Promise((resolve) => stub.close(resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  rmSync(root, { recursive: true, force: true });
}
