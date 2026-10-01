/**
 * Connection lifecycle + top-level gated surfaces: connect/retry, reconnect,
 * the workspace approval center view, the recovery indicator, and the
 * workspace approval gate. Extracted verbatim from ui/workspace-app.tsx
 * (P1.4); app-level cells are reached through the shared host binding.
 */
import { approvalCenterId } from "./approval-center.js";
import { element } from "./ui-dom.js";
import { workSessionViews } from "./session-views.js";
import { renderPolicyApproval, renderPolicyGrants } from "./review-feedback.js";
import { queueSessionRehydration } from "./session-hydration.js";
import { ensureSurface } from "./payload-mount.js";
import type { WorkSessionViewState } from "./session-view-types.js";

export interface LifecycleHost {
  getActiveWorkspaceId(): string | null;
  setApprovalRecoveryState(v: "healthy" | "degraded" | "forbidden" | "disconnected"): void;
  approvalRecoveryState(): "healthy" | "degraded" | "forbidden" | "disconnected";
  queueSessionRehydration(): void;
  scheduleRender(): void;
  selectWorkSession(workSessionId: string): void;
  replaceSurfaceChildren(...children: HTMLElement[]): void;
  maybeAppendAgentBar(): void;
  renderEmpty(message: string, tone: "muted" | "error"): void;
  getErrorMessage(): string | null;
  connectApp(): Promise<void>;
  applyHostContext(): void;
  getHostContext(): unknown;
  setHostContext(v: unknown): void;
  recreateApp(): Promise<void>;
  isConnected(): boolean;
  connectionState(): string;
  setConnectionState(v: string): void;
  getConnectionError(): string | null;
  setConnectionError(v: string | null): void;
  setConnected(v: boolean): void;
  bumpWorkspaceWatcherGeneration(): void;
  app(): unknown;
}

let host: LifecycleHost;

// Reconnect de-dup: overlapping transport failures collapse into one retry.
let reconnectPromise: Promise<void> | null = null;
let reconnectGeneration = 0;
const reconnectWaiters = new Set<() => void>();
export function setLifecycleHost(next: LifecycleHost): void {
  host = next;
}

/** Cancel the current reconnect owner and wake any bounded retry backoff. */
export function cancelReconnect(): void {
  reconnectGeneration += 1;
  for (const wake of reconnectWaiters) wake();
  reconnectWaiters.clear();
}

async function waitForRetry(delayMs: number, generation: number): Promise<void> {
  if (generation !== reconnectGeneration) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reconnectWaiters.delete(finish);
      resolve();
    };
    reconnectWaiters.add(finish);
    timer = setTimeout(finish, delayMs);
    if (generation !== reconnectGeneration) finish();
  });
}

function finishConnection(generation: number): boolean {
  if (generation !== reconnectGeneration || !host.app()) return false;
  const initialContext = host.getHostContext();
  if (initialContext) host.setHostContext(initialContext);
  host.applyHostContext();
  host.setConnected(true);
  host.setConnectionState("CONNECTED");
  host.setConnectionError(null);
  host.queueSessionRehydration();
  return true;
}

/** Initial App startup gets one bounded retry and then shows a terminal error. */
export async function connectBootstrapWithRetry(): Promise<void> {
  const generation = reconnectGeneration;
  let lastError: unknown;
  for (let attempt = 0; attempt < 2 && generation === reconnectGeneration; attempt += 1) {
    if (!host.app()) break;
    host.setConnectionState(attempt === 0 ? "CONNECTING" : "RECONNECTING");
    host.scheduleRender();
    try {
      await host.connectApp();
      if (finishConnection(generation)) return;
      break;
    } catch (error) {
      lastError = error;
      if (attempt === 0 && generation === reconnectGeneration && host.app()) {
        await waitForRetry(350, generation);
        if (generation !== reconnectGeneration || !host.app()) break;
        try {
          await host.recreateApp();
        } catch (recreateError) {
          lastError = recreateError;
        }
      }
    }
  }
  if (generation !== reconnectGeneration) return;
  const message = lastError instanceof Error ? lastError.message : String(lastError ?? "The MCP host connection is unavailable.");
  host.setConnected(false);
  host.setConnectionState("DISCONNECTED");
  host.setConnectionError(message);
  host.scheduleRender();
  throw lastError instanceof Error ? lastError : new Error(message);
}

export async function connectWithRetry(reason?: unknown): Promise<void> {
  const generation = reconnectGeneration;
  let retryDelayMs = 1_000;
  while (generation === reconnectGeneration && host.app() && !host.isConnected()) {
    host.setConnectionState(retryDelayMs === 1_000 && !reason ? "CONNECTING" : "RECONNECTING");
    host.scheduleRender();
    try {
      await host.connectApp();
      if (finishConnection(generation)) return;
      break;
    } catch (connectErrorValue) {
      if (generation !== reconnectGeneration || !host.app()) break;
      // A failed host transport may leave the SDK App instance permanently
      // bound to a closed message channel. Recreate the SDK object before the
      // next bounded attempt; the host supplies all durable UI state through
      // rehydration after the new handshake.
      try {
        await host.recreateApp();
      } catch (recreateError) {
        connectErrorValue = recreateError;
      }
      if (generation !== reconnectGeneration || !host.app()) break;
      host.setConnectionState("RECONNECTING");
      host.setConnectionError(connectErrorValue instanceof Error
        ? connectErrorValue.message
        : String(connectErrorValue));
      host.scheduleRender();
      const jitter = Math.floor(Math.random() * Math.min(500, retryDelayMs / 2));
      await waitForRetry(retryDelayMs + jitter, generation);
      retryDelayMs = Math.min(30_000, retryDelayMs * 2);
      reason = undefined;
    }
  }
  throw new Error("The MCP host connection is unavailable.");
}


export async function reconnectApp(reason: unknown): Promise<void> {
  if (reconnectPromise) return reconnectPromise;
  reconnectPromise = (async () => {
    if (!host.app()) throw new Error("The MCP host connection is unavailable.");
    host.setConnected(false);
    host.bumpWorkspaceWatcherGeneration();
    await connectWithRetry(reason);
  })().finally(() => {
    reconnectPromise = null;
  });
  return reconnectPromise;
}

export function renderApprovalCenterView(view: WorkSessionViewState): void {
  // P0.5: only the active workspace's approval center can render. A center
  // selected under another workspace falls back to the gated empty surface
  // instead of leaking that workspace's direct approvals.
  if (view.workSessionId !== approvalCenterId(host.getActiveWorkspaceId())) {
    if (renderWorkspaceApprovalGate()) return;
    host.renderEmpty(host.getErrorMessage() ?? "Waiting for a tool result.", host.getErrorMessage() ? "error" : "muted");
    return;
  }
  ensureSurface("approval-center");
  const main = element("main", { className: "shell" });
  const section = element("section", { className: "tool-card agent" });
  section.append(
    element("div", { className: "tool-title", text: "Workspace approvals" }),
    element("div", { className: "tool-label", text: `${view.policyApprovals.size} pending direct MCP operation(s)` }),
  );
  if (view.policyApprovals.size === 0 && host.approvalRecoveryState() === "healthy") {
    section.append(element("div", { className: "empty muted", text: "No pending approvals." }));
  } else if (view.policyApprovals.size === 0) {
    section.append(element("div", { className: "empty muted", text: "No pending approvals." }));
    section.append(renderApprovalRecoveryIndicator());
  } else {
    const list = element("div", { className: "approval-list" });
    for (const approval of view.policyApprovals.values()) list.append(renderPolicyApproval(view, approval));
    section.append(list);
    if (host.approvalRecoveryState() !== "healthy") section.append(renderApprovalRecoveryIndicator());
  }
  section.append(renderPolicyGrants(view));
  main.append(section);
  host.replaceSurfaceChildren(main);
  host.maybeAppendAgentBar();
}

/** P1: explicit approval-recovery health indicator with a manual retry. */
export function renderApprovalRecoveryIndicator(): HTMLElement {
  const indicator = element("div", { className: "session-notice warning", role: "status" });
  const message = host.approvalRecoveryState() === "forbidden"
    ? "Reviewer authorization failed: approval recovery is unavailable."
    : host.approvalRecoveryState() === "disconnected"
      ? "Approval recovery unavailable: the host connection is down."
      : "Approval recovery unavailable: pending approvals may be stale.";
  indicator.append(element("span", { text: message }));
  const retry = element("button", { className: "notice-action", type: "button", text: "Retry" });
  retry.addEventListener("click", () => {
    host.setApprovalRecoveryState("healthy");
    host.queueSessionRehydration();
    host.scheduleRender();
  });
  indicator.append(retry);
  return indicator;
}

/**
 * P0.3: prominent "Needs approval" banner shown in every current Kontrol
 * surface while a direct approval for the active workspace is pending but
 * not currently displayed. Returns true when the banner was rendered into a
 * standalone gated surface.
 */
export function renderWorkspaceApprovalGate(): boolean {
  const center = host.getActiveWorkspaceId() ? workSessionViews.get(approvalCenterId(host.getActiveWorkspaceId())) : undefined;
  if (!host.getActiveWorkspaceId() || !center || center.policyApprovals.size === 0) return false;
  const main = element("main", { className: "shell" });
  const section = element("section", { className: "session-notice warning approval-gate", role: "alert" });
  const review = element("button", {
    className: "notice-action approval-gate-action",
    type: "button",
    text: `Needs approval — ${center.policyApprovals.size} pending operation${center.policyApprovals.size === 1 ? "" : "s"}`,
    ariaLabel: "Open workspace approvals",
  });
  review.addEventListener("click", () => host.selectWorkSession(center.workSessionId));
  section.append(
    element("span", { className: "approval-gate-message", text: "A direct MCP operation is blocked and waiting for your decision." }),
    review,
  );
  main.append(section);
  host.replaceSurfaceChildren(main);
  host.maybeAppendAgentBar();
  return true;
}
