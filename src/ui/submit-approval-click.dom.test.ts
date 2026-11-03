// P0.2 dom-level approval dispatch: a rendered approval card's real
// Approve button must commit the decision through provide_policy_approval
// exactly once per attempt, with a stable idempotency key across duplicate
// clicks or an interrupted first attempt. This test proves the actual
// button → handler dispatch, not just that approval text exists.
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body><div id=app></div></body></html>", {
  url: "http://localhost/",
});

const globals: Record<string, unknown> = {
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  SVGElement: dom.window.SVGElement,
  HTMLInputElement: dom.window.HTMLInputElement,
  HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
  MutationObserver: dom.window.MutationObserver,
  customElements: dom.window.customElements,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
  cancelAnimationFrame: (id: number) => clearTimeout(id),
};
for (const [name, value] of Object.entries(globals)) {
  Object.defineProperty(globalThis, name, { configurable: true, value });
}

(globalThis as { __KONTROL_UI_TEST_MODE__?: boolean }).__KONTROL_UI_TEST_MODE__ = true;

const { setServerToolHost } = await import("./server-tool-call.js");
const { setFeedbackHost, renderPolicyApproval } = await import("./review-feedback.js");
type WorkSessionViewState = import("./session-view-types.js").WorkSessionViewState;

const toolInvocations: Array<{ name: string; args: Record<string, unknown> }> = [];
let failNext: "ambiguous" | null = null;

const fakeApp = {
  async callServerTool(request: { name?: string; arguments?: Record<string, unknown> }) {
    const name = String(request.name ?? "");
    const args = (request.arguments ?? {}) as Record<string, unknown>;
    toolInvocations.push({ name, args });
    if (failNext === "ambiguous") {
      failNext = null;
      throw new Error("connection closed");
    }
    return { isError: false, content: [], structuredContent: { status: "recorded" } };
  },
};

setServerToolHost({ getApp: () => fakeApp as never, reconnect: async () => undefined });

let minted = 0;
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
  getActiveWorkspaceId: () => "workspace-dom",
  getSelectedWorkSessionId: () => null,
  setSelectedWorkSessionId: () => undefined,
  setLastToolCard: () => undefined,
});

function pendingView(approvalId: string): WorkSessionViewState {
  return {
    workspaceSessionId: "workspace-dom",
    policyApprovals: new Map([
      [approvalId, {
        approvalId,
        workspaceId: "workspace-dom",
        kind: "tool",
        tool: "write",
        title: "write report.txt",
        description: "write /tmp/report.txt",
        origin: "direct_mcp",
        requestedAt: new Date().toISOString(),
        options: [
          { id: "approve", label: "Approve", effect: "approve", scope: "once" },
          { id: "deny", label: "Deny", effect: "deny" },
        ],
      }],
    ]),
    pendingApprovalCount: 1,
    recentApprovalOutcomes: [],
  } as unknown as WorkSessionViewState;
}

// ── One click on the real Approve button dispatches exactly one decision ──
{
  const view = pendingView("approval-click-1");
  document.body.append(renderPolicyApproval(view, view.policyApprovals.get("approval-click-1")!));
  try {
    const buttons = [...document.querySelectorAll(".approval-card .feedback-btn")] as HTMLButtonElement[];
    assert.equal(buttons.length, 2, "the card renders one button per option");
    assert.ok(buttons.every((button) => !button.disabled), "both buttons start enabled");
    const approve = buttons.find((button) => button.textContent === "Approve")!;
    assert.ok(approve, "the approve button exists");
    approve.click();
    await new Promise((resolve) => setTimeout(resolve, 25));
    const calls = toolInvocations.filter((call) => call.name === "provide_policy_approval");
    assert.equal(calls.length, 1, "one click dispatches exactly one decision");
    assert.equal(calls[0].args.approvalId, "approval-click-1");
    assert.equal(calls[0].args.decision, "approve");
    assert.equal(typeof calls[0].args.clientMutationId, "string");
    assert.equal(view.policyApprovals.has("approval-click-1"), false, "the decided card is removed");
    assert.equal(view.recentApprovalOutcomes?.[0]?.outcome, "approved_pending_retry");
  } finally {
    document.body.replaceChildren();
    toolInvocations.length = 0;
  }
}

// ── Duplicate clicks dispatch once: the second click is ignored while the ──
// ── first submit is in flight, so no second attempt ever starts. ──
{
  const view = pendingView("approval-click-2");
  document.body.append(renderPolicyApproval(view, view.policyApprovals.get("approval-click-2")!));
  try {
    const approve = [...document.querySelectorAll(".approval-card .feedback-btn")]
      .find((button) => button.textContent === "Approve")! as HTMLButtonElement;
    approve.click();
    approve.click();
    await new Promise((resolve) => setTimeout(resolve, 25));
    const calls = toolInvocations.filter((call) => call.name === "provide_policy_approval");
    assert.equal(calls.length, 1, "two synchronous clicks dispatch exactly once (the in-flight submit wins)");
    assert.equal(typeof calls[0].args.clientMutationId, "string",
      "the single attempt carries one idempotency key");
  } finally {
    document.body.replaceChildren();
    toolInvocations.length = 0;
  }
}

// ── An interrupted attempt keeps its key; the rendered card goes unknown ──
{
  const view = pendingView("approval-click-3");
  const card = renderPolicyApproval(view, view.policyApprovals.get("approval-click-3")!);
  document.body.append(card);
  try {
    failNext = "ambiguous";
    const approve = [...document.querySelectorAll(".approval-card .feedback-btn")]
      .find((button) => button.textContent === "Approve")! as HTMLButtonElement;
    approve.click();
    await new Promise((resolve) => setTimeout(resolve, 25));
    const record = view.policyApprovals.get("approval-click-3")!;
    assert.equal(record.uiState, "outcome_unknown");
    const firstKey = record.clientMutationId;
    assert.equal(typeof firstKey, "string");
    approve.click();
    await new Promise((resolve) => setTimeout(resolve, 25));
    const calls = toolInvocations.filter((call) => call.name === "provide_policy_approval");
    assert.equal(calls.length, 2);
    assert.equal(calls[1].args.clientMutationId, firstKey, "the retry after interruption reuses the stored key");
  } finally {
    document.body.replaceChildren();
    toolInvocations.length = 0;
  }
}

// ── Missing options fail closed: text, no buttons, no dispatch ──
{
  const view = pendingView("approval-click-4");
  view.policyApprovals.get("approval-click-4")!.options = [];
  document.body.append(renderPolicyApproval(view, view.policyApprovals.get("approval-click-4")!));
  try {
    assert.equal(document.querySelectorAll(".approval-card .feedback-btn").length, 0,
      "a card without server options renders no action buttons");
    assert.match(document.querySelector(".approval-card")?.textContent ?? "", /fail-closed/);
    assert.equal(toolInvocations.length, 0, "nothing is dispatched without an option");
  } finally {
    document.body.replaceChildren();
  }
}

// ── Expired approvals render fail-closed: text, no buttons, no dispatch ──
{
  const view = pendingView("approval-click-5");
  const record = view.policyApprovals.get("approval-click-5")!;
  record.expiresAt = new Date(Date.now() - 60_000).toISOString();
  document.body.append(renderPolicyApproval(view, record));
  try {
    assert.equal(document.querySelectorAll(".approval-card .feedback-btn").length, 0,
      "an expired approval offers no action buttons");
    assert.match(document.querySelector(".approval-card")?.textContent ?? "", /expired/,
      "the expired card says it is no longer actionable");
    assert.equal(toolInvocations.length, 0, "nothing is dispatched from an expired card");
  } finally {
    document.body.replaceChildren();
  }
}

console.log("submit-approval-click.dom.test.ts: all assertions passed");
