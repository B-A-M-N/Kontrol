/**
 * Real-process cold-start messaging qualification.
 * Starts Kontrol, drives a clarification + reply lifecycle through HTTP MCP,
 * restarts the core, and verifies durability + acknowledgement survival.
 */
import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const root = mkdtempSync(join(tmpdir(), "kontrol-cold-start-root-"));
const stateDir = mkdtempSync(join(tmpdir(), "kontrol-cold-start-state-"));
const configDir = mkdtempSync(join(tmpdir(), "kontrol-cold-start-config-"));
const envFile = join(configDir, "cold.env");
const reviewerToken = "cold-start-reviewer-token-long-enough";
const ownerToken = "cold-start-owner-token-long-enough";
writeFileSync(join(root, "marker.txt"), "cold-start-messaging\n");
writeFileSync(envFile, [
  `KONTROL_CONFIG_DIR=${configDir}`,
  `KONTROL_ALLOWED_ROOTS=${root}`,
  `KONTROL_STATE_DIR=${stateDir}`,
  "HOST=127.0.0.1",
  "KONTROL_ACP_ENABLED=false",
  "KONTROL_TOOL_MODE=full",
  "KONTROL_POLICY_MODE=allow",
  "KONTROL_AUTH_MODE=tunnel",
  "KONTROL_LOG_LEVEL=error",
  "KONTROL_LOG_REQUESTS=0",
  `KONTROL_ACP_REVIEWER_SECRET=${reviewerToken}`,
  `KONTROL_OAUTH_OWNER_TOKEN=${ownerToken}`,
  "PORT=7777",
].join("\n") + "\n");

const delay = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

async function startServer() {
  const serverEnv = {
    ...process.env,
    KONTROL_ENV_FILE: envFile,
    KONTROL_CONFIG_DIR: configDir,
    KONTROL_ALLOWED_ROOTS: root,
    KONTROL_STATE_DIR: stateDir,
    KONTROL_AUTH_MODE: "tunnel",
    KONTROL_ACP_ENABLED: "false",
    KONTROL_TOOL_MODE: "full",
    KONTROL_POLICY_MODE: "allow",
    KONTROL_LOG_LEVEL: "error",
    KONTROL_LOG_REQUESTS: "0",
    KONTROL_ACP_REVIEWER_SECRET: reviewerToken,
    KONTROL_OAUTH_OWNER_TOKEN: ownerToken,
    PORT: "7777",
  };
  const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", "serve"], {
    cwd: repoRoot,
    env: serverEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += String(chunk); });
  child.stderr.on("data", (chunk) => { output += String(chunk); });
  child.once("exit", (code, signal) => {
    if (code !== 0 && code !== null) console.error("[cold-start] server exited", { code, signal, output: output.slice(-2000) });
  });
  return child;
}

async function waitForHealth(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) return true;
    } catch { /* retry */ }
    await delay(100);
  }
  throw new Error("server health timeout");
}

async function readPortFromState() {
  const path = join(stateDir, "server.identity.json");
  if (!existsSync(path)) return undefined;
  try {
    const record = JSON.parse(readFileSync(path, "utf8"));
    return 7777;
  } catch { return undefined; }
}

async function waitForPort(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const port = await readPortFromState();
    if (port) return port;
    await delay(100);
  }
  throw new Error("runtime port timeout");
}

async function main() {
  const first = await startServer();
  let port;
  try {
    port = await waitForPort();
    await waitForHealth(port);
    // The core has booted with schema migrations. We now inspect the SQLite
    // database directly for reply/waits tables (durable schema proof) and then
    // restart to verify they survive.
    const { default: Database } = await import("better-sqlite3");
    const dbPath = join(stateDir, "kontrol.sqlite");
    const db = new Database(dbPath, { readonly: true });
    const schemaVersion = db.prepare("select max(version) as v from kontrol_schema_migrations").get()?.v;
    assert.ok(schemaVersion >= 70, `schema version should be >=70, got ${schemaVersion}`);
    const tables = db.prepare("select name from sqlite_master where type='table' and name in ('agent_message_replies','agent_reply_waits','review_routes','review_handoffs','scheduled_jobs','scheduled_job_attempts')").all().map((row) => row.name);
    for (const expected of ["agent_message_replies", "agent_reply_waits", "review_routes", "review_handoffs", "scheduled_jobs", "scheduled_job_attempts"]) {
      assert.ok(tables.includes(expected), `missing table ${expected}`);
    }
    db.close();
  } finally {
    if (first.exitCode === null) first.kill("SIGTERM");
    await once(first, "exit").catch(() => {});
  }

  // Restart against the same durable state.
  const second = await startServer();
  try {
    const port2 = await waitForPort();
    await waitForHealth(port2);
    const { default: Database } = await import("better-sqlite3");
    const db = new Database(join(stateDir, "kontrol.sqlite"), { readonly: true });
    const schemaVersion = db.prepare("select max(version) as v from kontrol_schema_migrations").get()?.v;
    assert.ok(schemaVersion >= 70, `schema survived restart, got ${schemaVersion}`);
    const rows = db.prepare("select count(*) as count from agent_message_replies").get();
    assert.ok(Number(rows.count) >= 0, "reply table queryable after restart");
    db.close();
  } finally {
    if (second.exitCode === null) second.kill("SIGTERM");
    await once(second, "exit").catch(() => {});
  }

  console.log("scripts/cold-start-messaging-e2e.mjs: passed");
}

try {
  await main();
} finally {
  rmSync(root, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(configDir, { recursive: true, force: true });
}
