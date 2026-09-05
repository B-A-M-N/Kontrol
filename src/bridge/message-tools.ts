/**
 * Agent-to-WebUI message and artifact tools
 *
 * Extracted verbatim from the original acp-bridge.ts god module (P0 refactor):
 * this capability module owns one semantic slice of the reviewer/worker
 * control-plane API and receives the same typed BridgeConfig context.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BridgeConfig } from "./context.js";
import { AGENT_MESSAGE_KINDS } from "../agent-messages.js";
import { registerMutationAppTool } from "./app-tool.js";
import { assertWorkerSessionBinding, forbidden, isReviewer, isWorkerOrClient, requireWorkSessionRead, workspaceAppModelAndAppMeta } from "./shared.js";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod/v4";

export function registerMessageTools(server: McpServer, config: BridgeConfig): void {
  registerMutationAppTool(
    server,
    "post_agent_message",
    {
      title: "Post message to WebUI",
      description: "Send a general message or artifact from the worker to the WebUI: ask for clarification, report a blocker, publish a finding, submit an artifact, or leave a note. Durable and ordered — the WebUI receives it live and can re-list it after a reload. Use kind='clarification_request' or 'blocker' when you need a human to act (these show as open until resolved).",
      inputSchema: {
        sessionId: z.string().describe("Work session ID."),
        kind: z.enum(AGENT_MESSAGE_KINDS as [string, ...string[]]).describe("Message kind."),
        title: z.string().optional().describe("Short headline."),
        body: z.string().optional().describe("Message text / question / description."),
        data: z.record(z.string(), z.unknown()).optional().describe("Structured payload: artifact ref, finding evidence, or answer options."),
        clientMutationId: z.string().min(1).max(200).optional(),
      },
      outputSchema: { messageId: z.string(), status: z.string(), kind: z.string() },
      _meta: workspaceAppModelAndAppMeta(),
      annotations: { readOnlyHint: false },
    },
    config,
    async ({ sessionId, kind, title, body, data }) => {
      if (!isWorkerOrClient(config.principalRole)) {
        return forbidden(config.principalRole, "post_agent_message");
      }
      if (!config.agentMessages) {
        return { content: [{ type: "text" as const, text: "Agent-message store unavailable." }], isError: true };
      }
      const session = config.workSessions.get(sessionId);
      if (!session) return { content: [{ type: "text" as const, text: "Session not found." }], isError: true };
      const bind = assertWorkerSessionBinding(config, sessionId);
      if (bind) return bind;

      const run = config.agentRegistry.getRunByWorkSessionId(sessionId);
      const commit = () => {
        const message = config.agentMessages!.post({
          workSessionId: sessionId,
          runId: run?.runId,
          kind: kind as (typeof AGENT_MESSAGE_KINDS)[number],
          author: config.principalRole === "worker" ? "worker" : "agent",
          title,
          body,
          data,
        });
        // The event is inserted in the same SQLite transaction as the message;
        // publish only after commit so a live WebUI can never observe a
        // projection event whose durable message row rolled back.
        const event = config.eventStore.appendEvent({
          type: "agent.message.posted",
          sessionId,
          payload: {
            messageId: message.id,
            kind: message.kind,
            title: message.title,
            body: message.body,
            status: message.status,
            runId: run?.runId,
          },
        }, { publish: false });
        return { message, event };
      };
      const committed = config.db ? config.db.sqlite.transaction(commit)() : commit();
      config.eventStore.publishEvents([committed.event]);
      const message = committed.message;
      return {
        content: [{ type: "text" as const, text: `Posted ${message.kind} (${message.id}).` }],
        structuredContent: { messageId: message.id, status: message.status, kind: message.kind },
      };
    },
  );

  registerAppTool(
    server,
    "list_agent_messages",
    {
      title: "List agent messages",
      description: "List durable agent→WebUI messages/artifacts for a work session (clarification requests, blockers, findings, artifacts, notes). Use for WebUI rehydration and to surface open questions/blockers awaiting a reply.",
      inputSchema: {
        sessionId: z.string().describe("Work session ID."),
        openOnly: z.boolean().optional().describe("Only return unresolved gating messages (questions/blockers)."),
      },
      outputSchema: {
        messages: z.array(z.object({
          messageId: z.string(),
          kind: z.string(),
          author: z.string(),
          title: z.string().optional(),
          body: z.string().optional(),
          status: z.string(),
          createdAt: z.string(),
        })),
      },
      _meta: {},
      annotations: { readOnlyHint: true },
    },
    async ({ sessionId, openOnly }) => {
      const denied = requireWorkSessionRead(config, sessionId);
      if (denied) return denied;
      if (!config.agentMessages) {
        return { content: [{ type: "text" as const, text: "Agent-message store unavailable." }], isError: true };
      }
      const messages = config.agentMessages.list(sessionId, { openOnly });
      return {
        content: [{ type: "text" as const, text: `${messages.length} message(s).` }],
        structuredContent: {
          messages: messages.map((m) => ({
            messageId: m.id,
            kind: m.kind,
            author: m.author,
            title: m.title,
            body: m.body,
            status: m.status,
            createdAt: m.createdAt,
          })),
        },
      };
    },
  );

  registerMutationAppTool(
    server,
    "resolve_agent_message",
    {
      title: "Resolve agent message",
      description: "Mark an open clarification request or blocker as resolved (e.g. after the reviewer has answered it). Optional reply text is delivered back to the worker as a durable event.",
      inputSchema: {
        sessionId: z.string().describe("Work session ID."),
        messageId: z.string().describe("The agent message to resolve."),
        reply: z.string().optional().describe("Answer / resolution text sent back to the worker."),
        clientMutationId: z.string().min(1).max(200).optional(),
      },
      outputSchema: { messageId: z.string(), status: z.string() },
      _meta: {},
      annotations: { readOnlyHint: false },
    },
    config,
    async ({ sessionId, messageId, reply }) => {
      if (!isReviewer(config.principalRole)) {
        return forbidden(config.principalRole, "resolve_agent_message");
      }
      if (!config.agentMessages) {
        return { content: [{ type: "text" as const, text: "Agent-message store unavailable." }], isError: true };
      }
      const existing = config.agentMessages.get(messageId);
      if (!existing || existing.workSessionId !== sessionId) {
        return { content: [{ type: "text" as const, text: "Message not found for this session." }], isError: true };
      }
      const commit = () => {
        const resolved = config.agentMessages!.resolve(messageId);
        const event = config.eventStore.appendEvent({
          type: "agent.message.resolved",
          sessionId,
          payload: { messageId, reply, replyToKind: existing.kind },
        }, { publish: false });
        return { resolved, event };
      };
      const committed = config.db ? config.db.sqlite.transaction(commit)() : commit();
      config.eventStore.publishEvents([committed.event]);
      const resolved = committed.resolved;
      return {
        content: [{ type: "text" as const, text: `Resolved ${messageId}.` }],
        structuredContent: { messageId, status: resolved?.status ?? "resolved" },
      };
    },
  );
}
