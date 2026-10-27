import type { DispatchOutbox, DispatchOutboxEvent, OutboxClaim } from "../dispatch-outbox.js";
import type { ReviewerBrowserController } from "./browser-controller.js";
import type { ReviewerJobStore, ReviewerJobClaim } from "../review-thread/reviewer-job-store.js";
import { BrowserReadinessError } from "./chatgpt-page-driver.js";
import { ReviewerTargetError } from "./target-binding.js";

const EVENT = "reviewer.browser_turn.ready";
const LEASE_MS = 30 * 60_000;
const RENEW_INTERVAL_MS = 5 * 60_000;
const MAX_INFLIGHT_TURNS = 4;
const AUTH_FAILURES = new Set(["login_required", "verification_required", "identity_provider_rejected", "identity_provider_unsupported_browser", "session_expired", "authentication_handoff_failed", "connector_authorization_required"]);
const BINDING_RECOVERY_FAILURES = new Set(["recovery_required", "target_ambiguous", "wrong_conversation"]);
const RETRYABLE_BROWSER_FAILURES = new Set(["navigation_unconfirmed", "browser_transport_failed", "browser_disconnected"]);

export interface ReviewerTurnDispatcher {
  start(): void;
  stopAndDrain(): Promise<void>;
  drainOnce(): Promise<void>;
}

function claimOf(event: DispatchOutboxEvent): OutboxClaim {
  return { eventId: event.id, claimOwner: event.claimedBy ?? "", claimToken: event.claimToken ?? "" };
}

export function createReviewerTurnDispatcher(input: {
  outbox: DispatchOutbox;
  jobs: ReviewerJobStore;
  browser: ReviewerBrowserController;
  drainTimeoutMs?: number;
}): ReviewerTurnDispatcher {
  const workerId = `reviewer-browser-${process.pid}`;
  let stopped = true;
  let running: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe: (() => void) | undefined;
  let stopPromise: Promise<void> | undefined;

  function markCompleted(claim: OutboxClaim, eventId: string, attemptId?: string): void {
    if (!input.outbox.markCompleted(claim)) {
      console.warn("reviewer_browser_outbox_completion_fenced", { eventId, ...(attemptId ? { attemptId } : {}) });
    }
  }
  function recordAuthenticationBlock(profileId: string, reason: string): void {
    const current = input.browser.profiles.get(profileId);
    if (!current || !AUTH_FAILURES.has(reason)) return;
    try {
      input.browser.profiles.transition({
        profileId, expectedGeneration: current.generation,
        status: reason === "login_required" ? "login_required" : "blocked",
        authState: reason === "login_required" ? "manual_auth_required" : "auth_blocked",
      });
    } catch { /* a concurrent generation transition owns the newer profile state */ }
  }
  function recordBrowserTransportFailure(profileId: string, reason: string): void {
    if (!RETRYABLE_BROWSER_FAILURES.has(reason) || !["browser_transport_failed", "browser_disconnected"].includes(reason)) return;
    const current = input.browser.profiles.get(profileId);
    if (!current) return;
    try { input.browser.profiles.transition({ profileId, expectedGeneration: current.generation, status: "recovering" }); }
    catch { /* a concurrent generation transition owns the newer profile state */ }
  }
  const activeTurns = new Map<string, { claim: ReviewerJobClaim; profileId: string; generation: number; crossedDispatchBoundary: boolean; shutdownPersisted: boolean; eventClaim: OutboxClaim }>();
  const conversationTails = new Map<string, Promise<void>>();

  async function lockConversation(conversationKey: string): Promise<() => void> {
    const previous = conversationTails.get(conversationKey);
    let release!: () => void;
    const tail = new Promise<void>((resolve) => { release = resolve; });
    conversationTails.set(conversationKey, tail);
    await previous;
    return () => {
      release();
      if (conversationTails.get(conversationKey) === tail) conversationTails.delete(conversationKey);
    };
  }

  async function handle(event: DispatchOutboxEvent): Promise<void> {
    const eventClaim = claimOf(event);
    const messageId = typeof event.payload.messageId === "string" ? event.payload.messageId : event.aggregateId;
    const profileId = typeof event.payload.profileId === "string" ? event.payload.profileId : undefined;
    let turnClaim: ReviewerJobClaim | undefined;
    let turnState: { claim: ReviewerJobClaim; profileId: string; generation: number; crossedDispatchBoundary: boolean; shutdownPersisted: boolean; eventClaim: OutboxClaim } | undefined;
    let crossedDispatchBoundary = false;
    let leaseHeartbeat: ReturnType<typeof setInterval> | undefined;
    let releaseConversation: (() => void) | undefined;
    if (!profileId) {
      input.outbox.markFailed(eventClaim, "review_browser_profile_missing", LEASE_MS);
      return;
    }
    let profile = input.browser.profiles.get(profileId);
    if (!profile) {
      input.outbox.markFailed(eventClaim, "review_browser_profile_unavailable", LEASE_MS);
      return;
    }
    if (["manual_auth_required", "manual_auth_in_progress", "handoff_pending", "auth_blocked"].includes(profile.authState)) {
      input.outbox.markSuspended(eventClaim, `review_browser_auth_suspended:${profile.authState}`);
      return;
    }
    try {
      if (!profile.generation || profile.status === "stopped" || profile.status === "recovering" || profile.status === "blocked") {
        profile = await input.browser.startProfile(profileId, profile.mode);
      }
      const threadId = typeof event.payload.threadId === "string" ? event.payload.threadId : "";
      const restored = await input.browser.restoreThread(threadId);
      if (restored.readiness?.status === "generation_active") {
        input.outbox.release(eventClaim, 5_000, "bound_conversation_generation_active");
        return;
      }
      if (stopped) {
        input.outbox.markFailed(eventClaim, "shutdown_before_dispatch", LEASE_MS);
        return;
      }
      turnClaim = input.jobs.claim({ messageId, profileId, browserGeneration: profile.generation, leaseMs: LEASE_MS });
      if (!turnClaim) {
        markCompleted(eventClaim, event.id);
        return;
      }
      input.jobs.transition({ attemptId: turnClaim.attemptId, leaseToken: turnClaim.leaseToken, profileId, browserGeneration: profile.generation, nextStatus: "browser_ready" });
      turnState = { claim: turnClaim, profileId, generation: profile.generation, crossedDispatchBoundary: false, shutdownPersisted: false, eventClaim };
      activeTurns.set(turnClaim.attemptId, turnState);
      leaseHeartbeat = setInterval(() => {
        try { input.jobs.renewLease({ attemptId: turnClaim!.attemptId, leaseToken: turnClaim!.leaseToken, profileId: profileId!, browserGeneration: profile!.generation, leaseMs: LEASE_MS }); }
        catch { /* a stale generation cannot renew; the durable attempt remains fenced */ }
      }, RENEW_INTERVAL_MS);
      releaseConversation = await lockConversation(turnClaim.conversationKey);
      if (stopped || turnState.shutdownPersisted) return;
      const baseline = await restored.driver.captureBaseline();
      if (stopped) {
        input.jobs.transition({ attemptId: turnClaim.attemptId, leaseToken: turnClaim.leaseToken, profileId, browserGeneration: profile.generation, nextStatus: "blocked_browser", errorCode: "shutdown_before_dispatch" });
        input.outbox.markFailed(eventClaim, "shutdown_before_dispatch", LEASE_MS);
        return;
      }
      // Persist the irreversible boundary before the only send action.
      input.jobs.transition({ attemptId: turnClaim.attemptId, leaseToken: turnClaim.leaseToken, profileId, browserGeneration: profile.generation, nextStatus: "dispatching" });
      crossedDispatchBoundary = true;
      turnState!.crossedDispatchBoundary = true;
      const result = await restored.driver.submitPrompt({ prompt: turnClaim.prompt, attemptId: turnClaim.attemptId, expectedConversationKey: turnClaim.conversationKey, baseline });
      if (turnState!.shutdownPersisted) return;
      if (result.status === "accepted") {
        input.jobs.transition({ attemptId: turnClaim.attemptId, leaseToken: turnClaim.leaseToken, profileId, browserGeneration: profile.generation, nextStatus: "prompt_accepted" });
        markCompleted(eventClaim, event.id, turnClaim.attemptId);
        let generation = await restored.driver.waitForGeneration(baseline, turnClaim.attemptId, "start");
        if (turnState!.shutdownPersisted) return;
        if (generation === "generating") {
          input.jobs.transition({ attemptId: turnClaim.attemptId, leaseToken: turnClaim.leaseToken, profileId, browserGeneration: profile.generation, nextStatus: "model_generating" });
          generation = await restored.driver.waitForGeneration(baseline, turnClaim.attemptId, "finish");
          if (turnState!.shutdownPersisted) return;
        }
        if (generation === "finished") {
          input.jobs.transition({ attemptId: turnClaim.attemptId, leaseToken: turnClaim.leaseToken, profileId, browserGeneration: profile.generation, nextStatus: "generation_finished" });
          input.jobs.transition({ attemptId: turnClaim.attemptId, leaseToken: turnClaim.leaseToken, profileId, browserGeneration: profile.generation, nextStatus: "awaiting_feedback" });
        } else {
          if (generation === "blocked") recordAuthenticationBlock(profileId, "session_expired");
          input.jobs.transition({ attemptId: turnClaim.attemptId, leaseToken: turnClaim.leaseToken, profileId, browserGeneration: profile.generation,
            nextStatus: "uncertain", errorCode: generation === "blocked" ? "authentication_lost_during_review" : "generation_observation_unavailable" });
        }
      } else if (result.status === "uncertain") {
        if (AUTH_FAILURES.has(result.reason)) recordAuthenticationBlock(profileId, result.reason);
        input.jobs.transition({ attemptId: turnClaim.attemptId, leaseToken: turnClaim.leaseToken, profileId, browserGeneration: profile.generation, nextStatus: "uncertain", errorCode: result.reason });
        markCompleted(eventClaim, event.id, turnClaim.attemptId);
      } else {
        const authBlocked = AUTH_FAILURES.has(result.reason);
        const blocked = authBlocked || ["authentication_handoff_failed", "connector_authorization_required"].includes(result.reason);
        if (authBlocked) recordAuthenticationBlock(profileId, result.reason);
        else recordBrowserTransportFailure(profileId, result.reason);
        input.jobs.transition({ attemptId: turnClaim.attemptId, leaseToken: turnClaim.leaseToken, profileId, browserGeneration: profile.generation, nextStatus: blocked ? "blocked_auth" : "blocked_browser", errorCode: result.reason });
        if (authBlocked) input.outbox.markSuspended(eventClaim, `review_browser_auth_suspended:${result.reason}`);
        else if (BINDING_RECOVERY_FAILURES.has(result.reason)) {
          input.browser.requireBindingRecovery(threadId, result.reason);
          input.outbox.markSuspended(eventClaim, `reviewer.browser_binding_suspended:${result.reason}`);
        }
        else if (RETRYABLE_BROWSER_FAILURES.has(result.reason)) input.outbox.release(eventClaim, 5_000, result.reason);
        else input.outbox.markFailed(eventClaim, result.reason, LEASE_MS);
      }
    } catch (error) {
      const latest = input.outbox.get(event.id);
      if (turnClaim) {
        const profile = input.browser.profiles.get(profileId!);
        const readiness = error instanceof BrowserReadinessError ? error.readiness : undefined;
        const authBlocked = readiness !== undefined && AUTH_FAILURES.has(readiness);
        const retryableBrowserFailure = readiness !== undefined && RETRYABLE_BROWSER_FAILURES.has(readiness);
        if (authBlocked) recordAuthenticationBlock(profileId!, readiness!);
        else if (retryableBrowserFailure) recordBrowserTransportFailure(profileId!, readiness!);
        if (profile) {
          try {
            input.jobs.transition({ attemptId: turnClaim.attemptId, leaseToken: turnClaim.leaseToken, profileId: profileId!, browserGeneration: profile.generation,
              nextStatus: crossedDispatchBoundary ? "uncertain" : authBlocked ? "blocked_auth" : "blocked_browser",
              errorCode: crossedDispatchBoundary ? "dispatch_result_unavailable" : authBlocked ? readiness : "browser_not_ready_before_dispatch" });
          } catch { /* a stale/fenced attempt remains durable for reconciliation */ }
        }
        if (latest?.status === "claimed") {
          if (crossedDispatchBoundary) markCompleted(eventClaim, event.id, turnClaim.attemptId);
          else if (authBlocked) input.outbox.markSuspended(eventClaim, `review_browser_auth_suspended:${readiness}`);
          else if (retryableBrowserFailure) input.outbox.release(eventClaim, 5_000, readiness!);
          else input.outbox.markFailed(eventClaim, "browser_not_ready_before_dispatch", LEASE_MS);
        }
      } else if (latest?.status === "claimed") {
        const latestProfile = input.browser.profiles.get(profileId!);
        const readiness = error instanceof BrowserReadinessError ? error.readiness : undefined;
        if (readiness !== undefined && AUTH_FAILURES.has(readiness)) {
          input.outbox.markSuspended(eventClaim, `review_browser_auth_suspended:${readiness}`);
        } else if (latestProfile && ["manual_auth_required", "manual_auth_in_progress", "handoff_pending", "auth_blocked"].includes(latestProfile.authState)) {
          input.outbox.markSuspended(eventClaim, `review_browser_auth_suspended:${latestProfile.authState}`);
        } else if (error instanceof ReviewerTargetError && BINDING_RECOVERY_FAILURES.has(error.code)) {
          input.outbox.markSuspended(eventClaim, `reviewer.browser_binding_suspended:${error.code}`);
        } else if (readiness !== undefined && RETRYABLE_BROWSER_FAILURES.has(readiness)) {
          input.outbox.release(eventClaim, 5_000, readiness);
        } else {
          input.outbox.markFailed(eventClaim, error instanceof Error ? error.message.slice(0, 300) : "browser_dispatch_failed", LEASE_MS);
        }
      }
    } finally {
      if (leaseHeartbeat) clearInterval(leaseHeartbeat);
      if (turnClaim) activeTurns.delete(turnClaim.attemptId);
      releaseConversation?.();
    }
  }

  async function drainOnce(): Promise<void> {
    if (stopped) return;
    if (running) return running;
    running = (async () => {
      input.outbox.reapExpiredClaims(LEASE_MS);
      let recovery: ReturnType<ReviewerJobStore["reconcileExpiredAttempts"]>;
      do {
        recovery = input.jobs.reconcileExpiredAttempts({ now: new Date().toISOString(), limit: 100 });
        if (recovery.reconciled + recovery.uncertain + recovery.fenced === 100) {
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      } while (!stopped && recovery.reconciled + recovery.uncertain + recovery.fenced === 100);
      const inFlight = new Set<Promise<void>>();
      while (!stopped) {
        let event: ReturnType<DispatchOutbox["claimNext"]>;
        while (!stopped && inFlight.size < MAX_INFLIGHT_TURNS
          && (event = input.outbox.claimNext(workerId, LEASE_MS, [EVENT]))) {
          const task = handle(event).finally(() => inFlight.delete(task));
          inFlight.add(task);
        }
        if (inFlight.size === 0) break;
        await Promise.race(inFlight);
      }
      await Promise.all(inFlight);
    })().finally(() => {
      running = undefined;
      scheduleNextEligible();
    });
    return running;
  }

  function scheduleNextEligible(): void {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (stopped) return;
    const next = input.outbox.listPending(1, [EVENT])[0];
    if (!next) return;
    const delay = Math.max(0, Date.parse(next.availableAt) - Date.now());
    timer = setTimeout(() => {
      timer = undefined;
      void drainOnce();
    }, delay);
  }

  function stopAndDrain(): Promise<void> {
    if (stopPromise) return stopPromise;
    stopped = true;
    unsubscribe?.();
    unsubscribe = undefined;
    if (timer) clearTimeout(timer);
    timer = undefined;
    stopPromise = (async () => {
      if (!running) return;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const drained = await Promise.race([
        running.then(() => true),
        new Promise<false>((resolve) => { timeout = setTimeout(() => resolve(false), Math.max(1, input.drainTimeoutMs ?? 5_000)); }),
      ]);
      if (timeout) clearTimeout(timeout);
      if (drained || activeTurns.size === 0) return;
      for (const current of activeTurns.values()) {
        try {
          input.jobs.transition({
            attemptId: current.claim.attemptId, leaseToken: current.claim.leaseToken,
            profileId: current.profileId, browserGeneration: current.generation,
            nextStatus: current.crossedDispatchBoundary ? "uncertain" : "blocked_browser",
            errorCode: current.crossedDispatchBoundary ? "shutdown_during_dispatch" : "shutdown_before_dispatch",
          });
        } catch { /* a concurrent authoritative transition already fenced this attempt */ }
        if (current.crossedDispatchBoundary) markCompleted(current.eventClaim, current.eventClaim.eventId, current.claim.attemptId);
        else input.outbox.markFailed(current.eventClaim, "shutdown_before_dispatch", LEASE_MS);
        current.shutdownPersisted = true;
      }
    })();
    return stopPromise;
  }

  return {
    start() {
      if (!stopped) return;
      stopPromise = undefined;
      stopped = false;
      unsubscribe = input.outbox.subscribe(() => { void drainOnce(); }, [EVENT]);
      // Reconcile durable work left by a crash before relying on notifications.
      void drainOnce();
    },
    stopAndDrain,
    drainOnce,
  };
}
