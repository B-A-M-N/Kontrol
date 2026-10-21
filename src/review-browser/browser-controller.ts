import { and, eq, inArray } from "drizzle-orm";
import type { DatabaseHandle } from "../db/client.js";
import { reviewBrowserProfiles, reviewRoutes, reviewThreads, reviewBrowserTurns, reviewThreadMessages } from "../db/schema.js";
import type { DispatchOutbox } from "../dispatch-outbox.js";
import { launchOrReconnectChrome, type OwnedChrome } from "./chrome-process.js";
import { ChatGptPageDriver } from "./chatgpt-page-driver.js";
import { createReviewerBrowserProfileStore, type ReviewerBrowserMode, type ReviewerBrowserProfile, type ReviewerBrowserProfileStore } from "./profile-store.js";
import { bindReviewerTarget, canonicalReviewerConversation, restoreReviewerTarget, reviewerConversationFingerprint, type BoundReviewerTarget, type ReviewerTabBinding } from "./target-binding.js";

const ACTIVE_TURN_STATES = ["leased", "browser_ready", "dispatching", "prompt_accepted", "model_generating", "generation_finished", "awaiting_feedback", "uncertain"];

export interface ReviewerBrowserController {
  profiles: ReviewerBrowserProfileStore;
  createProfile(input: { profileId: string; ownerPrincipalId: string; mode?: ReviewerBrowserMode }): ReviewerBrowserProfile;
  startProfile(profileId: string, mode?: ReviewerBrowserMode): Promise<ReviewerBrowserProfile>;
  stopProfile(profileId: string): Promise<ReviewerBrowserProfile>;
  switchMode(profileId: string, mode: ReviewerBrowserMode): Promise<ReviewerBrowserProfile>;
  openLoginPage(profileId: string): Promise<{ targetId: string; sessionId: string }>;
  bindConversation(input: { profileId: string; reviewThreadId: string; targetId: string; principalId: string }): Promise<ReviewerTabBinding>;
  restoreThread(reviewThreadId: string): Promise<{ target: BoundReviewerTarget; driver: ChatGptPageDriver }>;
  close(): Promise<void>;
}

export function createReviewerBrowserController(input: {
  database: DatabaseHandle;
  stateDir: string;
  dispatchOutbox?: DispatchOutbox;
  chromePath?: string;
  environment?: NodeJS.ProcessEnv;
}): ReviewerBrowserController {
  const profiles = createReviewerBrowserProfileStore(input.database, input.stateDir);
  const processes = new Map<string, OwnedChrome>();
  const bindings = new Map<string, BoundReviewerTarget>();
  const activeForProfile = (profileId: string): number => input.database.db.select({ id: reviewBrowserTurns.id })
    .from(reviewBrowserTurns).where(and(eq(reviewBrowserTurns.profileId, profileId), inArray(reviewBrowserTurns.state, ACTIVE_TURN_STATES))).all().length;

  async function startProfile(profileId: string, mode?: ReviewerBrowserMode): Promise<ReviewerBrowserProfile> {
    const current = profiles.get(profileId);
    if (!current) throw new Error("Reviewer browser profile is not registered.");
    const requestedMode = mode ?? current.mode;
    const existing = processes.get(profileId);
    if (existing) {
      if (current.mode === requestedMode) return current;
      return switchMode(profileId, requestedMode);
    }
    const starting = profiles.transition({ profileId, expectedGeneration: current.generation, status: "starting", mode: requestedMode });
    try {
      const profileDirectory = await profiles.profileDirectory(profileId);
      const chrome = await launchOrReconnectChrome({
        profileDirectory,
        generation: starting.generation,
        mode: requestedMode,
        chromePath: input.chromePath,
        environment: input.environment,
      });
      processes.set(profileId, chrome);
      const ready = profiles.transition({ profileId, expectedGeneration: starting.generation, status: "ready", mode: requestedMode, verified: true });
      return ready;
    } catch (error) {
      const failed = profiles.get(profileId);
      if (failed?.generation === starting.generation) profiles.transition({ profileId, expectedGeneration: starting.generation, status: "blocked" });
      throw error;
    }
  }

  async function stopProfile(profileId: string): Promise<ReviewerBrowserProfile> {
    const current = profiles.get(profileId);
    if (!current) throw new Error("Reviewer browser profile is not registered.");
    if (activeForProfile(profileId)) throw new Error("A reviewer turn is active or awaiting authoritative feedback; reconcile it before stopping Chromium.");
    const chrome = processes.get(profileId);
    if (chrome) {
      await chrome.close();
      processes.delete(profileId);
    }
    for (const [threadId, target] of bindings) {
      const thread = input.database.db.select().from(reviewThreads).where(eq(reviewThreads.id, threadId)).get();
      if (thread?.browserProfileId === profileId) bindings.delete(threadId);
    }
    const latest = profiles.get(profileId)!;
    if (latest.status === "stopped") return latest;
    return profiles.transition({ profileId, expectedGeneration: latest.generation, status: "stopped" });
  }

  async function switchMode(profileId: string, mode: ReviewerBrowserMode): Promise<ReviewerBrowserProfile> {
    const current = profiles.get(profileId);
    if (!current) throw new Error("Reviewer browser profile is not registered.");
    if (current.mode === mode && processes.has(profileId)) return current;
    if (activeForProfile(profileId)) throw new Error("Cannot switch headed/headless mode while a reviewer turn is active or awaiting feedback.");
    const chrome = processes.get(profileId);
    if (chrome) {
      await chrome.close();
      processes.delete(profileId);
    }
    const stopped = profiles.get(profileId)!;
    if (stopped.status !== "stopped") profiles.transition({ profileId, expectedGeneration: stopped.generation, status: "stopped" });
    return startProfile(profileId, mode);
  }

  async function openLoginPage(profileId: string): Promise<{ targetId: string; sessionId: string }> {
    let profile = profiles.get(profileId);
    if (!profile) throw new Error("Reviewer browser profile is not registered.");
    if (profile.mode !== "headed") profile = await switchMode(profileId, "headed");
    if (!processes.has(profileId)) profile = await startProfile(profileId, "headed");
    const chrome = processes.get(profileId)!;
    const created = await chrome.cdp.send<{ targetId?: string }>("Target.createTarget", { url: "https://chatgpt.com/" });
    if (!created.targetId) throw new Error("Chromium could not open the ChatGPT login page.");
    const attached = await chrome.cdp.send<{ sessionId?: string }>("Target.attachToTarget", { targetId: created.targetId, flatten: true });
    if (!attached.sessionId) throw new Error("Kontrol could not attach to the ChatGPT login page.");
    await chrome.cdp.send("Page.enable", {}, attached.sessionId);
    return { targetId: created.targetId, sessionId: attached.sessionId };
  }

  async function bindConversation(bindingInput: { profileId: string; reviewThreadId: string; targetId: string; principalId: string }): Promise<ReviewerTabBinding> {
    const profile = profiles.get(bindingInput.profileId);
    if (!profile || profile.ownerPrincipalId !== bindingInput.principalId) throw new Error("Reviewer browser profile owner authorization failed.");
    const thread = input.database.db.select().from(reviewThreads).where(eq(reviewThreads.id, bindingInput.reviewThreadId)).get();
    if (!thread) throw new Error("Reviewer thread does not exist.");
    const route = input.database.db.select().from(reviewRoutes).where(eq(reviewRoutes.id, thread.routeId)).get();
    if (!route || route.status !== "active" || route.routeEpoch !== thread.routeEpoch || route.deliveryTransport !== "native_cdp"
      || route.browserProfileId !== profile.id || thread.status !== "active" || thread.reviewerPrincipalId !== bindingInput.principalId) {
      throw new Error("Reviewer thread, route, profile, or authenticated principal is not eligible for browser binding.");
    }
    const chrome = processes.get(profile.id);
    if (!chrome) throw new Error("Reviewer browser profile is not running.");
    const prior = thread.conversationBindingStatus;
    if (prior === "bound" && thread.conversationFingerprint) throw new Error("This reviewer thread already owns a conversation; use exact restoration or authorized reattachment.");
    const revision = (thread.conversationBindingRevision ?? 0) + 1;
    const result = await bindReviewerTarget({
      cdp: chrome.cdp,
      profileId: profile.id,
      reviewThreadId: thread.id,
      browserGeneration: profile.generation,
      targetId: bindingInput.targetId,
      bindingRevision: revision,
    });
    await chrome.cdp.send("Page.enable", {}, result.target.sessionId);
    await chrome.cdp.send("Runtime.enable", {}, result.target.sessionId);
    const committed = input.database.sqlite.transaction(() => {
      const updated = input.database.db.update(reviewThreads).set({
        reviewerBindingId: thread.reviewerBindingId ?? `reviewer_binding_${thread.id}`,
        browserProfileId: profile.id,
        browserGeneration: profile.generation,
        browserTargetId: result.target.targetId,
        browserCdpSessionId: result.target.sessionId,
        conversationUrl: result.binding.conversationUrl,
        conversationKey: result.binding.conversationKey,
        conversationFingerprint: reviewerConversationFingerprint(result.binding.conversationKey!),
        conversationBindingRevision: revision,
        conversationBindingStatus: "bound",
        conversationBindingAssurance: "browser_observed",
        bindingGeneration: (thread.bindingGeneration ?? 0) + 1,
        revision: thread.revision + 1,
      }).where(and(eq(reviewThreads.id, thread.id), eq(reviewThreads.revision, thread.revision))).run();
      if (updated.changes !== 1) return false;
      const messages = input.database.db.select().from(reviewThreadMessages).where(eq(reviewThreadMessages.threadId, thread.id)).all();
      for (const message of messages) {
        if (message.status === "queued") input.dispatchOutbox?.enqueue({
          eventType: "reviewer.browser_turn.ready",
          aggregateId: message.id,
          aggregateRevision: message.revision,
          payload: { messageId: message.id, threadId: thread.id, profileId: profile.id, routeEpoch: thread.routeEpoch, revision: message.revision },
        });
      }
      return true;
    })();
    if (!committed) {
      await chrome.cdp.send("Target.detachFromTarget", { sessionId: result.target.sessionId }).catch(() => undefined);
      throw new Error("Reviewer conversation binding lost its thread revision compare-and-swap.");
    }
    bindings.set(thread.id, result.target);
    return result.binding;
  }

  async function restoreThread(reviewThreadId: string): Promise<{ target: BoundReviewerTarget; driver: ChatGptPageDriver }> {
    const thread = input.database.db.select().from(reviewThreads).where(eq(reviewThreads.id, reviewThreadId)).get();
    if (!thread || thread.status !== "active" || thread.conversationBindingStatus !== "bound" || !thread.browserProfileId
      || !thread.conversationUrl || !thread.conversationKey || !thread.conversationFingerprint) throw new Error("Reviewer conversation requires explicit binding recovery.");
    const route = input.database.db.select().from(reviewRoutes).where(eq(reviewRoutes.id, thread.routeId)).get();
    if (!route || route.status !== "active" || route.routeEpoch !== thread.routeEpoch || route.deliveryTransport !== "native_cdp"
      || route.browserProfileId !== thread.browserProfileId) throw new Error("Review route changed; browser conversation is fenced.");
    let profile = profiles.get(thread.browserProfileId);
    if (!profile) throw new Error("Bound reviewer browser profile is unavailable.");
    if (!processes.has(profile.id)) profile = await startProfile(profile.id);
    const chrome = processes.get(profile.id)!;
    const key = canonicalReviewerConversation(thread.conversationUrl).key;
    if (key !== thread.conversationKey || reviewerConversationFingerprint(key) !== thread.conversationFingerprint) throw new Error("Saved reviewer conversation identity does not match its canonical URL and fingerprint.");
    const target = await restoreReviewerTarget({
      cdp: chrome.cdp,
      browserGeneration: profile.generation,
      binding: {
        profileId: profile.id,
        reviewThreadId: thread.id,
        conversationUrl: thread.conversationUrl,
        conversationKey: thread.conversationKey,
        browserGeneration: thread.browserGeneration ?? 0,
        targetId: thread.browserTargetId ?? undefined,
        cdpSessionId: thread.browserCdpSessionId ?? undefined,
        bindingRevision: thread.conversationBindingRevision ?? 1,
        status: "bound",
      },
    });
    await chrome.cdp.send("Page.enable", {}, target.sessionId);
    await chrome.cdp.send("Runtime.enable", {}, target.sessionId);
    const driver = new ChatGptPageDriver(chrome.cdp, target);
    const readiness = await driver.inspect(key);
    if (readiness.status !== "ready") {
      const status = "recovery_required";
      input.database.db.update(reviewThreads).set({ conversationBindingStatus: status, revision: thread.revision + 1 })
        .where(and(eq(reviewThreads.id, thread.id), eq(reviewThreads.revision, thread.revision))).run();
      throw new Error(`Bound reviewer conversation is not ready: ${readiness.status}.`);
    }
    input.database.db.update(reviewThreads).set({
      browserGeneration: profile.generation,
      browserTargetId: target.targetId,
      browserCdpSessionId: target.sessionId,
      conversationBindingStatus: "bound",
      revision: thread.revision + 1,
    }).where(and(eq(reviewThreads.id, thread.id), eq(reviewThreads.revision, thread.revision))).run();
    bindings.set(thread.id, target);
    return { target, driver };
  }

  return {
    profiles,
    createProfile: ({ profileId, ownerPrincipalId, mode }) => profiles.create({ id: profileId, ownerPrincipalId, mode }),
    startProfile,
    stopProfile,
    switchMode,
    openLoginPage,
    bindConversation,
    restoreThread,
    async close() {
      for (const [profileId, chrome] of processes) {
        await chrome.detach();
        processes.delete(profileId);
        const profile = profiles.get(profileId);
        if (profile && profile.status !== "stopped") profiles.transition({ profileId, expectedGeneration: profile.generation, status: "recovering" });
      }
      bindings.clear();
    },
  };
}
