export const READ_ONLY_EXECUTION_ISSUER: "kontrol";
export const READ_ONLY_EXECUTION_OPERATIONS: readonly ["workspace.read", "workspace.search", "execution.report"];
export const READ_ONLY_EXECUTION_MAX_TTL_MS: number;

export type ReadOnlyExecutionGrant = {
  version: 1;
  issuer: "kontrol";
  workSessionId: string;
  workspaceSessionId: string;
  workspaceRoot: string;
  agentId: string;
  runId: string;
  attemptNumber: number;
  dispatchIdempotencyKey: string;
  operations: readonly string[];
  issuedAt: number;
  expiresAt: number;
  signature: string;
};

export function createReadOnlyExecutionGrant(
  input: Omit<ReadOnlyExecutionGrant, "version" | "issuer" | "operations" | "issuedAt" | "expiresAt" | "signature"> & { ttlMs?: number },
  secret: string | undefined,
  now?: number,
): ReadOnlyExecutionGrant;
export function verifyReadOnlyExecutionGrant(
  grant: unknown,
  secret: string | undefined,
  expected?: Record<string, unknown>,
  now?: number,
): grant is ReadOnlyExecutionGrant;
export function validateReadOnlyDispatchRequest(
  body: Record<string, unknown>,
  canonicalWorkspaceRoot: string,
  secret: string | undefined,
): { readOnly: boolean; valid?: boolean; code?: string; grant?: ReadOnlyExecutionGrant };
export class ReadOnlySandboxUnavailableError extends Error { code: "sandbox_unavailable"; }
export function findBubblewrap(configuredPath?: string): string;
export function probeBubblewrap(configuredPath?: string): string;
export function buildReadOnlySandboxCommand(input: {
  workspaceRoot: string;
  executable: string;
  executableTarget?: string;
  args?: string[];
  env?: Record<string, string>;
  toolchainPaths?: string | string[];
  bindMounts?: Array<{ source: string; target: string }>;
  bubblewrapPath?: string;
}): { command: string; args: string[]; env: Record<string, string> };
export function probeReadOnlyExecutionSandbox(input: {
  workspaceRoot: string;
  toolchainPaths?: string | string[];
  bindMounts?: Array<{ source: string; target: string }>;
  bubblewrapPath?: string;
}): boolean;
export function readOnlyWorkerEnvironment(source?: NodeJS.ProcessEnv): Record<string, string>;
export function resolveExecutablePath(executable: string, pathValue?: string): string | undefined;
