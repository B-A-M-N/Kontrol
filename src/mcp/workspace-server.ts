/**
 * MCP server composition (P1.3): createMcpServer wires the shared envelope
 * and registers the workspace app resources, workspace tools, codex process
 * tools, policy tools, and ACP bridge tools. The registration bodies live in
 * tools/*.ts; the execution envelope in tool-envelope.ts; shared helpers in
 * the focused modules re-exported below. HTTP transport admission and session
 * lifecycle remain in src/server.ts.
 */
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod/v4";
import type { ServerConfig } from "../config.js";
import { assertAllowedPath, expandHomePath } from "../roots.js";
import { peerGrantsRoot, peerPrincipalFromDescriptor } from "../peer/principal.js";
import { getPeerJobStore } from "../peer/jobs/store.js";
import { enforcePeerJobsCap, MAX_INSTRUCTION_BYTES, normalizeAllowedOutputs } from "../peer/jobs/service.js";
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
import { installCachedToolList, installToolListFilter, observeToolListDescriptors } from "../mcp-tool-list-cache.js";
import {
  evaluateToolCatalogAcknowledgement,
  fingerprintToolCatalog,
  TOOL_CATALOG_ACK_CAPABILITY,
  ToolCatalogAcceptedNotificationSchema,
  type ToolCatalogFingerprint,
} from "./tool-catalog-handshake.js";
import { registerPolicyTools } from "../policy-tools.js";
import { registerPeerStatusTool } from "../peer/peer-tools.js";
import { registerIngressManagementTool } from "../ingress/ingress-tools.js";
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
import { peerAllowedToolNames, peerToolProfileKey } from "../peer/tool-profile.js";

// Public re-exports: ./mcp/workspace-server.js remains the import surface.
export { constantTimeStringEqual, degradedAuditSnapshot, requestLogFields, readMcpServerVersion, readPackageVersion } from "./tool-logging.js";
export { mcpRequestContext, type McpRequestContext } from "./request-context.js";
export { type Transport } from "./transport.js";
export {
  WorkspaceMutationBlockedError,
  isWorkspaceMutationBlockedError,
} from "./mutation-barrier.js";
export { type ConnectionContext, processSessionOwnerId } from "./connection-context.js";

// The descriptor cache observes the public tools/list handler registration;
// catalog fingerprints come from the exact descriptor response.
const toolListDescriptorCache = new Map<string, Promise<unknown>>();
const toolSchemaCacheByConfig = new WeakMap<ServerConfig, Map<string, unknown>>();

function isZodSchema(value: unknown): value is { safeParse: (input: unknown) => unknown } {
  return Boolean(value && typeof value === "object" && typeof (value as { safeParse?: unknown }).safeParse === "function");
}

function normalizeAndCacheToolSchema<T>(
  cache: Map<string, unknown>,
  key: string,
  schema: T,
): T {
  if (!schema) return schema;
  if (cache.has(key)) return cache.get(key) as T;

  let normalized: unknown = schema;
  if (schema && typeof schema === "object" && !Array.isArray(schema) && !isZodSchema(schema)) {
    const shape = schema as Record<string, unknown>;
    if (Object.keys(shape).every((field) => isZodSchema(shape[field]))) {
      // McpServer normally converts raw field shapes into a new Zod object for
      // every session. Tool schemas depend on the immutable server build and
      // registration profile, so share that object while keeping each server's
      // callback and authorization context independent.
      normalized = z.object(shape as z.ZodRawShape);
    }
  }
  cache.set(key, normalized);
  return normalized as T;
}

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
  onScheduledJobCreated?: () => void,
  db?: DatabaseHandle,
  mutationReceipts?: MutationReceiptStore,
  onWorkspaceAppResource?: (uri: string) => void,
  onPhaseTiming?: (phase: string, durationMs: number) => void,
  scheduledJobs?: import("../scheduling/scheduled-job-store.js").ScheduledJobStore,
  reviewRoutes?: import("../review-handoff/route-store.js").ReviewRouteStore,
  onToolCatalogHandshake?: (sessionId: string | undefined, result: {
    status: "accepted" | "rejected";
    serverVersion: string;
    captureId?: string;
    serverCatalogSha256?: string;
    hostCatalogSha256: string;
    toolCount?: number;
    acceptedAt: string;
    reason?: string;
  }) => void,
  reconcileScheduledJob?: (jobId: string) => Promise<import("../scheduling/scheduled-job-store.js").ScheduledJob | undefined>,
  qualificationEvidence?: import("../server/mcp-qualification-evidence.js").McpQualificationEvidenceJournal,
  reviewBrowserController?: import("../review-browser/browser-controller.js").ReviewerBrowserController,
  reviewThreads?: import("../review-thread/thread-store.js").ReviewThreadStore,
  reviewBrowserJobs?: import("../review-thread/reviewer-job-store.js").ReviewerJobStore,
): McpServer {
  // note: parameters remain in declared order; scheduledJobs precedes reviewRoutes.
  const serverConstructionStartedAt = performance.now();
  const mcpToolSurface = readMcpToolSurface();
  const scheduledExecutionPolicyFor = (workSessionId: string): import("../work-session-action-guard.js").ScheduledExecutionPolicy | undefined => {
    if (!workSessionId || !scheduledJobs) return undefined;
    const row = scheduledJobs.getByWorkSessionId(workSessionId);
    if (!row) return undefined;
    return {
      executionMode: row.executionMode,
      workspaceAccess: typeof row.policySnapshotJson.workspaceAccess === "string" ? row.policySnapshotJson.workspaceAccess : undefined,
      mutate: row.policySnapshotJson.mutate === true ? true : row.policySnapshotJson.mutate === false ? false : undefined,
      allowedOutputs: Array.isArray(row.policySnapshotJson.allowedOutputs)
        ? row.policySnapshotJson.allowedOutputs.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
        : undefined,
      allowedTools: Array.isArray(row.policySnapshotJson.allowedTools) ? row.policySnapshotJson.allowedTools.filter((item): item is string => typeof item === "string") : undefined,
    };
  };
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
  let toolSchemaCache = toolSchemaCacheByConfig.get(config);
  if (!toolSchemaCache) {
    toolSchemaCache = new Map();
    toolSchemaCacheByConfig.set(config, toolSchemaCache);
  }
  const toolRegistrationProfile = JSON.stringify([
    mcpToolSurface.version,
    config.toolMode,
    config.widgets,
    config.skillsEnabled,
    config.acpEnabled,
    Boolean(workSessions),
    Boolean(agentRegistry),
    Boolean(eventStore),
    Boolean(continuationManager),
    Boolean(dispatchOutbox),
    Boolean(policyEngine),
    Boolean(policyEnforcer),
    Boolean(approvalRequests),
    Boolean(missionLedger),
    Boolean(reviewWorkflow),
    Boolean(liveWaiters),
    Boolean(agentMessages),
    Boolean(supervisorRuns),
    Boolean(db),
    Boolean(mutationReceipts),
    Boolean(scheduledJobs),
    Boolean(reconcileScheduledJob),
    Boolean(reviewRoutes),
    Boolean(qualificationEvidence),
    Boolean(reviewBrowserController),
    Boolean(reviewThreads),
    Boolean(reviewBrowserJobs),
  ]);
  // Peer-restricted servers (authenticatedRole === "peer") expose only the
  // owner-granted capability profile: unauthorized tools are hidden from
  // tools/list AND rejected at execution if invoked by name despite a stale
  // catalog. Owner-authorized servers keep the full catalog.
  const peerTools = connectionContext?.authenticatedRole === "peer"
    ? peerAllowedToolNames(connectionContext.peerCapabilities ?? [])
    : undefined;
  const registerTool = server.registerTool.bind(server);
  server.registerTool = ((name, definition, callback) => {
    const key = `${toolRegistrationProfile}:${name}`;
    const guardedCallback = peerTools
      ? async (args: unknown, extra: unknown) => {
          if (!peerTools.has(name)) {
            return {
              content: [{ type: "text" as const, text: `Forbidden: tool '${name}' is not in the granted peer capability profile.` }],
              isError: true,
            };
          }
          return (callback as (callArgs: unknown, callExtra: unknown) => unknown)(args, extra);
        }
      : callback;
    return registerTool(name, {
      ...definition,
      inputSchema: normalizeAndCacheToolSchema(toolSchemaCache!, `${key}:input`, definition.inputSchema),
      outputSchema: normalizeAndCacheToolSchema(toolSchemaCache!, `${key}:output`, definition.outputSchema),
    }, guardedCallback as typeof callback);
  }) as typeof server.registerTool;

  let toolCatalogFingerprint: ToolCatalogFingerprint | undefined;
  const toolListDescriptorObservation = observeToolListDescriptors(
    server,
    ListToolsRequestSchema,
    (descriptor) => {
      toolCatalogFingerprint = fingerprintToolCatalog(descriptor);
    },
  );
  const toolListCacheInstallation = installCachedToolList(
    server,
    `${config.toolMode}|${config.widgets}|${config.skillsEnabled ? "skills" : "no-skills"}|${config.acpEnabled ? "acp" : "no-acp"}|${policyEngine ? "policy" : "no-policy"}|surface:${mcpToolSurface.version}|${peerTools ? `peer:${peerToolProfileKey(connectionContext?.peerCapabilities)}` : "owner"}`,
    toolListDescriptorCache,
    ListToolsRequestSchema,
  );
  const peerFilterInstallation = peerTools
    ? installToolListFilter(server, ListToolsRequestSchema, (toolName) => peerTools.has(toolName))
    : undefined;
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
  const envelope = createToolEnvelope({ config, workspaces, reviewCheckpoints, workSessions, eventStore, connectionContext, scheduledExecutionPolicyFor });
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
    scheduledExecutionPolicyFor,
    recordPublicationIntent: (input: { jobId: string; intent: Record<string, unknown> }) => {
      if (!scheduledJobs) throw new Error("Scheduled jobs are unavailable for publication intents.");
      scheduledJobs.recordPublicationIntent(input);
    },
    recordPublicationReceipt: (input: { jobId: string; receipt: Record<string, unknown> }) => {
      if (!scheduledJobs) throw new Error("Scheduled jobs are unavailable for publication receipts.");
      scheduledJobs.recordPublicationReceipt(input);
    },
    recordPublicationFailure: (input: { jobId: string; receiptId: string; outcome: "rejected" | "conflict"; reason: string }) => {
      if (!scheduledJobs) throw new Error("Scheduled jobs are unavailable for publication outcomes.");
      scheduledJobs.recordPublicationFailure(input);
    },
    scheduledJobFor: (workSessionId: string) => scheduledJobs?.getByWorkSessionId(workSessionId),
  });

  // Process polling is available in every tool mode. This is the recovery
  // surface for a minimal-mode bash call whose original HTTP request ended.
  registerProcessPollingTool(server, config, workspaces, processSessions, workSessions, connectionContext);

  // Owner-side enqueue for the M3 durable peer-pull job protocol (C2). This
  // tool is NEVER in any peer tool profile (see peer/tool-profile.ts), so it
  // is hidden from peer tools/list and denied by the peer execution guard;
  // the handler additionally enforces owner-only authority so a worker,
  // reviewer, or peer session can never enqueue even with a stale catalog.
  server.registerTool(toolNames.enqueuePeerJob, {
    title: "Enqueue peer job",
    description:
      "Owner-only: enqueue a durable, peer-scoped job for a granted peer to claim over the peer job protocol. "
      + "instructions is delivered to the peer verbatim (capped at 256 KiB); allowedOutputs declares the RELATIVE path prefixes the peer's result manifest may contain (empty set allows no file outputs; \"*\" is the explicit match-all escape).",
    inputSchema: {
      peerId: z.string().min(1).describe("Operator-assigned peer identity from the credential registry."),
      repositoryId: z.string().min(1).describe("Workspace root for the job; canonicalized against KONTROL_ALLOWED_ROOTS and the peer's grantedRoots."),
      baseRevision: z.string().min(1).describe("Immutable git SHA or snapshot identity the job is based on."),
      taskClass: z.enum(["read_only_audit", "propose_patch", "bounded_execution"]),
      instructions: z.string().min(1).describe("UTF-8 instruction text delivered verbatim to the peer (max 256 KiB)."),
      allowedOutputs: z.array(z.string().min(1)).min(1).describe("REQUIRED relative path prefixes the result manifest may contain (e.g. [\"out/\"]); [\"*\"] allows everything."),
      maxRuntimeMs: z.number().int().positive().max(3_600_000).optional().describe("Runtime budget in ms (default 600000, max 3600000)."),
      maxArtifactBytes: z.number().int().positive().max(16_777_216).optional().describe("Result artifact byte cap (default 1048576, max 16777216)."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (args) => {
    const denied = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true as const });
    // Owner authority FIRST: exactly an authenticated client on the owner
    // listener may enqueue. Peer/worker/reviewer sessions are denied even if
    // a stale catalog advertised the tool.
    if (connectionContext?.authenticatedRole !== "client") {
      return denied("Forbidden: enqueue_peer_job is owner-only.");
    }
    const peer = config.peer;
    if (!peer) return denied("Peer integration is not enabled (no peer configuration).");
    const descriptor = peer.allowedPeers.find((candidate) => candidate.id === args.peerId);
    if (!descriptor) return denied(`Forbidden: peerId ${JSON.stringify(args.peerId)} is not in the peer credential registry.`);
    if (Buffer.byteLength(args.instructions, "utf8") > MAX_INSTRUCTION_BYTES) {
      return denied(`instructions exceed the ${MAX_INSTRUCTION_BYTES}-byte cap.`);
    }
    let allowedOutputs: string[];
    try {
      allowedOutputs = normalizeAllowedOutputs(args.allowedOutputs);
    } catch (error) {
      return denied(`Invalid allowedOutputs: ${error instanceof Error ? error.message : String(error)}`);
    }
    // Canonicalize the repository root exactly like open_workspace does:
    // resolve against the server's allowed roots, then realpath to the
    // canonical root. Descriptors always come from config — never from the
    // caller.
    let canonicalRoot: string;
    try {
      canonicalRoot = await realpath(assertAllowedPath(expandHomePath(args.repositoryId), config.allowedRoots));
    } catch {
      return denied(`Forbidden: repositoryId ${JSON.stringify(args.repositoryId)} is outside the server's allowed roots or does not exist.`);
    }
    const peerPrincipal = peerPrincipalFromDescriptor(descriptor, { revision: 0, hash: "unpublished" });
    if (!peerGrantsRoot(peerPrincipal, canonicalRoot)) {
      return denied(`Forbidden: peer ${descriptor.id} is not granted access to workspace root ${canonicalRoot}.`);
    }
    const store = getPeerJobStore();
    if (!store) return denied("Peer integration is not enabled (no peer job store).");
    try {
      enforcePeerJobsCap(store, descriptor.id, { peer: { maxClaimedJobs: peer.maxClaimedJobs } });
    } catch (error) {
      return denied(error instanceof Error ? error.message : String(error));
    }
    const job = store.createJob({
      peerId: descriptor.id,
      repositoryId: canonicalRoot,
      baseRevision: args.baseRevision,
      taskClass: args.taskClass,
      instructionHash: createHash("sha256").update(args.instructions, "utf8").digest("hex"),
      instructions: args.instructions,
      allowedOutputs,
      maxRuntimeMs: args.maxRuntimeMs ?? 600_000,
      maxArtifactBytes: args.maxArtifactBytes ?? 1_048_576,
    });
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          jobId: job.jobId,
          status: job.status,
          peerId: job.peerId,
          repositoryId: job.repositoryId,
          instructionHash: job.instructionHash,
          maxRuntimeMs: job.maxRuntimeMs,
          maxArtifactBytes: job.maxArtifactBytes,
        }),
      }],
    };
  });

  if (config.toolMode === "codex") {
    // P1-02: scheduled read-only execution policy is enforced at the tool boundary.
    registerCodexProcessTools(server, config, workspaces, processSessions, workSessions, policyEnforcer, policyEngine, connectionContext, prepareForMutation, scheduledExecutionPolicyFor);
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

  // M5 WebUI visibility: reviewer/owner peer-status projection. The tool is
  // never in a peer capability profile (peer/tool-profile.ts) and the peer
  // execution guard denies it; the handler additionally denies peer/worker
  // roles, so registering it on the peer listener too stays harmless while
  // the catalog filter keeps it out of peer tools/list.
  registerPeerStatusTool(server, {
    config,
    principalRole: connectionContext?.authenticatedRole ?? "client",
    store: getPeerJobStore(),
  });
  registerIngressManagementTool(server, {
    config,
    principalRole: connectionContext?.authenticatedRole ?? "client",
  });

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
      onScheduledJobCreated,
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
      scheduledJobs,
      reconcileScheduledJob,
      reviewRoutes,
      reviewBrowserController,
      reviewThreads,
      reviewBrowserJobs,
      qualificationEvidence,
      toolSurfaceVersion: mcpToolSurface.version,
    };
    registerBridgeTools(server, bridgeConfig);
  }

  const catalogObservationAvailable = toolListDescriptorObservation.finalizeRegistration();
  const descriptorCacheAvailable = toolListCacheInstallation.finalizeRegistration();
  if (!catalogObservationAvailable) {
    console.warn("[kontrol] tools/list descriptor observation unavailable; serving uncached and rejecting catalog acknowledgements");
  }
  if (!descriptorCacheAvailable) console.warn("[kontrol] tools/list descriptor cache unavailable; serving uncached");
  if (peerFilterInstallation && !peerFilterInstallation.finalizeRegistration()) {
    // Fail closed: a peer session that cannot hide unauthorized tools from
    // tools/list must not be served at all — the execution guard alone leaves
    // a confusing catalog that advertises tools the peer can never call.
    throw new Error("Peer tool catalog could not be restricted; refusing to create an unrestricted peer MCP server.");
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
    const validation = evaluateToolCatalogAcknowledgement({
      expected,
      received,
      authoritativeServerVersion: mcpToolSurface.version,
      clientSupportsExtension,
    });
    onToolCatalogHandshake?.(connectionContext?.mcpSessionId, {
      status: validation.status,
      serverVersion: mcpToolSurface.version,
      captureId: received.captureId,
      serverCatalogSha256: expected?.sha256,
      hostCatalogSha256: received.hostCatalogSha256,
      toolCount: expected?.toolCount,
      acceptedAt,
      reason: validation.reason,
    });
  });
  assertRequiredInspectionTools(workspaceToolNames);
  onPhaseTiming?.("mcp.tool_registration", performance.now() - toolRegistrationStartedAt);

  return server;
}
