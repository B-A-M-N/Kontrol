/**
 * P0.3 — approval attention state machine.
 *
 * A NEW direct approval must surface without destroying active reviewer
 * input: when the reviewer is typing, focus is retained and the always-
 * rendered "Needs approval" banner carries the action; otherwise the
 * workspace approval center is selected automatically and the previous
 * non-approval surface is remembered so it can be restored when the last
 * pending approval resolves.
 *
 * Extracted as a pure state machine so the visibility contract is testable
 * without an MCP host connection.
 */

export interface ApprovalAttentionState {
  /**
   * The work session the reviewer was on before an automatic switch to the
   * approval center. Null when no automatic switch is outstanding.
   */
  returnSessionId: string | null;
}

export const initialApprovalAttentionState: ApprovalAttentionState = {
  returnSessionId: null,
};

export interface ApprovalAttentionContext {
  /** True when a NEW approval just arrived (not a replay/rehydration). */
  isNewApproval: boolean;
  /** True when the reviewer's last pending approval just resolved. */
  isApprovalResolved: boolean;
  /** Approval rows currently pending in this workspace's center. */
  pendingApprovalCount: number;
  /** Currently selected work session (null when nothing is selected). */
  selectedSessionId: string | null;
  /** True when an input/textarea currently has focus. */
  reviewerInputHasFocus: boolean;
}

export type ApprovalAttentionAction =
  | { type: "select"; sessionId: string }
  | { type: "workspace_transition" };

/**
 * Fold a reviewer-driven selection into the state. While the reviewer stays
 * on (or returns to) the approval center, an outstanding auto-return stays
 * armed; navigating to any other surface is the reviewer choosing where to
 * be, which disarms it.
 */
export function selectionChanged(
  state: ApprovalAttentionState,
  nextSessionId: string | null,
  isApprovalCenterId: (id: string) => boolean,
): ApprovalAttentionState {
  if (state.returnSessionId === null) return state;
  if (nextSessionId !== null && isApprovalCenterId(nextSessionId)) return state;
  return { returnSessionId: null };
}

/** A workspace transition invalidates any outstanding auto-return. */
export function workspaceTransitioned(state: ApprovalAttentionState): ApprovalAttentionState {
  return state.returnSessionId === null ? state : { returnSessionId: null };
}

/**
 * Decide the next selection for an approval lifecycle event.
 * Returns the session to select (null = leave the current selection).
 */
export function approvalAttentionDecision(
  state: ApprovalAttentionState,
  ctx: ApprovalAttentionContext,
  approvalCenterSessionId: string,
): { next: ApprovalAttentionState; selectSessionId: string | null } {
  if (ctx.isNewApproval) {
    // Not NEW enough to yank the reviewer: earlier approvals are already
    // pending (replay) or the row itself was already delivered.
    if (ctx.pendingApprovalCount > 1) return { next: state, selectSessionId: null };
    // Active reviewer input wins: retain focus; the banner carries the
    // action instead of an automatic switch.
    if (ctx.reviewerInputHasFocus) return { next: state, selectSessionId: null };
    const returnSessionId = ctx.selectedSessionId !== null && ctx.selectedSessionId !== approvalCenterSessionId
      ? ctx.selectedSessionId
      : state.returnSessionId;
    return { next: { returnSessionId }, selectSessionId: approvalCenterSessionId };
  }
  if (ctx.isApprovalResolved) {
    if (ctx.pendingApprovalCount > 0) return { next: state, selectSessionId: null };
    const returnTo = state.returnSessionId;
    const next: ApprovalAttentionState = { returnSessionId: null };
    // Restore only when the reviewer is still looking at the auto-switched
    // approval center — a reviewer who navigated elsewhere has already made
    // their choice about where to be.
    if (!returnTo || ctx.selectedSessionId !== approvalCenterSessionId) {
      return { next, selectSessionId: null };
    }
    return { next, selectSessionId: returnTo };
  }
  return { next: state, selectSessionId: null };
}
