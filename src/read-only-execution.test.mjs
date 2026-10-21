import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  buildReadOnlySandboxCommand,
  createReadOnlyExecutionGrant,
  readOnlyWorkerEnvironment,
  resolveExecutablePath,
  validateReadOnlyDispatchRequest,
  verifyReadOnlyExecutionGrant,
} from "./read-only-execution.mjs";

const root = mkdtempSync(join(tmpdir(), "kontrol-read-only-execution-"));
try {
  const workspaceRoot = join(root, "workspace");
  const binDir = join(root, "bin");
  mkdirSync(workspaceRoot);
  mkdirSync(binDir);
  const executable = join(binDir, "test-agent");
  const bubblewrap = join(binDir, "bwrap");
  writeFileSync(executable, "#!/bin/sh\nexit 0\n");
  writeFileSync(bubblewrap, "#!/bin/sh\nexit 0\n");
  chmodSync(executable, 0o700);
  chmodSync(bubblewrap, 0o700);

  const secret = "test-adapter-secret";
  const now = Date.now();
  const claims = {
    workSessionId: "work-1",
    workspaceSessionId: "workspace-1",
    workspaceRoot,
    agentId: "agent-1",
    runId: "run-1",
    attemptNumber: 2,
    dispatchIdempotencyKey: "dispatch-2",
    ttlMs: 60_000,
  };
  const grant = createReadOnlyExecutionGrant(claims, secret, now);
  assert.equal(grant.networkPolicy, "disabled", "network access is disabled in newly issued grants by default");
  const expectedClaims = {
    workSessionId: claims.workSessionId,
    workspaceSessionId: claims.workspaceSessionId,
    workspaceRoot: claims.workspaceRoot,
    agentId: claims.agentId,
    runId: claims.runId,
    attemptNumber: claims.attemptNumber,
    dispatchIdempotencyKey: claims.dispatchIdempotencyKey,
  };
  assert.equal(verifyReadOnlyExecutionGrant(grant, secret, expectedClaims, now + 1), true);
  assert.equal(verifyReadOnlyExecutionGrant({ ...grant, workspaceRoot: root }, secret, expectedClaims, now + 1), false);
  assert.equal(verifyReadOnlyExecutionGrant(grant, secret, expectedClaims, now + 60_000), false, "expired grants are rejected");

  const request = {
    session_id: claims.workSessionId,
    workspace_session_id: claims.workspaceSessionId,
    workspace_root: workspaceRoot,
    agent_id: claims.agentId,
    parent_run_id: claims.runId,
    attempt_number: claims.attemptNumber,
    dispatch_idempotency_key: claims.dispatchIdempotencyKey,
    scheduled_execution_policy: { executionMode: "read_only_audit", workspaceAccess: "read_only", mutate: false },
    read_only_execution_grant: grant,
  };
  assert.equal(validateReadOnlyDispatchRequest(request, workspaceRoot, secret, "agent-1").valid, true);
  assert.equal(validateReadOnlyDispatchRequest(request, workspaceRoot, secret, "another-agent").valid, false,
    "a signed grant cannot be replayed to a different locally registered adapter");
  assert.equal(validateReadOnlyDispatchRequest(request, workspaceRoot, secret).valid, false,
    "read-only adapters fail closed when their registered identity is unavailable");
  assert.equal(validateReadOnlyDispatchRequest({ ...request, read_only_execution_grant: { ...grant, signature: "forged" } }, workspaceRoot, secret, "agent-1").valid, false);
  assert.equal(validateReadOnlyDispatchRequest({ ...request, scheduled_execution_policy: { ...request.scheduled_execution_policy, mutate: true } }, workspaceRoot, secret, "agent-1").valid, false);
  assert.equal(validateReadOnlyDispatchRequest({ workspace_root: workspaceRoot }, workspaceRoot, secret).readOnly, false);

  const env = readOnlyWorkerEnvironment({
    OPENAI_API_KEY: "explicit-provider-secret",
    KONTROL_READ_ONLY_AGENT_ENV_ALLOWLIST: "OPENAI_API_KEY",
    KONTROL_ADAPTER_SECRET: "must-not-pass",
    PATH: "/sensitive/host/path",
  });
  assert.deepEqual(env, { OPENAI_API_KEY: "explicit-provider-secret" }, "read-only children receive only explicitly named provider environment values");
  assert.deepEqual(readOnlyWorkerEnvironment({
    TEST_TOOLCHAIN_LABEL: "approved-toolchain",
    KONTROL_CHILD_ENV_ALLOWLIST: "TEST_TOOLCHAIN_LABEL",
  }), { TEST_TOOLCHAIN_LABEL: "approved-toolchain" }, "the project child-environment allowlist also applies to confined adapters");
  assert.throws(() => readOnlyWorkerEnvironment({
    BAD_TOKEN: "x",
    KONTROL_READ_ONLY_AGENT_ENV_ALLOWLIST: "BAD_TOKEN",
  }), /Unsafe read-only child environment name/);

  const resolvedExecutable = resolveExecutablePath("test-agent", binDir);
  assert.equal(resolvedExecutable, executable);
  assert.equal(resolveExecutablePath("missing-agent", delimiter), undefined);
  const launch = buildReadOnlySandboxCommand({
    workspaceRoot,
    executable,
    args: ["--stdio"],
    env,
    toolchainPaths: [],
    bubblewrapPath: bubblewrap,
  });
  assert.equal(launch.command, bubblewrap);
  assert.deepEqual(launch.env, {});
  assert.ok(launch.args.includes("--unshare-all"), "network and other namespaces are isolated");
  assert.ok(launch.args.includes("--clearenv"), "ambient adapter environment is cleared");
  assert.ok(launch.args.includes(workspaceRoot));
  assert.ok(launch.args.includes("/workspace"), "the checkout is mounted at a stable read-only path");
  assert.ok(launch.args.includes(executable), "the selected executable is mounted individually");
  assert.ok(!launch.args.includes(binDir), "the executable's neighboring files are not exposed as a directory");
  assert.ok(!launch.args.includes("--bind"), "all workspace/toolchain binds are read-only");
  assert.equal(launch.args.at(-2), "/opt/kontrol/bin/test-agent");
  assert.equal(launch.args.at(-1), "--stdio");
  const hostNetworkGrant = createReadOnlyExecutionGrant({ ...claims, networkPolicy: "host" }, secret, now);
  assert.equal(verifyReadOnlyExecutionGrant(hostNetworkGrant, secret, { ...expectedClaims, networkPolicy: "host" }, now + 1), true,
    "the network policy is covered by the grant signature");
  assert.equal(verifyReadOnlyExecutionGrant(hostNetworkGrant, secret, { ...expectedClaims, networkPolicy: "disabled" }, now + 1), false,
    "a signed host-network grant cannot be downgraded or substituted");
  const hostNetworkLaunch = buildReadOnlySandboxCommand({ workspaceRoot, executable, networkPolicy: "host", bubblewrapPath: bubblewrap });
  assert.ok(hostNetworkLaunch.args.includes("--unshare-all") && hostNetworkLaunch.args.includes("--share-net"),
    "host networking is an explicit opt-in while the other bubblewrap namespaces remain isolated");

  const configuredRuntime = buildReadOnlySandboxCommand({
    workspaceRoot,
    executable,
    toolchainPaths: ["/usr"],
    bubblewrapPath: bubblewrap,
  });
  assert.ok(configuredRuntime.args.some((value, index) => value === "--ro-bind" && configuredRuntime.args[index + 1] === "/usr"),
    "explicitly approved runtime directories are mounted read-only without a builder ReferenceError");

  const hermesSessionHome = join(root, "hermes-session-home");
  mkdirSync(hermesSessionHome);
  const hermesSessionLaunch = buildReadOnlySandboxCommand({
    workspaceRoot,
    executable,
    writableBindMounts: [{ source: hermesSessionHome, target: "/opt/kontrol/hermes-session" }],
    bubblewrapPath: bubblewrap,
  });
  assert.ok(hermesSessionLaunch.args.some((value, index) => value === "--bind"
    && hermesSessionLaunch.args[index + 1] === hermesSessionHome
    && hermesSessionLaunch.args[index + 2] === "/opt/kontrol/hermes-session"),
  "an explicitly selected provider-session directory can persist outside the read-only checkout");
  assert.throws(() => buildReadOnlySandboxCommand({
    workspaceRoot,
    executable,
    writableBindMounts: [{ source: hermesSessionHome, target: "/workspace/session-state" }],
    bubblewrapPath: bubblewrap,
  }), /outside the workspace and scratch directory/);

  const hermesCli = join(root, "hermes-cli");
  const adjacentCredential = join(root, "credential.json");
  writeFileSync(hermesCli, "#!/bin/sh\nexit 0\n");
  writeFileSync(adjacentCredential, "secret\n");
  const hermesLaunch = buildReadOnlySandboxCommand({
    workspaceRoot,
    executable,
    bindFiles: [{ source: hermesCli, target: "/opt/kontrol/hermes-bin/hermes" }],
    bubblewrapPath: bubblewrap,
  });
  assert.ok(hermesLaunch.args.some((value, index) => value === "--ro-bind" && hermesLaunch.args[index + 1] === hermesCli && hermesLaunch.args[index + 2] === "/opt/kontrol/hermes-bin/hermes"),
    "a selected adapter executable can be mounted as one read-only file");
  assert.ok(!hermesLaunch.args.includes(adjacentCredential), "individual executable binds do not expose neighboring credentials");
  assert.throws(() => buildReadOnlySandboxCommand({
    workspaceRoot,
    executable,
    bindFiles: [{ source: hermesCli, target: "/workspace/escape" }],
    bubblewrapPath: bubblewrap,
  }), /outside the workspace and scratch directory/);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("read-only-execution.test.mjs: all assertions passed");
