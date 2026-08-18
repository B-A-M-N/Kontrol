import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createEventStore } from "./event-log.js";

const stateDir = await mkdtemp(join(tmpdir(), "kontrol-event-log-"));
const events = createEventStore(stateDir);
try {
  for (let i = 0; i < 100; i++) {
    events.appendEvent({
      type: "agent.run.output_delta",
      sessionId: "session-1",
      payload: { channel: "message", text: `${i} ` },
    });
  }

  assert.equal(events.getEventsForSession("session-1").length, 0, "fragments are buffered, not inserted one per row");
  events.appendEvent({ type: "agent.run.started", sessionId: "session-1", payload: {} });

  const durable = events.getEventsForSession("session-1");
  assert.equal(durable.length, 2, "one aggregate plus the workflow event is durable");
  assert.equal(durable[0].type, "agent.run.output_delta");
  assert.equal(durable[0].payload.coalesced, true);
  assert.equal(durable[0].payload.count, 100);
  assert.equal(durable[0].payload.text, Array.from({ length: 100 }, (_, i) => `${i} `).join(""));
  assert.equal(durable[1].type, "agent.run.started");
  assert.ok(durable[1].seq > durable[0].seq);
} finally {
  events.close();
  await rm(stateDir, { recursive: true, force: true });
}

console.log("event-log.test.ts: all assertions passed");
