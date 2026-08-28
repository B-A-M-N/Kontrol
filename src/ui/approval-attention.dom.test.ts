// P0.3 — approval attention state machine: a NEW direct approval must surface
// automatically (unless reviewer input has focus) and the pre-approval surface
// must be restored when the last approval resolves. These assertions pin the
// visibility contract without an MCP host connection.
import assert from "node:assert/strict";
import {
  approvalAttentionDecision,
  initialApprovalAttentionState,
  selectionChanged,
  workspaceTransitioned,
} from "./approval-attention.js";

const CENTER = "__approval_center__:ws-1";
const SESSION_A = "session-a";
const SESSION_B = "session-b";
const isCenter = (id: string) => id.startsWith("__approval_center__");

function decide(state = initialApprovalAttentionState, overrides = {}) {
  const ctx = {
    isNewApproval: true,
    isApprovalResolved: false,
    pendingApprovalCount: 1,
    selectedSessionId: SESSION_A,
    reviewerInputHasFocus: false,
    ...overrides,
  };
  return approvalAttentionDecision(state, ctx, CENTER);
}

// New approval: auto-switch to the approval center and remember the surface.
{
  const { next, selectSessionId } = decide();
  assert.equal(selectSessionId, CENTER, "a new approval must auto-select the approval center");
  assert.equal(next.returnSessionId, SESSION_A, "the pre-approval surface must be remembered");
}

// Replay/rehydration is not a NEW approval: no switch, no state churn.
{
  const { selectSessionId, next } = decide(undefined, { pendingApprovalCount: 2 });
  assert.equal(selectSessionId, null, "a second concurrent approval must not re-yank the reviewer");
  assert.equal(next.returnSessionId, null, "no auto-return is armed by a replay");
}

// Reviewer input focus wins: focus is retained, banner carries the action.
{
  const { selectSessionId, next } = decide(undefined, { reviewerInputHasFocus: true });
  assert.equal(selectSessionId, null, "reviewer input focus must prevent the automatic switch");
  assert.equal(next.returnSessionId, null, "no auto-return is armed when focus is retained");
}

// Already on the approval center: no chained return slot.
{
  const { next } = decide(undefined, { selectedSessionId: CENTER });
  assert.equal(next.returnSessionId, null, "switching from the center itself must not arm a return");
}

// Last approval resolves: restore the remembered surface.
{
  const armed = decide().next;
  const restored = approvalAttentionDecision(armed, {
    isNewApproval: false,
    isApprovalResolved: true,
    pendingApprovalCount: 0,
    selectedSessionId: CENTER,
    reviewerInputHasFocus: false,
  }, CENTER);
  assert.equal(restored.selectSessionId, SESSION_A, "resolution must restore the pre-approval surface");
  assert.equal(restored.next.returnSessionId, null, "the return slot must be cleared after restore");
}

// Other approvals still pending: no restore.
{
  const armed = decide().next;
  const restored = approvalAttentionDecision(armed, {
    isNewApproval: false,
    isApprovalResolved: true,
    pendingApprovalCount: 1,
    selectedSessionId: CENTER,
    reviewerInputHasFocus: false,
  }, CENTER);
  assert.equal(restored.selectSessionId, null, "other approvals still pending must hold the center");
  assert.equal(restored.next.returnSessionId, SESSION_A, "the return slot must survive while approvals remain");
}

// Reviewer navigated elsewhere before resolution: keep them where they are.
{
  const armed = decide().next;
  const restored = approvalAttentionDecision(armed, {
    isNewApproval: false,
    isApprovalResolved: true,
    pendingApprovalCount: 0,
    selectedSessionId: SESSION_B,
    reviewerInputHasFocus: false,
  }, CENTER);
  assert.equal(restored.selectSessionId, null, "a reviewer who navigated away must not be yanked back");
  assert.equal(restored.next.returnSessionId, null, "the stale return slot must be cleared");
}

// Reviewer-driven navigation out of the center cancels the pending return.
{
  const armed = decide().next;
  const navigated = selectionChanged(armed, SESSION_B, isCenter);
  assert.equal(navigated.returnSessionId, null, "reviewer navigation must own the selection");
  // Navigating somewhere unrelated keeps the slot while the reviewer is on
  // the center; only returning to the remembered session clears it.
  const kept = selectionChanged(armed, CENTER, isCenter);
  assert.equal(kept.returnSessionId, SESSION_A, "re-selecting the center must keep the pending return");
}

// Workspace transition invalidates any outstanding auto-return.
{
  const armed = decide().next;
  const transitioned = workspaceTransitioned(armed);
  assert.equal(transitioned.returnSessionId, null, "a workspace transition must drop the auto-return");
}

console.log("approval-attention.dom.test.ts: all assertions passed");
