import { and, eq, inArray } from "drizzle-orm";
import type { DatabaseHandle } from "../db/client.js";
import { reviewBrowserProfiles, reviewRoutes, reviewThreads, reviewBrowserTurns, reviewThreadMessages } from "../db/schema.js";
import type { DispatchOutbox } from "../dispatch-outbox.js";
import { launchManualAuthenticationChrome, launchOrReconnectChrome, type ManualChromeAuthentication, type OwnedChrome } from "./chrome-process.js";
import { ChatGptPageDriver } from "./chatgpt-page-driver.js";
import { createReviewerBrowserProfileStore, type ReviewerBrowserMode, type ReviewerBrowserProfile, type ReviewerBrowserProfileStore } from "./profile-store.js";
import { bindReviewerTarget, canonicalReviewerConversation, restoreReviewerTarget, reviewerConversationFingerprint, type BoundReviewerTarget, type ReviewerTabBinding } from "./target-binding.js";

const LIVE_DISPATCH_STATES = ["leased", "browser_ready", "dispatching", "model_generating"];

export interface ReviewerBrowserController {
  profiles: ReviewerBrowserProfileStore;
  createProfile(input: { profileId: string; ownerPrincipalId: string; mode?: ReviewerBrowserMode }): ReviewerBrowserProfile;
  startProfile(profileId: string, mode?: ReviewerBrowserMode): Promise<ReviewerBrowserProfile>;
  stopProfile(profileId: string): Promise<ReviewerBrowserProfile>;
  switchMode(profileId: string, mode: ReviewerBrowserMode): Promise<ReviewerBrowserProfile>;
  openLoginPage(profileId: string): Promise<{ targetId: string; sessionId: string }>;
  beginManualAuthentication(profileId: string): Promise<{ profileId: string; generation: number; browserPid?: number }>;
  completeManualAuthentication(profileId: string): Promise<{ status: "authenticated" | "auth_required" | "auth_blocked"; reason?: string; targets: Array<{ targetId: string; url: string; title: string }> }>;
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
  launchControlled?: typeof launchOrReconnectChrome;
  launchManualAuthentication?: typeof launchManualAuthenticationChrome;
}): ReviewerBrowserController {
  const profiles = createReviewerBrowserProfileStore(input.database, input.stateDir);
  const processes = new Map<string, OwnedChrome>();
  const manualProcesses = new Map<string, ManualChromeAuthentication>();
  const bindings = new Map<string, BoundReviewerTarget>();
  const profileFlights = new Map<string, { operation: string; promise: Promise<unknown> }>();
  const launchControlled = input.launchControlled ?? launchOrReconnectChrome;
  const launchManual = input.launchManualAuthentication ?? launchManualAuthenticationChrome;
  const activeForProfile = (profileId: string): number => input.database.db.select({ id: reviewBrowserTurns.id })
    .from(reviewBrowserTurns).where(and(eq(reviewBrowserTurns.profileId, profileId), inArray(reviewBrowserTurns.state, LIVE_DISPATCH_STATES))).all().length;

  async function startProfileOnce(profileId: string, mode?: ReviewerBrowserMode): Promise<ReviewerBrowserProfile> {
    const current = profiles.get(profileId);
    if (!current) throw new Error("Reviewer browser profile is not registered.");
    if (manualProcesses.has(profileId)) throw new Error("Manual authentication owns this profile; complete or stop that handoff first.");
    const requestedMode = mode ?? current.mode;
    const existing = processes.get(profileId);
    if (existing) {
      if (current.mode === requestedMode) return current;
      return switchModeOnce(profileId, requestedMode);
    }
    const starting = profiles.transition({ profileId, expectedGeneration: current.generation, status: "starting", mode: requestedMode });
    try {
      const profileDirectory = await profiles.profileDirectory(profileId);
      const chrome = await launchControlled({
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

  function runProfileFlight<T>(profileId: string, operationKey: string, operation: () => Promise<T>): Promise<T> {
    const flight = profileFlights.get(profileId);
    if (flight) {
      if (flight.operation !== operationKey) return Promise.reject(new Error("A reviewer browser profile operation is already running; wait for that generation to finish."));
      return flight.promise as Promise<T>;
    }
    const promise = operation().finally(() => {
      if (profileFlights.get(profileId)?.promise === promise) profileFlights.delete(profileId);
    });
    profileFlights.set(profileId, { operation: operationKey, promise });
    return promise;
  }

  function startProfile(profileId: string, mode?: ReviewerBrowserMode): Promise<ReviewerBrowserProfile> {
    const current = profiles.get(profileId);
    if (!current) return Promise.reject(new Error("Reviewer browser profile is not registered."));
    const requestedMode = mode ?? current.mode;
    return runProfileFlight(profileId, `mode:${requestedMode}`, () => startProfileOnce(profileId, requestedMode));
  }

  async function stopProfileOnce(profileId: string): Promise<ReviewerBrowserProfile> {
    const current = profiles.get(profileId);
    if (!current) throw new Error("Reviewer browser profile is not registered.");
    if (activeForProfile(profileId)) throw new Error("A browser dispatch is still running; wait for it to finish or become explicitly uncertain before stopping Chromium.");
    const manual = manualProcesses.get(profileId);
    if (manual) {
      const closed = await manual.close();
      if (!closed) throw new Error("Manual Chrome is still shutting down; retry after it exits.");
      manualProcesses.delete(profileId);
    }
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

  async function switchModeOnce(profileId: string, mode: ReviewerBrowserMode): Promise<ReviewerBrowserProfile> {
    const current = profiles.get(profileId);
    if (!current) throw new Error("Reviewer browser profile is not registered.");
    if (manualProcesses.has(profileId)) throw new Error("Manual authentication owns this profile; complete or stop that handoff first.");
    if (current.mode === mode && processes.has(profileId)) return current;
    if (activeForProfile(profileId)) throw new Error("Cannot switch headed/headless mode while a browser dispatch is running.");
    const chrome = processes.get(profileId);
    if (chrome) {
      await chrome.close();
      processes.delete(profileId);
    }
    const stopped = profiles.get(profileId)!;
    if (stopped.status !== "stopped") profiles.transition({ profileId, expectedGeneration: stopped.generation, status: "stopped" });
    return startProfileOnce(profileId, mode);
  }

  function switchMode(profileId: string, mode: ReviewerBrowserMode): Promise<ReviewerBrowserProfile> {
    if (!profiles.get(profileId)) return Promise.reject(new Error("Reviewer browser profile is not registered."));
    return runProfileFlight(profileId, `mode:${mode}`, () => switchModeOnce(profileId, mode));
  }

  function stopProfile(profileId: string): Promise<ReviewerBrowserProfile> {
    return runProfileFlight(profileId, "stop", () => stopProfileOnce(profileId));
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

  async function beginManualAuthenticationOnce(profileId: string): Promise<{ profileId: string; generation: number; browserPid?: number }> {
    let profile = profiles.get(profileId);
    if (!profile) throw new Error("Reviewer browser profile is not registered.");
    if (manualProcesses.has(profileId)) throw new Error("Manual authentication is already running for this reviewer profile.");
    if (activeForProfile(profileId)) throw new Error("An active browser dispatch must finish or become recoverable before authentication mode can change.");
    const currentChrome = processes.get(profileId);
    if (currentChrome) {
      await currentChrome.close();
      processes.delete(profileId);
    }
    const current = profiles.get(profileId)!;
    const starting = profiles.transition({ profileId, expectedGeneration: current.generation, status: "starting", mode: "headed", authState: "manual_auth_in_progress" });
    try {
      const profileDirectory = await profiles.profileDirectory(profileId);
      const manual = await launchManual({
        profileDirectory, generation: starting.generation, chromePath: input.chromePath, environment: input.environment,
      });
      manualProcesses.set(profileId, manual);
      const inProgress = profiles.transition({ profileId, expectedGeneration: starting.generation, status: "login_required", authState: "manual_auth_in_progress", mode: "headed" });
      return { profileId, generation: inProgress.generation, ...(manual.browserPid ? { browserPid: manual.browserPid } : {}) };
    } catch (error) {
      const latest = profiles.get(profileId);
      if (latest?.generation === starting.generation) profiles.transition({ profileId, expectedGeneration: starting.generation, status: "blocked", authState: "auth_blocked" });
      throw error;
    }
  }

  function beginManualAuthentication(profileId: string): Promise<{ profileId: string; generation: number; browserPid?: number }> {
    return runProfileFlight(profileId, "manual-auth:start", () => beginManualAuthenticationOnce(profileId));
  }

  async function completeManualAuthenticationOnce(profileId: string): Promise<{ status: "authenticated" | "auth_required" | "auth_blocked"; reason?: string; targets: Array<{ targetId: string; url: string; title: string }> }> {
    const manual = manualProcesses.get(profileId);
    let profile = profiles.get(profileId);
    if (!profile) throw new Error("Reviewer browser profile is not registered.");
    if (!manual) throw new Error("No manual authentication handoff is active for this profile.");
    if (!manual.hasExited()) {
      profiles.transition({ profileId, expectedGeneration: profile.generation, status: "login_required", authState: "handoff_pending" });
      return { status: "auth_required", reason: "close_all_chrome_windows_before_handoff", targets: [] };
    }
    try { await manual.releaseAfterExit(); }
    catch (error) {
      profiles.transition({ profileId, expectedGeneration: profile.generation, status: "login_required", authState: "handoff_pending" });
      return { status: "auth_required", reason: error instanceof Error ? error.message.slice(0, 240) : "profile_still_owned", targets: [] };
    }
    manualProcesses.delete(profileId);
    const starting = profiles.transition({ profileId, expectedGeneration: profile.generation, status: "starting", mode: "headed", authState: "handoff_pending" });
    try {
      const profileDirectory = await profiles.profileDirectory(profileId);
      const chrome = await launchControlled({ profileDirectory, generation: starting.generation, mode: "headed", chromePath: input.chromePath, environment: input.environment });
      processes.set(profileId, chrome);
      profile = profiles.transition({ profileId, expectedGeneration: starting.generation, status: "ready", mode: "headed", authState: "handoff_pending" });
      const listed = await chrome.cdp.send<{ targetInfos?: Array<{ targetId: string; type: string; url: string; title?: string }> }>("Target.getTargets");
      const candidates = (listed.targetInfos ?? []).filter((target) => target.type === "page" && /^https:\/\/([a-z0-9-]+\.)?chatgpt\.com\//i.test(target.url));
      let authenticated = false;
      let blocked = false;
      let unsupportedBrowser = false;
      for (const target of candidates) {
        let sessionId: string | undefined;
        try {
          const attached = await chrome.cdp.send<{ sessionId?: string }>("Target.attachToTarget", { targetId: target.targetId, flatten: true });
          sessionId = attached.sessionId;
          if (!sessionId) continue;
          await chrome.cdp.send("Runtime.enable", {}, sessionId);
          const observed = await chrome.cdp.send<{ result?: { value?: { authenticated: boolean; loginRequired: boolean; verificationRequired: boolean; unsupportedBrowser: boolean } } }>("Runtime.evaluate", {
            expression: `(() => { const u=new URL(location.href), body=(document.body?.innerText||'').toLowerCase(); const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'}; const composer=[...document.querySelectorAll('#prompt-textarea,[data-testid="prompt-textarea"],[contenteditable="true"][role="textbox"]')].some(visible); return {loginRequired:/^\\/(auth\\/(login|signin)|login)/.test(u.pathname),verificationRequired:['verify you are human','security check','complete the captcha'].some(x=>body.includes(x)),unsupportedBrowser:['insecure browser','unsupported browser','browser may not be secure'].some(x=>body.includes(x)),authenticated:composer}; })()`,
            returnByValue: true,
          }, sessionId);
          const value = observed.result?.value;
          if (value?.verificationRequired) blocked = true;
          if (value?.unsupportedBrowser) { blocked = true; unsupportedBrowser = true; }
          if (value?.authenticated && !value.loginRequired && !value.verificationRequired && !value.unsupportedBrowser) authenticated = true;
        } catch { /* classify from another visible ChatGPT tab if one exists */ }
        finally { if (sessionId) await chrome.cdp.send("Target.detachFromTarget", { sessionId }).catch(() => undefined); }
      }
      const targets = candidates.map(({ targetId, url, title }) => ({ targetId, url: url.slice(0, 500), title: (title ?? "").slice(0, 160) }));
      if (authenticated) {
        profiles.transition({ profileId, expectedGeneration: profile.generation, status: "ready", authState: "authenticated", verified: true });
        return { status: "authenticated", targets };
      }
      const reason = blocked
        ? unsupportedBrowser ? "identity_provider_unsupported_browser_after_handoff" : "verification_required_after_browser_handoff"
        : candidates.length ? "chatgpt_session_not_authenticated_after_browser_handoff" : "no_chatgpt_tab_after_browser_handoff";
      profiles.transition({ profileId, expectedGeneration: profile.generation, status: blocked ? "blocked" : "login_required", authState: blocked ? "auth_blocked" : "manual_auth_required" });
      return { status: blocked ? "auth_blocked" : "auth_required", reason, targets };
    } catch (error) {
      const latest = profiles.get(profileId);
      if (latest) profiles.transition({ profileId, expectedGeneration: latest.generation, status: "blocked", authState: "auth_blocked" });
      return { status: "auth_blocked", reason: error instanceof Error ? error.message.slice(0, 240) : "controlled_browser_start_failed", targets: [] };
    }
  }

  function completeManualAuthentication(profileId: string): Promise<{ status: "authenticated" | "auth_required" | "auth_blocked"; reason?: string; targets: Array<{ targetId: string; url: string; title: string }> }> {
    return runProfileFlight(profileId, "manual-auth:complete", () => completeManualAuthenticationOnce(profileId));
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
      // Binding changes are serialized against durable browser-turn claims.
      // A turn that already crossed into any active state keeps the current
      // route and conversation fence until it settles or is explicitly
      // reconciled; it must not race a new target binding.
      const activeTurn = input.database.sqlite.prepare(`select id from review_browser_turns
        where review_thread_id = ? and state in
          ('leased', 'browser_ready', 'dispatching', 'prompt_accepted', 'model_generating', 'generation_finished', 'awaiting_feedback', 'uncertain')
        limit 1`).get(thread.id);
      if (activeTurn) return "active_turn" as const;
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
      if (updated.changes !== 1) return "thread_revision_conflict" as const;
      const messages = input.database.db.select().from(reviewThreadMessages).where(eq(reviewThreadMessages.threadId, thread.id)).all();
      for (const message of messages) {
        if (message.status === "queued") input.dispatchOutbox?.enqueue({
          eventType: "reviewer.browser_turn.ready",
          aggregateId: message.id,
          aggregateRevision: message.revision,
          payload: { messageId: message.id, threadId: thread.id, profileId: profile.id, routeEpoch: thread.routeEpoch, revision: message.revision },
        });
      }
      return "committed" as const;
    })();
    if (committed !== "committed") {
      await chrome.cdp.send("Target.detachFromTarget", { sessionId: result.target.sessionId }).catch(() => undefined);
      if (committed === "active_turn") throw new Error("Reviewer conversation binding is fenced by an active browser turn.");
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
    const restoredBinding = input.database.db.update(reviewThreads).set({
      browserGeneration: profile.generation,
      browserTargetId: target.targetId,
      browserCdpSessionId: target.sessionId,
      conversationBindingStatus: "bound",
      revision: thread.revision + 1,
    }).where(and(eq(reviewThreads.id, thread.id), eq(reviewThreads.revision, thread.revision))).run();
    if (restoredBinding.changes !== 1) {
      await chrome.cdp.send("Target.detachFromTarget", { sessionId: target.sessionId }).catch(() => undefined);
      throw new Error("Reviewer conversation restoration lost its thread revision compare-and-swap; recovery is required.");
    }
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
    beginManualAuthentication,
    completeManualAuthentication,
    bindConversation,
    restoreThread,
    async close() {
      for (const [profileId, manual] of manualProcesses) {
        const closed = await manual.close();
        if (!closed) throw new Error(`Manual Chrome for reviewer profile ${profileId} did not exit during shutdown.`);
        manualProcesses.delete(profileId);
      }
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
