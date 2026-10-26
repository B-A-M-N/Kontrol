import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { verifyWorkerToken } from "./acp-worker-token.mjs";
import { createAgentPtyReviewCredential, removeStaleAgentPtyReviewCredentials } from "./agent-pty-review-credential.js";

const stateDir = mkdtempSync(join(tmpdir(), "kontrol-pty-review-credential-"));
try {
  const binding = {
    id: "pty_binding_1",
    processSessionId: "proc_1",
    workspaceSessionId: "workspace_1",
    workSessionId: "work_1",
    runId: "run_1",
    agentName: "fixture-agent",
    ownerPrincipalId: "worker-work-session:work_1",
    processGeneration: 3,
    outputCursor: 0,
    status: "attached" as const,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const secret = "pty-credential-test-secret";
  const credential = createAgentPtyReviewCredential({
    stateDir,
    host: "0.0.0.0",
    port: 7676,
    secret,
    binding,
    workspaceLeaseNonce: "lease_1",
  });
  try {
    assert.equal(existsSync(credential.credentialFilePath), true);
    assert.equal(statSync(credential.credentialFilePath).mode & 0o777, 0o600);
    assert.equal(statSync(dirname(credential.credentialFilePath)).mode & 0o777, 0o700);
    const payload = JSON.parse(readFileSync(credential.credentialFilePath, "utf8")) as {
      mcpUrl: string;
      token: string;
      workSessionId: string;
    };
    assert.equal(payload.mcpUrl, "http://127.0.0.1:7676/mcp");
    assert.equal(payload.workSessionId, binding.workSessionId);
    const claims = verifyWorkerToken(payload.token, secret);
    assert.equal(claims.workspaceLeaseNonce, "lease_1");
    assert.deepEqual(claims.agentPtyReview, {
      bindingId: binding.id,
      processSessionId: binding.processSessionId,
      processGeneration: binding.processGeneration,
    });
  } finally {
    credential.cleanup();
  }
  assert.equal(existsSync(credential.credentialFilePath), false, "process cleanup removes the private credential directory");

  const stale = join(stateDir, "agent-pty-review-stale");
  mkdirSync(stale, { mode: 0o700 });
  writeFileSync(join(stale, "credential.json"), "stale", { mode: 0o600 });
  assert.equal(removeStaleAgentPtyReviewCredentials(stateDir), 1);
  assert.equal(existsSync(stale), false, "startup recovery removes credentials left by a crashed server");
} finally {
  rmSync(stateDir, { recursive: true, force: true });
}

console.log("agent-pty-review-credential.test.ts: all assertions passed");
