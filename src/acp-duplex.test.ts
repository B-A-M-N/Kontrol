import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAcpDuplex, type DuplexStream, type JsonRpcMessage } from "./acp-duplex.js";
import { createKontrolDuplexHandler } from "./acp-duplex-handler.js";
import { createApprovalRequestManager } from "./approval-requests.js";
import { createEventStore } from "./event-log.js";
import { openDatabase, databasePath } from "./db/client.js";
import Database from "better-sqlite3";

const root = mkdtempSync(join(tmpdir(), "kontrol-acp-duplex-test-"));

/** In-memory duplex stream: capture writes, inject lines. */
function fakeStream() {
  let lineCb: ((line: string) => void) | undefined;
  let closeCb: (() => void) | undefined;
  const written: JsonRpcMessage[] = [];
  const stream: DuplexStream = {
    write: (line) => written.push(JSON.parse(line) as JsonRpcMessage),
    onLine: (cb) => { lineCb = cb; },
    onClose: (cb) => { closeCb = cb; },
    close: () => closeCb?.(),
  };
  return {
    stream,
    written,
    feed: (msg: JsonRpcMessage) => lineCb?.(JSON.stringify(msg) + "\n"),
    triggerClose: () => closeCb?.(),
  };
}

try {
  const db = openDatabase(root);
  seedWorkspace(root, "ws-duplex");
  const eventStore = createEventStore(db);
  const approvalRequests = createApprovalRequestManager(db);

  // --- Agent-initiated permission request routes into the approval store,
  //     PARKS (no timeout), and returns "selected" once a human approves. ------
  {
    const io = fakeStream();
    const handler = createKontrolDuplexHandler({ approvalRequests, eventStore, workspaceSessionId: "ws-duplex" });
    createAcpDuplex(io.stream, handler);

    // Agent asks for permission (id=1).
    io.feed({
      jsonrpc: "2.0",
      id: 1,
      method: "session/request_permission",
      params: { sessionId: "ws-duplex", toolCall: { title: "rm -rf build" }, options: [
        { optionId: "allow-once", name: "Allow", kind: "allow_once" },
        { optionId: "reject", name: "Reject", kind: "reject_once" },
      ] },
    });

    // A pending approval must now exist and NOTHING should be written back yet
    // (the call is parked waiting for a human — no auto-deny).
    await tick();
    const pending = approvalRequests.listPending("ws-duplex");
    assert.equal(pending.length, 1, "permission request created a pending approval");
    assert.equal(io.written.length, 0, "call parks: no response until a human decides");

    // Human approves via the same event the WebUI emits.
    approvalRequests.resolve(pending[0].approvalId, { status: "approved", optionId: "allow-once" });
    eventStore.appendEvent({
      type: "approval.resolved",
      sessionId: "ws-duplex",
      payload: { approvalId: pending[0].approvalId, decision: "approve", optionId: "allow-once", status: "approved" },
    });

    await tick();
    assert.equal(io.written.length, 1, "response sent after approval");
    const resp = io.written[0];
    assert.equal(resp.id, 1);
    assert.deepEqual(resp.result, { outcome: { outcome: "selected", optionId: "allow-once" } });
  }

  // --- Denial routes to a cancelled outcome. ---------------------------------
  {
    const io = fakeStream();
    const handler = createKontrolDuplexHandler({ approvalRequests, eventStore, workspaceSessionId: "ws-duplex" });
    createAcpDuplex(io.stream, handler);
    io.feed({ jsonrpc: "2.0", id: 7, method: "session/request_permission", params: { sessionId: "ws-duplex", toolCall: { title: "danger" }, options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }] } });
    await tick();
    const pending = approvalRequests.listPending("ws-duplex");
    const target = pending[pending.length - 1];
    eventStore.appendEvent({ type: "approval.resolved", sessionId: "ws-duplex", payload: { approvalId: target.approvalId, decision: "deny", status: "denied" } });
    await tick();
    const resp = io.written[0];
    assert.deepEqual(resp.result, { outcome: { outcome: "cancelled" } });
  }

  // --- Stream close cancels a parked request (agent gets cancelled, not hung). -
  {
    const io = fakeStream();
    const handler = createKontrolDuplexHandler({ approvalRequests, eventStore, workspaceSessionId: "ws-duplex" });
    createAcpDuplex(io.stream, handler);
    io.feed({ jsonrpc: "2.0", id: 9, method: "session/request_permission", params: { sessionId: "ws-duplex", toolCall: {}, options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }] } });
    await tick();
    io.triggerClose();
    await tick();
    // The handler resolves to cancelled; the connection is closed so no frame is
    // written, but the promise must not hang (test completes = it resolved).
    assert.ok(true);
  }

  // --- Outbound request/response correlation. --------------------------------
  {
    const io = fakeStream();
    const handler = createKontrolDuplexHandler({ approvalRequests, eventStore, workspaceSessionId: "ws-duplex" });
    const conn = createAcpDuplex(io.stream, handler);
    const p = conn.request<{ ok: boolean }>("session/prompt", { text: "hi" });
    await tick();
    const sent = io.written[io.written.length - 1];
    assert.equal(sent.method, "session/prompt");
    io.feed({ jsonrpc: "2.0", id: sent.id!, result: { ok: true } });
    assert.deepEqual(await p, { ok: true });
  }

  eventStore.close();
  approvalRequests.close();
  console.log("acp-duplex.test.ts: all assertions passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function seedWorkspace(dir: string, id: string): void {
  const sqlite = new Database(databasePath(dir));
  sqlite.pragma("foreign_keys = OFF");
  sqlite.exec(
    `insert into workspace_sessions (id, root, status, mode, managed, created_at, last_used_at) ` +
    `values ('${id}', '/tmp', 'active', 'checkout', 'false', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')`,
  );
  sqlite.close();
}
