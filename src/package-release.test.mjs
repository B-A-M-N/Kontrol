import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { gunzipSync } from "node:zlib";

const root = process.cwd();
const tmp = mkdtempSync(join(tmpdir(), "kontrol-package-"));

try {
  console.log("[package-release] packing release artifact...");
  execFileSync("npm", ["pack", "--pack-destination", tmp], {
    cwd: root,
    env: { ...process.env, npm_config_cache: join(tmp, "npm-cache") },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const packedFilename = readdirSync(tmp).find((name) => name.endsWith(".tgz"));
  assert.ok(packedFilename, "npm pack did not create a tarball");

  const tarball = join(tmp, packedFilename);
  extractTgz(tarball, tmp);
  const pkg = join(tmp, "package");
  const packedPackageJson = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8"));
  assert.equal(packedPackageJson.name, "@b-a-m-n/kontrol", "package name changed unexpectedly");
  assert.equal(packedPackageJson.main, "dist/server.js", "package main must point at built server output");
  assert.equal(packedPackageJson.bin?.kontrol, "dist/cli.js", "kontrol bin must point at built CLI output");
  assert.ok(existsSync(join(pkg, "dist/server.js")), "packed package is missing dist/server.js");
  assert.ok(existsSync(join(pkg, "dist/cli.js")), "packed package is missing dist/cli.js");
  assert.ok(existsSync(join(pkg, "dist/acp-worker-token.mjs")), "packed package is missing dist/acp-worker-token.mjs");
  assert.ok(existsSync(join(pkg, "scripts/kontrol-user-service.sh")), "packed package is missing the generated systemd service installer");
  assert.equal(
    existsSync(join(pkg, "scripts/kontrol-acp-crush-adapter.service")),
    false,
    "fixed-path systemd units must not ship until service install generation exists",
  );
  assertUserFacingBranding(pkg);

  // Verify the artifact as an installed product, not only as an extracted
  // tarball. This catches missing runtime files and package-relative imports
  // that the checkout's node_modules symlink would otherwise hide.
  const installPrefix = join(tmp, "clean-prefix");
  console.log("[package-release] installing clean artifact (using the configured npm cache)...");
  execFileSync("npm", [
    "install",
    "--prefix",
    installPrefix,
    "--prefer-offline",
    "--no-audit",
    "--no-fund",
    "--package-lock=false",
    tarball,
  ], {
    cwd: tmp,
    env: {
      ...process.env,
      npm_config_update_notifier: "false",
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const installedPkg = join(installPrefix, "node_modules", "@b-a-m-n", "kontrol");
  const installedCli = join(installedPkg, "dist", "cli.js");
  assert.ok(existsSync(installedCli), "clean install is missing dist/cli.js");
  const installedVersion = execFileSync("node", [installedCli, "--version"], {
    cwd: installPrefix,
    encoding: "utf8",
  }).trim();
  assert.equal(installedVersion, packedPackageJson.version, "installed CLI reports the package version");

  const servicePort = await unusedTcpPort();
  const serviceState = join(tmp, "installed-state");
  const serviceEnv = {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: String(servicePort),
    KONTROL_AUTH_MODE: "tunnel",
    KONTROL_ALLOWED_ROOTS: installPrefix,
    KONTROL_ALLOWED_HOSTS: "127.0.0.1,localhost",
    KONTROL_PUBLIC_BASE_URL: `http://127.0.0.1:${servicePort}`,
    KONTROL_STATE_DIR: serviceState,
    KONTROL_WORKTREE_ROOT: join(tmp, "installed-worktrees"),
    KONTROL_ACP_ENABLED: "false",
    KONTROL_LOG_FORMAT: "pretty",
    // This suite verifies execution plumbing, not the approval boundary.
    // The secure baseline gates bash behind `ask`; promote it explicitly so
    // an unattended smoke test can exercise shell execution.
    KONTROL_POLICY_TOOL_BASH: "allow",
  };
  const doctorOutput = execFileSync("node", [installedCli, "doctor"], {
    cwd: installPrefix,
    env: serviceEnv,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"], // capture stderr — review #10
  });
  assert.match(doctorOutput, /Mutation policy/, "installed doctor reports the trust posture");

  const service = spawn("node", [installedCli, "serve"], {
    cwd: installPrefix,
    env: serviceEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serviceStderr = "";
  service.stderr?.on("data", (chunk) => { serviceStderr += String(chunk); });
  try {
    await waitForHttp(`http://127.0.0.1:${servicePort}/healthz`, service, () => serviceStderr);
    assert.equal(service.exitCode, null, "installed server remains alive after binding");

    const mcpUrl = `http://127.0.0.1:${servicePort}/mcp`;
    const initialized = await postMcp(mcpUrl, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "package-release", version: "1" } },
    });
    assert.equal(initialized.response.status, 200, "installed MCP endpoint initializes");
    const sessionId = initialized.response.headers.get("mcp-session-id");
    assert.ok(sessionId, "MCP initialize returns a session identity");
    await postMcp(mcpUrl, { jsonrpc: "2.0", method: "notifications/initialized", params: {} }, sessionId);

    const opened = await postMcp(mcpUrl, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "open_workspace", arguments: { path: installPrefix } },
    }, sessionId);
    assert.equal(opened.response.status, 200, "installed open_workspace call succeeds");
    const workspaceId = opened.body?.result?.structuredContent?.workspaceId;
    assert.equal(typeof workspaceId, "string", "open_workspace returns a workspace ID");

    const read = await postMcp(mcpUrl, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "read", arguments: { workspaceId, path: "package.json", limit: 5 } },
    }, sessionId);
    assert.equal(read.response.status, 200, "installed read call succeeds");
    assert.match(JSON.stringify(read.body), /@b-a-m-n\/kontrol/, "installed read returns package contents");

    const bash = await postMcp(mcpUrl, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "bash", arguments: { workspaceId, command: "pwd" } },
    }, sessionId);
    assert.equal(bash.response.status, 200, "installed bash call succeeds");
    assert.match(JSON.stringify(bash.body), /clean-prefix/, "installed bash executes in the opened workspace");
  } finally {
    if (service.exitCode === null) service.kill("SIGTERM");
    await waitForChild(service);
    assert.equal(service.exitCode, 0, "installed server exits cleanly on SIGTERM");
  }

  // Review #9: shipped-adapter validation must run against the CLEAN
  // installation only. The checkout's node_modules used to be symlinked in
  // here, which could satisfy an adapter's imports with dependencies the
  // package never declared — defeating the isolation this test exists for.
  const rootNodeModules = join(root, "node_modules");
  assert.equal(
    existsSync(join(pkg, "node_modules")) && realpathSync(join(pkg, "node_modules")) === realpathSync(rootNodeModules),
    false,
    "installed package must not resolve modules through the checkout's node_modules",
  );

  // Packed-manifest hygiene: no secrets, state, or scratch artifacts ship.
  // (.env.example is an intentional, secret-free template and is allowed.)
  // build-meta.json / runtime-identity.js are required shipped code modules
  // (immutable identity + reconciliation helpers), not user-specific state.
  const forbiddenPatterns = [
    [/^\.env$/, "environment file with potential secrets"],
    [/^\.env\.(?!example$)/, "environment file variant"],
    [/(^|\/)\.kontrol(\/|$)/, "runtime state directory"],
    [/(^|\/)__pycache__(\/|$)/, "python bytecode cache"],
    [/\.sqlite(-wal|-shm)?$/, "database state"],
    [/server\.identity\.json/, "runtime identity state"],
    [/(^|\/)(dist\.previous|\.kontrol-build-)/, "build scratch"],
    [/\/(home|Users)\//, "user-specific absolute path"],
    [/\.(log|pid)$/, "runtime artifact"],
  ];
  for (const file of listFiles(pkg)) {
    for (const [pattern, reason] of forbiddenPatterns) {
      if (pattern.test(file)) {
        assert.fail(`packed manifest contains ${reason}: ${file}`);
      }
    }
  }

  console.log("[package-release] validating installed server and shipped adapters...");
  const shippedScripts = [
    "scripts/acp-crush-adapter.mjs",
    "scripts/acp-hermes-native-adapter.mjs",
    "scripts/acp-stdio-duplex-adapter.mjs",
    "scripts/mcp-stdio-bridge.mjs",
  ];

  for (const script of shippedScripts) {
    // Validate the script from the CLEAN INSTALL, not the extracted tarball —
    // the installed copy is the artifact users actually run.
    const scriptPath = join(installedPkg, script);
    assert.ok(existsSync(scriptPath), `clean install is missing ${script}`);
    const source = await readFile(scriptPath, "utf8");
    assert.equal(
      source.includes("../src/"),
      false,
      `${script} imports from ../src, which is not shipped`,
    );
    execFileSync("node", [scriptPath, "--validate-imports"], {
      cwd: join(installPrefix, "node_modules", "@b-a-m-n", "kontrol"),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  console.log("package-release.test.mjs: shipped adapter imports validated");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

function assertUserFacingBranding(pkg) {
  const checkedFiles = listFiles(pkg).filter((file) =>
    [
      ".env.example",
      "README.md",
      "package.json",
      "NOTICE",
      "docs",
    ].some((prefix) => file === prefix || file.startsWith(`${prefix}/`)),
  );

  for (const file of checkedFiles) {
    if (/\.(png|jpg|jpeg|gif|webp|ico)$/i.test(file)) continue;
    const text = readFileSync(join(pkg, file), "utf8");
    const withoutAttribution = removeAllowedAttribution(file, text);

    assert.equal(
      /Dev Desktop|devdesktop|dev desktop/.test(withoutAttribution),
      false,
      `${file} contains old Dev Desktop branding`,
    );
    assert.equal(
      /(^|[^A-Za-z])devspace([^A-Za-z]|$)/i.test(withoutAttribution),
      false,
      `${file} contains old DevSpace branding outside attribution`,
    );
    assert.equal(
      /OpenCollective|GitHub Sponsors|sponsor|funding|donate|buy me a coffee/i.test(text),
      false,
      `${file} contains funding/sponsor copy`,
    );
    assert.equal(
      /github\.com\/bamn\/kontrol/i.test(text),
      false,
      `${file} uses lowercase bamn GitHub owner; use B-A-M-N`,
    );
  }
}

function removeAllowedAttribution(file, text) {
  if (file === "NOTICE") return "";
  if (file !== "README.md") return text;
  return text.replace(/## Attribution[\s\S]*?(?=\n## |\n# |\s*$)/, "");
}

function listFiles(base, dir = "") {
  const out = [];
  for (const entry of readdirSync(join(base, dir))) {
    const rel = dir ? `${dir}/${entry}` : entry;
    const path = join(base, rel);
    const stat = statSync(path);
    if (stat.isDirectory()) out.push(...listFiles(base, rel));
    else if (stat.isFile()) out.push(rel);
  }
  return out;
}

function extractTgz(tarball, destination) {
  const buffer = gunzipSync(readFileSyncBuffer(tarball));
  let offset = 0;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    offset += 512;
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    if (!name) break;
    const sizeOctal = header.subarray(124, 136).toString("utf8").replace(/\0.*$/, "").trim();
    const size = sizeOctal ? Number.parseInt(sizeOctal, 8) : 0;
    const type = header[156];
    const outputPath = join(destination, name);
    if (type === 53) {
      mkdirSync(outputPath, { recursive: true });
    } else if (type === 48 || type === 0) {
      mkdirSync(dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, buffer.subarray(offset, offset + size));
    }
    offset += Math.ceil(size / 512) * 512;
  }
}

function readFileSyncBuffer(path) {
  return readFileSync(path);
}

async function unusedTcpPort() {
  const probe = createNetServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => probe.close(resolve));
  assert.ok(port > 0, "failed to allocate a test port");
  return port;
}

async function waitForHttp(url, child, stderr) {
  let lastError = "";
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`installed server exited before readiness (${child.exitCode}): ${stderr()}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`installed server did not become ready: ${lastError}; stderr=${stderr()}`);
}

async function waitForChild(child) {
  if (child.exitCode !== null) return;
  await new Promise((resolve) => child.once("close", resolve));
}

async function postMcp(url, body, sessionId) {
  const headers = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    ...(sessionId ? { "mcp-session-id": sessionId } : {}),
  };
  const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await response.text();
  if (!text) return { response, body: undefined };
  const dataLine = text.split(/\r?\n/).filter((line) => line.startsWith("data:")).at(-1);
  return { response, body: JSON.parse(dataLine ? dataLine.slice(5).trim() : text) };
}
