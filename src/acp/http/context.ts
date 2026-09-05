/**
 * AcpContext: the shared typed dependency surface for the ACP HTTP route
 * modules.
 *
 * Extracted from acp-server.ts's createAcpServer closure (P1 decomposition).
 * Each capability module (auth, sse-hub, run-support, agent-routes, run-routes,
 * event-routes, review-routes) receives this ONE context object — plain data,
 * no behaviour — so the modules stay independent and `createAcpServer` remains
 * a thin composition entry. Schemas and shared constants multiple modules need
 * live here.
 */
import type { Request, Response } from "express";
import type { WorkspaceRegistry } from "../../workspaces.js";
import type { WorkSessionManager } from "../../work-sessions.js";
import type { AgentRegistryManager } from "../../acp-registry.js";
import type { EventStore } from "../../event-log.js";
import type { ReviewCheckpointManager } from "../../review-checkpoints.js";
import type { ReviewWorkflowService } from "../../review-workflow.js";
import type { PolicyEnforcer } from "../../policy-enforcement.js";
import type { ApprovalRequestManager } from "../../approval-requests.js";
import type { WebhookPolicy } from "../../webhook-policy.js";

/**
 * Long-poll window for a blocking agent permission request. This is NOT a
 * deadline: when it elapses the approval stays pending and the caller re-parks
 * (people step away for a long time). It only bounds how long a single HTTP
 * request is held so sockets/proxies don't die mid-wait.
 */
export const APPROVAL_WAIT_TIMEOUT_MS = 300_000;

export const ACP_AGENTS = [
  { name: "kontrol-read", description: "Read a file from the workspace." },
  { name: "kontrol-write", description: "Write or overwrite a file in the workspace." },
  { name: "kontrol-edit", description: "Edit a file by replacing exact text blocks." },
  { name: "kontrol-grep", description: "Search file contents by pattern." },
  { name: "kontrol-glob", description: "Find files by glob pattern." },
  { name: "kontrol-shell", description: "Execute a shell command in the workspace." },
  { name: "kontrol-review", description: "Submit work for human review and await feedback." },
  {
    name: "kontrol-agent-registry",
    description: "Register, discover, and list peer agents. For agent-to-agent routing.",
  },
  {
    name: "kontrol-submit-work-to-webui",
    description: "Submit completed work (diff/checkpoint) to the Kontrol WebUI for human review. (Ralphie Muntz Loop terminus: the WebUI's 'A-okay' is the only completion criterion.)",
  },
];

export const MUTATING_LOCAL_AGENTS = new Set([
  "kontrol-write",
  "kontrol-edit",
  "kontrol-shell",
  "kontrol-review",
  "kontrol-submit-work-to-webui",
]);

/** Role resolved from the presented bearer secret. */
export type AcpRole = "agent" | "reviewer" | "operator";

export interface AcpContext {
  workspaces: WorkspaceRegistry;
  workSessions: WorkSessionManager;
  agentRegistry: AgentRegistryManager;
  sharedSecret?: string;
  adapterSecret?: string;
  eventStore?: EventStore;
  reviewCheckpoints?: ReviewCheckpointManager;
  reviewWorkflow?: ReviewWorkflowService;
  policyEnforcer?: PolicyEnforcer;
  approvalRequests?: ApprovalRequestManager;
  agentSecret?: string;
  reviewerSecret?: string;
  effectiveWebhookPolicy: WebhookPolicy;
  /** Run-id keyed connected SSE response streams (run event fan-out). */
  sseClients: Map<string, Set<Response>>;
  /** Local Kontrol tool agents exposed over the ACP surface. */
  agentMap: Map<string, { name: string; description: string }>;
}
