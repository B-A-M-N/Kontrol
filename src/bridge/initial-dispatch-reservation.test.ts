// Initial-dispatch reservation (migration 119): one logical intent
// (owner + workspace + clientMutationId) binds to exactly one work
// session. A lost initial response is recoverable: the retry adopts the
// recorded session. Key reuse with different task content fails.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentRegistryManager } from "../acp-registry.js";
import { openDatabase } from "../db/client.js";
import { createWorkSessionManager } from "../work-sessions/index.js";

function reservationKey(owner: string, workspaceSessionId: string, clientMutationId: string): string {
  return createHash("sha256").update(["initial-dispatch-v1", owner, workspaceSessionId, clientMutationId].join("\n")).digest("hex");
}

const root = mkdtempSync(join(tmpdir(), "kontrol-initial-dispatch-"));
try {
  const db = openDatabase(root);
  const registry = createAgentRegistryManager(db);
  db.sqlite.prepare(
    "insert into workspace_sessions (id, root, status, mode, managed, created_at, last_used_at) values (?, ?, 'active', 'managed', 1, ?, ?)",
  ).run("ws-1", root, new Date().toISOString(), new Date().toISOString());
  const workSessions = createWorkSessionManager(db);

  const key = reservationKey("owner-a", "ws-1", "mut-1");
  const fingerprint = createHash("sha256").update("task one").digest("hex");
  assert.equal(registry.getInitialDispatchReservation(key), undefined, "no reservation initially");

  const first = workSessions.create({ workspaceSessionId: "ws-1", submittedBy: "test", title: "t" });
  // Lost response: the session exists, the caller never saw its id.
  const bound1 = registry.bindInitialDispatchReservation({ reservationKey: key, workSessionId: first.id, taskFingerprint: fingerprint });
  assert.equal(bound1.workSessionId, first.id);

  // Retry with the same key adopts the recorded session (no second one).
  const adopted = registry.bindInitialDispatchReservation({ reservationKey: key, workSessionId: "ws-NEVER-USED", taskFingerprint: fingerprint });
  assert.equal(adopted.workSessionId, first.id, "retry recovers the original session");

  // Same key with different content fails explicitly.
  assert.throws(
    () => registry.bindInitialDispatchReservation({ reservationKey: key, workSessionId: "ws-other", taskFingerprint: createHash("sha256").update("different task").digest("hex") }),
    /already used with different task content/,
    "key reuse with different content is refused",
  );

  // A different owner or workspace is an independent intent.
  const otherKey = reservationKey("owner-b", "ws-1", "mut-1");
  assert.equal(registry.getInitialDispatchReservation(otherKey), undefined, "owner isolation");
  const second = workSessions.create({ workspaceSessionId: "ws-1", submittedBy: "test", title: "t2" });
  const bound2 = registry.bindInitialDispatchReservation({ reservationKey: otherKey, workSessionId: second.id, taskFingerprint: fingerprint });
  assert.equal(bound2.workSessionId, second.id, "independent intent binds independently");

  registry.close();
  db.close();
} finally {
  rmSync(root, { recursive: true, force: true });
}

// Canonical intent fingerprint: one intent → one fingerprint and one
// dispatch key. Any mission-contract change alters the fingerprint, so
// a reused clientMutationId is refused exactly like a changed task.
{
  const { canonicalIntentFingerprint } = await import("./dispatch-service.js");
  const base = {
    task: "same task text",
    mission: {
      objective: "ship it",
      desiredOutcome: "done",
      acceptanceCriteria: [{ id: "a" }],
      supervisorInstructions: "review",
      autonomyMode: "manual" as const,
      approvalMode: "human_required" as const,
    },
    missionBaseline: { baselineKind: "git", baselineRef: "main", baselineCommit: "abc" },
  };
  const a = canonicalIntentFingerprint(base);
  const b = canonicalIntentFingerprint(base);
  assert.equal(a.intentFingerprint, b.intentFingerprint, "same intent → same fingerprint");
  assert.equal(a.canonicalIntent, b.canonicalIntent);

  const changedCriteria = canonicalIntentFingerprint({
    ...base, mission: { ...base.mission, acceptanceCriteria: [{ id: "b" }] },
  });
  assert.notEqual(changedCriteria.intentFingerprint, a.intentFingerprint,
    "changed mission contract → different fingerprint (second execution impossible)");
  assert.notEqual(changedCriteria.canonicalIntent, a.canonicalIntent);

  const changedObjective = canonicalIntentFingerprint({
    ...base, mission: { ...base.mission, objective: "ship something else" },
  });
  assert.notEqual(changedObjective.intentFingerprint, a.intentFingerprint,
    "changed objective → different fingerprint");

  const noMission = canonicalIntentFingerprint({ task: "same task text" });
  assert.notEqual(noMission.intentFingerprint, a.intentFingerprint,
    "adding a mission contract to the same task changes the intent");
  assert.equal(noMission.canonicalIntent, "same task text");
}

console.log("initial-dispatch-reservation.test.ts: all assertions passed");
