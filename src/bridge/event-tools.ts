/**
 * Event-driven waiting tools (session events, terminal wait, workspace events)
 *
 * Extracted verbatim from the original acp-bridge.ts god module (P0 refactor):
 * this capability module owns one semantic slice of the reviewer/worker
 * control-plane API and receives the same typed BridgeConfig context.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BridgeConfig } from "./context.js";
import { forbidden, isReviewer, requireWorkSessionRead, workspaceAppModelAndAppMeta } from "./shared.js";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod/v4";

export function registerEventTools(server: McpServer, config: BridgeConfig): void {
const TERMINAL_RUN_EVENTS = new Set([
  "agent.run.approved",
  "agent.run.rejected",
  "agent.run.cancelled",
  "agent.run.completed",
  "agent.run.failed",
  "agent.run.failed_protocol",
]);

  registerAppTool(
    server,
    "await_work_session_events",
    {
      title: "Await work session events",
      description: "Blocking, host-authenticated read of durable work-session events after a given seq. Returns immediately when an event arrives, or after timeoutMs (a liveness heartbeat, not 'nothing happened'). Used by the WebUI watcher to receive activity without polling.",
      inputSchema: {
        sessionId: z.string().describe("Work session ID to watch."),
        afterSeq: z.number().int().min(0).default(0).describe("Return events strictly after this seq."),
        timeoutMs: z.number().int().min(1000).max(120_000).default(55_000).describe("Max wait in ms before returning (liveness timeout)."),
      },
      outputSchema: {
        events: z.array(z.object({
          seq: z.number(),
          id: z.string(),
          type: z.string(),
          sessionId: z.string(),
          workspaceSessionId: z.string().optional(),
          payload: z.record(z.string(), z.unknown()),
          createdAt: z.string(),
        })),
        nextSeq: z.number(),
        terminal: z.boolean(),
      },
      _meta: workspaceAppModelAndAppMeta(),
      annotations: { readOnlyHint: true },
    },
    async ({ sessionId, afterSeq, timeoutMs }) => {
      const access = requireWorkSessionRead(config, sessionId);
      if (access) return access;
      const session = config.workSessions.get(sessionId);
      if (!session) {
        return { content: [{ type: "text" as const, text: "Session not found." }], isError: true };
      }
      const waitStartedAt = performance.now();
      const events = await config.eventStore.waitForEventsAfter(sessionId, afterSeq, timeoutMs);
      config.onPhaseTiming?.("event.session_wait", performance.now() - waitStartedAt);
      const terminal = events.some((e) =>
        TERMINAL_RUN_EVENTS.has(e.type) &&
        !(session.completionPolicy === "webui_approval_required" && e.type === "agent.run.completed")
      );
      const nextSeq = events.length ? events[events.length - 1].seq : afterSeq;
      return {
        content: [{ type: "text" as const, text: `${events.length} event(s) after seq ${afterSeq}; terminal=${terminal}.` }],
        structuredContent: {
          events: events.map((e) => ({
            seq: e.seq,
            id: e.id,
            type: e.type,
            sessionId: e.sessionId,
            workspaceSessionId: e.workspaceSessionId,
            payload: e.payload,
            createdAt: e.createdAt,
          })),
          nextSeq,
          terminal,
        },
      };
    },
  );

  registerAppTool(
    server,
    "await_work_session_terminal",
    {
      title: "Await work session terminal",
      description: "Block until the reviewed work session reaches a terminal run event. For webui_approval_required sessions, successful completion is agent.run.approved only.",
      inputSchema: {
        sessionId: z.string().describe("Work session ID to watch."),
        afterSeq: z.number().int().min(0).default(0).describe("Return terminal events strictly after this seq."),
        timeoutMs: z.number().int().min(1000).max(300_000).default(120_000).describe("Max wait in ms before returning pending."),
      },
      outputSchema: { status: z.string(), terminal: z.boolean(), successful: z.boolean(), eventType: z.string().optional(), nextSeq: z.number() },
      _meta: {},
      annotations: { readOnlyHint: true },
    },
    async ({ sessionId, afterSeq, timeoutMs }) => {
      const session = config.workSessions.get(sessionId);
      if (!session) return { content: [{ type: "text" as const, text: "Session not found." }], isError: true };
      const waitStartedAt = performance.now();
      const event = await config.eventStore.waitForMatchingEventAfter(
        sessionId,
        afterSeq,
        (candidate) =>
          TERMINAL_RUN_EVENTS.has(candidate.type) &&
          !(session.completionPolicy === "webui_approval_required" && candidate.type === "agent.run.completed"),
        timeoutMs,
      );
      config.onPhaseTiming?.("event.terminal_wait", performance.now() - waitStartedAt);
      const latest = config.workSessions.get(sessionId);
      const status = latest?.status ?? session.status;
      // For webui_approval_required sessions, success is ONLY agent.run.approved.
      // For ordinary agent_completion sessions, success is agent.run.completed
      // (a zero exit code is NOT approval — P1 #6).
      const successful = latest?.completionPolicy === "webui_approval_required"
        ? status === "approved" && event?.type === "agent.run.approved"
        : (event?.type === "agent.run.completed" || event?.type === "agent.run.approved" || status === "approved");
      return {
        content: [{ type: "text" as const, text: event ? `Terminal: ${event.type}` : "Still pending." }],
        structuredContent: {
          status,
          terminal: Boolean(event),
          successful,
          eventType: event?.type,
          nextSeq: event?.seq ?? afterSeq,
        },
      };
    },
  );

  registerAppTool(
    server,
    "await_workspace_events",
    {
      title: "Await workspace events",
      description: "Blocking, host-authenticated read of durable events across all work sessions in one workspace/project. Use one cursor instead of keeping a long-poll connection open for every parked session.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace or project identifier from open_workspace."),
        afterSeq: z.number().int().min(0).default(0).describe("Return events strictly after this global event sequence."),
        timeoutMs: z.number().int().min(1000).max(120_000).default(55_000).describe("Max wait in ms before returning."),
      },
      outputSchema: {
        events: z.array(z.object({
          seq: z.number(),
          id: z.string(),
          type: z.string(),
          sessionId: z.string(),
          workspaceSessionId: z.string().optional(),
          payload: z.record(z.string(), z.unknown()),
          createdAt: z.string(),
        })),
        nextSeq: z.number(),
      },
      _meta: workspaceAppModelAndAppMeta(),
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId, afterSeq, timeoutMs }) => {
      if (!isReviewer(config.principalRole)) {
        return forbidden(config.principalRole, "await_workspace_events");
      }
      const startedAt = performance.now();
      try {
      // Fail early for a typo rather than parking a waiter that can never
      // receive an event. The store still accepts project IDs as aliases.
      try {
        config.workspaces.getWorkspace(workspaceId);
      } catch {
        // A project alias may not be present in the in-memory registry; the
        // event-store query below validates it by returning an empty stream.
      }
      const events = await config.eventStore.waitForWorkspaceEventsAfter(workspaceId, afterSeq, timeoutMs);
      const nextSeq = events.length ? events[events.length - 1].seq : afterSeq;
      return {
        content: [{ type: "text" as const, text: `${events.length} workspace event(s) after seq ${afterSeq}.` }],
        structuredContent: {
          events: events.map((event) => ({
            seq: event.seq,
            id: event.id,
            type: event.type,
            sessionId: event.sessionId,
            workspaceSessionId: event.workspaceSessionId,
            payload: event.payload,
            createdAt: event.createdAt,
          })),
          nextSeq,
        },
      };
      } finally {
        config.onPhaseTiming?.("event.workspace_wait", performance.now() - startedAt);
      }
    },
  );
}
