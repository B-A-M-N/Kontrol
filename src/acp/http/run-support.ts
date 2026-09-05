/**
 * Run dispatch support: work-session/workspace resolution and the
 * checkout-modify lease gate.
 *
 * Extracted verbatim from acp-server.ts's createAcpServer closure (P1
 * decomposition). Consumed by run-routes (the POST /runs dispatch paths).
 */
import { realpath } from "node:fs/promises";
import type { Response } from "express";
import type { WorkSessionManager } from "../../work-sessions.js";
import type { AcpContext } from "./context.js";

export function makeRunSupport(ctx: AcpContext) {
  const { workspaces, workSessions } = ctx;

  function resolveCwd(sessionId: string): { cwd: string; root: string } | undefined {
    const session = workSessions.get(sessionId);
    if (!session) return undefined;
    try {
      const ws = workspaces.getWorkspace(session.workspaceSessionId);
      return { cwd: ws.root, root: ws.root };
    } catch { return undefined; }
  }

  function extractTaskText(input: Array<{ parts?: Array<{ content?: string }> }>): string {
    return input.map((m) => m.parts?.map((p) => p.content ?? "").join("\n") ?? "").filter(Boolean).join("\n");
  }

  function resolveRunContext(
    res: Response,
    input: {
      workspace_id?: string;
      workspace_session_id?: string;
      work_session_id?: string;
      session_id?: string;
      submittedBy: string;
      title: string;
    },
  ): { workspaceId: string; workspaceRoot: string; session: ReturnType<WorkSessionManager["create"]>; createdSession: boolean } | undefined {
    const suppliedWorkSessionId = input.work_session_id ?? input.session_id;
    const suppliedWorkspaceId = input.workspace_id ?? input.workspace_session_id;

    let session = suppliedWorkSessionId ? workSessions.get(suppliedWorkSessionId) : undefined;
    if (suppliedWorkSessionId && !session) {
      res.status(404).json({ error: { code: "not_found", message: `Unknown work session: ${suppliedWorkSessionId}` } });
      return undefined;
    }

    const workspaceId = suppliedWorkspaceId ?? session?.workspaceSessionId;
    if (!workspaceId) {
      res.status(400).json({
        error: {
          code: "invalid_input",
          message: "workspace_id or workspace_session_id is required unless work_session_id/session_id names an existing work session",
        },
      });
      return undefined;
    }

    if (session && session.workspaceSessionId !== workspaceId) {
      res.status(409).json({ error: { code: "conflict", message: "work_session_id does not belong to the supplied workspace" } });
      return undefined;
    }

    let workspaceRoot: string;
    try {
      workspaceRoot = workspaces.getWorkspace(workspaceId).root;
    } catch (error) {
      res.status(400).json({
        error: {
          code: "invalid_workspace",
          message: error instanceof Error ? error.message : `Unknown workspace: ${workspaceId}`,
        },
      });
      return undefined;
    }

    let createdSession = false;
    if (!session) {
      session = workSessions.create({
        workspaceSessionId: workspaceId,
        submittedBy: input.submittedBy,
        title: input.title,
      });
      createdSession = true;
    }

    return { workspaceId, workspaceRoot, session, createdSession };
  }

  async function acquireCheckoutModifyLease(
    res: Response,
    workspaceId: string,
    workspaceRoot: string,
    workSessionId: string,
  ): Promise<boolean> {
    let workspaceMode = "checkout";
    try {
      workspaceMode = workspaces.getWorkspace(workspaceId).mode;
    } catch {
      workspaceMode = "checkout";
    }
    if (workspaceMode !== "checkout") return true;

    let canonicalRoot: string;
    try {
      canonicalRoot = await realpath(workspaceRoot);
    } catch (error) {
      res.status(400).json({
        error: {
          code: "invalid_workspace",
          message: `Unable to resolve checkout root: ${error instanceof Error ? error.message : String(error)}`,
        },
      });
      return false;
    }

    const lease = workSessions.acquireWorkspaceLease({
      canonicalRoot,
      workspaceSessionId: workspaceId,
      workSessionId,
    });
    if (lease.acquired) return true;
    res.status(409).json({
      error: {
        code: "checkout_busy",
        message: `Checkout is already controlled by work session ${lease.conflictingWorkSessionId}. Use an isolated worktree or cancel the existing session before dispatching another modifying worker.`,
        conflicting_work_session_id: lease.conflictingWorkSessionId,
        workspace_session_id: lease.workspaceSessionId,
        expires_at: lease.expiresAt,
      },
    });
    return false;
  }

  return { resolveCwd, extractTaskText, resolveRunContext, acquireCheckoutModifyLease };
}
