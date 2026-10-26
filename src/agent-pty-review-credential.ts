import { chmodSync, lstatSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { signWorkerToken, TOKEN_TTL_MS } from "./acp-worker-token.mjs";
import type { AgentPtyBinding } from "./agent-pty-bindings.js";

const CREDENTIAL_DIRECTORY_PREFIX = "agent-pty-review-";

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
    const token = signWorkerToken({
      role: "worker",
      workSessionId: input.binding.workSessionId,
      workspaceSessionId: input.binding.workspaceSessionId,
      runId: input.binding.runId,
      ...(input.workspaceLeaseNonce ? { workspaceLeaseNonce: input.workspaceLeaseNonce } : {}),
      exp: Date.now() + TOKEN_TTL_MS,
      agentPtyReview: {
        bindingId: input.binding.id,
        processSessionId: input.binding.processSessionId,
        processGeneration: input.binding.processGeneration,
      },
    }, input.secret);
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
