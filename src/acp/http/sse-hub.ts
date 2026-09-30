/**
 * SSE hub: run-id keyed Server-Sent-Event fan-out plus client-disconnect
 * abort signals.
 *
 * The response stream owns subscription lifetime. Node may finish the incoming
 * request while the streaming response remains open, so request completion is
 * not a disconnect signal. Backpressure is bounded per subscriber: a stalled
 * writer is disconnected rather than allowing output to accumulate forever.
 */
import type { Request, Response } from "express";
import type { AcpContext } from "./context.js";

const SSE_KEEPALIVE_INTERVAL_MS = 15_000;
const SSE_MAX_BUFFERED_BYTES = 256 * 1024;
type SseContext = AcpContext & { sseHistory?: Map<string, Array<{ id: string; event: string; data: unknown }>> };

export function makeSseHub(ctx: AcpContext) {
  function emitSse(runId: string, event: string, data: unknown): void {
    const clients = ctx.sseClients.get(runId);
    const id = `${runId}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
    const payload = `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    const history = (ctx as SseContext).sseHistory?.get(runId) ?? [];
    history.push({ id, event, data });
    if (history.length > 256) history.shift();
    (ctx as SseContext).sseHistory?.set(runId, history);
    if (!clients) return;
    for (const res of clients) {
      if (res.destroyed || res.writableEnded) {
        clients.delete(res);
        continue;
      }
      // Express/Node does not expose a portable writableLength on all supported
      // versions. The explicit high-water mark prevents a stalled client from
      // retaining unbounded output while preserving normal burst buffering.
      const buffered = (res as Response & { writableLength?: number }).writableLength ?? 0;
      if (buffered > SSE_MAX_BUFFERED_BYTES) {
        clients.delete(res);
        try { res.end(); } catch { /* stream already closed */ }
        continue;
      }
      try { res.write(payload); } catch { clients.delete(res); }
    }
    if (clients.size === 0) ctx.sseClients.delete(runId);
  }

  function sseSubscribe(runId: string, _req: Request, res: Response, afterId?: string): void {
    if (!ctx.sseClients.has(runId)) ctx.sseClients.set(runId, new Set());
    const clients = ctx.sseClients.get(runId)!;
    clients.add(res);
    if (afterId) {
      const history = (ctx as SseContext).sseHistory?.get(runId) ?? [];
      const start = history.findIndex((entry) => entry.id === afterId);
      if (start >= 0) {
        for (const entry of history.slice(start + 1)) {
          try { res.write(`id: ${entry.id}\nevent: ${entry.event}\ndata: ${JSON.stringify(entry.data)}\n\n`); } catch { break; }
        }
      }
    }
    let removed = false;
    const remove = (): void => {
      if (removed) return;
      removed = true;
      if (keepalive) clearInterval(keepalive);
      res.removeListener("close", remove);
      const current = ctx.sseClients.get(runId);
      if (current) {
        current.delete(res);
        if (current.size === 0) ctx.sseClients.delete(runId);
      }
    };
    const keepalive = setInterval(() => {
      if (res.destroyed || res.writableEnded) {
        remove();
        return;
      }
      try { res.write(": kontrol-heartbeat\n\n"); } catch { remove(); }
    }, SSE_KEEPALIVE_INTERVAL_MS);
    keepalive.unref?.();
    res.once("close", remove);
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
