import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { act } from "react";
import type { ToolResultCard } from "./card-types.js";

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
  IS_REACT_ACT_ENVIRONMENT: true,
  CSSStyleSheet: class CSSStyleSheet {
    replaceSync() {}
    replace() { return Promise.resolve(this); }
  },
};
for (const [name, value] of Object.entries(globals)) {
  Object.defineProperty(globalThis, name, { configurable: true, value });
}

Object.defineProperty(dom.window, "matchMedia", {
  configurable: true,
  value: () => ({ matches: false, media: "", onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; } }),
});
Object.defineProperty(dom.window, "ResizeObserver", {
  configurable: true,
  value: class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
});
Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: dom.window.ResizeObserver });
Object.defineProperty(dom.window.document, "fonts", {
  configurable: true,
  value: { add() {}, delete() {}, clear() {}, ready: Promise.resolve(), status: "loaded" },
});

const { mountHeavyPayload } = await import("./heavy-payload.js");
const { mountReviewPayload } = await import("./review-payload.js");

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 25));
}

function readCard(text: string): ToolResultCard {
  return {
    tool: "read",
    path: "src/example.ts",
    payload: { content: [{ type: "text", text }] },
    summary: { offset: 1 },
  };
}

const readContainer = document.createElement("div");
document.body.append(readContainer);
let readPayload: ReturnType<typeof mountHeavyPayload>;
await act(async () => {
  readPayload = mountHeavyPayload(readContainer, {
    card: readCard("export const answer = 42;\n"),
    hostContext: { theme: "dark" } as never,
  });
  await settle();
});
assert.ok(readContainer.querySelector(".pierre-file"), "read cards mount Pierre's file renderer");
const fileSurface = readContainer.querySelector(".pierre-file");
await act(async () => {
  readPayload.update({ card: readCard("export const answer = 43;\n"), hostContext: { theme: "light" } as never });
  await settle();
});
assert.ok(readContainer.querySelector(".pierre-file"), "theme/content updates keep the file renderer mounted");
assert.equal(readContainer.querySelector(".pierre-file"), fileSurface, "a changed file payload updates the existing renderer surface");
await act(async () => { readPayload.unmount(); });
assert.equal(readContainer.childElementCount, 0, "unmount tears down the React payload root");

const patch = [
  "diff --git a/src/example.ts b/src/example.ts",
  "--- a/src/example.ts",
  "+++ b/src/example.ts",
  "@@ -1,1 +1,1 @@",
  "-export const answer = 42;",
  "+export const answer = 43;",
  "",
].join("\n");
const patchContainer = document.createElement("div");
document.body.append(patchContainer);
let patchPayload: ReturnType<typeof mountHeavyPayload>;
await act(async () => {
  patchPayload = mountHeavyPayload(patchContainer, {
    card: { tool: "apply_patch", payload: { patch } },
  });
  await settle();
});
assert.ok(patchContainer.querySelector(".pierre-diff"), "apply_patch cards use the rich diff renderer");
await act(async () => { patchPayload.unmount(); });

const reviewContainer = document.createElement("div");
document.body.append(reviewContainer);
let reviewPayload: ReturnType<typeof mountReviewPayload>;
await act(async () => {
  reviewPayload = mountReviewPayload(reviewContainer, {
    card: { tool: "submit_for_review", payload: { patch } },
    hostContext: { theme: "dark" } as never,
  });
  await settle();
});
const fileHeader = reviewContainer.querySelector<HTMLButtonElement>(".review-diff-file-header");
assert.ok(fileHeader, "review cards render a per-file diff selector");
const reviewFiles = reviewContainer.querySelector(".review-diff-files");
await act(async () => {
  fileHeader?.click();
  await settle();
});
assert.ok(reviewContainer.querySelector(".pierre-diff"), "expanding a review file mounts Pierre's diff renderer");
await act(async () => {
  reviewPayload.update({ card: { tool: "submit_for_review", payload: { patch } }, hostContext: { theme: "light" } as never });
  await settle();
});
assert.equal(reviewContainer.querySelector(".review-diff-files"), reviewFiles, "theme updates do not rebuild the review file list");
await act(async () => { reviewPayload.unmount(); });
assert.equal(reviewContainer.childElementCount, 0, "review renderer unmount is complete");

// Exercise the actual imperative workspace-session surface in test mode. This
// catches the regression where each telemetry event replaced the whole DOM and
// destroyed an in-progress reviewer reply.
(globalThis as { __KONTROL_UI_TEST_MODE__?: boolean }).__KONTROL_UI_TEST_MODE__ = true;
let fakeConnectCount = 0;
let fakeSurfaceFailures = 0;
let fakeEventDelivered = false;
let fakeMutationCalls = 0;
const fakeToolCalls: string[] = [];
const fakeApp = {
  ontoolresult: undefined as ((result: unknown) => void) | undefined,
  onhostcontextchanged: undefined as ((context: unknown) => void) | undefined,
  onteardown: undefined as (() => Promise<unknown>) | undefined,
  async connect() {
    fakeConnectCount += 1;
  },
  getHostContext() {
    return undefined;
  },
  async callServerTool(request: { name?: string }) {
    const name = String(request.name ?? "");
    fakeToolCalls.push(name);
    if (name === "get_workspace_session_surface") {
      if (fakeSurfaceFailures > 0) {
        fakeSurfaceFailures -= 1;
        throw new Error("simulated transport loss");
      }
      return { isError: false, content: [], structuredContent: { lastSeq: 5, sessions: [] } };
    }
    if (name === "list_pending_approvals") {
      return { isError: false, content: [], structuredContent: { approvals: [] } };
    }
    if (name === "await_workspace_events") {
      if (!fakeEventDelivered) {
        fakeEventDelivered = true;
        return {
          isError: false,
          content: [],
          structuredContent: {
            events: [{
              seq: 6,
              id: "reconnect-event-6",
              type: "agent.run.output_delta",
              sessionId: "session-reconnect",
              workspaceSessionId: "workspace-reconnect",
              payload: { text: "caught up after reconnect" },
              createdAt: new Date().toISOString(),
            }],
            nextSeq: 6,
          },
        };
      }
      return await new Promise<never>(() => {});
    }
    if (name === "provide_review_feedback") {
      fakeMutationCalls += 1;
      throw new Error("simulated mutation transport loss");
    }
    return { isError: false, content: [], structuredContent: {} };
  },
};
(globalThis as { __KONTROL_UI_TEST_APP_FACTORY__?: () => never }).__KONTROL_UI_TEST_APP_FACTORY__ = () => fakeApp as never;
const { __workspaceAppTest } = await import("./workspace-app.js");
const session = __workspaceAppTest.ensureWorkSessionView("session-dom", "workspace-dom", "run-dom");
session.title = "DOM lifecycle";
session.status = "in_progress";
session.openMessages.set("message-dom", {
  messageId: "message-dom",
  kind: "clarification_request",
  title: "Need a decision",
  body: "Choose the migration path.",
  status: "open",
});
__workspaceAppTest.renderWorkSessionView(session);
const replyBox = document.querySelector<HTMLTextAreaElement>(".message-reply");
assert.ok(replyBox, "open agent messages render a reply control");
replyBox?.focus();
for (let seq = 1; seq <= 100; seq++) {
  __workspaceAppTest.reduceWorkSessionEvent("session-dom", {
    seq,
    id: `event-${seq}`,
    type: "agent.run.output_delta",
    sessionId: "session-dom",
    payload: { text: `fragment-${seq} ` },
    createdAt: new Date().toISOString(),
  });
  __workspaceAppTest.renderWorkSessionView(session);
}
assert.equal(document.activeElement, replyBox, "activity updates preserve reviewer input focus");
assert.equal(document.querySelectorAll(".message-reply").length, 1, "activity updates preserve the message tray DOM");
assert.match(document.querySelector(".agent-event")?.textContent ?? "", /fragment-100/, "coalesced output updates the existing activity row");

const secondSession = __workspaceAppTest.ensureWorkSessionView("session-dom-2", "workspace-dom", "run-dom-2");
secondSession.title = "Second session";
secondSession.updatedAt = new Date(Date.now() + 1_000).toISOString();
// P0.5: the switcher only offers views of the ACTIVE workspace, so the
// session's workspace must be activated before the switcher can render it.
__workspaceAppTest.activateWorkspace("workspace-dom");
await settle();
__workspaceAppTest.renderWorkSessionView(session);
const sessionButtons = [...document.querySelectorAll<HTMLButtonElement>(".session-switcher-item")];
assert.equal(sessionButtons.length, 2, "multiple recovered sessions render a switcher");
sessionButtons.find((button) => button.textContent?.includes("Second session"))?.click();
__workspaceAppTest.renderWorkSessionView(secondSession);
assert.ok(document.querySelector(".session-switcher-item.selected")?.textContent?.includes("Second session"), "session switcher selects another work session");

// Reconnect replay is cursor-safe and direct approvals remain outside the
// currently selected work session. These are the two UI-side invariants that
// a fresh event watcher must preserve after transport replacement.
const directApprovalEvent = {
  seq: 201,
  id: "approval-event-201",
  type: "policy.approval_requested",
  sessionId: "transport-session",
  workspaceSessionId: "workspace-dom",
  payload: { approvalId: "approval-dom", workspaceId: "workspace-dom", tool: "write", origin: "direct_mcp" },
  createdAt: new Date().toISOString(),
};
assert.equal(
  __workspaceAppTest.workspaceEventTargetSessionId(directApprovalEvent),
  "__approval_center__:workspace-dom",
  "direct approval events use the workspace approval center",
);
assert.equal(
  __workspaceAppTest.workspaceEventTargetSessionId({ ...directApprovalEvent, payload: { ...directApprovalEvent.payload, workSessionId: "session-dom" } }),
  "session-dom",
  "work-session approvals retain their explicit work-session correlation",
);
const approvalCenter = __workspaceAppTest.ensureWorkSessionView("__approval_center__:workspace-dom", "workspace-dom", "");
__workspaceAppTest.reduceWorkSessionEvent("__approval_center__:workspace-dom", directApprovalEvent);
assert.equal(approvalCenter.pendingApprovalCount, 1, "direct approval replay is visible in the approval center");
const replayEvent = {
  seq: 101,
  id: "replay-event-101",
  type: "agent.run.failed",
  sessionId: "session-dom",
  payload: {},
  createdAt: new Date().toISOString(),
};
__workspaceAppTest.reduceWorkSessionEvent("session-dom", replayEvent);
const replaySeq = session.lastSeq;
const replayActivityCount = session.activity.length;
__workspaceAppTest.reduceWorkSessionEvent("session-dom", replayEvent);
assert.equal(session.lastSeq, replaySeq, "overlapping event replay does not move the cursor twice");
assert.equal(session.activity.length, replayActivityCount, "overlapping event replay does not duplicate activity");

// Drive the real boot/connect/reconnect path through a test app host. This is
// intentionally above reducer-level coverage: it verifies a transport error
// reconnects the host, rehydrates durable state, catches up the event cursor,
// and does not blindly replay an ambiguous mutation.
await __workspaceAppTest.boot();
assert.equal(fakeConnectCount, 1, "initial app host connection succeeds");
fakeApp.ontoolresult?.({
  _meta: { tool: "open_workspace" },
  structuredContent: { workspaceId: "workspace-reconnect" },
  content: [],
});
await settle();
await settle();
assert.equal(__workspaceAppTest.getConnectionState(), "CONNECTED", "app host reaches connected state");
assert.ok(__workspaceAppTest.getLastSuccessfulHydrationAt(), "workspace state is hydrated after open_workspace");
assert.equal(
  __workspaceAppTest.getWorkSessionView("session-reconnect")?.lastSeq,
  6,
  "event watcher catches up the durable event cursor",
);

const surfaceCallsBeforeReconnect = fakeToolCalls.filter((name) => name === "get_workspace_session_surface").length;
fakeSurfaceFailures = 1;
await __workspaceAppTest.callServerToolChecked({
  name: "get_workspace_session_surface",
  arguments: { workspaceId: "workspace-reconnect", filter: "live", limit: 50 },
});
await settle();
assert.ok(fakeConnectCount >= 2, "transport failure creates a fresh app host connection");
assert.equal(__workspaceAppTest.getConnectionState(), "CONNECTED", "reconnected app host returns to connected state");
assert.ok(
  fakeToolCalls.filter((name) => name === "get_workspace_session_surface").length > surfaceCallsBeforeReconnect + 1,
  "reconnect rehydrates durable workspace state before/alongside the safe retry",
);

await assert.rejects(
  __workspaceAppTest.callServerToolChecked({
    name: "provide_review_feedback",
    arguments: { sessionId: "session-reconnect", submissionId: "submission-1", comments: "ambiguous" },
  }),
  /Verify the operation before retrying/,
  "ambiguous mutations are not blindly replayed after reconnect",
);
assert.equal(fakeMutationCalls, 1, "ambiguous mutation is sent only once");
assert.ok(fakeConnectCount >= 3, "mutation transport failure also reconnects the app host");

// P0.3 — a NEW direct approval surfaces without a manual switch, an approval
// center selection is restored after resolution, and active reviewer input
// keeps focus (the banner carries the action instead). Runs while the host is
// still connected: the auto-switch renders through the normal render path.
{
  __workspaceAppTest.activateWorkspace("workspace-dom");
  const preApproval = __workspaceAppTest.ensureWorkSessionView("session-dom", "workspace-dom", "run-dom");
  // The earlier replay block left an approval pending in the center; clear it
  // so the attention assertions below start from a quiet workspace.
  const staleCenter = __workspaceAppTest.ensureWorkSessionView("__approval_center__:workspace-dom", "workspace-dom", "");
  staleCenter.policyApprovals.delete("approval-dom");
  staleCenter.pendingApprovalCount = staleCenter.policyApprovals.size;
  __workspaceAppTest.selectWorkSession("session-dom");
  await settle();
  __workspaceAppTest.renderWorkSessionView(preApproval);
  assert.ok(
    document.querySelector(".session-switcher-item.selected")?.textContent?.includes("DOM lifecycle"),
    "reviewer starts on a normal work-session surface",
  );
  const approvalCenterView = __workspaceAppTest.ensureWorkSessionView("__approval_center__:workspace-dom", "workspace-dom", "");
  // The focus-preservation assertions later in this block rely on a starting
  // state with no active reviewer input.
  (document.activeElement as HTMLElement | null)?.blur?.();
  // Real delivery order: the approval row reduces into the center first, then
  // the watcher's surface hook fires for the new approval.
  __workspaceAppTest.reduceWorkSessionEvent("__approval_center__:workspace-dom", {
    seq: 300,
    id: "approval-event-300",
    type: "policy.approval_requested",
    sessionId: "workspace-dom",
    workspaceSessionId: "workspace-dom",
    payload: { approvalId: "approval-auto-1", workspaceId: "workspace-dom", tool: "bash", origin: "direct_mcp" },
    createdAt: new Date().toISOString(),
  });
  __workspaceAppTest.surfaceNewDirectApproval("workspace-dom", "approval-auto-1");
  await settle();
  assert.equal(
    __workspaceAppTest.getSelectedWorkSessionId(),
    "__approval_center__:workspace-dom",
    "a new direct approval auto-selects the workspace approval center",
  );
  assert.ok(
    document.body.textContent?.includes("Workspace approvals"),
    "the approval center surface renders after the auto-switch",
  );
  assert.ok(
    document.body.textContent?.includes("Approve") || document.body.textContent?.includes("approval"),
    "the pending approval is actionable on the auto-selected surface",
  );
  approvalCenterView.policyApprovals.delete("approval-auto-1");
  approvalCenterView.pendingApprovalCount = 0;
  __workspaceAppTest.surfaceNewDirectApprovalResolved("workspace-dom");
  await settle();
  assert.equal(
    __workspaceAppTest.getSelectedWorkSessionId(),
    "session-dom",
    "resolution restores the pre-approval selection",
  );
  __workspaceAppTest.renderWorkSessionView(preApproval);
  assert.ok(
    document.querySelector(".session-switcher-item.selected")?.textContent?.includes("DOM lifecycle"),
    "resolution restores the pre-approval surface",
  );

  // Focus preservation: an in-progress reviewer reply is never interrupted.
  __workspaceAppTest.selectWorkSession("session-dom");
  __workspaceAppTest.renderWorkSessionView(preApproval);
  const reply = document.querySelector<HTMLTextAreaElement>(".message-reply");
  assert.ok(reply, "reply control is rendered on the session surface");
  reply?.focus();
  __workspaceAppTest.reduceWorkSessionEvent("__approval_center__:workspace-dom", {
    seq: 301,
    id: "approval-event-301",
    type: "policy.approval_requested",
    sessionId: "workspace-dom",
    workspaceSessionId: "workspace-dom",
    payload: { approvalId: "approval-auto-2", workspaceId: "workspace-dom", tool: "bash", origin: "direct_mcp" },
    createdAt: new Date().toISOString(),
  });
  __workspaceAppTest.surfaceNewDirectApproval("workspace-dom", "approval-auto-2");
  assert.equal(document.activeElement, reply, "reviewer input focus is preserved on a new approval");
  assert.equal(
    __workspaceAppTest.getSelectedWorkSessionId(),
    "session-dom",
    "focus retention also means the selection stays on the reviewer's surface",
  );
  __workspaceAppTest.renderWorkSessionView(preApproval);
  assert.ok(
    document.body.textContent?.includes("Needs approval"),
    "the banner still advertises the pending approval while focus is retained",
  );
  const approvalCenterAfterFocus = __workspaceAppTest.getWorkSessionView("__approval_center__:workspace-dom");
  approvalCenterAfterFocus?.policyApprovals.set("approval-auto-2", { approvalId: "approval-auto-2" } as never);
  __workspaceAppTest.renderWorkSessionView(approvalCenterAfterFocus!);
  assert.ok(
    document.body.textContent?.includes("Workspace approvals"),
    "the switcher offers the approval center without stealing focus",
  );
  approvalCenterAfterFocus?.policyApprovals.clear();
  if (approvalCenterAfterFocus) approvalCenterAfterFocus.pendingApprovalCount = 0;
}

// P0.4/P0.5 — workspace isolation: a pending approval of workspace A must be
// invisible while workspace B is active, and switching back to A restores it.
{
  __workspaceAppTest.activateWorkspace("workspace-isolation-a");
  const centerA = __workspaceAppTest.ensureWorkSessionView("__approval_center__:workspace-isolation-a", "workspace-isolation-a", "");
  __workspaceAppTest.reduceWorkSessionEvent("__approval_center__:workspace-isolation-a", {
    seq: 400,
    id: "approval-event-400",
    type: "policy.approval_requested",
    sessionId: "workspace-isolation-a",
    workspaceSessionId: "workspace-isolation-a",
    payload: { approvalId: "approval-a", workspaceId: "workspace-isolation-a", tool: "bash", origin: "direct_mcp" },
    createdAt: new Date().toISOString(),
  });
  (document.activeElement as HTMLElement | null)?.blur?.();
  assert.equal(
    __workspaceAppTest.getWorkSessionView("__approval_center__:workspace-isolation-a")?.pendingApprovalCount,
    1,
    "workspace A has a pending approval",
  );
  __workspaceAppTest.activateWorkspace("workspace-isolation-b");
  const centerB = __workspaceAppTest.ensureWorkSessionView("__approval_center__:workspace-isolation-b", "workspace-isolation-b", "");
  __workspaceAppTest.renderWorkSessionView(centerB);
  assert.equal(
    centerB.policyApprovals.size,
    0,
    "workspace B's approval center must not inherit workspace A's approvals",
  );
  assert.equal(
    (document.body.textContent?.includes("approval-a") ? 1 : 0) + (document.querySelector(".approval-list")?.childElementCount ?? 0),
    0,
    "workspace A's approval must not render while workspace B is active",
  );
  assert.equal(
    __workspaceAppTest.getSelectedWorkSessionId() === "__approval_center__:workspace-isolation-a",
    false,
    "a workspace transition must drop a selection that belongs to another workspace",
  );
  __workspaceAppTest.activateWorkspace("workspace-isolation-a");
  __workspaceAppTest.renderWorkSessionView(centerA);
  assert.equal(
    centerA.pendingApprovalCount,
    1,
    "switching back to workspace A restores its pending approval",
  );
  centerA.policyApprovals.clear();
  centerA.pendingApprovalCount = 0;
  centerB.policyApprovals.clear();
}

// P0 — lost approval-response reconciliation: a server that already resolved
// an approval whose response transport died must win on reconnect. The stale
// local card disappears when the authoritative pending list omits it.
{
  __workspaceAppTest.activateWorkspace("workspace-dom");
  const center = __workspaceAppTest.ensureWorkSessionView("__approval_center__:workspace-dom", "workspace-dom", "");
  center.policyApprovals.set("approval-stale", { approvalId: "approval-stale", tool: "write" } as never);
  center.pendingApprovalCount = 1;
  __workspaceAppTest.reconcileAuthoritativeApprovals(
    [],
    new Set(["approval-live"]),
    "workspace-dom",
  );
  assert.equal(
    center.policyApprovals.has("approval-stale"),
    false,
    "a locally-pending card the server no longer lists must be dropped",
  );
  assert.equal(
    center.pendingApprovalCount,
    0,
    "the approval count must reflect the authoritative server set",
  );
}

await fakeApp.onteardown?.();
assert.equal(__workspaceAppTest.getConnectionState(), "DISCONNECTED", "app teardown marks the host disconnected");
(globalThis as { __KONTROL_UI_TEST_APP_FACTORY__?: () => never }).__KONTROL_UI_TEST_APP_FACTORY__ = undefined;


console.log("workspace-app DOM: rich renderer mount/update/unmount passed");
