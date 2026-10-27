/**
 * Worker-facing ordinary-reply wait and acknowledgement contract.
 *
 * Review feedback continuations are deliberately separate from clarification
 * replies. These tools create durable waiting intent and bind consumption to
 * the authenticated worker's logical run/attempt.
 */
import type { McpServer } from "@modelcontextprotocol/server";
import type { BridgeConfig } from "./context.js";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { registerMutationAppTool } from "./app-tool.js";
import { forbidden, isWorkerOrClient, requireWorkerDeliveryBinding, requireWorkSessionRead } from "./shared.js";
import { z } from "zod/v4";

export function registerReplyTools(server: McpServer, config: BridgeConfig): void {
  registerAppTool(
    server,
    "get_pending_agent_replies",
    {
      title: "Get pending agent replies",
      description: "Nonblocking retrieval of unacknowledged reviewer replies for this work session; use for reconnect/startup recovery.",
      inputSchema: { sessionId: z.string().describe("Work session ID.") },
      outputSchema: {
        replies: z.array(z.object({
          replyId: z.string(),
          messageId: z.string(),
          replyRevision: z.number(),
          body: z.string(),
          status: z.string(),
        })),
      },
      _meta: {},
      annotations: { readOnlyHint: true },
    },
    async ({ sessionId }: { sessionId: string }) => {
      if (!isWorkerOrClient(config.principalRole)) return forbidden(config.principalRole, "get_pending_agent_replies");
      const denied = requireWorkSessionRead(config, sessionId);
      if (denied) return denied;
      const bind = requireWorkerDeliveryBinding(config, sessionId);
      if (bind) return bind;
      if (!config.agentMessages) return { content: [{ type: "text" as const, text: "Agent-message store unavailable." }], isError: true };
      const replies = config.agentMessages.listPendingReplies(sessionId);
      return {
        content: [{ type: "text" as const, text: `${replies.length} pending reply/replies.` }],
        structuredContent: {
          replies: replies.map((reply) => ({
            replyId: reply.id,
            messageId: reply.messageId,
            replyRevision: reply.replyRevision,
            body: reply.body,
            status: reply.status,
          })),
        },
      };
    },
  );

  registerAppTool(
    server,
    "await_agent_reply",
    {
      title: "Await agent reply",
      description: "Durably wait for a reviewer reply to a clarification/blocker. Subscribe-before-query, bounded timeout, returns immutable reply identity.",
      inputSchema: {
        sessionId: z.string().describe("Work session ID."),
        messageId: z.string().describe("Original agent message."),
        timeoutMs: z.number().int().min(1_000).max(900_000).optional().default(300_000),
      },
      outputSchema: {
        status: z.enum(["reply_ready", "timeout", "error"]),
        replyId: z.string().optional(),
        replyRevision: z.number().optional(),
        body: z.string().optional(),
        message: z.string().optional(),
      },
      _meta: {},
      annotations: { readOnlyHint: true },
    },
    async ({ sessionId, messageId, timeoutMs }: { sessionId: string; messageId: string; timeoutMs?: number }) => {
      if (!isWorkerOrClient(config.principalRole)) return forbidden(config.principalRole, "await_agent_reply");
      const denied = requireWorkSessionRead(config, sessionId);
      if (denied) return denied;
      const bind = requireWorkerDeliveryBinding(config, sessionId);
      if (bind) return bind;
      if (!config.agentMessages) return { content: [{ type: "text" as const, text: "Agent-message store unavailable." }], isError: true };
      const message = config.agentMessages.get(messageId);
      if (!message || message.workSessionId !== sessionId) {
        return { content: [{ type: "text" as const, text: "Message not found for this session." }], isError: true };
      }
      const run = config.agentRegistry.getRunByWorkSessionId(sessionId);
      void config.agentMessages.waitForReply({
        messageId,
        workSessionId: sessionId,
        runId: run?.runId,
        attempt: run?.attemptNumber ?? 1,
        expectsReply: true,
        resumeOnReply: message.data.resumeOnReply === true,
      });
      // Subscribe before the durable query so a reply that arrives between the
      // two steps wakes this waiter instead of being missed until timeout.
      const lastSeq = config.eventStore.getLatestEventSequenceForSession(sessionId);
      const existing = config.agentMessages.listPendingReplies(sessionId).find((candidate) => candidate.messageId === messageId);
      if (existing && existing.status !== "acknowledged") {
        return {
          content: [{ type: "text" as const, text: "Reviewer reply is available." }],
          structuredContent: { status: "reply_ready", replyId: existing.id, replyRevision: existing.replyRevision, body: existing.body },
        };
      }
      await config.eventStore.waitForEventsAfter(sessionId, lastSeq, Math.min(timeoutMs ?? 300_000, 300_000));
      const reply = config.agentMessages.listPendingReplies(sessionId).find((candidate) => candidate.messageId === messageId);
      if (reply && reply.status !== "acknowledged") {
        return {
          content: [{ type: "text" as const, text: "Reviewer reply is available." }],
          structuredContent: { status: "reply_ready", replyId: reply.id, replyRevision: reply.replyRevision, body: reply.body },
        };
      }
      return {
        content: [{ type: "text" as const, text: "Reply is still pending." }],
        structuredContent: { status: "timeout" },
      };
    },
  );

  registerMutationAppTool(server, "ack_agent_reply", {
    title: "Acknowledge agent reply",
    description: "Persist that the authenticated worker consumed the exact reviewer reply into its task context.",
    inputSchema: {
      sessionId: z.string(),
      replyId: z.string(),
      replyRevision: z.number().int().min(1),
      deliveryAttemptId: z.string().min(1),
    },
    outputSchema: {
      replyId: z.string(),
      status: z.string(),
      acknowledgedRunId: z.string().optional(),
      acknowledgedAttempt: z.number().optional(),
    },
    _meta: {},
    annotations: { readOnlyHint: false },
  } as any, config, async (input: any) => {
    const sessionId = String(input.sessionId ?? "");
    const replyId = String(input.replyId ?? "");
    if (!isWorkerOrClient(config.principalRole)) return forbidden(config.principalRole, "ack_agent_reply");
    // Acknowledgement is consumption, so a binding is mandatory for workers:
    // an unbound worker cannot acknowledge a reply it was never delivered.
    const bind = config.principalRole === "worker"
      ? requireWorkerDeliveryBinding(config, sessionId)
      : requireWorkSessionRead(config, sessionId);
    if (bind) return bind;
    if (!config.agentMessages) return { content: [{ type: "text" as const, text: "Agent-message store unavailable." }], isError: true };
    const run = config.agentRegistry.getRunByWorkSessionId(sessionId);
    if (!run) return { content: [{ type: "text" as const, text: "No logical run is bound to this session." }], isError: true };
    // deliveryAttemptId binds acknowledgement to a specific delivery identity,
    // preventing a forged or stale delivery token from consuming a reply.
    if (String(input.deliveryAttemptId) !== `${run.runId}:${run.attemptNumber ?? 1}`) {
      return { content: [{ type: "text" as const, text: "Stale or forged delivery attempt identity." }], isError: true };
    }
    try {
      const ackResult = config.agentMessages.acknowledgeReply({
        replyId,
        workSessionId: sessionId,
        runId: run.runId,
        attempt: run.attemptNumber ?? 1,
        actorId: config.principalId ?? `role:${config.principalRole ?? "worker"}`,
        expectedReplyRevision: input.replyRevision,
      });
      const reply = ackResult.reply;
      const ackEvent = ackResult.created
        ? config.eventStore.appendEvent({
            type: "agent.message.reply_acknowledged",
            sessionId,
            payload: {
              messageId: reply.messageId,
              replyId: reply.id,
              replyRevision: reply.replyRevision,
              runId: run.runId,
              attempt: run.attemptNumber ?? 1,
              status: reply.status,
              destinationAgentId: config.agentRegistry.getLatestDispatchAttemptForRun(run.runId)?.agentId,
            },
          })
        : undefined;
      void ackEvent;
      return {
        content: [{ type: "text" as const, text: `Reply ${reply.id} acknowledged.` }],
        structuredContent: { replyId: reply.id, status: reply.status, acknowledgedRunId: run.runId, acknowledgedAttempt: run.attemptNumber ?? 1 },
      };
    } catch (error) {
      return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], isError: true };
    }
  });
}
