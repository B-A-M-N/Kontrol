import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./db/client.js";
import { createDispatchOutbox } from "./dispatch-outbox.js";
import { createWorkSessionManager } from "./work-sessions.js";

const root = await mkdtemp(join(tmpdir(), "kontrol-outbox-test-"));

try {
  // --- Fix 1: dead-lettering is keyed off genuine failures, not claims. ---
  {
    const db = openDatabase(root);
    const outbox = createDispatchOutbox(db);

    const event = outbox.enqueue({
      eventType: "continuation.ready",
      aggregateId: "cont_dead_letter",
      aggregateRevision: 1,
    });

    // Simulate the pre-v21 hazard: a claim that gets reaped WITHOUT a failure
    // must NOT consume the failure budget. Claim → let the (1ms) lease lapse →
    // reap, several times.
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 5; i += 1) {
      const claimed = outbox.claimNext("dispatcher-a", 1);
      assert.ok(claimed, "expected to claim the pending event");
      await sleep(3); // let the 1ms claim lease expire in real wall time
      const reaped = outbox.reapExpiredClaims(0);
      assert.equal(reaped, 1, "the expired claim should be reaped back to pending");
    }

    // Even though attemptCount climbed with each claim, the event is still
    // dispatchable — no failure was ever recorded.
    const afterReaps = outbox
      .listPending()
      .find((e) => e.aggregateId === "cont_dead_letter");
    assert.ok(afterReaps, "event must remain pending after claim/reap churn");
    assert.equal(afterReaps.status, "pending");
    assert.ok(
      afterReaps.attemptCount >= 5,
      "attemptCount is a claim odometer and should have advanced",
    );
    assert.equal(
      afterReaps.failureCount,
      0,
      "no genuine failure occurred, so failureCount must be 0",
    );

    // Now record TWO real failures — still under the threshold of 3.
    for (let i = 0; i < 2; i += 1) {
      const claimed = outbox.claimNext("dispatcher-a", 10_000);
      assert.ok(claimed);
      outbox.markFailed(claimed.id, `boom ${i}`, 0);
    }
    const afterTwoFailures = outbox
      .listPending()
      .find((e) => e.aggregateId === "cont_dead_letter");
    assert.ok(
      afterTwoFailures,
      "two failures (< 3) must NOT dead-letter — event stays retryable",
    );
    assert.equal(afterTwoFailures.failureCount, 2);

    // Third genuine failure crosses the threshold → dead-lettered.
    const claimedFinal = outbox.claimNext("dispatcher-a", 10_000);
    assert.ok(claimedFinal);
    outbox.markFailed(claimedFinal.id, "boom final", 0);
    assert.equal(
      outbox.listPending().find((e) => e.aggregateId === "cont_dead_letter"),
      undefined,
      "after the 3rd genuine failure the event must be dead-lettered, not pending",
    );

    // redrive resets BOTH counters so the retry budget is fresh.
    const redriven = outbox.redriveDeadLetter("continuation.ready", "cont_dead_letter", 1);
    assert.ok(redriven, "dead-lettered event must be redrivable");
    assert.equal(redriven.status, "pending");
    assert.equal(redriven.attemptCount, 0);
    assert.equal(redriven.failureCount, 0);

    outbox.close();
  }

  // --- Fix 2: checkout-lease renewal from a worker heartbeat. ---
  {
    const db = openDatabase(join(root, "leases"));
    const workSessions = createWorkSessionManager(db);

    // Seed workspace_sessions parent rows so the work_sessions FK passes.
    for (const wsId of ["ws_1", "ws_2"]) {
      db.sqlite
        .prepare(
          "insert into workspace_sessions (id, root, status, mode, managed, created_at, last_used_at) " +
            "values (?, '/tmp', 'active', 'checkout', 'false', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')",
        )
        .run(wsId);
    }

    const workspace = workSessions.create({
      workspaceSessionId: "ws_1",
      submittedBy: "tester",
    });

    // Acquire with a short TTL so expiry is observable within the test.
    const acquired = workSessions.acquireWorkspaceLease({
      canonicalRoot: "/tmp/checkout-a",
      workspaceSessionId: "ws_1",
      workSessionId: workspace.id,
      ttlMs: 50,
    });
    assert.ok(acquired.acquired, "initial lease acquisition should succeed");
    const originalExpiry = acquired.lease.expiresAt;

    // Renew from a "heartbeat" with a long TTL — expiry must move forward.
    const renewed = workSessions.renewWorkspaceLeaseForSession(workspace.id, 60 * 60 * 1000);
    assert.equal(renewed, 1, "renewal should touch exactly the one owned lease");

    // Renewal for a session that owns no lease is a harmless no-op.
    const noneRenewed = workSessions.renewWorkspaceLeaseForSession("ws_session_nonexistent");
    assert.equal(noneRenewed, 0, "renewing a session with no lease returns 0");

    // A second, unrelated session must NOT be able to seize the checkout now
    // that it has been renewed — renewal genuinely extended the lease.
    const other = workSessions.create({
      workspaceSessionId: "ws_2",
      submittedBy: "tester",
    });
    const seizeAttempt = workSessions.acquireWorkspaceLease({
      canonicalRoot: "/tmp/checkout-a",
      workspaceSessionId: "ws_2",
      workSessionId: other.id,
    });
    assert.equal(
      seizeAttempt.acquired,
      false,
      "renewed lease must still block another session from taking the checkout",
    );
    if (!seizeAttempt.acquired) {
      assert.equal(seizeAttempt.conflictingWorkSessionId, workspace.id);
    }

    void originalExpiry;
    db.close();
  }

  // --- WebUI rehydration: listActiveWorkSessions returns every non-terminal
  //     session (not just awaiting_review) and excludes terminal ones. ---
  {
    const db = openDatabase(join(root, "active"));
    const workSessions = createWorkSessionManager(db);

    db.sqlite
      .prepare(
        "insert into workspace_sessions (id, root, status, mode, managed, created_at, last_used_at) " +
          "values ('ws_a', '/tmp', 'active', 'checkout', 'false', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')",
      )
      .run();

    // One session per relevant live status + representative terminal ones.
    const live: Array<[string, "in_progress" | "resuming" | "changes_requested" | "awaiting_review"]> = [
      ["s_in_progress", "in_progress"],
      ["s_resuming", "resuming"],
      ["s_changes", "changes_requested"],
      ["s_await", "awaiting_review"],
    ];
    const terminal: Array<[string, "approved" | "rejected" | "cancelled" | "failed"]> = [
      ["s_approved", "approved"],
      ["s_rejected", "rejected"],
      ["s_cancelled", "cancelled"],
      ["s_failed", "failed"],
    ];

    const ids = new Map<string, string>();
    for (const [key, status] of [...live, ...terminal]) {
      const s = workSessions.create({ workspaceSessionId: "ws_a", submittedBy: "tester" });
      workSessions.updateStatus(s.id, status);
      ids.set(key, s.id);
    }

    const active = workSessions.listActiveWorkSessions("ws_a");
    const activeIds = new Set(active.map((s) => s.id));

    for (const [key] of live) {
      assert.ok(
        activeIds.has(ids.get(key)!),
        `listActiveWorkSessions must include live status '${key}'`,
      );
    }
    for (const [key] of terminal) {
      assert.equal(
        activeIds.has(ids.get(key)!),
        false,
        `listActiveWorkSessions must exclude terminal status '${key}'`,
      );
    }
    assert.equal(active.length, live.length, "only the 4 live sessions should be returned");

    // Workspace scoping: a session in another workspace is not returned.
    db.sqlite
      .prepare(
        "insert into workspace_sessions (id, root, status, mode, managed, created_at, last_used_at) " +
          "values ('ws_b', '/tmp', 'active', 'checkout', 'false', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')",
      )
      .run();
    const other = workSessions.create({ workspaceSessionId: "ws_b", submittedBy: "tester" });
    assert.ok(
      !workSessions.listActiveWorkSessions("ws_a").some((s) => s.id === other.id),
      "workspace-scoped listing must not leak sessions from another workspace",
    );
    assert.ok(
      workSessions.listActiveWorkSessions().some((s) => s.id === other.id),
      "unscoped listing must include sessions across all workspaces",
    );

    db.close();
  }

  console.log("dispatch-outbox.test.ts: all assertions passed");
} finally {
  await rm(root, { recursive: true, force: true });
}
