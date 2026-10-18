import assert from "node:assert/strict";
import {
  canonicalAllowedOutputs,
  createBoundedFileWriteGrant,
  validateBoundedFileWriteDispatchRequest,
  verifyBoundedFileWriteGrant,
} from "./bounded-file-write.mjs";

const secret = "test-adapter-secret";
const now = Date.now();
const allowedOutputs = [{
  path: "Hello World.txt",
  operation: "create",
  expectedSha256: "a".repeat(64),
  overwrite: "deny",
}];
const claims = {
  workSessionId: "work-1",
  workspaceSessionId: "workspace-1",
  workspaceRoot: "/tmp/workspace",
  agentId: "agent-1",
  runId: "run-1",
  attemptNumber: 2,
  dispatchIdempotencyKey: "dispatch-2",
  allowedOutputs,
  ttlMs: 60_000,
};
const grant = createBoundedFileWriteGrant(claims, secret, now);
assert.equal(grant.issuer, "kontrol");
const canonicalOutputs = canonicalAllowedOutputs(allowedOutputs);
assert.ok(canonicalOutputs, "valid exact-path outputs are accepted");
const canonicalClaims = { ...claims, allowedOutputs: canonicalOutputs };
delete canonicalClaims.ttlMs;
assert.equal(verifyBoundedFileWriteGrant(grant, secret, {
  ...canonicalClaims,
}, now + 1), true);
assert.equal(verifyBoundedFileWriteGrant({ ...grant, signature: grant.signature.slice(0, -1) + (grant.signature.at(-1) === "0" ? "1" : "0") }, secret, { ...claims, allowedOutputs }, now + 1), false);
assert.equal(verifyBoundedFileWriteGrant(grant, secret, {
  ...claims,
  allowedOutputs: [{ ...canonicalOutputs?.[0], expectedSha256: "b".repeat(64) }],
}, now + 1), false);
assert.equal(canonicalAllowedOutputs([{ ...allowedOutputs[0], path: "../escape" }]), undefined);
assert.equal(canonicalAllowedOutputs([{ ...allowedOutputs[0], path: "/escape" }]), undefined);
assert.equal(canonicalAllowedOutputs([{ ...allowedOutputs[0], overwrite: "deny", expectedPreviousSha256: "c".repeat(64) }]), undefined);

const body = {
  session_id: claims.workSessionId,
  workspace_session_id: claims.workspaceSessionId,
  workspace_root: claims.workspaceRoot,
  agent_id: claims.agentId,
  parent_run_id: claims.runId,
  attempt_number: claims.attemptNumber,
  dispatch_idempotency_key: claims.dispatchIdempotencyKey,
  scheduled_execution_policy: {
    executionMode: "bounded_file_write",
    workspaceAccess: "staged_write",
    mutate: true,
    allowedOutputs,
  },
  bounded_file_write_grant: grant,
};
assert.equal(validateBoundedFileWriteDispatchRequest(body, secret, "agent-1").valid, true);
assert.equal(validateBoundedFileWriteDispatchRequest(body, secret, "other-agent").valid, false);
assert.equal(validateBoundedFileWriteDispatchRequest({
  ...body,
  scheduled_execution_policy: {
    ...body.scheduled_execution_policy,
    allowedOutputs: [{ ...allowedOutputs[0], path: "../escape" }],
  },
}, secret, "agent-1").valid, false);
assert.equal(validateBoundedFileWriteDispatchRequest({ ...body, bounded_file_write_grant: { ...grant, signature: "forged" } }, secret, "agent-1").valid, false);
assert.equal(validateBoundedFileWriteDispatchRequest({
  ...body,
  scheduled_execution_policy: {
    ...body.scheduled_execution_policy,
    executionMode: "read_only_audit",
  },
}, secret, "agent-1").boundedWrite, false);
console.log("bounded-file-write.test.mjs: grant policy, identity binding, and path policy assertions passed");
