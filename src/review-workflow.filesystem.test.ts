import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "./db/client.js";
import { createEventStore } from "./event-log.js";
import { createContinuationManager } from "./continuation.js";
import { createAgentRegistryManager } from "./acp-registry.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { createWorkSessionManager } from "./work-sessions.js";
import { createReviewWorkflowService, WorkflowError } from "./review-workflow.js";

const state = mkdtempSync(join(tmpdir(), "kontrol-review-workflow-fs-"));
const root = mkdtempSync(join(tmpdir(), "kontrol-review-workflow-root-"));
writeFileSync(join(root, "tracked.txt"), "baseline\n");
const db = openDatabase(state);
db.sqlite.prepare("insert into workspace_sessions (id, root, status, mode, managed, created_at, last_used_at) values (?, ?, 'active', 'checkout', 'false', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')").run("ws-fs-review", root);
const workSessions = createWorkSessionManager(db);
const eventStore = createEventStore(db);
const continuations = createContinuationManager(db);
const agents = createAgentRegistryManager(db);
const checkpoints = createReviewCheckpointManager({ snapshotStoreRoot: join(state, "snapshots") });
const workspaces = { getWorkspace: () => ({ id: "ws-fs-review", root, mode: "checkout" }) } as any;
const workflow = createReviewWorkflowService({ workSessions, eventStore, continuationManager: continuations, agentRegistry: agents, db, workspaces, reviewCheckpoints: checkpoints });
const session = workSessions.create({ workspaceSessionId: "ws-fs-review", submittedBy: "worker", completionPolicy: "webui_approval_required" });
const baseline = await checkpoints.reviewChanges({ workspaceId: "ws-fs-review", root, since: "workspace_open", markReviewed: false });
writeFileSync(join(root, "tracked.txt"), "submitted\n");
const submittedSnapshot = await checkpoints.reviewChangesAgainstSnapshot({ workspaceId: "ws-fs-review", root, baseline: baseline.snapshot });
const submission = workflow.submitForReview({
  workSessionId: session.id,
  diff: submittedSnapshot.patch,
  changedFiles: submittedSnapshot.files,
  snapshotKind: submittedSnapshot.snapshotKind,
  snapshotRef: submittedSnapshot.snapshotRef,
  snapshotCommit: submittedSnapshot.snapshotRef,
});

writeFileSync(join(root, "tracked.txt"), "changed-after-review\n");
await assert.rejects(
  () => workflow.provideFeedback({ sessionId: session.id, submissionId: submission.submissionId, verdict: "approve", comments: "approve", reviewerId: "webui" }),
  (error: unknown) => error instanceof WorkflowError && error.code === "stale_submission",
);

workSessions.close();
agents.close();
eventStore.close();
db.close();
console.log("review-workflow.filesystem: stale approval rejected");
