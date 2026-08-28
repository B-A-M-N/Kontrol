import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { validateRelease } from "./validate-release.mjs";

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
      // kontrol-env-exception: module-load smoke only imports the local release
      // and explicitly clears the runtime lock before spawning it.
      env: { ...process.env, KONTROL_RUNTIME_LOCK_TOKEN: "" },
      encoding: "utf8",
    });
    if (result.status !== 0) {
      throw new Error(`${entrypoint} load failed:\n${result.stderr || result.stdout}`);
    }
  }

  const help = spawnSync(process.execPath, [join(artifactPath, "cli.js"), "--help"], {
    cwd: artifactPath,
    // kontrol-env-exception: --help is a local release import smoke; the
    // runtime lock is explicitly cleared and no project-controlled command is run.
    env: { ...process.env, KONTROL_RUNTIME_LOCK_TOKEN: "" },
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

async function bootSmoke(artifactPath, buildId) {
  const smokeRoot = mkdtempSync(join(tmpdir(), "kontrol-release-smoke-"));
  const port = await unusedTcpPort();
  const env = {
    ...process.env,
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
    KONTROL_EXPECTED_BUILD_ID: buildId,
    KONTROL_ARTIFACT_PATH: artifactPath,
    KONTROL_LAUNCHER: "release-smoke",
    KONTROL_LAUNCH_GENERATION_ID: `release-smoke-${process.pid}-${Date.now()}`,
    KONTROL_RUNTIME_LOCK_TOKEN: "",
  };
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
