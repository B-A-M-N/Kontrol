import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./db/client.js";
import { createAgentMessageManager } from "./agent-messages.js";
import { createWorkSessionManager } from "./work-sessions.js";

const root = await mkdtemp(join(tmpdir(), "kontrol-agent-msg-test-"));

try {
  const db = openDatabase(root);
  const workSessions = createWorkSessionManager(db);
  const messages = createAgentMessageManager(db);

  db.sqlite
    .prepare(
      "insert into workspace_sessions (id, root, status, mode, managed, created_at, last_used_at) " +
        "values ('ws_m', '/tmp', 'active', 'checkout', 'false', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')",
    )
    .run();
  const session = workSessions.create({ workspaceSessionId: "ws_m", submittedBy: "tester" });

  // Gating kinds (question/blocker) are OPEN; records (finding/artifact/note) are resolved.
  const question = messages.post({
    workSessionId: session.id,
    kind: "clarification_request",
    title: "Which config?",
    body: "prod or staging?",
    data: { options: ["prod", "staging"] },
  });
  assert.equal(question.status, "open", "clarification_request must be open");
  assert.equal(question.data.options ? (question.data.options as string[]).length : 0, 2);

  const blocker = messages.post({ workSessionId: session.id, kind: "blocker", body: "missing creds" });
  assert.equal(blocker.status, "open", "blocker must be open");

  const finding = messages.post({ workSessionId: session.id, kind: "finding", title: "N+1 query" });
  assert.equal(finding.status, "resolved", "finding is a record, not a gate — resolved on post");

  const artifact = messages.post({
    workSessionId: session.id,
    kind: "artifact",
    title: "coverage.html",
    data: { url: "file:///tmp/coverage.html" },
  });
  assert.equal(artifact.status, "resolved");

  // list returns all, ordered by creation.
  const all = messages.list(session.id);
  assert.equal(all.length, 4, "all four messages listed");
  assert.deepEqual(
    all.map((m) => m.kind),
    ["clarification_request", "blocker", "finding", "artifact"],
    "messages ordered by createdAt",
  );

  // openOnly returns just the two gating messages.
  const open = messages.list(session.id, { openOnly: true });
  assert.deepEqual(
    new Set(open.map((m) => m.id)),
    new Set([question.id, blocker.id]),
    "openOnly returns only unresolved gating messages",
  );

  // kind filter.
  const findings = messages.list(session.id, { kind: "finding" });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].id, finding.id);

  // resolve closes an open message; re-resolving is a no-op that stays resolved.
  const resolved = messages.resolve(question.id);
  assert.equal(resolved?.status, "resolved");
  assert.equal(
    messages.list(session.id, { openOnly: true }).length,
    1,
    "one gating message remains open after resolving the question",
  );
  const reResolved = messages.resolve(question.id);
  assert.equal(reResolved?.status, "resolved", "resolving an already-resolved message is idempotent");

  // Cascade: deleting the work session removes its messages (FK on delete cascade).
  db.sqlite.prepare("delete from work_sessions where id = ?").run(session.id);
  assert.equal(messages.list(session.id).length, 0, "messages cascade-deleted with the session");

  db.close();
  console.log("agent-messages.test.ts: all assertions passed");
} finally {
  await rm(root, { recursive: true, force: true });
}
