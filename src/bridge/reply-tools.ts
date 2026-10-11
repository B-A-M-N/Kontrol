/**
 * Worker-facing ordinary-reply wait and acknowledgement contract.
 *
 * Review feedback continuations are deliberately separate from clarification
 * replies. These tools create durable waiting intent and bind consumption to
 * the authenticated worker's logical run/attempt.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BridgeConfig } from "./context.js";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { registerMutationAppTool } from "./app-tool.js";
import { assertWorkerSessionBinding, forbidden, isWorkerOrClient, requireWorkSessionRead } from "./shared.js";
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
      const bind = assertWorkerSessionBinding(config, sessionId);
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
      const bind = assertWorkerSessionBinding(config, sessionId);
      if (bind) return bind;
      if (!config.agentMessages) return { content: [{ type: "text" as const, text: "Agent-message store unavailable." }], isError: true };
      const message = config.agentMessages.get(messageId);
      if (!message || message.workSessionId !== sessionId) {
        return { content: [{ type: "text" as const, text: "Message not found for this session." }], isError: true };
      }
      const run = config.agentRegistry.getRunByWorkSessionId(sessionId);
      config.agentMessages.waitForReply({
        messageId,
        workSessionId: sessionId,
        runId: run?.runId,
        attempt: run?.attemptNumber ?? 1,
        expectsReply: true,
        resumeOnReply: message.data.resumeOnReply === true,
      });
      const reply = config.agentMessages.listPendingReplies(sessionId).find((candidate) => candidate.messageId === messageId);
      if (reply && reply.status !== "acknowledged") {
        return {
          content: [{ type: "text" as const, text: "Reviewer reply is available." }],
          structuredContent: { status: "reply_ready", replyId: reply.id, replyRevision: reply.replyRevision, body: reply.body },
        };
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(timeoutMs ?? 300_000, 250)));
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
    const bind = assertWorkerSessionBinding(config, sessionId);
    if (bind) return bind;
    if (!config.agentMessages) return { content: [{ type: "text" as const, text: "Agent-message store unavailable." }], isError: true };
    const run = config.agentRegistry.getRunByWorkSessionId(sessionId);
    if (!run) return { content: [{ type: "text" as const, text: "No logical run is bound to this session." }], isError: true };
    try {
      const reply = config.agentMessages.acknowledgeReply({
        replyId,
        workSessionId: sessionId,
        runId: run.runId,
        attempt: run.attemptNumber ?? 1,
        actorId: config.principalId ?? `role:${config.principalRole ?? "worker"}`,
      });
      config.eventStore.appendEvent({
        type: "agent.message.reply_acknowledged",
        sessionId,
        payload: {
          messageId: reply.messageId,
          replyId: reply.id,
          replyRevision: reply.replyRevision,
          runId: run.runId,
          attempt: run.attemptNumber ?? 1,
        },
      });
      return {
        content: [{ type: "text" as const, text: `Reply ${reply.id} acknowledged.` }],
        structuredContent: { replyId: reply.id, status: reply.status, acknowledgedRunId: run.runId, acknowledgedAttempt: run.attemptNumber ?? 1 },
      };
    } catch (error) {
      return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], isError: true };
    }
  });
}
