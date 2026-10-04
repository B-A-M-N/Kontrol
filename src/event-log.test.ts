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
  assert.throws(() => events.appendTelemetryIngress({
    id: "adapter-event-1", type: "agent.run.output_delta", sessionId: "session-ingress", payload: { ...ingressOne, text: "tampered" },
  }), /reused with different telemetry content/);
  events.appendTelemetryIngress({ id: "adapter-event-2", type: "agent.run.output_delta", sessionId: "session-ingress", payload: ingressTwo });
  assert.equal(events.flushTelemetryIngress("session-ingress"), 2);
  const ingressEvents = events.getEventsForSession("session-ingress");
  assert.equal(ingressEvents.length, 1, "durable ingress rows coalesce to one event-log record");
  assert.equal(ingressEvents[0]?.payload.count, 2);
  assert.equal(ingressEvents[0]?.payload.text, "durable-one durable-two ");
  const mappedReceipt = events.getEventById("adapter-event-1");
  assert.equal(mappedReceipt?.id, "adapter-event-1");
  assert.equal(mappedReceipt?.seq, ingressEvents[0]?.seq);
  const tombstone = database.sqlite.prepare("select status, event_log_id, payload_json from telemetry_ingress where event_id = ?")
    .get("adapter-event-1") as { status: string; event_log_id?: string; payload_json?: string | null };
  assert.equal(tombstone.status, "committed");
  assert.equal(tombstone.event_log_id, ingressEvents[0]?.id);
  assert.equal(tombstone.payload_json, null, "committed receipts retain the ID mapping but release fragment payload storage");
  assert.equal(events.flushTelemetryIngress("session-ingress"), 0);

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
