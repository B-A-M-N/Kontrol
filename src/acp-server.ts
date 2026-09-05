/**
 * ACP HTTP server entry: composition only.
 *
 * P1 decomposition: the former 1,586-line createAcpServer closure now lives in
 * src/acp/http/ as capability route modules (auth, sse-hub, run-support,
 * review-barrier, agent-routes, run-routes, event-routes, review-routes)
 * mounted by createAcpRouter over one shared AcpContext. This entry keeps the
 * exact exported signature its five importers already use and maps the
 * positional dependency list onto the context.
 */
import { Router } from "express";
import type { WorkspaceRegistry } from "./workspaces.js";
import type { WorkSessionManager } from "./work-sessions.js";
import type { AgentRegistryManager } from "./acp-registry.js";
import type { EventStore } from "./event-log.js";
import type { ContinuationManager } from "./continuation.js";
import type { ReviewCheckpointManager } from "./review-checkpoints.js";
import type { ReviewWorkflowService } from "./review-workflow.js";
import type { PolicyEnforcer } from "./policy-enforcement.js";
import type { ApprovalRequestManager } from "./approval-requests.js";
import type { WebhookPolicy } from "./webhook-policy.js";
import { createAcpRouter } from "./acp/http/router.js";

export function createAcpServer(
  workspaces: WorkspaceRegistry,
  workSessions: WorkSessionManager,
  agentRegistry: AgentRegistryManager,
  sharedSecret?: string,
  adapterSecret?: string,
  eventStore?: EventStore,
  continuationManager?: ContinuationManager,
  reviewCheckpoints?: ReviewCheckpointManager,
  reviewWorkflow?: ReviewWorkflowService,
  policyEnforcer?: PolicyEnforcer,
  approvalRequests?: ApprovalRequestManager,
  agentSecret?: string,
  reviewerSecret?: string,
  webhookPolicy?: WebhookPolicy,
): Router {
  // continuationManager is accepted for signature compatibility; the ACP HTTP
  // surface itself never dispatches through it (native ACP continuations
  // arrive as adapter lifecycle events on POST /runs/:run_id/events).
  void continuationManager;
  return createAcpRouter(
    {
      workspaces,
      workSessions,
      agentRegistry,
      sharedSecret,
      adapterSecret,
      eventStore,
      reviewCheckpoints,
      reviewWorkflow,
      policyEnforcer,
      approvalRequests,
      agentSecret,
      reviewerSecret,
    },
    webhookPolicy,
  );
}
