import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReadOnlyExecutionGrant, findBubblewrap } from "./read-only-execution.mjs";

const ADAPTER_SECRET = "adapter-integration-secret";
const AGENT_SECRET = "agent-integration-secret";
const SOURCE = "adapter fixture source stays unchanged\n";
const task = "Read the source and report whether each attempted mutation was denied.";

function adapterProcessEnvironment(overrides) {
  const env = {};
  for (const name of ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "USER", "LOGNAME", "SHELL"]) {
    if (typeof process.env[name] === "string") env[name] = process.env[name];
  }
  return { ...env, ...overrides };
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}

async function freePort() {
  const server = createServer();
  const port = await listen(server);
  await closeServer(server);
  return port;
}

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolve) => server.close(resolve));
}

async function waitFor(description, predicate, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function requestJson(url, { method = "GET", body, secret = ADAPTER_SECRET } = {}) {
  const response = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${secret}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let json = {};
  try { json = await response.json(); } catch { /* surfaced by assertions */ }
  return { response, json };
}

function makeReadOnlyBody({ workspaceRoot, agentId, runId, workSessionId, dispatchKey, grant, taskText = task, attemptNumber = 1, continuationId, contextTransfer }) {
  return {
    workspace_root: workspaceRoot,
    workspace_session_id: `workspace-${workSessionId}`,
    session_id: workSessionId,
    agent_id: agentId,
    parent_run_id: runId,
    attempt_number: attemptNumber,
    dispatch_idempotency_key: dispatchKey,
    ...(continuationId ? { continuation_id: continuationId } : {}),
    ...(contextTransfer ? { context_transfer: contextTransfer } : {}),
    scheduled_execution_policy: {
      executionMode: "read_only_audit",
      workspaceAccess: "read_only",
      mutate: false,
    },
    read_only_execution_grant: grant,
    input: [{ parts: [{ content: taskText }] }],
  };
}

function createGrant({ workspaceRoot, agentId, runId, workSessionId, dispatchKey, attemptNumber = 1 }) {
  return createReadOnlyExecutionGrant({
    workSessionId,
    workspaceSessionId: `workspace-${workSessionId}`,
    workspaceRoot,
    agentId,
    runId,
    attemptNumber,
    dispatchIdempotencyKey: dispatchKey,
  }, ADAPTER_SECRET);
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

async function createWorkspace(root) {
  const workspaceRoot = join(root, "workspace");
  const outsideFile = join(root, "outside.txt");
  await mkdir(workspaceRoot);
  await writeFile(join(workspaceRoot, "source.txt"), SOURCE);
  await writeFile(outsideFile, "outside fixture stays unchanged\n");
  await symlink(outsideFile, join(workspaceRoot, "outside-link"));
  execFileSync("git", ["init", "-q", workspaceRoot]);
  execFileSync("git", ["-C", workspaceRoot, "config", "user.name", "fixture"]);
  const gitConfig = await readFile(join(workspaceRoot, ".git", "config"));
  return {
    workspaceRoot,
    outsideFile,
    sourceHash: sha256(await readFile(join(workspaceRoot, "source.txt"))),
    outsideHash: sha256(await readFile(outsideFile)),
    gitConfigHash: sha256(gitConfig),
  };
}

async function createControlPlane(agentId, events, expectedDispatch) {
  const dispatches = Array.isArray(expectedDispatch) ? expectedDispatch : [expectedDispatch];
  const durableEventPath = join(dispatches[0].root, "kontrol-durable-events.jsonl");
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    let body = {};
    if (chunks.length) body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (req.url?.endsWith("/agents/register")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: agentId, agentCredential: `${agentId}-credential` }));
      return;
    }
    const eventRoute = req.url?.match(/\/runs\/([^/]+)\/events$/);
    let receiptAcknowledgement = {};
    if (eventRoute) {
      events.push(body);
      const terminal = ["completed", "failed", "cancelled", "exited"].includes(body.type);
      const correlatedDispatch = dispatches.find((dispatch) => decodeURIComponent(eventRoute[1]) === dispatch.runId
        && body.attempt_number === dispatch.attemptNumber);
      const exactDispatch = Boolean(correlatedDispatch)
        && typeof body.remote_run_id === "string"
        && typeof body.event_id === "string";
      if (terminal && exactDispatch) {
        await appendFile(durableEventPath, `${JSON.stringify({ runId: correlatedDispatch.runId, dispatchKey: correlatedDispatch.dispatchKey, ...body })}\n`);
        receiptAcknowledgement = {
          dispatch_receipt_acknowledged: true,
          dispatch_idempotency_key: correlatedDispatch.dispatchKey,
          remote_run_id: body.remote_run_id,
          attempt_number: body.attempt_number,
          event_id: body.event_id,
        };
      }
    }
    res.writeHead(202, { "content-type": "application/json" });
    res.end(JSON.stringify({ accepted: true, ...receiptAcknowledgement }));
  });
  const port = await listen(server);
  return { server, url: `http://127.0.0.1:${port}/acp`, durableEventPath };
}

async function assertReceiptAcknowledged({ adapterName, receiptsPath, dispatchKey, remoteRunId, control }) {
  const receipt = await waitFor(`${adapterName} durable receipt acknowledgement`, async () => {
    try {
      const stored = JSON.parse(await readFile(receiptsPath, "utf8"));
      return stored.find((item) => item.key === dispatchKey && item.remoteRunId === remoteRunId && item.controllerAcknowledgedAt);
    } catch { return false; }
  });
  assert.equal(typeof receipt.controllerAcknowledgedAt, "number", `${adapterName} receipt is marked only after Kontrol acknowledgement`);
  assert.equal(typeof receipt.controllerEventId, "string");
  const durableEvents = (await readFile(control.durableEventPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(durableEvents.some((event) => event.dispatchKey === dispatchKey && event.remote_run_id === remoteRunId && event.event_id === receipt.controllerEventId),
    `${adapterName} only releases retention after the matching terminal event is durable at the controller`);
}

async function createBubblewrapWrapper(root) {
  const realBubblewrap = findBubblewrap();
  const marker = join(root, "bubblewrap-calls.txt");
  const wrapper = join(root, "bwrap-wrapper");
  await writeFile(wrapper, `#!/bin/sh\nprintf 'called\\n' >> ${shellQuote(marker)}\nexec ${shellQuote(realBubblewrap)} "$@"\n`);
  await chmod(wrapper, 0o700);
  return { wrapper, marker };
}

async function assertConfinedResult({ adapterName, state, accepted, events, outsideFile, logs }) {
  assert.equal(accepted.execution_receipt?.issuer, "kontrol", `${adapterName} returns Kontrol's execution receipt`);
  assert.equal(accepted.execution_receipt?.network_policy, "disabled", `${adapterName} uses the signed no-network policy`);
  assert.equal(accepted.execution_receipt?.confinement, "bubblewrap-read-only-workspace-no-network");
  const text = await waitFor(`${adapterName} worker output`, () => {
    const matching = events.find((event) => JSON.stringify(event).includes("read=adapter fixture source stays unchanged"));
    return matching && JSON.stringify(matching);
  });
  for (const field of ["source_write", "git_config", "git_index", "symlink_write", "helper_write"]) {
    assert.match(text, new RegExp(`${field}=[1-9]`), `${adapterName} denied ${field} inside its confined process`);
  }
  assert.match(text, /scratch_write=0/, `${adapterName} retains isolated writable scratch space`);
  await waitFor(`${adapterName} terminal completion event`, () => events.find((event) => event.type === "completed"))
    .catch((error) => {
      const observedTypes = events.map((event) => event.type).filter(Boolean).join(", ");
      throw new Error(`${error.message}; observed events=${observedTypes}; adapter=${logs}`);
    });
  assert.equal(sha256(await readFile(join(state.workspaceRoot, "source.txt"))), state.sourceHash, `${adapterName} left source bytes unchanged`);
  assert.equal(sha256(await readFile(join(state.workspaceRoot, ".git", "config"))), state.gitConfigHash, `${adapterName} left Git config unchanged`);
  assert.equal(sha256(await readFile(outsideFile)), state.outsideHash, `${adapterName} left a symlink target outside the workspace unchanged`);
  await assert.rejects(readFile(join(state.workspaceRoot, "helper-write.txt")), { code: "ENOENT" }, `${adapterName} helper process did not create a workspace file`);
}

async function runCrush(root) {
  const events = [];
  const state = await createWorkspace(root);
  const dispatchKey = "crush-read-only-integration";
  const runId = "crush-read-only-run";
  const workSessionId = "crush-read-only-session";
  const agentId = "agent-crush-integration";
  const control = await createControlPlane(agentId, events, { root, dispatchKey, runId, attemptNumber: 1 });
  const { wrapper, marker } = await createBubblewrapWrapper(root);
  const crushBin = join(root, "fake-crush");
  await writeFile(crushBin, `#!/bin/sh\nprintf '\\n__ARGS_START__\\n'\nprintf '<%s>\\n' "$@"\nprintf '__ARGS_END__\\n'\n${mutationProbeShell()}\nprintf '\\n__STDIN_START__\\n'\ncat\nprintf '\\n__STDIN_END__\\n'\nexit 0\n`);
  await chmod(crushBin, 0o700);
  const adapterPort = await freePort();
  const adapter = spawn(process.execPath, ["scripts/acp-crush-adapter.mjs"], {
    cwd: process.cwd(),
    env: adapterProcessEnvironment({
      KONTROL_ACP_URL: control.url,
      KONTROL_ACP_AGENT_SECRET: AGENT_SECRET,
      KONTROL_ACP_ADAPTER_SECRET: ADAPTER_SECRET,
      KONTROL_ACP_AGENT_STATE_FILE: join(root, "crush-agent-identity.json"),
      ACP_ADAPTER_REPLAY_STORE: join(root, "crush-replay.json"),
      KONTROL_CRUSH_DISPATCH_RECEIPTS: join(root, "crush-receipts.json"),
      KONTROL_CRUSH_OWNED_PROCESSES: join(root, "crush-owned.json"),
      ACP_ADAPTER_PORT: String(adapterPort),
      KONTROL_ALLOWED_ROOTS: state.workspaceRoot,
      KONTROL_BWRAP: wrapper,
      CRUSH_BIN: crushBin,
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  adapter.stdout.setEncoding("utf8");
  adapter.stderr.setEncoding("utf8");
  adapter.stdout.on("data", (chunk) => { logs += chunk; });
  adapter.stderr.on("data", (chunk) => { logs += chunk; });
  try {
    const baseUrl = `http://127.0.0.1:${adapterPort}`;
    await waitFor("CRUSH adapter health", async () => {
      try { return (await fetch(`${baseUrl}/health`)).ok; } catch { return false; }
    }, 10_000).catch((error) => { throw new Error(`${error.message}\n${logs}`); });
    const grant = createGrant({ workspaceRoot: state.workspaceRoot, agentId, runId, workSessionId, dispatchKey });
    const secretPromptValue = "KONTROL_PROMPT_SECRET_MUST_ONLY_APPEAR_ON_STDIN";
    const largePrompt = `${secretPromptValue}\n${Array.from({ length: 2048 }, (_, index) => `instruction-${String(index).padStart(4, "0")}: verify complete multiline delivery ${"payload-".repeat(4)}`).join("\n")}\nPROMPT_END_MARKER`;
    const body = makeReadOnlyBody({ workspaceRoot: state.workspaceRoot, agentId, runId, workSessionId, dispatchKey, grant, taskText: largePrompt });
    assert.equal("workspace_lease_nonce" in body, false, "CRUSH read-only dispatch does not require a mutation lease");
    const emptyTask = await requestJson(`${baseUrl}/runs`, { method: "POST", body: { ...body, input: [] } });
    assert.equal(emptyTask.response.status, 400, "CRUSH rejects an empty task before accepting dispatch");
    assert.equal(emptyTask.json.error?.code, "invalid_task");
    await assert.rejects(readFile(marker), { code: "ENOENT" }, "CRUSH does not start Bubblewrap for an empty task");
    const forged = await requestJson(`${baseUrl}/runs`, { method: "POST", body: { ...body, read_only_execution_grant: { ...grant, signature: "forged" } } });
    assert.equal(forged.response.status, 403, "CRUSH rejects a forged execution grant before sandbox or child launch");
    await assert.rejects(readFile(marker), { code: "ENOENT" }, "CRUSH does not invoke Bubblewrap for a forged grant");

    const result = await requestJson(`${baseUrl}/runs`, { method: "POST", body });
    assert.equal(result.response.status, 202, `${result.json.error?.message ?? "CRUSH read-only dispatch was not accepted"}\n${logs}`);
    assert.equal(result.json.accepted, true);
    assert.equal(result.json.dispatch_idempotency_key, dispatchKey);
    assert.ok(result.json.run_id);
    await assertConfinedResult({ adapterName: "CRUSH", state, accepted: result.json, events, outsideFile: state.outsideFile, logs });
    const completed = events.find((event) => event.type === "completed");
    const finalOutput = completed?.payload?.final_output;
    assert.equal(typeof finalOutput, "string", "CRUSH completion includes captured worker output, not only a successful spawn");
    assert.ok(finalOutput.includes(largePrompt), "the complete large multiline task reached the worker through stdin without truncation");
    const args = finalOutput.split("__ARGS_START__")[1]?.split("__ARGS_END__")[0] ?? "";
    assert.match(args, /Execute the complete task supplied on standard input\./, "CRUSH receives its required fixed positional instruction");
    assert.equal(args.includes(secretPromptValue), false, "sensitive task content is absent from process arguments");
    assert.equal(logs.includes(secretPromptValue), false, "sensitive task content is absent from routine adapter logs");
    await assertReceiptAcknowledged({ adapterName: "CRUSH", receiptsPath: join(root, "crush-receipts.json"), dispatchKey, remoteRunId: result.json.run_id, control });
    const lookup = await requestJson(`${baseUrl}/runs/by-dispatch-id/${encodeURIComponent(dispatchKey)}`);
    assert.equal(lookup.response.status, 200);
    assert.equal(lookup.json.run_id, result.json.run_id);
    assert.equal(lookup.json.execution_receipt?.grant_fingerprint, result.json.execution_receipt.grant_fingerprint,
      "CRUSH retains the same correlated execution receipt for dispatch recovery");
    assert.ok((await readFile(marker, "utf8")).trim().length > 0, "valid CRUSH execution exercised Bubblewrap");
    console.log("acp-readonly-adapters.integration: CRUSH dispatched and resisted confined mutation attempts");
  } finally {
    adapter.kill("SIGTERM");
    await Promise.race([new Promise((resolve) => adapter.once("exit", resolve)), new Promise((resolve) => setTimeout(resolve, 5_000))]);
    if (adapter.exitCode === null) adapter.kill("SIGKILL");
    await closeServer(control.server);
  }
}

async function runHermes(root) {
  const events = [];
  const state = await createWorkspace(root);
  const dispatchKey = "hermes-read-only-integration";
  const runId = "hermes-read-only-run";
  const continuationDispatchKey = "hermes-read-only-continuation-integration";
  const continuationRunId = "hermes-read-only-continuation-run";
  const workSessionId = "hermes-read-only-session";
  const agentId = "agent-hermes-integration";
  const control = await createControlPlane(agentId, events, [
    { root, dispatchKey, runId, attemptNumber: 1 },
    { root, dispatchKey: continuationDispatchKey, runId: continuationRunId, attemptNumber: 2 },
    { root, dispatchKey: "hermes-transfer-dispatch", runId: "hermes-transfer-run", attemptNumber: 3 },
    { root, dispatchKey: "hermes-transfer-continuation-dispatch", runId: "hermes-transfer-run", attemptNumber: 4 },
  ]);
  const { wrapper, marker } = await createBubblewrapWrapper(root);
  const hermesRoot = join(root, "hermes-runtime");
  const toolchainRoot = await mkdtemp(join(process.cwd(), ".tmp-kontrol-hermes-toolchain-"));
  const pythonRuntime = join(toolchainRoot, ".venv");
  const pythonBin = join(pythonRuntime, "bin", "python");
  const sitePackages = join(pythonRuntime, "lib", "python3.10", "site-packages");
  const fakeHermesBin = join(root, "fake-hermes");
  await mkdir(join(pythonRuntime, "bin"), { recursive: true });
  await mkdir(join(sitePackages, "acp"), { recursive: true });
  for (const packagePath of ["acp_adapter", "agent"]) {
    await mkdir(join(hermesRoot, packagePath), { recursive: true });
    await writeFile(join(hermesRoot, packagePath, "__init__.py"), "# integration fixture\n");
  }
  await writeFile(join(sitePackages, "acp", "__init__.py"), "# fixture SDK package\n");
  await writeFile(join(sitePackages, "acp", "meta.py"), "PROTOCOL_VERSION = '1.0'\n");
  await writeFile(join(sitePackages, "acp", "schema.py"), [
    "from types import SimpleNamespace",
    "class ClientCapabilities:",
    "    def __init__(self, fs=None): self.fs = fs",
    "class FileSystemCapabilities:",
    "    def __init__(self, write_text_file=False): self.write_text_file = write_text_file",
    "class Implementation:",
    "    def __init__(self, name, version): self.name, self.version = name, version",
    "class TextContentBlock:",
    "    def __init__(self, type, text): self.type, self.text = type, text",
    ""] .join("\n"));
  await writeFile(join(sitePackages, "acp", "core.py"), [
    "import os",
    "from pathlib import Path",
    "from types import SimpleNamespace",
    "class _Connection:",
    "    def __init__(self, client, output_stream): self.client, self.output_stream = client, output_stream",
    "    async def initialize(self, **_kwargs): return SimpleNamespace(agent_capabilities=SimpleNamespace(load_session=True))",
    "    async def new_session(self, **_kwargs):",
    "        home = Path(os.environ['HERMES_HOME'])",
    "        home.mkdir(parents=True, exist_ok=True)",
    "        (home / 'fixture-session-id').write_text('fixture-session')",
    "        return SimpleNamespace(session_id='fixture-session')",
    "    async def load_session(self, cwd, session_id, mcp_servers=None):",
    "        home = Path(os.environ['HERMES_HOME'])",
    "        stored = (home / 'fixture-session-id').read_text() if (home / 'fixture-session-id').exists() else ''",
    "        if stored != session_id: return None",
    "        (home / 'loaded-session-id').write_text(session_id)",
    "        return object()",
    "    async def prompt(self, **kwargs):",
    "        text = (await self.output_stream.read()).decode('utf-8', errors='replace')",
    "        prompt_blocks = kwargs.get('prompt') or []",
    "        prompt_text = '\\n'.join(getattr(block, 'text', '') for block in prompt_blocks)",
    "        home = Path(os.environ['HERMES_HOME'])",
    "        home.mkdir(parents=True, exist_ok=True)",
    "        (home / 'fixture-last-prompt').write_text(prompt_text)",
    "        await self.client.session_update('fixture-session', {'sessionUpdate': 'agent_message_chunk', 'content': {'text': text}})",
    "        return SimpleNamespace(stop_reason='end_turn', usage=None)",
    "    async def close(self): return None",
    "def connect_to_agent(client, output_stream, **_kwargs): return _Connection(client, output_stream)",
    ""] .join("\n"));
  await writeFile(join(hermesRoot, "acp_adapter", "entry.py"), "# public ACP server module fixture\n");
  await writeFile(join(hermesRoot, "acp_adapter", "server.py"), "# public ACP server module fixture\n");
  // The Hermes adapter consumes JSONL from its runner, so the fixture emits
  // protocol frames after performing the same confined process probes.
  await writeFile(pythonBin, `#!/bin/sh\nexport PYTHONPATH=${shellQuote(sitePackages)}:"$PYTHONPATH"\nexec /usr/bin/python3 "$@"\n`);
  await chmod(pythonBin, 0o700);
  await writeFile(fakeHermesBin, `#!/bin/sh\nif [ "$1" = acp ] && [ "$2" = --check ]; then exit 0; fi\nif [ "$1" = acp ]; then\n${mutationProbeShell()}\nexit 0\nfi\nexit 93\n`);
  await chmod(fakeHermesBin, 0o700);
  const adapterPort = await freePort();
  const adapter = spawn(process.execPath, ["scripts/acp-hermes-native-adapter.mjs"], {
    cwd: process.cwd(),
    env: adapterProcessEnvironment({
      KONTROL_ACP_URL: control.url,
      KONTROL_ACP_AGENT_SECRET: AGENT_SECRET,
      KONTROL_ACP_ADAPTER_SECRET: ADAPTER_SECRET,
      KONTROL_ACP_AGENT_STATE_FILE: join(root, "hermes-agent-identity.json"),
      KONTROL_HERMES_DISPATCH_RECEIPTS: join(root, "hermes-receipts.json"),
      KONTROL_HERMES_OWNED_PROCESSES: join(root, "hermes-owned.json"),
      KONTROL_HERMES_TERMINAL_SPOOL: join(root, "hermes-terminal-spool.json"),
      KONTROL_HERMES_EVENT_SPOOL: join(root, "hermes-event-spool.json"),
      KONTROL_HERMES_PROVIDER_SESSIONS: join(root, "hermes-provider-sessions.json"),
      KONTROL_HERMES_SESSION_HOME_ROOT: join(root, "hermes-session-homes"),
      HERMES_ACP_ADAPTER_PORT: String(adapterPort),
      HERMES_AGENT_ROOT: hermesRoot,
      HERMES_NATIVE_PYTHON: pythonBin,
      HERMES_BIN: fakeHermesBin,
      KONTROL_VERIFY_TOOLCHAIN_PATHS: pythonRuntime,
      KONTROL_BWRAP: wrapper,
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  adapter.stdout.setEncoding("utf8");
  adapter.stderr.setEncoding("utf8");
  adapter.stdout.on("data", (chunk) => { logs += chunk; });
  adapter.stderr.on("data", (chunk) => { logs += chunk; });
  try {
    const baseUrl = `http://127.0.0.1:${adapterPort}`;
    await waitFor("Hermes adapter health", async () => {
      try { return (await fetch(`${baseUrl}/health`)).ok; } catch { return false; }
    }, 12_000).catch((error) => { throw new Error(`${error.message}\n${logs}`); });
    const grant = createGrant({ workspaceRoot: state.workspaceRoot, agentId, runId, workSessionId, dispatchKey });
    const body = makeReadOnlyBody({ workspaceRoot: state.workspaceRoot, agentId, runId, workSessionId, dispatchKey, grant });
    assert.equal("workspace_lease_nonce" in body, false, "Hermes read-only dispatch does not require a mutation lease");
    const forged = await requestJson(`${baseUrl}/runs`, { method: "POST", body: { ...body, read_only_execution_grant: { ...grant, signature: "forged" } } });
    assert.equal(forged.response.status, 403, "Hermes rejects a forged execution grant before sandbox or child launch");
    await assert.rejects(readFile(marker), { code: "ENOENT" }, "Hermes does not invoke Bubblewrap for a forged grant");

    const result = await requestJson(`${baseUrl}/runs`, { method: "POST", body });
    assert.equal(result.response.status, 202, `${result.json.error?.message ?? "Hermes read-only dispatch was not accepted"}\n${logs}`);
    assert.equal(result.json.accepted, true);
    assert.equal(result.json.dispatch_idempotency_key, dispatchKey);
    assert.ok(result.json.run_id);
    await assertConfinedResult({ adapterName: "Hermes", state, accepted: result.json, events, outsideFile: state.outsideFile, logs });
    await assertReceiptAcknowledged({ adapterName: "Hermes", receiptsPath: join(root, "hermes-receipts.json"), dispatchKey, remoteRunId: result.json.run_id, control });
    const lookup = await requestJson(`${baseUrl}/runs/by-dispatch-id/${encodeURIComponent(dispatchKey)}`);
    assert.equal(lookup.response.status, 200);
    assert.equal(lookup.json.run_id, result.json.run_id);
    assert.equal(lookup.json.execution_receipt?.grant_fingerprint, result.json.execution_receipt.grant_fingerprint,
      "Hermes retains the same correlated execution receipt for dispatch recovery");
    assert.ok((await readFile(marker, "utf8")).trim().length > 0, "valid Hermes execution exercised Bubblewrap");

    const continuationGrant = createGrant({
      workspaceRoot: state.workspaceRoot,
      agentId,
      runId: continuationRunId,
      workSessionId,
      dispatchKey: continuationDispatchKey,
      attemptNumber: 2,
    });
    const continuationBody = makeReadOnlyBody({
      workspaceRoot: state.workspaceRoot,
      agentId,
      runId: continuationRunId,
      workSessionId,
      dispatchKey: continuationDispatchKey,
      grant: continuationGrant,
      taskText: "Continue in the existing Hermes conversation and confirm the session loaded.",
      attemptNumber: 2,
      continuationId: "continuation-2",
    });
    const continued = await requestJson(`${baseUrl}/runs`, { method: "POST", body: continuationBody });
    assert.equal(continued.response.status, 202, `${continued.json.error?.message ?? "Hermes continuation was not accepted"}\n${logs}`);
    assert.ok(continued.json.run_id);
    await waitFor("Hermes continuation completion", () => events.find((event) => event.type === "completed" && event.remote_run_id === continued.json.run_id));
    await assertReceiptAcknowledged({
      adapterName: "Hermes continuation",
      receiptsPath: join(root, "hermes-receipts.json"),
      dispatchKey: continuationDispatchKey,
      remoteRunId: continued.json.run_id,
      control,
    });
    const sessionHome = join(root, "hermes-session-homes", sha256(workSessionId));
    assert.equal(await readFile(join(sessionHome, "loaded-session-id"), "utf8"), "fixture-session",
      "the continuation loaded the same Hermes provider session from its persistent per-work-session home");

    const transferId = "hermes-cross-provider-transfer-1";
    const transferPacket = {
      version: 1,
      transferId,
      task: "Continue the CRUSH implementation without losing the original task.",
      taskSha256: sha256("Continue the CRUSH implementation without losing the original task."),
      checkpoint: { snapshotKind: "git", snapshotRef: "checkpoint-hermes-transfer", submissionId: "submission-transfer-1", reviewEpoch: 2 },
      latestReviewerFeedback: { verdict: "changes_requested", comments: "Preserve the checkpoint and add the missing edge case." },
      unresolvedRequirements: ["Add the missing edge case"],
    };
    const transferContext = {
      id: transferId,
      sha256: sha256(JSON.stringify(transferPacket)),
      packet: transferPacket,
      fresh: true,
    };
    const transferTask = `Continue from the imported CRUSH work.\n\nImmutable cross-agent context transfer (sha256 ${transferContext.sha256}):\n${JSON.stringify(transferPacket, null, 2)}`;
    const transferDispatchKey = "hermes-transfer-dispatch";
    const transferRunId = "hermes-transfer-run";
    const transferGrant = createGrant({
      workspaceRoot: state.workspaceRoot,
      agentId,
      runId: transferRunId,
      workSessionId,
      dispatchKey: transferDispatchKey,
      attemptNumber: 3,
    });
    const transferred = await requestJson(`${baseUrl}/runs`, {
      method: "POST",
      body: makeReadOnlyBody({
        workspaceRoot: state.workspaceRoot,
        agentId,
        runId: transferRunId,
        workSessionId,
        dispatchKey: transferDispatchKey,
        grant: transferGrant,
        taskText: transferTask,
        attemptNumber: 3,
        continuationId: "continuation-from-crush",
        contextTransfer: transferContext,
      }),
    });
    assert.equal(transferred.response.status, 202, `${transferred.json.error?.message ?? "Hermes rejected a valid fresh cross-provider transfer"}\n${logs}`);
    const transferTerminal = await waitFor("Hermes cross-provider transfer terminal event", () => events.find((event) =>
      ["completed", "failed", "cancelled"].includes(event.type) && event.remote_run_id === transferred.json.run_id))
      .catch((error) => { throw new Error(`${error.message}; events=${JSON.stringify(events)}; adapter=${logs}`); });
    assert.equal(transferTerminal.type, "completed", `Hermes cross-provider transfer failed: ${JSON.stringify(transferTerminal)}\n${logs}`);
    await assertReceiptAcknowledged({
      adapterName: "Hermes cross-provider transfer",
      receiptsPath: join(root, "hermes-receipts.json"),
      dispatchKey: transferDispatchKey,
      remoteRunId: transferred.json.run_id,
      control,
    });
    const transferSessionHome = join(root, "hermes-session-homes", sha256(`${workSessionId}:transfer:${transferId}`));
    assert.equal(await readFile(join(transferSessionHome, "fixture-last-prompt"), "utf8"), transferTask,
      "the Hermes ACP child receives the exact immutable transfer packet, checkpoint, and reviewer feedback");
    assert.equal(await readFile(join(transferSessionHome, "fixture-session-id"), "utf8"), "fixture-session",
      "cross-provider transfer created an isolated provider-native Hermes session");

    const transferContinuationKey = "hermes-transfer-continuation-dispatch";
    const transferContinuationGrant = createGrant({
      workspaceRoot: state.workspaceRoot,
      agentId,
      runId: transferRunId,
      workSessionId,
      dispatchKey: transferContinuationKey,
      attemptNumber: 4,
    });
    const transferContinuation = await requestJson(`${baseUrl}/runs`, {
      method: "POST",
      body: makeReadOnlyBody({
        workspaceRoot: state.workspaceRoot,
        agentId,
        runId: transferRunId,
        workSessionId,
        dispatchKey: transferContinuationKey,
        grant: transferContinuationGrant,
        taskText: "Continue the Hermes-owned transfer session after the next review round.",
        attemptNumber: 4,
        continuationId: "hermes-transfer-round-two",
        contextTransfer: { ...transferContext, fresh: false },
      }),
    });
    assert.equal(transferContinuation.response.status, 202, `${transferContinuation.json.error?.message ?? "Hermes transfer continuation was not accepted"}\n${logs}`);
    const transferContinuationTerminal = await waitFor("Hermes transfer continuation terminal event", () => events.find((event) =>
      ["completed", "failed", "cancelled"].includes(event.type) && event.remote_run_id === transferContinuation.json.run_id))
      .catch((error) => { throw new Error(`${error.message}; events=${JSON.stringify(events)}; adapter=${logs}`); });
    assert.equal(transferContinuationTerminal.type, "completed", `Hermes transfer continuation failed: ${JSON.stringify(transferContinuationTerminal)}\n${logs}`);
    assert.equal(await readFile(join(transferSessionHome, "loaded-session-id"), "utf8"), "fixture-session",
      "the cross-provider continuation restored the transfer-scoped Hermes conversation");

    const transferReplayKey = "hermes-transfer-replay-dispatch";
    const replayGrant = createGrant({
      workspaceRoot: state.workspaceRoot,
      agentId,
      runId: transferRunId,
      workSessionId,
      dispatchKey: transferReplayKey,
      attemptNumber: 5,
    });
    const replayTransfer = await requestJson(`${baseUrl}/runs`, {
      method: "POST",
      body: makeReadOnlyBody({
        workspaceRoot: state.workspaceRoot,
        agentId,
        runId: transferRunId,
        workSessionId,
        dispatchKey: transferReplayKey,
        grant: replayGrant,
        taskText: transferTask,
        attemptNumber: 5,
        continuationId: "duplicate-fresh-transfer",
        contextTransfer: transferContext,
      }),
    });
    assert.equal(replayTransfer.response.status, 409, "an already-started immutable transfer cannot be replayed as fresh");
    assert.equal(replayTransfer.json.error?.code, "context_transfer_already_started");
    console.log("acp-readonly-adapters.integration: Hermes dispatched and resisted confined mutation attempts");
  } finally {
    adapter.kill("SIGTERM");
    await Promise.race([new Promise((resolve) => adapter.once("exit", resolve)), new Promise((resolve) => setTimeout(resolve, 5_000))]);
    if (adapter.exitCode === null) adapter.kill("SIGKILL");
    await closeServer(control.server);
    await rm(toolchainRoot, { recursive: true, force: true });
  }
}

if (process.platform !== "linux") {
  assert.throws(
    () => findBubblewrap(),
    (error) => error?.code === "sandbox_unavailable",
    "non-Linux hosts fail closed instead of claiming to run the Linux-only confined adapter integration",
  );
  console.log("acp-readonly-adapters.integration: unsupported platform fails closed; execution integration is Linux-only");
} else {
  const root = await mkdtemp(join(tmpdir(), "kontrol-readonly-adapters-"));
  try {
    await mkdir(join(root, "crush"), { recursive: true });
    await runCrush(join(root, "crush"));
    await mkdir(join(root, "hermes"), { recursive: true });
    await runHermes(join(root, "hermes"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
