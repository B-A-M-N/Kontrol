import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContinuationManager } from "./continuation.js";

const root = await mkdtemp(join(tmpdir(), "devdesktop-continuation-test-"));

try {
  testAtomicClaim();
  testClaimOldest();
  testSupersedeForSession();
  console.log("continuation.test.ts: all assertions passed");
} finally {
  await rm(root, { recursive: true, force: true });
}

function makeManager(): ReturnType<typeof createContinuationManager> {
  return createContinuationManager(join(root, `m-${Math.random().toString(36).slice(2)}`));
}

// The claim must be atomic: only the first dispatcher to claim a pending
// continuation succeeds, preventing duplicate re-dispatch of the same review
// feedback (the "claimed once" / "duplicate agents fail over" guarantee).
function testAtomicClaim(): void {
  const m = makeManager();
  const cont = m.create({
    sessionId: "wsess_test",
    reviewId: "wssub_test",
    feedbackEventId: "evt_test",
    verdict: "changes_requested",
    feedbackSummary: "fix the thing",
  });
  assert.equal(cont.status, "pending");

  const first = m.claim("dispatcher-a", { id: cont.id });
  assert.ok(first, "first claim should succeed");
  assert.equal(first?.status, "claimed");
  assert.equal(first?.claimOwner, "dispatcher-a");

  const second = m.claim("dispatcher-b", { id: cont.id });
  assert.equal(second, null, "concurrent second claim must be rejected (CAS)");

  assert.equal(m.listPending().length, 0, "claimed continuation must leave the pending list");

  assert.equal(
    m.markDelivered({
      id: first!.id,
      expectedStatus: "claimed",
      claimOwner: "dispatcher-a",
      targetRunId: "run-a",
    }),
    true,
  );
  assert.equal(m.get(first!.id)?.status, "dispatched");
  m.markCompleted(first!.id);
  assert.equal(m.get(first!.id)?.status, "completed");
  m.close();
}

function testClaimOldest(): void {
  const m = makeManager();
  const a = m.create({ sessionId: "s1", reviewId: "r1", feedbackEventId: "e1", verdict: "changes_requested" });
  const b = m.create({ sessionId: "s2", reviewId: "r2", feedbackEventId: "e2", verdict: "changes_requested" });

  const claimed = m.claim("dispatcher-x");
  assert.ok(claimed);
  assert.equal(claimed?.id, a.id, "oldest pending continuation is claimed first");

  const next = m.claim("dispatcher-x");
  assert.ok(next);
  assert.equal(next?.id, b.id, "next oldest is claimed on the following poll");

  m.close();
}

function testSupersedeForSession(): void {
  const m = makeManager();
  const pending = m.create({ sessionId: "s1", reviewId: "r1", feedbackEventId: "e1", verdict: "changes_requested" });
  const claimed = m.create({ sessionId: "s1", reviewId: "r2", feedbackEventId: "e2", verdict: "changes_requested" });
  const other = m.create({ sessionId: "s2", reviewId: "r3", feedbackEventId: "e3", verdict: "changes_requested" });
  assert.ok(m.claim("live-worker:s1", { id: claimed.id }));

  const count = m.supersedeForSession("s1", "session cancelled");
  assert.equal(count, 2, "pending and claimed continuations are superseded");
  assert.equal(m.get(pending.id)?.status, "superseded");
  assert.equal(m.get(claimed.id)?.status, "superseded");
  assert.equal(m.get(other.id)?.status, "pending");
  assert.equal(m.listPending("s1").length, 0);
  assert.equal(m.listPending("s2").length, 1);
  assert.equal(
    m.markDelivered({
      id: claimed.id,
      expectedStatus: "claimed",
      claimOwner: "live-worker:s1",
      targetRunId: "late-run",
    }),
    false,
    "superseded continuation cannot be overwritten as dispatched",
  );

  m.close();
}
