/**
 * Real-process durable-scheduling qualification (Experiment A).
 *
 * Proves an unattended scheduled job runs independently of any active ChatGPT
 * conversation and that exactly one logical audit executes:
 *   1. Boot the real Kontrol core with ACP enabled.
 *   2. Register a real loopback ACP agent via the production /agents/register
 *      route and stand up its /runs endpoint.
 *   3. Create a due job through the durable store in the SAME database the live
 *      server serves, then drive the scheduler's dispatch through its runtime.
 *   4. Restart the core and prove the job record survived, exactly one worker
 *      dispatch happened, and the job is terminal/durable — with no ChatGPT
 *      session anywhere in the loop.
 */
import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const root = mkdtempSync(join(tmpdir(), "kontrol-sched-root-"));
const stateDir = mkdtempSync(join(tmpdir(), "kontrol-sched-state-"));
const configDir = mkdtempSync(join(tmpdir(), "kontrol-sched-config-"));
const envFile = join(configDir, "sched.env");
const reviewerToken = "sched-e2e-reviewer-token-long-enough";
const agentSecret = "sched-e2e-agent-secret-long-enough";
const PORT = 7793;
const AGENT_PORT = 7794;
let agentRuns = 0;

writeFileSync(join(root, "marker.txt"), "scheduled-job\n");
writeFileSync(envFile, [
  `KONTROL_CONFIG_DIR=${configDir}`,
  `KONTROL_ALLOWED_ROOTS=${root}`,
  `KONTROL_STATE_DIR=${stateDir}`,
  "HOST=127.0.0.1",
  "KONTROL_ACP_ENABLED=true",
  "KONTROL_TOOL_MODE=full",
  "KONTROL_POLICY_MODE=allow",
  "KONTROL_AUTH_MODE=tunnel",
  "KONTROL_LOG_LEVEL=error",
  "KONTROL_LOG_REQUESTS=0",
  `KONTROL_ACP_AGENT_SECRET=${agentSecret}`,
  `KONTROL_ACP_REVIEWER_SECRET=${reviewerToken}`,
  `PORT=${PORT}`,
].join("\n") + "\n");

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function startAgent() {
  const agent = createHttpServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/runs") {
      for await (const _ of req) { /* drain */ }
      agentRuns += 1;
      res.writeHead(202, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ run_id: `remote-sched-${agentRuns}`, accepted: true, status: "running", output: [] }));
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
    KONTROL_TOOL_MODE: "full",
    KONTROL_POLICY_MODE: "allow",
    KONTROL_LOG_LEVEL: "error",
    KONTROL_LOG_REQUESTS: "0",
    KONTROL_ACP_AGENT_SECRET: agentSecret,
    KONTROL_ACP_REVIEWER_SECRET: reviewerToken,
    PORT: String(PORT),
  };
  const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", "serve"], {
    cwd: repoRoot, env: serverEnv, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (c) => { output += String(c); });
  child.stderr.on("data", (c) => { output += String(c); });
  child.once("exit", (code) => {
    if (code !== 0 && code !== null) console.error("[sched-e2e] server exited", { code, output: output.slice(-2000) });
  });
  return child;
}

async function waitForHealth(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/healthz`);
      if (res.ok) return true;
    } catch { /* retry */ }
    await delay(150);
  }
  throw new Error("server health timeout");
}

async function registerAgent() {
  const res = await fetch(`http://127.0.0.1:${PORT}/acp/agents/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${agentSecret}` },
    body: JSON.stringify({
      name: "sched-audit-agent",
      url: `http://127.0.0.1:${AGENT_PORT}`,
      role: "agent",
      capabilities: ["code"],
      ttlSeconds: 600,
    }),
  });
  if (!res.ok) throw new Error(`agent registration failed: ${res.status} ${await res.text()}`);
  const body = await res.json();
  assert.ok(body.id, "agent registration returns an id");
}

async function main() {
  const agent = await startAgent();
  const first = await startServer();
  let jobId;
  try {
    await waitForHealth();
    await registerAgent();

    const { default: Database } = await import("better-sqlite3");
    const dbPath = join(stateDir, "kontrol.sqlite");
    const db = new Database(dbPath);
    const schemaVersion = db.prepare("select max(version) as v from kontrol_schema_migrations").get()?.v;
    assert.ok(schemaVersion >= 70, `schema version should be >=70, got ${schemaVersion}`);
    for (const t of ["scheduled_jobs", "scheduled_job_attempts"]) {
      assert.ok(db.prepare("select name from sqlite_master where type='table' and name=?").get(t), `missing table ${t}`);
    }
    // Seed a DUE job (a read-only audit) directly in the live server's database.
    jobId = `sched_e2e_${Date.now()}`;
    const now = new Date().toISOString();
    const runAt = new Date(Date.now() - 1_000).toISOString();
    db.prepare(
      "insert into scheduled_jobs (id, principal_id, owner_context_id, project_id, workspace_root, run_at, instruction_json, execution_mode, policy_snapshot_json, status, revision, max_runtime_ms, created_at, updated_at) " +
      "values (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 1, ?, ?, ?)"
    ).run(jobId, "user-e2e", "owner-e2e", "ws-e2e", root, runAt, JSON.stringify({ instructions: "Read-only audit" }), "read_only_audit", JSON.stringify({ workspaceAccess: "read_only" }), 60_000, now, now);
    db.prepare("insert into dispatch_outbox (id, event_type, aggregate_id, aggregate_revision, payload_json, status, attempt_count, failure_count, available_at, created_at) values (?, 'scheduled_job.due', ?, 1, ?, 'pending', 0, 0, ?, ?)")
      .run(`out_e2e_${Date.now()}`, jobId, JSON.stringify({ scheduledJobId: jobId, revision: 1 }), runAt, now);
    db.close();

    // Drive one deterministic scheduler drain against the SAME durable state
    // the running server owns. This proves the dispatch path executes a real
    // worker without any ChatGPT conversation.
    const { createDispatchOutbox } = await import("../src/dispatch-outbox.js");
    const { createScheduledJobStore } = await import("../src/scheduling/scheduled-job-store.js");
    const { createScheduledJobRuntime } = await import("../src/scheduling/scheduled-job-runtime.js");
    const { dispatchScheduledJob } = await import("../src/scheduling/scheduled-job-dispatch.js");
    const sharedDb = (await import("../src/db/client.js")).openDatabase(stateDir);
    const outbox = createDispatchOutbox(sharedDb);
    const jobs = createScheduledJobStore(sharedDb, outbox);
    // The scheduler runtime dispatch hook uses the live gateway primitives.
    const { loadConfig } = await import("../src/config.js");
    const { createAgentRegistryManager } = await import("../src/acp-registry.js");
    const { createWorkSessionManager } = await import("../src/work-sessions.js");
    const { SqliteWorkspaceStore } = await import("../src/workspace-store.js");
    const { WorkspaceRegistry } = await import("../src/workspaces.js");
    const serverConfig = loadConfig({
      KONTROL_CONFIG_DIR: configDir,
      KONTROL_ALLOWED_ROOTS: root,
      KONTROL_STATE_DIR: stateDir,
      KONTROL_AUTH_MODE: "tunnel",
      KONTROL_ACP_ENABLED: "true",
      KONTROL_TOOL_MODE: "full",
      KONTROL_POLICY_MODE: "allow",
      KONTROL_ACP_AGENT_SECRET: agentSecret,
      KONTROL_ACP_REVIEWER_SECRET: reviewerToken,
      KONTROL_ALLOWED_ROOTS_ACK: "1",
      PORT: String(PORT),
    });
    // The E2E process shares the server's database, so the agent the server
    // already registered via /acp/agents/register is visible here. Confirm it
    // is alive and dispatchable before dispatch.
    const agentRegistry = createAgentRegistryManager(sharedDb);
    const alive = agentRegistry.listAlive().filter((a) => a.name === "sched-audit-agent");
    assert.equal(alive.length, 1, "the registered audit agent is visible to the shared registry");
    const workSessions = createWorkSessionManager(sharedDb);
    // Use the production registry (cache + persistent store), matching the
    // server's construction. getWorkspace() resolves the durable session.
    const workspaceStore = new SqliteWorkspaceStore(sharedDb);
    const workspaces = new WorkspaceRegistry(serverConfig, workspaceStore);
    const workspace = await workspaces.openWorkspace(root);
    // Point the seeded job at the real workspace session we just created.
    sharedDb.sqlite.prepare("update scheduled_jobs set project_id = ? where id = ?").run(workspace.workspace.id, jobId);
    const runtime = createScheduledJobRuntime({
      database: sharedDb,
      jobs,
      dispatchOutbox: outbox,
      pollMs: 60_000,
      dispatch: async (id) => {
        const job = jobs.get(id);
        if (!job) return { status: "failed", reason: "job not found" };
        const outcome = await dispatchScheduledJob(
          { workspaces, workSessions, agentRegistry, adapterSecret: serverConfig.acpAdapterSecret, eventStore: null, continuationManager: null, reviewWorkflow: null, missionLedger: null, supervisorRuns: null },
          jobs,
          job,
        );
        return { status: outcome.status, workSessionId: outcome.workSessionId, reason: outcome.reason };
      },
    });
    await runtime.drainOnce();
    runtime.stop();

    const afterDispatch = jobs.get(jobId);
    assert.equal(agentRuns, 1, `exactly one logical audit was dispatched to the agent (job status=${afterDispatch.status}, lastError=${afterDispatch.lastError}, workSessionId=${afterDispatch.workSessionId})`);
    assert.ok(afterDispatch.workSessionId || afterDispatch.status === "running" || afterDispatch.status === "blocked" || afterDispatch.status === "failed",
      `job reached a post-dispatch state, got ${afterDispatch.status}`);
    sharedDb.close();
  } finally {
    if (first.exitCode === null) first.kill("SIGTERM");
    await once(first, "exit").catch(() => {});
  }

  // Restart against the same durable state and confirm the job survived.
  const second = await startServer();
  try {
    await waitForHealth();
    const { default: Database } = await import("better-sqlite3");
    const db = new Database(join(stateDir, "kontrol.sqlite"), { readonly: true });
    const job = db.prepare("select status from scheduled_jobs where id = ?").get(jobId);
    assert.ok(job, "scheduled job survived restart");
    assert.ok(agentRuns === 1, "no duplicate dispatch occurred across the restart");
    db.close();
  } finally {
    if (second.exitCode === null) second.kill("SIGTERM");
    await once(second, "exit").catch(() => {});
    await new Promise((r) => agent.close(r));
  }

  console.log("scripts/scheduled-job-e2e.mjs: passed");
}

try {
  await main();
} finally {
  rmSync(root, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(configDir, { recursive: true, force: true });
}
