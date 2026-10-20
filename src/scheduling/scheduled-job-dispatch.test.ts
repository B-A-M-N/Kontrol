import assert from "node:assert/strict";
import { createServer } from "node:http";
import { dispatchScheduledJob } from "./scheduled-job-dispatch.js";

const server = createServer((request, response) => {
  if (request.url !== "/health") {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify({
    ready: true,
    executionCapabilities: {
      read_only_audit: {
        supported: true,
        grantPolicy: "kontrol_signed_attempt_bound",
        confinementAvailable: false,
        executableAvailable: true,
        cliInputContract: "hermes_public_acp_v1_session_prompt",
        networkPolicies: ["disabled", "host"],
      },
    },
  }));
});

await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});

try {
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const agent = {
    id: "agent-hermes",
    name: "hermes-agent",
    url: `http://127.0.0.1:${address.port}`,
    role: "agent",
    capabilities: ["scheduled:read_only_audit"],
  };
  let sessionCreations = 0;
  const config = {
    workspaces: { getWorkspace: () => ({ root: "/tmp/scheduled-preflight" }) },
    agentRegistry: { listAlive: () => [agent] },
    adapterSecret: undefined,
    workSessions: {
      create: () => { sessionCreations += 1; return { id: "must-not-start" }; },
      updateStatus: () => undefined,
    },
    serverConfig: { readOnlyExecutionNetworkPolicy: "disabled" },
  } as any;
  const job = {
    id: "scheduled-preflight",
    projectId: "project-preflight",
    workspaceRoot: "/tmp/scheduled-preflight",
    agentName: "hermes-agent",
    executionMode: "read_only_audit",
    instructionJson: { instructions: "Audit safely." },
    ownerContextId: "owner-preflight",
    principalId: "principal-preflight",
    maxRuntimeMs: 60_000,
  } as any;

  const incompatible = await dispatchScheduledJob(config, {} as any, { ...job, executionMode: "bounded_file_write" });
  assert.equal(incompatible.status, "blocked");
  assert.equal(incompatible.blockerKind, "permanent_configuration");
  assert.equal(incompatible.failureClass, "execution_mode_unsupported");
  assert.equal(sessionCreations, 0, "an adapter without the exact mode capability is rejected before work-session creation");

  const unavailableSandbox = await dispatchScheduledJob(config, {} as any, job);
  assert.equal(unavailableSandbox.status, "blocked");
  assert.equal(unavailableSandbox.blockerKind, "permanent_configuration");
  assert.equal(unavailableSandbox.failureClass, "execution_mode_preflight_failed");
  assert.equal(unavailableSandbox.probeResult?.selectedAgent, "hermes-agent");
  assert.match(unavailableSandbox.reason ?? "", /bubblewrap\/prlimit confinement is unavailable/);
  assert.equal(sessionCreations, 0, "a sandbox failure is classified before any scheduled worker can start");
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

console.log("scheduled-job-dispatch.test.ts: all assertions passed");
