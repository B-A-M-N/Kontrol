/**
 * SSE hub: run-id keyed Server-Sent-Event fan-out plus client-disconnect
 * abort signals.
 *
 * Extracted verbatim from acp-server.ts's createAcpServer closure (P1
 * decomposition). The hub owns nothing durable — `sseClients` lives on the
 * AcpContext so run-routes and event-routes share one fan-out table.
 */
import type { Request, Response } from "express";
import type { AcpContext } from "./context.js";

export function makeSseHub(ctx: AcpContext) {
  function emitSse(runId: string, event: string, data: unknown): void {
    const clients = ctx.sseClients.get(runId);
    if (!clients) return;
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) {
      try { res.write(payload); } catch { clients.delete(res); }
    }
    if (clients.size === 0) ctx.sseClients.delete(runId);
  }

  function sseSubscribe(runId: string, req: Request, res: Response): void {
    if (!ctx.sseClients.has(runId)) ctx.sseClients.set(runId, new Set());
    ctx.sseClients.get(runId)!.add(res);
    req.on("close", () => {
      const clients = ctx.sseClients.get(runId);
      if (clients) { clients.delete(res); if (clients.size === 0) ctx.sseClients.delete(runId); }
    });
  }

  function requestAbortSignal(req: Request, res: Response): AbortSignal {
    const controller = new AbortController();
    const abortIfDisconnected = () => {
      if (!res.writableFinished) controller.abort();
    };
    req.once("aborted", abortIfDisconnected);
    res.once("close", abortIfDisconnected);
    const cleanup = () => {
      req.removeListener("aborted", abortIfDisconnected);
      res.removeListener("close", abortIfDisconnected);
    };
    res.once("finish", cleanup);
    return controller.signal;
  }

  return { emitSse, sseSubscribe, requestAbortSignal };
}
