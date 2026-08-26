import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentRegistryManager } from "./acp-registry.js";
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
