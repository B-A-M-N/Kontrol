import { createHash, randomUUID } from "node:crypto";
import type { DispatchOutbox } from "./dispatch-outbox.js";
import type { EventStore } from "./event-log.js";
import type { SupervisorDecision } from "./supervisor-evaluator.js";
import type { SupervisorRuns } from "./supervisor-runs.js";

export interface SupervisorRuntime {
  start(): void;
  stop(): void;
  drainOnce(): Promise<void>;
  wake(workSessionId: string): void;
}

type Evaluation = { decision: SupervisorDecision; reasons: string[] };
const TERMINAL_OR_PAUSED = new Set(["completed", "failed", "cancelled", "awaiting_human", "paused"]);

/**
 * Leased, outbox-driven kernel for autonomous supervision. Every outbox item
 * advances at most one durable state transition; subscriptions only accelerate
 * delivery and are never the source of recovery truth.
 */
export function createSupervisorRuntime(input: {
  outbox: DispatchOutbox;
  events: EventStore;
  runs: SupervisorRuns;
  onVerify: (workSessionId: string, deadlineAt?: string | null, submission?: { id: string; snapshotCommit?: string; reviewEpoch?: number }) => Promise<void>;
  onEvaluate: (workSessionId: string) => Promise<Evaluation>;
  onCorrect: (workSessionId: string, reasons: string[]) => Promise<void>;
  onApprove: (workSessionId: string) => Promise<void>;
  currentSubmission: (workSessionId: string) => { id: string; snapshotCommit?: string; reviewEpoch?: number } | undefined;
  currentSessionStatus: (workSessionId: string) => string | undefined;
  currentApproval: (workSessionId: string) => { allowed: boolean; reasons: string[] };
}): SupervisorRuntime {
  const instanceId = `supervisor-${randomUUID()}`;
  const leaseMs = 30_000;
  const RENEW_EVERY_MS = 10_000;
  let activeRenewal: { workSessionId: string; runId: string; leaseNonce: string; timer: ReturnType<typeof setInterval> } | undefined;

  function renewActiveLeases(): void {
    if (!activeRenewal) return;
    input.runs.renew(activeRenewal.runId, instanceId, activeRenewal.leaseNonce, leaseMs);
  }

  function startLeaseHeartbeat(workSessionId: string, runId: string, leaseNonce: string): void {
    stopLeaseHeartbeat();
    activeRenewal = { workSessionId, runId, leaseNonce, timer: setInterval(renewActiveLeases, RENEW_EVERY_MS) };
  }

  function stopLeaseHeartbeat(): void {
    if (activeRenewal) {
      clearInterval(activeRenewal.timer);
      activeRenewal = undefined;
    }
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe: (() => void) | undefined;
  let stopped = true;

  const schedule = () => {
    if (!stopped) {
      // P1 #17: Use a slow maintenance sweep (5s) instead of 250ms polling.
      // Event-driven wakes via `wake()` handle immediate processing.
      timer = setTimeout(() => void drainOnce().finally(schedule), 5_000);
    }
  };

  let wakeResolver: (() => void) | null = null;

  function wake(workSessionId: string): void {
    enqueueCurrentAction(input.runs.getByWorkSession(workSessionId));
    // Immediately drain if we're idle
    if (wakeResolver) {
      wakeResolver();
      wakeResolver = null;
    } else {
      // Kick off an immediate drain
      void drainOnce();
    }
  }

  function enqueueVerification(workSessionId: string, eventSeq?: number): void {
    const run = input.runs.getByWorkSession(workSessionId);
    if (!run || run.autonomyMode === "manual" || TERMINAL_OR_PAUSED.has(run.status)) return;
    if (isExpired(run.deadlineAt)) { requireHuman(workSessionId, "Supervisor wall-clock deadline reached.", eventSeq); return; }
    let pending = run;
    if (run.status !== "verification_pending") {
      // A submission is actionable only after a worker turn. Do not turn an
      // arbitrary state into verification merely because a stale event arrived.
      if (run.status !== "worker_active" && run.status !== "awaiting_submission") return;
      const transitioned = input.runs.transition({
        id: run.id,
        expectedStatus: run.status,
        expectedRevision: run.revision,
        nextStatus: "verification_pending",
        lastProcessedEventSeq: eventSeq,
        lastSubmissionId: input.currentSubmission(workSessionId)?.id,
        lastSnapshotCommit: input.currentSubmission(workSessionId)?.snapshotCommit,
      });
      if (!transitioned) return;
      pending = transitioned;
    }
    if (!input.outbox.hasActive("supervisor.verification.requested", pending.id)) {
      input.outbox.enqueue({
        eventType: "supervisor.verification.requested",
        aggregateId: pending.id,
        aggregateRevision: pending.revision,
        payload: { workSessionId },
      });
    }
  }

  function enqueueAction(eventType: "supervisor.correction.requested" | "supervisor.approval.requested", runId: string, revision: number, workSessionId: string, reasons: string[] = []): void {
    if (!input.outbox.hasActive(eventType, runId)) input.outbox.enqueue({ eventType, aggregateId: runId, aggregateRevision: revision, payload: { workSessionId, reasons } });
  }

  /**
   * Recreate only the durable next action implied by a run's current state.
   * This is used both after process restart and after an operator resumes a
   * paused run; neither path may depend on a transient event subscription.
   */
  function enqueueCurrentAction(run: ReturnType<typeof input.runs.getByWorkSession>): void {
    if (!run || TERMINAL_OR_PAUSED.has(run.status)) return;
    if (run.status === "verification_pending" || ((run.status === "worker_active" || run.status === "awaiting_submission") && input.currentSubmission(run.workSessionId))) {
      enqueueVerification(run.workSessionId);
      return;
    }
    if (run.status === "correction_pending" && ["correction_auto", "full"].includes(run.autonomyMode)) {
      enqueueAction("supervisor.correction.requested", run.id, run.revision, run.workSessionId);
      return;
    }
    if (run.status === "approval_pending" && run.approvalMode !== "human_required") {
      // P1 #27: policy_auto requires the mission ledger to authorize the
      // approval. fully_automatic lets the evidence predicate alone decide.
      if (run.approvalMode === "policy_auto") {
        const approval = input.currentApproval(run.workSessionId);
        if (!approval.allowed) {
          enqueueAction("supervisor.correction.requested", run.id, run.revision, run.workSessionId, approval.reasons);
          return;
        }
      }
      enqueueAction("supervisor.approval.requested", run.id, run.revision, run.workSessionId);
    }
  }

  function requireHuman(workSessionId: string, reason: string, eventSeq?: number): void {
    transitionNonterminalToAwaitingHuman(workSessionId, reason, eventSeq);
  }

  /** P1 #16: Transition any non-terminal supervisor status to awaiting_human. */
  function transitionNonterminalToAwaitingHuman(workSessionId: string, reason: string, eventSeq?: number): boolean {
    const run = input.runs.getByWorkSession(workSessionId);
    if (!run) return false;
    if (TERMINAL_OR_PAUSED.has(run.status)) return false;
    const transitioned = input.runs.transition({
      id: run.id,
      expectedStatus: run.status,
      expectedRevision: run.revision,
      nextStatus: "awaiting_human",
      lastProcessedEventSeq: eventSeq,
      lastError: reason,
    });
    return Boolean(transitioned);
  }

  function isExpired(deadlineAt: string | null | undefined): boolean {
    return Boolean(deadlineAt && Date.parse(deadlineAt) <= Date.now());
  }

  async function drainOnce(): Promise<void> {
    input.outbox.reapExpiredClaims(leaseMs);
    input.runs.releaseExpiredClaims();
    const event = input.outbox.claimNext(instanceId, leaseMs, ["supervisor.verification.requested", "supervisor.correction.requested", "supervisor.approval.requested"]);
    if (!event) return;
    const workSessionId = typeof event.payload.workSessionId === "string" ? event.payload.workSessionId : "";
    const current = input.runs.getByWorkSession(workSessionId);
    const expectedStatus = event.eventType === "supervisor.verification.requested" ? "verification_pending" : event.eventType === "supervisor.correction.requested" ? "correction_pending" : "approval_pending";
    if (!current || current.id !== event.aggregateId || current.status !== expectedStatus) {
      input.outbox.markCompleted(event.id);
      return;
    }
    if (isExpired(current.deadlineAt)) {
      const transitioned = transitionNonterminalToAwaitingHuman(workSessionId, "Supervisor wall-clock deadline reached.");
      if (transitioned) {
        input.outbox.markCompleted(event.id);
      } else {
        // CAS lost — reload state and re-evaluate
        input.outbox.release(event.id, 250, "Deadline transition CAS failed, retrying");
        return;
      }
      return;
    }
    const claimed = input.runs.claim(current.id, instanceId, leaseMs);
    if (!claimed) {
      input.outbox.release(event.id, 250, "Supervisor run is leased by another instance.");
      return;
    }
    const leaseNonce = claimed.leaseNonce;
    if (!leaseNonce) {
      input.outbox.release(event.id, 250, "Supervisor lease has no fencing nonce.");
      return;
    }
    const lease = { ownerInstanceId: instanceId, leaseNonce };
    try {
      startLeaseHeartbeat(workSessionId, claimed.id, leaseNonce);
      if (event.eventType === "supervisor.correction.requested") {
        const reasons = Array.isArray(event.payload.reasons) ? event.payload.reasons.filter((value): value is string => typeof value === "string") : [];
        await input.onCorrect(workSessionId, reasons);
        const resumed = input.runs.transition({ id: claimed.id, expectedStatus: "correction_pending", expectedRevision: claimed.revision, nextStatus: "worker_active", cycleNumber: claimed.cycleNumber + 1, lease });
        if (!resumed) throw new Error("Supervisor state changed before correction dispatch.");
        input.outbox.markCompleted(event.id);
        return;
      }
      if (event.eventType === "supervisor.approval.requested") {
        await input.onApprove(workSessionId);
        const completed = input.runs.transition({ id: claimed.id, expectedStatus: "approval_pending", expectedRevision: claimed.revision, nextStatus: "completed", lease });
        if (!completed) throw new Error("Supervisor state changed before automatic approval.");
        input.outbox.markCompleted(event.id);
        return;
      }
      const verifying = input.runs.transition({
        id: claimed.id,
        expectedStatus: "verification_pending",
        expectedRevision: claimed.revision,
        nextStatus: "verifying",
        lease,
      });
      if (!verifying) {
        input.outbox.release(event.id, 250, "Supervisor state changed before verification.");
        return;
      }
      await input.onVerify(workSessionId, verifying.deadlineAt, input.currentSubmission(workSessionId));
      const evaluating = input.runs.transition({
        id: verifying.id,
        expectedStatus: "verifying",
        expectedRevision: verifying.revision,
        nextStatus: "evaluation_pending",
        lease,
      });
      if (!evaluating) throw new Error("Supervisor state changed before evaluation.");
      let evaluation = await input.onEvaluate(workSessionId);
      if (evaluation.decision === "correction_pending") {
        const fingerprint = createHash("sha256").update(evaluation.reasons.map((reason) => reason.replace(/\s+/g, " ").trim()).sort().join("\n")).digest("hex");
        const repeats = input.runs.noteFailureFingerprint(claimed.id, instanceId, fingerprint, leaseNonce);
        if (repeats >= 3) {
          evaluation = { decision: "awaiting_human", reasons: [`Repeated verification failure fingerprint (${repeats} consecutive cycles).`, ...evaluation.reasons] };
        }
      }
      const decided = input.runs.transition({
        id: evaluating.id,
        expectedStatus: "evaluation_pending",
        expectedRevision: evaluating.revision,
        nextStatus: evaluation.decision,
        lease,
      });
      if (!decided) throw new Error("Supervisor state changed before decision.");
      if (decided.status === "correction_pending" && ["correction_auto", "full"].includes(decided.autonomyMode)) {
        enqueueAction("supervisor.correction.requested", decided.id, decided.revision, workSessionId, evaluation.reasons);
      }
      if (decided.status === "approval_pending" && decided.approvalMode !== "human_required") {
        enqueueAction("supervisor.approval.requested", decided.id, decided.revision, workSessionId);
      }
      input.outbox.markCompleted(event.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      input.runs.noteFailure(claimed.id, instanceId, message, leaseNonce);
      input.outbox.markFailed(event.id, message, 1_000);
      if (input.outbox.get(event.id)?.status === "dead_lettered") {
        const stalled = input.runs.getByWorkSession(workSessionId);
        if (stalled && !["completed", "failed", "cancelled", "awaiting_human"].includes(stalled.status)) {
          input.runs.transition({ id: stalled.id, expectedStatus: stalled.status, expectedRevision: stalled.revision, nextStatus: "awaiting_human", lastError: `Supervisor event dead-lettered: ${message}`, lease });
        }
      }
    } finally {
      stopLeaseHeartbeat();
      input.runs.release(claimed.id, instanceId, leaseNonce);
    }
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      input.runs.releaseExpiredClaims();
      unsubscribe = input.events.subscribeAll((event) => {
        if (event.type === "review.submitted") enqueueVerification(event.sessionId, event.seq);
        if (["agent.run.failed", "agent.run.failed_protocol", "agent.run.cancelled", "worker.attempt.exited"].includes(event.type)) {
          requireHuman(event.sessionId, `Worker lifecycle event requires intervention: ${event.type}`, event.seq);
        }
        if (event.type === "agent.message.posted" && ["clarification_request", "blocker"].includes(String(event.payload.kind ?? ""))) {
          requireHuman(event.sessionId, `Worker ${String(event.payload.kind)} requires reviewer input.`, event.seq);
        }
      });
      for (const run of input.runs.listRecoverable()) {
        const sessionStatus = input.currentSessionStatus(run.workSessionId);
        const terminalStatus = sessionStatus === "approved" ? "completed" : sessionStatus === "cancelled" ? "cancelled" : ["rejected", "failed", "failed_protocol"].includes(sessionStatus ?? "") ? "failed" : undefined;
        if (terminalStatus) {
          input.runs.transition({ id: run.id, expectedStatus: run.status, expectedRevision: run.revision, nextStatus: terminalStatus, lastError: `Recovered terminal work-session status: ${sessionStatus}` });
          continue;
        }
        enqueueCurrentAction(run);
      }
      schedule();
    },
    stop() {
      stopped = true;
      stopLeaseHeartbeat();
      if (timer) clearTimeout(timer);
      unsubscribe?.();
      unsubscribe = undefined;
    },
    drainOnce,
    wake(workSessionId) {
      enqueueCurrentAction(input.runs.getByWorkSession(workSessionId));
    },
  };
}
