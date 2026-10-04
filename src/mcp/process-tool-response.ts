/**
 * Codex process-tool (exec_command / write_stdin) result shaping and the
 * worker→workspace binding guard. Extracted verbatim from
 * src/mcp/workspace-server.ts (P1.3).
 */
import * as z from "zod/v4";
import type { ProcessSnapshot } from "../process-sessions.js";
import type { WorkSessionManager } from "../work-sessions.js";
import { resultOutputSchema } from "./tool-schemas.js";
import { textBlock, textSummary, type ToolContent } from "./tool-result.js";
import type { ConnectionContext } from "./connection-context.js";

export function processResult(snapshot: ProcessSnapshot): string {
  const status = snapshot.running
    ? `Process running with session ID ${snapshot.sessionId}.`
    : snapshot.signal
      ? `Process exited after signal ${snapshot.signal}.`
      : `Process exited with code ${snapshot.exitCode ?? "unknown"}.`;
  return snapshot.output ? `${snapshot.output.replace(/\n$/, "")}\n${status}` : status;
}

export function processOutputSchema(): z.ZodRawShape {
  return resultOutputSchema({
    sessionId: z.string().optional(),
    command: z.string().optional(),
    // Approval-required responses use the gated tool's shared result schema
    // and intentionally do not contain process lifecycle fields yet.
    running: z.boolean().optional(),
    exitCode: z.number().int().optional(),
    signal: z.string().optional(),
    wallTimeMs: z.number().nonnegative().optional(),
    outputTruncated: z.boolean().optional(),
    // Cursor-based nondestructive output reads (P0): the snapshot's monotonic
    // stream position and the oldest position still retained. A retry of a
    // lost poll at the same cursor returns the same logical output until
    // retention evicts it.
    outputCursor: z.number().int().nonnegative().optional(),
    oldestAvailableCursor: z.number().int().nonnegative().optional(),
    // Epoch ms when the child launched. A running card advances elapsed time
    // locally from this instead of freezing at the snapshot's wallTimeMs.
    startedAtEpochMs: z.number().int().nonnegative().optional(),
  });
}

export function processToolResponse(
  tool: "exec_command" | "write_stdin" | "bash" | "poll_process",
  workspaceId: string,
  snapshot: ProcessSnapshot,
  summary: Record<string, unknown>,
) {
  const result = processResult(snapshot);
  const content = [textBlock(result)];
  const outputSummary = textSummary(snapshot.output ? [textBlock(snapshot.output)] : []);
  return {
    content,
    _meta: {
      tool,
      card: {
        workspaceId,
        summary: { command: snapshot.command, ...summary, ...outputSummary },
      },
    },
    structuredContent: {
      tool,
      result,
      sessionId: snapshot.sessionId,
      command: snapshot.command,
      running: snapshot.running,
      exitCode: snapshot.exitCode,
      signal: snapshot.signal,
      wallTimeMs: snapshot.wallTimeMs,
      outputTruncated: snapshot.outputTruncated,
      outputCursor: snapshot.outputCursor,
      oldestAvailableCursor: snapshot.oldestAvailableCursor,
      startedAtEpochMs: snapshot.startedAtEpochMs,
    },
  };
}

/**
 * P0 #6: a dispatched worker is cryptographically bound to exactly one signed
 * work session, which lives inside exactly one workspace. It must never operate
 * on a different workspace — cross-workspace worker access defeats the
 * correlation/credential contract. Enforced only when the connection is a
 * verified worker with a bound session; ordinary clients and reviewers are
 * unrestricted here (their tools are role-gated separately).
 */
export function assertWorkerWorkspaceBinding(
  connectionContext: ConnectionContext | undefined,
  workSessions: WorkSessionManager | undefined,
  workspaceId: string,
): { content: Array<{ type: "text"; text: string }>; isError: true } | null {
  if (connectionContext?.authenticatedRole !== "worker") return null;
  const denied = () => ({
    content: [{ type: "text" as const, text: "Forbidden: worker is not bound to the requested workspace." }],
    isError: true as const,
  });
  if (!connectionContext.workSessionId || !workSessions) return denied();
  const session = workSessions.get(connectionContext.workSessionId);
  const allowed = session?.workspaceSessionId;
  if (
    !allowed ||
    workspaceId !== allowed ||
    (connectionContext.workspaceSessionId !== undefined && connectionContext.workspaceSessionId !== allowed)
  ) return denied();
  return null;
}

export type { ToolContent };
