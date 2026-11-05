import assert from "node:assert/strict";
import { mergePendingApproval } from "./session-views.js";
import { reconcilePolicyApproval, setFeedbackHost, submitPolicyApproval } from "./review-feedback.js";
import { setServerToolHost } from "./server-tool-call.js";
import type { WorkSessionViewState } from "./session-view-types.js";

function emptyView(): WorkSessionViewState {
  return { policyApprovals: new Map(), pendingApprovalCount: 0 } as WorkSessionViewState;
}

// P0.2 item 1: one idempotency key per decision attempt. An ambiguous
// interruption keeps the key so a retry resends the identical mutation; a
// rejected decision mints a fresh key for the next attempt.
let minted = 0;
const sent: Array<{ name: string; args: Record<string, unknown> }> = [];
let failNext: "ambiguous" | "rejected" | null = null;
let listedApprovals: Array<Record<string, unknown>> = [];
let statusById: Record<string, unknown> = {};
let statusThrows = false;

const fakeApp = {
  callServerTool: async (request: { name: string; arguments?: Record<string, unknown> }) => {
    sent.push({ name: String(request.name), args: { ...(request.arguments ?? {}) } });
    const name = String(request.name);
    if (name === "provide_policy_approval") {
      if (failNext === "ambiguous") {
        failNext = null;
        throw new Error("connection closed");
      }
      if (failNext === "rejected") {
        failNext = null;
        return { isError: true, content: [{ type: "text", text: "The server rejected the decision." }] };
      }
      return { isError: false, content: [], structuredContent: { status: "recorded" } };
    }
    if (name === "list_pending_approvals") {
      return { isError: false, content: [], structuredContent: { approvals: listedApprovals } };
    }
    if (name === "get_approval_status") {
      if (statusThrows) throw new Error("connection closed");
      const id = String((request.arguments as Record<string, unknown> | undefined)?.approvalId ?? "");
      return {
        isError: false,
        content: [],
        structuredContent: { approval: statusById[id] ?? { approvalId: id, found: false, status: "unknown", consumed: false } },
      };
    }
    throw new Error(`unexpected tool call: ${name}`);
  },
};

setServerToolHost({ getApp: () => fakeApp as never, reconnect: async () => undefined });
setFeedbackHost({
  hydrateWorkSessionSnapshot: async () => undefined,
  getApp: () => fakeApp as never,
  render: () => undefined,
  scheduleRender: () => undefined,
  uiMutationsAllowed: () => true,
  newClientMutationId: () => `mutation-${++minted}`,
  activateWorkspace: () => undefined,
  renderEmpty: () => undefined,
  workspaceApprovalConfirmations: new Set<string>(),
  getActiveWorkspaceId: () => "ws-id",
  getSelectedWorkSessionId: () => null,
  setSelectedWorkSessionId: () => undefined,
  setLastToolCard: () => undefined,
});

{
  const view = emptyView();
  mergePendingApproval(view, { approvalId: "b1", title: "op" } as never, "ws-id");

  failNext = "ambiguous";
  await submitPolicyApproval(view, "b1", "approve");
  const unknown = view.policyApprovals.get("b1")!;
  assert.equal(unknown.uiState, "outcome_unknown");
  assert.equal(unknown.clientMutationId, "mutation-1", "the interrupted attempt keeps its key");

  // Retry after the interruption: the identical mutation is resent.
  await submitPolicyApproval(view, "b1", "approve");
  assert.equal(view.policyApprovals.has("b1"), false, "success deletes the card");
  const retries = sent.filter((call) => call.name === "provide_policy_approval");
  assert.equal(retries.length, 2);
  assert.equal(retries[0].args.clientMutationId, "mutation-1");
  assert.equal(retries[1].args.clientMutationId, "mutation-1", "retry reuses the stored key, never mints a second mutation");
  assert.equal(minted, 1, "no new key was minted for the retry");

  // P0.2 item 4: the committed decision leaves a distinct outcome behind.
  const outcomes = view.recentApprovalOutcomes ?? [];
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].outcome, "approved_pending_retry");
  assert.match(outcomes[0].detail, /retry the original tool call/, "direct approval is retry authorization, not proof of execution");
}

{
  const view = emptyView();
  mergePendingApproval(view, { approvalId: "b2", title: "op" } as never, "ws-id");

  failNext = "rejected";
  await submitPolicyApproval(view, "b2", "approve");
  const failed = view.policyApprovals.get("b2")!;
  assert.equal(failed.uiState, "error");
  assert.equal(failed.clientMutationId, undefined, "a rejected decision releases its key");

  await submitPolicyApproval(view, "b2", "approve");
  const attempts = sent.filter((call) => call.args.approvalId === "b2");
  assert.equal(attempts.length, 2);
  assert.notEqual(attempts[0].args.clientMutationId, attempts[1].args.clientMutationId,
    "a new attempt after a known rejection mints a fresh key");
}

// A committed denial records a denied outcome, never a retry authorization.
{
  const view = emptyView();
  mergePendingApproval(view, {
    approvalId: "b3",
    title: "deny op",
    options: [
      { id: "approve", label: "Approve", effect: "approve" },
      { id: "deny", label: "Deny", effect: "deny" },
    ],
  } as never, "ws-id");
  await submitPolicyApproval(view, "b3", "deny");
  assert.equal(view.policyApprovals.has("b3"), false);
  assert.equal(view.recentApprovalOutcomes?.length, 1);
  assert.equal(view.recentApprovalOutcomes?.[0].outcome, "denied");
  assert.match(view.recentApprovalOutcomes?.[0].detail ?? "", /will not run/);
}

// Reconcile consults the authoritative status endpoint when the card leaves
// the pending list: terminal states are recorded and the card closes, while
// unknown results and endpoint failures preserve the card as outcome_unknown
// instead of silently discarding an unresolved action.
{
  const view = emptyView();
  mergePendingApproval(view, { approvalId: "r1", title: "op r1" } as never, "ws-id");
  mergePendingApproval(view, { approvalId: "r2", title: "op r2" } as never, "ws-id");
  mergePendingApproval(view, { approvalId: "r3", title: "op r3" } as never, "ws-id");
  listedApprovals = [];
  statusById = {
    r1: { approvalId: "r1", found: true, status: "approved", consumed: true, consumedAt: "2026-01-01T00:00:00Z" },
    r2: { approvalId: "r2", found: true, status: "denied" },
  };

  await reconcilePolicyApproval(view, "r1");
  assert.equal(view.policyApprovals.has("r1"), false);
  const r1 = (view.recentApprovalOutcomes ?? []).find((entry) => entry.approvalId === "r1");
  assert.equal(r1?.outcome, "authorization_consumed", "consumption is authorization use, not proof of execution");
  assert.match(r1?.detail ?? "", /Authorization consumed/);
  assert.match(r1?.detail ?? "", /Execution result not verified/);

  await reconcilePolicyApproval(view, "r2");
  const r2 = (view.recentApprovalOutcomes ?? []).find((entry) => entry.approvalId === "r2");
  assert.equal(r2?.outcome, "denied");

  const before = (view.recentApprovalOutcomes ?? []).length;
  await reconcilePolicyApproval(view, "r3");
  assert.equal(view.policyApprovals.has("r3"), true, "unknown cards are preserved, never silently dropped");
  assert.equal(view.policyApprovals.get("r3")?.uiState, "outcome_unknown");
  assert.equal((view.recentApprovalOutcomes ?? []).length, before, "unknown outcomes are not fabricated");

  statusThrows = true;
  mergePendingApproval(view, { approvalId: "r4", title: "op r4" } as never, "ws-id");
  await reconcilePolicyApproval(view, "r4");
  statusThrows = false;
  assert.equal(view.policyApprovals.has("r4"), true, "an endpoint failure preserves the card");
  assert.equal(view.policyApprovals.get("r4")?.uiState, "outcome_unknown");
  assert.match(view.policyApprovals.get("r4")?.error ?? "", /lookup failed/);
}

// Duplicate clicks while a decision submit is in flight send nothing: the
// in-flight request keeps its idempotency key and no second attempt starts.
{
  const view = emptyView();
  mergePendingApproval(view, { approvalId: "dup", title: "op" } as never, "ws-id");
  view.policyApprovals.get("dup")!.uiState = "submitting";
  const before = sent.length;
  await submitPolicyApproval(view, "dup", "approve");
  assert.equal(sent.length, before, "a second click during submit sends no duplicate decision");
  assert.equal(view.policyApprovals.get("dup")?.uiState, "submitting");
}

// P1.4: the idempotency key is bound to the exact {approvalId, decision}
// pair. Changing the decision after an unknown outcome mints a distinct key
// (reusing the old key with different content would be a server conflict).
{
  const view = emptyView();
  mergePendingApproval(view, {
    approvalId: "chg",
    title: "op",
    options: [
      { id: "approve", label: "Approve", effect: "approve" },
      { id: "deny", label: "Deny", effect: "deny" },
    ],
  } as never, "ws-id");

  failNext = "ambiguous";
  await submitPolicyApproval(view, "chg", "approve");
  const unknown = view.policyApprovals.get("chg")!;
  assert.equal(unknown.uiState, "outcome_unknown");
  const approveKey = unknown.clientMutationId;
  assert.ok(approveKey, "interrupted attempt keeps its key");

  await submitPolicyApproval(view, "chg", "deny");
  const changed = sent.filter((call) => call.args.approvalId === "chg");
  assert.equal(changed.length, 2);
  assert.equal(changed[0].args.clientMutationId, approveKey);
  assert.equal(changed[0].args.decision, "approve");
  assert.notEqual(changed[1].args.clientMutationId, approveKey, "a changed decision mints a distinct key");
  assert.equal(changed[1].args.decision, "deny");
  assert.equal(view.policyApprovals.has("chg"), false, "the committed denial closes the card");
}

// P1.4: an authoritative pending listing clears the uncertain state in a
// controlled transition and releases the in-flight key, so the next submit
// mints a fresh key bound to the then-chosen decision.
{
  const view = emptyView();
  mergePendingApproval(view, { approvalId: "rec", title: "op" } as never, "ws-id");
  failNext = "ambiguous";
  await submitPolicyApproval(view, "rec", "approve");
  assert.equal(view.policyApprovals.get("rec")?.uiState, "outcome_unknown");

  listedApprovals = [{ approvalId: "rec", title: "op" }];
  await reconcilePolicyApproval(view, "rec");
  const idle = view.policyApprovals.get("rec")!;
  assert.equal(idle.uiState, "idle");
  assert.equal(idle.error, undefined);
  assert.equal(idle.clientMutationId, undefined, "authoritative pending releases the uncertain key");

  listedApprovals = [];
  await submitPolicyApproval(view, "rec", "approve");
  const after = sent.filter((call) => call.args.approvalId === "rec");
  assert.equal(after.length, 2, "interrupted attempt plus fresh retry");
  assert.notEqual(after[1].args.clientMutationId, after[0].args.clientMutationId, "reconciled retry mints a fresh key");
}

// P1.4: stale pending data cannot resurrect a decided card. A committed
// outcome survives the refresh that still lists the approval.
{
  const view = emptyView();
  mergePendingApproval(view, { approvalId: "stale", title: "op" } as never, "ws-id");
  await submitPolicyApproval(view, "stale", "approve");
  assert.equal(view.policyApprovals.has("stale"), false, "success deletes the card");
  assert.ok((view.recentApprovalOutcomes ?? []).some((entry) => entry.approvalId === "stale"));

  mergePendingApproval(view, { approvalId: "stale", title: "op" } as never, "ws-id");
  assert.equal(view.policyApprovals.has("stale"), false, "stale pending data never reopens a committed decision");
}

console.log("submit-approval-id.test.ts: all assertions passed");
