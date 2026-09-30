import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { validateRelease } from "./validate-release.mjs";
import { buildToolEnvironment, releaseProbeEnvironment } from "./lib/tool-environment.mjs";

function unusedTcpPort() {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolvePromise(port));
    });
  });
}

function loadSmoke(artifactPath) {
  // cli.js invokes its command dispatcher when imported as the process entry;
  // exercise that graph through --help below and import the non-dispatching
  // runtime modules directly here.
  const entrypoints = [
    "server.js",
    "acp-duplex.js",
    "acp-worker-token.mjs",
    // Import worker entrypoints too: a release that boots the HTTP server but
    // cannot resolve a background worker is not independently loadable.
    "database-integrity-worker.js",
  ];
  for (const entrypoint of entrypoints) {
    const modulePath = pathToFileURL(join(artifactPath, entrypoint)).href;
    const result = spawnSync(process.execPath, [
      "--input-type=module",
      "-e",
      `await import(${JSON.stringify(modulePath)});`,
    ], {
      cwd: artifactPath,
      // P1.10: module-load smoke imports the local release with the runtime
      // lock explicitly cleared, not inherited.
      env: releaseProbeEnvironment(process.env, { overrides: { KONTROL_RUNTIME_LOCK_TOKEN: "" } }),
      encoding: "utf8",
    });
    if (result.status !== 0) {
      throw new Error(`${entrypoint} load failed:\n${result.stderr || result.stdout}`);
    }
  }

  const help = spawnSync(process.execPath, [join(artifactPath, "cli.js"), "--help"], {
    cwd: artifactPath,
    // P1.10: local release import smoke; the runtime lock is explicitly
    // cleared and no project-controlled command is run.
    env: releaseProbeEnvironment(process.env, { overrides: { KONTROL_RUNTIME_LOCK_TOKEN: "" } }),
    encoding: "utf8",
  });
  if (help.status !== 0) throw new Error(`cli --help failed:\n${help.stderr || help.stdout}`);
}

async function waitFor(url, child, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "not attempted";
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`candidate exited (${child.exitCode}) before ${url}: ${child.stderrText}`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_500) });
      if (response.ok) return response;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
  }
  throw new Error(`timed out waiting for ${url}: ${lastError}\n${child.stderrText}`);
}

async function probeCandidateSurface(baseUrl, workspace, requiredInspectionTools) {
  let requestId = 0;
  let sessionId;
  const rpc = async (method, params, { withSession = true } = {}) => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(sessionId && withSession ? { "mcp-session-id": sessionId } : {}),
        "x-kontrol-reviewer-token": "release-probe-reviewer",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, params }),
      signal: AbortSignal.timeout(5_000),
    });
    const text = await response.text();
    const data = text.trim().split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
    const payload = JSON.parse(data || text);
    if (method === "initialize") sessionId = response.headers.get("mcp-session-id") ?? sessionId;
    assert.equal(response.status, 200, `${method} returned HTTP ${response.status}: ${text}`);
    assert.ok(!payload.error, `${method}: ${payload.error?.message ?? "JSON-RPC error"}`);
    return payload.result;
  };
  const initialized = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "release-surface-probe", version: "1" },
  }, { withSession: false });
  assert.ok(sessionId, "candidate initialize did not return an MCP session id");
  const listed = await rpc("tools/list", {});
  const names = new Set((listed.tools ?? []).map((tool) => tool.name));
  for (const required of requiredInspectionTools) {
    assert.ok(names.has(required), `candidate tools/list is missing required inspection tool ${required}`);
  }
  const opened = await rpc("tools/call", { name: "open_workspace", arguments: { path: workspace, mode: "checkout" } });
  const surface = opened.structuredContent ?? opened;
  assert.ok(surface.workspaceId, "candidate open_workspace did not return workspaceId");
  assert.deepEqual(surface.toolSurface?.requiredInspectionTools, requiredInspectionTools, "candidate open_workspace inspection contract mismatch");
  for (const name of requiredInspectionTools) {
    const result = await rpc("tools/call", { name, arguments: { workspaceId: surface.workspaceId } });
    const value = result.structuredContent ?? result;
    assert.notEqual(value.status, "approval_required", `${name} required policy approval during isolated release probe`);
  }
  if (initialized?.serverInfo?.version) {
    assert.equal(typeof initialized.serverInfo.version, "string", "candidate initialize must publish a server version");
  }
  await fetch(`${baseUrl}/mcp`, { method: "DELETE", headers: { "mcp-session-id": sessionId } }).catch(() => {});
}

async function bootSmoke(artifactPath, buildId) {
  const smokeRoot = mkdtempSync(join(tmpdir(), "kontrol-release-smoke-"));
  const port = await unusedTcpPort();
  writeFileSync(join(smokeRoot, "README.md"), "# release probe fixture\n");
  for (const args of [["init"], ["config", "user.email", "release-probe@example.invalid"], ["config", "user.name", "Release Probe"], ["add", "README.md"], ["commit", "-m", "release probe fixture"]]) {
    const result = spawnSync("git", args, { cwd: smokeRoot, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`git fixture setup failed: ${result.stderr || result.stdout}`);
  }
  const env = buildToolEnvironment(process.env, {
    // The boot smoke IS a launcher: it deliberately establishes this
    // release's runtime identity. Everything else inherits the tool allowlist.
    overrides: {
      HOST: "127.0.0.1",
    PORT: String(port),
    KONTROL_AUTH_MODE: "tunnel",
    KONTROL_ALLOWED_ROOTS: smokeRoot,
    KONTROL_ALLOWED_HOSTS: "127.0.0.1,localhost",
    KONTROL_PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
    KONTROL_STATE_DIR: join(smokeRoot, "state"),
    KONTROL_WORKTREE_ROOT: join(smokeRoot, "worktrees"),
    KONTROL_ACP_ENABLED: "false",
    // Release smoke exercises boot/serve/transport plumbing, not the approval
    // boundary; the ask baseline would trip the tunnel reviewer gate.
    KONTROL_POLICY_MODE: "allow",
    KONTROL_TUNNEL_DOCTOR: "false",
    KONTROL_ACP_REVIEWER_SECRET: "release-probe-reviewer",
    KONTROL_EXPECTED_BUILD_ID: buildId,
    KONTROL_ARTIFACT_PATH: artifactPath,
    KONTROL_LAUNCHER: "release-smoke",
    KONTROL_LAUNCH_GENERATION_ID: `release-smoke-${process.pid}-${Date.now()}`,
    KONTROL_RUNTIME_LOCK_TOKEN: "",
    },
  });
  const child = spawn(process.execPath, [join(artifactPath, "cli.js"), "serve"], {
    cwd: artifactPath,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderrText = "";
  child.stdoutText = "";
  child.stderr.on("data", (chunk) => { child.stderrText += String(chunk); });
  child.stdout.on("data", (chunk) => { child.stdoutText += String(chunk); });
  try {
    await waitFor(`http://127.0.0.1:${port}/healthz`, child);
    await waitFor(`http://127.0.0.1:${port}/core-readyz`, child);
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "release-probe", version: "1" } },
      }),
      signal: AbortSignal.timeout(3_000),
    });
    assert.equal(response.status, 200, `candidate MCP initialize returned HTTP ${response.status}`);
    const toolNamesModule = await import(pathToFileURL(join(artifactPath, "mcp", "tool-names.js")).href);
    await probeCandidateSurface(`http://127.0.0.1:${port}`, smokeRoot, [...toolNamesModule.REQUIRED_INSPECTION_TOOLS]);
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
    await new Promise((resolvePromise) => {
      if (child.exitCode !== null) return resolvePromise();
      child.once("exit", resolvePromise);
      setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
        resolvePromise();
      }, 5_000).unref();
    });
    rmSync(smokeRoot, { recursive: true, force: true });
  }
}

async function main() {
  const boot = process.argv.includes("--boot");
  const artifactArg = process.argv.slice(2).find((argument) => argument !== "--boot");
  if (!artifactArg) throw new Error("Usage: probe-release.mjs [--boot] ARTIFACT_PATH");
  const artifactPath = validateRelease(resolve(artifactArg)).artifactPath;
  const metadata = JSON.parse(readFileSync(join(artifactPath, "build-meta.json"), "utf8"));
  loadSmoke(artifactPath);
  if (boot) await bootSmoke(artifactPath, metadata.buildId);
  console.log(`[release-probe] ${boot ? "load and boot" : "load"} smoke passed for ${metadata.buildId}`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(`[release-probe] failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
