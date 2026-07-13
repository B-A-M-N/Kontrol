import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
} from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  isEditTool,
  isExpandableCard,
  isPatchTool,
  isReadTool,
  isReviewTool,
  isSearchTool,
  isShellTool,
  isToolName,
  isToolResultCard,
  isAgentRunCard,
  isWriteTool,
  payloadText,
  summaryNumber,
  type AgentToolEvent,
  type HostContext,
  type PatchOperation,
  type ToolName,
  type ToolResultCard,
} from "./card-types.js";
import { getPatchDisplayParts } from "./patch-display.js";
import "./workspace-app.css";

interface ToolDisplay {
  icon: string;
  title: string;
  label: string;
  tone: string;
}

interface MountedPayload {
  update(options: {
    card: ToolResultCard;
    hostContext?: HostContext;
    errorMessage?: string | null;
    visibleFileCount?: number;
  }): void;
  unmount(): void;
}

// ── Work-session view model ───────────────────────────
// A run is a long-lived workflow, not a succession of unrelated single cards.
// Each delegated task owns a WorkSessionViewState that composes the run header,
// the live activity timeline, and the current review submission + feedback.

interface AgentActivityEvent {
  seq: number;
  id: string;
  type: string;
  sessionId: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

interface ReviewSubmissionView {
  submissionId: string;
  submissionNumber: number;
  status: string;
  message?: string;
  files: Array<{ path?: string; previousPath?: string; operation?: string }>;
  patch: string;
  additions: number;
  removals: number;
  diffSha256?: string;
  reviewEpoch?: number;
}

interface PolicyApprovalView {
  approvalId: string;
  workspaceId?: string;
  workSessionId?: string;
  tool: string;
  path?: string;
  command?: string;
  approvalKey?: string;
  matchedPattern?: string;
  options?: Array<{
    id: string;
    label: string;
    effect: "approve" | "deny" | "changes_requested";
    scope?: "once" | "work_session" | "workspace";
  }>;
  uiState?: "idle" | "submitting" | "resolved" | "error";
  error?: string;
}

type FeedbackState = "idle" | "submitting" | "submitted" | "error";

interface WorkSessionViewState {
  workspaceSessionId: string;
  workSessionId: string;
  runId: string;
  status: string;
  lastSeq: number;
  activity: AgentActivityEvent[];
  submissions: Map<string, ReviewSubmissionView>;
  policyApprovals: Map<string, PolicyApprovalView>;
  activeSubmissionId?: string;
  feedbackStateBySubmission: Map<string, FeedbackState>;
  feedbackErrorBySubmission: Map<string, string>;
  feedbackMessage?: string;
}

let app: App | null = null;
let connected = false;
let connectionError: string | null = null;
let hostContext: HostContext | undefined;

// Durable UI state.
let activeWorkspaceId: string | null = null;
const workSessionViews = new Map<string, WorkSessionViewState>();
let selectedWorkSessionId: string | null = null;
let lastToolCard: ToolResultCard | null = null;

// View-local UI state (replaced the previous globals).
let expanded = false;
let reviewFilesExpanded = false;
let errorMessage: string | null = null;
let currentPayload: MountedPayload | null = null;
let currentPayloadContainer: HTMLElement | null = null;
let agentBar: HTMLElement | null = null;

// Generation-controlled watcher: incrementing this cancels any in-flight
// await_work_session_events loop (no 2.5s poll timer — we block on the host
// tool until the next event or a connection-liveness timeout).
// Per-session watcher generations so starting a second run cancels only the
// watcher for the same work session, not all watchers.
const watcherGenerations = new Map<string, number>();

const maybeAppRoot = document.querySelector<HTMLElement>("#app");
if (!maybeAppRoot) {
  throw new Error("Missing #app root element.");
}
const appRoot = maybeAppRoot;

void boot();

async function boot(): Promise<void> {
  render();

  app = new App(
    { name: "kontrol-tool-cards", version: "0.4.0" },
    {},
  );

  app.ontoolresult = (result) => {
    const structuredContent = getStructuredContent<Partial<ToolResultCard>>(result);
    const metaCard = cardFromMeta(result);
    const structured = metaCard
      ? { ...structuredContent, ...metaCard }
      : structuredContent;
    const tool = toolNameFromMeta(result);

    if (!tool || !isToolResultCard(structured)) {
      lastToolCard = null;
      selectedWorkSessionId = null;
      expanded = false;
      reviewFilesExpanded = false;
      errorMessage = "No result card is available for this tool result.";
      render();
      return;
    }

    // open_workspace carries the currently opened workspace ID.
    if (tool === "open_workspace" && structured.workspaceId) {
      activeWorkspaceId = structured.workspaceId;
    }

    // Agent run (submit_to_coding_agent) and review (submit_for_review) cards
    // drive the work-session view model.
    if (tool === "submit_to_coding_agent" || isReviewTool(tool)) {
      const wsId =
        (structured as { workSessionId?: string }).workSessionId ??
        (structured as { summary?: { sessionId?: string } }).summary?.sessionId;

      if (wsId) {
        ensureWorkSessionView(
          wsId,
          (structured as { workspaceSessionId?: string }).workspaceSessionId ?? activeWorkspaceId ?? "",
          (structured as { runId?: string }).runId ?? "",
        );
        selectedWorkSessionId = wsId;
        lastToolCard = null;
        expanded = false;
        reviewFilesExpanded = false;
        errorMessage = null;
        void watchWorkSession(wsId);
        render();
        return;
      }
    }

    // Any other tool result is a transient card; it does not destroy the
    // work-session view, but clears the selection so the card renders.
    lastToolCard = { ...structured, tool };
    selectedWorkSessionId = null;
    expanded = false;
    reviewFilesExpanded = false;
    errorMessage = null;
    render();
  };

  app.onhostcontextchanged = (ctx) => {
    hostContext = { ...hostContext, ...ctx };
    applyHostContext();
    renderPayloadIfNeeded();
  };

  app.onteardown = async () => {
    unmountPayload();
    return {};
  };

  try {
    await app.connect();
    const initialContext = app.getHostContext();
    if (initialContext) hostContext = initialContext;
    applyHostContext();
    connected = true;
  } catch (connectError) {
    connectionError = connectError instanceof Error
      ? connectError.message
      : String(connectError);
  }

  render();
}

function ensureWorkSessionView(workSessionId: string, workspaceSessionId: string, runId: string): WorkSessionViewState {
  let view = workSessionViews.get(workSessionId);
  if (!view) {
    view = {
      workspaceSessionId,
      workSessionId,
      runId,
      status: "in_progress",
      lastSeq: 0,
      activity: [],
      submissions: new Map(),
      policyApprovals: new Map(),
      feedbackStateBySubmission: new Map(),
      feedbackErrorBySubmission: new Map(),
    };
    workSessionViews.set(workSessionId, view);
  } else {
    if (workspaceSessionId) view.workspaceSessionId = workspaceSessionId;
    if (runId) view.runId = runId;
  }
  return view;
}

function applyHostContext(): void {
  if (hostContext?.theme) applyDocumentTheme(hostContext.theme);
  if (hostContext?.styles?.variables) {
    applyHostStyleVariables(hostContext.styles.variables);
  }
  if (hostContext?.styles?.css?.fonts) {
    applyHostFonts(hostContext.styles.css.fonts);
  }
  const insets = hostContext?.safeAreaInsets;
  if (!insets) return;
  document.body.style.padding = `${insets.top}px ${insets.right}px ${insets.bottom}px ${insets.left}px`;
}

function render(): void {
  unmountPayload();

  if (connectionError) {
    renderEmpty(connectionError, "error");
    return;
  }
  if (!connected) {
    renderEmpty("Connecting to host...");
    return;
  }

  const view = selectedWorkSessionId ? workSessionViews.get(selectedWorkSessionId) : undefined;
  if (view) {
    renderWorkSessionView(view);
    return;
  }

  if (!lastToolCard) {
    renderEmpty(errorMessage ?? "Waiting for a tool result.", errorMessage ? "error" : "muted");
    return;
  }

  const card = lastToolCard;
  const display = getToolDisplay(card);
  if (card.tool === "open_approval_center") {
    renderApprovalCenterCard(card, display);
    return;
  }
  if (isReviewTool(card.tool)) {
    renderReviewCard(card, display);
    return;
  }

  const expandable = isExpandableCard(card);
  const main = element("main", { className: "shell" });
  const section = element("section", { className: `tool-card ${display.tone}` });
  const button = element("button", {
    className: "tool-header",
    type: "button",
    ariaExpanded: String(expanded),
    disabled: !expandable,
  });

  if (expandable) {
    button.addEventListener("click", () => {
      expanded = !expanded;
      render();
    });
  }

  const icon = element("span", { className: "tool-icon", ariaHidden: "true" });
  icon.innerHTML = display.icon;

  const toolMain = element("span", { className: "tool-main" });
  const title = element("span", { className: "tool-title", text: display.title });
  const label = element("span", {
    className: "tool-label",
    text: display.label,
    title: display.label,
  });
  toolMain.append(title, label);

  button.append(
    icon,
    toolMain,
    renderSummaryBadge(card),
    renderChevron(expanded, expandable),
  );
  section.append(button);

  if (expanded) {
    const body = element("div", { className: "tool-body" });
    currentPayloadContainer = body;
    section.append(body);
  }

  main.append(section);
  appRoot.replaceChildren(main);
  maybeAppendAgentBar();
  renderPayloadIfNeeded();
}

function renderEmpty(message: string, tone: "muted" | "error" = "muted"): void {
  const main = element("main", { className: "shell" });
  main.append(element("section", { className: `empty ${tone}`, text: message }));
  appRoot.replaceChildren(main);
  maybeAppendAgentBar();
}

function renderSummaryBadge(card: ToolResultCard): HTMLElement {
  const badge = element("span", { className: "tool-badge", ariaHidden: "true" });
  if (isReviewTool(card.tool)) {
    const files = summaryNumber(card.summary, "files") ?? card.files?.length ?? 0;
    badge.textContent = files > 0 ? `${files} file${files === 1 ? "" : "s"}` : "review";
  } else if (card.summary?.status) {
    badge.textContent = String(card.summary.status);
  } else if (card.path) {
    badge.textContent = card.path.split("/").pop() ?? card.path;
  } else {
    badge.textContent = card.tool;
  }
  return badge;
}

function unmountPayload(): void {
  if (currentPayload) {
    try {
      currentPayload.unmount();
    } catch {
      /* ignore */
    }
    currentPayload = null;
  }
  if (currentPayloadContainer) {
    currentPayloadContainer.replaceChildren();
  }
}

function renderPayloadIfNeeded(): void {
  const target = currentPayloadContainer;
  if (!target) return;
  target.replaceChildren();
  const card = lastToolCard;
  if (!card) return;

  if (isReviewTool(card.tool)) {
    const patch = card.payload?.patch;
    if (patch) {
      const pre = element("pre", { className: "review-patch" });
      pre.textContent = patch;
      target.append(pre);
    } else if (card.files?.length) {
      const ul = element("ul", { className: "review-filelist" });
      for (const f of card.files) {
        ul.append(element("li", { text: `${f.path ?? f.previousPath ?? "file"}${f.operation ? ` (${f.operation})` : ""}` }));
      }
      target.append(ul);
    }
    return;
  }

  const text = card.payload?.patch ?? payloadText(card.payload);
  if (text) {
    const pre = element("pre", { className: "tool-payload" });
    pre.textContent = text;
    target.append(pre);
  }
}

// ── Composed work-session view ───────────────────────

function renderWorkSessionView(view: WorkSessionViewState): void {
  const main = element("main", { className: "shell" });
  const section = element("section", { className: "tool-card agent" });

  // Run header.
  const header = element("div", { className: "review-header" });
  const icon = element("span", { className: "tool-icon", ariaHidden: "true" });
  icon.innerHTML = agentIcon();
  const titleGroup = element("div", { className: "review-title-group" });
  titleGroup.append(
    element("span", { className: "tool-title", text: "Coding Agent Run" }),
    element("span", { className: "tool-label", text: view.status, title: view.status }),
  );
  header.append(icon, titleGroup, element("span", { className: "tool-badge", text: view.status }));
  section.append(header);

  const meta = element("div", { className: "agent-meta" });
  if (view.workspaceSessionId) meta.append(element("span", { className: "agent-meta-row", text: `workspace: ${view.workspaceSessionId}` }));
  if (view.workSessionId) meta.append(element("span", { className: "agent-meta-row", text: `session: ${view.workSessionId}` }));
  if (view.runId) meta.append(element("span", { className: "agent-meta-row", text: `run: ${view.runId}` }));
  section.append(meta);

  // Activity timeline.
  const activityHeader = element("div", { className: "agent-activity-header", text: "Agent activity" });
  section.append(activityHeader);
  const activity = element("ul", { className: "agent-activity" });
  if (view.activity.length === 0) {
    activity.append(element("li", { className: "agent-event muted", text: "No activity yet." }));
  }
  for (const e of view.activity.slice(-50)) {
    const label = eventLabel(e);
    const title = String(e.payload?.outputSummary ?? e.payload?.text ?? e.payload?.description ?? "");
    activity.append(element("li", { className: e.payload?.success === false ? "agent-event failed" : "agent-event", text: label, title }));
  }
  section.append(activity);

  if (view.policyApprovals.size > 0) {
    section.append(element("div", { className: "agent-activity-header", text: "Policy approvals" }));
    const approvals = element("div", { className: "approval-list" });
    for (const approval of view.policyApprovals.values()) {
      approvals.append(renderPolicyApproval(view, approval));
    }
    section.append(approvals);
  }

  // Current review submission (if any).
  const submission = view.activeSubmissionId ? view.submissions.get(view.activeSubmissionId) : undefined;
  if (submission) {
    const subHeader = element("div", { className: "agent-activity-header", text: `Review submission #${submission.submissionNumber}` });
    section.append(subHeader);

    if (submission.patch) {
      const pre = element("pre", { className: "review-patch" });
      pre.textContent = submission.patch;
      section.append(pre);
    }

    const fbState = view.feedbackStateBySubmission.get(submission.submissionId) ?? "idle";
    if (fbState === "submitted") {
      section.append(renderFeedbackSubmitted(view));
    } else {
      section.append(renderFeedbackFormForSubmission(view, submission));
    }
  } else if (view.status === "awaiting_review") {
    section.append(element("div", { className: "empty muted", text: "Awaiting review submission…" }));
  }

  main.append(section);
  appRoot.replaceChildren(main);
  maybeAppendAgentBar();
}

function eventLabel(e: AgentActivityEvent): string {
  switch (e.type) {
    case "agent.run.started": return "run started";
    case "agent.run.heartbeat": return "heartbeat";
    case "agent.run.output_delta": return String(e.payload?.text ?? "output").slice(0, 160);
    case "agent.run.thought_delta": return `thought: ${String(e.payload?.text ?? "").slice(0, 120)}`;
    case "agent.tool.started": return `→ ${String(e.payload?.tool ?? "tool")}`;
    case "agent.tool.completed": return `✓ ${String(e.payload?.tool ?? "tool")}${e.payload?.path ? " · " + e.payload.path : ""}`;
    case "agent.tool.failed": return `✗ ${String(e.payload?.tool ?? "tool")}${e.payload?.path ? " · " + e.payload.path : ""}`;
    case "agent.plan.updated": return "plan updated";
    case "worker.turn.completed": return "worker turn completed";
    case "worker.turn.completed_review_submitted": return "review barrier created";
    case "worker.attempt.exited": return "worker exited; review still open";
    case "review.submitted": return `submitted #${String(e.payload?.submissionNumber ?? "")}`;
    case "review.feedback.provided": return `feedback: ${String(e.payload?.verdict ?? "")}`;
    case "agent.run.approved": return "approved";
    case "agent.run.rejected": return "rejected";
    case "agent.run.failed": return "failed";
    case "agent.run.cancelled": return "cancelled";
    case "continuation.created": return "continuation queued";
    case "continuation.delivered": return "continuation delivered";
    case "policy.approval_requested": return `approval needed: ${String(e.payload?.tool ?? "tool")}`;
    case "policy.approval.provided":
    case "approval.resolved":
      return "approval resolved";
    default: return e.type;
  }
}

// ── Event-driven watcher (replaces the 2.5s poll) ──

async function watchWorkSession(sessionId: string, initialSeq = 0): Promise<void> {
  let cursor = initialSeq;
  const myGen = Date.now();
  watcherGenerations.set(sessionId, myGen);

  while (app && watcherGenerations.get(sessionId) === myGen) {
    try {
      const result = await app.callServerTool({
        name: "await_work_session_events",
        arguments: { sessionId, afterSeq: cursor, timeoutMs: 55000 },
      });

      if (watcherGenerations.get(sessionId) !== myGen) return;

      const content = getStructuredContent<{
        events: AgentActivityEvent[];
        nextSeq: number;
        terminal: boolean;
      }>(result);

      if (!content) continue;

      for (const event of content.events) {
        reduceWorkSessionEvent(sessionId, event);
      }
      cursor = content.nextSeq;
      render();
      if (content.terminal) return;
    } catch (error) {
      if (watcherGenerations.get(sessionId) !== myGen) return;

      const view = workSessionViews.get(sessionId);
      if (view) {
        view.feedbackMessage = `Activity connection interrupted: ${
          error instanceof Error ? error.message : String(error)
        }`;
      }
      render();

      // Transport failure: reconnect after a brief delay (not polling)
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

function reduceWorkSessionEvent(sessionId: string, event: AgentActivityEvent): void {
  const view = workSessionViews.get(sessionId);
  if (!view) return;
  view.activity.push(event);
  if (view.activity.length > 200) view.activity.shift();
  view.lastSeq = Math.max(view.lastSeq, event.seq);

  if (event.type === "review.submitted") {
    const submissionId = String(event.payload?.submissionId ?? "");
    view.status = "awaiting_review";
    // Auto-fetch the full submission card from the agent's submit_for_review
    // invocation (which occurred in CRUSH's MCP connection, not this iframe).
    if (submissionId && app) {
      void app
        .callServerTool({ name: "get_review_submission", arguments: { sessionId, submissionId } })
        .then((res) => {
          const sc = getStructuredContent<{
            submissionId: string;
            status: string;
            files: number;
            additions: number;
            removals: number;
            submissionNumber: number;
            diffSha256?: string;
            reviewEpoch?: number;
          } & { summary?: ReviewSubmissionView }>(res);
          if (!sc) return;
          const card = (res as { _meta?: { card?: { summary?: ReviewSubmissionView; files?: ReviewSubmissionView["files"]; payload?: { patch: string } } } })._meta?.card;
          const view2 = workSessionViews.get(sessionId);
          if (!view2) return;
          view2.submissions.set(submissionId, {
            submissionId,
            submissionNumber: Number(event.payload?.submissionNumber ?? sc.submissionNumber ?? 0),
            status: sc.status,
            files: card?.files ?? [],
            patch: card?.payload?.patch ?? "",
            additions: card?.summary?.additions ?? sc.additions ?? 0,
            removals: card?.summary?.removals ?? sc.removals ?? 0,
            message: card?.summary?.message,
            diffSha256: String(card?.summary?.diffSha256 ?? sc.diffSha256 ?? ""),
            reviewEpoch: Number(card?.summary?.reviewEpoch ?? sc.reviewEpoch ?? 0),
          });
          view2.activeSubmissionId = submissionId;
          render();
        })
        .catch((err) => {
          // P1 #11: surface the failure to load submission details rather than
          // silently leaving a blank card (which would mask a worker/transport
          // failure).
          errorMessage =
            "Failed to load submission details: " +
            (err instanceof Error ? err.message : String(err));
          render();
        });
    }
  } else if (event.type === "review.feedback.provided") {
    const sid = String(event.payload?.submissionId ?? view.activeSubmissionId ?? "");
    if (sid && view.submissions.has(sid)) view.feedbackStateBySubmission.set(sid, "submitted");
    view.feedbackMessage = "Feedback submitted. The waiting agent has been notified.";
  } else if (event.type === "agent.run.approved") {
    view.status = "approved";
  } else if (event.type === "agent.run.rejected") {
    view.status = "rejected";
  } else if (event.type === "agent.run.failed" || event.type === "agent.run.cancelled") {
    view.status = event.type === "agent.run.failed" ? "failed" : "cancelled";
  } else if (event.type === "policy.approval_requested" || event.type === "approval.requested") {
    const approvalId = String(event.payload?.approvalId ?? "");
    if (approvalId) {
      view.policyApprovals.set(approvalId, {
        approvalId,
        workspaceId: typeof event.payload?.workspaceId === "string" ? event.payload.workspaceId : undefined,
        workSessionId: typeof event.payload?.workSessionId === "string" ? event.payload.workSessionId : undefined,
        tool: String(event.payload?.tool ?? "tool"),
        path: typeof event.payload?.path === "string" ? event.payload.path : undefined,
        command: typeof event.payload?.command === "string" ? event.payload.command : undefined,
        approvalKey: typeof event.payload?.approvalKey === "string" ? event.payload.approvalKey : undefined,
        matchedPattern: typeof event.payload?.matchedPattern === "string" ? event.payload.matchedPattern : undefined,
        options: parsePolicyApprovalOptions(event.payload?.options),
      });
    }
  } else if (event.type === "policy.approval.provided" || event.type === "approval.resolved") {
    const approvalId = String(event.payload?.approvalId ?? "");
    if (approvalId) view.policyApprovals.delete(approvalId);
  }
}

// ── Agent submit bar ─────────────────────────────────

function renderAgentSubmitBar(): HTMLElement {
  if (!agentBar) {
    agentBar = element("div", { className: "agent-submit-bar" });
    agentBar.style.cssText =
      "position:sticky;bottom:0;display:flex;gap:6px;padding:8px 10px;background:var(--surface,#111827);border-top:1px solid var(--border,#1f2937)";

    const input = document.createElement("input");
    input.className = "agent-submit-input";
    input.placeholder = "Send a task to the coding agent…";
    input.setAttribute("aria-label", "Task for coding agent");
    input.style.cssText =
      "flex:1;min-width:0;padding:6px 8px;border-radius:6px;border:1px solid var(--border,#1f2937);background:#0b1220;color:inherit;font:inherit";

    const btn = element("button", { className: "agent-submit-btn", type: "button", text: "Send" });
    btn.style.cssText =
      "padding:6px 12px;border-radius:6px;border:0;background:#2563eb;color:#fff;font:inherit;cursor:pointer";

    btn.addEventListener("click", () => {
      const task = input.value.trim();
      if (!task || !app) return;
      if (!activeWorkspaceId) {
        input.value = "";
        input.placeholder = "Open a workspace before dispatching a coding agent.";
        return;
      }
      btn.setAttribute("disabled", "true");
      void app
        .callServerTool({
          name: "submit_to_coding_agent",
          arguments: { task, workspaceSessionId: activeWorkspaceId },
        })
        .then((result) => {
          const dispatch = getStructuredContent<{
            runId: string;
            remoteRunId?: string;
            workSessionId: string;
            workspaceSessionId: string;
            status: string;
            output: string;
            error?: string;
          }>(result);

          if (!dispatch?.workSessionId) {
            input.value = dispatch?.error ?? "Coding-agent dispatch returned no workSessionId.";
            return;
          }

          const view = ensureWorkSessionView(
            dispatch.workSessionId,
            dispatch.workspaceSessionId,
            dispatch.runId,
          );
          view.status = dispatch.status;
          selectedWorkSessionId = dispatch.workSessionId;
          lastToolCard = null;
          expanded = false;
          reviewFilesExpanded = false;
          errorMessage = null;
          input.value = "";
          render();
          void watchWorkSession(dispatch.workSessionId, view.lastSeq);
        })
        .catch((err) => {
          input.value = String(err instanceof Error ? err.message : err);
        })
        .finally(() => btn.removeAttribute("disabled"));
    });

    agentBar.append(input, btn);
  }
  return agentBar;
}

function maybeAppendAgentBar(): void {
  if (connected) appRoot.append(renderAgentSubmitBar());
}

// ── Legacy review card (non-work-session review surfaces) ──

function renderReviewCard(card: ToolResultCard, display: ToolDisplay): void {
  unmountPayload();

  const files = card.files ?? [];
  const summary = card.summary ?? {};
  const visibleFiles = reviewFilesExpanded ? files : files.slice(0, 3);
  const hiddenCount = Math.max(0, files.length - visibleFiles.length);
  const main = element("main", { className: "shell" });
  const section = element("section", { className: "tool-card review" });
  const header = element("div", { className: "review-header" });
  const icon = element("span", { className: "tool-icon", ariaHidden: "true" });
  icon.innerHTML = display.icon;
  const titleGroup = element("div", { className: "review-title-group" });

  titleGroup.append(
    element("span", { className: "tool-title", text: display.title }),
    element("span", { className: "tool-label", text: display.label, title: display.label }),
  );
  header.append(icon, titleGroup, renderSummaryBadge(card));

  const body = element("div", { className: "review-summary" });
  currentPayloadContainer = body;

  const actions = element("div", { className: "review-actions" });
  if (hiddenCount > 0) {
    const showMore = element("button", {
      className: "review-action",
      type: "button",
      text: `Show ${hiddenCount} more ${hiddenCount === 1 ? "file" : "files"}`,
    });
    showMore.addEventListener("click", () => {
      reviewFilesExpanded = true;
      render();
    });
    actions.append(showMore);
  }

  section.append(header, body);
  if (actions.childElementCount > 0) {
    section.append(actions);
  }

  if (card.tool === "submit_for_review" && !feedbackSubmittedGlobal && typeof card.summary?.sessionId === "string") {
    section.append(renderFeedbackFormForSession(card.summary.sessionId, card));
  } else if (card.tool === "submit_for_review" && feedbackSubmittedGlobal) {
    section.append(renderFeedbackSubmittedGlobal());
  }

  main.append(section);
  appRoot.replaceChildren(main);
  renderPayloadIfNeeded();
}

let feedbackSubmittedGlobal = false;
let feedbackSubmittingGlobal = false;
let feedbackErrorGlobal: string | null = null;

function renderFeedbackFormForSession(sessionId: string, card: ToolResultCard): HTMLElement {
  const container = element("div", { className: "feedback-form" });
  const label = element("label", { className: "feedback-label", text: "Review feedback" });
  const textarea = document.createElement("textarea");
  textarea.className = "feedback-textarea";
  textarea.placeholder = "Tell the agent what to fix, or leave blank for a clean approve/reject.";
  textarea.rows = 3;

  if (feedbackErrorGlobal) {
    container.append(element("div", { className: "feedback-error", text: feedbackErrorGlobal }));
  }

  const buttonRow = element("div", { className: "feedback-buttons" });

  const makeButton = (verdict: string, text: string, cls: string): HTMLButtonElement => {
    const btn = element("button", { className: `feedback-btn ${cls}`, type: "button", text });
    // P1 #11: disable verdict buttons while a submission is in flight so the
    // reviewer cannot double-submit or fire overlapping feedback calls.
    if (feedbackSubmittingGlobal) btn.disabled = true;
    btn.addEventListener("click", () => {
      submitFeedbackForSession(sessionId, card, verdict, textarea.value.trim() || undefined);
    });
    return btn;
  };

  buttonRow.append(
    makeButton("approve", "Approve", "approve"),
    makeButton("changes_requested", "Request Changes", "changes"),
    makeButton("reject", "Reject", "reject"),
  );

  container.append(label, textarea, buttonRow);
  return container;
}

async function submitFeedbackForSession(sessionId: string, card: ToolResultCard, verdict: string, comments?: string): Promise<void> {
  if (!sessionId || !app) return;
  feedbackSubmittingGlobal = true;
  feedbackErrorGlobal = null;
  render();
  try {
    await app.callServerTool({
      name: "provide_review_feedback",
      arguments: {
        sessionId,
        submissionId: typeof card.summary?.submissionId === "string" ? card.summary.submissionId : undefined,
        diffSha256: typeof card.summary?.diffSha256 === "string" ? card.summary.diffSha256 : undefined,
        reviewEpoch: typeof card.summary?.reviewEpoch === "number" ? card.summary.reviewEpoch : undefined,
        verdict,
        comments,
      },
    });
    feedbackSubmittedGlobal = true;
    feedbackSubmittingGlobal = false;
    render();
  } catch (err) {
    // P1 #11: surface the transport / worker execution failure instead of
    // swallowing it — the reviewer needs to know the feedback did not land.
    feedbackSubmittingGlobal = false;
    feedbackErrorGlobal =
      "Failed to submit feedback: " + (err instanceof Error ? err.message : String(err));
    render();
  }
}

function renderFeedbackSubmittedGlobal(): HTMLElement {
  return element("div", { className: "feedback-submitted", text: "Feedback submitted. The waiting agent has been notified." });
}

function renderApprovalCenterCard(card: ToolResultCard, display: ToolDisplay): void {
  unmountPayload();
  const main = element("main", { className: "shell" });
  const section = element("section", { className: "tool-card agent" });
  const header = element("div", { className: "review-header" });
  const icon = element("span", { className: "tool-icon", ariaHidden: "true" });
  icon.innerHTML = display.icon;
  const titleGroup = element("div", { className: "review-title-group" });
  titleGroup.append(
    element("span", { className: "tool-title", text: "Approval Center" }),
    element("span", { className: "tool-label", text: `${String(card.summary?.count ?? 0)} pending` }),
  );
  header.append(icon, titleGroup, renderSummaryBadge(card));
  section.append(header);

  const approvals = Array.isArray(card.summary?.approvals)
    ? card.summary.approvals as Array<Record<string, unknown>>
    : [];
  if (approvals.length === 0) {
    section.append(element("div", { className: "empty muted", text: "No pending approvals." }));
  } else {
    const list = element("div", { className: "approval-list" });
    const tempView = ensureWorkSessionView("__approval_center__", "", "");
    for (const approval of approvals) {
      list.append(renderPolicyApproval(tempView, {
        approvalId: String(approval.id ?? ""),
        workspaceId: typeof approval.workspaceId === "string" ? approval.workspaceId : undefined,
        workSessionId: typeof approval.workSessionId === "string" ? approval.workSessionId : undefined,
        tool: String(approval.tool ?? "tool"),
        path: typeof approval.path === "string" ? approval.path : undefined,
        command: typeof approval.command === "string" ? approval.command : undefined,
        options: parsePolicyApprovalOptions(approval.options),
      }));
    }
    section.append(list);
  }
  main.append(section);
  appRoot.replaceChildren(main);
}

// ── Work-session feedback form ────────────────────────

function renderFeedbackFormForSubmission(view: WorkSessionViewState, submission: ReviewSubmissionView): HTMLElement {
  const container = element("div", { className: "feedback-form" });
  const label = element("label", { className: "feedback-label", text: "Review feedback" });
  const textarea = document.createElement("textarea");
  textarea.className = "feedback-textarea";
  textarea.placeholder = "Tell the agent what to fix, or leave blank for a clean approve/reject.";
  textarea.rows = 3;

  const submissionId = submission.submissionId;
  const state = view.feedbackStateBySubmission.get(submissionId);
  const isSubmitting = state === "submitting";
  const isError = state === "error";

  if (isError && view.feedbackErrorBySubmission.get(submissionId)) {
    container.append(element("div", { className: "feedback-error", text: view.feedbackErrorBySubmission.get(submissionId) ?? "" }));
  }

  const buttonRow = element("div", { className: "feedback-buttons" });

  const makeButton = (verdict: string, text: string, cls: string): HTMLButtonElement => {
    const btn = element("button", { className: `feedback-btn ${cls}`, type: "button", text });
    // P1 #11: disable verdict buttons while a submission is in flight.
    if (isSubmitting) btn.disabled = true;
    btn.addEventListener("click", () => {
      submitFeedbackForSubmission(view, submission, verdict, textarea.value.trim() || undefined);
    });
    return btn;
  };

  buttonRow.append(
    makeButton("approve", "Approve", "approve"),
    makeButton("changes_requested", "Request Changes", "changes"),
    makeButton("reject", "Reject", "reject"),
  );

  container.append(label, textarea, buttonRow);
  return container;
}

async function submitFeedbackForSubmission(view: WorkSessionViewState, submission: ReviewSubmissionView, verdict: string, comments?: string): Promise<void> {
  if (!app) return;
  const submissionId = submission.submissionId;
  view.feedbackStateBySubmission.set(submissionId, "submitting");
  view.feedbackErrorBySubmission.delete(submissionId);
  render();
  try {
    await app.callServerTool({
      name: "provide_review_feedback",
      arguments: {
        sessionId: view.workSessionId,
        submissionId,
        diffSha256: submission.diffSha256,
        reviewEpoch: submission.reviewEpoch,
        verdict,
        comments,
      },
    });
    view.feedbackStateBySubmission.set(submissionId, "submitted");
    view.feedbackMessage = "Feedback submitted. The waiting agent has been notified.";
  } catch (err) {
    // P1 #11: surface the transport / worker execution failure instead of
    // leaving the reviewer blind.
    view.feedbackStateBySubmission.set(submissionId, "error");
    view.feedbackErrorBySubmission.set(
      submissionId,
      "Failed to submit feedback: " + (err instanceof Error ? err.message : String(err)),
    );
  }
  render();
}

function renderFeedbackSubmitted(view: WorkSessionViewState): HTMLElement {
  return element("div", { className: "feedback-submitted", text: view.feedbackMessage ?? "Feedback submitted. The waiting agent has been notified." });
}

function renderPolicyApproval(view: WorkSessionViewState, approval: PolicyApprovalView): HTMLElement {
  const item = element("div", { className: "approval-card" });
  const title = element("div", { className: "approval-title", text: approval.tool });
  const detail = element("div", {
    className: "approval-detail",
    text: approval.command ?? approval.path ?? approval.matchedPattern ?? approval.approvalKey ?? approval.approvalId,
  });
  const buttons = element("div", { className: "feedback-buttons" });
  const options = approval.options?.length
    ? approval.options
    : [
      { id: "approve", label: "Approve Once", effect: "approve" as const, scope: "once" as const },
      { id: "approve_session", label: "Approve Session", effect: "approve" as const, scope: "work_session" as const },
      { id: "deny", label: "Deny", effect: "deny" as const },
  ];
  const makeButton = (option: NonNullable<PolicyApprovalView["options"]>[number]): HTMLButtonElement => {
    const cls = option.effect === "deny" ? "reject" : option.effect === "changes_requested" ? "changes" : "approve";
    const btn = element("button", { className: `feedback-btn ${cls}`, type: "button", text: option.label });
    if (approval.uiState === "submitting") btn.setAttribute("disabled", "true");
    btn.addEventListener("click", () => {
      void submitPolicyApproval(view, approval.approvalId, option.id);
    });
    return btn;
  };
  buttons.append(...options.map(makeButton));
  item.append(title, detail, buttons);
  if (approval.error) item.append(element("div", { className: "feedback-error", text: approval.error }));
  return item;
}

async function submitPolicyApproval(
  view: WorkSessionViewState,
  approvalId: string,
  decision: string,
): Promise<void> {
  if (!app) return;
  const approval = view.policyApprovals.get(approvalId);
  if (approval) {
    approval.uiState = "submitting";
    approval.error = undefined;
  }
  render();
  try {
    await app.callServerTool({
      name: "provide_policy_approval",
      arguments: { approvalId, decision },
    });
    const latest = view.policyApprovals.get(approvalId);
    if (latest) latest.uiState = "resolved";
    view.policyApprovals.delete(approvalId);
  } catch (err) {
    const latest = view.policyApprovals.get(approvalId);
    if (latest) {
      latest.uiState = "error";
      latest.error = "Failed to submit approval: " + (err instanceof Error ? err.message : String(err));
    }
  }
  render();
}

function parsePolicyApprovalOptions(value: unknown): PolicyApprovalView["options"] {
  if (!Array.isArray(value)) return undefined;
  const options = value.flatMap((entry): NonNullable<PolicyApprovalView["options"]> => {
    if (!entry || typeof entry !== "object") return [];
    const obj = entry as Record<string, unknown>;
    if (typeof obj.id !== "string" || typeof obj.label !== "string") return [];
    if (obj.effect !== "approve" && obj.effect !== "deny" && obj.effect !== "changes_requested") return [];
    return [{
      id: obj.id,
      label: obj.label,
      effect: obj.effect,
      scope: obj.scope === "once" || obj.scope === "work_session" || obj.scope === "workspace" ? obj.scope : undefined,
    }];
  });
  return options.length ? options : undefined;
}

function renderChevron(isExpanded: boolean, visible: boolean): HTMLElement {
  const chevron = element("span", {
    className: visible ? `chevron ${isExpanded ? "expanded" : ""}` : "chevron",
    ariaHidden: "true",
  });
  if (visible) {
    chevron.innerHTML = iconSvg('<path d="m6 9 6 6 6-6" />');
  }
  return chevron;
}

function setPayloadLoading(container: HTMLElement, loading: boolean): void {
  const header = container.previousElementSibling;
  const chevron = header?.querySelector<HTMLElement>(".chevron");
  if (!chevron) return;
  chevron.classList.toggle("loading", loading);
  chevron.innerHTML = loading
    ? iconSvg('<circle cx="12" cy="12" r="8" />')
    : iconSvg('<path d="m6 9 6 6 6-6" />');
  const button = header instanceof HTMLButtonElement ? header : null;
  if (button) button.setAttribute("aria-busy", String(loading));
}

function workspacePayloadText(card: ToolResultCard): string {
  const agentsFiles = card.agentsFiles ?? [];
  const availableAgentsFiles = card.availableAgentsFiles ?? [];
  const skills = card.skills ?? [];
  const lines = [
    card.workspaceId ? `Workspace: ${card.workspaceId}` : undefined,
    card.root ? `Root: ${card.root}` : undefined,
    skills.length > 0
      ? `Skills: ${skills.map((skill) => skill.name ?? skill.path ?? "unnamed").join(", ")}`
      : "Skills: none",
    availableAgentsFiles.length > 0
      ? `Nested instructions: ${availableAgentsFiles.map((file) => file.path ?? "unknown").join(", ")}`
      : undefined,
    agentsFiles.length > 0
      ? `\n${formatAgentsFilesForPayload(agentsFiles)}`
      : "\nAGENTS.md: none loaded",
  ].filter((line): line is string => typeof line === "string");
  return lines.join("\n");
}

function formatAgentsFilesForPayload(
  agentsFiles: NonNullable<ToolResultCard["agentsFiles"]>,
): string {
  return agentsFiles
    .map((file) => {
      const path = file.path ?? "AGENTS.md";
      const content = file.content?.trim();
      return content ? `${path}\n\n${content}` : `${path}\n\nNo content loaded.`;
    })
    .join("\n\n");
}

function getPatchToolDisplay(card: ToolResultCard, label: string): ToolDisplay {
  const display = getPatchDisplayParts(card);
  return {
    icon: patchIcon(display.iconOperation),
    title: display.title,
    label,
    tone: display.tone,
  };
}

function patchIcon(operation: PatchOperation | undefined): string {
  if (operation === "add") return filePlusIcon();
  if (operation === "delete") return fileIcon();
  if (operation === "move") return filesIcon();
  return editIcon();
}

function getToolDisplay(card: ToolResultCard): ToolDisplay {
  const label = getToolLabel(card);
  switch (card.tool) {
    case "open_workspace":
      return { icon: folderIcon(), title: "Workspace", label, tone: "workspace" };
    case "read":
      return { icon: fileIcon(), title: "Read File", label, tone: "read" };
    case "write":
      return { icon: filePlusIcon(), title: "Write File", label, tone: "write" };
    case "edit":
      return { icon: editIcon(), title: "Edit File", label, tone: "edit" };
    case "apply_patch":
      return getPatchToolDisplay(card, label);
    case "grep":
      return { icon: searchIcon(), title: "Grep", label, tone: "search" };
    case "glob":
      return { icon: filesIcon(), title: "Glob", label, tone: "search" };
    case "ls":
      return { icon: listIcon(), title: "List Directory", label, tone: "directory" };
    case "bash":
      return { icon: terminalIcon(), title: "Bash", label, tone: "shell" };
    case "exec_command":
      return { icon: terminalIcon(), title: "Exec Command", label, tone: "shell" };
    case "write_stdin":
      return { icon: terminalIcon(), title: "Process Session", label, tone: "shell" };
    case "show_changes":
      return { icon: reviewIcon(), title: "Show Changes", label, tone: "review" };
    case "submit_for_review":
      return { icon: reviewIcon(), title: "Review Submission", label, tone: "review" };
    case "submit_to_coding_agent":
      return { icon: agentIcon(), title: "Coding Agent", label, tone: "agent" };
    case "open_approval_center":
      return { icon: reviewIcon(), title: "Approval Center", label, tone: "agent" };
  }
}

function getToolLabel(card: ToolResultCard): string {
  if (isShellTool(card.tool)) {
    return String(card.summary?.command ?? card.summary?.sessionId ?? card.path ?? card.tool);
  }
  if (isReviewTool(card.tool)) {
    const count = Number(card.summary?.files ?? card.files?.length ?? 0);
    return count === 0 ? "No changes since last review" : `${count} changed ${count === 1 ? "file" : "files"}`;
  }
  if (card.path) return card.path;
  if (card.root) return card.root;
  if (isSearchTool(card.tool)) {
    return String(card.summary?.pattern ?? card.tool);
  }
  return card.tool;
}

function toolNameFromMeta(result: CallToolResult): ToolName | undefined {
  const meta = result._meta as Record<string, unknown> | undefined;
  const tool = meta?.tool;
  return isToolName(tool) ? tool : undefined;
}

function cardFromMeta(result: CallToolResult): Partial<ToolResultCard> | undefined {
  const meta = result._meta as Record<string, unknown> | undefined;
  const metaCard = meta?.card;
  return metaCard && typeof metaCard === "object" ? metaCard : undefined;
}

function getStructuredContent<T>(result: CallToolResult): T | undefined {
  return result.structuredContent as T | undefined;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: {
    className?: string;
    text?: string;
    type?: string;
    title?: string;
    ariaHidden?: string;
    ariaExpanded?: string;
    disabled?: boolean;
  } = {},
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (options.className) node.className = options.className;
  if (options.text !== undefined) node.textContent = options.text;
  if (options.type !== undefined && "type" in node) node.setAttribute("type", options.type);
  if (options.title !== undefined) node.title = options.title;
  if (options.ariaHidden !== undefined) node.setAttribute("aria-hidden", options.ariaHidden);
  if (options.ariaExpanded !== undefined) node.setAttribute("aria-expanded", options.ariaExpanded);
  if (options.disabled !== undefined && "disabled" in node) {
    (node as HTMLButtonElement).disabled = options.disabled;
  }
  return node;
}

function iconSvg(children: string): string {
  return `<svg aria-hidden="true" class="icon-svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8">${children}</svg>`;
}

function folderIcon(): string {
  return iconSvg('<path d="M3 7.5h6l2 2h10" /><path d="M3 7.5v10A2.5 2.5 0 0 0 5.5 20h13a2.5 2.5 0 0 0 2.5-2.5v-8H3" />');
}
function fileIcon(): string {
  return iconSvg('<path d="M14 3v5h5" /><path d="M6 3h8l5 5v13H6z" /><path d="M9 13h6" /><path d="M9 17h4" />');
}
function filePlusIcon(): string {
  return iconSvg('<path d="M14 3v5h5" /><path d="M6 3h8l5 5v13H6z" /><path d="M12 12v6" /><path d="M9 15h6" />');
}
function editIcon(): string {
  return iconSvg('<path d="M4 20h4l11-11a2.8 2.8 0 0 0-4-4L4 16z" /><path d="m13.5 6.5 4 4" />');
}
function searchIcon(): string {
  return iconSvg('<circle cx="11" cy="11" r="6" /><path d="m16 16 4 4" />');
}
function filesIcon(): string {
  return iconSvg('<path d="M8 7V4h9l4 4v10h-3" /><path d="M12 4v5h5" /><path d="M4 7h9l4 4v10H4z" /><path d="M13 7v5h4" />');
}
function checkCircleIcon(): string {
  return '<svg aria-hidden="true" class="badge-icon" fill="none" viewBox="0 0 16 16" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><circle cx="8" cy="8" r="6" /><path d="m5.5 8 1.7 1.7 3.4-3.5" /></svg>';
}
function listIcon(): string {
  return iconSvg('<path d="M8 6h12" /><path d="M8 12h12" /><path d="M8 18h12" /><path d="M4 6h.01" /><path d="M4 12h.01" /><path d="M4 18h.01" />');
}
function terminalIcon(): string {
  return iconSvg('<path d="m5 7 5 5-5 5" /><path d="M12 17h7" />');
}
function agentIcon(): string {
  return iconSvg('<circle cx="12" cy="8" r="3.2" /><path d="M5 20a7 7 0 0 1 14 0" />');
}
function reviewIcon(): string {
  return iconSvg('<path d="M5 4h14v16H5z" /><path d="M8 8h8" /><path d="M8 12h5" /><path d="M8 16h7" />');
}
