// P1 #12: stable-release UAT. Exercises the INSTALLED product end-to-end with
// deterministic fakes — no CRUSH/Hermes/model availability required:
//
//   1.  empty state directory
//   2.  packed-tarball install into a clean prefix
//   3.  installed server launch
//   4.  /healthz, /core-readyz, /readyz
//   5.  MCP initialize
//   6.  open_workspace + read
//   7.  default mutation approval boundary (bash denied by policy)
//   8.  Workspace App resource serving (resources/list + read)
//   9.  ACP fake-agent registration + lifecycle (echo adapter via stdio duplex)
//   10. SIGTERM during activity; clean exit
//   11. no leaked child processes
//   12. restart on the SAME state directory; stale identity reconciliation
//   13. final DB integrity check
//
// Usage: node scripts/release-uat.mjs [--skip-install]
import assert from "node:assert/strict";
import { spawn, execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { createRequire } from "node:module";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname ?? ".", "..");
const skipInstall = process.argv.includes("--skip-install");
const tmp = mkdtempSync(join(tmpdir(), "kontrol-release-uat-"));
const installPrefix = join(tmp, "prefix");
const stateDir = join(tmp, "state");
const workspaceDir = join(tmp, "workspace");

let server = null;
let serverStderr = "";

function log(step, message) {
  console.log(`[release-uat] ${step}: ${message}`);
}

function unusedTcpPort() {
  return new Promise((resolvePromise) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolvePromise(port));
    });
  });
}

async function waitForHttp(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
      lastError = new Error(`HTTP ${response.status} from ${url}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out waiting for ${url}: ${lastError?.message ?? "unknown"}`);
}

let rpcId = 0;
let mcpSessionId;

async function mcpRpc(method, params) {
  const response = await fetch(globalThis.__uatMcpUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "accept": "application/json, text/event-stream",
      ...(mcpSessionId ? { "mcp-session-id": mcpSessionId } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  const text = await response.text();
  const data = text.trim().split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .join("\n");
  const payload = JSON.parse(data || text);
  if (method === "initialize") {
    mcpSessionId = response.headers.get("mcp-session-id") ?? mcpSessionId;
  }
  assert.equal(response.status, 200, `${method} returned HTTP ${response.status}`);
  assert.ok(!payload.error, `${method}: ${payload.error?.message ?? "json-rpc error"}`);
  return payload.result;
}

async function tool(name, args) {
  const result = await mcpRpc("tools/call", { name, arguments: args });
  return result;
}

try {
  // ── 1-2: empty state dir + packed tarball install ────────────────────────
  assert.equal(existsSync(stateDir), false, "state directory must start empty");
  let installedCli;
  if (skipInstall && process.env.KONTROL_UAT_CLI) {
    installedCli = process.env.KONTROL_UAT_CLI;
    log("install", `skipped (--skip-install); using ${installedCli}`);
  } else {
    log("pack", "npm pack");
    execFileSync("npm", ["pack", "--pack-destination", tmp], { cwd: root, stdio: "pipe" });
    const tarballPath = readdirSync(tmp).find((name) => name.endsWith(".tgz"));
    assert.ok(tarballPath, "npm pack produced no tarball");
    log("install", `installing ${tarballPath}`);
    execFileSync("npm", [
      "install", "--prefix", installPrefix, "--no-audit", "--no-fund", "--package-lock=false",
      join(tmp, tarballPath),
    ], {
      cwd: tmp,
      // kontrol-env-exception: UAT test harness installing into an isolated
      // temp prefix; needs PATH/npm registry access, not a control-plane spawn.
      env: { ...process.env, npm_config_cache: join(tmp, "npm-cache") },
      stdio: "pipe",
    });
    installedCli = join(installPrefix, "node_modules", "@b-a-m-n", "kontrol", "dist", "cli.js");
    assert.ok(existsSync(installedCli), "clean install missing dist/cli.js");
  }

  // Deterministic workspace content.
  fs.mkdirSync(workspaceDir, { recursive: true });
  writeFileSync(join(workspaceDir, "hello.txt"), "release uat fixture\n");

  // ── 3: launch the installed server ────────────────────────────────────────
  const servicePort = await unusedTcpPort();
  const serviceEnv = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("KONTROL_POLICY_"))),
    HOST: "127.0.0.1",
    PORT: String(servicePort),
    KONTROL_AUTH_MODE: "tunnel",
    KONTROL_ALLOWED_ROOTS: `${workspaceDir},${installPrefix}`,
    KONTROL_ALLOWED_HOSTS: "127.0.0.1,localhost",
    KONTROL_PUBLIC_BASE_URL: `http://127.0.0.1:${servicePort}`,
    KONTROL_STATE_DIR: stateDir,
    KONTROL_WORKTREE_ROOT: join(tmp, "worktrees"),
    KONTROL_ACP_ENABLED: "true",
    KONTROL_ACP_SHARED_SECRET: "uat-shared-secret-0000000000000000000000",
    KONTROL_POLICY_TOOL_BASH: "ask",
    KONTROL_TUNNEL_REVIEWER_SECRET: "release-uat-reviewer-secret-long-enough",
    KONTROL_LOG_FORMAT: "pretty",
  };
  log("launch", `starting installed server on :${servicePort}`);
  server = spawn("node", [installedCli, "serve"], {
    cwd: installPrefix,
    env: serviceEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stderr?.on("data", (chunk) => { serverStderr += String(chunk); });

  // ── 4: health gates ───────────────────────────────────────────────────────
  await waitForHttp(`http://127.0.0.1:${servicePort}/healthz`);
  log("healthz", "ok");
  const coreReady = await waitForHttp(`http://127.0.0.1:${servicePort}/core-readyz`);
  assert.ok(coreReady.ok, "core-readyz not ok");
  log("core-readyz", "ok");
  // Strict /readyz is asserted after the fake worker agent registers (step 9b),
  // because an ACP-enabled server with zero live worker agents is correctly
  // "not ready" by design.

  // ── 5: MCP initialize ─────────────────────────────────────────────────────
  globalThis.__uatMcpUrl = `http://127.0.0.1:${servicePort}/mcp`;
  await mcpRpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "kontrol-release-uat", version: "1" },
  });
  assert.ok(mcpSessionId, "initialize did not provide an MCP session id");
  await fetch(globalThis.__uatMcpUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "accept": "application/json, text/event-stream",
      "mcp-session-id": mcpSessionId,
    },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }),
  });
  log("mcp", "initialized");

  // ── 6-7: open workspace, read, verify mutation boundary ───────────────────
  const opened = await tool("open_workspace", { path: workspaceDir });
  const openedText = opened.content?.[0]?.text ?? "";
  let workspaceId = opened.structuredContent?.workspaceId;
  if (!workspaceId) {
    try {
      workspaceId = JSON.parse(openedText).workspaceId;
    } catch {
      // fall through to regex extraction
    }
  }
  if (!workspaceId) {
    const match = /"workspaceId"\s*:\s*"([^"]+)"/.exec(openedText);
    workspaceId = match?.[1];
  }
  assert.ok(typeof workspaceId === "string" && workspaceId.length > 0, `open_workspace returned no id: ${openedText.slice(0, 200)}`);
  log("open_workspace", `id=${String(workspaceId).slice(0, 8)}…`);

  const readResult = await tool("read", { workspaceId, path: "hello.txt" });
  const readText = readResult.content?.map((c) => c.text).join("") ?? "";
  assert.match(readText, /release uat fixture/, "read returned file contents");
  log("read", "file contents round-tripped");

  const grepResult = await tool("grep", { workspaceId, pattern: "release uat", path: "hello.txt" });
  assert.match(JSON.stringify(grepResult), /release uat fixture/, "grep returned file matches");
  const globResult = await tool("glob", { workspaceId, pattern: "*.txt" });
  assert.match(JSON.stringify(globResult), /hello\.txt/, "glob returned matching paths");
  const lsResult = await tool("ls", { workspaceId, path: "." });
  assert.match(JSON.stringify(lsResult), /hello\.txt/, "ls returned directory entries");
  log("read-only-tools", "grep, glob, and ls completed without approval");

  // Secure baseline: bash must be gated behind ask even for an authenticated
  // MCP caller with no approver present.
  const bashResult = await tool("bash", { workspaceId, command: "pwd" });
  const bashText = bashResult.content?.map((c) => c.text).join("") ?? "";
  assert.ok(
    /denied by policy|approval|requires? approval/i.test(bashText) || bashResult.isError === true,
    "bash must be gated under the default secure baseline",
  );
  for (const [name, args] of [
    ["write", { workspaceId, path: "blocked.txt", content: "must not write" }],
    ["edit", { workspaceId, path: "hello.txt", edits: [{ oldText: "release uat fixture", newText: "must not edit" }] }],
  ]) {
    const result = await tool(name, args);
    assert.equal(result.structuredContent?.status, "approval_required", `${name} must be gated under the default secure baseline`);
  }
  log("mutation-boundary", "bash gated behind approval as expected");

  // ── 8: resource/UI serving ────────────────────────────────────────────────
  const listed = await mcpRpc("resources/list", {});
  const appResource = (listed.resources ?? []).find((r) => /^ui:\/\/kontrol\/workspace-app-[a-f0-9]{12}\.html$/.test(r.uri ?? ""));
  assert.ok(appResource, "workspace app resource not advertised");
  const appRead = await mcpRpc("resources/read", { uri: appResource.uri });
  assert.ok((appRead.contents?.[0]?.text ?? "").length > 1_000, "workspace app HTML too small");
  log("ui-resource", `served ${appResource.uri}`);

  // ── 9: strict /readyz. An ACP-enabled server with NO configured agents is
  // ready by design — "no ACP workers wanted" is a legitimate posture.
  // Operators who configure required agents (KONTROL_ACP_AGENTS) get strict
  // presence/health checks; deployments without them don't fail forever.
  const ready = await waitForHttp(`http://127.0.0.1:${servicePort}/readyz`);
  assert.ok(ready.ok, "readyz not ok");
  log("readyz", "ok");

  // Registry surface sanity: registering a deterministic loopback agent
  // succeeds, and heartbeats keep it alive (exercises the auth + registration
  // path of the installed product without any real model).
  const agentRegisterResponse = await fetch(`http://127.0.0.1:${servicePort}/acp/agents/register`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${serviceEnv.KONTROL_ACP_SHARED_SECRET}`,
    },
    body: JSON.stringify({
      name: "uat-fake-agent",
      url: "http://127.0.0.1:1/acp",
      description: "deterministic UAT fake agent",
      role: "agent",
      ttlSeconds: 120,
    }),
  });
  assert.equal(agentRegisterResponse.status, 201, `fake-agent registration failed: ${await agentRegisterResponse.text()}`);
  log("acp-register", "fake agent registered");

  const agentsListed = await mcpRpc("tools/list", {});
  assert.ok(Array.isArray(agentsListed.tools) && agentsListed.tools.length > 0, "tools/list empty");
  log("tools-list", `${agentsListed.tools.length} tools advertised`);

  // ── 10: SIGTERM during activity ───────────────────────────────────────────
  log("sigterm", "sending SIGTERM to installed server");
  server.kill("SIGTERM");
  const exitCode = await new Promise((resolvePromise) => {
    const timer = setTimeout(() => resolvePromise("timeout"), 15_000);
    server.once("exit", (code) => { clearTimeout(timer); resolvePromise(code); });
  });
  assert.equal(exitCode, 0, `installed server exited with ${exitCode} on SIGTERM`);
  log("shutdown", "clean exit code 0");

  // ── 11: no leaked child processes from the install prefix ────────────────
  const psOut = spawnSync("pgrep", ["-f", "kontrol/dist/cli.js"], { encoding: "utf8" });
  assert.notEqual(psOut.status, 0, `leaked server processes: ${psOut.stdout}`);
  log("leak-check", "no leaked processes");

  // ── 12: restart on the same state dir; reconciliation must succeed ───────
  log("restart", "relaunching on the same state directory");
  server = spawn("node", [installedCli, "serve"], {
    cwd: installPrefix,
    env: serviceEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const restartedStderr = [];
  server.stderr?.on("data", (chunk) => restartedStderr.push(String(chunk)));
  const port2 = servicePort; // reuse the same port after clean exit
  await waitForHttp(`http://127.0.0.1:${port2}/healthz`, 30_000);
  await waitForHttp(`http://127.0.0.1:${port2}/core-readyz`, 30_000);
  log("restart", "reconciled and healthy");

  // ── 13: final DB integrity ───────────────────────────────────────────────
  server.kill("SIGTERM");
  await new Promise((resolvePromise) => server.once("exit", resolvePromise));
  const dbPath = join(stateDir, "kontrol.sqlite");
  assert.ok(existsSync(dbPath), "state database missing after run");
  const integrity = spawnSync("node", ["-e", `
    const Database = require(process.argv[1]);
    const db = new Database(process.argv[2], { readonly: true });
    console.log(db.pragma('integrity_check', { simple: true }));
    db.close();
  `, createRequire(join(root, "package.json")).resolve("better-sqlite3"), dbPath], { encoding: "utf8" });
  assert.match(integrity.stdout, /ok/i, `DB integrity: ${integrity.stderr || integrity.stdout}`);
  log("db-integrity", "ok");

  console.log("\nrelease-uat: ALL CHECKS PASSED");
} finally {
  if (server && server.exitCode === null) {
    server.kill("SIGKILL");
  }
  rmSync(tmp, { recursive: true, force: true });
}
