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
    running: z.boolean(),
    exitCode: z.number().int().optional(),
    signal: z.string().optional(),
    wallTimeMs: z.number().nonnegative(),
    outputTruncated: z.boolean(),
  });
}

export function processToolResponse(
  tool: "exec_command" | "write_stdin",
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
        summary: { ...summary, ...outputSummary },
        payload: { content },
      },
    },
    structuredContent: {
      result,
      sessionId: snapshot.sessionId,
      running: snapshot.running,
      exitCode: snapshot.exitCode,
      signal: snapshot.signal,
      wallTimeMs: snapshot.wallTimeMs,
      outputTruncated: snapshot.outputTruncated,
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
  if (connectionContext?.authenticatedRole === "worker" && connectionContext.workSessionId && workSessions) {
    const session = workSessions.get(connectionContext.workSessionId);
    const allowed = session?.workspaceSessionId;
    if (allowed && workspaceId !== allowed) {
      return {
        content: [{ type: "text" as const, text: "Forbidden: worker is bound to a different workspace than the requested one." }],
        isError: true,
      };
    }
  }
  return null;
}

export type { ToolContent };
