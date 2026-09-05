/**
 * Supervisor run pause/resume/redrive tools
 *
 * Extracted verbatim from the original acp-bridge.ts god module (P0 refactor):
 * this capability module owns one semantic slice of the reviewer/worker
 * control-plane API and receives the same typed BridgeConfig context.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BridgeConfig } from "./context.js";
import { registerMutationAppTool } from "./app-tool.js";
import { supervisorPacket } from "./context.js";
import { forbidden, isReviewer, workspaceAppModelAndAppMeta } from "./shared.js";
import { z } from "zod/v4";

export function registerSupervisorTools(server: McpServer, config: BridgeConfig): void {
  registerMutationAppTool(
    server,
    "pause_supervisor_run",
    {
      title: "Pause autonomous supervision",
      description: "Durably pause new supervisor actions without cancelling the mission or deleting its recovery state.",
      inputSchema: { workSessionId: z.string(), expectedRevision: z.number().int().positive(), clientMutationId: z.string().min(1).max(200).optional() },
      outputSchema: { packet: z.unknown() },
      _meta: workspaceAppModelAndAppMeta(),
      annotations: { readOnlyHint: false },
    },
    config,
    async ({ workSessionId, expectedRevision }) => {
      if (!isReviewer(config.principalRole)) return forbidden(config.principalRole, "pause_supervisor_run");
      const current = config.supervisorRuns?.getByWorkSession(workSessionId);
      const paused = current && config.supervisorRuns?.pause(current.id, expectedRevision);
      if (!paused) return { content: [{ type: "text" as const, text: "Supervisor run was not found or changed concurrently." }], isError: true };
      config.eventStore.appendEvent({ type: "supervisor.run.paused", sessionId: workSessionId, payload: { supervisorRunId: paused.id, revision: paused.revision } });
      return { content: [{ type: "text" as const, text: "Supervisor paused." }], structuredContent: { packet: await supervisorPacket(config, workSessionId) } };
    },
  );

  registerMutationAppTool(
    server,
    "resume_supervisor_run",
    {
      title: "Resume autonomous supervision",
      description: "Resume a paused supervisor run from its exact prior durable state.",
      inputSchema: { workSessionId: z.string(), expectedRevision: z.number().int().positive(), clientMutationId: z.string().min(1).max(200).optional() },
      outputSchema: { packet: z.unknown() },
      _meta: workspaceAppModelAndAppMeta(),
      annotations: { readOnlyHint: false },
    },
    config,
    async ({ workSessionId, expectedRevision }) => {
      if (!isReviewer(config.principalRole)) return forbidden(config.principalRole, "resume_supervisor_run");
      const current = config.supervisorRuns?.getByWorkSession(workSessionId);
      const resumed = current && config.supervisorRuns?.resume(current.id, expectedRevision);
      if (!resumed) return { content: [{ type: "text" as const, text: "Supervisor run was not paused or changed concurrently." }], isError: true };
      config.eventStore.appendEvent({ type: "supervisor.run.resumed", sessionId: workSessionId, payload: { supervisorRunId: resumed.id, revision: resumed.revision, status: resumed.status } });
      // The runtime reconstructs the exact durable next action for every
      // non-paused state (verification, correction, or automatic approval).
      // Restricting this wake-up to verification stranded paused correction
      // and approval runs until a later unrelated event arrived.
      config.onSupervisorResume?.(workSessionId);
      return { content: [{ type: "text" as const, text: "Supervisor resumed." }], structuredContent: { packet: await supervisorPacket(config, workSessionId) } };
    },
  );

  registerMutationAppTool(
    server,
    "redrive_supervisor_run",
    {
      title: "Redrive stalled supervisor run",
      description: "Requeue a dead-lettered supervisor action after reviewer intervention, preserving its durable audit trail.",
      inputSchema: { workSessionId: z.string(), expectedRevision: z.number().int().positive(), clientMutationId: z.string().min(1).max(200).optional() },
      outputSchema: { redriven: z.number(), packet: z.unknown() },
      _meta: workspaceAppModelAndAppMeta(),
      annotations: { readOnlyHint: false },
    },
    config,
    async ({ workSessionId, expectedRevision }) => {
      if (!isReviewer(config.principalRole)) return forbidden(config.principalRole, "redrive_supervisor_run");
      const outbox = config.dispatchOutbox;
      if (!outbox) return { content: [{ type: "text" as const, text: "Dispatch outbox is unavailable." }], isError: true };
      const run = config.supervisorRuns?.getByWorkSession(workSessionId);
      if (!run || run.status !== "awaiting_human" || run.revision !== expectedRevision) return { content: [{ type: "text" as const, text: "Supervisor run is not an unchanged human-intervention checkpoint." }], isError: true };
      const events = outbox.listByAggregate(run.id);
      let redriven = 0;
      for (const event of events) {
        if (event.status === "dead_lettered" && outbox.redriveDeadLetter(event.eventType, event.aggregateId, event.aggregateRevision)) redriven += 1;
      }
      if (!redriven) return { content: [{ type: "text" as const, text: "No dead-lettered supervisor action exists to redrive." }], isError: true };
      const dead = events.filter((event) => event.status === "dead_lettered");
      const nextStatus = dead.some((event) => event.eventType === "supervisor.correction.requested") ? "correction_pending" : dead.some((event) => event.eventType === "supervisor.approval.requested") ? "approval_pending" : "verification_pending";
      config.supervisorRuns?.transition({ id: run.id, expectedStatus: "awaiting_human", expectedRevision, nextStatus });
      config.eventStore.appendEvent({ type: "supervisor.run.redriven", sessionId: workSessionId, payload: { supervisorRunId: run.id, redriven, nextStatus } });
      return { content: [{ type: "text" as const, text: `Redrove ${redriven} supervisor action(s).` }], structuredContent: { redriven, packet: await supervisorPacket(config, workSessionId) } };
    },
  );
}
