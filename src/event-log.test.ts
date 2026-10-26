import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createEventStore } from "./event-log.js";
import { openDatabase } from "./db/client.js";

const stateDir = await mkdtemp(join(tmpdir(), "kontrol-event-log-"));
const database = openDatabase(stateDir);
const timingPhases: string[] = [];
const events = createEventStore(database, (phase) => timingPhases.push(phase));
try {
  for (let i = 0; i < 100; i++) {
    const receipt = events.appendEvent({
      type: "agent.run.output_delta",
      sessionId: "session-1",
      payload: { channel: "message", text: `${i} ` },
    });
    assert.equal(receipt.durable, false, "buffered telemetry must return a non-durable receipt");
    assert.equal(receipt.receipt, true, "buffered telemetry receipt must be explicit");
    assert.equal(receipt.seq, 0, "buffered telemetry must not advance the durable cursor");
  }

  assert.equal(events.getEventsForSession("session-1").length, 0, "fragments are buffered, not inserted one per row");
  events.appendEvent({ type: "agent.run.started", sessionId: "session-1", payload: {} });

  const durable = events.getEventsForSession("session-1");
  assert.equal(durable.length, 2, "one buffered aggregate plus the workflow event is durable");
  assert.equal(durable[0].type, "agent.run.output_delta");
  assert.equal(durable[0].durable, true);
  assert.equal(durable[0].payload.coalesced, true);
  assert.equal(durable[0].payload.count, 100);
  assert.equal(durable[0].payload.text, Array.from({ length: 100 }, (_, i) => `${i} `).join(""));
  assert.equal("segments" in durable[0].payload, false, "coalesced telemetry does not duplicate text in segments");
  assert.equal(durable[1].type, "agent.run.started");
  assert.ok(durable[1].seq > durable[0].seq);
  assert.equal(events.getLatestEventSequenceForSession("session-1"), durable[1].seq,
    "the indexed session watermark matches the newest durable event");
  assert.equal(events.getLatestEventSequenceForSession("session-without-events"), 0,
    "an empty session has a zero event watermark");
  const watermarkPlan = database.sqlite.prepare(
    "EXPLAIN QUERY PLAN select coalesce(max(seq), 0) from event_log where session_id = ?",
  ).all("session-1") as Array<{ detail: string }>;
  assert.ok(watermarkPlan.some((step) => step.detail.includes("event_log_session_seq_idx")),
    "the latest-event watermark uses the session sequence index");
  events.appendEvent({
    type: "session.handoff",
    sessionId: "session-handoff-index",
    payload: { runId: "run-old", transferId: "transfer-old" },
  });
  events.appendEvent({
    type: "session.handoff",
    sessionId: "session-handoff-index",
    payload: { runId: "run-new", transferId: "transfer-new" },
  });
  events.appendEvent({
    type: "session.handoff.state",
    sessionId: "session-handoff-index",
    payload: { transferId: "transfer-old", state: "blocked" },
  });
  events.appendEvent({
    type: "session.handoff.state",
    sessionId: "session-handoff-index",
    payload: { transferId: "transfer-new", state: "committed" },
  });
  assert.equal(events.getLatestEventForSession("session-handoff-index", "session.handoff")?.payload.runId, "run-new",
    "latest typed event lookup returns one newest event without decoding session history");
  assert.equal(events.getLatestEventForSession("session-handoff-index", "session.handoff", { field: "runId", value: "run-old" })?.payload.transferId,
    "transfer-old", "handoff lookup can bind the newest matching run identity");
  assert.equal(events.getLatestEventForSession("session-handoff-index", "session.handoff.state", { field: "transferId", value: "transfer-old" })?.payload.state,
    "blocked", "handoff state lookup is scoped to the exact transfer");
  const handoffLookupPlan = database.sqlite.prepare(`explain query plan select id, seq, type, session_id,
    workspace_session_id, payload, created_at from event_log where session_id = 'session-handoff-index'
    and type = 'session.handoff.state' and (null is null or json_extract(payload, '$.transferId') = 'transfer-old')
    order by seq desc limit 1`).all() as Array<{ detail: string }>;
  assert.ok(handoffLookupPlan.some((row) => row.detail.includes("event_log_session_type_seq_idx")),
    "handoff recovery lookup uses the bounded session/type/sequence index");
  const insertHistory = database.sqlite.prepare(`insert into event_log
    (id, type, session_id, workspace_session_id, payload, created_at)
    values (?, ?, 'session-handoff-index', null, '{}', '2026')`);
  const insertHistoryBatch = database.sqlite.transaction(() => {
    for (let index = 0; index < 2_000; index += 1) {
      insertHistory.run(`history-${index}`, index % 2 ? "agent.run.output_delta" : "agent.run.completed");
    }
  });
  insertHistoryBatch();
  assert.equal(events.getLatestEventForSession("session-handoff-index", "session.handoff")?.payload.runId, "run-new",
    "indexed handoff lookup remains correct with thousands of unrelated lifecycle and telemetry events");
  assert.ok(timingPhases.includes("sqlite.commit"), "event-store writes expose commit timing");
  assert.ok(timingPhases.includes("agent.time_to_first_event"), "first agent event timing is recorded");
  assert.ok(timingPhases.includes("agent.event_interval"), "agent event intervals are recorded");

  const ingressOne = { channel: "message", text: "durable-one " };
  const ingressTwo = { channel: "message", text: "durable-two " };
  assert.deepEqual(events.appendTelemetryIngress({ id: "adapter-event-1", type: "agent.run.output_delta", sessionId: "session-ingress", payload: ingressOne }), {
    eventId: "adapter-event-1", duplicate: false,
  });
  const ingressReceipt = events.getEventById("adapter-event-1");
  assert.equal(ingressReceipt?.durable, true, "the fragment receipt is committed before asynchronous event-log folding");
  assert.equal(ingressReceipt?.ingressReceipt, true);
  assert.equal(ingressReceipt?.seq, 0, "ingress receipts do not invent an event-log cursor");
  assert.equal(events.getEventsForSession("session-ingress").length, 0, "new fragments are folded asynchronously");
  assert.deepEqual(events.appendTelemetryIngress({ id: "adapter-event-1", type: "agent.run.output_delta", sessionId: "session-ingress", payload: ingressOne }), {
    eventId: "adapter-event-1", duplicate: true,
  }, "a retry with the same event id is durably deduplicated before event-log materialization");
  assert.deepEqual(events.appendTelemetryIngress({
    id: "adapter-event-1",
    type: "agent.run.output_delta",
    sessionId: "session-ingress",
    payload: { text: ingressOne.text, channel: ingressOne.channel },
  }), {
    eventId: "adapter-event-1", duplicate: true,
  }, "telemetry retries remain idempotent when object property order changes");
  assert.throws(() => events.appendTelemetryIngress({
    id: "adapter-event-1", type: "agent.run.output_delta", sessionId: "session-ingress", payload: { ...ingressOne, text: "tampered" },
  }), /reused with different telemetry content/);
  events.appendTelemetryIngress({ id: "adapter-event-2", type: "agent.run.output_delta", sessionId: "session-ingress", payload: ingressTwo });
  assert.equal(events.flushTelemetryIngress("session-ingress"), 2);
  const ingressEvents = events.getEventsForSession("session-ingress");
  assert.equal(ingressEvents.length, 1, "durable ingress rows coalesce to one event-log record");
  assert.equal(ingressEvents[0]?.payload.count, 2);
  assert.equal(ingressEvents[0]?.payload.text, "durable-one durable-two ");
  assert.deepEqual(events.appendTelemetryIngress({ id: "adapter-event-1", type: "agent.run.output_delta", sessionId: "session-ingress", payload: ingressOne }), {
    eventId: "adapter-event-1", duplicate: true,
  }, "a retry remains idempotent after the ingress receipt has been materialized");
  assert.throws(() => events.appendTelemetryIngress({
    id: "adapter-event-1", type: "agent.run.output_delta", sessionId: "session-ingress", payload: { ...ingressOne, text: "tampered after commit" },
  }), /reused with different telemetry content/, "a committed event ID cannot be reused with altered content");
  const mappedReceipt = events.getEventById("adapter-event-1");
  assert.equal(mappedReceipt?.id, "adapter-event-1");
  assert.equal(mappedReceipt?.seq, ingressEvents[0]?.seq);
  const tombstone = database.sqlite.prepare("select status, event_log_id, payload_json from telemetry_ingress where event_id = ?")
    .get("adapter-event-1") as { status: string; event_log_id?: string; payload_json?: string | null };
  assert.equal(tombstone.status, "committed");
  assert.equal(tombstone.event_log_id, ingressEvents[0]?.id);
  assert.equal(tombstone.payload_json, null, "committed receipts retain the ID mapping but release fragment payload storage");
  assert.equal(events.flushTelemetryIngress("session-ingress"), 0);

  const interleavedIngress = [
    { id: "adapter-order-1", type: "agent.run.output_delta", payload: { channel: "message", text: "A" } },
    { id: "adapter-order-2", type: "agent.run.thought_delta", payload: { channel: "thought", text: "B" } },
    { id: "adapter-order-3", type: "agent.run.output_delta", payload: { channel: "message", text: "C" } },
  ];
  for (const event of interleavedIngress) {
    events.appendTelemetryIngress({ ...event, sessionId: "session-interleaved" });
  }
  assert.equal(events.flushTelemetryIngress("session-interleaved"), 3);
  const interleavedEvents = events.getEventsForSession("session-interleaved");
  assert.deepEqual(
    interleavedEvents.map((event) => [event.type, event.payload.text]),
    [
      ["agent.run.output_delta", "A"],
      ["agent.run.thought_delta", "B"],
      ["agent.run.output_delta", "C"],
    ],
    "coalescing preserves the original order of interleaved output and thought fragments",
  );

  events.appendTelemetryIngress({
    id: "adapter-order-recent",
    type: "agent.run.output_delta",
    sessionId: "session-retention",
    payload: { channel: "message", text: "recent" },
  });
  events.flushTelemetryIngress("session-retention");
  events.appendTelemetryIngress({
    id: "adapter-order-pending",
    type: "agent.run.output_delta",
    sessionId: "session-retention",
    payload: { channel: "message", text: "pending" },
  });
  database.sqlite.prepare(`
    update telemetry_ingress
       set committed_at = '2000-01-01T00:00:00.000Z'
     where event_id in ('adapter-event-1', 'adapter-event-2')
  `).run();
  const retentionCutoff = "2025-01-01T00:00:00.000Z";
  assert.equal(events.pruneCommittedTelemetryIngress(retentionCutoff, 1), 1, "retention deletes no more than one committed receipt per bounded page");
  assert.equal(
    (database.sqlite.prepare("select count(*) as count from telemetry_ingress where status = 'committed' and committed_at < ?").get(retentionCutoff) as { count: number }).count,
    1,
    "one expired committed tombstone remains for the next page",
  );
  assert.equal(
    (database.sqlite.prepare("select status from telemetry_ingress where event_id = 'adapter-order-pending'").get() as { status: string }).status,
    "pending",
    "pending ingress is retained regardless of age",
  );
  assert.ok(events.getEventById("adapter-order-recent"), "recent committed idempotency receipt remains available");
  assert.equal(events.pruneCommittedTelemetryIngress(retentionCutoff, 1), 1, "a later page removes the next expired committed receipt");
  assert.equal(events.pruneCommittedTelemetryIngress(retentionCutoff, 1), 0, "retention reports a drained page");
  assert.equal(events.getEventById("adapter-event-1"), undefined, "expired adapter tombstones leave the idempotency horizon");

  const now = new Date().toISOString();
  database.sqlite.prepare(`
    insert into workspace_sessions (id, project_id, root, status, mode, managed, created_at, last_used_at)
    values (?, ?, ?, 'active', 'checkout', 'false', ?, ?)
  `).run("workspace-1", "project-1", "/tmp/project-1", now, now);
  database.sqlite.prepare(`
    insert into workspace_sessions (id, project_id, root, status, mode, managed, created_at, last_used_at)
    values (?, ?, ?, 'active', 'checkout', 'false', ?, ?)
  `).run("workspace-2", "project-1", "/tmp/project-1", now, now);
  database.sqlite.prepare(`
    insert into work_sessions (id, project_id, workspace_session_id, status, runtime_state, completion_policy, review_epoch, submitted_by, created_at, updated_at)
    values (?, ?, ?, 'in_progress', 'running', 'agent_completion', 1, 'test', ?, ?)
  `).run("session-ws-1", "project-1", "workspace-1", now, now);
  events.appendEvent({ type: "agent.tool.completed", sessionId: "session-ws-1", payload: { tool: "read" } });
  const cursor = events.getWorkspaceEventsAfter("workspace-1", 0);
  assert.equal(cursor.length, 1, "workspace stream includes events for its work sessions");
  assert.equal(
    events.getWorkspaceEventsAfter("workspace-2", 0).length,
    1,
    "workspace stream resolves a workspace session to its project scope",
  );
  const nextSeq = cursor[cursor.length - 1].seq;
  const pending = events.waitForWorkspaceEventsAfter("workspace-2", nextSeq, 1_000);
  setTimeout(() => {
    events.appendEvent({ type: "review.submitted", sessionId: "session-ws-1", payload: { submissionId: "submission-1" } });
  }, 5);
  const arrived = await pending;
  assert.equal(arrived.length, 1, "workspace waiter wakes for a later session event");
  assert.equal(arrived[0].type, "review.submitted");

  const unrelatedRunEvent = events.appendEvent({
    type: "agent.run.output_delta",
    sessionId: "session-event-progress",
    payload: { runId: "another-run", text: "unrelated" },
  });
  let observedSeq = 0;
  const matchingRunEvent = events.waitForMatchingEventAfter(
    "session-event-progress",
    0,
    (event) => event.payload.runId === "target-run",
    1_000,
    undefined,
    (seq) => { observedSeq = Math.max(observedSeq, seq); },
  );
  assert.equal(observedSeq, unrelatedRunEvent.seq, "durable nonmatching events advance the caller's reconciliation cursor");
  const targetRunEvent = events.appendEvent({
    type: "review.submitted",
    sessionId: "session-event-progress",
    payload: { runId: "target-run" },
  });
  assert.equal((await matchingRunEvent)?.seq, targetRunEvent.seq, "the event waiter still resolves on the matching durable event");
  assert.equal(observedSeq, targetRunEvent.seq, "live matching events also advance the caller's cursor");

  const abortController = new AbortController();
  const aborted = events.waitForWorkspaceEventsAfter("workspace-2", arrived[0].seq, 10_000, abortController.signal);
  abortController.abort();
  assert.deepEqual(await aborted, [], "aborting a workspace waiter settles immediately with no events");

  let secondSubscriberCalls = 0;
  const unsubscribeThrowing = events.subscribe("session-ws-1", () => {
    throw new Error("observer failure");
  });
  const unsubscribeHealthy = events.subscribe("session-ws-1", () => {
    secondSubscriberCalls += 1;
  });
  assert.doesNotThrow(() => {
    events.appendEvent({ type: "review.feedback", sessionId: "session-ws-1", payload: { verdict: "approve" } });
  }, "a subscriber failure must not turn a committed append into an API failure");
  assert.equal(secondSubscriberCalls, 1, "a failing subscriber must not starve later subscribers");
  assert.equal(events.getLatestEvent("session-ws-1", "review.feedback")?.payload.verdict, "approve");
  unsubscribeThrowing();
  unsubscribeHealthy();
} finally {
  events.close();
  database.close();
  await rm(stateDir, { recursive: true, force: true });
}

console.log("event-log.test.ts: all assertions passed");
