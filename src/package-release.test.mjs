import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
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
import { pathToFileURL } from "node:url";
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
  assert.ok(existsSync(join(pkg, "dist/service.js")), "packed package is missing compiled service lifecycle code");
  assert.equal(
    existsSync(join(pkg, "scripts/kontrol-user-service.sh")),
    false,
    "checkout-only service wrappers must not be required by the installed package",
  );
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

  const servicePreview = JSON.parse(execFileSync("node", [installedCli, "service", "unit", "--json"], {
    cwd: installPrefix,
    env: {
      ...serviceEnvForInstall(tmp, installPrefix),
      KONTROL_STATE_DIR: join(tmp, "service-preview-state"),
    },
    encoding: "utf8",
  }));
  assert.equal(servicePreview.build.buildId, JSON.parse(readFileSync(join(installedPkg, "dist/build-meta.json"), "utf8")).buildId);
  assert.match(servicePreview.unit, new RegExp(`ExecStart=/usr/bin/env node ".*dist/cli\\.js" serve`));
  assert.doesNotMatch(servicePreview.unit, /tsx|src\/config|kontrol-user-service\.sh/);

  const servicePort = await unusedTcpPort();
  const serviceState = join(tmp, "installed-state");
  const serviceEnv = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("KONTROL_POLICY_"))),
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
    // Exercise the real zero-configuration secure baseline: structured
    // read-only discovery is frictionless, while arbitrary shell and file
    // mutation return approval_required without executing.
    KONTROL_TUNNEL_REVIEWER_SECRET: "package-release-reviewer-secret-long-enough",
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

    const listed = await postMcp(mcpUrl, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    }, sessionId);
    const toolNames = (listed.body?.result?.tools ?? []).map((tool) => tool.name);
    for (const name of ["read", "grep", "glob", "ls"]) {
      assert.ok(toolNames.includes(name), `installed default tool surface includes structured ${name}; got ${JSON.stringify(toolNames)}`);
    }

    const opened = await postMcp(mcpUrl, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "open_workspace", arguments: { path: installPrefix } },
    }, sessionId);
    assert.equal(opened.response.status, 200, "installed open_workspace call succeeds");
    const workspaceId = opened.body?.result?.structuredContent?.workspaceId;
    assert.equal(typeof workspaceId, "string", "open_workspace returns a workspace ID");

    const read = await postMcp(mcpUrl, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "read", arguments: { workspaceId, path: "package.json", limit: 5 } },
    }, sessionId);
    assert.equal(read.response.status, 200, "installed read call succeeds");
    assert.match(JSON.stringify(read.body), /@b-a-m-n\/kontrol/, "installed read returns package contents");

    const grep = await postMcp(mcpUrl, {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "grep", arguments: { workspaceId, pattern: "@b-a-m-n", path: "package.json" } },
    }, sessionId);
    assert.equal(grep.response.status, 200, "installed grep call succeeds without approval");
    assert.match(JSON.stringify(grep.body), /@b-a-m-n\/kontrol/, "installed grep returns repository matches");

    const glob = await postMcp(mcpUrl, {
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "glob", arguments: { workspaceId, pattern: "**/*.json" } },
    }, sessionId);
    assert.equal(glob.response.status, 200, "installed glob call succeeds without approval");
    assert.doesNotMatch(JSON.stringify(glob.body), /approval_required/, "installed glob does not enter the approval boundary");

    const ls = await postMcp(mcpUrl, {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "ls", arguments: { workspaceId, path: "." } },
    }, sessionId);
    assert.equal(ls.response.status, 200, "installed ls call succeeds without approval");
    assert.match(JSON.stringify(ls.body), /package\.json/, "installed ls returns directory entries");

    const bash = await postMcp(mcpUrl, {
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: { name: "bash", arguments: { workspaceId, command: "pwd" } },
    }, sessionId);
    assert.equal(bash.response.status, 200, "installed bash returns the approval boundary");
    assert.equal(bash.body?.result?.structuredContent?.status, "approval_required", "installed bash is gated by the secure baseline");

    const write = await postMcp(mcpUrl, {
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name: "write", arguments: { workspaceId, path: "should-not-be-written.txt", content: "blocked" } },
    }, sessionId);
    assert.equal(write.response.status, 200, "installed write returns the approval boundary");
    assert.equal(write.body?.result?.structuredContent?.status, "approval_required", "installed write is gated by the secure baseline");
    assert.equal(existsSync(join(installPrefix, "should-not-be-written.txt")), false, "gated write does not execute");

    const edit = await postMcp(mcpUrl, {
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: { name: "edit", arguments: { workspaceId, path: "package.json", edits: [{ oldText: "never-match", newText: "blocked" }] } },
    }, sessionId);
    assert.equal(edit.response.status, 200, "installed edit returns the approval boundary");
    assert.equal(edit.body?.result?.structuredContent?.status, "approval_required", "installed edit is gated by the secure baseline");
  } finally {
    if (service.exitCode === null) service.kill("SIGTERM");
    await waitForChild(service);
    assert.equal(
      service.exitCode,
      0,
      `installed server exits cleanly on SIGTERM (exit=${service.exitCode}, signal=${service.signalCode}, stderr=${serviceStderr})`,
    );
  }

  await exerciseInstalledCodexMutationBoundary(installedCli, installPrefix, serviceEnv, tmp);
  await exerciseInstalledServiceLifecycle(installedPkg, tmp);

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

async function exerciseInstalledCodexMutationBoundary(installedCli, installPrefix, baseEnv, tmpRoot) {
  const port = await unusedTcpPort();
  const stateDir = join(tmpRoot, "installed-codex-state");
  const env = {
    ...baseEnv,
    PORT: String(port),
    KONTROL_STATE_DIR: stateDir,
    KONTROL_TOOL_MODE: "codex",
  };
  const child = spawn("node", [installedCli, "serve"], {
    cwd: installPrefix,
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
  try {
    await waitForHttp(`http://127.0.0.1:${port}/healthz`, child, () => stderr);
    const url = `http://127.0.0.1:${port}/mcp`;
    let id = 1;
    const initialized = await postMcp(url, {
      jsonrpc: "2.0",
      id: id++,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "package-codex-boundary", version: "1" } },
    });
    const sessionId = initialized.response.headers.get("mcp-session-id");
    assert.ok(sessionId, "codex-mode installed MCP initialize returns a session identity");
    await postMcp(url, { jsonrpc: "2.0", method: "notifications/initialized", params: {} }, sessionId);
    const listed = await postMcp(url, { jsonrpc: "2.0", id: id++, method: "tools/list", params: {} }, sessionId);
    assert.ok((listed.body?.result?.tools ?? []).some((tool) => tool.name === "apply_patch"), "codex-mode installed surface includes apply_patch");
    const opened = await postMcp(url, {
      jsonrpc: "2.0",
      id: id++,
      method: "tools/call",
      params: { name: "open_workspace", arguments: { path: installPrefix } },
    }, sessionId);
    const workspaceId = opened.body?.result?.structuredContent?.workspaceId;
    assert.equal(typeof workspaceId, "string", "codex-mode open_workspace returns a workspace ID");
    const patch = await postMcp(url, {
      jsonrpc: "2.0",
      id: id++,
      method: "tools/call",
      params: {
        name: "apply_patch",
        arguments: {
          workspaceId,
          patch: "*** Begin Patch\n*** Add File: should-not-be-patched.txt\n+blocked\n*** End Patch",
        },
      },
    }, sessionId);
    assert.equal(patch.response.status, 200, "codex-mode apply_patch returns the approval boundary");
    assert.equal(patch.body?.result?.structuredContent?.status, "approval_required", `codex-mode apply_patch is gated by the secure baseline: ${JSON.stringify(patch.body)}`);
    assert.equal(existsSync(join(installPrefix, "should-not-be-patched.txt")), false, "gated apply_patch does not execute");
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
    await waitForChild(child);
    assert.equal(child.exitCode, 0, `codex-mode installed server exits cleanly (stderr=${stderr})`);
  }
}

async function exerciseInstalledServiceLifecycle(installedPkg, tmpRoot) {
  const serviceModule = await import(pathToFileURL(join(installedPkg, "dist", "service.js")).href);
  const databaseModule = await import(pathToFileURL(join(installedPkg, "dist", "db", "client.js")).href);
  const backupModule = await import(pathToFileURL(join(installedPkg, "dist", "db", "deployment-backup.js")).href);
  const migrationsModule = await import(pathToFileURL(join(installedPkg, "dist", "db", "migrations.js")).href);
  const installedRequire = createRequire(pathToFileURL(join(installedPkg, "package.json")));
  const Database = installedRequire("better-sqlite3");
  const rootDir = join(tmpRoot, "installed-service-lifecycle");
  const candidate = join(rootDir, "candidate");
  mkdirSync(candidate, { recursive: true });
  const baseMeta = JSON.parse(readFileSync(join(installedPkg, "dist", "build-meta.json"), "utf8"));
  const candidateMeta = {
    ...baseMeta,
    buildId: `${baseMeta.buildId}-candidate`,
    contentSha256: "b".repeat(16),
    schemaVersion: Number(baseMeta.schemaVersion) + 1,
    maxReadableSchemaVersion: Number(baseMeta.maxReadableSchemaVersion) + 1,
  };
  writeFileSync(join(candidate, "cli.js"), "#!/usr/bin/env node\n");
  writeFileSync(join(candidate, "build-meta.json"), JSON.stringify(candidateMeta));

  const env = {
    ...serviceEnvForInstall(tmpRoot, rootDir),
    KONTROL_STATE_DIR: join(rootDir, "database state"),
    KONTROL_USER_SERVICE_NAME: "kontrol-package-fixture.service",
  };
  const paths = serviceModule.servicePaths(env);
  const calls = [];
  const dependencies = {
    currentArtifactPath: () => join(installedPkg, "dist"),
    requireSystemd: () => undefined,
    systemctl: (servicePaths, args) => {
      calls.push(args.join(" "));
      if (args[0] !== "start") return;
      const installed = JSON.parse(readFileSync(servicePaths.statePath, "utf8"));
      if (installed.buildId !== candidateMeta.buildId) return;
      const sqlite = new Database(databaseModule.databasePath(servicePaths.stateDir));
      try {
        backupModule.captureMigrationBackup(sqlite, databaseModule.databasePath(servicePaths.stateDir), servicePaths.stateDir, installed.deploymentId, candidateMeta.schemaVersion);
        sqlite.exec("create table installed_candidate_only (id text primary key not null)");
        sqlite.prepare("insert into kontrol_schema_migrations (version, name, applied_at) values (?, ?, ?)").run(
          candidateMeta.schemaVersion,
          "installed_package_fixture_migration",
          new Date().toISOString(),
        );
      } finally {
        sqlite.close();
      }
    },
    waitForReady: async (_servicePaths, expected) => {
      if (expected.buildId === candidateMeta.buildId) throw new Error("installed candidate failed readiness");
    },
  };

  await serviceModule.runServiceCommand(["install"], env, dependencies);
  const initial = databaseModule.openDatabase(paths.stateDir);
  initial.close();
  await assert.rejects(
    () => serviceModule.runServiceCommand(["upgrade"], env, { ...dependencies, currentArtifactPath: () => candidate }),
    /Candidate .* failed readiness; previous build .* and database were restored/,
  );
  const restoredState = JSON.parse(readFileSync(paths.statePath, "utf8"));
  assert.equal(restoredState.buildId, baseMeta.buildId, "installed service rollback restores the previous artifact");
  const sqlite = new Database(databaseModule.databasePath(paths.stateDir), { readonly: true });
  try {
    const schema = sqlite.prepare("select max(version) as version from kontrol_schema_migrations").get();
    assert.equal(schema.version, migrationsModule.LATEST_SCHEMA_VERSION, "installed service rollback restores the prior schema");
    assert.throws(() => sqlite.prepare("select * from installed_candidate_only").get(), /no such table/);
  } finally {
    sqlite.close();
  }
  assert.deepEqual(calls.filter((call) => call.startsWith("start") || call.startsWith("stop")).slice(-4), [
    "stop kontrol-package-fixture.service",
    "start kontrol-package-fixture.service",
    "stop kontrol-package-fixture.service",
    "start kontrol-package-fixture.service",
  ]);
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

function serviceEnvForInstall(tmpRoot, installPrefix) {
  return {
    ...process.env,
    XDG_CONFIG_HOME: join(tmpRoot, "service-config-home"),
    XDG_DATA_HOME: join(tmpRoot, "service-data-home"),
    KONTROL_SERVICE_DATA_DIR: join(tmpRoot, "service-data"),
    KONTROL_ALLOWED_ROOTS: installPrefix,
  };
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
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => child.once("exit", resolve));
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
