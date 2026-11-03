import assert from "node:assert/strict";
import { MAX_RECENT_APPROVAL_OUTCOMES, mergePendingApproval, recordApprovalOutcome } from "./session-views.js";
import type { WorkSessionViewState } from "./session-view-types.js";
import type { PendingApprovalRecord } from "./session-view-types.js";

function emptyView(): WorkSessionViewState {
  return { policyApprovals: new Map(), pendingApprovalCount: 0 } as WorkSessionViewState;
}

function record(approvalId: string, title = "server title"): PendingApprovalRecord {
  return { approvalId, title } as PendingApprovalRecord;
}

// P0.2: a hydration refresh must not clobber a local decision still in
// flight. A submitting or outcome_unknown record keeps its UI state while
// the server fields merge underneath it.
{
  const view = emptyView();
  mergePendingApproval(view, record("a1"), "ws-1");
  const seeded = view.policyApprovals.get("a1")!;
  seeded.uiState = "submitting";

  mergePendingApproval(view, record("a1", "server title v2"), "ws-1");
  const merged = view.policyApprovals.get("a1")!;
  assert.equal(merged.uiState, "submitting", "hydration must preserve submitting state");
  assert.equal(merged.title, "server title v2", "server fields still merge underneath");
}

{
  const view = emptyView();
  mergePendingApproval(view, record("a2"), "ws-1");
  const seeded = view.policyApprovals.get("a2")!;
  seeded.uiState = "outcome_unknown";
  seeded.error = "interrupted; refresh before retrying";

  mergePendingApproval(view, record("a2", "server title v2"), "ws-1");
  const merged = view.policyApprovals.get("a2")!;
  assert.equal(merged.uiState, "outcome_unknown", "hydration must preserve outcome_unknown state");
  assert.equal(merged.error, "interrupted; refresh before retrying", "the unknown-outcome notice survives hydration");
}

// Settled/idle records keep the old behavior: fresh server data wins.
{
  const view = emptyView();
  mergePendingApproval(view, record("a3"), "ws-1");
  view.policyApprovals.get("a3")!.uiState = "idle";
  mergePendingApproval(view, record("a3", "server title v2"), "ws-1");
  assert.equal(view.policyApprovals.get("a3")!.uiState, undefined, "idle records reset to the fresh server record");
}

{
  const view = emptyView();
  mergePendingApproval(view, record("a4"), "ws-1");
  assert.equal(view.policyApprovals.get("a4")!.uiState, undefined, "new approvals carry no UI state");
  assert.equal(view.pendingApprovalCount, 1);
}

// Outcome history is bounded and keyed by approval: re-recording the same
// approval replaces it in place instead of duplicating, and the oldest
// entries are evicted past the cap.
{
  const view = emptyView();
  for (let i = 0; i < MAX_RECENT_APPROVAL_OUTCOMES + 2; i++) {
    recordApprovalOutcome(view, { approvalId: `o${i}`, outcome: "denied", detail: `detail ${i}` });
  }
  const history = view.recentApprovalOutcomes ?? [];
  assert.equal(history.length, MAX_RECENT_APPROVAL_OUTCOMES);
  assert.ok(!history.some((entry) => entry.approvalId === "o0"), "oldest outcomes are evicted");
  assert.equal(history[history.length - 1].approvalId, `o${MAX_RECENT_APPROVAL_OUTCOMES + 1}`);

  recordApprovalOutcome(view, { approvalId: `o${MAX_RECENT_APPROVAL_OUTCOMES + 1}`, outcome: "executed", detail: "updated" });
  assert.equal(view.recentApprovalOutcomes?.length, MAX_RECENT_APPROVAL_OUTCOMES);
  assert.equal(view.recentApprovalOutcomes?.filter((entry) => entry.approvalId === `o${MAX_RECENT_APPROVAL_OUTCOMES + 1}`).length, 1,
    "re-recording an approval replaces it instead of duplicating");
  assert.equal(view.recentApprovalOutcomes?.[view.recentApprovalOutcomes.length - 1].outcome, "executed");
}

console.log("session-views.test.ts: all assertions passed");
