/**
 * Continuation prompt retrieval, listing and consumption tools
 *
 * Extracted verbatim from the original acp-bridge.ts god module (P0 refactor):
 * this capability module owns one semantic slice of the reviewer/worker
 * control-plane API and receives the same typed BridgeConfig context.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BridgeConfig } from "./context.js";
import type { Continuation } from "../continuation.js";
import { registerMutationAppTool } from "./app-tool.js";
import { assertWorkerSessionBinding } from "./shared.js";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod/v4";

export function registerContinuationTools(server: McpServer, config: BridgeConfig): void {
  registerAppTool(
    server,
    "get_continuation_prompt",
    {
      title: "Get continuation prompt",
      description: "Get the agent-ready prompt for continuing a work session from review feedback. Contains verdict, required actions, and resumption instructions. Use after receiving review feedback to get the next instructions for the session.",
      inputSchema: {
        feedbackEventId: z.string().describe("Feedback event ID from the review.feedback.provided event."),
      },
      outputSchema: {
        continuationId: z.string(),
        prompt: z.string(),
        sessionId: z.string(),
        reviewId: z.string(),
        feedbackEventId: z.string(),
        reviewEpoch: z.number(),
        verdict: z.string(),
        status: z.string(),
      },
      _meta: {},
      annotations: { readOnlyHint: true },
    },
    async ({ feedbackEventId }) => {
      const continuation = config.continuationManager.getByFeedbackEventId(feedbackEventId);
      const prompt = continuation?.promptText;

      if (!prompt) {
        return {
          content: [{ type: "text" as const, text: `No continuation found for feedback event "${feedbackEventId}". Call submit_for_review first.` }],
          isError: true,
        };
      }

      return {
        content: [{ type: "text" as const, text: prompt }],
        structuredContent: {
          continuationId: continuation.id,
          prompt,
          sessionId: continuation.sessionId,
          reviewId: continuation.reviewId,
          feedbackEventId: continuation.feedbackEventId,
          reviewEpoch: continuation.reviewEpoch,
          verdict: continuation.verdict,
          status: continuation.status,
        },
      };
    },
  );

  registerAppTool(
    server,
    "list_pending_continuations",
    {
      title: "List pending continuations",
      description: "List continuations awaiting agent pickup. A continuation is created when review feedback is submitted and represents the next agent prompt for that session.",
      inputSchema: {
        sessionId: z.string().optional().describe("Filter by work session ID. If omitted, returns all pending continuations."),
      },
      outputSchema: {
        continuations: z.array(z.object({
          id: z.string(),
          sessionId: z.string(),
          reviewId: z.string(),
          feedbackEventId: z.string(),
          verdict: z.string(),
          status: z.string(),
          createdAt: z.string(),
        })),
        count: z.number(),
      },
      _meta: {},
      annotations: { readOnlyHint: true },
    },
    async ({ sessionId }) => {
      const pending = config.continuationManager.listPending(sessionId);

      return {
        content: [{ type: "text" as const, text: `${pending.length} pending continuation(s).` }],
        structuredContent: {
          continuations: pending.map((c) => ({
            id: c.id,
            sessionId: c.sessionId,
            reviewId: c.reviewId,
            feedbackEventId: c.feedbackEventId,
            verdict: c.verdict,
            status: c.status,
            createdAt: c.createdAt,
          })),
          count: pending.length,
        },
      };
    },
  );

  registerMutationAppTool(
    server,
    "mark_continuation_consumed",
    {
      title: "Mark continuation consumed",
      description: "Mark a continuation as consumed after acting on it. Prevents the same feedback from being applied twice.",
      inputSchema: {
        continuationId: z.string().describe("Continuation ID to mark as consumed."),
        clientMutationId: z.string().min(1).max(200).optional(),
      },
      outputSchema: { status: z.string() },
      _meta: {},
      annotations: { readOnlyHint: false },
    },
    config,
    async ({ continuationId }) => {
      const continuation = config.continuationManager.get(continuationId);
      if (!continuation) {
        return {
          content: [{ type: "text" as const, text: `Continuation ${continuationId} not found.` }],
          structuredContent: { status: "not_found" },
          isError: true,
        };
      }
      // P1 #13: a dispatched worker is bound to one work session; it must not
      // consume a continuation that belongs to a different session.
      const bind = assertWorkerSessionBinding(config, continuation.sessionId);
      if (bind) return bind;
      if (continuation.status === "completed") {
        return {
          content: [{ type: "text" as const, text: `Continuation ${continuationId} already consumed.` }],
          structuredContent: { status: "already_consumed" },
        };
      }
      config.continuationManager.markCompleted(continuationId);
      return {
        content: [{ type: "text" as const, text: `Continuation ${continuationId} marked as consumed.` }],
        structuredContent: { status: "consumed" },
      };
    },
  );
}
