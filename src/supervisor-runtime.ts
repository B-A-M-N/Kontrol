import { createHash, randomUUID } from "node:crypto";
import type { DispatchOutbox, DispatchOutboxEvent } from "./dispatch-outbox.js";
import type { EventStore } from "./event-log.js";
import type { SupervisorDecision } from "./supervisor-evaluator.js";
import type { SupervisorProgressSnapshot, SupervisorRuns } from "./supervisor-runs.js";

export interface SupervisorRuntime {
  start(): void;
  stop(): void;
  drainOnce(): Promise<void>;
  wake(workSessionId: string): void;
}

export type Evaluation = { decision: SupervisorDecision; reasons: string[]; failureSetSha256?: string; failureCount?: number };
const TERMINAL_OR_PAUSED = new Set(["completed", "failed", "cancelled", "awaiting_human", "paused"]);

export interface SupervisorTimingSample {
  workSessionId: string;
  eventType: string;
  eventCreatedAt: string;
  claimedAt: string;
  stage: "correction" | "approval" | "verification";
  eventToClaimMs: number;
  verificationMs?: number;
  evaluationMs?: number;
  totalMs: number;
}

/** Stable across evaluator ordering/whitespace so repeated failures converge. */
export function deterministicFailureFingerprint(evaluation: Evaluation): string {
  const reasons = [...new Set(evaluation.reasons
    .map((reason) => reason.replace(/\s+/g, " ").trim())
    .filter(Boolean))].sort();
  return createHash("sha256").update(JSON.stringify({ decision: evaluation.decision, reasons, failureSetSha256: evaluation.failureSetSha256 ?? null })).digest("hex");
}

/**
 * Leased, outbox-driven kernel for autonomous supervision. Every outbox item
 * advances at most one durable state transition; subscriptions only accelerate
 * delivery and are never the source of recovery truth.
 */
export function createSupervisorRuntime(input: {
  outbox: DispatchOutbox;
  events: EventStore;
  runs: SupervisorRuns;
  /** P1 #22: injected configuration (parsed once in config.ts). */
  maxInflight?: number;
  onVerify: (workSessionId: string, deadlineAt?: string | null, submission?: { id: string; snapshotCommit?: string; reviewEpoch?: number }) => Promise<void>;
  onEvaluate: (workSessionId: string) => Promise<Evaluation>;
  onCorrect: (workSessionId: string, reasons: string[]) => Promise<void>;
  onApprove: (workSessionId: string) => Promise<void>;
  currentSubmission: (workSessionId: string) => { id: string; snapshotCommit?: string; reviewEpoch?: number } | undefined;
  currentSessionStatus: (workSessionId: string) => string | undefined;
  currentApproval: (workSessionId: string) => { allowed: boolean; reasons: string[] };
  getProgressSnapshot?: (workSessionId: string, evaluation: Evaluation) => SupervisorProgressSnapshot | undefined;
  onTiming?: (sample: SupervisorTimingSample) => void;
}): SupervisorRuntime {
  const instanceId = `supervisor-${randomUUID()}`;
  const leaseMs = 30_000;
  const RENEW_EVERY_MS = 10_000;
  const activeRenewals = new Map<string, { workSessionId: string; runId: string; leaseNonce: string }>();

  function renewActiveLeases(): void {
    for (const active of activeRenewals.values()) input.runs.renew(active.runId, instanceId, active.leaseNonce, leaseMs);
  }

  // P1 #21: ONE shared renewal timer for all active leases. A per-run timer
  // whose callback renewed every lease produced N timers × N renewals.
  let renewalTimer: ReturnType<typeof setInterval> | undefined;
  function ensureRenewalTimer(): void {
    if (activeRenewals.size === 0) return;
    if (!renewalTimer) {
      renewalTimer = setInterval(renewActiveLeases, RENEW_EVERY_MS);
    }
  }
  function maybeStopRenewalTimer(): void {
    if (activeRenewals.size === 0 && renewalTimer) {
      clearInterval(renewalTimer);
      renewalTimer = undefined;
    }
  }

  function startLeaseHeartbeat(workSessionId: string, runId: string, leaseNonce: string): void {
    stopLeaseHeartbeat(runId);
    activeRenewals.set(runId, { workSessionId, runId, leaseNonce });
    ensureRenewalTimer();
  }

  function stopLeaseHeartbeat(runId?: string): void {
    if (runId) {
      activeRenewals.delete(runId);
      maybeStopRenewalTimer();
      return;
    }
    activeRenewals.clear();
    if (renewalTimer) {
      clearInterval(renewalTimer);
      renewalTimer = undefined;
    }
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe: (() => void) | undefined;
  let stopped = true;
  // P1 #22: use injected configuration; env parsing remains only as a
  // fallback for direct callers (tests, standalone scripts).
  const maxInflight = input.maxInflight ?? parsePositiveInteger(process.env.KONTROL_SUPERVISOR_MAX_INFLIGHT, 4);
  const inflightByWorkSession = new Map<string, Promise<void>>();

  const schedule = () => {
    if (!stopped) {
      // P1 #17: Use a slow maintenance sweep (5s) instead of 250ms polling.
      // Event-driven wakes via `wake()` handle immediate processing.
      timer = setTimeout(() => void drainOnce().finally(schedule), 5_000);
    }
  };

  function wake(workSessionId: string): void {
    enqueueCurrentAction(input.runs.getByWorkSession(workSessionId));
    // A drain pass only claims work; individual leased jobs run concurrently.
    // This wake is intentionally independent of any long-running verifier.
    void drainOnce();
  }

  function enqueueVerification(workSessionId: string, eventSeq?: number): void {
    const run = input.runs.getByWorkSession(workSessionId);
    if (!run || run.autonomyMode === "manual" || TERMINAL_OR_PAUSED.has(run.status)) return;
    if (isExpired(run.deadlineAt)) { requireHumanWithStall(workSessionId, "Supervisor wall-clock deadline reached.", "deadline_failsafe", eventSeq); return; }
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
    if (!input.outbox.hasActive(eventType, runId)) {
      const run = input.runs.getByWorkSession(workSessionId);
      input.outbox.enqueue({ eventType, aggregateId: runId, aggregateRevision: revision, availableAt: run?.nextActionAt ?? undefined, payload: { workSessionId, reasons } });
    }
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

  /** P1 #24: classify non-terminal escalations so remediation can be targeted. */
  function requireHumanWithStall(workSessionId: string, reason: string, stallReason: "deadline_failsafe" | "worker_no_activity" | "agent_unavailable" | "workspace_conflict" | "protocol_failure", eventSeq?: number): void {
    const run = input.runs.getByWorkSession(workSessionId);
    if (!run || TERMINAL_OR_PAUSED.has(run.status)) {
      requireHuman(workSessionId, reason, eventSeq);
      return;
    }
    const transitioned = input.runs.transition({
      id: run.id,
      expectedStatus: run.status,
      expectedRevision: run.revision,
      nextStatus: "awaiting_human",
      lastProcessedEventSeq: eventSeq,
      lastError: reason,
      stallReason,
    });
    if (!transitioned) requireHuman(workSessionId, reason, eventSeq);
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

  async function processEvent(event: DispatchOutboxEvent): Promise<void> {
    const workSessionId = typeof event.payload.workSessionId === "string" ? event.payload.workSessionId : "";
    const current = input.runs.getByWorkSession(workSessionId);
    const expectedStatus = event.eventType === "supervisor.verification.requested" ? "verification_pending" : event.eventType === "supervisor.correction.requested" ? "correction_pending" : "approval_pending";
    if (!current || current.id !== event.aggregateId || current.status !== expectedStatus) {
      input.outbox.markCompleted(event.id);
      return;
    }
    if (isExpired(current.deadlineAt)) {
      const transitioned = input.runs.transition({ id: current.id, expectedStatus: current.status, expectedRevision: current.revision, nextStatus: "awaiting_human", lastError: "Supervisor wall-clock deadline reached.", stallReason: "deadline_failsafe" });
      if (transitioned) input.outbox.markCompleted(event.id);
      else input.outbox.release(event.id, 250, "Deadline transition CAS failed, retrying");
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
    const timingStartedAt = performance.now();
    const timing: Omit<SupervisorTimingSample, "totalMs"> = {
      workSessionId,
      eventType: event.eventType,
      eventCreatedAt: event.createdAt,
      claimedAt: new Date().toISOString(),
      stage: event.eventType === "supervisor.correction.requested" ? "correction" : event.eventType === "supervisor.approval.requested" ? "approval" : "verification",
      eventToClaimMs: Math.max(0, Date.now() - Date.parse(event.createdAt)),
    };
    try {
      startLeaseHeartbeat(workSessionId, claimed.id, leaseNonce);
      if (event.eventType === "supervisor.correction.requested") {
        const reasons = Array.isArray(event.payload.reasons) ? event.payload.reasons.filter((value): value is string => typeof value === "string") : [];
        await input.onCorrect(workSessionId, reasons);
        const resumed = input.runs.transition({ id: claimed.id, expectedStatus: "correction_pending", expectedRevision: claimed.revision, nextStatus: "worker_active", cycleNumber: claimed.cycleNumber + 1, nextActionAt: null, stallReason: null, lease });
        if (!resumed) throw new Error("Supervisor state changed before correction dispatch.");
        input.outbox.markCompleted(event.id);
        return;
      }
      if (event.eventType === "supervisor.approval.requested") {
        await input.onApprove(workSessionId);
        const completed = input.runs.transition({ id: claimed.id, expectedStatus: "approval_pending", expectedRevision: claimed.revision, nextStatus: "completed", nextActionAt: null, stallReason: null, lease });
        if (!completed) throw new Error("Supervisor state changed before automatic approval.");
        input.outbox.markCompleted(event.id);
        return;
      }
      const verifying = input.runs.transition({ id: claimed.id, expectedStatus: "verification_pending", expectedRevision: claimed.revision, nextStatus: "verifying", lease });
      if (!verifying) {
        input.outbox.release(event.id, 250, "Supervisor state changed before verification.");
        return;
      }
      const verificationStartedAt = performance.now();
      await input.onVerify(workSessionId, verifying.deadlineAt, input.currentSubmission(workSessionId));
      timing.verificationMs = Math.max(0, performance.now() - verificationStartedAt);
      const evaluating = input.runs.transition({ id: verifying.id, expectedStatus: "verifying", expectedRevision: verifying.revision, nextStatus: "evaluation_pending", lease });
      if (!evaluating) throw new Error("Supervisor state changed before evaluation.");
      const evaluationStartedAt = performance.now();
      let evaluation = await input.onEvaluate(workSessionId);
      timing.evaluationMs = Math.max(0, performance.now() - evaluationStartedAt);
      const progress = input.getProgressSnapshot?.(workSessionId, evaluation);
      const progressRecord = progress ? input.runs.recordProgress(claimed.id, instanceId, progress, leaseNonce) : undefined;
      if (evaluation.decision === "correction_pending") {
        const fingerprint = deterministicFailureFingerprint(evaluation);
        const repeats = input.runs.noteFailureFingerprint(claimed.id, instanceId, fingerprint, leaseNonce);
        const failureLimit = claimed.repeatedFailureFingerprintLimit ?? 3;
        if (repeats >= failureLimit) {
          evaluation = { ...evaluation, decision: "awaiting_human", reasons: [`Repeated verification failure fingerprint (${repeats} consecutive cycles).`, ...evaluation.reasons] };
        } else if (progressRecord && progressRecord.stagnantCycleCount >= (claimed.maxStagnantCycles ?? 2)) {
          evaluation = { ...evaluation, decision: "awaiting_human", reasons: [`No demonstrable progress for ${progressRecord.stagnantCycleCount} supervisor cycles.`, ...evaluation.reasons] };
        }
      } else if (evaluation.decision === "approval_pending") {
        input.runs.clearFailureFingerprint(claimed.id, instanceId, leaseNonce);
      }
      const decided = input.runs.transition({ id: evaluating.id, expectedStatus: "evaluation_pending", expectedRevision: evaluating.revision, nextStatus: evaluation.decision, stallReason: evaluation.decision === "awaiting_human" ? (progressRecord?.stagnantCycleCount ? "no_new_evidence" : "repeated_verification") : null, lease });
      if (!decided) throw new Error("Supervisor state changed before decision.");
      if (decided.status === "correction_pending" && ["correction_auto", "full"].includes(decided.autonomyMode)) enqueueAction("supervisor.correction.requested", decided.id, decided.revision, workSessionId, evaluation.reasons);
      if (decided.status === "approval_pending" && decided.approvalMode !== "human_required") enqueueAction("supervisor.approval.requested", decided.id, decided.revision, workSessionId);
      input.outbox.markCompleted(event.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      input.runs.noteFailure(claimed.id, instanceId, message, leaseNonce);
      // P1 #22: infrastructure failure backs off geometrically (1s→2s→4s…)
      // via nextActionAt instead of retrying immediately and hot-looping.
      const failureCount = input.outbox.get(event.id)?.attemptCount ?? 0;
      const backoffMs = Math.min(30_000, 250 * Math.pow(2, Math.max(0, failureCount - 1)));
      input.outbox.markFailed(event.id, message, backoffMs);
      const stalled = input.runs.getByWorkSession(workSessionId);
      if (input.outbox.get(event.id)?.status === "dead_lettered" && stalled && !["completed", "failed", "cancelled", "awaiting_human"].includes(stalled.status)) {
        input.runs.transition({ id: stalled.id, expectedStatus: stalled.status, expectedRevision: stalled.revision, nextStatus: "awaiting_human", stallReason: "dispatch_failure", lastError: `Supervisor event dead-lettered: ${message}`, lease });
      } else if (!stopped && stalled && !TERMINAL_OR_PAUSED.has(stalled.status)) {
        // Keep the run schedulable after the backoff window elapses.
        input.runs.transition({ id: stalled.id, expectedStatus: stalled.status, expectedRevision: stalled.revision, nextStatus: stalled.status, nextActionAt: new Date(Date.now() + backoffMs).toISOString(), lease });
      }
    } finally {
      try {
        input.onTiming?.({ ...timing, totalMs: Math.max(0, performance.now() - timingStartedAt) });
      } catch {
        // Diagnostics must never change the leased state machine outcome.
      }
      stopLeaseHeartbeat(claimed.id);
      input.runs.release(claimed.id, instanceId, leaseNonce);
    }
  }

  async function drainOnceImpl(): Promise<Promise<void>[]> {
    input.outbox.reapExpiredClaims(leaseMs);
    input.runs.releaseExpiredClaims();
    const started: Promise<void>[] = [];
    while (inflightByWorkSession.size < maxInflight) {
      const activeRunIds = [...inflightByWorkSession.keys()]
        .map((workSessionId) => input.runs.getByWorkSession(workSessionId)?.id)
        .filter((id): id is string => Boolean(id));
      const event = input.outbox.claimNext(instanceId, leaseMs, ["supervisor.verification.requested", "supervisor.correction.requested", "supervisor.approval.requested"], activeRunIds);
      if (!event) break;
      const workSessionId = typeof event.payload.workSessionId === "string" ? event.payload.workSessionId : "";
      if (!workSessionId) {
        input.outbox.markCompleted(event.id);
        continue;
      }
      const job = processEvent(event).finally(() => {
        inflightByWorkSession.delete(workSessionId);
        if (!stopped) void drainOnce();
      });
      inflightByWorkSession.set(workSessionId, job);
      started.push(job);
    }
    return started;
  }

  async function drainOnce(): Promise<void> {
    // The claim pass is short and synchronous with respect to the event loop;
    // only the leased jobs remain asynchronous. A later wake can therefore
    // fill spare pool capacity while an earlier verifier is still running.
    const started = await drainOnceImpl();
    await Promise.allSettled(started);
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      input.runs.releaseExpiredClaims();
      unsubscribe = input.events.subscribeAll((event) => {
        if (event.type === "review.submitted") enqueueVerification(event.sessionId, event.seq);
        if (event.type === "agent.run.failed_protocol") {
          requireHumanWithStall(event.sessionId, "Worker protocol failure requires intervention.", "protocol_failure", event.seq);
        } else if (["agent.run.failed", "agent.run.cancelled", "worker.attempt.exited"].includes(event.type)) {
          requireHumanWithStall(event.sessionId, `Worker lifecycle event requires intervention: ${event.type}`, "agent_unavailable", event.seq);
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
      void drainOnce();
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
    wake,
  };
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
