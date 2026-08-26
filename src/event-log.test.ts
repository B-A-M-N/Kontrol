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
  assert.equal(durable.length, 2, "one aggregate plus the workflow event is durable");
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

  const now = new Date().toISOString();
  database.sqlite.prepare(`
    insert into workspace_sessions (id, project_id, root, status, mode, managed, created_at, last_used_at)
    values (?, ?, ?, 'active', 'checkout', 'false', ?, ?)
  `).run("workspace-1", "project-1", "/tmp/project-1", now, now);
  database.sqlite.prepare(`
    insert into work_sessions (id, project_id, workspace_session_id, status, runtime_state, completion_policy, review_epoch, submitted_by, created_at, updated_at)
    values (?, ?, ?, 'in_progress', 'running', 'agent_completion', 1, 'test', ?, ?)
  `).run("session-ws-1", "project-1", "workspace-1", now, now);
  events.appendEvent({ type: "agent.tool.completed", sessionId: "session-ws-1", payload: { tool: "read" } });
  const cursor = events.getWorkspaceEventsAfter("workspace-1", 0);
  assert.equal(cursor.length, 1, "workspace stream includes events for its work sessions");
  const nextSeq = cursor[cursor.length - 1].seq;
  const pending = events.waitForWorkspaceEventsAfter("workspace-1", nextSeq, 1_000);
  setTimeout(() => {
    events.appendEvent({ type: "review.submitted", sessionId: "session-ws-1", payload: { submissionId: "submission-1" } });
  }, 5);
  const arrived = await pending;
  assert.equal(arrived.length, 1, "workspace waiter wakes for a later session event");
  assert.equal(arrived[0].type, "review.submitted");
} finally {
  events.close();
  database.close();
  await rm(stateDir, { recursive: true, force: true });
}

console.log("event-log.test.ts: all assertions passed");
