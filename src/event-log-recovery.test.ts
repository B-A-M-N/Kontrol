import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventStore } from "./event-log.js";
import { openDatabase } from "./db/client.js";

const stateDir = await mkdtemp(join(tmpdir(), "kontrol-event-log-recovery-"));
const payload = { channel: "message", text: "durable before the simulated crash" };
const payloadJson = JSON.stringify(payload);
const sessionId = "session-recovered";
const eventId = "adapter-event-recovered";
const type = "agent.run.output_delta";
const canonicalHashInput = JSON.stringify({
  payload,
  sessionId,
  type,
  workspaceSessionId: "",
});
const payloadSha256 = createHash("sha256").update(canonicalHashInput).digest("hex");
const uncommittedId = "adapter-event-before-commit";
const uncommittedPayload = { channel: "message", text: "retry after rollback" };

try {
  // Persist the receipt, then close SQLite without creating an EventStore.
  // This leaves the same durable pending row as a process exit immediately
  // after the ingress acknowledgement and before asynchronous materialization.
  const firstDatabase = openDatabase(stateDir);
  firstDatabase.sqlite.prepare(`
    insert into telemetry_ingress
      (event_id, session_id, type, payload_json, payload_sha256, publish, status, received_at)
    values (?, ?, ?, ?, ?, 0, 'pending', ?)
  `).run(eventId, sessionId, type, payloadJson, payloadSha256, new Date().toISOString());
  const interruptedTransaction = firstDatabase.sqlite.transaction(() => {
    firstDatabase.sqlite.prepare(`
      insert into telemetry_ingress
        (event_id, session_id, type, payload_json, payload_sha256, publish, status, received_at)
      values (?, ?, ?, ?, ?, 0, 'pending', ?)
    `).run(uncommittedId, sessionId, type, JSON.stringify(uncommittedPayload), "f".repeat(64), new Date().toISOString());
    throw new Error("injected crash before receipt commit");
  });
  assert.throws(interruptedTransaction, /injected crash before receipt commit/);
  firstDatabase.close();

  // A fresh database and event-store instance represents startup recovery.
  const recoveredDatabase = openDatabase(stateDir);
  const events = createEventStore(recoveredDatabase);
  try {
    for (let attempt = 0; attempt < 50; attempt++) {
      const row = recoveredDatabase.sqlite.prepare("select status from telemetry_ingress where event_id = ?")
        .get(eventId) as { status: string };
      if (row.status === "committed") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const receipt = events.getEventById(eventId);
    assert.equal(receipt?.durable, true, "the acknowledged ingress receipt survives event-store restart");
    assert.equal(receipt?.ingressReceipt, true);
    assert.equal(receipt?.payload.text, payload.text, "startup reconciliation materializes the original payload");
    const row = recoveredDatabase.sqlite.prepare("select status, event_log_id from telemetry_ingress where event_id = ?")
      .get(eventId) as { status: string; event_log_id?: string };
    assert.equal(row.status, "committed");
    assert.ok(row.event_log_id, "the recovered receipt points at its materialized event");
    assert.deepEqual(events.appendTelemetryIngress({ id: eventId, type, sessionId, payload }), {
      eventId,
      duplicate: true,
    }, "a retry after simulated restart reuses the durable receipt");
    assert.equal(events.getEventsForSession(sessionId).length, 1, "recovery does not duplicate the materialized event");
    assert.equal(events.getEventById(uncommittedId), undefined, "a rolled-back receipt cannot be mistaken for an acknowledged event");
    assert.deepEqual(events.appendTelemetryIngress({ id: uncommittedId, type, sessionId, payload: uncommittedPayload }), {
      eventId: uncommittedId,
      duplicate: false,
    }, "retry after a pre-commit crash durably records the event");
    assert.equal(events.flushTelemetryIngress(sessionId), 1, "the retried pre-commit event materializes once");
    assert.equal(events.getEventsForSession(sessionId).length, 2, "both the recovered and retried receipts materialize exactly once");
  } finally {
    events.close();
    recoveredDatabase.close();
  }
} finally {
  await rm(stateDir, { recursive: true, force: true });
}

console.log("event-log-recovery.test.ts: durable ingress restart recovery passed");
