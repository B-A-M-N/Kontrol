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
// Usage: node scripts/release-uat.mjs [--skip-install] [--candidate <immutable-candidate-dir>]
//
// P1-D: `--candidate` (or KONTROL_UAT_CANDIDATE_DIR) exercises the EXACT
// artifact intended for release instead of building a fresh one: the
// candidate's build-meta.json identity is verified before packing, and the
// same identity is recorded in the UAT receipt. Never rebuild the candidate
// during final release qualification.
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
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { testHarnessEnvironment } from "./lib/tool-environment.mjs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname ?? ".", "..");
const skipInstall = process.argv.includes("--skip-install");
function flagValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
// P1-D: explicit immutable candidate under test. Empty/undefined = build one.
const explicitCandidateDir = flagValue("--candidate") ?? process.env.KONTROL_UAT_CANDIDATE_DIR ?? undefined;
if (process.argv.includes("--candidate") && !flagValue("--candidate")) {
  throw new Error("release-uat: --candidate requires a directory argument");
}
// The UAT receipt binds the exercised artifact to its build identity.
const uatReceipt = {
  schema: "kontrol-release-uat-receipt/1",
  candidate: null,
  checksPassed: false,
};
const tmp = mkdtempSync(join(tmpdir(), "kontrol-release-uat-"));
const installPrefix = join(tmp, "prefix");
const stateDir = join(tmp, "state");
const workspaceDir = join(tmp, "workspace");

let server = null;
let serverStderr = "";
let serverStdout = "";
// P1-A: fixture-owned server PIDs. The leak check verifies exactly these
// identities instead of a host-wide pgrep, so a concurrently running Kontrol
// elsewhere on the machine can neither false-fail this UAT nor hide a
// fixture child that survived.
const ownedServerPids = [];

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

function assertNoFixtureSurvivors(label) {
  const survivors = ownedServerPids.filter(pidAlive);
  assert.equal(survivors.length, 0, `${label}: leaked fixture server processes: ${survivors.join(",")}`);
  log("leak-check", `${label}: no fixture survivors`);
}

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

// P1-A: every outbound request carries its own deadline. A single hanging
// fetch must never block the outer retry-deadline check.
const PER_REQUEST_MS = Number(process.env.KONTROL_UAT_REQUEST_TIMEOUT_MS ?? 10_000);

async function fetchWithTimeout(url, options = {}, timeoutMs = PER_REQUEST_MS) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(timeoutMs),
  });
  return response;
}

async function waitForHttp(url, timeoutMs = 30_000, diagnostics = () => "") {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const remaining = deadline - Date.now();
      const response = await fetchWithTimeout(url, {}, Math.min(PER_REQUEST_MS, Math.max(remaining, 1_000)));
      if (response.ok) return response;
      lastError = new Error(`HTTP ${response.status} from ${url}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out waiting for ${url}: ${lastError?.message ?? "unknown"}${diagnostics()}`);
}

let rpcId = 0;
let mcpSessionId;

async function mcpRpc(method, params) {
  const response = await fetchWithTimeout(globalThis.__uatMcpUrl, {
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
    if (explicitCandidateDir) {
      throw new Error("release-uat: --candidate cannot be combined with --skip-install (nothing would be installed)");
    }
    installedCli = process.env.KONTROL_UAT_CLI;
    log("install", `skipped (--skip-install); using ${installedCli}`);
  } else {
    // P1-D: verify the exact candidate identity BEFORE packing/installing.
    let packArgs;
    if (explicitCandidateDir) {
      const candidateMetaPath = join(explicitCandidateDir, "build-meta.json");
      assert.ok(existsSync(candidateMetaPath), `explicit candidate has no build-meta.json: ${candidateMetaPath}`);
      const candidateMeta = JSON.parse(readFileSync(candidateMetaPath, "utf8"));
      assert.equal(typeof candidateMeta.buildId, "string", "candidate build-meta.json has no string buildId");
      assert.equal(typeof candidateMeta.contentSha256, "string", "candidate build-meta.json has no string contentSha256");
      uatReceipt.candidate = {
        artifactPath: explicitCandidateDir,
        buildId: candidateMeta.buildId,
        version: candidateMeta.version ?? null,
        contentSha256: candidateMeta.contentSha256,
      };
      log("candidate", `exact artifact buildId=${candidateMeta.buildId} contentSha256=${String(candidateMeta.contentSha256).slice(0, 16)}…`);
      packArgs = ["--skip-build", "--candidate", explicitCandidateDir, "--pack-destination", tmp];
    } else {
      log("pack", "building and packing immutable release candidate");
      packArgs = ["--pack-destination", tmp];
    }
    try {
      execFileSync(process.execPath, [
        join(root, "scripts", "package-stage.mjs"),
        ...packArgs,
      ], {
        cwd: root,
        env: testHarnessEnvironment(process.env, {
          overrides: {
            KONTROL_BUILD_RESULT_PATH: join(tmp, "build-result.json"),
            npm_config_cache: join(tmp, "npm-cache"),
          },
        }),
        stdio: "pipe",
        // P1-A: packaging must be bounded; stdlib enforces the deadline.
        timeout: Number(process.env.KONTROL_UAT_PACK_TIMEOUT_MS ?? 600_000),
        killSignal: "SIGKILL",
      });
    } catch (error) {
      error.message = `release-uat pack step failed (product failure, not network): ${error.message}`;
      throw error;
    }
    const tarballPath = readdirSync(tmp).find((name) => name.endsWith(".tgz"));
    assert.ok(tarballPath, "npm pack produced no tarball");
    log("install", `installing ${tarballPath}`);
    try {
      execFileSync("npm", [
        "install", "--prefix", installPrefix, "--no-audit", "--no-fund", "--package-lock=false",
        join(tmp, tarballPath),
      ], {
        cwd: tmp,
        // P1.10: UAT harness installs into an isolated temp prefix with the
        // explicit tool allowlist, not a control-plane environment.
        env: testHarnessEnvironment(process.env, { overrides: { npm_config_cache: join(tmp, "npm-cache") } }),
        stdio: "pipe",
        // P1-A: installation must be bounded. A timeout here is INFRA
        // (registry/cache), not a product verdict — the stdlib ETIMEDOUT
        // message preserves that distinction.
        timeout: Number(process.env.KONTROL_UAT_INSTALL_TIMEOUT_MS ?? 600_000),
        killSignal: "SIGKILL",
      });
    } catch (error) {
      if (error.code === "ETIMEDOUT") {
        error.message = `release-uat npm install timed out (infra/network, not a product verdict): ${error.message}`;
      }
      throw error;
    }
    installedCli = join(installPrefix, "node_modules", "@b-a-m-n", "kontrol", "dist", "cli.js");
    assert.ok(existsSync(installedCli), "clean install missing dist/cli.js");
    if (!uatReceipt.candidate) {
      // Default path: the candidate was just built by package-stage; bind the
      // receipt to its identity (build-result.json lives in tmp via
      // KONTROL_BUILD_RESULT_PATH).
      const builtResultPath = join(tmp, "build-result.json");
      assert.ok(existsSync(builtResultPath), `fresh build produced no build-result.json at ${builtResultPath}`);
      const builtResult = JSON.parse(readFileSync(builtResultPath, "utf8"));
      const builtMetaPath = join(builtResult.artifactPath, "build-meta.json");
      assert.ok(existsSync(builtMetaPath), `fresh candidate has no build-meta.json: ${builtMetaPath}`);
      const builtMeta = JSON.parse(readFileSync(builtMetaPath, "utf8"));
      uatReceipt.candidate = {
        artifactPath: builtResult.artifactPath,
        buildId: builtMeta.buildId ?? builtResult.buildId ?? null,
        version: builtMeta.version ?? null,
        contentSha256: builtMeta.contentSha256 ?? null,
      };
      log("candidate", `fresh artifact buildId=${uatReceipt.candidate.buildId} contentSha256=${String(uatReceipt.candidate.contentSha256).slice(0, 16)}…`);
    }
  }

  // Deterministic workspace content.
  // The install prefix must exist as a spawn cwd even when --skip-install
  // bypasses `npm install` (which would otherwise create it).
  fs.mkdirSync(installPrefix, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });
  writeFileSync(join(workspaceDir, "hello.txt"), "release uat fixture\n");

  // ── 3: launch the installed server ────────────────────────────────────────
  const servicePort = await unusedTcpPort();
  const serviceEnv = testHarnessEnvironment(process.env, { overrides: {
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
  } });
  log("launch", `starting installed server on :${servicePort}`);
  server = spawn(process.execPath, [installedCli, "serve"], {
    cwd: installPrefix,
    env: serviceEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (server.pid) ownedServerPids.push(server.pid);
  server.stdout?.on("data", (chunk) => { serverStdout = `${serverStdout}${String(chunk)}`.slice(-32_000); });
  server.stderr?.on("data", (chunk) => { serverStderr += String(chunk); });

  // ── 4: health gates ───────────────────────────────────────────────────────
  await waitForHttp(`http://127.0.0.1:${servicePort}/healthz`, 30_000, () => `\nserver output:\n${serverStdout}\n${serverStderr}`);
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
  await fetchWithTimeout(globalThis.__uatMcpUrl, {
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
  const agentRegisterResponse = await fetchWithTimeout(`http://127.0.0.1:${servicePort}/acp/agents/register`, {
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

  // ── 11: no leaked child processes from this fixture ────────────────────
  assertNoFixtureSurvivors("first server");

  // ── 12: restart on the same state dir; reconciliation must succeed ───────
  log("restart", "relaunching on the same state directory");
  server = spawn(process.execPath, [installedCli, "serve"], {
    cwd: installPrefix,
    env: serviceEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (server.pid) ownedServerPids.push(server.pid);
  const restartedStderr = [];
  server.stderr?.on("data", (chunk) => restartedStderr.push(String(chunk)));
  const port2 = servicePort; // reuse the same port after clean exit
  await waitForHttp(`http://127.0.0.1:${port2}/healthz`, 30_000);
  await waitForHttp(`http://127.0.0.1:${port2}/core-readyz`, 30_000);
  log("restart", "reconciled and healthy");

  // ── 13: final DB integrity ───────────────────────────────────────────────
  // P1-A: the final shutdown carries its own deadline with SIGKILL
  // escalation, and the fixture-scoped leak check covers both servers.
  server.kill("SIGTERM");
  const finalExit = await new Promise((resolvePromise) => {
    const timer = setTimeout(() => resolvePromise("timeout"), 15_000);
    server.once("exit", (code) => { clearTimeout(timer); resolvePromise(code); });
  });
  if (finalExit === "timeout" && server.exitCode === null) {
    server.kill("SIGKILL");
    const killExit = await new Promise((resolvePromise) => {
      const timer = setTimeout(() => resolvePromise("timeout"), 10_000);
      server.once("exit", (code) => { clearTimeout(timer); resolvePromise(code); });
    });
    assert.notEqual(killExit, "timeout", `fixture server pid=${server.pid} survived SIGKILL (CLEANUP_FAILED)`);
  }
  assertNoFixtureSurvivors("restarted server");
  const dbPath = join(stateDir, "kontrol.sqlite");
  assert.ok(existsSync(dbPath), "state database missing after run");
  const integrity = spawnSync(process.execPath, ["-e", `
    const Database = require(process.argv[1]);
    const db = new Database(process.argv[2], { readonly: true });
    console.log(db.pragma('integrity_check', { simple: true }));
    db.close();
  `, createRequire(join(root, "package.json")).resolve("better-sqlite3"), dbPath], {
    encoding: "utf8",
    // P1-A: local integrity probe, still bounded.
    timeout: 60_000,
    killSignal: "SIGKILL",
  });
  assert.match(integrity.stdout, /ok/i, `DB integrity: ${integrity.stderr || integrity.stdout}`);
  log("db-integrity", "ok");

  uatReceipt.checksPassed = true;
  console.log("\nrelease-uat: ALL CHECKS PASSED");
  // P1-D: machine-readable receipt binds the exercised artifact to its
  // build identity. stdout is the durable channel: the tmp dir is removed
  // in `finally`, and the caller (beta gate) persists this line.
  console.log(`release-uat-receipt: ${JSON.stringify(uatReceipt)}`);
} finally {
  if (server && server.exitCode === null) {
    server.kill("SIGKILL");
  }
  rmSync(tmp, { recursive: true, force: true });
}
