export const BOUNDED_FILE_WRITE_ISSUER: "kontrol";
export const BOUNDED_FILE_WRITE_OPERATIONS: readonly ["workspace.read", "workspace.search", "staged_file_write", "execution.report"];
export const BOUNDED_FILE_WRITE_MAX_TTL_MS: number;

export type BoundedFileWriteOutput = {
  path: string;
  operation: "create" | "replace";
  expectedSha256?: string;
  overwrite: "deny" | "expected_hash";
  expectedPreviousSha256?: string;
};

export type BoundedFileWriteGrant = {
  version: 1;
  issuer: "kontrol";
  workSessionId: string;
  workspaceSessionId: string;
  workspaceRoot: string;
  agentId: string;
  runId: string;
  attemptNumber: number;
  dispatchIdempotencyKey: string;
  allowedOutputs: readonly BoundedFileWriteOutput[];
  issuedAt: number;
  expiresAt: number;
  signature: string;
};

export function canonicalAllowedOutputs(outputs: unknown): BoundedFileWriteOutput[] | undefined;
export function createBoundedFileWriteGrant(
  input: Omit<BoundedFileWriteGrant, "version" | "issuer" | "issuedAt" | "expiresAt" | "signature" | "allowedOutputs">
    & { allowedOutputs: unknown; ttlMs?: number },
  secret: string | undefined,
  now?: number,
): BoundedFileWriteGrant;
export function verifyBoundedFileWriteGrant(
  grant: unknown,
  secret: string | undefined,
  expected?: Record<string, unknown>,
  now?: number,
): grant is BoundedFileWriteGrant;
export function validateBoundedFileWriteDispatchRequest(
  body: Record<string, unknown>,
  secret: string | undefined,
  adapterAgentId?: string,
): { boundedWrite: boolean; valid?: boolean; code?: string; grant?: BoundedFileWriteGrant };
