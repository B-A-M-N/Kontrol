import { chmodSync, lstatSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { signWorkerToken, TOKEN_TTL_MS, verifyWorkerTokenSignature, type WorkerTokenClaims } from "./acp-worker-token.mjs";
import type { AgentPtyBinding } from "./agent-pty-bindings.js";
import type { AgentPtyBindingStore } from "./agent-pty-bindings.js";
import type { AgentRegistryManager } from "./acp-registry.js";
import type { ProcessSessionManager } from "./process-sessions.js";
import type { WorkSessionManager } from "./work-sessions.js";

const CREDENTIAL_DIRECTORY_PREFIX = "agent-pty-review-";

export function createAgentPtyReviewToken(input: {
  secret: string;
  binding: AgentPtyBinding;
  workspaceLeaseNonce: string;
}): string {
  return signWorkerToken({
    role: "worker",
    workSessionId: input.binding.workSessionId,
    workspaceSessionId: input.binding.workspaceSessionId,
    runId: input.binding.runId,
    workspaceLeaseNonce: input.workspaceLeaseNonce,
    exp: Date.now() + TOKEN_TTL_MS,
    agentPtyReview: {
      bindingId: input.binding.id,
      processSessionId: input.binding.processSessionId,
      processGeneration: input.binding.processGeneration,
    },
  }, input.secret);
}

export function exchangeAgentPtyReviewCredential(input: {
  token: string;
  secret: string;
  bindings: AgentPtyBindingStore;
  processSessions: ProcessSessionManager;
  workSessions: WorkSessionManager;
  agentRegistry: AgentRegistryManager;
  now?: number;
}): { token: string; expiresAt: number } {
  const now = input.now ?? Date.now();
  const claims = verifyWorkerTokenSignature(input.token, input.secret) as WorkerTokenClaims;
  const scope = claims.agentPtyReview;
  if (!scope || !Number.isSafeInteger(scope.processGeneration) || scope.processGeneration < 1
    || typeof scope.bindingId !== "string" || typeof scope.processSessionId !== "string"
    || typeof claims.runId !== "string" || typeof claims.workspaceLeaseNonce !== "string") {
    throw new Error("PTY review credential renewal claims are incomplete.");
  }
  const binding = input.bindings.getByProcessSession(scope.processSessionId);
  if (!binding || binding.id !== scope.bindingId || binding.processGeneration !== scope.processGeneration
    || !["attached", "detached"].includes(binding.status)
    || binding.workSessionId !== claims.workSessionId
    || binding.workspaceSessionId !== claims.workspaceSessionId
    || binding.runId !== claims.runId
    || binding.ownerPrincipalId !== `worker-work-session:${claims.workSessionId}`) {
    throw new Error("The bound agent PTY is no longer eligible for credential renewal.");
  }
  const observation = input.processSessions.observeAgentPty({
    workSessionId: binding.workSessionId,
    processSessionId: binding.processSessionId,
  });
  if (!observation?.running || observation.binding.id !== binding.id
    || observation.binding.processGeneration !== binding.processGeneration) {
    throw new Error("The bound agent PTY process is not live in its original generation.");
  }
  const session = input.workSessions.get(binding.workSessionId);
  const run = input.agentRegistry.getRun(binding.runId);
  const latestAttempt = input.agentRegistry.getLatestDispatchAttemptForRun(binding.runId);
  if (!session || session.workspaceSessionId !== binding.workspaceSessionId
    || !["in_progress", "drafting", "awaiting_review", "in_review", "review_in_progress", "resuming", "changes_requested"].includes(session.status)
    || !run || run.workSessionId !== binding.workSessionId || run.workspaceSessionId !== binding.workspaceSessionId
    || ["approved", "rejected", "cancelled", "failed", "failed_protocol", "dispatch_uncertain"].includes(run.status)
    || !latestAttempt || latestAttempt.runId !== binding.runId
    || !latestAttempt.agentId || latestAttempt.agentId !== run.agentId) {
    throw new Error("The PTY work session or executing run is no longer current.");
  }
  const lease = input.workSessions.getWorkspaceLeaseForSession(binding.workSessionId);
  if (!lease || lease.workSessionId !== binding.workSessionId
    || lease.workspaceSessionId !== binding.workspaceSessionId
    || lease.leaseNonce !== claims.workspaceLeaseNonce
    || Date.parse(lease.expiresAt) <= now) {
    throw new Error("The PTY workspace lease is missing, expired, or changed.");
  }
  const expiresAt = now + TOKEN_TTL_MS;
  return {
    token: signWorkerToken({ ...claims, exp: expiresAt }, input.secret),
    expiresAt,
  };
}

export function createAgentPtyReviewCredential(input: {
  stateDir: string;
  host: string;
  port: number;
  secret: string;
  binding: AgentPtyBinding;
  workspaceLeaseNonce?: string;
}): { credentialFilePath: string; cleanup(): void } {
  const directory = mkdtempSync(join(input.stateDir, CREDENTIAL_DIRECTORY_PREFIX));
  chmodSync(directory, 0o700);
  const credentialFilePath = join(directory, "credential.json");
  try {
    if (!input.workspaceLeaseNonce) throw new Error("PTY review credentials require a live workspace lease.");
    const token = createAgentPtyReviewToken({
      secret: input.secret,
      binding: input.binding,
      workspaceLeaseNonce: input.workspaceLeaseNonce,
    });
    const host = input.host === "::" || input.host === "::1"
      ? "::1"
      : input.host === "0.0.0.0" || input.host === "127.0.0.1" || input.host === "localhost"
        ? "127.0.0.1"
        : undefined;
    if (!host) throw new Error("PTY review credentials require Kontrol to listen on a loopback or wildcard address.");
    const mcpUrl = new URL("/mcp", `http://${host.includes(":") ? `[${host}]` : host}:${input.port}`).href;
    writeFileSync(credentialFilePath, JSON.stringify({ mcpUrl, token, workSessionId: input.binding.workSessionId }), {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    credentialFilePath,
    cleanup() { rmSync(directory, { recursive: true, force: true }); },
  };
}

export function removeStaleAgentPtyReviewCredentials(stateDir: string): number {
  // The state directory is Kontrol-owned and private. Do not follow symlinks
  // or recurse outside it while cleaning credentials left by a crashed run.
  let removed = 0;
  for (const entry of readdirSync(stateDir, { withFileTypes: true })) {
    if (!entry.name.startsWith(CREDENTIAL_DIRECTORY_PREFIX) || entry.isSymbolicLink()) continue;
    const path = join(stateDir, entry.name);
    try {
      if (!lstatSync(path).isDirectory()) continue;
      rmSync(path, { recursive: true, force: true });
      removed++;
    } catch {
      // Startup remains available; any surviving credential still fails once
      // its durable PTY binding has been reconciled as lost.
    }
  }
  return removed;
}
