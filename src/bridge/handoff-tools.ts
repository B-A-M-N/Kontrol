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
        const route = routes.configure({
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
        const warning = route.status === "active" && route.mode === "pinned_conversation" && route.maxReviewRounds > 1
          ? "Extended review sessions: repeated agent/reviewer handoffs increase opportunities for context drift, inaccurate assumptions, and missed regressions. Kontrol preserves the original objective and requires fresh verification, but additional rounds cannot guarantee greater accuracy. You can pause the loop or switch to fresh isolated reviews at any time."
          : undefined;
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
      try {
        const claimed = routes.claimHandoff({
          handoffId,
          expectedRevision,
          principalId: config.principalId ?? `role:${config.principalRole ?? "reviewer"}`,
          ownerContextId: reviewOwnerContextId(config),
          destinationConversationId,
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
          diffSha256: handoff.diffSha256,
          reviewEpoch: handoff.reviewEpoch,
          verdict,
          comments,
          requiredActions,
          allowedNextActions,
          reviewerId: config.principalId ?? "handoff-reviewer",
        });
        routes.markHandoffStatus({
          handoffId: handoff.id,
          expectedRevision,
          nextStatus: "feedback_committed",
          completed: true,
        });
        config.eventStore.appendEvent({
          type: "review.handoff.feedback_committed",
          sessionId: handoff.workSessionId,
          payload: { handoffId: handoff.id, verdict, submissionId: handoff.submissionId },
        });
        return {
          content: [{ type: "text" as const, text: `Handoff ${handoff.id} feedback recorded: ${verdict}.` }],
          structuredContent: { status: result.status, verdict, submissionId: result.submissionId },
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
      },
      _meta: {},
      annotations: { readOnlyHint: true },
    },
    async ({ handoffId }: { handoffId: string }) => {
      if (!routes) return { content: [{ type: "text" as const, text: "Review routing is unavailable." }], isError: true };
      const handoff = (routes as unknown as { getHandoffById?: (id: string) => unknown }).getHandoffById?.(handoffId) as { status?: string; claimedByOwnerContextId?: string; workSessionId?: string } | undefined;
      if (!handoff) return { content: [{ type: "text" as const, text: `Unknown handoff: ${handoffId}` }], isError: true };
      if (handoff.claimedByOwnerContextId !== reviewOwnerContextId(config)) {
        return forbidden(config.principalRole, "get_review_handoff");
      }
      return {
        content: [{ type: "text" as const, text: `Handoff ${handoffId}: ${handoff.status}` }],
        structuredContent: handoff as never,
      };
    },
  );
}
