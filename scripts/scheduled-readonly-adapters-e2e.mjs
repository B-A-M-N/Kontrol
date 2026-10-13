/**
 * Compose durable scheduled read-only dispatch with the real bundled ACP
 * adapters. Unlike the lower-level adapter test, the production scheduler
 * creates the run and each adapter performs the confined worker execution.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findBubblewrap } from "../src/read-only-execution.mjs";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const REVIEWER_SECRET = "scheduled-readonly-reviewer-secret-long";
const AGENT_SECRET = "scheduled-readonly-agent-secret-long";
const ADAPTER_SECRET = "scheduled-readonly-adapter-secret-long";
const SOURCE = "scheduled adapter fixture source stays unchanged\n";
const TASK = "Read the workspace and report whether mutation attempts were denied.";

const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function mutationProbeShell() {
  return [
    "set +e",
    'source=$(cat /workspace/source.txt 2>/dev/null)',
    'printf changed >> /workspace/source.txt 2>/dev/null',
    'source_write=$?',
    'git -C /workspace config user.name attacker >/dev/null 2>&1',
    'git_config=$?',
    'git -C /workspace add source.txt >/dev/null 2>&1',
    'git_index=$?',
    'printf changed > /workspace/outside-link 2>/dev/null',
    'symlink_write=$?',
    "/bin/sh -c 'printf helper > /workspace/helper-write.txt' >/dev/null 2>&1",
    'helper_write=$?',
    'printf scratch > /tmp/kontrol-read-only-scratch 2>/dev/null',
    'scratch_write=$?',
    'printf "read=%s;source_write=%s;git_config=%s;git_index=%s;symlink_write=%s;helper_write=%s;scratch_write=%s\\n" "$source" "$source_write" "$git_config" "$git_index" "$symlink_write" "$helper_write" "$scratch_write"',
  ].join("\n");
}

async function listen(server) {
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  return server.address().port;
}

async function freePort() {
  const server = createServer();
  const port = await listen(server);
  await new Promise((resolveClose) => server.close(resolveClose));
  return port;
}

async function waitFor(description, predicate, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await predicate();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ""}`);
}

async function createWorkspace(root) {
  const workspaceRoot = join(root, "workspace");
  const outsideFile = join(root, "outside.txt");
  await mkdir(workspaceRoot, { recursive: true });
  await writeFile(join(workspaceRoot, "source.txt"), SOURCE);
  await writeFile(outsideFile, "outside scheduled fixture remains unchanged\n");
  await symlink(outsideFile, join(workspaceRoot, "outside-link"));
  execFileSync("git", ["init", "-q", workspaceRoot]);
  execFileSync("git", ["-C", workspaceRoot, "config", "user.name", "fixture"]);
  return {
    workspaceRoot,
    outsideFile,
    sourceHash: sha256(await readFile(join(workspaceRoot, "source.txt"))),
    gitConfigHash: sha256(await readFile(join(workspaceRoot, ".git", "config"))),
    outsideHash: sha256(await readFile(outsideFile)),
  };
}

async function createBubblewrapWrapper(root) {
  const realBubblewrap = findBubblewrap();
  const marker = join(root, "bubblewrap-calls.txt");
  const wrapper = join(root, "bwrap-wrapper");
  await writeFile(wrapper, `#!/bin/sh\nprintf 'called\\n' >> ${shellQuote(marker)}\nexec ${shellQuote(realBubblewrap)} "$@"\n`);
  await chmod(wrapper, 0o700);
  return { wrapper, marker };
}

async function createHermesFixture(root) {
  const hermesRoot = join(root, "hermes-runtime");
  const toolchainRoot = await mkdtemp(join(repoRoot, ".tmp-kontrol-scheduled-hermes-toolchain-"));
  const pythonRuntime = join(toolchainRoot, ".venv");
  const pythonBin = join(pythonRuntime, "bin", "python");
  const sitePackages = join(pythonRuntime, "lib", "python3.10", "site-packages");
  const fakeHermesBin = join(root, "fake-hermes");
  await mkdir(join(pythonRuntime, "bin"), { recursive: true });
  await mkdir(join(sitePackages, "acp"), { recursive: true });
  for (const packagePath of ["acp_adapter", "agent"]) {
    await mkdir(join(hermesRoot, packagePath), { recursive: true });
    await writeFile(join(hermesRoot, packagePath, "__init__.py"), "# scheduled integration fixture\n");
  }
  await writeFile(join(sitePackages, "acp", "__init__.py"), "async def connect_to_agent(*args, **kwargs):\n    raise RuntimeError('fixture ACP client is provided by the native adapter')\nclass Client:\n    pass\n");
  await writeFile(join(sitePackages, "acp", "connection.py"), "class StreamDirection:\n    INCOMING = 'incoming'\nclass StreamEvent:\n    pass\n");
  await writeFile(join(hermesRoot, "acp_adapter", "client.py"), [
    "import asyncio",
    "from types import SimpleNamespace",
    "",
    "class TaskEvent:",
    "    def __init__(self, success, response_text, error=''):",
    "        self.success = success",
    "        self.response_text = response_text",
    "        self.thought_text = ''",
    "        self.usage = {}",
    "        self.stop_reason = 'completed' if success else 'error'",
    "        self.error = error",
    "",
    "class _Connection:",
    "    def add_observer(self, _observer):",
    "        return None",
    "",
    "class ACPClient:",
    "    def __init__(self, command, args, cwd, env, on_event, timeout, model):",
    "        self.command, self.args, self.cwd, self.env, self.timeout = command, args, cwd, env, timeout",
    "        self._conn = SimpleNamespace(_conn=_Connection())",
    "    async def __aenter__(self):",
    "        return self",
    "    async def __aexit__(self, *_args):",
    "        return False",
    "    async def dispatch_task(self, prompt, task_id, timeout, cwd):",
    "        process = await asyncio.create_subprocess_exec(self.command, *self.args, cwd=cwd, env=self.env, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)",
    "        stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=timeout)",
    "        return TaskEvent(process.returncode == 0, stdout.decode(), stderr.decode())",
    "",
  ].join("\n"));
  await writeFile(pythonBin, `#!/bin/sh\nexport PYTHONPATH=${shellQuote(sitePackages)}:"$PYTHONPATH"\nexec /usr/bin/python3 "$@"\n`);
  await chmod(pythonBin, 0o700);
  await writeFile(fakeHermesBin, `#!/bin/sh\nif [ "$1" = acp ] && [ "$2" = --check ]; then exit 0; fi\nif [ "$1" = acp ]; then\n${mutationProbeShell()}\nexit 0\nfi\nexit 93\n`);
  await chmod(fakeHermesBin, 0o700);
  return { hermesRoot, toolchainRoot, pythonRuntime, pythonBin, fakeHermesBin };
}

function makeEnvironment(overrides = {}) {
  const env = {};
  for (const name of ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "USER", "LOGNAME", "SHELL"]) {
    if (typeof process.env[name] === "string") env[name] = process.env[name];
  }
  return { ...env, ...overrides };
}

function startChild(command, args, { cwd, env }) {
  const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let logs = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { logs += chunk; });
  child.stderr.on("data", (chunk) => { logs += chunk; });
  child.once("exit", (code) => {
    if (code !== 0 && code !== null) console.error(`[scheduled-readonly] child exited (${code}): ${logs.slice(-3000)}`);
  });
  return { child, getLogs: () => logs };
}

async function stopChild(record) {
  if (!record || record.child.exitCode !== null) return;
  record.child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolveExit) => record.child.once("exit", resolveExit)),
    delay(5_000),
  ]);
  if (record.child.exitCode === null) record.child.kill("SIGKILL");
}

async function startServer({ root, stateDir, configDir, port }) {
  const envFile = join(configDir, "scheduled-readonly.env");
  await writeFile(envFile, [
    `KONTROL_CONFIG_DIR=${configDir}`,
    `KONTROL_ALLOWED_ROOTS=${root}`,
    `KONTROL_STATE_DIR=${stateDir}`,
    "HOST=127.0.0.1",
    "KONTROL_ACP_ENABLED=true",
    "KONTROL_TOOL_MODE=full",
    "KONTROL_POLICY_MODE=allow",
    "KONTROL_AUTH_MODE=tunnel",
    "KONTROL_READ_ONLY_NETWORK_POLICY=disabled",
    "KONTROL_LOG_LEVEL=error",
    "KONTROL_LOG_REQUESTS=0",
    `KONTROL_ACP_AGENT_SECRET=${AGENT_SECRET}`,
    `KONTROL_ACP_REVIEWER_SECRET=${REVIEWER_SECRET}`,
    `KONTROL_ACP_ADAPTER_SECRET=${ADAPTER_SECRET}`,
    `PORT=${port}`,
  ].join("\n") + "\n");
  return startChild(process.execPath, ["--import", "tsx", "src/cli.ts", "serve"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      KONTROL_ENV_FILE: envFile,
      KONTROL_CONFIG_DIR: configDir,
      KONTROL_ALLOWED_ROOTS: root,
      KONTROL_STATE_DIR: stateDir,
      KONTROL_ACP_ENABLED: "true",
      KONTROL_AUTH_MODE: "tunnel",
      KONTROL_TOOL_MODE: "full",
      KONTROL_POLICY_MODE: "allow",
      KONTROL_READ_ONLY_NETWORK_POLICY: "disabled",
      KONTROL_LOG_LEVEL: "error",
      KONTROL_LOG_REQUESTS: "0",
      KONTROL_ACP_AGENT_SECRET: AGENT_SECRET,
      KONTROL_ACP_REVIEWER_SECRET: REVIEWER_SECRET,
      KONTROL_ACP_ADAPTER_SECRET: ADAPTER_SECRET,
      PORT: String(port),
    },
  });
}

async function waitForHttp(url, description, timeoutMs = 25_000) {
  return waitFor(description, async () => {
    try {
      const response = await fetch(url);
      return response.ok;
    } catch {
      return false;
    }
  }, timeoutMs);
}

async function startAdapter(name, { port, acpUrl, root, wrapper, hermes, stateDir }) {
  const adapterDirectory = join(stateDir, "adapter-state");
  await mkdir(adapterDirectory, { recursive: true });
  const commonEnv = {
    KONTROL_ACP_URL: acpUrl,
    KONTROL_ACP_AGENT_SECRET: AGENT_SECRET,
    KONTROL_ACP_ADAPTER_SECRET: ADAPTER_SECRET,
    KONTROL_ALLOWED_ROOTS: root,
    KONTROL_BWRAP: wrapper,
  };
  if (name === "crush") {
    const crushBin = join(stateDir, "fake-crush");
    return writeFile(crushBin, `#!/bin/sh\nprintf 'worker-started\\n'\n${mutationProbeShell()}\nexit 0\n`).then(async () => {
      await chmod(crushBin, 0o700);
      const portValue = String(port);
      return startChild(process.execPath, ["scripts/acp-crush-adapter.mjs"], {
        cwd: repoRoot,
        env: makeEnvironment({
          ...commonEnv,
          ACP_ADAPTER_PORT: portValue,
          CRUSH_BIN: crushBin,
          ACP_ADAPTER_REPLAY_STORE: join(adapterDirectory, "crush-replay.json"),
          KONTROL_CRUSH_DISPATCH_RECEIPTS: join(adapterDirectory, "crush-receipts.json"),
          KONTROL_CRUSH_OWNED_PROCESSES: join(adapterDirectory, "crush-owned.json"),
          KONTROL_ACP_AGENT_STATE_FILE: join(adapterDirectory, "crush-agent-identity.json"),
        }),
      });
    });
  }
  return writeFile(hermes.fakeHermesBin, `#!/bin/sh\nif [ "$1" = acp ] && [ "$2" = --check ]; then exit 0; fi\nif [ "$1" = acp ]; then\nprintf 'worker-started\\n'\n${mutationProbeShell()}\nexit 0\nfi\nexit 93\n`).then(async () => {
    await chmod(hermes.fakeHermesBin, 0o700);
    const portValue = String(port);
    return startChild(process.execPath, ["scripts/acp-hermes-native-adapter.mjs"], {
      cwd: repoRoot,
      env: makeEnvironment({
        ...commonEnv,
        HERMES_ACP_ADAPTER_PORT: portValue,
        HERMES_AGENT_ROOT: hermes.hermesRoot,
        HERMES_NATIVE_PYTHON: hermes.pythonBin,
        HERMES_BIN: hermes.fakeHermesBin,
        KONTROL_VERIFY_TOOLCHAIN_PATHS: hermes.pythonRuntime,
        KONTROL_HERMES_DISPATCH_RECEIPTS: join(adapterDirectory, "hermes-receipts.json"),
        KONTROL_HERMES_OWNED_PROCESSES: join(adapterDirectory, "hermes-owned.json"),
        KONTROL_HERMES_TERMINAL_SPOOL: join(adapterDirectory, "hermes-terminal-spool.json"),
        KONTROL_HERMES_EVENT_SPOOL: join(adapterDirectory, "hermes-event-spool.json"),
        KONTROL_ACP_AGENT_STATE_FILE: join(adapterDirectory, "hermes-agent-identity.json"),
      }),
    });
  });
}

async function runAdapterCase(name) {
  const root = await mkdtemp(join(tmpdir(), `kontrol-scheduled-${name}-root-`));
  const stateDir = await mkdtemp(join(tmpdir(), `kontrol-scheduled-${name}-state-`));
  const configDir = await mkdtemp(join(tmpdir(), `kontrol-scheduled-${name}-config-`));
  const workspace = await createWorkspace(root);
  const { wrapper, marker } = await createBubblewrapWrapper(root);
  const hermes = name === "hermes" ? await createHermesFixture(root) : undefined;
  const serverPort = await freePort();
  const adapterPort = await freePort();
  const baseUrl = `http://127.0.0.1:${serverPort}`;
  let server;
  let adapter;
  let sharedDb;
  try {
    server = await startServer({ root, stateDir, configDir, port: serverPort });
    await waitForHttp(`${baseUrl}/healthz`, `${name} Kontrol server health`);
    adapter = await startAdapter(name, {
      port: adapterPort,
      acpUrl: `${baseUrl}/acp`,
      root: workspace.workspaceRoot,
      wrapper,
      hermes,
      stateDir,
    });
    const adapterUrl = `http://127.0.0.1:${adapterPort}`;
    await waitForHttp(`${adapterUrl}/health`, `${name} adapter health`);

    const { openDatabase } = await import("../src/db/client.js");
    const { createDispatchOutbox } = await import("../src/dispatch-outbox.js");
    const { createScheduledJobStore } = await import("../src/scheduling/scheduled-job-store.js");
    const { createScheduledJobRuntime } = await import("../src/scheduling/scheduled-job-runtime.js");
    const { dispatchScheduledJob } = await import("../src/scheduling/scheduled-job-dispatch.js");
    const { loadConfig } = await import("../src/config.js");
    const { createAgentRegistryManager } = await import("../src/acp-registry.js");
    const { createWorkSessionManager } = await import("../src/work-sessions.js");
    const { SqliteWorkspaceStore } = await import("../src/workspace-store.js");
    const { WorkspaceRegistry } = await import("../src/workspaces.js");

    sharedDb = openDatabase(stateDir);
    const outbox = createDispatchOutbox(sharedDb);
    const jobs = createScheduledJobStore(sharedDb, outbox);
    const serverConfig = loadConfig({
      KONTROL_CONFIG_DIR: configDir,
      KONTROL_ALLOWED_ROOTS: root,
      KONTROL_STATE_DIR: stateDir,
      KONTROL_AUTH_MODE: "tunnel",
      KONTROL_ACP_ENABLED: "true",
      KONTROL_TOOL_MODE: "full",
      KONTROL_POLICY_MODE: "allow",
      KONTROL_READ_ONLY_NETWORK_POLICY: "disabled",
      KONTROL_ACP_AGENT_SECRET: AGENT_SECRET,
      KONTROL_ACP_ADAPTER_SECRET: ADAPTER_SECRET,
      KONTROL_ACP_REVIEWER_SECRET: REVIEWER_SECRET,
      KONTROL_ALLOWED_ROOTS_ACK: "1",
      PORT: String(serverPort),
    });
    const agentRegistry = createAgentRegistryManager(sharedDb);
    const expectedAgent = name === "crush" ? "cli-coding-agent" : "hermes-agent";
    await waitFor(`${name} registration`, () => agentRegistry.listAlive().find((agentInfo) => agentInfo.name === expectedAgent));
    const workSessions = createWorkSessionManager(sharedDb);
    const workspaceStore = new SqliteWorkspaceStore(sharedDb);
    const workspaces = new WorkspaceRegistry(serverConfig, workspaceStore);
    const opened = await workspaces.openWorkspace(workspace.workspaceRoot);

    const job = jobs.create({
      principalId: `scheduled-${name}-principal`,
      ownerContextId: `principal:scheduled-${name}-principal|transport:e2e`,
      projectId: opened.workspace.id,
      workspaceRoot: workspace.workspaceRoot,
      runAt: new Date(Date.now() - 1_000).toISOString(),
      instructionJson: { instructions: TASK },
      executionMode: "read_only_audit",
      policySnapshotJson: { workspaceAccess: "read_only" },
      agentName: expectedAgent,
      maxRuntimeMs: 60_000,
    });
    const runtime = createScheduledJobRuntime({
      database: sharedDb,
      jobs,
      dispatchOutbox: outbox,
      pollMs: 60_000,
      dispatch: async (jobId) => {
        const current = jobs.get(jobId);
        if (!current) return { status: "failed", reason: "scheduled job disappeared" };
        const outcome = await dispatchScheduledJob({
          workspaces,
          workSessions,
          agentRegistry,
          adapterSecret: ADAPTER_SECRET,
          serverConfig,
          eventStore: null,
          continuationManager: null,
          reviewWorkflow: null,
          missionLedger: null,
          supervisorRuns: null,
        }, jobs, current);
        return {
          status: outcome.status,
          workSessionId: outcome.workSessionId,
          runId: outcome.runId,
          remoteRunId: outcome.remoteRunId,
          attemptNumber: outcome.attemptNumber,
          executionReceipt: outcome.executionReceipt,
          reason: outcome.reason,
        };
      },
    });

    await runtime.drainOnce();
    const dispatched = jobs.get(job.id);
    assert.equal(dispatched?.status, "running", `${name} read-only scheduled dispatch was accepted: ${dispatched?.lastError ?? ""}`);
    assert.ok(dispatched?.workSessionId, `${name} scheduled dispatch owns a work session`);
    assert.equal(agentRegistry.getRunByWorkSessionId(dispatched.workSessionId)?.scheduledExecutionMode, "read_only_audit",
      `${name} run records read-only authority before its eager lifecycle events arrive`);
    const attempt = jobs.getAttempt(job.id);
    assert.equal(attempt?.executionReceipt?.issuer, "kontrol", `${name} persisted the correlated Kontrol execution receipt`);
    assert.equal(attempt?.executionReceipt?.confinement, "bubblewrap-read-only-workspace-no-network");
    assert.equal(attempt?.executionReceipt?.network_policy, "disabled");

    const completedRun = await waitFor(`${name} sandboxed worker completion`, () => {
      const run = agentRegistry.getRunByWorkSessionId(dispatched.workSessionId);
      return run?.finishedAt ? run : undefined;
      }, 40_000);
    assert.ok(["awaiting_review", "completed"].includes(completedRun.status),
      `${name} bounded worker finished and entered its review state: status=${completedRun.status}, error=${completedRun.errorMessage ?? "none"}, output=${completedRun.outputJson ?? "none"}`);
    const parsedOutput = JSON.parse(completedRun.outputJson ?? "{}");
    const output = parsedOutput.output?.flatMap((message) => message.parts?.map((part) => part.content ?? "") ?? []).join("\n") ?? "";
    assert.match(output, /read=scheduled adapter fixture source stays unchanged/,
      `${name} worker read the scheduled workspace through its confined mount: ${output}`);
    for (const field of ["source_write", "git_config", "git_index", "symlink_write", "helper_write"]) {
      assert.match(output, new RegExp(`${field}=[1-9]`), `${name} denied ${field}: ${output}`);
    }
    assert.match(output, /worker-started/, `${name} launched the bounded worker process`);
    assert.match(output, /scratch_write=0/, `${name} provided isolated scratch storage: ${output}`);
    assert.ok((await readFile(marker, "utf8")).includes("called"), `${name} reached the real Bubblewrap wrapper`);
    assert.equal(sha256(await readFile(join(workspace.workspaceRoot, "source.txt"))), workspace.sourceHash,
      `${name} left the scheduled source bytes unchanged`);
    assert.equal(sha256(await readFile(join(workspace.workspaceRoot, ".git", "config"))), workspace.gitConfigHash,
      `${name} left Git configuration unchanged`);
    assert.equal(sha256(await readFile(workspace.outsideFile)), workspace.outsideHash,
      `${name} left the symlink target outside the workspace unchanged`);
    await assert.rejects(readFile(join(workspace.workspaceRoot, "helper-write.txt")), { code: "ENOENT" },
      `${name} helper process did not create a workspace file`);

    runtime.stop();
    sharedDb.close();
    sharedDb = undefined;
    console.log(`scheduled-readonly-adapters-e2e: ${name} passed`);
  } catch (error) {
    const detail = [server?.getLogs(), adapter?.getLogs()].filter(Boolean).join("\n--- adapter logs ---\n");
    if (detail) error.message += `\n${detail.slice(-8_000)}`;
    throw error;
  } finally {
    sharedDb?.close();
    await stopChild(adapter);
    await stopChild(server);
    await rm(root, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
    if (hermes?.toolchainRoot) await rm(hermes.toolchainRoot, { recursive: true, force: true });
  }
}

await runAdapterCase("crush");
await runAdapterCase("hermes");
console.log("scripts/scheduled-readonly-adapters-e2e.mjs: passed");
