import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAdapterEventSpool } from "./adapter-event-spool.mjs";

const directory = await mkdtemp(join(tmpdir(), "kontrol-adapter-event-spool-"));
const eventPath = join(directory, "events.json");
const terminalPath = join(directory, "terminals.json");
const terminalEvent = {
  event_id: "remote-attempt-1:1:2",
  event_sequence: 2,
  type: "completed",
  remote_run_id: "remote-attempt-1",
  attempt_number: 1,
  dispatch_idempotency_key: "dispatch-1",
  payload: { final_output: "first line\nUnicode: café 🌲" },
};
const outputEvent = {
  ...terminalEvent,
  event_id: "remote-attempt-1:1:1",
  event_sequence: 1,
  type: "output_delta",
  payload: { text: terminalEvent.payload.final_output },
};

try {
  const unavailable = createAdapterEventSpool({
    eventPath,
    terminalPath,
    deliver: async () => { throw new Error("controller unavailable"); },
    acknowledgeTerminal: async () => false,
  });
  await unavailable.load();
  assert.equal(await unavailable.enqueue("kontrol-run-1", outputEvent), false);
  assert.equal(await unavailable.enqueue("kontrol-run-1", terminalEvent, true), false);
  assert.deepEqual(unavailable.snapshot(), { pendingEvents: 1, pendingTerminalEvents: 1 },
    "controller outages retain ordered output and terminal evidence on disk");

  const committedEventIds = new Set();
  let closeAfterCommitOnce = true;
  const replay = createAdapterEventSpool({
    eventPath,
    terminalPath,
    deliver: async (_runId, event) => {
      const duplicate = committedEventIds.has(event.event_id);
      committedEventIds.add(event.event_id);
      if (!duplicate && event.type === "completed" && closeAfterCommitOnce) {
        closeAfterCommitOnce = false;
        throw new Error("connection closed after controller commit");
      }
      return {
        ok: true,
        async json() {
          return event.type === "completed" ? {
            dispatch_receipt_acknowledged: true,
            dispatch_idempotency_key: event.dispatch_idempotency_key,
            remote_run_id: event.remote_run_id,
            attempt_number: event.attempt_number,
            event_id: event.event_id,
          } : {};
        },
      };
    },
    acknowledgeTerminal: async (event, body) => body.event_id === event.event_id
      && body.dispatch_idempotency_key === event.dispatch_idempotency_key,
  });
  await replay.load();
  assert.equal(await replay.flush(), true, "restart replay resolves a committed event after losing its HTTP response");
  assert.deepEqual(replay.snapshot(), { pendingEvents: 0, pendingTerminalEvents: 0 });
  assert.equal(committedEventIds.size, 2, "one ordered output and one terminal identity are committed");
  const terminalSpoolOnDisk = JSON.parse(await readFile(terminalPath, "utf8"));
  assert.deepEqual(terminalSpoolOnDisk, [], "the terminal spool clears only after exact acknowledgement");
  assert.equal(replay.nextSequence("remote-attempt-1"), 3,
    "acknowledged events still advance the durable per-attempt event sequence");
  const afterAcknowledgementRestart = createAdapterEventSpool({
    eventPath,
    terminalPath,
    deliver: async () => ({ ok: true, async arrayBuffer() { return new ArrayBuffer(0); } }),
    acknowledgeTerminal: async () => false,
  });
  await afterAcknowledgementRestart.load();
  assert.equal(afterAcknowledgementRestart.nextSequence("remote-attempt-1"), 3,
    "restart does not reuse event IDs after earlier events were acknowledged and removed from the spool");
} finally {
  await rm(directory, { recursive: true, force: true });
}

console.log("adapter-event-spool.test.mjs: all assertions passed");
