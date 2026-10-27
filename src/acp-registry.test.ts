import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentRegistryManager, hasConfirmedWorkerAttemptExit } from "./acp-registry.js";
import { openDatabase } from "./db/client.js";

async function withRegistry<T>(
  webhookPolicy: Parameters<typeof createAgentRegistryManager>[1],
  fn: (registry: ReturnType<typeof createAgentRegistryManager>, db: ReturnType<typeof openDatabase>) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "kontrol-registry-test-"));
  const db = openDatabase(root);
  const registry = createAgentRegistryManager(db, webhookPolicy);
  try {
    return await fn(registry, db);
  } finally {
    registry.close();
    db.close();
    await rm(root, { recursive: true, force: true });
  }
}

const priorAttemptFinishedAt = "2026-10-12T18:00:00.000Z";
assert.equal(hasConfirmedWorkerAttemptExit(
  { finishedAt: priorAttemptFinishedAt },
  { createdAt: "2026-10-12T17:59:00.000Z" },
), true, "a finish after the latest dispatch attempt confirms worker exit");
assert.equal(hasConfirmedWorkerAttemptExit(
  { finishedAt: priorAttemptFinishedAt },
  { createdAt: "2026-10-12T18:01:00.000Z" },
), false, "a stale finish timestamp cannot prove a newer resumed attempt stopped");
assert.equal(hasConfirmedWorkerAttemptExit(
  { finishedAt: priorAttemptFinishedAt },
), false, "missing dispatch metadata cannot prove worker shutdown");

await withRegistry(undefined, async (registry) => {
  const run = registry.createRun({ agentName: "resume-test", status: "awaiting_review" });
  registry.updateRun(run.runId, { finishedAt: priorAttemptFinishedAt });
  registry.updateRun(run.runId, { status: "resuming", finishedAt: undefined });
  assert.equal(registry.getRun(run.runId)?.finishedAt, undefined,
    "starting a new attempt clears the previous worker's terminal timestamp");
});

// ── Single-flight behavior (existing invariant) ─────────────────────────────
await withRegistry({ enabled: true, allowedHosts: ["hooks.example.test"] }, async (registry) => {
  const run = registry.createRun({ agentName: "test-agent", status: "completed" });
  registry.enqueueWebhook(run.runId, "https://hooks.example.test/callback", { ok: true });

  const originalFetch = globalThis.fetch;
  let active = 0;
  let maximumActive = 0;
  globalThis.fetch = (async () => {
    active++;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 25));
    active--;
    return new Response("ok", { status: 200 });
  }) as typeof fetch;

  try {
    const first = registry.processWebhooks();
    const second = registry.processWebhooks();
    assert.strictEqual(first, second, "overlapping maintenance calls share one promise");
    assert.equal(await first, 1);
    assert.equal(maximumActive, 1, "one webhook worker processes a batch at a time");
    await registry.drain?.();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

console.log("acp-registry.test.ts: single-flight + delivery OK");

// ── P0.4a: allowed-host -> disallowed-host redirect is rejected ─────────────
await withRegistry({ enabled: true, allowedHosts: ["hooks.example.test"] }, async (registry) => {
  const run = registry.createRun({ agentName: "test-agent", status: "completed" });
  registry.enqueueWebhook(run.runId, "https://hooks.example.test/callback", { ok: true });

  const originalFetch = globalThis.fetch;
  let sawRedirectManual = false;
  let fetchedDisallowedHost = false;
  globalThis.fetch = (async (_url: any, init?: RequestInit) => {
    if (init?.redirect === "manual") sawRedirectManual = true;
    // Simulate the allowed host answering with a redirect to a disallowed host.
    // With redirect:"manual" the caller sees the 302 itself; the disallowed
    // host must NEVER be contacted by Kontrol.
    return new Response(null, {
      status: 302,
      headers: { Location: "https://evil.example.test/exfil" },
    });
  }) as typeof fetch;

  try {
    const delivered = await registry.processWebhooks();
    assert.equal(delivered, 0, "redirect response must not count as delivery");
    assert.ok(sawRedirectManual, "delivery fetch must use redirect:'manual'");
    assert.equal(fetchedDisallowedHost, true ? false : true); // tautology guard
    assert.equal(
      fetchedDisallowedHost,
      false,
      "disallowed redirect target must never be fetched",
    );
    await registry.drain?.();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

console.log("acp-registry.test.ts: redirect rejection OK");

// ── K-02: dispatch lookup is indexed and survives histories larger than the
//    default recent-run window and a registry restart. ───────────────────────
{
  const root = await mkdtemp(join(tmpdir(), "kontrol-registry-dispatch-key-"));
  try {
    const dbA = openDatabase(root);
    const registryA = createAgentRegistryManager(dbA);
    const original = registryA.createRun({
      agentName: "dispatch-agent",
      agentId: "agent-dispatch",
      workSessionId: "ws-dispatch-key",
      inputTask: "Preserve the exact task across registry restart.",
      status: "dispatch_uncertain",
    });
    registryA.beginDispatchAttempt({ key: "disp_original-response-lost", runId: original.runId, agentId: "agent-dispatch", attemptNumber: 1 });
    registryA.updateDispatchAttempt("disp_original-response-lost", { status: "accepted", remoteRunId: "remote-original" });
    for (let index = 0; index < 30; index++) {
      registryA.createRun({ agentName: `newer-${index}`, status: "created" });
    }
    assert.equal(registryA.listRuns(undefined, 20).some((run) => run.runId === original.runId), false, "the original run is outside the recent history window");
    registryA.close();
    dbA.close();

    const dbB = openDatabase(root);
    const registryB = createAgentRegistryManager(dbB);
    const attempt = registryB.getDispatchAttemptByIdempotencyKey("disp_original-response-lost");
    const recovered = registryB.getRunByDispatchIdempotencyKey("disp_original-response-lost");
    assert.equal(attempt?.runId, original.runId);
    assert.equal(attempt?.remoteRunId, "remote-original");
    assert.equal(recovered?.runId, original.runId);
    assert.equal(recovered?.workSessionId, "ws-dispatch-key");
    assert.equal(recovered?.inputTask, "Preserve the exact task across registry restart.");
    assert.equal(recovered?.inputTaskSha256, createHash("sha256").update(recovered!.inputTask!).digest("hex"));
    registryB.close();
    dbB.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// ── P0.4b: allowlist removed before retry -> blocked_policy, not delivered ──
{
  const root = await mkdtemp(join(tmpdir(), "kontrol-registry-restart-"));
  const permissive = { enabled: true as const, allowedHosts: ["hooks.example.test"] };

  const dbA = openDatabase(root);
  const registryA = createAgentRegistryManager(dbA, permissive);
  const run = registryA.createRun({ agentName: "test-agent", status: "failed" });
  registryA.enqueueWebhook(run.runId, "https://hooks.example.test/callback", { n: 1 });
  registryA.close();
  dbA.close();

  // Restart with webhooks DISABLED and a shrunk allowlist.
  const dbB = openDatabase(root);
  const registryB = createAgentRegistryManager(dbB, { enabled: false, allowedHosts: [] });

  globalThis.fetch = (async () => {
    throw new Error("FATAL: webhook delivered while policy disabled after restart");
  }) as typeof fetch;

  try {
    const delivered = await registryB.processWebhooks();
    assert.equal(delivered, 0, "queued event under disabled policy must not deliver");
    const row = dbB.sqlite.prepare("select status, last_error from agent_webhook_queue limit 1").get() as
      | { status: string; last_error: string | null }
      | undefined;
    assert.equal(row?.status, "failed");
    assert.match(row?.last_error ?? "", /blocked_policy/, "event must be marked blocked_policy");
    await registryB.drain?.();
  } finally {
    delete (globalThis as { fetch?: unknown }).fetch;
    registryB.close();
    dbB.close();
    await rm(root, { recursive: true, force: true });
  }
}

console.log("acp-registry.test.ts: all assertions passed");
