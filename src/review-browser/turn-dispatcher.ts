import type { DispatchOutbox, DispatchOutboxEvent, OutboxClaim } from "../dispatch-outbox.js";
import type { ReviewerBrowserController } from "./browser-controller.js";
import type { ReviewerJobStore, ReviewerJobClaim } from "../review-thread/reviewer-job-store.js";

const EVENT = "reviewer.browser_turn.ready";
const LEASE_MS = 30 * 60_000;

export interface ReviewerTurnDispatcher {
  start(): void;
  stop(): void;
  drainOnce(): Promise<void>;
}

function claimOf(event: DispatchOutboxEvent): OutboxClaim {
  return { eventId: event.id, claimOwner: event.claimedBy ?? "", claimToken: event.claimToken ?? "" };
}

export function createReviewerTurnDispatcher(input: {
  outbox: DispatchOutbox;
  jobs: ReviewerJobStore;
  browser: ReviewerBrowserController;
}): ReviewerTurnDispatcher {
  const workerId = `reviewer-browser-${process.pid}`;
  let stopped = true;
  let running: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe: (() => void) | undefined;

  async function handle(event: DispatchOutboxEvent): Promise<void> {
    const eventClaim = claimOf(event);
    const messageId = typeof event.payload.messageId === "string" ? event.payload.messageId : event.aggregateId;
    const profileId = typeof event.payload.profileId === "string" ? event.payload.profileId : undefined;
    let turnClaim: ReviewerJobClaim | undefined;
    let crossedDispatchBoundary = false;
    if (!profileId) {
      input.outbox.markFailed(eventClaim, "review_browser_profile_missing", LEASE_MS);
      return;
    }
    let profile = input.browser.profiles.get(profileId);
    if (!profile) {
      input.outbox.markFailed(eventClaim, "review_browser_profile_unavailable", LEASE_MS);
      return;
    }
    try {
      if (!profile.generation || profile.status === "stopped" || profile.status === "recovering" || profile.status === "blocked") {
        profile = await input.browser.startProfile(profileId, profile.mode);
      }
      const threadId = typeof event.payload.threadId === "string" ? event.payload.threadId : "";
      const restored = await input.browser.restoreThread(threadId);
      turnClaim = input.jobs.claim({ messageId, profileId, browserGeneration: profile.generation, leaseMs: LEASE_MS });
      if (!turnClaim) {
        input.outbox.markCompleted(eventClaim);
        return;
      }
      input.jobs.transition({ attemptId: turnClaim.attemptId, leaseToken: turnClaim.leaseToken, profileId, browserGeneration: profile.generation, nextStatus: "browser_ready" });
      const baseline = await restored.driver.captureBaseline();
      // Persist the irreversible boundary before the only send action.
      input.jobs.transition({ attemptId: turnClaim.attemptId, leaseToken: turnClaim.leaseToken, profileId, browserGeneration: profile.generation, nextStatus: "dispatching" });
      crossedDispatchBoundary = true;
      const result = await restored.driver.submitPrompt({ prompt: turnClaim.prompt, attemptId: turnClaim.attemptId, expectedConversationKey: turnClaim.conversationKey, baseline });
      if (result.status === "accepted") {
        input.jobs.transition({ attemptId: turnClaim.attemptId, leaseToken: turnClaim.leaseToken, profileId, browserGeneration: profile.generation, nextStatus: "prompt_accepted" });
        input.outbox.markCompleted(eventClaim);
      } else if (result.status === "uncertain") {
        input.jobs.transition({ attemptId: turnClaim.attemptId, leaseToken: turnClaim.leaseToken, profileId, browserGeneration: profile.generation, nextStatus: "uncertain", errorCode: result.reason });
        input.outbox.markCompleted(eventClaim);
      } else {
        const blocked = ["login_required", "verification_required", "connector_authorization_required"].includes(result.reason);
        input.jobs.transition({ attemptId: turnClaim.attemptId, leaseToken: turnClaim.leaseToken, profileId, browserGeneration: profile.generation, nextStatus: blocked ? "blocked_auth" : "blocked_browser", errorCode: result.reason });
        input.outbox.markCompleted(eventClaim);
      }
    } catch (error) {
      const latest = input.outbox.get(event.id);
      if (turnClaim) {
        const profile = input.browser.profiles.get(profileId!);
        if (profile) {
          try {
            input.jobs.transition({ attemptId: turnClaim.attemptId, leaseToken: turnClaim.leaseToken, profileId: profileId!, browserGeneration: profile.generation,
              nextStatus: crossedDispatchBoundary ? "uncertain" : "blocked_browser",
              errorCode: crossedDispatchBoundary ? "dispatch_result_unavailable" : "browser_not_ready_before_dispatch" });
          } catch { /* a stale/fenced attempt remains durable for reconciliation */ }
        }
        if (latest?.status === "claimed") {
          if (crossedDispatchBoundary) input.outbox.markCompleted(eventClaim);
          else input.outbox.markFailed(eventClaim, "browser_not_ready_before_dispatch", LEASE_MS);
        }
      } else if (latest?.status === "claimed") {
        input.outbox.markFailed(eventClaim, error instanceof Error ? error.message.slice(0, 300) : "browser_dispatch_failed", LEASE_MS);
      }
    }
  }

  async function drainOnce(): Promise<void> {
    if (stopped) return;
    if (running) return running;
    running = (async () => {
      input.outbox.reapExpiredClaims(LEASE_MS);
      let event: ReturnType<DispatchOutbox["claimNext"]>;
      while (!stopped && (event = input.outbox.claimNext(workerId, LEASE_MS, [EVENT]))) {
        await handle(event);
      }
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

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      unsubscribe = input.outbox.subscribe(() => { void drainOnce(); }, [EVENT]);
      // Reconcile durable work left by a crash before relying on notifications.
      void drainOnce();
    },
    stop() {
      stopped = true;
      unsubscribe?.();
      unsubscribe = undefined;
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
    drainOnce,
  };
}
