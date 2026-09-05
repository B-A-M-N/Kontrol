/**
 * WorkSessionToolEventStore: tool-activity telemetry rows
 *
 * Extracted verbatim from SqliteWorkSessionManager (P1 god-object
 * decomposition). Shares the caller's DatabaseHandle.
 */
import { randomUUID } from "node:crypto";
import { eq, and, desc, sql } from "drizzle-orm";
import type { DatabaseHandle } from "../db/client.js";
import { workSessionToolEvents } from "../db/schema.js";
import type { ToolEvent } from "./types.js";
import { rowToToolEvent } from "./internal.js";

export function createWorkSessionToolEventStore(db: DatabaseHandle) {
  return {
    logToolEvent(input: {
      workSessionId: string;
      workspaceSessionId: string;
      tool: string;
      inputJson: string;
      outputSummary?: string;
      path?: string;
      success: boolean;
      elapsedMs: number;
    }): ToolEvent {
      const now = new Date().toISOString();
      const id = `wste_${randomUUID()}`;
      db.db
        .insert(workSessionToolEvents)
        .values({
          id,
          workSessionId: input.workSessionId,
          workspaceSessionId: input.workspaceSessionId,
          tool: input.tool,
          inputJson: input.inputJson,
          outputSummary: input.outputSummary ?? null,
          path: input.path ?? null,
          success: input.success ? 1 : 0,
          elapsedMs: input.elapsedMs,
          createdAt: now,
        })
        .run();
      return {
        id,
        workSessionId: input.workSessionId,
        workspaceSessionId: input.workspaceSessionId,
        tool: input.tool,
        inputJson: input.inputJson,
        outputSummary: input.outputSummary,
        path: input.path,
        success: input.success,
        elapsedMs: input.elapsedMs,
        createdAt: now,
      };
    },

    /** P2 #54: Compact recent summary (default 50). */
    getRecentToolEvents(workSessionId: string, limit = 50): ToolEvent[] {
      const rows = db.db
        .select()
        .from(workSessionToolEvents)
        .where(eq(workSessionToolEvents.workSessionId, workSessionId))
        .orderBy(desc(workSessionToolEvents.createdAt), desc(workSessionToolEvents.id))
        .limit(limit)
        .all();
      return rows.map(rowToToolEvent);
    },

    /** P2 #54: Full history with pagination (cursor-based). */
    listToolEvents(workSessionId: string, afterId?: string, limit = 500): ToolEvent[] {
      const baseCondition = eq(workSessionToolEvents.workSessionId, workSessionId);
      if (afterId) {
        const anchor = db.db
          .select()
          .from(workSessionToolEvents)
          .where(and(
            eq(workSessionToolEvents.id, afterId),
            baseCondition,
          ))
          .get();
        if (!anchor) return [];
        const rows = db.db
          .select()
          .from(workSessionToolEvents)
          .where(and(
            baseCondition,
            sql`(
              ${workSessionToolEvents.createdAt} < ${anchor.createdAt}
              or (
                ${workSessionToolEvents.createdAt} = ${anchor.createdAt}
                and ${workSessionToolEvents.id} < ${anchor.id}
              )
            )`,
          ))
          .orderBy(desc(workSessionToolEvents.createdAt), desc(workSessionToolEvents.id))
          .limit(limit)
          .all();
        return rows.map(rowToToolEvent);
      }
      const rows = db.db
        .select()
        .from(workSessionToolEvents)
        .where(baseCondition)
        .orderBy(desc(workSessionToolEvents.createdAt), desc(workSessionToolEvents.id))
        .limit(limit)
        .all();
      return rows.map(rowToToolEvent);
    },

    /** @deprecated Use getRecentToolEvents() or listToolEvents() */
    getToolEvents(workSessionId: string, limit = 50): ToolEvent[] {
      return this.getRecentToolEvents(workSessionId, limit);
    },
  };
}

export type WorkSessionToolEventStore = ReturnType<typeof createWorkSessionToolEventStore>;
