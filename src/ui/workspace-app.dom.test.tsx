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
__workspaceAppTest.renderWorkSessionView(session);
const sessionButtons = [...document.querySelectorAll<HTMLButtonElement>(".session-switcher-item")];
assert.equal(sessionButtons.length, 2, "multiple recovered sessions render a switcher");
sessionButtons.find((button) => button.textContent?.includes("Second session"))?.click();
__workspaceAppTest.renderWorkSessionView(secondSession);
assert.ok(document.querySelector(".session-switcher-item.selected")?.textContent?.includes("Second session"), "session switcher selects another work session");

console.log("workspace-app DOM: rich renderer mount/update/unmount passed");
