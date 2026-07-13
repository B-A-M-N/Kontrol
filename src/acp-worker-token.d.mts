// Type declarations for the plain-JS worker-token module (src/acp-worker-token.mjs).
export interface WorkerTokenClaims {
  role: "worker";
  workSessionId: string;
  workspaceSessionId: string;
  runId?: string;
  continuationId?: string;
  exp: number;
}

export const TOKEN_TTL_MS: number;

export function signWorkerToken(claims: WorkerTokenClaims, secret: string): string;

export class WorkerTokenError extends Error {}

export function verifyWorkerToken(token: string, secret: string): WorkerTokenClaims;
