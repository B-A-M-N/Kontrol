/**
 * ACP HTTP authentication and per-request authorization gates.
 *
 * Extracted verbatim from acp-server.ts's createAcpServer closure (P1
 * decomposition). Role resolution is timing-safe and first-match; `authGate`
 * is the single entry every route module uses.
 */
import type { Request, Response } from "express";
import { constantTimeStringEqual } from "../../mcp/workspace-server.js";
import type { AcpContext, AcpRole } from "./context.js";

export function makeAuth(ctx: AcpContext) {
  const { agentSecret, reviewerSecret, sharedSecret, agentRegistry } = ctx;

  /**
   * Authenticate with the appropriate secret based on the claimed role.
   * A worker/agent must use the agent secret; a reviewer/client must use the
   * reviewer secret. An agent secret must NOT allow self-registration as
   * "client" or "reviewer".
   */
  function authenticateAcpRequest(req: Request): AcpRole | undefined {
    const presented = req.headers.authorization;
    // Timing-safe comparisons (P1 #5). First-match wins; distinct secrets are
    // enforced by config validation, so role resolution is unambiguous.
    if (agentSecret && constantTimeStringEqual(presented, `Bearer ${agentSecret}`)) return "agent";
    if (reviewerSecret && constantTimeStringEqual(presented, `Bearer ${reviewerSecret}`)) return "reviewer";
    if (sharedSecret && constantTimeStringEqual(presented, `Bearer ${sharedSecret}`)) return "operator";
    return undefined;
  }

  function authGate(req: Request, res: Response, allowedRoles: AcpRole[] = ["agent", "reviewer", "operator"]): AcpRole | undefined {
    if (!sharedSecret && !agentSecret && !reviewerSecret) {
      res.status(401).json({ error: { code: "unauthorized", message: "ACP is disabled: no shared secret configured" } });
      return undefined;
    }
    const role = authenticateAcpRequest(req);
    if (role && allowedRoles.includes(role)) return role;
    if (role) {
      res.status(403).json({ error: { code: "forbidden", message: `ACP role ${role} is not allowed for this operation` } });
      return undefined;
    }
    res.status(401).json({ error: { code: "unauthorized", message: "Missing or invalid authorization" } });
    return undefined;
  }

  function requireAgentOwnership(
    req: Request,
    res: Response,
    role: AcpRole,
    expectedAgentId: string | undefined,
  ): boolean {
    if (role !== "agent") return true;
    const presentedAgentId = req.header("x-kontrol-agent-id");
    const presentedCredential = req.header("x-kontrol-agent-credential");
    if (!expectedAgentId || presentedAgentId !== expectedAgentId || !agentRegistry.verifyAgentCredential(expectedAgentId, presentedCredential)) {
      res.status(403).json({ error: { code: "forbidden", message: "Valid per-agent credential is required for this resource" } });
      return false;
    }
    return true;
  }

  return { authenticateAcpRequest, authGate, requireAgentOwnership };
}
