import { createHmac, timingSafeEqual } from "node:crypto";
import { isAbsolute } from "node:path";

export const BOUNDED_FILE_WRITE_ISSUER = "kontrol";
export const BOUNDED_FILE_WRITE_OPERATIONS = Object.freeze(["workspace.read", "workspace.search", "staged_file_write", "execution.report"]);
export const BOUNDED_FILE_WRITE_MAX_TTL_MS = 24 * 60 * 60 * 1000;

const GRANT_VERSION = 1;
const GRANT_FIELDS = Object.freeze([
  "version",
  "issuer",
  "workSessionId",
  "workspaceSessionId",
  "workspaceRoot",
  "agentId",
  "runId",
  "attemptNumber",
  "dispatchIdempotencyKey",
  "allowedOutputs",
  "issuedAt",
  "expiresAt",
]);

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function grantPayload(grant) {
  return Object.fromEntries(GRANT_FIELDS.map((field) => [field, grant[field]]));
}

function signatureFor(payload, secret) {
  return createHmac("sha256", secret).update(stableJson(payload)).digest("hex");
}

function nonempty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function canonicalAllowedOutputs(outputs) {
  if (!Array.isArray(outputs) || outputs.length === 0 || outputs.length > 8) return undefined;
  const canonical = [];
  for (const output of outputs) {
    if (!output || typeof output !== "object" || Array.isArray(output)) return undefined;
    if (!nonempty(output.path) || isAbsolute(output.path) || output.path.includes("..")) return undefined;
    if (output.path.includes("\\")) return undefined;
    if (output.operation !== "create" && output.operation !== "replace") return undefined;
    if (output.overwrite !== "deny" && output.overwrite !== "expected_hash") return undefined;
    if ((output.expectedSha256 !== undefined && !/^[a-f0-9]{64}$/.test(output.expectedSha256))
      || (output.expectedPreviousSha256 !== undefined && !/^[a-f0-9]{64}$/.test(output.expectedPreviousSha256))) return undefined;
    if ((output.overwrite === "expected_hash" && !output.expectedPreviousSha256)
      || (output.overwrite === "deny" && output.expectedPreviousSha256 !== undefined)) return undefined;
    canonical.push({
      path: output.path,
      operation: output.operation,
      ...(output.expectedSha256 === undefined ? {} : { expectedSha256: output.expectedSha256 }),
      overwrite: output.overwrite,
      ...(output.expectedPreviousSha256 === undefined ? {} : { expectedPreviousSha256: output.expectedPreviousSha256 }),
    });
  }
  return canonical;
}

export function createBoundedFileWriteGrant(input, secret, now = Date.now()) {
  if (!nonempty(secret)) throw new Error("bounded_file_write_grant_issuer_unavailable");
  const ttlMs = Math.max(1, Math.min(Number(input.ttlMs) || 60 * 60 * 1000, BOUNDED_FILE_WRITE_MAX_TTL_MS));
  const allowedOutputs = canonicalAllowedOutputs(input.allowedOutputs);
  if (!allowedOutputs) throw new Error("bounded_file_write_grant_claims_invalid");
  const payload = {
    version: GRANT_VERSION,
    issuer: BOUNDED_FILE_WRITE_ISSUER,
    workSessionId: input.workSessionId,
    workspaceSessionId: input.workspaceSessionId,
    workspaceRoot: input.workspaceRoot,
    agentId: input.agentId,
    runId: input.runId,
    attemptNumber: input.attemptNumber,
    dispatchIdempotencyKey: input.dispatchIdempotencyKey,
    allowedOutputs,
    issuedAt: now,
    expiresAt: now + ttlMs,
  };
  if (
    !nonempty(payload.workSessionId)
    || !nonempty(payload.workspaceSessionId)
    || !isAbsolute(payload.workspaceRoot)
    || !nonempty(payload.agentId)
    || !nonempty(payload.runId)
    || !Number.isSafeInteger(payload.attemptNumber)
    || payload.attemptNumber < 1
    || !nonempty(payload.dispatchIdempotencyKey)
  ) throw new Error("bounded_file_write_grant_claims_invalid");
  return { ...payload, signature: signatureFor(payload, secret) };
}

export function verifyBoundedFileWriteGrant(grant, secret, expected, now = Date.now()) {
  if (!grant || typeof grant !== "object" || !nonempty(secret) || typeof grant.signature !== "string") return false;
  if (GRANT_FIELDS.some((field) => !(field in grant))) return false;
  if (Object.keys(grant).some((field) => field !== "signature" && !GRANT_FIELDS.includes(field))) return false;
  if (grant.version !== GRANT_VERSION || grant.issuer !== BOUNDED_FILE_WRITE_ISSUER) return false;
  if (!Array.isArray(grant.allowedOutputs) || stableJson(grant.allowedOutputs) !== stableJson(canonicalAllowedOutputs(grant.allowedOutputs))) return false;
  if (!Number.isSafeInteger(grant.issuedAt) || !Number.isSafeInteger(grant.expiresAt)) return false;
  if (grant.issuedAt > now + 30_000 || grant.expiresAt <= now || grant.expiresAt <= grant.issuedAt) return false;
  if (grant.expiresAt - grant.issuedAt > BOUNDED_FILE_WRITE_MAX_TTL_MS) return false;
  const payload = grantPayload(grant);
  const expectedSignature = Buffer.from(signatureFor(payload, secret), "hex");
  const actualSignature = Buffer.from(grant.signature, "hex");
  if (expectedSignature.length !== actualSignature.length || !timingSafeEqual(expectedSignature, actualSignature)) return false;
  for (const [key, value] of Object.entries(expected ?? {})) {
    if (key === "allowedOutputs") {
      if (stableJson(grant.allowedOutputs) !== stableJson(value)) return false;
      continue;
    }
    if (grant[key] !== value) return false;
  }
  return true;
}

export function validateBoundedFileWriteDispatchRequest(body, secret, adapterAgentId) {
  const policy = body?.scheduled_execution_policy;
  const grant = body?.bounded_file_write_grant;
  if (policy?.executionMode !== "bounded_file_write") return { boundedWrite: false };
  if (
    policy?.workspaceAccess !== "staged_write"
    || policy?.mutate !== true
    || !Array.isArray(policy?.allowedOutputs) || policy.allowedOutputs.length === 0
    || !body?.session_id
    || !body?.workspace_session_id
    || !body?.agent_id
    || !(body?.parent_run_id || body?.run_id)
    || !Number.isSafeInteger(body?.attempt_number)
    || body.attempt_number < 1
    || !body?.dispatch_idempotency_key
    || !nonempty(adapterAgentId)
    || body.agent_id !== adapterAgentId
  ) return { boundedWrite: true, valid: false, code: "bounded_file_write_grant_invalid" };
  const allowedOutputs = canonicalAllowedOutputs(policy.allowedOutputs);
  const valid = allowedOutputs && verifyBoundedFileWriteGrant(grant, secret, {
    workSessionId: body.session_id,
    workspaceSessionId: body.workspace_session_id,
    agentId: body.agent_id,
    runId: body.parent_run_id || body.run_id,
    attemptNumber: body.attempt_number,
    dispatchIdempotencyKey: body.dispatch_idempotency_key,
    allowedOutputs,
  });
  return valid
    ? { boundedWrite: true, valid: true, grant }
    : { boundedWrite: true, valid: false, code: "bounded_file_write_grant_invalid" };
}
