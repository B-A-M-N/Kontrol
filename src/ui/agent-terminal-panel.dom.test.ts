// Read-only live agent-terminal panel: a reviewer watches a running PTY
// continuously through incremental observe_agent_pty reads. The panel never
// sends input, resize, or signals; each viewer keeps its own cursor; evicted
// ranges surface as an explicit gap, never a silent hole.
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
  MutationObserver: dom.window.MutationObserver,
  customElements: dom.window.customElements,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
  cancelAnimationFrame: (id: number) => clearTimeout(id),
};
for (const [name, value] of Object.entries(globals)) {
  Object.defineProperty(globalThis, name, { configurable: true, value });
}

const { setServerToolHost } = await import("./server-tool-call.js");
const { disposeAgentTerminalPanels, renderAgentTerminalPanels, resetAgentTerminalPanelsForTests } = await import("./agent-terminal-panel.js");
type WorkSessionViewState = import("./session-view-types.js").WorkSessionViewState;

const toolInvocations: Array<{ name: string; args: Record<string, unknown> }> = [];
type ObserveResponse = {
  output: string;
  outputCursor: number;
  oldestAvailableCursor: number;
  outputTruncated: boolean;
  status: string;
  running: boolean;
};
let scripted: ObserveResponse[] = [];

const fakeApp = {
  async callServerTool(request: { name?: string; arguments?: Record<string, unknown> }) {
    toolInvocations.push({ name: String(request.name ?? ""), args: (request.arguments ?? {}) as Record<string, unknown> });
    const next = scripted.shift();
    assert.ok(next, "unexpected observe_agent_pty call: no scripted response left");
    return { isError: false, content: [], structuredContent: next };
  },
};

setServerToolHost({ getApp: () => fakeApp as never, reconnect: async () => undefined });

function ptyView(outputCursor: number): WorkSessionViewState {
  return {
    workSessionId: "ws-terminal",
    workspaceSessionId: "wss-terminal",
    agentPtys: [{
      processSessionId: "pty-1",
      agentName: "test-agent",
      processGeneration: 1,
      outputCursor,
      status: "attached",
      createdAt: new Date().toISOString(),
    }],
  } as WorkSessionViewState;
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 25));
}

// ── Transcript fills incrementally; only the read-only endpoint is used ──
{
  resetAgentTerminalPanelsForTests();
  toolInvocations.length = 0;
  const container = document.createElement("div");
  document.body.append(container);
  try {
    scripted = [
      { output: "hello world", outputCursor: 11, oldestAvailableCursor: 0, outputTruncated: false, status: "attached", running: true },
      { output: "!!!", outputCursor: 14, oldestAvailableCursor: 0, outputTruncated: false, status: "attached", running: true },
    ];
    renderAgentTerminalPanels(container, ptyView(11));
    await flush();
    const transcript = container.querySelector(".agent-terminal-transcript");
    assert.ok(transcript, "a transcript element is rendered");
    assert.match(transcript.textContent ?? "", /hello world/, "first fetch fills the transcript");
    assert.equal(container.querySelectorAll("input, textarea").length, 0, "the panel has no input surface");
    assert.ok(toolInvocations.every((call) => call.name === "observe_agent_pty"),
      "watching uses only the read-only observe endpoint");

    // Snapshot cursor advanced: the next fetch resumes from the viewer cursor.
    renderAgentTerminalPanels(container, ptyView(14));
    await flush();
    assert.match(container.querySelector(".agent-terminal-transcript")?.textContent ?? "", /hello world!!!/);
    const second = toolInvocations.filter((call) => call.name === "observe_agent_pty")[1];
    assert.equal(second.args.afterCursor, 11, "incremental reads resume from the viewer cursor");
    assert.equal(second.args.sessionId, "ws-terminal");
    assert.equal(second.args.processSessionId, "pty-1");
    assert.ok(!("chars" in second.args) && !("columns" in second.args), "observation carries no control parameters");
  } finally {
    container.remove();
    toolInvocations.length = 0;
  }
}

// ── Evicted ranges surface as an explicit gap, never a silent hole ──
{
  resetAgentTerminalPanelsForTests();
  toolInvocations.length = 0;
  const container = document.createElement("div");
  document.body.append(container);
  try {
    scripted = [
      { output: "tail-only", outputCursor: 100, oldestAvailableCursor: 90, outputTruncated: true, status: "attached", running: true },
    ];
    renderAgentTerminalPanels(container, ptyView(100));
    await flush();
    const gap = container.querySelector(".agent-terminal-gap");
    assert.ok(gap, "an evicted range renders an explicit gap marker");
    assert.match(gap.textContent ?? "", /0 → 90/, "the gap names the cursors this viewer never received");
    assert.match(container.querySelector(".agent-terminal-transcript")?.textContent ?? "", /tail-only/);
  } finally {
    container.remove();
    toolInvocations.length = 0;
  }
}

// ── A finished PTY stops fetching; the final state stays visible ──
{
  resetAgentTerminalPanelsForTests();
  toolInvocations.length = 0;
  const container = document.createElement("div");
  document.body.append(container);
  try {
    scripted = [
      { output: "done", outputCursor: 4, oldestAvailableCursor: 0, outputTruncated: false, status: "exited", running: false },
    ];
    renderAgentTerminalPanels(container, ptyView(4));
    await flush();
    assert.match(container.querySelector(".agent-terminal-transcript")?.textContent ?? "", /done/);
    assert.match(container.querySelector(".agent-terminal-status")?.textContent ?? "", /finished/);
    const callsAfterFinish = toolInvocations.length;
    renderAgentTerminalPanels(container, ptyView(4));
    await flush();
    assert.equal(toolInvocations.length, callsAfterFinish, "a finished panel issues no further fetches");
  } finally {
    container.remove();
    toolInvocations.length = 0;
  }
}

function ptyViewFor(workSessionId: string, outputCursor: number): WorkSessionViewState {
  return { ...ptyView(outputCursor), workSessionId } as WorkSessionViewState;
}

// ── A done panel still reconciles a higher authoritative cursor once ──
{
  resetAgentTerminalPanelsForTests();
  toolInvocations.length = 0;
  const container = document.createElement("div");
  document.body.append(container);
  try {
    scripted = [
      { output: "done", outputCursor: 4, oldestAvailableCursor: 0, outputTruncated: false, status: "exited", running: false },
    ];
    renderAgentTerminalPanels(container, ptyView(4));
    await flush();
    assert.match(container.querySelector(".agent-terminal-status")?.textContent ?? "", /finished/);
    // Buffered trailing output arrives after termination: one final fetch.
    scripted = [
      { output: "+trailing", outputCursor: 12, oldestAvailableCursor: 0, outputTruncated: false, status: "exited", running: false },
    ];
    renderAgentTerminalPanels(container, ptyView(12));
    await flush();
    assert.match(container.querySelector(".agent-terminal-transcript")?.textContent ?? "", /\+trailing/,
      "a higher authoritative cursor after termination triggers one final reconciliation");
    assert.equal(toolInvocations.length, 2, "exactly one final fetch, no resumed polling");
    renderAgentTerminalPanels(container, ptyView(12));
    await flush();
    assert.equal(toolInvocations.length, 2, "a converged terminal panel stays quiet");
  } finally {
    container.remove();
    toolInvocations.length = 0;
  }
}

// ── Workspace switch disposes the abandoned surface's panels ──
{
  resetAgentTerminalPanelsForTests();
  toolInvocations.length = 0;
  const containerA = document.createElement("div");
  const containerB = document.createElement("div");
  document.body.append(containerA, containerB);
  try {
    scripted = [
      { output: "aaa", outputCursor: 3, oldestAvailableCursor: 0, outputTruncated: false, status: "attached", running: true },
    ];
    renderAgentTerminalPanels(containerA, ptyViewFor("ws-a", 3));
    await flush();
    assert.match(containerA.querySelector(".agent-terminal-transcript")?.textContent ?? "", /aaa/);
    // Navigate away: the old surface detaches while another session renders.
    containerA.remove();
    scripted = [
      { output: "bbb", outputCursor: 3, oldestAvailableCursor: 0, outputTruncated: false, status: "attached", running: true },
    ];
    renderAgentTerminalPanels(containerB, ptyViewFor("ws-b", 3));
    await flush();
    assert.match(containerB.querySelector(".agent-terminal-transcript")?.textContent ?? "", /bbb/);
    // Returning to the first session rebuilds from cursor 0: the old entry
    // was disposed instead of leaking with stale DOM and cursor state.
    scripted = [
      { output: "aaa-fresh", outputCursor: 3, oldestAvailableCursor: 0, outputTruncated: false, status: "attached", running: true },
    ];
    const containerA2 = document.createElement("div");
    document.body.append(containerA2);
    renderAgentTerminalPanels(containerA2, ptyViewFor("ws-a", 3));
    await flush();
    const lastFetch = toolInvocations.filter((call) => call.name === "observe_agent_pty").at(-1);
    assert.equal(lastFetch?.args.afterCursor, 0, "a disposed panel rebuilds from cursor 0");
    assert.match(containerA2.querySelector(".agent-terminal-transcript")?.textContent ?? "", /aaa-fresh/);
    containerA2.remove();
  } finally {
    containerB.remove();
    toolInvocations.length = 0;
  }
}

// ── Explicit disposal drops hosted panels before unmount ──
{
  resetAgentTerminalPanelsForTests();
  toolInvocations.length = 0;
  const container = document.createElement("div");
  document.body.append(container);
  try {
    scripted = [
      { output: "tmp", outputCursor: 3, oldestAvailableCursor: 0, outputTruncated: false, status: "attached", running: true },
    ];
    renderAgentTerminalPanels(container, ptyView(3));
    await flush();
    assert.ok(container.querySelector(".agent-terminal-panel"), "panel is hosted before disposal");
    disposeAgentTerminalPanels(container);
    assert.equal(container.querySelector(".agent-terminal-panel"), null, "disposal removes hosted panels");
    scripted = [
      { output: "tmp-fresh", outputCursor: 3, oldestAvailableCursor: 0, outputTruncated: false, status: "attached", running: true },
    ];
    renderAgentTerminalPanels(container, ptyView(3));
    await flush();
    const lastFetch = toolInvocations.filter((call) => call.name === "observe_agent_pty").at(-1);
    assert.equal(lastFetch?.args.afterCursor, 0, "a disposed panel rebuilds from cursor 0");
  } finally {
    container.remove();
    toolInvocations.length = 0;
  }
}

console.log("agent-terminal-panel.dom.test.ts: all assertions passed");
