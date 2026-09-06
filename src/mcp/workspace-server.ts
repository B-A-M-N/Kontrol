/**
 * MCP server composition (P1.3): createMcpServer wires the shared envelope
 * and registers the workspace app resources, workspace tools, codex process
 * tools, policy tools, and ACP bridge tools. The registration bodies live in
 * tools/*.ts; the execution envelope in tool-envelope.ts; shared helpers in
 * the focused modules re-exported below. HTTP transport admission and session
 * lifecycle remain in src/server.ts.
 */
import { performance } from "node:perf_hooks";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ServerConfig } from "../config.js";
import type { PolicyEngine } from "../policy.js";
import type { WorkspaceRegistry } from "../workspaces.js";
import type { createReviewCheckpointManager } from "../review-checkpoints.js";
import type { createWorkSessionManager } from "../work-sessions.js";
import type { ProcessSessionManager } from "../process-sessions.js";
import type { WorkSessionManager } from "../work-sessions.js";
import type { AgentRegistryManager } from "../acp-registry.js";
import type { EventStore } from "../event-log.js";
import type { ContinuationManager } from "../continuation.js";
import type { DispatchOutbox } from "../dispatch-outbox.js";
import type { createApprovalRequestManager } from "../approval-requests.js";
import type { createMissionLedger } from "../mission-ledger.js";
import type { createAgentMessageManager } from "../agent-messages.js";
import type { createSupervisorRuns } from "../supervisor-runs.js";
import type { MutationReceiptStore } from "../mutation-receipts.js";
import type { ReviewWorkflowService } from "../review-workflow.js";
import type { LiveWaiterRegistry } from "../bridge/shared.js";
import type { DatabaseHandle } from "../db/client.js";
import { installCachedToolList } from "../mcp-tool-list-cache.js";
import { registerPolicyTools } from "../policy-tools.js";
import { registerBridgeTools } from "../acp-bridge.js";
// P1.3 decomposition: shared helpers live in focused modules. The names are
// re-exported below so existing importers of ./mcp/workspace-server.js keep
// working unchanged.
import {
  cachedServerInstructions,
  toolNames,
} from "./tool-names.js";
import { createToolEnvelope } from "./tool-envelope.js";
import { readPackageVersion } from "./tool-logging.js";
import { registerWorkspaceAppResources } from "./tools/resources.js";
import { registerWorkspaceTools } from "./tools/workspace.js";
import { registerCodexProcessTools } from "./tools/process.js";
import type { ConnectionContext } from "./connection-context.js";

// Public re-exports: ./mcp/workspace-server.js remains the import surface.
export { constantTimeStringEqual, degradedAuditSnapshot, requestLogFields, readPackageVersion } from "./tool-logging.js";
export { mcpRequestContext, type McpRequestContext } from "./request-context.js";
export { type Transport } from "./transport.js";
export {
  WorkspaceMutationBlockedError,
  isWorkspaceMutationBlockedError,
} from "./mutation-barrier.js";
export { type ConnectionContext, processSessionOwnerId } from "./connection-context.js";

// P1 #42: SDK internal-hook usage is isolated in mcp-tool-list-cache.ts.
const toolListDescriptorCache = new Map<string, Promise<unknown>>();
let toolListDescriptorCacheActive = false;

export type { DiffStats, ToolContent } from "./tool-result.js";
export { toolNames } from "./tool-names.js";
export {
  approvalResumeIdSchema,
  resultOutputSchema,
} from "./tool-schemas.js";
export { toolWidgetDescriptorMeta } from "./tool-context.js";

export function createMcpServer(
  config: ServerConfig,
  workspaces: WorkspaceRegistry,
  reviewCheckpoints: ReturnType<typeof createReviewCheckpointManager>,
  processSessions: ProcessSessionManager,
  workSessions?: ReturnType<typeof createWorkSessionManager>,
  agentRegistry?: import("../acp-registry.js").AgentRegistryManager,
  eventStore?: import("../event-log.js").EventStore,
  continuationManager?: import("../continuation.js").ContinuationManager,
  dispatchOutbox?: import("../dispatch-outbox.js").DispatchOutbox,
  policyEngine?: PolicyEngine,
  policyEnforcer?: import("../policy-enforcement.js").PolicyEnforcer,
  approvalRequests?: ReturnType<typeof createApprovalRequestManager>,
  missionLedger?: ReturnType<typeof createMissionLedger>,
  connectionContext?: ConnectionContext,
  reviewWorkflow?: ReviewWorkflowService,
  liveWaiters?: LiveWaiterRegistry,
  agentMessages?: ReturnType<typeof createAgentMessageManager>,
  supervisorRuns?: ReturnType<typeof createSupervisorRuns>,
  onSupervisorResume?: (workSessionId: string) => void,
  db?: DatabaseHandle,
  mutationReceipts?: MutationReceiptStore,
  onWorkspaceAppResource?: (uri: string) => void,
  onPhaseTiming?: (phase: string, durationMs: number) => void,
): McpServer {
  const serverConstructionStartedAt = performance.now();
  const server = new McpServer(
    {
      name: "kontrol",
      title: "Kontrol",
      // P1 #26: runtime version derives from the package manifest so the MCP
      // surface can never advertise an independent hardcoded version.
      version: readPackageVersion(),
      description:
        "Secure local coding workspace for MCP clients. Provides workspace-scoped file, search, edit, write, and shell tools.",
    },
    {
      instructions: cachedServerInstructions(config),
    },
  );
  onPhaseTiming?.("mcp.server_construction", performance.now() - serverConstructionStartedAt);
  const toolRegistrationStartedAt = performance.now();
  const mutationPrincipalId = connectionContext?.authenticatedPrincipalId
    || `${connectionContext?.authSource ?? "anonymous"}:${connectionContext?.authenticatedRole ?? "client"}`;
  const envelope = createToolEnvelope({ config, workspaces, reviewCheckpoints, workSessions, eventStore, connectionContext });
  const { trackToolEvent, prepareForMutation } = envelope;

  registerWorkspaceAppResources(server, config, onWorkspaceAppResource);

  registerWorkspaceTools(server, {
    config,
    workspaces,
    reviewCheckpoints,
    policyEngine,
    policyEnforcer,
    connectionContext,
    workSessions,
    trackToolEvent,
    prepareForMutation,
  });

  if (config.toolMode === "codex") {
    registerCodexProcessTools(server, config, workspaces, processSessions, workSessions, policyEnforcer, policyEngine, connectionContext, prepareForMutation);
  }

  // Policy approval tools — available whenever policy engine is configured.
  // The MCP /mcp surface is reached by the WebUI (reviewer) and ordinary
  // clients, NOT by the worker (the worker reaches Kontrol through the
  // stdio bridge, which hides these tools). Mark the caller as a reviewer so
  // provide_policy_approval is permitted here.
  if (policyEngine && eventStore) {
    registerPolicyTools(server, {
      eventStore,
      policyEngine,
      approvalRequests,
      principalRole: connectionContext?.authenticatedRole ?? "client",
      principalId: mutationPrincipalId,
      mutationReceipts,
    });
  }

  if (workSessions && config.acpEnabled && eventStore && reviewWorkflow && liveWaiters) {
    const bridgeConfig: Parameters<typeof registerBridgeTools>[1] = {
      db,
      workspaces,
      workSessions,
      reviewCheckpoints,
      agentRegistry: agentRegistry!,
      eventStore,
      continuationManager: continuationManager!,
      dispatchOutbox,
      reviewWorkflow,
      missionLedger,
      supervisorRuns,
      onSupervisorResume,
      agentMessages,
      approvalRequests,
      knownAgents: config.acpKnownAgents,
      adapterSecret: config.acpAdapterSecret,
      // P1 #10: pass server config to bridge so search_skills has access to skill paths.
      serverConfig: config,
      // Role is derived from the AUTHENTICATED envelope only. A connection is a
      // WORKER solely when a signed worker token verified (see
      // connectionContext.authenticatedRole); an ordinary MCP client is
      // "client". Reviewer authority requires the separate reviewer credential.
      // This lets the SAME bridge tool set enforce
      // reviewer-only vs worker-only server-side without registering the tools
      // twice — and crucially, a caller cannot gain worker rights by sending an
      // unsigned X-Kontrol-Work-Session header (P0 #3).
      principalRole: connectionContext?.authenticatedRole ?? "client",
      principalId: mutationPrincipalId,
      mutationReceipts,
      connectionContinuationId: connectionContext?.continuationId,
      connectionWorkSessionId: connectionContext?.workSessionId,
      connectionWorkspaceLeaseNonce: connectionContext?.workspaceLeaseNonce,
      liveWaiters,
      onPhaseTiming,
    };
    registerBridgeTools(server, bridgeConfig);
  }

  toolListDescriptorCacheActive = installCachedToolList(
    server,
    `${config.toolMode}|${config.widgets}|${config.skillsEnabled ? "skills" : "no-skills"}|${config.acpEnabled ? "acp" : "no-acp"}|${policyEngine ? "policy" : "no-policy"}`,
    toolListDescriptorCache,
    ListToolsRequestSchema,
  );
  if (!toolListDescriptorCacheActive) {
    console.warn("[kontrol] tools/list descriptor cache unavailable (SDK internals changed); serving uncached");
  }
  onPhaseTiming?.("mcp.tool_registration", performance.now() - toolRegistrationStartedAt);

  return server;
}
