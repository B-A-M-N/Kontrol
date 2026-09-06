/**
 * Supervised-mission surfaces: the mission packet panel, its correction
 * form, and the pure activity-event label formatter. Extracted verbatim
 * from ui/workspace-app.tsx (P1.4); mutable app state is reached through
 * the same explicit host binding pattern as review-feedback.ts.
 */
import { element, stableDomId } from "./ui-dom.js";
import { humanizeStatus } from "./ui-format.js";
import type {
  AgentActivityEvent,
  MissionPacketView,
  WorkSessionViewState,
} from "./session-view-types.js";
import type { App } from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { getStructuredContent } from "./server-tool-call.js";

export interface MissionHost {
  scheduleRender(): void;
  newClientMutationId(): string;
  getApp(): App | null;
  callServerToolChecked(request: { name: string; arguments: Record<string, unknown> }): Promise<CallToolResult>;
  refreshMission(view: WorkSessionViewState): Promise<void>;
}

let host: MissionHost;
export function setMissionHost(next: MissionHost): void {
  host = next;
}

export function renderMissionPanel(view: WorkSessionViewState): HTMLElement {
  const packet = view.mission!;
  const panel = element("section", { className: "approval-card" });
  panel.append(element("div", { className: "approval-title", text: "Supervised mission" }));
  panel.append(element("div", { className: "approval-detail", text: packet.mission?.objective ?? "Mission contract" }));
  if (packet.supervisor) {
    const run = packet.supervisor;
    panel.append(element("div", { className: "approval-detail", text: `Supervisor: ${humanizeStatus(run.status)} · cycle ${run.cycleNumber}/${run.maxCycles} · ${humanizeStatus(run.autonomyMode)} · ${humanizeStatus(run.approvalMode)}${run.repeatedFailureCount ? ` · repeated failure ${run.repeatedFailureCount}` : ""}` }));
    let progress: { blockingFindingCount?: number; failedCriterionCount?: number; passedCriterionCount?: number; failingVerificationCount?: number; unresolvedRequiredActions?: number } | undefined;
    if (run.progressJson) {
      try { progress = JSON.parse(run.progressJson) as typeof progress; } catch { /* tolerate an older/corrupt projection */ }
    }
    if (progress) {
      const requiredTotal = (progress.failedCriterionCount ?? 0) + (progress.passedCriterionCount ?? 0);
      const criteriaText = requiredTotal > 0 ? `${progress.passedCriterionCount ?? 0}/${requiredTotal} criteria passing` : "criteria pending";
      const repeatedText = run.repeatedFailureFingerprintLimit
        ? ` · repeated failure ${run.repeatedFailureCount ?? 0}/${run.repeatedFailureFingerprintLimit}`
        : "";
      panel.append(element("div", { className: "approval-detail", text: `Convergence: ${progress.blockingFindingCount ?? 0} blockers · ${criteriaText} · ${progress.failingVerificationCount ?? 0} verification failures · ${progress.unresolvedRequiredActions ?? 0} required actions${repeatedText}` }));
    }
    if (run.stallReason) panel.append(element("div", { className: "feedback-error", text: `Supervision paused: ${run.stallReason}` }));
    if (run.updatedAt) panel.append(element("div", { className: "approval-detail", text: `Last supervisor progress: ${new Date(run.updatedAt).toLocaleString()}` }));
    if (run.deadlineAt) panel.append(element("div", { className: "approval-detail", text: `Autonomous deadline: ${new Date(run.deadlineAt).toLocaleString()}` }));
    if (run.lastError) panel.append(element("div", { className: "feedback-error", text: `Supervisor error: ${run.lastError}` }));
    const control = element("button", { className: "feedback-btn changes", type: "button", text: run.status === "paused" ? "Resume supervisor" : "Pause supervisor" });
    control.addEventListener("click", () => {
      if (!host.getApp()) return;
      control.setAttribute("disabled", "true");
      void host.callServerToolChecked({ name: run.status === "paused" ? "resume_supervisor_run" : "pause_supervisor_run", arguments: { workSessionId: view.workSessionId, expectedRevision: run.revision, clientMutationId: host.newClientMutationId() } })
        .then(() => host.refreshMission(view))
        .catch((error) => { view.notice = { tone: "error", message: `Supervisor control failed: ${error instanceof Error ? error.message : String(error)}` }; host.scheduleRender(); });
    });
    panel.append(control);
    if (run.status === "awaiting_human") {
      const redrive = element("button", { className: "feedback-btn changes", type: "button", text: "Redrive stalled supervisor action" });
      redrive.addEventListener("click", () => {
        if (!host.getApp()) return;
        redrive.setAttribute("disabled", "true");
        void host.callServerToolChecked({ name: "redrive_supervisor_run", arguments: { workSessionId: view.workSessionId, expectedRevision: run.revision, clientMutationId: host.newClientMutationId() } })
          .then(() => host.refreshMission(view))
          .catch((error) => { view.notice = { tone: "error", message: `Supervisor redrive failed: ${error instanceof Error ? error.message : String(error)}` }; host.scheduleRender(); });
      });
      panel.append(redrive);
    }
  }
  const progress = packet.criteria.map((criterion) => `${criterion.status === "verified" ? "✓" : "○"} ${criterion.description} — ${humanizeStatus(criterion.status)}${criterion.dependsOnCriterionIds?.length ? ` · depends on ${criterion.dependsOnCriterionIds.join(", ")}` : ""}`);
  for (const item of progress) panel.append(element("div", { className: "approval-detail", text: item }));
  const blockers = packet.approval.reasons;
  if (blockers.length) {
    panel.append(element("div", { className: "feedback-error", text: `Mission approval blocked: ${blockers.join("; ")}` }));
  } else {
    panel.append(element("div", { className: "feedback-submitted", text: "Mission evidence is complete and approval is available." }));
  }
  const openFindings = packet.findings.filter((finding) => !["verified_resolved", "waived"].includes(finding.status));
  for (const finding of openFindings) {
    panel.append(element("div", { className: "approval-detail", text: `${humanizeStatus(finding.severity)} · ${humanizeStatus(finding.scope)}: ${finding.description}` }));
  }
  for (const report of packet.completionReports ?? []) {
    panel.append(element("div", { className: report.status === "passed" ? "approval-detail" : "feedback-error", text: `Final integration: ${report.status} · report ${report.reportSha256.slice(0, 12)}` }));
  }
  const refresh = element("button", { className: "feedback-btn changes", type: "button", text: "Refresh mission" });
  refresh.addEventListener("click", () => { void host.refreshMission(view); });
  panel.append(refresh);
  if (packet.criteria.some((criterion) => criterion.verificationCommand)) {
    const verify = element("button", { className: "feedback-btn approve", type: "button", text: "Run declared verification" });
    verify.addEventListener("click", () => {
      if (!host.getApp()) return;
      verify.setAttribute("disabled", "true");
      void host.callServerToolChecked({ name: "run_mission_verification", arguments: { workSessionId: view.workSessionId, clientMutationId: host.newClientMutationId() } })
        .then(() => host.refreshMission(view))
        .catch((error) => { view.notice = { tone: "error", message: `Verification failed: ${error instanceof Error ? error.message : String(error)}` }; host.scheduleRender(); });
    });
    panel.append(verify);
  }
  if (view.activeSubmissionId && !packet.approval.allowed) panel.append(renderMissionCorrectionForm(view));
  return panel;
}


export function renderMissionCorrectionForm(view: WorkSessionViewState): HTMLElement {
  const packet = view.mission!;
  const form = element("div", { className: "feedback-form" });
  const instructionsId = stableDomId(`mission-instructions-${view.workSessionId}`);
  const findingId = stableDomId(`mission-finding-${view.workSessionId}`);
  form.append(element("label", { className: "feedback-label", text: "Next bounded work order", htmlFor: instructionsId }));
  const instructions = document.createElement("textarea");
  instructions.className = "feedback-textarea";
  instructions.id = instructionsId;
  instructions.dataset.focusKey = `mission-instructions:${view.workSessionId}`;
  instructions.rows = 3;
  instructions.placeholder = "State the exact corrective work and required verification.";
  const finding = document.createElement("textarea");
  finding.className = "feedback-textarea";
  finding.id = findingId;
  finding.dataset.focusKey = `mission-finding:${view.workSessionId}`;
  finding.rows = 2;
  finding.placeholder = "Optional new blocking finding (recorded durably).";
  form.append(instructions, finding);
  const selectedCriteria = packet.criteria.filter((criterion) => criterion.priority === "required" && criterion.status !== "verified");
  if (selectedCriteria.length) form.append(element("div", { className: "approval-detail", text: `Targets: ${selectedCriteria.map((criterion) => criterion.description).join("; ")}` }));
  const submit = element("button", { className: "feedback-btn changes", type: "button", text: "Dispatch correction round" });
  submit.addEventListener("click", () => {
    const comments = instructions.value.trim();
    if (!comments || !host.getApp()) return;
    submit.setAttribute("disabled", "true");
    void host.callServerToolChecked({
      name: "continue_supervised_work",
      arguments: {
        workSessionId: view.workSessionId,
        comments,
        findings: finding.value.trim() ? [{
          description: finding.value.trim(), requiredAction: comments, severity: "blocker", scope: "in_scope",
        }] : undefined,
        workOrder: {
          objectiveForThisTurn: comments,
          acceptanceCriterionIds: selectedCriteria.map((criterion) => criterion.id),
          requiredActions: [comments],
          requiredVerification: selectedCriteria.map((criterion) => criterion.verificationCommand).filter(Boolean),
        },
        clientMutationId: host.newClientMutationId(),
      },
    }).then((result) => {
      const content = getStructuredContent<{ packet?: MissionPacketView }>(result);
      if (content?.packet) view.mission = content.packet;
      view.notice = { tone: "success", message: "Correction round queued." };
      host.scheduleRender();
    }).catch((error) => {
      view.notice = { tone: "error", message: `Correction dispatch failed: ${error instanceof Error ? error.message : String(error)}` };
      host.scheduleRender();
    });
  });
  form.append(submit);
  return form;
}


export function eventLabel(e: AgentActivityEvent): string {
  switch (e.type) {
    case "agent.run.started": return "run started";
    case "agent.run.output_delta": return String(e.payload?.text ?? "output").slice(-160);
    case "agent.run.thought_delta": return `thought: ${String(e.payload?.text ?? "").slice(-120)}`;
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
    case "agent.run.cancellation_requested": return "cancellation requested";
    case "agent.run.cancelled": return "cancelled";
    case "continuation.created": return "continuation queued";
    case "continuation.delivered": return "continuation delivered";
    case "agent.message.posted": {
      const kind = String(e.payload?.kind ?? "message");
      const title = e.payload?.title ? `: ${String(e.payload.title)}` : "";
      return `${kind.replace(/_/g, " ")}${title}`;
    }
    case "agent.message.resolved": return "message resolved";
    case "session.handoff": return `handed off → ${String(e.payload?.toAgent ?? "agent")}`;
    case "policy.approval_requested": return `approval needed: ${String(e.payload?.tool ?? "tool")}`;
    case "policy.approval.provided":
    case "approval.resolved":
      return "approval resolved";
    default: return e.type;
  }
}

// ── Event-driven watcher (replaces the 2.5s poll) ──


