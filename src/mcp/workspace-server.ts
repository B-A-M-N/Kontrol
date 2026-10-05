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
import {
  fingerprintToolCatalog,
  TOOL_CATALOG_ACK_CAPABILITY,
  ToolCatalogAcceptedNotificationSchema,
  type ToolCatalogFingerprint,
} from "./tool-catalog-handshake.js";
import { registerPolicyTools } from "../policy-tools.js";
import { registerBridgeTools } from "../acp-bridge.js";
// P1.3 decomposition: shared helpers live in focused modules. The names are
// re-exported below so existing importers of ./mcp/workspace-server.js keep
// working unchanged.
import {
  cachedServerInstructions,
  toolNames,
  assertRequiredInspectionTools,
  readMcpToolSurface,
} from "./tool-names.js";
import { createToolEnvelope } from "./tool-envelope.js";
import { readMcpServerVersion } from "./tool-logging.js";
import { registerWorkspaceAppResources } from "./tools/resources.js";
import { registerWorkspaceTools } from "./tools/workspace.js";
import { registerCodexProcessTools, registerProcessPollingTool } from "./tools/process.js";
import type { ConnectionContext } from "./connection-context.js";
import { mcpOwnerContextId } from "./owner-context.js";

// Public re-exports: ./mcp/workspace-server.js remains the import surface.
export { constantTimeStringEqual, degradedAuditSnapshot, requestLogFields, readMcpServerVersion, readPackageVersion } from "./tool-logging.js";
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
  onToolCatalogHandshake?: (sessionId: string | undefined, result: {
    status: "accepted" | "rejected";
    serverCatalogSha256?: string;
    hostCatalogSha256: string;
    toolCount?: number;
    acceptedAt: string;
    reason?: string;
  }) => void,
): McpServer {
  const serverConstructionStartedAt = performance.now();
  const mcpToolSurface = readMcpToolSurface();
  const server = new McpServer(
    {
      name: "kontrol",
      title: "Kontrol",
      // The MCP identity includes the immutable executable-tree fingerprint so
      // clients cannot treat materially different tool catalogs as identical.
      version: mcpToolSurface.version,
      description:
        "Secure local coding workspace for MCP clients. Provides workspace-scoped file, search, edit, write, and shell tools.",
    },
    {
      instructions: cachedServerInstructions(config),
    },
  );
  server.server.registerCapabilities({
    extensions: {
      [TOOL_CATALOG_ACK_CAPABILITY]: {
        contractVersion: 1,
        notificationMethod: "notifications/experimental/kontrol/tool-catalog-accepted",
        fingerprint: "sha256-canonical-json-v1",
        required: config.mcpToolCatalogAckRequired === true,
      },
    },
  });
  onPhaseTiming?.("mcp.server_construction", performance.now() - serverConstructionStartedAt);
  const toolRegistrationStartedAt = performance.now();
  const mutationPrincipalId = connectionContext?.authenticatedPrincipalId
    || `${connectionContext?.authSource ?? "anonymous"}:${connectionContext?.authenticatedRole ?? "client"}`;
  const envelope = createToolEnvelope({ config, workspaces, reviewCheckpoints, workSessions, eventStore, connectionContext });
  const { trackToolEvent, prepareForMutation } = envelope;

  registerWorkspaceAppResources(server, config, onWorkspaceAppResource);

  const workspaceToolNames = registerWorkspaceTools(server, {
    config,
    workspaces,
    reviewCheckpoints,
    policyEngine,
    policyEnforcer,
    connectionContext,
    workSessions,
    trackToolEvent,
    prepareForMutation,
    processSessions,
  });

  // Process polling is available in every tool mode. This is the recovery
  // surface for a minimal-mode bash call whose original HTTP request ended.
  registerProcessPollingTool(server, config, workspaces, processSessions, workSessions, connectionContext);

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
      workSessions,
      principalRole: connectionContext?.authenticatedRole ?? "client",
      principalId: mutationPrincipalId,
      connectionContext,
      ownerContextId: mcpOwnerContextId(connectionContext ?? {}),
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
      connectionContext,
      mutationReceipts,
      connectionContinuationId: connectionContext?.continuationId,
      connectionWorkSessionId: connectionContext?.workSessionId,
      connectionMcpSessionId: connectionContext?.mcpSessionId,
      connectionConversationId: connectionContext?.conversationId,
      connectionWorkspaceLeaseNonce: connectionContext?.workspaceLeaseNonce,
      liveWaiters,
      onPhaseTiming,
    };
    registerBridgeTools(server, bridgeConfig);
  }

  let toolCatalogFingerprint: ToolCatalogFingerprint | undefined;
  toolListDescriptorCacheActive = installCachedToolList(
    server,
    `${config.toolMode}|${config.widgets}|${config.skillsEnabled ? "skills" : "no-skills"}|${config.acpEnabled ? "acp" : "no-acp"}|${policyEngine ? "policy" : "no-policy"}|surface:${mcpToolSurface.version}`,
    toolListDescriptorCache,
    ListToolsRequestSchema,
    (descriptor) => {
      toolCatalogFingerprint = fingerprintToolCatalog(descriptor);
    },
  );
  if (!toolListDescriptorCacheActive) {
    console.warn("[kontrol] tools/list descriptor cache unavailable (SDK internals changed); serving uncached");
  }
  server.server.setNotificationHandler(ToolCatalogAcceptedNotificationSchema, async (notification) => {
    const expected = toolCatalogFingerprint;
    const received = notification.params;
    const acceptedAt = new Date().toISOString();
    const clientExtension = server.server.getClientCapabilities()?.extensions?.[TOOL_CATALOG_ACK_CAPABILITY];
    const clientSupportsExtension = Boolean(
      clientExtension
      && typeof clientExtension === "object"
      && (clientExtension as { contractVersion?: unknown }).contractVersion === 1,
    );
    const reason = !expected
      ? "tools_list_not_observed"
      : !clientSupportsExtension
        ? "client_capability_missing"
      : received.serverVersion !== mcpToolSurface.version
        ? "server_version_mismatch"
        : received.hostCatalogSha256 !== expected.sha256
          ? "host_catalog_fingerprint_mismatch"
          : received.hostToolCount !== expected.toolCount
            ? "host_catalog_tool_count_mismatch"
            : undefined;
    onToolCatalogHandshake?.(connectionContext?.mcpSessionId, {
      status: reason ? "rejected" : "accepted",
      serverCatalogSha256: expected?.sha256,
      hostCatalogSha256: received.hostCatalogSha256,
      toolCount: expected?.toolCount,
      acceptedAt,
      reason,
    });
  });
  assertRequiredInspectionTools(workspaceToolNames);
  onPhaseTiming?.("mcp.tool_registration", performance.now() - toolRegistrationStartedAt);

  return server;
}
