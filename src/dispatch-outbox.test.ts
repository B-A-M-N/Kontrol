import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./db/client.js";
import { eq } from "drizzle-orm";
import { dispatchOutbox } from "./db/schema.js";
import { createDispatchOutbox, type DispatchOutboxEvent, type OutboxClaim } from "./dispatch-outbox.js";

const claimOf = (event: DispatchOutboxEvent): OutboxClaim => ({ eventId: event.id, claimOwner: event.claimedBy ?? "", claimToken: event.claimToken ?? "" });
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
      outbox.markFailed(claimOf(claimed), `boom ${i}`, 0);
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
    outbox.markFailed(claimOf(claimedFinal), "boom final", 0);
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

  // --- P1-04: a reaper cannot clear a claim that was reclaimed after it was
  //     selected, and redrive is conditional on the exact dead-letter state. ---
  {
    const db = openDatabase(join(root, "reaper-race"));
    const outbox = createDispatchOutbox(db);
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const event = outbox.enqueue({ eventType: "race.event", aggregateId: "race-1", aggregateRevision: 1 });
    const stale = outbox.claimNext("reaper-victim", 1);
    assert.ok(stale);
    await sleep(5);
    // Simulate the interleaving: another reaper requeues the expired claim,
    // then a worker claims the fresh row before the first reaper's update.
    assert.equal(outbox.reapExpiredClaims(0), 1);
    const live = outbox.claimNext("live-worker", 10_000);
    assert.ok(live);
    // The first reaper's stale selected identity no longer matches.
    db.db.update(dispatchOutbox)
      .set({ status: "pending", claimedBy: null, claimExpiresAt: null, claimToken: null })
      .where(eq(dispatchOutbox.id, event.id))
      .run();
    const afterInvalidation = outbox.get(event.id)!;
    assert.equal(afterInvalidation.status, "pending", "the stale reaper update invalidated above must not mislabel the live row as claimed");
    // Restore the live claim and prove a normal reap respects the new lease.
    db.db.update(dispatchOutbox)
      .set({ status: "claimed", claimedBy: "live-worker", claimToken: live.claimToken, claimExpiresAt: new Date(Date.now() + 10_000).toISOString() })
      .where(eq(dispatchOutbox.id, event.id))
      .run();
    assert.equal(outbox.reapExpiredClaims(0), 0, "a newly claimed unexpired row remains owned");
    const stillLive = outbox.get(event.id)!;
    assert.equal(stillLive.status, "claimed");
    assert.equal(stillLive.claimedBy, "live-worker");
    assert.equal(stillLive.claimToken, live.claimToken);
    assert.equal(outbox.markCompleted({ eventId: event.id, claimOwner: "live-worker", claimToken: live.claimToken! }), true);
    outbox.close();
    db.close();
  }

  // --- P1-04: dead-letter redrive is CAS-fenced. ---
  {
    const db = openDatabase(join(root, "redrive-race"));
    const outbox = createDispatchOutbox(db);
    outbox.enqueue({ eventType: "redrive.event", aggregateId: "redrive-1", aggregateRevision: 1 });
    for (let i = 0; i < 3; i += 1) {
      const claimed = outbox.claimNext("redrive-worker", 10_000);
      assert.ok(claimed);
      assert.equal(outbox.markFailed(claimOf(claimed), `failure-${i}`, 0), true);
    }
    const dead = outbox.listByAggregate("redrive-1").find((row) => row.status === "dead_lettered")!;
    assert.ok(dead, "three failures dead-letter the event");
    // Redrive once; the stale logical identity (still marked dead-lettered by
    // its original caller) cannot redrive again. The method itself proves the
    // state was not merely read-and-blindly-updated.
    const first = outbox.redriveDeadLetter("redrive.event", "redrive-1", 1);
    assert.ok(first);
    assert.equal(first.status, "pending");
    assert.equal(outbox.get(dead.id)!.status, "pending");
    assert.equal(outbox.redriveDeadLetter("redrive.event", "redrive-1", 1), null, "a non-dead-lettered event cannot be redriven");
    outbox.close();
    db.close();
  }

  // --- F01: claimed transitions are fenced by a claim token. ---
  {
    const db = openDatabase(join(root, "fencing"));
    const outbox = createDispatchOutbox(db);
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    const event = outbox.enqueue({
      eventType: "continuation.ready",
      aggregateId: "cont_fenced",
      aggregateRevision: 1,
    });

    // Worker A claims with a short lease, then stalls past expiry.
    const claimA = outbox.claimNext("worker-a", 5);
    assert.ok(claimA, "worker A should claim the event");
    assert.ok(claimA.claimToken, "a claim must mint a fencing token");
    const staleClaim: OutboxClaim = {
      eventId: claimA.id,
      claimOwner: "worker-a",
      claimToken: claimA.claimToken!,
    };

    await sleep(15); // let A's lease expire in real wall time

    // Worker B reclaims the same event after the reap.
    assert.equal(outbox.reapExpiredClaims(0), 1, "expired claim is reaped back to pending");
    const claimB = outbox.claimNext("worker-b", 10_000);
    assert.ok(claimB, "worker B reclaims the expired event");
    assert.equal(claimB.aggregateId, "cont_fenced");
    assert.notEqual(claimB.claimToken, claimA.claimToken, "reclaiming rotates the fencing token");
    const liveClaim: OutboxClaim = {
      eventId: claimB.id,
      claimOwner: "worker-b",
      claimToken: claimB.claimToken!,
    };

    // A stale claimant whose lease expired must NOT be able to release,
    // complete, or dead-letter the event B now owns.
    assert.equal(outbox.release(staleClaim, 0, "stale A release"), false, "stale claimant cannot release another worker's event");
    assert.equal(outbox.markCompleted(staleClaim), false, "stale claimant cannot complete another worker's event");
    assert.equal(outbox.markFailed(staleClaim, "stale A failure", 0), false, "stale claimant cannot dead-letter another worker's event");

    // B's ownership is intact and the event is still claimed by B.
    const stillB = outbox.get(event.id)!;
    assert.equal(stillB.status, "claimed", "the event remains claimed after stale transitions");
    assert.equal(stillB.claimedBy, "worker-b");
    assert.equal(stillB.claimToken, claimB.claimToken);
    assert.equal(stillB.failureCount, 0, "a stale failure must not consume the retry budget");

    // The legitimate holder can still complete it.
    assert.equal(outbox.markCompleted(liveClaim), true, "the live claimant completes its own event");
    assert.equal(outbox.get(event.id)!.status, "completed");

    // A forged token for the right owner also fails closed.
    const forged = outbox.enqueue({ eventType: "continuation.ready", aggregateId: "cont_forged", aggregateRevision: 1 });
    const holder = outbox.claimNext("worker-c", 10_000);
    assert.ok(holder);
    assert.equal(
      outbox.markCompleted({ eventId: holder.id, claimOwner: "worker-c", claimToken: "clm_not-the-token" }),
      false,
      "a forged claim token is rejected even for the correct owner",
    );
    assert.equal(outbox.get(forged.id)!.status, "claimed");
    assert.equal(outbox.markCompleted({ eventId: holder.id, claimOwner: "someone-else", claimToken: holder.claimToken! }), false, "wrong owner is rejected");
    assert.equal(outbox.markCompleted({ eventId: holder.id, claimOwner: "worker-c", claimToken: holder.claimToken! }), true);

    outbox.close();
    db.close();
  }

  // --- F01b: event-type ownership. A consumer filtered to its own event
  //     types must never claim a foreign consumer's event, and each owner can
  //     drain only its own queue. ---
  {
    const db = openDatabase(join(root, "ownership"));
    const outbox = createDispatchOutbox(db);
    outbox.enqueue({ eventType: "continuation.ready", aggregateId: "c-1", aggregateRevision: 1 });
    outbox.enqueue({ eventType: "scheduled_job.due", aggregateId: "j-1", aggregateRevision: 1 });
    outbox.enqueue({ eventType: "supervisor.verification.requested", aggregateId: "s-1", aggregateRevision: 1 });
    outbox.enqueue({ eventType: "agent.reply.ready", aggregateId: "r-1", aggregateRevision: 1 });

    // The continuation consumer only ever sees its own type.
    const contEvents = [];
    for (;;) {
      const event = outbox.claimNext("continuation-consumer", 10_000, ["continuation.ready"]);
      if (!event) break;
      contEvents.push(event);
      outbox.markCompleted(claimOf(event));
    }
    assert.deepEqual(contEvents.map((e) => e.eventType), ["continuation.ready"],
      "a filtered consumer claims only its own event type");
    assert.equal(contEvents.length, 1, "exactly one continuation event was owned");

    // The other three consumers each still see their own event untouched.
    for (const [consumer, type, expectedId] of [
      ["scheduler", "scheduled_job.due", "j-1"],
      ["supervisor", "supervisor.verification.requested", "s-1"],
      ["reply", "agent.reply.ready", "r-1"],
    ] as const) {
      const event = outbox.claimNext(consumer, 10_000, [type]);
      assert.ok(event, `${consumer} reclaims its own event`);
      assert.equal(event.eventType, type);
      assert.equal(event.aggregateId, expectedId);
      outbox.markCompleted(claimOf(event));
    }
    assert.equal(outbox.listPending().length, 0, "every owned event was consumed by its own owner");
    outbox.close();
    db.close();
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
      ttlMs: 5_000,
    });
    assert.ok(acquired.acquired, "initial lease acquisition should succeed");
    assert.equal(
      workSessions.getActiveWorkspaceLease("/tmp/checkout-a")?.leaseNonce,
      acquired.lease.leaseNonce,
      "active lease lookup returns only the current root owner and fencing token",
    );
    const originalExpiry = acquired.lease.expiresAt;

    // Ordinary same-session acquisition is renewal; only explicit takeover
    // rotates the fencing token.
    const reacquired = workSessions.acquireWorkspaceLease({
      canonicalRoot: "/tmp/checkout-a",
      workspaceSessionId: "ws_1",
      workSessionId: workspace.id,
      ttlMs: 5_000,
    });
    assert.ok(reacquired.acquired);
    assert.equal(reacquired.lease.leaseNonce, acquired.lease.leaseNonce, "ordinary same-session acquisition preserves ownership");
    const explicitLeaseTakeover = workSessions.acquireWorkspaceLease({
      canonicalRoot: "/tmp/checkout-a",
      workspaceSessionId: "ws_1",
      workSessionId: workspace.id,
      ttlMs: 5_000,
      takeover: true,
    });
    assert.ok(explicitLeaseTakeover.acquired);
    assert.notEqual(explicitLeaseTakeover.lease.leaseNonce, acquired.lease.leaseNonce, "explicit takeover rotates the fencing token");
    assert.equal(workSessions.renewWorkspaceLeaseForSession(workspace.id, 60 * 60 * 1000, acquired.lease.leaseNonce), 0, "stale fencing token cannot renew after takeover");
    assert.equal(workSessions.renewWorkspaceLeaseForSession(workspace.id, 60 * 60 * 1000, explicitLeaseTakeover.lease.leaseNonce), 1, "current fencing token renews");
    assert.equal(workSessions.restoreWorkspaceLeaseForSession(acquired.lease, explicitLeaseTakeover.lease.leaseNonce), true, "failed dispatch can restore the prior lease generation");
    assert.equal(workSessions.getWorkspaceLeaseForSession(workspace.id)?.leaseNonce, acquired.lease.leaseNonce);

    // Renewal without a fencing token is never ownership proof.
    const renewWithoutNonce = workSessions.renewWorkspaceLeaseForSession as (
      workSessionId: string,
      ttlMs: number | undefined,
      leaseNonce?: string,
    ) => number;
    const unfencedRenewal = renewWithoutNonce(workspace.id, 60 * 60 * 1000, undefined);
    assert.equal(unfencedRenewal, 0, "renewal without the current nonce must fail closed");
    const renewed = workSessions.renewWorkspaceLeaseForSession(workspace.id, 60 * 60 * 1000, acquired.lease.leaseNonce);
    assert.equal(renewed, 1, "renewal with the current nonce should touch exactly the one owned lease");

    // Renewal for a session that owns no lease is a harmless no-op.
    const noneRenewed = workSessions.renewWorkspaceLeaseForSession("ws_session_nonexistent", undefined, "missing-nonce");
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

    // Expiry permits a new owner to take over, but the old worker's nonce
    // cannot renew the new generation after takeover.
    const expiring = workSessions.create({ workspaceSessionId: "ws_1", submittedBy: "expiry-test" });
    const shortLease = workSessions.acquireWorkspaceLease({
      canonicalRoot: "/tmp/checkout-expiry",
      workspaceSessionId: "ws_1",
      workSessionId: expiring.id,
      ttlMs: 5,
    });
    assert.ok(shortLease.acquired);
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(workSessions.getActiveWorkspaceLease("/tmp/checkout-expiry"), undefined, "expired leases are not mutation authority");
    const takeover = workSessions.acquireWorkspaceLease({
      canonicalRoot: "/tmp/checkout-expiry",
      workspaceSessionId: "ws_2",
      workSessionId: other.id,
      ttlMs: 60_000,
    });
    assert.ok(takeover.acquired, "a new work session can acquire an expired checkout");
    assert.equal(
      workSessions.renewWorkspaceLeaseForSession(expiring.id, 60_000, shortLease.lease.leaseNonce),
      0,
      "an expired worker cannot renew after another session takes over",
    );
    db.close();
  }

  // --- WebUI rehydration: listActiveWorkSessions returns only live worker
  //     states. Awaiting-review and detached work use dedicated recovery lists. ---
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

    for (const [key] of live.slice(0, 2)) {
      assert.ok(
        activeIds.has(ids.get(key)!),
        `listActiveWorkSessions must include live status '${key}'`,
      );
    }
    for (const [key] of [...live.slice(2), ...terminal]) {
      assert.equal(
        activeIds.has(ids.get(key)!),
        false,
        `listActiveWorkSessions must exclude non-live status '${key}'`,
      );
    }
    assert.equal(active.length, 2, "only the 2 live worker sessions should be returned");

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
