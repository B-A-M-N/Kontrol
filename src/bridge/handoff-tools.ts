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
import { forbidden, isReviewer, reviewClaimContextId, reviewOwnerContextId, reviewerThreadContextId, requireWorkSessionMutation, requireWorkSessionRead } from "./shared.js";
import { z } from "zod/v4";
import { and, desc, eq, sql } from "drizzle-orm";
import { createReviewPacket } from "../review-thread/review-packet.js";
import { reviewBrowserTurns, reviewThreadMessages } from "../db/schema.js";
import { createHash } from "node:crypto";
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
  const handoffContextId = (workSessionId: string) => {
    const route = routes?.getRouteBySession(workSessionId);
    return route ? reviewClaimContextId(config, route.mode) : undefined;
  };
  const hasCurrentHandoffClaim = (handoff: NonNullable<ReturnType<NonNullable<typeof routes>["getHandoffById"]>>): boolean => {
    if (!isReviewer(config.principalRole)) return false;
    const route = routes?.getRouteBySession(handoff.workSessionId);
    if (!route || (route.status !== "active" && route.status !== "paused") || handoff.routeEpoch !== route.routeEpoch
      || handoff.status !== "claimed" || !handoff.claimExpiresAt || Date.parse(handoff.claimExpiresAt) <= Date.now()) return false;
    const contextId = reviewClaimContextId(config, route.mode);
    const principalId = config.principalId ?? `role:${config.principalRole ?? "reviewer"}`;
    if (!contextId || handoff.claimedByOwnerContextId !== contextId || handoff.claimedByPrincipalId !== principalId) return false;
    if (route.mode === "isolated_review") {
      const thread = config.reviewThreads?.getForRoute(route.id, route.routeEpoch);
      return Boolean(thread && (thread.status === "active" || thread.status === "paused")
        && thread.reviewerPrincipalId === principalId && thread.reviewerContextId === contextId);
    }
    return true;
  };

  registerMutationAppTool(
    server,
    "configure_review_loop",
    {
      title: "Configure review loop",
      description: "Enable, disable, or pause durable review routing for a work session. Select mcp_app for the current host conversation, native_cdp for the dedicated private Chromium profile, or manual delivery.",
      inputSchema: {
        workSessionId: z.string(),
        enabled: z.boolean(),
        mode: z.enum(["pinned_conversation", "isolated_review"]).default("isolated_review"),
        deliveryTransport: z.enum(["mcp_app", "native_cdp", "manual"]).optional(),
        browserProfileId: z.string().optional(),
        maxReviewRounds: z.number().int().min(1).max(10).default(3),
        pinnedConversationId: z.string().optional(),
        expectedRevision: z.number().int().min(1).optional(),
      },
      outputSchema: {
        routeId: z.string(),
        status: z.string(),
        revision: z.number(),
        routeEpoch: z.number(),
        deliveryTransport: z.string(),
        completedReviewRounds: z.number(),
        admittedReviewRounds: z.number(),
        maxReviewRounds: z.number(),
        warning: z.string().optional(),
      },
      _meta: {},
      annotations: { readOnlyHint: false },
    },
    config,
    async ({ workSessionId, enabled, mode, deliveryTransport, browserProfileId, maxReviewRounds, pinnedConversationId, expectedRevision }) => {
      if (!isReviewer(config.principalRole)) return forbidden(config.principalRole, "configure_review_loop");
      const access = requireWorkSessionMutation(config, workSessionId);
      if (access) return access;
      if (!routes) return { content: [{ type: "text" as const, text: "Review routing is unavailable." }], isError: true };
      try {
        if (deliveryTransport === "native_cdp") {
          const ownerPrincipalId = config.principalId;
          const selectedProfileId = browserProfileId ?? routes.getRouteBySession(workSessionId)?.browserProfileId;
          const profile = selectedProfileId ? config.reviewBrowserController?.profiles.get(selectedProfileId) : undefined;
          if (!ownerPrincipalId || !profile || profile.ownerPrincipalId !== ownerPrincipalId) {
            throw new Error("Native CDP review delivery requires a browser profile owned by the authenticated reviewer.");
          }
        }
        let route = routes.configure({
          workSessionId,
          ownerPrincipalId: config.principalId ?? `role:${config.principalRole ?? "reviewer"}`,
          ownerContextId: reviewOwnerContextId(config),
          enabled,
          mode,
          maxReviewRounds,
          pinnedConversationId,
          deliveryTransport,
          browserProfileId,
          expectedRevision,
        });
        config.eventStore.appendEvent({
          type: "review.route.configured",
          sessionId: workSessionId,
          payload: { routeId: route.id, status: route.status, mode: route.mode, deliveryTransport: route.deliveryTransport, maxReviewRounds: route.maxReviewRounds, revision: route.revision, routeEpoch: route.routeEpoch },
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
            deliveryTransport: route.deliveryTransport,
            completedReviewRounds: route.completedReviewRounds,
            admittedReviewRounds: route.admittedReviewRounds,
            maxReviewRounds: route.maxReviewRounds,
            warning,
          },
        };
      } catch (error) {
        return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], isError: true };
      }
    },
  );

  registerMutationAppTool(server, "create_reviewer_browser_profile", {
    title: "Create reviewer browser profile",
    description: "Create a private persistent Chromium profile owned by the authenticated reviewer. Profile data stays in Kontrol state.",
    inputSchema: { profileId: z.string(), mode: z.enum(["headed", "headless"]).default("headed") },
    outputSchema: { profileId: z.string(), mode: z.string(), status: z.string(), generation: z.number() }, _meta: {}, annotations: { readOnlyHint: false },
  }, config, async ({ profileId, mode }) => {
    if (!isReviewer(config.principalRole)) return forbidden(config.principalRole, "create_reviewer_browser_profile");
    if (!config.reviewBrowserController || !config.principalId) return { content: [{ type: "text" as const, text: "Authenticated reviewer browser control is unavailable." }], isError: true };
    try {
      const profile = config.reviewBrowserController.createProfile({ profileId, ownerPrincipalId: config.principalId, mode });
      return { content: [{ type: "text" as const, text: `Reviewer browser profile ${profile.id} is ${profile.status}.` }], structuredContent: { profileId: profile.id, mode: profile.mode, status: profile.status, generation: profile.generation } };
    } catch (error) { return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], isError: true }; }
  });

  registerMutationAppTool(server, "start_reviewer_browser_profile", {
    title: "Start reviewer browser profile",
    description: "Start or switch the dedicated Chromium profile. Headed and headless modes share one persistent profile and cannot overlap.",
    inputSchema: { profileId: z.string(), mode: z.enum(["headed", "headless"]).optional() },
    outputSchema: { profileId: z.string(), mode: z.string(), status: z.string(), generation: z.number() }, _meta: {}, annotations: { readOnlyHint: false },
  }, config, async ({ profileId, mode }) => {
    if (!isReviewer(config.principalRole)) return forbidden(config.principalRole, "start_reviewer_browser_profile");
    const owner = config.reviewBrowserController?.profiles.get(profileId);
    if (!owner || owner.ownerPrincipalId !== config.principalId) return { content: [{ type: "text" as const, text: "Reviewer browser profile owner authorization failed." }], isError: true };
    try {
      const profile = await config.reviewBrowserController!.startProfile(profileId, mode);
      return { content: [{ type: "text" as const, text: `Reviewer browser profile ${profile.id} is ${profile.status} in ${profile.mode} mode.` }], structuredContent: { profileId: profile.id, mode: profile.mode, status: profile.status, generation: profile.generation } };
    } catch (error) { return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], isError: true }; }
  });

  registerMutationAppTool(server, "stop_reviewer_browser_profile", {
    title: "Stop reviewer browser profile",
    description: "Stop the dedicated Chromium process after active or uncertain review turns are reconciled.",
    inputSchema: { profileId: z.string() },
    outputSchema: { profileId: z.string(), status: z.string(), generation: z.number() }, _meta: {}, annotations: { readOnlyHint: false },
  }, config, async ({ profileId }) => {
    if (!isReviewer(config.principalRole)) return forbidden(config.principalRole, "stop_reviewer_browser_profile");
    const owner = config.reviewBrowserController?.profiles.get(profileId);
    if (!owner || owner.ownerPrincipalId !== config.principalId) return { content: [{ type: "text" as const, text: "Reviewer browser profile owner authorization failed." }], isError: true };
    try {
      const profile = await config.reviewBrowserController!.stopProfile(profileId);
      return { content: [{ type: "text" as const, text: `Reviewer browser profile ${profile.id} is ${profile.status}.` }], structuredContent: { profileId, status: profile.status, generation: profile.generation } };
    } catch (error) { return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], isError: true }; }
  });

  registerMutationAppTool(server, "open_reviewer_browser_login", {
    title: "Open reviewer browser login",
    description: "Compatibility login opener for an existing controlled browser. If the identity provider rejects a software-controlled browser, use begin_reviewer_browser_auth and complete_reviewer_browser_auth to sign in in ordinary Chrome before Kontrol enables CDP.",
    inputSchema: { profileId: z.string() }, outputSchema: { profileId: z.string(), targetId: z.string() }, _meta: {}, annotations: { readOnlyHint: false },
  }, config, async ({ profileId }) => {
    if (!isReviewer(config.principalRole)) return forbidden(config.principalRole, "open_reviewer_browser_login");
    const owner = config.reviewBrowserController?.profiles.get(profileId);
    if (!owner || owner.ownerPrincipalId !== config.principalId) return { content: [{ type: "text" as const, text: "Reviewer browser profile owner authorization failed." }], isError: true };
    try {
      const opened = await config.reviewBrowserController!.openLoginPage(profileId);
      return { content: [{ type: "text" as const, text: "ChatGPT opened in the dedicated headed reviewer browser. Complete login or verification manually, then bind the exact conversation." }], structuredContent: { profileId, targetId: opened.targetId } };
    } catch (error) { return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], isError: true }; }
  });

  registerMutationAppTool(server, "begin_reviewer_browser_auth", {
    title: "Begin reviewer browser authentication",
    description: "Open the dedicated persistent profile in official Chrome without remote debugging so the reviewer can sign in manually. Never send passwords, one-time codes, recovery codes, or cookies through Kontrol.",
    inputSchema: { profileId: z.string() },
    outputSchema: { profileId: z.string(), generation: z.number(), browserPid: z.number().optional() },
    _meta: {}, annotations: { readOnlyHint: false },
  }, config, async ({ profileId }) => {
    if (!isReviewer(config.principalRole)) return forbidden(config.principalRole, "begin_reviewer_browser_auth");
    const owner = config.reviewBrowserController?.profiles.get(profileId);
    if (!owner || owner.ownerPrincipalId !== config.principalId) return { content: [{ type: "text" as const, text: "Reviewer browser profile owner authorization failed." }], isError: true };
    try {
      const result = await config.reviewBrowserController!.beginManualAuthentication(profileId);
      return { content: [{ type: "text" as const, text: "Official Chrome opened without remote debugging. Sign in manually, close every Chrome window for this profile, then call complete_reviewer_browser_auth." }], structuredContent: result };
    } catch (error) { return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], isError: true }; }
  });

  registerMutationAppTool(server, "complete_reviewer_browser_auth", {
    title: "Complete reviewer browser authentication",
    description: "After ordinary Chrome has exited, relaunch the same dedicated profile under loopback CDP and verify ChatGPT authentication before offering exact conversation targets.",
    inputSchema: { profileId: z.string() },
    outputSchema: { status: z.enum(["authenticated", "auth_required", "auth_blocked"]), reason: z.string().optional(), targets: z.array(z.object({ targetId: z.string(), url: z.string(), title: z.string() })) },
    _meta: {}, annotations: { readOnlyHint: false },
  }, config, async ({ profileId }) => {
    if (!isReviewer(config.principalRole)) return forbidden(config.principalRole, "complete_reviewer_browser_auth");
    const owner = config.reviewBrowserController?.profiles.get(profileId);
    if (!owner || owner.ownerPrincipalId !== config.principalId) return { content: [{ type: "text" as const, text: "Reviewer browser profile owner authorization failed." }], isError: true };
    try {
      const result = await config.reviewBrowserController!.completeManualAuthentication(profileId);
      const text = result.status === "authenticated"
        ? "ChatGPT authentication survived the controlled-browser handoff. Select an exact conversation target to bind."
        : `Authentication handoff did not verify (${result.reason ?? result.status}). ${result.status === "auth_blocked" ? "This authentication method is blocked; use an authorized alternative instead of retrying the controlled login." : "Keep the reviewer route and queued submission intact, authenticate manually, then retry the handoff."}`;
      return { content: [{ type: "text" as const, text }], structuredContent: result };
    } catch (error) { return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], isError: true }; }
  });

  registerMutationAppTool(server, "bind_reviewer_conversation", {
    title: "Bind reviewer conversation",
    description: "Bind an explicitly selected ChatGPT tab to the active reviewer thread and its dedicated profile.",
    inputSchema: { profileId: z.string(), reviewThreadId: z.string(), targetId: z.string() },
    outputSchema: { reviewThreadId: z.string(), profileId: z.string(), conversationKey: z.string(), status: z.string() }, _meta: {}, annotations: { readOnlyHint: false },
  }, config, async ({ profileId, reviewThreadId, targetId }) => {
    if (!isReviewer(config.principalRole) || !config.principalId) return forbidden(config.principalRole, "bind_reviewer_conversation");
    try {
      const binding = await config.reviewBrowserController?.bindConversation({ profileId, reviewThreadId, targetId, principalId: config.principalId });
      if (!binding?.conversationKey) throw new Error("Reviewer conversation binding failed.");
      return { content: [{ type: "text" as const, text: `Reviewer thread bound to ChatGPT conversation ${binding.conversationKey}.` }], structuredContent: { reviewThreadId, profileId, conversationKey: binding.conversationKey, status: binding.status } };
    } catch (error) { return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], isError: true }; }
  });

  // The two activation tools below are deliberately NOT mutation tools: they
  // take no clientMutationId and produce no canonical request receipt. The
  // one-time expiring activation grant is their idempotency fence - it is
  // consumed atomically, so a replay of the same secret fails closed instead
  // of binding the thread twice. The durable bridge mutations elsewhere in
  // this file use registerMutationAppTool because they can legitimately be
  // retried and therefore need a replayable receipt.
  registerAppTool(
    server,
    "prepare_review_thread_activation",
    {
      title: "Prepare reviewer thread activation",
      description: "Create a one-time, expiring activation grant for an explicitly opened reviewer context. Kontrol cannot silently create a ChatGPT conversation.",
      inputSchema: { workSessionId: z.string(), reviewerPrincipalId: z.string().min(1), ttlMs: z.number().int().min(60_000).max(86_400_000).optional() },
      outputSchema: { threadId: z.string(), activationSecret: z.string(), expiresAt: z.string() },
      _meta: {},
      annotations: { readOnlyHint: false },
    },
    async ({ workSessionId, reviewerPrincipalId, ttlMs }: { workSessionId: string; reviewerPrincipalId: string; ttlMs?: number }) => {
      if (!isReviewer(config.principalRole)) return forbidden(config.principalRole, "prepare_review_thread_activation");
      const access = requireWorkSessionMutation(config, workSessionId);
      if (access) return access;
      if (!config.reviewThreads || !routes) return { content: [{ type: "text" as const, text: "Review thread storage is unavailable." }], isError: true };
      try {
        const route = routes.getRouteBySession(workSessionId);
        if (!route || route.status !== "active") throw new Error("An active review route is required.");
        const grant = config.reviewThreads.createActivation({ routeId: route.id, ownerPrincipalId: config.principalId ?? `role:${config.principalRole ?? "reviewer"}`, reviewerPrincipalId, ttlMs });
        return { content: [{ type: "text" as const, text: `Activation grant prepared for reviewer ${reviewerPrincipalId}; use it once in the fresh reviewer context before ${grant.expiresAt}.` }], structuredContent: grant };
      } catch (error) {
        return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], isError: true };
      }
    },
  );

  // Consuming a one-time grant: see the note above
  // prepare_review_thread_activation for why this tool carries no mutation
  // receipt.
  registerAppTool(
    server,
    "activate_review_thread",
    {
      title: "Activate reviewer thread",
      description: "Consume a one-time owner-issued grant and bind this authenticated reviewer context to the persistent Kontrol review thread.",
      inputSchema: { activationSecret: z.string().min(20), hostKind: z.enum(["chatgpt", "kontrol_ui", "external"]).optional(), hostConversationId: z.string().optional() },
      outputSchema: { threadId: z.string(), routeId: z.string(), routeEpoch: z.number(), status: z.string(), hostBindingVerified: z.boolean() },
      _meta: {},
      annotations: { readOnlyHint: false },
    },
    async ({ activationSecret, hostKind, hostConversationId }: { activationSecret: string; hostKind?: "chatgpt" | "kontrol_ui" | "external"; hostConversationId?: string }) => {
      if (!isReviewer(config.principalRole)) return forbidden(config.principalRole, "activate_review_thread");
      if (!config.reviewThreads) return { content: [{ type: "text" as const, text: "Review thread storage is unavailable." }], isError: true };
      const contextId = reviewerThreadContextId(config);
      if (!contextId) return { content: [{ type: "text" as const, text: "A server-issued authenticated MCP reviewer session is required to activate this thread." }], isError: true };
      try {
        const thread = config.reviewThreads.activate({
          activationSecret,
          principalId: config.principalId ?? `role:${config.principalRole ?? "reviewer"}`,
          contextId,
          hostKind,
          hostConversationId,
        });
        config.eventStore.appendEvent({ type: "review.thread.activated", sessionId: thread.workSessionId, payload: { threadId: thread.id, routeId: thread.routeId, routeEpoch: thread.routeEpoch, reviewerPrincipalId: thread.reviewerPrincipalId, hostBindingVerified: false } });
        return { content: [{ type: "text" as const, text: `Review thread ${thread.id} activated for route epoch ${thread.routeEpoch}. Host conversation identity remains unverified.` }], structuredContent: { threadId: thread.id, routeId: thread.routeId, routeEpoch: thread.routeEpoch, status: thread.status, hostBindingVerified: thread.hostBindingVerified } };
      } catch (error) {
        return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], isError: true };
      }
    },
  );

  registerAppTool(
    server,
    "claim_review_thread_deliveries",
    {
      title: "Claim queued review messages",
      description: "Claim queued packets for delivery into this explicitly activated WebUI conversation. Claims are durable so uncertain host responses are not blindly resent.",
      inputSchema: { routeId: z.string().optional(), routeEpoch: z.number().int().positive().optional() },
      outputSchema: { messages: z.array(z.object({ threadId: z.string(), handoffId: z.string(), handoffRevision: z.number(), payloadSha256: z.string(), packet: z.record(z.string(), z.unknown()) })) },
      _meta: {},
      annotations: { readOnlyHint: false },
    },
    async ({ routeId, routeEpoch }: { routeId?: string; routeEpoch?: number }) => {
      if (!isReviewer(config.principalRole)) return forbidden(config.principalRole, "claim_review_thread_deliveries");
      if (!config.db || !config.reviewThreads) return { content: [{ type: "text" as const, text: "Review thread storage is unavailable." }], isError: true };
      const contextId = reviewerThreadContextId(config);
      if (!contextId) return { content: [{ type: "text" as const, text: "A server-issued authenticated MCP reviewer session is required." }], isError: true };
      const threads = config.reviewThreads.listForContext(config.principalId ?? `role:${config.principalRole ?? "reviewer"}`, contextId)
        .filter((thread) => (!routeId || thread.routeId === routeId) && (routeEpoch === undefined || thread.routeEpoch === routeEpoch));
      const messages = config.db.sqlite.transaction(() => {
        const claimed: Array<{ threadId: string; handoffId: string; handoffRevision: number; payloadSha256: string; packet: Record<string, unknown> }> = [];
        for (const thread of threads) {
          const route = routes?.getRouteBySession(thread.workSessionId);
          if (!route || route.routeEpoch !== thread.routeEpoch || route.status !== "active") continue;
          const queued = config.db!.db.select().from(reviewThreadMessages).where(and(
            eq(reviewThreadMessages.threadId, thread.id), eq(reviewThreadMessages.status, "queued"),
          )).all();
          for (const row of queued) {
            const handoff = routes?.getHandoffById(row.handoffId);
            if (!handoff || handoff.routeEpoch !== thread.routeEpoch || handoff.status === "feedback_committed") continue;
            if (createHash("sha256").update(row.payloadJson).digest("hex") !== row.payloadSha256) continue;
            let packet: Record<string, unknown>;
            try { packet = JSON.parse(row.payloadJson) as Record<string, unknown>; } catch { continue; }
            const changed = config.db!.db.update(reviewThreadMessages).set({ status: "presenting", revision: row.revision + 1, updatedAt: new Date().toISOString() })
              .where(and(eq(reviewThreadMessages.id, row.id), eq(reviewThreadMessages.revision, row.revision), eq(reviewThreadMessages.status, "queued"))).run();
            if (changed.changes === 1) claimed.push({ threadId: thread.id, handoffId: row.handoffId, handoffRevision: handoff.revision, payloadSha256: row.payloadSha256, packet });
          }
        }
        return claimed;
      })();
      return { content: [{ type: "text" as const, text: `Claimed ${messages.length} queued review message(s) for host delivery.` }], structuredContent: { messages } };
    },
  );

  registerAppTool(
    server,
    "acknowledge_review_thread_delivery",
    {
      title: "Record review message delivery",
      description: "Record the host's successful acceptance of a review message into the active conversation. This does not assert that the model read or reviewed it.",
      inputSchema: { threadId: z.string(), handoffId: z.string(), payloadSha256: z.string().length(64), outcome: z.enum(["accepted", "rejected"]) },
      outputSchema: { handoffId: z.string(), status: z.string() },
      _meta: {},
      annotations: { readOnlyHint: false },
    },
    async ({ threadId, handoffId, payloadSha256, outcome }: { threadId: string; handoffId: string; payloadSha256: string; outcome: "accepted" | "rejected" }) => {
      if (!isReviewer(config.principalRole)) return forbidden(config.principalRole, "acknowledge_review_thread_delivery");
      if (!config.db || !config.reviewThreads) return { content: [{ type: "text" as const, text: "Review thread storage is unavailable." }], isError: true };
      const thread = config.reviewThreads.getById(threadId);
      if (!thread || thread.status !== "active" || thread.reviewerPrincipalId !== (config.principalId ?? `role:${config.principalRole ?? "reviewer"}`)
        || thread.reviewerContextId !== reviewerThreadContextId(config)) return { content: [{ type: "text" as const, text: "Review thread access denied." }], isError: true };
      const route = routes?.getRouteBySession(thread.workSessionId);
      if (!route || route.routeEpoch !== thread.routeEpoch || route.status !== "active") return { content: [{ type: "text" as const, text: "The active review thread route is unavailable." }], isError: true };
      const result = config.db.db.update(reviewThreadMessages).set({ status: outcome === "accepted" ? "presented" : "failed", revision: sql`${reviewThreadMessages.revision} + 1`, updatedAt: new Date().toISOString() })
        .where(and(eq(reviewThreadMessages.threadId, thread.id), eq(reviewThreadMessages.handoffId, handoffId), eq(reviewThreadMessages.payloadSha256, payloadSha256), eq(reviewThreadMessages.status, "presenting"))).run();
      if (result.changes !== 1) return { content: [{ type: "text" as const, text: "Delivery receipt did not match an active claimed packet." }], isError: true };
      return { content: [{ type: "text" as const, text: `Host delivery ${outcome}; reviewer action is still pending.` }], structuredContent: { handoffId, status: outcome === "accepted" ? "presented" : "failed" } };
    },
  );

  registerAppTool(
    server,
    "list_review_thread_messages",
    {
      title: "List review thread messages",
      description: "Read the bounded delivery index for the reviewer thread activated in this authenticated context. Reading does not mark packets delivered.",
      inputSchema: { threadId: z.string() },
      outputSchema: { threadId: z.string(), routeEpoch: z.number(), messages: z.array(z.object({ handoffId: z.string(), submissionId: z.string(), reviewEpoch: z.number(), roundNumber: z.number(), kind: z.string(), status: z.string(), deliveryState: z.string(), nextAction: z.string(), revision: z.number(), payloadSha256: z.string() })) },
      _meta: {},
      annotations: { readOnlyHint: true },
    },
    async ({ threadId }: { threadId: string }) => {
      if (!isReviewer(config.principalRole)) return forbidden(config.principalRole, "list_review_thread_messages");
      const thread = config.reviewThreads?.getById(threadId);
      if (!thread || thread.status !== "active" || thread.reviewerPrincipalId !== (config.principalId ?? `role:${config.principalRole ?? "reviewer"}`)
        || thread.reviewerContextId !== reviewerThreadContextId(config)) {
        return { content: [{ type: "text" as const, text: "Review thread access denied." }], isError: true };
      }
      const route = routes?.getRouteBySession(thread.workSessionId);
      if (!route || route.routeEpoch !== thread.routeEpoch || route.status === "disabled" || route.status === "closed") {
        return { content: [{ type: "text" as const, text: "Review thread is unavailable for the current route epoch." }], isError: true };
      }
      const recentMessages = config.reviewThreads!.listMessages(threadId).slice(-20);
      const attempts = new Map(recentMessages.map((message) => [message.id, config.db?.db.select().from(reviewBrowserTurns)
        .where(eq(reviewBrowserTurns.reviewMessageId, message.id)).orderBy(desc(reviewBrowserTurns.attemptNumber)).limit(1).get()]));
      const messages = recentMessages.map((message) => {
        const attempt = attempts.get(message.id);
        const deliveryState = attempt?.state === "uncertain" ? "dispatch_uncertain"
          : attempt?.state === "awaiting_feedback" ? "awaiting_reviewer_action"
            : attempt?.state === "prompt_accepted" || attempt?.state === "model_generating" || attempt?.state === "generation_finished" ? "prompt_accepted"
              : ["blocked_auth", "blocked_browser", "failed"].includes(attempt?.state ?? "") || message.status === "failed" ? "recovery_required"
                : ["feedback_committed", "settled"].includes(attempt?.state ?? "") ? "feedback_committed"
                : message.status === "presented" ? "prompt_accepted"
                  : message.status === "queued" ? "pending_delivery"
                    : message.status === "settled" ? "feedback_committed"
                      : "delivery_pending";
        const nextAction = deliveryState === "pending_delivery" ? "Deliver the queued packet through the active reviewer context."
          : deliveryState === "dispatch_uncertain" ? "Inspect the exact conversation and resolve this attempt before any resend."
            : deliveryState === "prompt_accepted" ? "Wait for generation or inspect the exact conversation; generation is not a verdict."
              : deliveryState === "awaiting_reviewer_action" ? "Submit feedback through the authenticated review tools."
                : deliveryState === "feedback_committed" ? "No reviewer action is pending for this message."
                  : deliveryState === "recovery_required" ? "Check browser login, profile ownership, and connection, then resolve the durable attempt."
                    : "Check the active reviewer transport and delivery receipt.";
        return {
          handoffId: message.handoffId, submissionId: message.submissionId,
          reviewEpoch: message.reviewEpoch, roundNumber: message.roundNumber, kind: message.kind,
          status: message.status, deliveryState, nextAction, revision: message.revision,
          payloadSha256: message.payloadSha256,
        };
      });
      return { content: [{ type: "text" as const, text: `Review thread ${threadId} has ${messages.length} recent submission packet(s).` }], structuredContent: { threadId, routeEpoch: thread.routeEpoch, messages } };
    },
  );

  registerMutationAppTool(
    server,
    "requeue_review_thread_delivery",
    {
      title: "Requeue an uncertain review message",
      description: "Explicitly retry a failed or uncertain delivery for the active reviewer thread. An uncertain `presenting` message requires acknowledging that the host may already have received it; handoff identity and feedback commit remain idempotently fenced.",
      inputSchema: { handoffId: z.string(), threadId: z.string(), expectedRevision: z.number().int().min(1), acceptPossibleDuplicate: z.boolean().default(false) },
      outputSchema: { handoffId: z.string(), status: z.string(), revision: z.number() },
      _meta: {},
      annotations: { readOnlyHint: false },
    },
    config,
    async ({ handoffId, threadId, expectedRevision, acceptPossibleDuplicate }) => {
      if (!isReviewer(config.principalRole)) return forbidden(config.principalRole, "requeue_review_thread_delivery");
      if (!config.db || !config.reviewThreads) return { content: [{ type: "text" as const, text: "Review thread storage is unavailable." }], isError: true };
      const thread = config.reviewThreads.getById(threadId);
      if (!thread || thread.status !== "active" || thread.reviewerPrincipalId !== (config.principalId ?? `role:${config.principalRole ?? "reviewer"}`)
        || thread.reviewerContextId !== reviewerThreadContextId(config)) return { content: [{ type: "text" as const, text: "Review thread access denied." }], isError: true };
      const message = thread && config.db.db.select().from(reviewThreadMessages).where(and(
        eq(reviewThreadMessages.threadId, thread.id), eq(reviewThreadMessages.handoffId, handoffId),
      )).get();
      if (!thread || !message) return { content: [{ type: "text" as const, text: "Review message is not bound to the active reviewer context." }], isError: true };
      const route = routes?.getRouteBySession(thread.workSessionId);
      if (!route || route.status !== "active" || route.routeEpoch !== thread.routeEpoch || message.routeEpoch !== thread.routeEpoch) {
        return { content: [{ type: "text" as const, text: "Review message belongs to an inactive route generation." }], isError: true };
      }
      if (message.status !== "presenting" && message.status !== "failed") {
        return { content: [{ type: "text" as const, text: `Review message status ${message.status} cannot be requeued.` }], isError: true };
      }
      if (message.status === "presenting" && !acceptPossibleDuplicate) {
        return { content: [{ type: "text" as const, text: "The previous host response is uncertain. Set acceptPossibleDuplicate=true only after reviewing the delivery status." }], isError: true };
      }
      if (createHash("sha256").update(message.payloadJson).digest("hex") !== message.payloadSha256) {
        return { content: [{ type: "text" as const, text: "Review packet integrity check failed." }], isError: true };
      }
      const updatedAt = new Date().toISOString();
      const updated = config.db.db.update(reviewThreadMessages).set({ status: "queued", revision: message.revision + 1, updatedAt })
        .where(and(eq(reviewThreadMessages.id, message.id), eq(reviewThreadMessages.revision, expectedRevision), eq(reviewThreadMessages.status, message.status))).run();
      if (updated.changes !== 1) return { content: [{ type: "text" as const, text: "Review delivery revision conflict." }], isError: true };
      config.eventStore.appendEvent({ type: "review.thread.delivery_requeued", sessionId: thread.workSessionId, payload: { threadId: thread.id, handoffId } });
      return { content: [{ type: "text" as const, text: `Review message ${handoffId} requeued for host delivery.` }], structuredContent: { handoffId, status: "queued", revision: message.revision + 1 } };
    },
  );

  registerMutationAppTool(
    server,
    "resolve_uncertain_reviewer_browser_attempt",
    {
      title: "Resolve an uncertain reviewer browser attempt",
      description: "After inspecting the exact bound ChatGPT conversation, explicitly confirm that the immutable prompt is absent and no reviewer feedback was committed. This records a reviewer recovery receipt and requeues the same immutable message. If the prompt may have been accepted, leave the attempt fenced and wait for feedback; generation text is never a verdict.",
      inputSchema: {
        attemptId: z.string(),
        threadId: z.string(),
        confirmPromptAbsent: z.literal(true),
        inspectionEvidence: z.string().trim().min(12).max(2_000),
      },
      outputSchema: { attemptId: z.string(), status: z.literal("queued"), messageId: z.string(), messageRevision: z.number(), resolutionSha256: z.string() },
      _meta: {}, annotations: { readOnlyHint: false },
    },
    config,
    async ({ attemptId, threadId, confirmPromptAbsent, inspectionEvidence }) => {
      if (!isReviewer(config.principalRole)) return forbidden(config.principalRole, "resolve_uncertain_reviewer_browser_attempt");
      const thread = config.reviewThreads?.getById(threadId);
      const reviewerPrincipalId = config.principalId ?? `role:${config.principalRole ?? "reviewer"}`;
      if (!config.reviewBrowserJobs || !thread || thread.status !== "active"
        || thread.reviewerPrincipalId !== reviewerPrincipalId
        || thread.reviewerContextId !== reviewerThreadContextId(config)) {
        return { content: [{ type: "text" as const, text: "An active browser review thread bound to this authenticated reviewer context is required." }], isError: true };
      }
      try {
        const result = config.reviewBrowserJobs.resolveUncertainAttemptForRetry({
          attemptId, reviewThreadId: thread.id, routeEpoch: thread.routeEpoch, reviewerPrincipalId,
          confirmPromptAbsent, inspectionEvidence,
        });
        config.eventStore.appendEvent({
          type: "review.browser_turn.operator_reconciled", sessionId: thread.workSessionId,
          payload: { threadId: thread.id, attemptId, resolution: "confirmed_prompt_absent_requeue", resolutionSha256: result.resolutionSha256 },
        });
        return {
          content: [{ type: "text" as const, text: "The exact uncertain attempt was reconciled from your conversation inspection. The same immutable reviewer message is queued for a new delivery attempt." }],
          structuredContent: { attemptId, status: "queued" as const, ...result },
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
        reviewThreadId: z.string().optional(),
        destinationConversationId: z.string().optional(),
      },
      outputSchema: {
        handoffId: z.string(),
        status: z.string(),
        revision: z.number(),
        roundNumber: z.number(),
        claimExpiresAt: z.string().optional(),
      },
      _meta: {},
      annotations: { readOnlyHint: false },
    },
    async ({ handoffId, expectedRevision, reviewThreadId, destinationConversationId }: { handoffId: string; expectedRevision: number; reviewThreadId?: string; destinationConversationId?: string }) => {
      if (!isReviewer(config.principalRole)) return forbidden(config.principalRole, "claim_review_handoff");
      if (!routes) return { content: [{ type: "text" as const, text: "Review routing is unavailable." }], isError: true };
      const handoff = routes.getHandoffById(handoffId);
      if (!handoff) return { content: [{ type: "text" as const, text: `Unknown handoff: ${handoffId}` }], isError: true };
      try {
        const route = routes.getRouteBySession(handoff.workSessionId);
        if (!route) return { content: [{ type: "text" as const, text: "Review route not found for this handoff." }], isError: true };
        const submissions = config.workSessions.getSubmissions(handoff.workSessionId);
        const pendingSubmission = submissions.find((item) => item.id === handoff.submissionId);
        const latestSubmission = submissions.reduce<typeof pendingSubmission>((latest, item) =>
          !latest || item.submissionNumber > latest.submissionNumber ? item : latest, undefined);
        if (!pendingSubmission) throw new Error("The handoff submission is not visible in this work-session context.");
        if (pendingSubmission.status !== "pending" || latestSubmission?.id !== handoff.submissionId) {
          throw new Error("Only the current pending submission can be claimed.");
        }
        if (pendingSubmission.reviewEpoch !== handoff.reviewEpoch || pendingSubmission.diffSha256 !== handoff.diffSha256
          || pendingSubmission.snapshotKind !== handoff.snapshotKind || pendingSubmission.snapshotRef !== handoff.snapshotRef) {
          throw new Error("The handoff does not match the current submission's immutable snapshot.");
        }
        const reviewerContextId = reviewClaimContextId(config, route.mode);
        if (!reviewerContextId) throw new Error("An authenticated reviewer context bound to this MCP session is required.");
        const destinationConversationMetadata = destinationConversationId
          ?? (route.mode === "isolated_review"
            ? config.reviewThreads?.getById(reviewThreadId ?? "")?.hostConversationId
            : route.pinnedConversationId);
        const claimed = routes.claimHandoff({
          handoffId,
          expectedRevision,
          principalId: config.principalId ?? `role:${config.principalRole ?? "reviewer"}`,
          ownerContextId: reviewerContextId,
          reviewThreadId,
          destinationConversationId: destinationConversationMetadata,
        });
        config.eventStore.appendEvent({
          type: "review.handoff.claimed",
          sessionId: claimed.workSessionId,
          payload: { handoffId: claimed.id, revision: claimed.revision, claimedByPrincipalId: claimed.claimedByPrincipalId, claimedByOwnerContextId: claimed.claimedByOwnerContextId },
        });
        return {
          content: [{ type: "text" as const, text: `Handoff ${claimed.id} claimed for round ${claimed.roundNumber}.` }],
          structuredContent: { handoffId: claimed.id, status: claimed.status, revision: claimed.revision, roundNumber: claimed.roundNumber, claimExpiresAt: claimed.claimExpiresAt },
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
        admittedReviewRounds: z.number().optional(),
        maxReviewRounds: z.number().optional(),
        reviewThreadId: z.string().optional(),
        reviewThreadStatus: z.string().optional(),
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
      const thread = config.reviewThreads?.getForRoute(route.id, route.routeEpoch);
      return {
        content: [{ type: "text" as const, text: `Review loop ${route.status}; ${route.admittedReviewRounds}/${route.maxReviewRounds} rounds admitted, ${route.completedReviewRounds} completed${thread ? `; reviewer thread ${thread.status}` : ""}.` }],
        structuredContent: {
          configured: true,
          routeId: route.id,
          status: route.status,
          mode: route.mode,
          completedReviewRounds: route.completedReviewRounds,
          admittedReviewRounds: route.admittedReviewRounds,
          maxReviewRounds: route.maxReviewRounds,
          reviewThreadId: thread?.id,
          reviewThreadStatus: thread?.status,
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
        if (!hasCurrentHandoffClaim(handoff)) {
          return forbidden(config.principalRole, "submit_handoff_feedback");
        }
        const reviewerContextId = handoffContextId(handoff.workSessionId);
        if (!reviewerContextId) return forbidden(config.principalRole, "submit_handoff_feedback");
        if (handoff.revision !== expectedRevision) {
          return { content: [{ type: "text" as const, text: "Stale handoff revision." }], isError: true };
        }
        const result = await config.reviewWorkflow.provideFeedback({
          sessionId: handoff.workSessionId,
          submissionId: handoff.submissionId,
          reviewerOwnerContextId: reviewerContextId,
          reviewerPrincipalId: config.principalId ?? `role:${config.principalRole ?? "reviewer"}`,
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
      outputSchema: { handoffId: z.string(), status: z.string(), revision: z.number(), claimExpiresAt: z.string().optional() },
      _meta: {},
      annotations: { readOnlyHint: true },
    },
    async ({ handoffId }: { handoffId: string }) => {
      const handoff = routes?.getHandoffById(handoffId);
      if (!handoff) return { content: [{ type: "text" as const, text: `Unknown handoff: ${handoffId}` }], isError: true };
      if (!hasCurrentHandoffClaim(handoff)) {
        return forbidden(config.principalRole, "get_review_handoff_status");
      }
      return {
        content: [{ type: "text" as const, text: `Handoff ${handoffId}: ${handoff.status}` }],
        structuredContent: { handoffId: handoff.id, status: handoff.status, revision: handoff.revision, claimExpiresAt: handoff.claimExpiresAt },
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
        if (!hasCurrentHandoffClaim(handoff)) {
          return forbidden(config.principalRole, "release_review_handoff");
        }
        const route = routes!.getRouteBySession(handoff.workSessionId);
        if (!route || handoff.routeEpoch !== route.routeEpoch) throw new Error("Cannot release a handoff from a stale route epoch.");
        const released = routes!.markHandoffStatus({
          handoffId: handoff.id,
          expectedRevision,
          nextStatus: route.mode === "pinned_conversation" ? "ready" : "awaiting_attachment",
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
        reviewPacket: z.record(z.string(), z.unknown()),
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
      if (!hasCurrentHandoffClaim(handoff)) {
        return forbidden(config.principalRole, "get_review_handoff");
      }
      const session = config.workSessions.get(handoff.workSessionId);
      const submission = config.workSessions.getSubmissions(handoff.workSessionId).find((item) => item.id === handoff.submissionId);
      if (!session || !submission || submission.reviewEpoch !== handoff.reviewEpoch
        || submission.diffSha256 !== handoff.diffSha256
        || submission.snapshotKind !== handoff.snapshotKind || submission.snapshotRef !== handoff.snapshotRef) {
        return { content: [{ type: "text" as const, text: "The immutable review packet no longer matches the claimed submission snapshot." }], isError: true };
      }
      const priorFeedback = config.db
        ? config.db.sqlite.prepare(`
            select submission_id as submissionId, verdict, comments,
                   required_actions_json as requiredActionsJson, created_at as createdAt
              from work_session_feedback
             where work_session_id = ? and submission_id != ?
             order by created_at desc limit 10
          `).all(handoff.workSessionId, handoff.submissionId).map((row: any) => ({
            submissionId: row.submissionId,
            verdict: row.verdict,
            comments: row.comments ?? undefined,
            requiredActions: (() => { try { return JSON.parse(row.requiredActionsJson ?? "[]") as string[]; } catch { return []; } })(),
            createdAt: row.createdAt,
          })).reverse()
        : [];
      let missionPacket: unknown;
      try { missionPacket = config.missionLedger?.getPacket(handoff.workSessionId); } catch { /* no mission packet is valid for ordinary sessions */ }
      const run = config.agentRegistry.getRunByWorkSessionId(handoff.workSessionId);
      const reviewPacket = routes.getReviewPacketByHandoff(handoff.id) ?? createReviewPacket({
        session,
        submission,
        roundNumber: handoff.roundNumber,
        objective: run?.inputPreview,
        mission: missionPacket,
        priorFeedback,
      });
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
          reviewPacket,
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
      if (!hasCurrentHandoffClaim(handoff)) {
        return forbidden(config.principalRole, "submit_external_catalog_observation");
      }
      const reviewerContextId = handoffContextId(handoff.workSessionId);
      if (!reviewerContextId) return forbidden(config.principalRole, "submit_external_catalog_observation");
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
          reviewerOwnerContextId: reviewerContextId,
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
        || !hasCurrentHandoffClaim(handoff)) {
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
