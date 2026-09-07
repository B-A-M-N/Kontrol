// P0 #3 DOM-level revocation semantics: the reviewer UI's per-row "Revoke
// this grant" must revoke EXACTLY that grant id (revoke_policy_grant with
// grantId) — never the whole scope. Bulk revocation is a separate, clearly
// labeled operation. This test proves the actual tool dispatch, not just that
// strings exist.
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

(globalThis as { __KONTROL_UI_TEST_MODE__?: boolean }).__KONTROL_UI_TEST_MODE__ = true;

const { setServerToolHost } = await import("./server-tool-call.js");
const { setFeedbackHost } = await import("./review-feedback.js");
const { renderPolicyGrants } = await import("./review-feedback.js");
const { __workspaceAppTest } = await import("./workspace-app.js");
type WorkSessionViewState = import("./session-view-types.js").WorkSessionViewState;

// Authoritative fake server state: two workspace grants + one work-session
// grant in the same workspace. Revoking one row must remove exactly that id.
const effectiveGrants = new Map<string, Record<string, unknown>>([
  ["grant-aaa", { id: "grant-aaa", principalId: "principal-one", scope: "workspace", scopeId: "workspace-dom", approvalKey: "tool:write", createdAt: new Date().toISOString() }],
  ["grant-bbb", { id: "grant-bbb", principalId: "principal-two", scope: "workspace", scopeId: "workspace-dom", approvalKey: "bash:npm test", createdAt: new Date().toISOString() }],
  ["grant-ccc", { id: "grant-ccc", principalId: "principal-one", scope: "work_session", scopeId: "session-dom", approvalKey: "tool:write", createdAt: new Date().toISOString() }],
]);

const toolInvocations: Array<{ name: string; args: Record<string, unknown> }> = [];
let revocationFailure: Error | undefined;

const fakeApp = {
  async callServerTool(request: { name?: string; arguments?: Record<string, unknown> }) {
    const name = String(request.name ?? "");
    const args = (request.arguments ?? {}) as Record<string, unknown>;
    toolInvocations.push({ name, args });
    if (name === "list_policy_grants") {
      const scope = args.scope as string | undefined;
      const grants = [...effectiveGrants.values()].filter((grant) => !scope || grant.scope === scope);
      return { isError: false, content: [], structuredContent: { grants } };
    }
    if (name === "revoke_policy_grant") {
      const grantId = String(args.grantId ?? "");
      if (revocationFailure) {
        const failure = revocationFailure;
        revocationFailure = undefined;
        if ((failure as Error).message === "server-rejected") {
          return { isError: true, content: [{ type: "text", text: "The server rejected the revocation." }] };
        }
        throw failure;
      }
      if (!effectiveGrants.has(grantId)) {
        return { isError: true, content: [{ type: "text", text: `Unknown or already-revoked policy grant: ${grantId}.` }] };
      }
      effectiveGrants.delete(grantId);
      return { isError: false, content: [{ type: "text", text: `Revoked ${grantId}.` }], structuredContent: { status: "revoked", grantId } };
    }
    // Any call to the BULK revoke here is a semantic failure under test.
    if (name === "revoke_policy_grants") {
      throw new Error("row-level revoke must never call the bulk revoke_policy_grants operation");
    }
    return { isError: false, content: [], structuredContent: {} };
  },
} as never;

setServerToolHost({
  getApp: () => fakeApp,
  reconnect: async () => undefined,
});

setFeedbackHost({
  hydrateWorkSessionSnapshot: async () => undefined,
  getApp: () => fakeApp,
  render: () => undefined,
  scheduleRender: () => undefined,
  uiMutationsAllowed: () => true,
  newClientMutationId: () => "mutation-test-1",
  activateWorkspace: () => undefined,
  renderEmpty: () => undefined,
  workspaceApprovalConfirmations: new Set<string>(),
  getActiveWorkspaceId: () => "workspace-dom",
  getSelectedWorkSessionId: () => null,
  setSelectedWorkSessionId: () => undefined,
  setLastToolCard: () => undefined,
});

const view = __workspaceAppTest.ensureWorkSessionView("__approval_center__:workspace-dom", "workspace-dom", "") as WorkSessionViewState;
view.policyGrants.clear();
for (const grant of effectiveGrants.values()) {
  view.policyGrants.set(String(grant.id), { ...(grant as Record<string, unknown>), uiState: "idle", error: undefined } as never);
}
view.policyGrantsLoaded = true;
view.policyGrantsError = undefined;

// ── Rendering: groups, principal visibility, exact-revoke button ──
const section = renderPolicyGrants(view);
document.body.append(section);
try {
  const groupHeaders = [...section.querySelectorAll(".policy-grants-group-header")].map((node) => node.textContent);
  assert.deepEqual(groupHeaders, ["Workspace permissions", "Work-session permissions"], "grant classes render as separate groups");

  const cards = [...section.querySelectorAll(".policy-grant-card")];
  assert.equal(cards.length, 3, "all effective grants render");
  const principals = cards.map((card) => card.querySelector(".approval-detail")?.textContent ?? "");
  assert.ok(principals.every((text) => text.includes("Principal ")), "every grant card names its principal");
  assert.ok(
    cards.some((card) => (card.querySelector(".approval-detail")?.textContent ?? "").includes("principal-two")),
    "the reviewer can see which principal a grant belongs to",
  );

  const buttons = [...section.querySelectorAll("button")] as HTMLButtonElement[];
  assert.ok(buttons.every((button) => button.textContent === "Revoke this grant"), "row buttons say 'Revoke this grant' — not a bulk label");

  // ── Clicking one row revokes EXACTLY that grant id ──
  const grantACard = cards.find((card) => (card.querySelector(".approval-meta")?.textContent ?? "").includes("tool:write"))!;
  assert.ok(grantACard, "target card found");
  const grantAButton = [...grantACard.querySelectorAll("button")] as HTMLButtonElement[];
  assert.equal(grantAButton.length, 1);
  grantAButton[0].click();
  await new Promise((resolve) => setTimeout(resolve, 25));

  const revokeCalls = toolInvocations.filter((call) => call.name === "revoke_policy_grant");
  assert.equal(revokeCalls.length, 1, "exactly one revoke call fired");
  assert.equal(revokeCalls[0].args.grantId, "grant-aaa", "the revoke carried the EXACT grant id of the clicked row");
  assert.ok(typeof revokeCalls[0].args.clientMutationId === "string", "the revoke carried a clientMutationId");
  assert.equal(
    toolInvocations.filter((call) => call.name === "revoke_policy_grants").length,
    0,
    "row-level revoke never dispatched the bulk operation",
  );

  // Siblings survive on the server; only the revoked row is gone.
  assert.equal(effectiveGrants.has("grant-aaa"), false, "targeted grant revoked server-side");
  assert.ok(effectiveGrants.has("grant-bbb"), "sibling workspace grant untouched");
  assert.ok(effectiveGrants.has("grant-ccc"), "work-session grant untouched");
  assert.equal(view.policyGrants.has("grant-aaa"), false, "revoked row left the view");
  assert.equal(view.policyGrants.size, 2, "exactly one row was removed");

  // ── Server-rejected revocation keeps the row with a plain error ──
  revocationFailure = new Error("server-rejected");
  const remainingCard = [...section.querySelectorAll(".policy-grant-card")]
    .find((card) => (card.querySelector(".approval-meta")?.textContent ?? "").includes("npm test"))!;
  const remainingButton = [...remainingCard.querySelectorAll("button")] as HTMLButtonElement[];
  remainingButton[0].click();
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.ok(effectiveGrants.has("grant-bbb"), "failed revocation did not remove the grant server-side");
  // host.render() re-renders through the app; here the fresh section is the
  // render, so query the current view state through a fresh renderPolicyGrants.
  const rereadSection = renderPolicyGrants(view);
  const rereadCard = [...rereadSection.querySelectorAll(".policy-grant-card")]
    .find((card) => (card.querySelector(".approval-meta")?.textContent ?? "").includes("npm test"))!;
  assert.ok(
    (rereadCard.querySelector(".feedback-error")?.textContent ?? "").includes("Revocation failed"),
    "revocation failure is surfaced on the grant row",
  );
  rereadSection.remove();

  // ── Ambiguous outcome messaging ──
  const { AmbiguousMutationError } = await import("./server-tool-call.js");
  revocationFailure = new AmbiguousMutationError("revoke_policy_grant", "mutation-test-2");
  const lastCardTarget = [...view.policyGrants.values()].find((grant) => grant.id === "grant-ccc")!;
  const cccButton = [...section.querySelectorAll(".policy-grant-card")]
    .find((card) => (card.querySelector(".approval-meta")?.textContent ?? "").includes("session-dom"))!
    .querySelectorAll("button")[0] as HTMLButtonElement;
  cccButton.click();
  await new Promise((resolve) => setTimeout(resolve, 25));
  const ambiguousSection = renderPolicyGrants(view);
  const ambiguousCard = [...ambiguousSection.querySelectorAll(".policy-grant-card")]
    .find((card) => (card.querySelector(".approval-meta")?.textContent ?? "").includes("session-dom"))!;
  assert.match(
    ambiguousCard.querySelector(".feedback-error")?.textContent ?? "",
    /unknown after a connection interruption|Refresh permissions/,
    "ambiguous revocation tells the reviewer to refresh before retrying",
  );
  assert.ok(effectiveGrants.has("grant-ccc") === false || lastCardTarget.uiState === "error", "ambiguous outcome keeps the row visible or errors it");
  ambiguousSection.remove();
} finally {
  section.remove();
}

console.log("policy-grant-revoke.dom.test.tsx: all assertions passed");
