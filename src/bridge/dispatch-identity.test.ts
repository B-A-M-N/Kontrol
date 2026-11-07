import assert from "node:assert/strict";
import {
  checkDispatchReplay,
  deriveStableDispatchKey,
  dispatchGenerationForRoot,
  dispatchIntentRoot,
} from "./dispatch-identity.js";
import type { AgentRegistryManager, PersistentAcpDispatchAttempt } from "../acp-registry.js";

function fakeRegistry(attempts: PersistentAcpDispatchAttempt[]): AgentRegistryManager {
  return {
    getDispatchAttemptByIdempotencyKey: (key: string) =>
      attempts.find((a) => a.dispatchIdempotencyKey === key),
    listDispatchAttemptsForRun: () => attempts,
  } as unknown as AgentRegistryManager;
}

function attempt(key: string, status: string, runId = "run-1"): PersistentAcpDispatchAttempt {
  return { dispatchIdempotencyKey: key, runId, attemptNumber: 1, status, createdAt: "2020-01-01T00:00:00Z", updatedAt: "2020-01-01T00:00:00Z" };
}

const intent = {
  workSessionId: "ws-1",
  intentId: "initial",
  feedbackEpoch: 0,
  agentId: "agent-1",
  task: "do the thing",
};

// Same intent → identical key across "processes" (pure derivation).
assert.equal(
  deriveStableDispatchKey(fakeRegistry([]), "run-1", intent),
  deriveStableDispatchKey(fakeRegistry([]), "run-1", intent),
  "same intent derives the same key",
);
// Agent id, task, epoch, and intent differences all re-root the key.
for (const changed of [
  { ...intent, agentId: "agent-2" },
  { ...intent, task: "do another thing" },
  { ...intent, feedbackEpoch: 1 },
  { ...intent, intentId: "feedback-9" },
  { ...intent, latestFeedbackId: "feedback-9" },
]) {
  assert.notEqual(
    deriveStableDispatchKey(fakeRegistry([]), "run-1", changed),
    deriveStableDispatchKey(fakeRegistry([]), "run-1", intent),
    "intent identity changes re-root the key",
  );
}

// Unrelated attempts never affect the generation for this root.
const root = dispatchIntentRoot(intent);
assert.equal(
  deriveStableDispatchKey(fakeRegistry([attempt("disp_random", "rejected")]), "run-1", intent),
  deriveStableDispatchKey(fakeRegistry([]), "run-1", intent),
);

// A rejected attempt bumps the generation; replay of the new key is stable.
const keyG1 = deriveStableDispatchKey(fakeRegistry([]), "run-1", intent);
const keyG2 = deriveStableDispatchKey(fakeRegistry([attempt(keyG1, "rejected")]), "run-1", intent);
assert.notEqual(keyG2, keyG1, "rejected attempt bumps the generation");
assert.equal(
  deriveStableDispatchKey(fakeRegistry([attempt(keyG1, "rejected")]), "run-1", intent),
  keyG2,
  "generation derivation is deterministic after a rejection",
);
// Accepted / uncertain attempts do NOT bump: replay must hit the same key.
for (const live of ["accepted", "uncertain", "dispatching"]) {
  assert.equal(
    deriveStableDispatchKey(fakeRegistry([attempt(keyG1, live)]), "run-1", intent),
    keyG1,
  );
}

// Prefix filtering: same root, older generation rejected, newer accepted → stay on newer key.
assert.equal(
  dispatchGenerationForRoot(
    [attempt(keyG1, "rejected"), attempt(keyG2, "accepted")],
    root,
  ),
  2,
);

// Replay matrix: accepted returns accepted, dispatching/uncertain reconcile, rejected is no-op.
assert.equal(checkDispatchReplay(fakeRegistry([attempt(keyG1, "accepted")]), keyG1).kind, "accepted");
assert.equal(checkDispatchReplay(fakeRegistry([attempt(keyG1, "uncertain")]), keyG1).kind, "uncertain");
assert.equal(checkDispatchReplay(fakeRegistry([attempt(keyG1, "dispatching")]), keyG1).kind, "uncertain");
assert.equal(checkDispatchReplay(fakeRegistry([attempt(keyG1, "rejected")]), keyG1).kind, "none");
assert.equal(checkDispatchReplay(fakeRegistry([]), keyG1).kind, "none");
assert.equal(checkDispatchReplay(fakeRegistry([attempt(keyG1, "accepted")]), "other-key").kind, "none", "replay only fires on the exact key");

console.log("dispatch-identity.test.ts: all assertions passed");
