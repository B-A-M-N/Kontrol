import { element } from "./ui-dom.js";

export interface PeerStatusJob {
  jobId?: string;
  peerId?: string;
  workspaceSessionId?: string;
  workSessionId?: string;
  taskClass?: string;
  repositoryId?: string;
  status?: string;
  createdAt?: string;
  cancelRequestedAt?: string;
  displayHint?: string;
  actorClass?: string;
  outcomeCertainty?: string;
  terminalReason?: string;
  submissionId?: string;
  reviewEpoch?: number;
  snapshotKind?: string;
  snapshotRef?: string;
  resultProcessingFailure?: string;
  verificationStatus?: string;
  verificationEvidenceSha256?: string;
  reviewVerdict?: string;
}

export interface PeerStatusProjection {
  [key: string]: unknown;
  peer?: { enabled?: boolean; bindHost?: string; port?: number };
  peers?: Array<{ id?: string; capabilities?: string[] }>;
  jobs?: PeerStatusJob[];
  counts?: Record<string, number>;
  notes?: string[];
  nextCursor?: string;
}

export interface PeerStatusPanelActions {
  previousAvailable: boolean;
  loading?: boolean;
  reconcilingJobId?: string | null;
  cancellingJobId?: string | null;
  error?: string | null;
  next(cursor: string): void;
  previous(): void;
  reconcile(jobId: string, expectedFailure: string): void;
  cancel(jobId: string): void;
}

function detail(label: string, value: unknown): HTMLElement | null {
  if (value === undefined || value === null || value === "") return null;
  const row = element("div", { className: "peer-job-detail" });
  row.append(
    element("span", { className: "peer-job-detail-label", text: label }),
    element("span", { className: "peer-job-detail-value", text: String(value) }),
  );
  return row;
}

export function renderPeerStatusPanel(
  projection: PeerStatusProjection,
  actions: PeerStatusPanelActions,
): HTMLElement {
  const main = element("main", { className: "shell" });
  const panel = element("section", { className: "tool-card agent peer-status-panel", ariaLabel: "Peer job status" });
  const listener = projection.peer ?? {};
  const heading = element("header", { className: "peer-status-heading" });
  const headingText = element("div");
  headingText.append(
    element("h2", { className: "peer-status-title", text: "Peer jobs" }),
    element("p", {
      className: "peer-status-listener",
      text: listener.enabled
        ? `Listener enabled${listener.bindHost ? ` · ${listener.bindHost}:${listener.port ?? "?"}` : ""}`
        : "Listener disabled",
    }),
  );
  const jobs = projection.jobs ?? [];
  heading.append(headingText, element("span", {
    className: "peer-status-page-count",
    text: `${jobs.length} job${jobs.length === 1 ? "" : "s"} on this page`,
  }));
  panel.append(heading);

  if (projection.peers?.length) {
    const peerList = element("div", { className: "peer-status-peers", ariaLabel: "Enrolled peers" });
    for (const peer of projection.peers) {
      const item = element("span", { className: "peer-status-peer", text: peer.id ?? "Unknown peer" });
      if (peer.capabilities?.length) item.title = `Capabilities: ${peer.capabilities.join(", ")}`;
      peerList.append(item);
    }
    panel.append(peerList);
  }

  if (jobs.length === 0) {
    panel.append(element("p", { className: "peer-status-empty", text: "No peer jobs on this page." }));
  } else {
    const list = element("ol", { className: "peer-job-list", ariaLabel: "Peer jobs" });
    for (const job of jobs) {
      const card = element("li", { className: "peer-job" });
      const top = element("div", { className: "peer-job-header" });
      top.append(
        element("strong", { className: "peer-job-id", text: job.jobId ?? "Unknown job" }),
        element("span", { className: `peer-job-status peer-job-status-${(job.status ?? "unknown").replace(/[^a-z0-9_-]/gi, "-")}`, text: job.status ?? "unknown" }),
      );
      card.append(top);
      if (job.displayHint) card.append(element("p", { className: "peer-job-hint", text: job.displayHint }));

      const details = element("div", { className: "peer-job-details" });
      for (const row of [
        detail("Peer", job.peerId),
        detail("Work session", job.workSessionId),
        detail("Workspace", job.workspaceSessionId),
        detail("Repository", job.repositoryId),
        detail("Task class", job.taskClass),
        detail("Created", job.createdAt ? new Date(job.createdAt).toLocaleString() : undefined),
        detail("Cancellation requested", job.cancelRequestedAt),
        detail("Reported actor", job.actorClass),
        detail("Outcome certainty", job.outcomeCertainty),
        detail("Submission", job.submissionId),
        detail("Review epoch", job.reviewEpoch),
        detail("Snapshot", job.snapshotRef ? `${job.snapshotKind ?? "snapshot"}:${job.snapshotRef}` : undefined),
        detail("Verification", job.verificationStatus),
        detail("Verification evidence", job.verificationEvidenceSha256),
        detail("Review verdict", job.reviewVerdict),
        detail("Terminal reason", job.terminalReason),
        detail("Processing issue", job.resultProcessingFailure),
      ]) if (row) details.append(row);
      if (details.childElementCount) card.append(details);
      if (job.status === "awaiting_reconciliation" && job.resultProcessingFailure) {
        const retry = element("button", {
          className: "peer-job-reconcile-button",
          type: "button",
          text: actions.reconcilingJobId === job.jobId ? "Queueing recovery…" : "Retry local result processing",
        }) as HTMLButtonElement;
        retry.disabled = Boolean(actions.loading || actions.reconcilingJobId);
        retry.addEventListener("click", () => actions.reconcile(job.jobId!, job.resultProcessingFailure!));
        card.append(retry);
      }
      if (["pending", "claimed", "running", "awaiting_reconciliation"].includes(job.status ?? "")) {
        if (job.cancelRequestedAt) {
          card.append(element("p", { className: "peer-job-cancel-pending", role: "status", text: "Cancellation requested; checkout remains fenced until peer shutdown is confirmed." }));
        } else {
          const cancel = element("button", {
            className: "peer-job-cancel-button",
            type: "button",
            text: actions.cancellingJobId === job.jobId ? "Requesting cancellation…" : "Cancel peer job",
          }) as HTMLButtonElement;
          cancel.disabled = Boolean(actions.loading || actions.cancellingJobId);
          cancel.addEventListener("click", () => actions.cancel(job.jobId!));
          card.append(cancel);
        }
      }
      list.append(card);
    }
    panel.append(list);
  }

  if (projection.notes?.length) {
    const note = projection.notes.find((value) => /muse_vm_process results are never evidence/i.test(value));
    if (note) panel.append(element("p", { className: "peer-status-note", text: note }));
  }

  const footer = element("footer", { className: "peer-status-pagination" });
  const previous = element("button", { className: "peer-status-page-button", type: "button", text: "Previous" }) as HTMLButtonElement;
  previous.disabled = !actions.previousAvailable || Boolean(actions.loading);
  previous.addEventListener("click", actions.previous);
  const next = element("button", { className: "peer-status-page-button", type: "button", text: actions.loading ? "Loading…" : "Next" }) as HTMLButtonElement;
  next.disabled = !projection.nextCursor || Boolean(actions.loading);
  if (projection.nextCursor) next.addEventListener("click", () => actions.next(projection.nextCursor!));
  footer.append(previous, next);
  if (actions.error) footer.append(element("span", { className: "peer-status-error", role: "status", text: actions.error }));
  panel.append(footer);
  main.append(panel);
  return main;
}
