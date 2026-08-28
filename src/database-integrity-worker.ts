import Database from "better-sqlite3";
import { parentPort, workerData } from "node:worker_threads";

// tsx exposes CommonJS native modules through a namespace wrapper in worker
// threads, while the compiled ESM artifact receives the constructor directly.
const DatabaseConstructor = (Database as unknown as { default?: typeof Database }).default ?? Database;

interface IntegrityWorkerData {
  databasePath: string;
  delayMs?: number;
}

interface IntegrityWorkerResult {
  ok: boolean;
  detail: string;
  durationMs: number;
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function main(): Promise<void> {
  const input = workerData as IntegrityWorkerData;
  const startedAt = performance.now();
  let database: Database.Database | undefined;
  try {
    database = new DatabaseConstructor(input.databasePath, { readonly: true, fileMustExist: true });
    database.pragma("busy_timeout = 1000");
    // Test-only delay lets the regression test model a scan longer than the
    // supervisor's old probe timeout without blocking the serving isolate.
    if (input.delayMs && input.delayMs > 0) await sleep(input.delayMs);
    const result = database.prepare("PRAGMA quick_check").get() as { quick_check?: string } | undefined;
    const detail = String(result?.quick_check ?? "quick_check returned no result");
    parentPort?.postMessage({
      ok: detail === "ok",
      detail,
      durationMs: Math.round(performance.now() - startedAt),
    } satisfies IntegrityWorkerResult);
  } catch (error) {
    parentPort?.postMessage({
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
      durationMs: Math.round(performance.now() - startedAt),
    } satisfies IntegrityWorkerResult);
  } finally {
    database?.close();
  }
}

void main();
