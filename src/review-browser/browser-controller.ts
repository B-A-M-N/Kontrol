import { and, eq, inArray } from "drizzle-orm";
import type { DatabaseHandle } from "../db/client.js";
import { reviewBrowserProfiles, reviewRoutes, reviewThreads, reviewBrowserTurns, reviewThreadMessages } from "../db/schema.js";
import type { DispatchOutbox } from "../dispatch-outbox.js";
import { inspectChromeProfileOwner, inspectOwnedProcess, launchManualAuthenticationChrome, launchOrReconnectChrome, type ManualChromeAuthentication, type OwnedChrome } from "./chrome-process.js";
import { BrowserReadinessError, ChatGptPageDriver } from "./chatgpt-page-driver.js";
import type { BrowserReadiness } from "./chatgpt-page-driver.js";
import { createReviewerBrowserProfileStore, type ReviewerBrowserMode, type ReviewerBrowserProfile, type ReviewerBrowserProfileStore } from "./profile-store.js";
import { bindReviewerTarget, canonicalReviewerConversation, restoreReviewerTarget, reviewerConversationFingerprint, ReviewerTargetError, type BoundReviewerTarget, type ReviewerTabBinding } from "./target-binding.js";

const LIVE_DISPATCH_STATES = ["leased", "browser_ready", "dispatching", "model_generating"];
const AUTH_BLOCKED_STATUSES = new Set(["login_required", "verification_required", "identity_provider_rejected", "identity_provider_unsupported_browser", "session_expired", "authentication_handoff_failed", "connector_authorization_required"]);
const REVIEW_TURN_EVENT = "reviewer.browser_turn.ready";
const AUTH_SUSPENSION_PREFIX = "review_browser_auth_suspended:";
const BINDING_SUSPENSION_PREFIX = "reviewer.browser_binding_suspended:";

export class ManualAuthenticationRequiredError extends Error {
  readonly code = "manual_authentication_required";
  readonly retryable = false;
  readonly requiredAction = "begin_reviewer_browser_auth";
  constructor() {
    super("Sign in through begin_reviewer_browser_auth in ordinary Chrome; controlled-browser login is disabled.");
    this.name = "ManualAuthenticationRequiredError";
  }
}

export interface ReviewerBrowserController {
  profiles: ReviewerBrowserProfileStore;
  createProfile(input: { profileId: string; ownerPrincipalId: string; mode?: ReviewerBrowserMode }): ReviewerBrowserProfile;
  startProfile(profileId: string, mode?: ReviewerBrowserMode): Promise<ReviewerBrowserProfile>;
  stopProfile(profileId: string): Promise<ReviewerBrowserProfile>;
  switchMode(profileId: string, mode: ReviewerBrowserMode): Promise<ReviewerBrowserProfile>;
  openLoginPage(profileId: string): Promise<{ targetId: string; sessionId: string }>;
  beginManualAuthentication(profileId: string): Promise<{ profileId: string; generation: number; browserPid?: number; browserProduct: string; remoteDebuggingEnabled: false; browserLaunchDiagnostic: string }>;
  completeManualAuthentication(profileId: string): Promise<{ status: "authenticated" | "auth_required" | "auth_blocked"; reason?: string; targets: Array<{ targetId: string; url: string; title: string }> }>;
  bindConversation(input: { profileId: string; reviewThreadId: string; targetId: string; principalId: string }): Promise<ReviewerTabBinding>;
  requireBindingRecovery(reviewThreadId: string, reason: string): void;
  restoreThread(reviewThreadId: string): Promise<{ target: BoundReviewerTarget; driver: ChatGptPageDriver; readiness?: BrowserReadiness }>;
  inspectHealth(profileId: string): Promise<{
    browserProcess: "running" | "manual_authentication" | "ownership_unknown" | "not_attached" | "stopped";
    cdpConnection: "connected" | "disconnected" | "disabled" | "not_attached";
    authState: string;
    lastVerifiedAt?: string;
    browserProduct?: string;
    remoteDebuggingEnabled?: boolean;
    browserLaunchDiagnostic?: string;
    bindings: { bound: number; recoveryRequired: number; other: number };
    dispatch: { queued: number; active: number; uncertain: number; blocked: number };
  }>;
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
    if (["manual_auth_in_progress", "handoff_pending"].includes(current.authState)) {
      throw new Error("A durable manual-auth handoff is unresolved; call complete_reviewer_browser_auth to reconcile it before starting controlled Chrome.");
    }
    const requestedMode = mode ?? current.mode;
    const existing = processes.get(profileId);
    if (existing) {
      if (current.mode === requestedMode) return current;
      return switchModeOnce(profileId, requestedMode);
    }
    const starting = profiles.transition({ profileId, expectedGeneration: current.generation, status: "starting", mode: requestedMode, authState: "unknown" });
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
      const ready = profiles.transition({
        profileId, expectedGeneration: starting.generation, status: "ready", mode: requestedMode,
        authState: "unknown", browserReady: true,
        browserLaunch: {
          product: chrome.launchDiagnostics.product,
          remoteDebuggingEnabled: chrome.launchDiagnostics.remoteDebuggingEnabled,
          diagnostic: chrome.launchDiagnostics.stderr,
        },
      });
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
    if (!manual && current.manualAuthPid) {
      const owner = await inspectOwnedProcess({
        pid: current.manualAuthPid,
        processStartIdentity: current.manualAuthProcessStartIdentity,
        bootIdentity: current.manualAuthBootIdentity,
      });
      if (owner === "same" || owner === "unknown") {
        throw new Error("Manual Chrome ownership is live or ambiguous; close that browser and complete the authentication handoff before stopping the profile.");
      }
    }
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
    return profiles.transition({
      profileId, expectedGeneration: latest.generation, status: "stopped",
      ...(manual || current.manualAuthPid ? { authState: "manual_auth_required" as const, clearManualAuthOwner: true } : {}),
    });
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
    if (!profiles.get(profileId)) throw new Error("Reviewer browser profile is not registered.");
    throw new ManualAuthenticationRequiredError();
  }

  async function beginManualAuthenticationOnce(profileId: string): Promise<{ profileId: string; generation: number; browserPid?: number; browserProduct: string; remoteDebuggingEnabled: false; browserLaunchDiagnostic: string }> {
    let profile = profiles.get(profileId);
    if (!profile) throw new Error("Reviewer browser profile is not registered.");
    if (manualProcesses.has(profileId)) throw new Error("Manual authentication is already running for this reviewer profile.");
    if (["manual_auth_in_progress", "handoff_pending"].includes(profile.authState)) {
      throw new Error("A durable manual-auth handoff is unresolved; complete or reconcile it before beginning another handoff.");
    }
    if (activeForProfile(profileId)) throw new Error("An active browser dispatch must finish or become recoverable before authentication mode can change.");
    const currentChrome = processes.get(profileId);
    if (currentChrome) {
      await currentChrome.close();
      processes.delete(profileId);
    }
    const current = profiles.get(profileId)!;
    const starting = profiles.transition({ profileId, expectedGeneration: current.generation, status: "starting", mode: "headed", authState: "manual_auth_in_progress", clearManualAuthOwner: true });
    try {
      const profileDirectory = await profiles.profileDirectory(profileId);
      const manual = await launchManual({
        profileDirectory, generation: starting.generation, chromePath: input.chromePath, environment: input.environment,
      });
      manualProcesses.set(profileId, manual);
      const launchDiagnostic = manual.launchDiagnostic();
      const inProgress = profiles.transition({
        profileId, expectedGeneration: starting.generation, status: "login_required", authState: "manual_auth_in_progress", mode: "headed",
        ...(manual.browserPid ? { manualAuthOwner: {
          pid: manual.browserPid, generation: starting.generation,
          processStartIdentity: manual.processStartIdentity, bootIdentity: manual.bootIdentity,
        } } : {}),
        browserLaunch: { product: manual.browserProduct, remoteDebuggingEnabled: false, diagnostic: launchDiagnostic },
      });
      return {
        profileId, generation: inProgress.generation,
        ...(manual.browserPid ? { browserPid: manual.browserPid } : {}),
        browserProduct: manual.browserProduct,
        remoteDebuggingEnabled: false,
        browserLaunchDiagnostic: launchDiagnostic,
      };
    } catch (error) {
      const latest = profiles.get(profileId);
      if (latest?.generation === starting.generation) profiles.transition({ profileId, expectedGeneration: starting.generation, status: "blocked", authState: "auth_blocked" });
      throw error;
    }
  }

  function beginManualAuthentication(profileId: string): Promise<{ profileId: string; generation: number; browserPid?: number; browserProduct: string; remoteDebuggingEnabled: false; browserLaunchDiagnostic: string }> {
    return runProfileFlight(profileId, "manual-auth:start", () => beginManualAuthenticationOnce(profileId));
  }

  async function completeManualAuthenticationOnce(profileId: string): Promise<{ status: "authenticated" | "auth_required" | "auth_blocked"; reason?: string; targets: Array<{ targetId: string; url: string; title: string }> }> {
    const manual = manualProcesses.get(profileId);
    let profile = profiles.get(profileId);
    if (!profile) throw new Error("Reviewer browser profile is not registered.");
    if (manual) {
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
    } else {
      if (!["manual_auth_in_progress", "handoff_pending"].includes(profile.authState)) {
        throw new Error("No durable manual authentication handoff can be reconciled for this profile.");
      }
      if (profile.manualAuthPid) {
        if (profile.manualAuthGeneration !== profile.generation) {
          profiles.transition({ profileId, expectedGeneration: profile.generation, status: "login_required", authState: "handoff_pending" });
          return { status: "auth_required", reason: "manual_browser_owner_unverified", targets: [] };
        }
        const ownership = await inspectOwnedProcess({
          pid: profile.manualAuthPid,
          processStartIdentity: profile.manualAuthProcessStartIdentity,
          bootIdentity: profile.manualAuthBootIdentity,
        });
        if (ownership === "same") {
          profiles.transition({ profileId, expectedGeneration: profile.generation, status: "login_required", authState: "handoff_pending" });
          return { status: "auth_required", reason: "close_all_chrome_windows_before_handoff", targets: [] };
        }
        if (ownership === "unknown") {
          profiles.transition({ profileId, expectedGeneration: profile.generation, status: "login_required", authState: "handoff_pending" });
          return { status: "auth_required", reason: "manual_browser_owner_unverified", targets: [] };
        }
      }
      // The controller may have crashed after Chrome acquired the profile but
      // before its PID was persisted. Reconcile Chrome's own singleton lock
      // before starting a CDP-controlled generation.
      const profileDirectory = await profiles.profileDirectory(profileId);
      const profileOwner = await inspectChromeProfileOwner(profileDirectory);
      if (profileOwner.status === "unknown") {
        profiles.transition({ profileId, expectedGeneration: profile.generation, status: "login_required", authState: "handoff_pending" });
        return { status: "auth_required", reason: "manual_browser_owner_unverified", targets: [] };
      }
      if (profileOwner.status === "owned" && profileOwner.pid && !profileOwner.remoteDebuggingEnabled) {
        profiles.transition({
          profileId, expectedGeneration: profile.generation, status: "login_required", authState: "handoff_pending",
          manualAuthOwner: { pid: profileOwner.pid, generation: profile.generation,
            processStartIdentity: profileOwner.processStartIdentity, bootIdentity: profileOwner.bootIdentity },
        });
        return { status: "auth_required", reason: "close_all_chrome_windows_before_handoff", targets: [] };
      }
      // A surviving loopback-CDP generation can be safely reattached by the
      // normal exclusive controller lock and then subjected to a fresh auth
      // observation. An ordinary non-CDP Chrome owner above must never be
      // attached to or launched over.
    }
    const starting = profiles.transition({ profileId, expectedGeneration: profile.generation, status: "starting", mode: "headed", authState: "handoff_pending", clearManualAuthOwner: true });
    try {
      const profileDirectory = await profiles.profileDirectory(profileId);
      const chrome = await launchControlled({ profileDirectory, generation: starting.generation, mode: "headed", chromePath: input.chromePath, environment: input.environment });
      processes.set(profileId, chrome);
      profile = profiles.transition({
        profileId, expectedGeneration: starting.generation, status: "ready", mode: "headed", authState: "handoff_pending",
        browserReady: true, browserLaunch: {
          product: chrome.launchDiagnostics.product,
          remoteDebuggingEnabled: chrome.launchDiagnostics.remoteDebuggingEnabled,
          diagnostic: chrome.launchDiagnostics.stderr,
        },
      });
      let listed = await chrome.cdp.send<{ targetInfos?: Array<{ targetId: string; type: string; url: string; title?: string }> }>("Target.getTargets");
      let candidates = (listed.targetInfos ?? []).filter((target) => target.type === "page" && /^https:\/\/([a-z0-9-]+\.)?chatgpt\.com\//i.test(target.url));
      let identityProviderRedirect = false;
      let navigationUnconfirmed = false;
      if (candidates.length === 0) {
        // Chrome does not promise to restore the manually used tab. Create one
        // bounded diagnostic tab and inspect its actual destination; never
        // automate credentials or follow an identity-provider challenge.
        const created = await chrome.cdp.send<{ targetId?: string }>("Target.createTarget", { url: "https://chatgpt.com/" });
        if (!created.targetId) throw new Error("Could not open a diagnostic ChatGPT tab after browser handoff.");
        const deadline = Date.now() + 10_000;
        let diagnostic: { targetId: string; type: string; url: string; title?: string } | undefined;
        let priorUrl = "";
        let stableUrlReads = 0;
        while (Date.now() < deadline) {
          listed = await chrome.cdp.send("Target.getTargets");
          diagnostic = (listed.targetInfos ?? []).find((target) => target.targetId === created.targetId && target.type === "page");
          const settledCandidate = diagnostic?.url && diagnostic.url !== "about:blank" && !diagnostic.url.startsWith("chrome://newtab");
          if (diagnostic && settledCandidate && diagnostic.url === priorUrl) stableUrlReads += 1;
          else stableUrlReads = 0;
          priorUrl = diagnostic?.url ?? "";
          if (stableUrlReads >= 3) break;
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
        }
        if (!diagnostic || diagnostic.url === "about:blank" || diagnostic.url.startsWith("chrome://newtab")) navigationUnconfirmed = true;
        else {
          try { new URL(diagnostic.url); } catch { navigationUnconfirmed = true; }
          if (/^https:\/\/accounts\.google\.com\//i.test(diagnostic.url)) identityProviderRedirect = true;
          candidates = [diagnostic].filter((target) => /^https:\/\/([a-z0-9-]+\.)?chatgpt\.com\//i.test(target.url));
        }
      }
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
          const observed = await chrome.cdp.send<{ result?: { value?: { url?: string; authenticated: boolean; loginRequired: boolean; verificationRequired: boolean; unsupportedBrowser: boolean } } }>("Runtime.evaluate", {
            expression: `(() => { const u=new URL(location.href); if(!/(^|\\.)chatgpt\\.com$/i.test(u.hostname)) return {url:u.href,authenticated:false,loginRequired:false,verificationRequired:false,unsupportedBrowser:false}; const body=(document.body?.innerText||'').toLowerCase(); const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'}; const composer=[...document.querySelectorAll('#prompt-textarea,[data-testid="prompt-textarea"],[contenteditable="true"][role="textbox"]')].some(visible); return {url:u.href,loginRequired:/^\\/(auth\\/(login|signin)|login)/.test(u.pathname),verificationRequired:['verify you are human','security check','complete the captcha'].some(x=>body.includes(x)),unsupportedBrowser:['insecure browser','unsupported browser','browser may not be secure'].some(x=>body.includes(x)),authenticated:composer}; })()`,
            returnByValue: true,
          }, sessionId);
          const value = observed.result?.value;
          if (value?.url) {
            try {
              const observedUrl = new URL(value.url);
              if (observedUrl.hostname.toLowerCase() === "accounts.google.com") identityProviderRedirect = true;
              else if (!/(^|\.)chatgpt\.com$/i.test(observedUrl.hostname)) navigationUnconfirmed = true;
            } catch { navigationUnconfirmed = true; }
          }
          if (value?.verificationRequired) blocked = true;
          if (value?.unsupportedBrowser) { blocked = true; unsupportedBrowser = true; }
          if (value?.authenticated && !value.loginRequired && !value.verificationRequired && !value.unsupportedBrowser) authenticated = true;
        } catch { /* classify from another visible ChatGPT tab if one exists */ }
        finally { if (sessionId) await chrome.cdp.send("Target.detachFromTarget", { sessionId }).catch(() => undefined); }
      }
      const targets = candidates.map(({ targetId, url, title }) => ({ targetId, url: url.slice(0, 500), title: (title ?? "").slice(0, 160) }));
      if (authenticated) {
        profiles.transition({ profileId, expectedGeneration: profile.generation, status: "ready", authState: "authenticated", verified: true, clearManualAuthOwner: true });
        input.dispatchOutbox?.resumeSuspended(REVIEW_TURN_EVENT, "profileId", profileId, AUTH_SUSPENSION_PREFIX);
        return { status: "authenticated", targets };
      }
      const reason = blocked
        ? unsupportedBrowser ? "identity_provider_unsupported_browser_after_handoff" : "verification_required_after_browser_handoff"
        : identityProviderRedirect ? "identity_provider_rejected_after_handoff"
          : navigationUnconfirmed ? "navigation_unconfirmed_after_browser_handoff"
            : candidates.length ? "chatgpt_session_not_authenticated_after_browser_handoff" : "no_chatgpt_tab_after_browser_handoff";
      const authBlocked = blocked || identityProviderRedirect;
      profiles.transition({ profileId, expectedGeneration: profile.generation, status: authBlocked ? "blocked" : "login_required", authState: authBlocked ? "auth_blocked" : "manual_auth_required", clearManualAuthOwner: true });
      return { status: authBlocked ? "auth_blocked" : "auth_required", reason, targets };
    } catch (error) {
      const latest = profiles.get(profileId);
      if (latest) profiles.transition({ profileId, expectedGeneration: latest.generation, status: "blocked", authState: "auth_blocked", clearManualAuthOwner: true });
      return { status: "auth_blocked", reason: error instanceof Error ? error.message.slice(0, 240) : "controlled_browser_start_failed", targets: [] };
    }
  }

  function completeManualAuthentication(profileId: string): Promise<{ status: "authenticated" | "auth_required" | "auth_blocked"; reason?: string; targets: Array<{ targetId: string; url: string; title: string }> }> {
    return runProfileFlight(profileId, "manual-auth:complete", () => completeManualAuthenticationOnce(profileId));
  }

  async function bindConversation(bindingInput: { profileId: string; reviewThreadId: string; targetId: string; principalId: string }): Promise<ReviewerTabBinding> {
    let profile = profiles.get(bindingInput.profileId);
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
    let result: Awaited<ReturnType<typeof bindReviewerTarget>>;
    try {
      result = await bindReviewerTarget({
        cdp: chrome.cdp,
        profileId: profile.id,
        reviewThreadId: thread.id,
        browserGeneration: profile.generation,
        targetId: bindingInput.targetId,
        bindingRevision: revision,
      });
    } catch (error) {
      if (error instanceof ReviewerTargetError && error.code === "identity_provider_rejected") {
        profiles.transition({ profileId: profile.id, expectedGeneration: profile.generation, status: "blocked", authState: "auth_blocked" });
      }
      throw error;
    }
    await chrome.cdp.send("Page.enable", {}, result.target.sessionId);
    await chrome.cdp.send("Runtime.enable", {}, result.target.sessionId);
    const pageDriver = new ChatGptPageDriver(chrome.cdp, result.target);
    const readiness = await pageDriver.inspect(result.binding.conversationKey);
    if (readiness.status !== "ready" && readiness.status !== "generation_active") {
      if (AUTH_BLOCKED_STATUSES.has(readiness.status)) {
        profiles.transition({
          profileId: profile.id, expectedGeneration: profile.generation,
          status: readiness.status === "login_required" ? "login_required" : "blocked",
          authState: readiness.status === "login_required" ? "manual_auth_required" : "auth_blocked",
        });
      }
      await chrome.cdp.send("Target.detachFromTarget", { sessionId: result.target.sessionId }).catch(() => undefined);
      throw new Error(`The selected conversation is not currently authenticated and ready: ${readiness.status}.`);
    }
    profile = profiles.transition({
      profileId: profile.id, expectedGeneration: profile.generation,
      status: readiness.status === "generation_active" ? "busy" : "ready",
      authState: "authenticated", verified: true,
    });
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
    input.dispatchOutbox?.resumeSuspended(REVIEW_TURN_EVENT, "profileId", profile.id, AUTH_SUSPENSION_PREFIX);
    input.dispatchOutbox?.resumeSuspended(REVIEW_TURN_EVENT, "threadId", thread.id, BINDING_SUSPENSION_PREFIX);
    return result.binding;
  }

  function requireBindingRecovery(reviewThreadId: string, reason: string): void {
    if (!["wrong_conversation", "target_ambiguous", "recovery_required"].includes(reason)) {
      throw new Error("Only an exact-conversation identity failure can require binding recovery.");
    }
    const thread = input.database.db.select().from(reviewThreads).where(eq(reviewThreads.id, reviewThreadId)).get();
    if (!thread || thread.conversationBindingStatus !== "bound") return;
    input.database.db.update(reviewThreads).set({ conversationBindingStatus: "recovery_required", revision: thread.revision + 1 })
      .where(and(eq(reviewThreads.id, thread.id), eq(reviewThreads.revision, thread.revision), eq(reviewThreads.conversationBindingStatus, "bound"))).run();
  }

  async function restoreThread(reviewThreadId: string): Promise<{ target: BoundReviewerTarget; driver: ChatGptPageDriver; readiness?: BrowserReadiness }> {
    const thread = input.database.db.select().from(reviewThreads).where(eq(reviewThreads.id, reviewThreadId)).get();
    if (!thread || thread.status !== "active") throw new Error("Reviewer conversation thread is not active.");
    if (thread.conversationBindingStatus !== "bound" || !thread.browserProfileId
      || !thread.conversationUrl || !thread.conversationKey || !thread.conversationFingerprint) {
      throw new ReviewerTargetError("recovery_required", "Reviewer conversation requires explicit binding recovery.");
    }
    const route = input.database.db.select().from(reviewRoutes).where(eq(reviewRoutes.id, thread.routeId)).get();
    if (!route || route.status !== "active" || route.routeEpoch !== thread.routeEpoch || route.deliveryTransport !== "native_cdp"
      || route.browserProfileId !== thread.browserProfileId) throw new Error("Review route changed; browser conversation is fenced.");
    let profile = profiles.get(thread.browserProfileId);
    if (!profile) throw new Error("Bound reviewer browser profile is unavailable.");
    if (!processes.has(profile.id)) profile = await startProfile(profile.id);
    const chrome = processes.get(profile.id)!;
    const key = canonicalReviewerConversation(thread.conversationUrl).key;
    if (key !== thread.conversationKey || reviewerConversationFingerprint(key) !== thread.conversationFingerprint) throw new Error("Saved reviewer conversation identity does not match its canonical URL and fingerprint.");
    let target: BoundReviewerTarget;
    try {
      target = await restoreReviewerTarget({
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
    } catch (error) {
      if (error instanceof ReviewerTargetError && error.code === "identity_provider_rejected") {
        profiles.transition({ profileId: profile.id, expectedGeneration: profile.generation, status: "blocked", authState: "auth_blocked" });
        throw new BrowserReadinessError("identity_provider_rejected");
      }
      if (error instanceof ReviewerTargetError && ["wrong_conversation", "recovery_required", "target_ambiguous"].includes(error.code)) {
        input.database.db.update(reviewThreads).set({ conversationBindingStatus: "recovery_required", revision: thread.revision + 1 })
          .where(and(eq(reviewThreads.id, thread.id), eq(reviewThreads.revision, thread.revision), eq(reviewThreads.conversationBindingStatus, "bound"))).run();
      }
      if (error instanceof ReviewerTargetError && error.code === "navigation_unconfirmed") {
        throw new BrowserReadinessError("navigation_unconfirmed");
      }
      if (error instanceof ReviewerTargetError && error.code === "no_target") {
        throw new BrowserReadinessError("navigation_unconfirmed");
      }
      if (error instanceof ReviewerTargetError) throw error;
      profiles.transition({ profileId: profile.id, expectedGeneration: profile.generation, status: "recovering" });
      throw new BrowserReadinessError("browser_transport_failed");
    }
    const previousTarget = bindings.get(thread.id);
    let sessionCommitted = false;
    try {
      try {
        await chrome.cdp.send("Page.enable", {}, target.sessionId);
        await chrome.cdp.send("Runtime.enable", {}, target.sessionId);
      } catch {
        profiles.transition({ profileId: profile.id, expectedGeneration: profile.generation, status: "recovering" });
        throw new BrowserReadinessError("browser_transport_failed");
      }
      const driver = new ChatGptPageDriver(chrome.cdp, target);
      const readiness = await driver.inspect(key);
      if (readiness.status === "generation_active" || readiness.status === "ready") {
        profile = profiles.transition({
          profileId: profile.id, expectedGeneration: profile.generation,
          status: readiness.status === "generation_active" ? "busy" : "ready",
          authState: "authenticated", verified: true,
        });
        input.dispatchOutbox?.resumeSuspended(REVIEW_TURN_EVENT, "profileId", profile.id, AUTH_SUSPENSION_PREFIX);
      } else if (AUTH_BLOCKED_STATUSES.has(readiness.status)) {
        profiles.transition({
          profileId: profile.id, expectedGeneration: profile.generation,
          status: readiness.status === "login_required" ? "login_required" : "blocked",
          authState: readiness.status === "login_required" ? "manual_auth_required" : "auth_blocked",
        });
        throw new BrowserReadinessError(readiness.status);
      } else if (readiness.status === "wrong_conversation") {
        const status = "recovery_required";
        input.database.db.update(reviewThreads).set({ conversationBindingStatus: status, revision: thread.revision + 1 })
          .where(and(eq(reviewThreads.id, thread.id), eq(reviewThreads.revision, thread.revision))).run();
        throw new ReviewerTargetError("wrong_conversation", `Bound reviewer conversation is not ready: ${readiness.status}.`);
      } else {
        if (["browser_transport_failed", "browser_disconnected"].includes(readiness.status)) {
          profiles.transition({ profileId: profile.id, expectedGeneration: profile.generation, status: "recovering" });
        }
        throw new BrowserReadinessError(readiness.status);
      }
      const restoredBinding = input.database.db.update(reviewThreads).set({
        browserGeneration: profile.generation,
        browserTargetId: target.targetId,
        browserCdpSessionId: target.sessionId,
        conversationBindingStatus: "bound",
        revision: thread.revision + 1,
      }).where(and(eq(reviewThreads.id, thread.id), eq(reviewThreads.revision, thread.revision))).run();
      if (restoredBinding.changes !== 1) {
        throw new Error("Reviewer conversation restoration lost its thread revision compare-and-swap; recovery is required.");
      }
      sessionCommitted = true;
      bindings.set(thread.id, target);
      if (previousTarget && previousTarget.sessionId !== target.sessionId
        && previousTarget.browserGeneration === profile.generation) {
        await chrome.cdp.send("Target.detachFromTarget", { sessionId: previousTarget.sessionId }).catch(() => undefined);
      }
      return { target, driver, readiness };
    } finally {
      if (!sessionCommitted) {
        await chrome.cdp.send("Target.detachFromTarget", { sessionId: target.sessionId }).catch(() => undefined);
      }
    }
  }

  async function inspectHealth(profileId: string) {
    const profile = profiles.get(profileId);
    if (!profile) throw new Error("Reviewer browser profile is not registered.");
    const chrome = processes.get(profileId);
    const manualOwner = !manualProcesses.has(profileId) && profile.manualAuthPid
      ? await inspectOwnedProcess({ pid: profile.manualAuthPid, processStartIdentity: profile.manualAuthProcessStartIdentity, bootIdentity: profile.manualAuthBootIdentity })
      : undefined;
    const manualAuthentication = manualProcesses.has(profileId) || manualOwner === "same";
    let cdpConnection: "connected" | "disconnected" | "disabled" | "not_attached" = manualAuthentication
      ? "disabled" : chrome ? "disconnected" : "not_attached";
    if (chrome) {
      try {
        const version = await chrome.cdp.send<Record<string, unknown>>("Browser.getVersion", {}, undefined, 2_000);
        cdpConnection = version.product ? "connected" : "disconnected";
      } catch { cdpConnection = "disconnected"; }
    }
    const threadBindings = input.database.db.select({ status: reviewThreads.conversationBindingStatus })
      .from(reviewThreads).where(eq(reviewThreads.browserProfileId, profileId)).all();
    const turnStates = input.database.db.select({ state: reviewBrowserTurns.state })
      .from(reviewBrowserTurns).where(eq(reviewBrowserTurns.profileId, profileId)).all();
    const queuedRow = input.database.sqlite.prepare(`select count(*) as count from review_thread_messages m
      join review_threads t on t.id = m.thread_id where t.browser_profile_id = ? and m.status = 'queued'`).get(profileId) as { count: number };
    const activeStates = new Set(["leased", "browser_ready", "dispatching", "prompt_accepted", "model_generating", "generation_finished", "awaiting_feedback"]);
    return {
      browserProcess: manualAuthentication ? "manual_authentication" as const
        : manualOwner === "unknown" ? "ownership_unknown" as const
          : chrome ? "running" as const : profile.status === "stopped" ? "stopped" as const : "not_attached" as const,
      cdpConnection,
      authState: profile.authState,
      ...(profile.lastVerifiedAt ? { lastVerifiedAt: profile.lastVerifiedAt } : {}),
      ...(profile.browserProduct ? { browserProduct: profile.browserProduct } : {}),
      ...(profile.remoteDebuggingEnabled !== undefined ? { remoteDebuggingEnabled: profile.remoteDebuggingEnabled } : {}),
      ...(profile.browserLaunchDiagnostic !== undefined ? { browserLaunchDiagnostic: profile.browserLaunchDiagnostic } : {}),
      bindings: {
        bound: threadBindings.filter((binding) => binding.status === "bound").length,
        recoveryRequired: threadBindings.filter((binding) => binding.status === "recovery_required").length,
        other: threadBindings.filter((binding) => binding.status !== "bound" && binding.status !== "recovery_required").length,
      },
      dispatch: {
        queued: queuedRow.count,
        active: turnStates.filter((turn) => activeStates.has(turn.state)).length,
        uncertain: turnStates.filter((turn) => turn.state === "uncertain").length,
        blocked: turnStates.filter((turn) => ["blocked_auth", "blocked_browser", "failed"].includes(turn.state)).length,
      },
    };
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
    requireBindingRecovery,
    restoreThread,
    inspectHealth,
    async close() {
      for (const [profileId, manual] of manualProcesses) {
        const closed = await manual.close();
        if (!closed) throw new Error(`Manual Chrome for reviewer profile ${profileId} did not exit during shutdown.`);
        manualProcesses.delete(profileId);
      }
      for (const [profileId, chrome] of processes) {
        await chrome.close();
        processes.delete(profileId);
        const profile = profiles.get(profileId);
        if (profile && profile.status !== "stopped") profiles.transition({ profileId, expectedGeneration: profile.generation, status: "stopped" });
      }
      bindings.clear();
    },
  };
}
