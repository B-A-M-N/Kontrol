/**
 * Conversation-scoped review handoff tools.
 *
 * A fresh reviewer context must claim an exact submission-scoped handoff before
 * it can read the packet or return feedback. Possession of a work-session ID is
 * not authorization.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BridgeConfig } from "./context.js";
import { registerMutationAppTool } from "./app-tool.js";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { forbidden, isReviewer, liveOwnerContextId, reviewOwnerContextId, requireWorkSessionMutation, requireWorkSessionRead } from "./shared.js";
import { z } from "zod/v4";
import {
  ExternalCatalogObservationSubmissionSchema,
  validateExternalCatalogObservation,
} from "../qualification/external-catalog-capture.js";

/**
 * L04: shared pause/resume/disable control. Keeps route status independent of
 * supervisor state; the caller may separately pause the supervisor when that is
 * operationally appropriate.
 */
async function setRouteStatus(
  config: BridgeConfig,
  routes: BridgeConfig["reviewRoutes"],
  workSessionId: string,
  expectedRevision: number | undefined,
  status: import("../review-handoff/route-store.js").ReviewRouteStatus,
  tool: string,
) {
  if (!isReviewer(config.principalRole)) return forbidden(config.principalRole, tool);
  const access = requireWorkSessionMutation(config, workSessionId);
  if (access) return access;
  if (!routes) return { content: [{ type: "text" as const, text: "Review routing is unavailable." }], isError: true };
  try {
    const route = routes.setStatus({ workSessionId, expectedRevision, status });
    config.eventStore.appendEvent({
      type: "review.route.status_changed",
      sessionId: workSessionId,
      payload: { routeId: route.id, status: route.status, revision: route.revision, routeEpoch: route.routeEpoch },
    });
    return {
      content: [{ type: "text" as const, text: `Review loop ${route.status}.` }],
      structuredContent: { routeId: route.id, status: route.status, revision: route.revision, routeEpoch: route.routeEpoch },
    };
  } catch (error) {
    return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], isError: true };
  }
}

export function registerHandoffTools(server: McpServer, config: BridgeConfig): void {
  const routes = config.reviewRoutes;

  registerMutationAppTool(
    server,
    "configure_review_loop",
    {
      title: "Configure review loop",
      description: "Enable/disable or pause durable review routing for a work session. Conversation IDs are correlation only; no background ChatGPT delivery is performed.",
      inputSchema: {
        workSessionId: z.string(),
        enabled: z.boolean(),
        mode: z.enum(["pinned_conversation", "isolated_review"]).default("isolated_review"),
        maxReviewRounds: z.number().int().min(1).max(10).default(3),
        pinnedConversationId: z.string().optional(),
        expectedRevision: z.number().int().min(1).optional(),
      },
      outputSchema: {
        routeId: z.string(),
        status: z.string(),
        revision: z.number(),
        routeEpoch: z.number(),
        completedReviewRounds: z.number(),
        maxReviewRounds: z.number(),
        warning: z.string().optional(),
      },
      _meta: {},
      annotations: { readOnlyHint: false },
    },
    config,
    async ({ workSessionId, enabled, mode, maxReviewRounds, pinnedConversationId, expectedRevision }) => {
      if (!isReviewer(config.principalRole)) return forbidden(config.principalRole, "configure_review_loop");
      const access = requireWorkSessionMutation(config, workSessionId);
      if (access) return access;
      if (!routes) return { content: [{ type: "text" as const, text: "Review routing is unavailable." }], isError: true };
      try {
        let route = routes.configure({
          workSessionId,
          ownerPrincipalId: config.principalId ?? `role:${config.principalRole ?? "reviewer"}`,
          ownerContextId: reviewOwnerContextId(config),
          enabled,
          mode,
          maxReviewRounds,
          pinnedConversationId,
          expectedRevision,
        });
        config.eventStore.appendEvent({
          type: "review.route.configured",
          sessionId: workSessionId,
          payload: { routeId: route.id, status: route.status, mode: route.mode, maxReviewRounds: route.maxReviewRounds, revision: route.revision, routeEpoch: route.routeEpoch },
        });
        // C05: warn once, when enabling a multi-round pinned review — the
        // configuration where repeated handoffs accumulate the most drift risk.
        // Persist the warning marker so repeated configuration calls do not
        // repeatedly surface a one-time operational warning.
        const qualifiesForWarning = route.status === "active" && route.mode === "pinned_conversation" && route.maxReviewRounds > 1;
        const warning = qualifiesForWarning && !route.warningAcknowledgedAt
          ? "Extended review sessions: repeated agent/reviewer handoffs increase opportunities for context drift, inaccurate assumptions, and missed regressions. Kontrol preserves the original objective and requires fresh verification, but additional rounds cannot guarantee greater accuracy. You can pause the loop or switch to fresh isolated reviews at any time."
          : undefined;
        if (warning) {
          const acknowledged = routes.markWarningAcknowledged({ workSessionId, expectedRevision: route.revision });
          route = acknowledged;
        }
        return {
          content: [{ type: "text" as const, text: `Review loop ${route.status}; round ${route.completedReviewRounds}/${route.maxReviewRounds}.${warning ? ` ${warning}` : ""}` }],
          structuredContent: {
            routeId: route.id,
            status: route.status,
            revision: route.revision,
            routeEpoch: route.routeEpoch,
            completedReviewRounds: route.completedReviewRounds,
            maxReviewRounds: route.maxReviewRounds,
            warning,
          },
        };
      } catch (error) {
        return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], isError: true };
      }
    },
  );

  registerAppTool(
    server,
    "claim_review_handoff",
    {
      title: "Claim review handoff",
      description: "Explicitly bind the current authorized reviewer context to one submission-scoped handoff.",
      inputSchema: {
        handoffId: z.string(),
        expectedRevision: z.number().int().min(1),
        destinationConversationId: z.string().optional(),
      },
      outputSchema: {
        handoffId: z.string(),
        status: z.string(),
        revision: z.number(),
        roundNumber: z.number(),
      },
      _meta: {},
      annotations: { readOnlyHint: false },
    },
    async ({ handoffId, expectedRevision, destinationConversationId }: { handoffId: string; expectedRevision: number; destinationConversationId?: string }) => {
      if (!isReviewer(config.principalRole)) return forbidden(config.principalRole, "claim_review_handoff");
      if (!routes) return { content: [{ type: "text" as const, text: "Review routing is unavailable." }], isError: true };
      const handoff = routes.getHandoffById(handoffId);
      if (!handoff) return { content: [{ type: "text" as const, text: `Unknown handoff: ${handoffId}` }], isError: true };
      try {
        const route = routes.getRouteBySession(handoff.workSessionId);
        if (!route) return { content: [{ type: "text" as const, text: "Review route not found for this handoff." }], isError: true };
        const claimed = routes.claimHandoff({
          handoffId,
          expectedRevision,
          principalId: config.principalId ?? `role:${config.principalRole ?? "reviewer"}`,
          ownerContextId: reviewOwnerContextId(config),
          destinationConversationId: destinationConversationId ?? reviewOwnerContextId(config),
          authorization: {
            conversationId: reviewOwnerContextId(config),
            freshConversationIds: [reviewOwnerContextId(config)],
          },
        });
        config.eventStore.appendEvent({
          type: "review.handoff.claimed",
          sessionId: claimed.workSessionId,
          payload: { handoffId: claimed.id, revision: claimed.revision, claimedByPrincipalId: claimed.claimedByPrincipalId, claimedByOwnerContextId: claimed.claimedByOwnerContextId },
        });
        return {
          content: [{ type: "text" as const, text: `Handoff ${claimed.id} claimed for round ${claimed.roundNumber}.` }],
          structuredContent: { handoffId: claimed.id, status: claimed.status, revision: claimed.revision, roundNumber: claimed.roundNumber },
        };
      } catch (error) {
        return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], isError: true };
      }
    },
  );

  registerMutationAppTool(
    server,
    "pause_review_loop",
    {
      title: "Pause review loop",
      description: "Pause autonomous review routing for a work session. New automation stops; already-committed feedback and pending submissions are preserved.",
      inputSchema: { workSessionId: z.string(), expectedRevision: z.number().int().min(1).optional() },
      outputSchema: { routeId: z.string(), status: z.string(), revision: z.number(), routeEpoch: z.number() },
      _meta: {},
      annotations: { readOnlyHint: false },
    },
    config,
    async ({ workSessionId, expectedRevision }) => setRouteStatus(config, routes, workSessionId, expectedRevision, "paused", "pause_review_loop"),
  );

  registerMutationAppTool(
    server,
    "resume_review_loop",
    {
      title: "Resume review loop",
      description: "Resume a paused review route, rebuilding the next action from durable state. Does not replay a stale request.",
      inputSchema: { workSessionId: z.string(), expectedRevision: z.number().int().min(1).optional() },
      outputSchema: { routeId: z.string(), status: z.string(), revision: z.number(), routeEpoch: z.number() },
      _meta: {},
      annotations: { readOnlyHint: false },
    },
    config,
    async ({ workSessionId, expectedRevision }) => setRouteStatus(config, routes, workSessionId, expectedRevision, "active", "resume_review_loop"),
  );

  registerAppTool(
    server,
    "get_review_loop_status",
    {
      title: "Get review loop status",
      description: "Read the durable review-route status, mode, round budget, and current destination for a work session.",
      inputSchema: { workSessionId: z.string() },
      outputSchema: {
        configured: z.boolean(),
        routeId: z.string().optional(),
        status: z.string().optional(),
        mode: z.string().optional(),
        completedReviewRounds: z.number().optional(),
        maxReviewRounds: z.number().optional(),
        routeEpoch: z.number().optional(),
        revision: z.number().optional(),
        pinnedConversationId: z.string().optional(),
      },
      _meta: {},
      annotations: { readOnlyHint: true },
    },
    async ({ workSessionId }: { workSessionId: string }) => {
      const denied = requireWorkSessionRead(config, workSessionId);
      if (denied) return denied;
      if (!routes) return { content: [{ type: "text" as const, text: "Review routing is unavailable." }], isError: true };
      const route = routes.getRouteBySession(workSessionId);
      if (!route) {
        return {
          content: [{ type: "text" as const, text: `No review route is configured for ${workSessionId}.` }],
          structuredContent: { configured: false },
        };
      }
      return {
        content: [{ type: "text" as const, text: `Review loop ${route.status}; round ${route.completedReviewRounds}/${route.maxReviewRounds}.` }],
        structuredContent: {
          configured: true,
          routeId: route.id,
          status: route.status,
          mode: route.mode,
          completedReviewRounds: route.completedReviewRounds,
          maxReviewRounds: route.maxReviewRounds,
          routeEpoch: route.routeEpoch,
          revision: route.revision,
          pinnedConversationId: route.pinnedConversationId,
        },
      };
    },
  );

  registerMutationAppTool(
    server,
    "submit_handoff_feedback",
    {
      title: "Submit handoff feedback",
      description: "Return authorized reviewer feedback through the exact claimed handoff to the original work session.",
      inputSchema: {
        handoffId: z.string(),
        expectedRevision: z.number().int().min(1),
        verdict: z.enum(["approve", "changes_requested", "reject"]),
        comments: z.string().optional(),
        requiredActions: z.array(z.string()).optional(),
        allowedNextActions: z.array(z.string()).optional(),
      },
      outputSchema: {
        status: z.string(),
        verdict: z.string(),
        submissionId: z.string().optional(),
        handoffId: z.string().optional(),
        handoffRevision: z.number().optional(),
        handoffStatus: z.string().optional(),
      },
      _meta: {},
      annotations: { readOnlyHint: false },
    },
    config,
    async ({ handoffId, expectedRevision, verdict, comments, requiredActions, allowedNextActions }) => {
      if (!isReviewer(config.principalRole)) return forbidden(config.principalRole, "submit_handoff_feedback");
      if (!routes) return { content: [{ type: "text" as const, text: "Review routing is unavailable." }], isError: true };
      try {
        const handoff = routes.getHandoffById(handoffId);
        if (!handoff) return { content: [{ type: "text" as const, text: `Unknown handoff: ${handoffId}` }], isError: true };
        if (handoff.claimedByOwnerContextId !== reviewOwnerContextId(config)) {
          return forbidden(config.principalRole, "submit_handoff_feedback");
        }
        if (handoff.revision !== expectedRevision) {
          return { content: [{ type: "text" as const, text: "Stale handoff revision." }], isError: true };
        }
        const result = await config.reviewWorkflow.provideFeedback({
          sessionId: handoff.workSessionId,
          submissionId: handoff.submissionId,
          reviewerOwnerContextId: reviewOwnerContextId(config),
          invocationOrigin: "authenticated_reviewer",
          diffSha256: handoff.diffSha256,
          reviewEpoch: handoff.reviewEpoch,
          verdict,
          comments,
          requiredActions,
          allowedNextActions,
          reviewerId: config.principalId ?? "handoff-reviewer",
        });
        return {
          content: [{ type: "text" as const, text: `Handoff ${handoff.id} feedback recorded: ${verdict}.` }],
          structuredContent: {
            status: result.status,
            verdict,
            submissionId: result.submissionId,
            handoffId: result.handoffId,
            handoffRevision: result.handoffRevision,
            handoffStatus: result.handoffStatus,
          },
        };
      } catch (error) {
        return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], isError: true };
      }
    },
  );

  registerAppTool(
    server,
    "get_review_handoff_status",
    {
      title: "Get review handoff status",
      description: "Read-only delivery/review status for a claimed handoff.",
      inputSchema: { handoffId: z.string() },
      outputSchema: { handoffId: z.string(), status: z.string(), revision: z.number() },
      _meta: {},
      annotations: { readOnlyHint: true },
    },
    async ({ handoffId }: { handoffId: string }) => {
      const handoff = routes?.getHandoffById(handoffId);
      if (!handoff) return { content: [{ type: "text" as const, text: `Unknown handoff: ${handoffId}` }], isError: true };
      if (handoff.claimedByOwnerContextId !== reviewOwnerContextId(config)) {
        return forbidden(config.principalRole, "get_review_handoff_status");
      }
      return {
        content: [{ type: "text" as const, text: `Handoff ${handoffId}: ${handoff.status}` }],
        structuredContent: { handoffId: handoff.id, status: handoff.status, revision: handoff.revision },
      };
    },
  );

  registerMutationAppTool(
    server,
    "release_review_handoff",
    {
      title: "Release review handoff",
      description: "Release an unused or abandoned handoff claim so another authorized reviewer can claim it.",
      inputSchema: { handoffId: z.string(), expectedRevision: z.number().int().min(1) },
      outputSchema: { handoffId: z.string(), status: z.string() },
      _meta: {},
      annotations: { readOnlyHint: false },
    },
    config,
    async ({ handoffId, expectedRevision }) => {
      if (!isReviewer(config.principalRole)) return forbidden(config.principalRole, "release_review_handoff");
      try {
        const handoff = routes?.getHandoffById(handoffId);
        if (!handoff) return { content: [{ type: "text" as const, text: `Unknown handoff: ${handoffId}` }], isError: true };
        if (handoff.claimedByOwnerContextId !== reviewOwnerContextId(config)) {
          return forbidden(config.principalRole, "release_review_handoff");
        }
        const released = routes!.markHandoffStatus({
          handoffId: handoff.id,
          expectedRevision,
          nextStatus: "awaiting_attachment",
          completed: false,
        });
        config.eventStore.appendEvent({
          type: "review.handoff.released",
          sessionId: handoff.workSessionId,
          payload: { handoffId: handoff.id, releasedBy: config.principalId },
        });
        return {
          content: [{ type: "text" as const, text: `Handoff ${handoffId} released.` }],
          structuredContent: { handoffId: handoff.id, status: released.status },
        };
      } catch (error) {
        return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], isError: true };
      }
    },
  );

  registerAppTool(
    server,
    "get_review_handoff",
    {
      title: "Get review handoff",
      description: "Retrieve the bounded review handoff packet for an explicitly claimed reviewer context.",
      inputSchema: { handoffId: z.string() },
      outputSchema: {
        handoffId: z.string(),
        status: z.string(),
        revision: z.number(),
        workSessionId: z.string(),
        submissionId: z.string(),
        reviewEpoch: z.number(),
        snapshotKind: z.string(),
        snapshotRef: z.string(),
        diffSha256: z.string(),
        roundNumber: z.number(),
        externalCatalogAttachments: z.array(z.object({
          attachmentId: z.string(),
          observationRecordId: z.string(),
          investigationDirection: z.string(),
          attachedAt: z.string(),
          expiresAt: z.string(),
          contentSha256: z.string(),
        })),
      },
      _meta: {},
      annotations: { readOnlyHint: true },
    },
    async ({ handoffId }: { handoffId: string }) => {
      if (!routes) return { content: [{ type: "text" as const, text: "Review routing is unavailable." }], isError: true };
      const handoff = routes.getHandoffById(handoffId);
      if (!handoff) return { content: [{ type: "text" as const, text: `Unknown handoff: ${handoffId}` }], isError: true };
      if (handoff.claimedByOwnerContextId !== reviewOwnerContextId(config)) {
        return forbidden(config.principalRole, "get_review_handoff");
      }
      const externalCatalogAttachments = config.qualificationEvidence
        ?.listHandoffObservationAttachments(handoffId)
        .map(({ attachmentId, observationRecordId, investigationDirection, attachedAt, expiresAt, contentSha256 }) => ({
          attachmentId,
          observationRecordId,
          investigationDirection,
          attachedAt,
          expiresAt,
          contentSha256,
        })) ?? [];
      return {
        content: [{ type: "text" as const, text: `Handoff ${handoffId}: ${handoff.status}` }],
        structuredContent: {
          handoffId: handoff.id,
          status: handoff.status,
          revision: handoff.revision,
          workSessionId: handoff.workSessionId,
          submissionId: handoff.submissionId,
          reviewEpoch: handoff.reviewEpoch,
          snapshotKind: handoff.snapshotKind,
          snapshotRef: handoff.snapshotRef,
          diffSha256: handoff.diffSha256,
          roundNumber: handoff.roundNumber,
          externalCatalogAttachments,
        },
      };
    },
  );

  registerMutationAppTool(
    server,
    "submit_external_catalog_observation",
    {
      title: "Submit external catalog observation",
      description: "Persist a reviewer-submitted external-host observation and attach it to the currently claimed review handoff. A model or operator supplied registry remains operator_reported; Kontrol never promotes it to verified host registration.",
      inputSchema: {
        handoffId: z.string().min(1).max(256),
        investigationDirection: z.string().trim().min(1).max(4_000),
        soakId: z.string().min(1).max(256).optional(),
        observation: ExternalCatalogObservationSubmissionSchema,
      },
      outputSchema: {
        recordId: z.string(),
        contentSha256: z.string(),
        observationSource: z.literal("operator_reported"),
        status: z.enum(["host_capture_unsupported", "operator_reported_match", "operator_reported_mismatch"]),
        validationReasons: z.array(z.string()),
        attachmentId: z.string(),
        qualificationAssociationRecordId: z.string().optional(),
        qualificationAssociationContentSha256: z.string().optional(),
      },
      _meta: {},
      annotations: { readOnlyHint: false },
    },
    config,
    async ({ handoffId, investigationDirection, soakId, observation }: {
      handoffId: string;
      investigationDirection: string;
      soakId?: string;
      observation: unknown;
    }) => {
      if (!isReviewer(config.principalRole)) return forbidden(config.principalRole, "submit_external_catalog_observation");
      if (!routes || !config.qualificationEvidence) {
        return { content: [{ type: "text" as const, text: "External catalog evidence storage is unavailable." }], isError: true };
      }
      const handoff = routes.getHandoffById(handoffId);
      if (!handoff) return { content: [{ type: "text" as const, text: `Unknown handoff: ${handoffId}` }], isError: true };
      const denied = requireWorkSessionRead(config, handoff.workSessionId);
      if (denied) return denied;
      if (handoff.claimedByOwnerContextId !== reviewOwnerContextId(config)) {
        return forbidden(config.principalRole, "submit_external_catalog_observation");
      }
      try {
        const validated = validateExternalCatalogObservation(observation);
        if (config.toolSurfaceVersion && validated.serverVersion !== config.toolSurfaceVersion) {
          return {
            content: [{ type: "text" as const, text: "The observation server version does not match this Kontrol process." }],
            structuredContent: { code: "build_identity_mismatch" },
            isError: true,
          };
        }
        const record = config.qualificationEvidence.recordExternalCatalogObservation(validated, {
          serverBuildId: config.serverConfig?.expectedBuildId,
          workSessionId: handoff.workSessionId,
          handoffId: handoff.id,
        });
        const attachment = config.qualificationEvidence.attachObservationToHandoff({
          observationRecordId: record.recordId,
          workSessionId: handoff.workSessionId,
          handoffId: handoff.id,
          reviewerPrincipalId: config.principalId ?? `role:${config.principalRole}`,
          reviewerOwnerContextId: reviewOwnerContextId(config),
          investigationDirection,
        });
        let qualificationAssociation: ReturnType<NonNullable<BridgeConfig["qualificationEvidence"]>["recordQualificationAssociation"]> | undefined;
        const serverBuildId = config.serverConfig?.expectedBuildId;
        const matchingEvidence = serverBuildId
          ? config.qualificationEvidence.listRecent({
              serverBuildId,
              captureId: record.captureId,
              sessionIdSha256: record.sessionIdSha256,
              limit: 500,
            })
          : [];
        const acknowledgement = matchingEvidence.find((item) => item.recordType === "catalog_acknowledgement" && item.status === "accepted");
        const streaming = record.streamingOperationId
          ? matchingEvidence.find((item) => item.recordType === "external_sse" && item.operationId === record.streamingOperationId)
          : undefined;
        if (serverBuildId && acknowledgement && (!record.streamingOperationId || streaming)) {
          qualificationAssociation = config.qualificationEvidence.recordQualificationAssociation({
            serverBuildId,
            captureId: record.captureId,
            sessionIdSha256: record.sessionIdSha256,
            soakId: soakId ?? record.soakId,
            observationRecordId: record.recordId,
            acknowledgementRecordId: acknowledgement.recordId,
            ...(streaming?.recordType === "external_sse" ? { externalSseRecordId: streaming.recordId } : {}),
          });
        }
        config.eventStore.appendEvent({
          type: "review.handoff.external_catalog_observation_attached",
          sessionId: handoff.workSessionId,
          payload: {
            handoffId: handoff.id,
            observationRecordId: record.recordId,
            observationContentSha256: record.contentSha256,
            attachmentId: attachment.attachmentId,
            attachmentContentSha256: attachment.contentSha256,
            observationSource: record.observationSource,
            status: record.status,
            investigationDirection,
          },
        });
        return {
          content: [{ type: "text" as const, text: record.status === "host_capture_unsupported"
            ? `Observation ${record.recordId} stored. Host registry capture is unsupported; this record remains operator_reported.`
            : `Observation ${record.recordId} stored as operator_reported; it is not machine-verified host registration.` }],
          structuredContent: {
            recordId: record.recordId,
            contentSha256: record.contentSha256,
            observationSource: record.observationSource,
            status: record.status,
            validationReasons: record.validationReasons,
            attachmentId: attachment.attachmentId,
            ...(qualificationAssociation ? {
              qualificationAssociationRecordId: qualificationAssociation.recordId,
              qualificationAssociationContentSha256: qualificationAssociation.contentSha256,
            } : {}),
          },
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: error instanceof Error ? error.message : "Invalid external catalog observation." }],
          structuredContent: { code: error instanceof Error && "code" in error ? error.code : "invalid_observation" },
          isError: true,
        };
      }
    },
  );

  registerAppTool(
    server,
    "get_external_catalog_observation",
    {
      title: "Get external catalog observation",
      description: "Read one content-addressed external-host observation through the claimed reviewer handoff that owns it.",
      inputSchema: { recordId: z.string().min(1).max(128) },
      outputSchema: { observation: z.record(z.string(), z.unknown()) },
      _meta: {},
      annotations: { readOnlyHint: true },
    },
    async ({ recordId }: { recordId: string }) => {
      if (!isReviewer(config.principalRole)) return forbidden(config.principalRole, "get_external_catalog_observation");
      const record = config.qualificationEvidence?.getExternalCatalogObservation(recordId);
      if (!record) return { content: [{ type: "text" as const, text: "External catalog observation not found or expired." }], isError: true };
      const handoff = record.handoffId ? routes?.getHandoffById(record.handoffId) : undefined;
      if (!handoff || handoff.workSessionId !== record.workSessionId
        || handoff.claimedByOwnerContextId !== reviewOwnerContextId(config)) {
        return forbidden(config.principalRole, "get_external_catalog_observation");
      }
      const denied = requireWorkSessionRead(config, handoff.workSessionId);
      if (denied) return denied;
      return {
        content: [{ type: "text" as const, text: `Observation ${record.recordId}: ${record.status} (${record.observationSource}).` }],
        structuredContent: { observation: record },
      };
    },
  );
}
