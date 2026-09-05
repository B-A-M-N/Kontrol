/**
 * DatabaseIntegrityMonitor: the out-of-process PRAGMA quick_check diagnostic.
 *
 * Extracted verbatim from server.ts's createServer closure (P0 refactor). The
 * monitor owns its state, deadline timer and worker lifecycle; createServer
 * consumes `integrity.state` for /diagnostics and calls `integrity.stop()` on
 * shutdown.
 */
import { performance } from "node:perf_hooks";
import { Worker } from "node:worker_threads";
import type { ServerConfig } from "../config.js";
import { databasePath } from "../db/client.js";

export interface DatabaseIntegrityStatus {
  ok: boolean;
  status: "pending" | "healthy" | "degraded";
  checkedAt: string | undefined;
  detail: string;
  durationMs: number;
  timedOut: boolean;
}

export function createDatabaseIntegrityMonitor(config: ServerConfig) {
  const INTEGRITY_INTERVAL_MS = config.integrityIntervalMs;
  const INTEGRITY_DEADLINE_MS = config.integrityDeadlineMs;
  const databaseIntegrity: DatabaseIntegrityStatus = {
    ok: false,
    status: "pending",
    checkedAt: undefined,
    detail: "integrity check pending",
    durationMs: 0,
    timedOut: false,
  };
  let integrityWorker: Worker | undefined;
  // Keep the single-flight guard set until a timed-out worker has actually
  // terminated. Clearing only the worker reference in the timeout callback
  // would let a short test interval (or an unusually fast maintenance timer)
  // overlap a still-running diagnostic worker.
  let integrityScanActive = false;
  const refreshDatabaseIntegrity = (): void => {
    // A slow read-only scan is diagnostic work. Never queue a second scan or
    // execute it in the serving isolate while the previous one is running.
    if (integrityScanActive) return;
    const startedAt = performance.now();
    const workerModule = import.meta.url.endsWith(".ts")
      ? "../database-integrity-worker.ts"
      : "../database-integrity-worker.js";
    let worker: Worker;
    try {
      worker = new Worker(new URL(workerModule, import.meta.url), {
        workerData: {
          databasePath: databasePath(config.stateDir),
          delayMs: Number(process.env.KONTROL_INTEGRITY_TEST_DELAY_MS ?? 0),
        },
      });
    } catch (error) {
      // Worker construction can fail synchronously (for example when a
      // packaged worker artifact is missing or the runtime rejects its
      // module options). Integrity is diagnostic work: record the degraded
      // result and keep server construction/serving independent of it.
      databaseIntegrity.ok = false;
      databaseIntegrity.status = "degraded";
      databaseIntegrity.detail = error instanceof Error ? error.message : String(error);
      databaseIntegrity.durationMs = Math.round(performance.now() - startedAt);
      databaseIntegrity.checkedAt = new Date().toISOString();
      databaseIntegrity.timedOut = false;
      console.warn(`[kontrol] database integrity diagnostic unavailable: ${databaseIntegrity.detail}`);
      return;
    }
    integrityScanActive = true;
    integrityWorker = worker;
    const releaseScan = (): void => {
      if (integrityWorker === worker) integrityWorker = undefined;
      integrityScanActive = false;
    };
    let settled = false;
    const finish = (result: { ok: boolean; detail: string; durationMs?: number; timedOut?: boolean }): void => {
      if (settled) return;
      settled = true;
      databaseIntegrity.ok = result.ok;
      databaseIntegrity.status = result.ok ? "healthy" : "degraded";
      databaseIntegrity.detail = result.detail;
      databaseIntegrity.durationMs = result.durationMs ?? Math.round(performance.now() - startedAt);
      databaseIntegrity.checkedAt = new Date().toISOString();
      databaseIntegrity.timedOut = result.timedOut === true;
      if (!result.ok) {
        console.warn(`[kontrol] database integrity diagnostic degraded: ${result.detail}`);
      }
    };
    const deadline = setTimeout(() => {
      finish({
        ok: false,
        detail: `quick_check exceeded ${INTEGRITY_DEADLINE_MS}ms diagnostic deadline`,
        durationMs: INTEGRITY_DEADLINE_MS,
        timedOut: true,
      });
      void worker.terminate().finally(releaseScan);
    }, INTEGRITY_DEADLINE_MS);
    deadline.unref?.();
    worker.once("message", (result: { ok?: boolean; detail?: string; durationMs?: number }) => {
      clearTimeout(deadline);
      finish({
        ok: result.ok === true,
        detail: result.detail ?? "quick_check returned no result",
        durationMs: result.durationMs,
      });
    });
    worker.once("error", (error) => {
      clearTimeout(deadline);
      finish({ ok: false, detail: error instanceof Error ? error.message : String(error) });
      void worker.terminate().finally(releaseScan);
    });
    worker.once("exit", (code) => {
      clearTimeout(deadline);
      if (!settled) finish({ ok: false, detail: `integrity worker exited without a result (code ${code})` });
      releaseScan();
    });
  };
  // Start asynchronously after construction. The initial server bind and all
  // liveness/readiness routes remain available while this diagnostic runs.
  refreshDatabaseIntegrity();
  const databaseIntegrityTimer = setInterval(refreshDatabaseIntegrity, INTEGRITY_INTERVAL_MS);
  databaseIntegrityTimer.unref?.();

  /** Stop the monitor: clear the timer and terminate a live scan worker. */
  async function stop(): Promise<void> {
    clearInterval(databaseIntegrityTimer);
    if (integrityWorker) {
      const worker = integrityWorker;
      integrityWorker = undefined;
      integrityScanActive = false;
      worker.removeAllListeners();
      // A failed bind must not wait indefinitely for a diagnostic worker that
      // is still loading a packaged/tsx module. Stop waiting after a short
      // cleanup bound and unref the worker so the failed server can exit.
      worker.unref?.();
      await Promise.race([
        worker.terminate().catch(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, 500)),
      ]);
    }
  }

  return { state: databaseIntegrity, refresh: refreshDatabaseIntegrity, stop };
}
