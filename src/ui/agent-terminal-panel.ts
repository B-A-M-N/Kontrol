/**
 * Read-only live agent-terminal panel.
 *
 * Renders one transcript per work-session PTY discovered through the
 * work-session snapshot (`view.agentPtys`). Output is retrieved
 * incrementally through the reviewer-only, read-only `observe_agent_pty`
 * endpoint — this module never sends input, resize, or signals, and never
 * writes terminal characters into the durable event ledger.
 *
 * Refreshes are snapshot-driven: a fetch happens only when the snapshot's
 * `outputCursor` advanced past this viewer's cursor (coalescing bursts of
 * output-available notifications) or when the reviewer clicks Refresh.
 * Each viewer keeps its own cursor; when retention evicted data this viewer
 * never received, an explicit gap marker is shown instead of a silent hole.
 */
import { element } from "./ui-dom.js";
import { callServerToolChecked, getStructuredContent } from "./server-tool-call.js";
import type { WorkSessionViewState } from "./session-view-types.js";

type PtyView = NonNullable<WorkSessionViewState["agentPtys"]>[number];

interface AgentTerminalPanelState {
  cursor: number;
  status: string;
  gap: boolean;
  trimmed: boolean;
  refreshing: boolean;
  done: boolean;
  error?: string;
}

const MAX_TRANSCRIPT_CHARACTERS = 16_000;
const FETCH_CHARACTERS = 8_000;

const panels = new Map<string, { state: AgentTerminalPanelState; root: HTMLElement; transcript: HTMLElement; statusLine: HTMLElement; host: HTMLElement }>();

function panelKey(workSessionId: string, processSessionId: string): string {
  return `${workSessionId}:${processSessionId}`;
}

function freshState(): AgentTerminalPanelState {
  return { cursor: 0, status: "attached", gap: false, trimmed: false, refreshing: false, done: false };
}

function setGapMarker(root: HTMLElement, fromCursor: number, toCursor: number): void {
  const marker = element("div", {
    className: "agent-terminal-gap",
    text: `… output unavailable: retention evicted data this view never received (cursor ${fromCursor} → ${toCursor}) …`,
  });
  root.append(marker);
}

function appendTranscript(entry: { root: HTMLElement; transcript: HTMLElement }, text: string): void {
  entry.transcript.append(element("span", { text }));
  while ((entry.transcript.textContent ?? "").length > MAX_TRANSCRIPT_CHARACTERS && entry.transcript.firstChild) {
    entry.transcript.firstChild.remove();
  }
}

async function refreshPanel(key: string, workSessionId: string, pty: PtyView): Promise<void> {
  const entry = panels.get(key);
  if (!entry || entry.state.refreshing || entry.state.done) return;
  entry.state.refreshing = true;
  entry.state.error = undefined;
  try {
    const result = await callServerToolChecked({
      name: "observe_agent_pty",
      arguments: {
        sessionId: workSessionId,
        processSessionId: pty.processSessionId,
        afterCursor: entry.state.cursor,
        maxOutputCharacters: FETCH_CHARACTERS,
      },
    });
    const observation = getStructuredContent<{
      output?: string;
      outputCursor?: number;
      oldestAvailableCursor?: number;
      outputTruncated?: boolean;
      status?: string;
      running?: boolean;
    }>(result);
    if (!observation || typeof observation.outputCursor !== "number") return;
    if (typeof observation.oldestAvailableCursor === "number" && observation.oldestAvailableCursor > entry.state.cursor) {
      setGapMarker(entry.root, entry.state.cursor, observation.oldestAvailableCursor);
      entry.state.gap = true;
    }
    if (observation.output) appendTranscript(entry, observation.output);
    const before = entry.transcript.textContent ?? "";
    if (before.length >= MAX_TRANSCRIPT_CHARACTERS) entry.state.trimmed = true;
    entry.state.cursor = observation.outputCursor;
    entry.state.status = observation.status ?? entry.state.status;
    if (observation.running === false || observation.status === "exited" || observation.status === "lost") {
      entry.state.done = true;
    }
  } catch (error) {
    entry.state.error = error instanceof Error ? error.message : String(error);
  } finally {
    entry.state.refreshing = false;
    paintPanel(key, pty);
  }
}

function paintPanel(key: string, pty: PtyView): void {
  const entry = panels.get(key);
  if (!entry) return;
  const { state, statusLine } = entry;
  const parts = [
    `PTY · ${pty.agentName} · generation ${pty.processGeneration}`,
    state.status,
    state.done ? "finished" : "live",
    `cursor ${state.cursor}`,
  ];
  if (state.gap) parts.push("gap in retained output");
  if (state.trimmed) parts.push("earlier transcript trimmed in this view");
  if (state.refreshing) parts.push("refreshing…");
  if (state.error) parts.push(`refresh failed: ${state.error}`);
  statusLine.textContent = parts.join(" · ");
}

function buildPanel(key: string, container: HTMLElement, workSessionId: string, pty: PtyView): void {
  const root = element("div", { className: "agent-terminal-panel" });
  const statusLine = element("div", { className: "agent-terminal-status" });
  const transcript = element("pre", { className: "agent-terminal-transcript" });
  transcript.setAttribute("aria-label", `Read-only transcript for ${pty.agentName}`);
  const refresh = element("button", { className: "feedback-btn", type: "button", text: "Refresh transcript" });
  refresh.addEventListener("click", () => {
    const entry = panels.get(key);
    if (!entry || entry.state.refreshing) return;
    // Manual refresh re-reads from the viewer's cursor; a finished panel
    // re-opens observation in case the binding changed.
    entry.state.done = false;
    void refreshPanel(key, workSessionId, pty);
  });
  root.append(statusLine, transcript, refresh);
  // Start at cursor 0 so the first paint fills the transcript from retained
  // history (bounded per fetch); every later fetch is incremental from the
  // viewer's own cursor.
  const state = freshState();
  panels.set(key, { state, root, transcript, statusLine, host: container });
  paintPanel(key, pty);
}

/**
 * Explicitly dispose panels hosted in the given container (or every panel
 * when omitted): remove their DOM and drop viewer cursor state. Invoke on
 * workspace transition and unmount so entries for a removed container cannot
 * linger; rendering again rebuilds from cursor 0 off retained history.
 */
export function disposeAgentTerminalPanels(container?: HTMLElement): void {
  for (const [key, entry] of panels) {
    if (container && entry.host !== container) continue;
    entry.root.remove();
    panels.delete(key);
  }
}

/**
 * Reconcile one transcript panel per PTY in the view. Panels own their
 * viewer cursor and DOM; the session surface only hosts the container.
 * Snapshot-driven: a fetch fires only when the snapshot cursor advanced
 * past the viewer's cursor, so bursts of output coalesce into one read.
 */
export function renderAgentTerminalPanels(container: HTMLElement, view: WorkSessionViewState): void {
  const seen = new Set<string>();
  for (const pty of view.agentPtys ?? []) {
    const key = panelKey(view.workSessionId, pty.processSessionId);
    seen.add(key);
    if (!panels.has(key)) buildPanel(key, container, view.workSessionId, pty);
    const entry = panels.get(key)!;
    entry.host = container;
    if (!entry.root.isConnected) container.append(entry.root);
    if (pty.outputCursor > entry.state.cursor && !entry.state.refreshing) {
      // A higher authoritative cursor after termination still gets one final
      // reconciliation (buffered trailing output); the fetch re-arms `done`
      // when the process is still reported finished, so polling does not
      // resume once the viewer cursor converges.
      if (entry.state.done) entry.state.done = false;
      void refreshPanel(key, view.workSessionId, pty);
    }
    paintPanel(key, pty);
  }
  for (const [key, entry] of panels) {
    if (entry.root.parentElement === container && !seen.has(key)) {
      entry.root.remove();
      panels.delete(key);
      continue;
    }
    // Entries whose host surface detached (workspace transition/unmount)
    // cannot be revisited through their own container: drop them here so a
    // later render rebuilds instead of leaking DOM and cursor state.
    if (entry.host !== container && !entry.host.isConnected) {
      entry.root.remove();
      panels.delete(key);
    }
  }
}

/** Test hook: drop all panel state (DOM tests run without a full app). */
export function resetAgentTerminalPanelsForTests(): void {
  panels.clear();
}
