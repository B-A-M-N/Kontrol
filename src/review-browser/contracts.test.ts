import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../db/client.js";
import { createReviewerBrowserProfileStore } from "./profile-store.js";
import { createReviewerBrowserController } from "./browser-controller.js";
import { createReviewRouteStore } from "../review-handoff/route-store.js";
import { createReviewThreadStore } from "../review-thread/thread-store.js";
import { bindReviewerTarget, canonicalReviewerConversation, restoreReviewerTarget, reviewerConversationFingerprint, ReviewerTargetError } from "./target-binding.js";
import type { CdpClient } from "./cdp-client.js";
import { BrowserReadinessError, ChatGptPageDriver, type TurnBaseline } from "./chatgpt-page-driver.js";
import type { BoundReviewerTarget } from "./target-binding.js";
import { acquireReviewerProfileLock, chromeArguments, inspectChromeProfileOwner, isOfficialChromeInstallPath } from "./chrome-process.js";
import { createReviewerTurnDispatcher } from "./turn-dispatcher.js";

const root = await realpath(await mkdtemp(join(tmpdir(), "kontrol-review-browser-test-")));
try {
  const canonical = canonicalReviewerConversation("https://www.chatgpt.com/c/conversation_12345678?foo=1#x");
  assert.deepEqual(canonical, { url: "https://chatgpt.com/c/conversation_12345678", key: "conversation_12345678" });
  assert.equal(reviewerConversationFingerprint(canonical.key).length, 64);
  const manualArgs = chromeArguments("/private/reviewer-profile", "manual_authentication");
  assert.ok(manualArgs.includes("https://chatgpt.com/"));
  assert.ok(manualArgs.includes("--user-data-dir=/private/reviewer-profile"));
  assert.equal(manualArgs.some((arg) => arg.includes("remote-debugging")), false, "manual authentication never starts Chrome with a debugging endpoint");
  const controlledArgs = chromeArguments("/private/reviewer-profile", "controlled_review", "headed");
  assert.ok(controlledArgs.includes("--remote-debugging-address=127.0.0.1"));
  assert.ok(controlledArgs.includes("--user-data-dir=/private/reviewer-profile"), "both modes use the same dedicated profile");
  assert.equal(isOfficialChromeInstallPath("linux", "/opt/google/chrome/google-chrome"), true);
  assert.equal(isOfficialChromeInstallPath("linux", "/tmp/custom-chromium"), false,
    "an explicitly configured arbitrary executable is not accepted for manual authentication");
  {
    const lockProfile = join(root, "lock-profile");
    await mkdir(lockProfile, { recursive: true, mode: 0o700 });
    await writeFile(join(lockProfile, "kontrol-controller.lock"), JSON.stringify({ pid: 2_000_000, generation: 8, lockId: "dead-owner" }));
    const acquisitions = await Promise.allSettled([
      acquireReviewerProfileLock(lockProfile, 9),
      acquireReviewerProfileLock(lockProfile, 10),
    ]);
    assert.equal(acquisitions.filter((result) => result.status === "fulfilled").length, 1,
      "concurrent controllers cannot both reclaim a conclusively dead owner's lock");
    const acquired = acquisitions.find((result): result is PromiseFulfilledResult<() => Promise<void>> => result.status === "fulfilled")!;
    const record = JSON.parse(await readFile(join(lockProfile, "kontrol-controller.lock"), "utf8")) as { pid: number; generation: number; lockId: string };
    assert.equal(record.pid, process.pid);
    assert.ok([9, 10].includes(record.generation));
    assert.notEqual(record.lockId, "dead-owner");
    await acquired.value();
    await writeFile(join(lockProfile, "kontrol-controller.lock"), JSON.stringify({ pid: process.pid, generation: 10, lockId: "live-owner" }));
    await assert.rejects(acquireReviewerProfileLock(lockProfile, 11), /owns this profile|cannot be verified/i,
      "a live owner cannot be displaced");
    const inaccessibleProfile = join(root, "inaccessible-lock-profile");
    await mkdir(inaccessibleProfile, { recursive: true, mode: 0o700 });
    const inaccessiblePid = 2_000_001;
    await writeFile(join(inaccessibleProfile, "kontrol-controller.lock"), JSON.stringify({ pid: inaccessiblePid, generation: 10, lockId: "inaccessible-owner" }));
    const originalKill = process.kill;
    process.kill = ((pid: number, signal?: number | NodeJS.Signals) => {
      if (pid === inaccessiblePid) throw Object.assign(new Error("permission denied"), { code: "EPERM" });
      return originalKill(pid, signal);
    }) as typeof process.kill;
    try {
      await assert.rejects(acquireReviewerProfileLock(inaccessibleProfile, 11), /owns this profile|cannot be verified/i,
        "an inaccessible owner is not mistaken for a stale lock");
    } finally { process.kill = originalKill; }
  }
  for (const url of ["http://chatgpt.com/c/conversation_12345678", "https://chatgpt.com/", "https://chatgpt.com/c/short", "https://evil.example/c/conversation_12345678"]) {
    assert.throws(() => canonicalReviewerConversation(url));
  }

  const targets = [{ targetId: "tab-1", type: "page", url: canonical.url, title: "Review" }];
  const commands: Array<{ method: string; params: Record<string, unknown> }> = [];
  const fakeCdp = {
    async send(method: string, params: Record<string, unknown> = {}) {
      commands.push({ method, params });
      if (method === "Target.getTargets") return { targetInfos: targets };
      if (method === "Target.attachToTarget") return { sessionId: "session-1" };
      if (method === "Target.createTarget") { targets.push({ targetId: "tab-2", type: "page", url: String(params.url), title: "Restored" }); return { targetId: "tab-2" }; }
      return {};
    },
  } as unknown as CdpClient;
  const { binding, target } = await bindReviewerTarget({ cdp: fakeCdp, profileId: "reviewer", reviewThreadId: "thread-1", browserGeneration: 2, targetId: "tab-1", bindingRevision: 1 });
  assert.equal(binding.conversationKey, canonical.key);
  assert.equal(target.targetId, "tab-1", "binding uses the explicitly selected target");
  const restored = await restoreReviewerTarget({ cdp: fakeCdp, binding: { ...binding, targetId: "closed-tab" }, browserGeneration: 3 });
  assert.equal(restored.targetId, "tab-1", "restoration finds the exact conversation instead of selecting the first tab");
  assert.equal(restored.browserGeneration, 3);
  targets[0]!.url = "https://accounts.google.com/signin";
  await assert.rejects(bindReviewerTarget({ cdp: fakeCdp, profileId: "reviewer", reviewThreadId: "thread-1", browserGeneration: 2, targetId: "tab-1", bindingRevision: 2 }),
    (error: unknown) => error instanceof Error && (error as { code?: string }).code === "identity_provider_rejected",
    "a selected identity-provider page is never treated as a conversation");
  await assert.rejects(restoreReviewerTarget({ cdp: fakeCdp, binding, browserGeneration: 3 }),
    (error: unknown) => error instanceof Error && (error as { code?: string }).code === "identity_provider_rejected",
    "restoration classifies a bound tab redirected to Google as an authentication block");
  targets[0]!.url = canonical.url;

  let racingReads = 0;
  let racingDetachCalls = 0;
  const racingCdp = {
    async send(method: string) {
      if (method === "Target.getTargets") {
        racingReads += 1;
        return { targetInfos: [{ targetId: "racing-tab", type: "page", url: racingReads === 1 ? canonical.url : "https://chatgpt.com/c/other_12345678", title: "Review" }] };
      }
      if (method === "Target.attachToTarget") return { sessionId: "racing-session" };
      if (method === "Target.detachFromTarget") { racingDetachCalls += 1; return {}; }
      return {};
    },
  } as unknown as CdpClient;
  await assert.rejects(bindReviewerTarget({ cdp: racingCdp, profileId: "reviewer", reviewThreadId: "thread-race", browserGeneration: 2, targetId: "racing-tab", bindingRevision: 1 }),
    (error: unknown) => error instanceof Error && (error as { code?: string }).code === "wrong_conversation",
    "a tab that changes conversations during attachment fails closed");
  assert.equal(racingDetachCalls, 1, "a failed exact-target attachment detaches its CDP session");

  const ambiguousCdp = {
    async send(method: string) {
      if (method === "Target.getTargets") return { targetInfos: [
        { targetId: "duplicate-a", type: "page", url: canonical.url, title: "Review A" },
        { targetId: "duplicate-b", type: "page", url: canonical.url, title: "Review B" },
      ] };
      return {};
    },
  } as unknown as CdpClient;
  await assert.rejects(restoreReviewerTarget({ cdp: ambiguousCdp, binding: { ...binding, targetId: "closed-tab" }, browserGeneration: 3 }),
    (error: unknown) => error instanceof Error && (error as { code?: string }).code === "target_ambiguous",
    "multiple tabs with the saved conversation require explicit recovery");

  const navigatingTargets: Array<{ targetId: string; type: string; url: string; title: string }> = [];
  let navigationReads = 0;
  const navigatingCdp = {
    async send(method: string, params: Record<string, unknown> = {}) {
      if (method === "Target.getTargets") {
        navigationReads += 1;
        const target = navigatingTargets[0];
        if (target && navigationReads >= 3) target.url = canonical.url;
        return { targetInfos: navigatingTargets };
      }
      if (method === "Target.createTarget") {
        navigatingTargets.push({ targetId: "navigating-tab", type: "page", url: "about:blank", title: "" });
        return { targetId: "navigating-tab" };
      }
      if (method === "Target.attachToTarget") return { sessionId: "navigating-session" };
      return {};
    },
  } as unknown as CdpClient;
  const navigated = await restoreReviewerTarget({
    cdp: navigatingCdp,
    binding: { ...binding, targetId: "closed-tab" },
    browserGeneration: 3,
  });
  assert.equal(navigated.targetId, "navigating-tab", "restoration waits for the exact new target to finish navigation");
  assert.ok(navigationReads >= 5, "restoration observes a stable exact conversation after navigation");

  const db = openDatabase(join(root, "state"));
  try {
    const profiles = createReviewerBrowserProfileStore(db, join(root, "state"));
    const profile = profiles.create({ id: "reviewer-default", ownerPrincipalId: "reviewer-1" });
    assert.equal(profile.status, "stopped");
    assert.equal(profile.authState, "unknown", "authentication status is independent of browser process status");
    const directory = await profiles.profileDirectory(profile.id);
    assert.ok(directory.startsWith(join(root, "state", "reviewer-browser", "profiles")));
    if (process.platform !== "win32") assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.throws(() => profiles.create({ id: "../outside", ownerPrincipalId: "reviewer-1" }));
    assert.throws(() => profiles.create({ id: "reviewer-default", ownerPrincipalId: "reviewer-2" }), /another principal/i);
  } finally { db.close(); }

  {
    const controllerDb = openDatabase(join(root, "controller-state"));
    let controlledLaunches = 0;
    let releaseInitialLaunch!: (value: any) => void;
    let releaseHandoffLaunch!: (value: any) => void;
    const initialLaunch = new Promise<any>((resolve) => { releaseInitialLaunch = resolve; });
    const handoffLaunch = new Promise<any>((resolve) => { releaseHandoffLaunch = resolve; });
    let manualExited = false;
    let manualCloseCalls = 0;
    let controlledCloseCalls = 0;
    let handoffDiagnosticCreated = false;
    let handoffRedirectsGoogle = false;
    let handoffTabs: Array<{ targetId: string; type: string; url: string; title: string }> = [];
    const fakeChrome = (generation: number, authenticated = false, emptyTabs = false) => {
      const targets: Array<{ targetId: string; type: string; url: string; title: string }> = emptyTabs ? [] : [
        { targetId: "auth-tab", type: "page", url: "https://chatgpt.com/", title: "ChatGPT" },
        { targetId: "review-tab", type: "page", url: "https://chatgpt.com/c/conversation_binding1", title: "Review" },
      ];
      if (emptyTabs) handoffTabs = targets;
      return ({
      profileDirectory: join(root, "controller-state", "profile"), generation, browserPid: 999,
      version: { product: "Chrome/test" }, reused: false,
      launchDiagnostics: { product: "Google Chrome 136.0", remoteDebuggingEnabled: true, stderr: "" },
      cdp: { async send(method: string, params: Record<string, unknown> = {}) {
        if (method === "Browser.getVersion") return { product: "Chrome/test" };
        if (method === "Target.getTargets") return { targetInfos: targets };
        if (method === "Target.createTarget") {
          handoffDiagnosticCreated = true;
          targets.push({ targetId: "diagnostic-tab", type: "page", url: handoffRedirectsGoogle ? "https://accounts.google.com/signin" : String(params.url), title: "ChatGPT" });
          return { targetId: "diagnostic-tab" };
        }
        if (method === "Target.attachToTarget") return { sessionId: "auth-session" };
        if (method === "Runtime.evaluate") return { result: { value: {
          status: "ready", url: "https://chatgpt.com/c/conversation_binding1", key: "conversation_binding1",
          authenticated, loginRequired: false, verificationRequired: false, unsupportedBrowser: false,
        } } };
        return {};
      } },
      async detach() {}, async close() { controlledCloseCalls += 1; },
      });
    };
    const controller = createReviewerBrowserController({
      database: controllerDb, stateDir: join(root, "controller-state"),
      launchControlled: async (options) => {
        controlledLaunches += 1;
        if (controlledLaunches === 1) return initialLaunch;
        if (controlledLaunches === 2) return handoffLaunch;
        return fakeChrome(options.generation, true, handoffRedirectsGoogle) as any;
      },
      launchManualAuthentication: async (options) => ({
        browserPid: 1000,
        browserProduct: "Google Chrome 136.0",
        launchDiagnostic: () => "",
        hasExited: () => manualExited,
        async releaseAfterExit() { if (!manualExited) throw new Error("still running"); },
        async close() { manualCloseCalls += 1; manualExited = true; return true; },
      }),
    });
    try {
      controller.createProfile({ profileId: "controller-test", ownerPrincipalId: "reviewer-1" });
      const startA = controller.startProfile("controller-test", "headed");
      for (let i = 0; i < 50 && controlledLaunches === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 2));
      const startB = controller.startProfile("controller-test", "headed");
      assert.equal(startA, startB, "same-generation concurrent profile starts share the in-flight promise");
      await assert.rejects(controller.beginManualAuthentication("controller-test"), /operation is already running/i,
        "manual auth cannot overlap a profile start");
      releaseInitialLaunch(fakeChrome(1) as any);
      await Promise.all([startA, startB]);
      assert.ok(controller.profiles.get("controller-test")?.browserReadyAt, "successful process and CDP startup records browser readiness");
      assert.equal(controller.profiles.get("controller-test")?.authState, "unknown",
        "a controlled-browser launch without an authentication observation remains unknown");
      assert.equal(controller.profiles.get("controller-test")?.lastVerifiedAt, undefined,
        "starting a browser does not claim that ChatGPT authentication was verified");
      const auth = await controller.beginManualAuthentication("controller-test");
      assert.equal(auth.generation, 2);
      assert.equal(auth.browserLaunchDiagnostic, "", "manual Chrome launch diagnostics are returned after redaction");
      assert.equal(controller.profiles.get("controller-test")?.browserProduct, "Google Chrome 136.0");
      assert.equal(controller.profiles.get("controller-test")?.remoteDebuggingEnabled, false,
        "the profile records that the manual authentication launch had no CDP endpoint");
      assert.equal(controller.profiles.get("controller-test")?.authState, "manual_auth_in_progress");
      await assert.rejects(controller.startProfile("controller-test"), /manual authentication owns this profile/i,
        "controlled mode cannot start while ordinary Chrome owns the profile");
      manualExited = true;
      const completing = controller.completeManualAuthentication("controller-test");
      for (let i = 0; i < 50 && controlledLaunches < 2; i += 1) await new Promise((resolve) => setTimeout(resolve, 2));
      await assert.rejects(controller.startProfile("controller-test"), /operation is already running/i,
        "profile restart cannot overlap authentication handoff verification");
      releaseHandoffLaunch(fakeChrome(3, true, true) as any);
      const completed = await completing;
      assert.equal(completed.status, "authenticated", "controlled relaunch verifies the persisted ChatGPT session");
      assert.equal(handoffDiagnosticCreated, true, "an empty restored-tab list opens one diagnostic ChatGPT tab before checking authentication");
      assert.equal(controller.profiles.get("controller-test")?.authState, "authenticated");
      assert.ok(controller.profiles.get("controller-test")?.lastVerifiedAt, "lastVerifiedAt records positive ChatGPT authentication observation");
      handoffRedirectsGoogle = true;
      manualExited = false;
      await controller.beginManualAuthentication("controller-test");
      manualExited = true;
      const rejectedIdentityProvider = await controller.completeManualAuthentication("controller-test");
      assert.equal(rejectedIdentityProvider.status, "auth_blocked", "a diagnostic-tab redirect to Google ends the handoff as an authentication block");
      assert.equal(rejectedIdentityProvider.reason, "identity_provider_rejected_after_handoff");
      assert.equal(controller.profiles.get("controller-test")?.authState, "auth_blocked");
      handoffRedirectsGoogle = false;
      handoffTabs.push({ targetId: "review-tab", type: "page", url: "https://chatgpt.com/c/conversation_binding1", title: "Review" });

      controllerDb.sqlite.prepare("insert into workspace_sessions (id, root, status, mode, managed, created_at, last_used_at) values (?, '/tmp', 'active', 'checkout', 'false', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')")
        .run("ws-controller-binding");
      controllerDb.sqlite.prepare("insert into work_sessions (id, workspace_session_id, submitted_by, status, created_at, updated_at) values (?, 'ws-controller-binding', 'owner', 'in_progress', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')")
        .run("session-controller-binding");
      const routes = createReviewRouteStore(controllerDb);
      const threads = createReviewThreadStore(controllerDb);
      const route = routes.configure({
        workSessionId: "session-controller-binding", ownerPrincipalId: "reviewer-1", ownerContextId: "owner-context",
        enabled: true, mode: "pinned_conversation", maxReviewRounds: 2,
        deliveryTransport: "native_cdp", browserProfileId: "controller-test",
      });
      const activation = threads.createActivation({ routeId: route.id, ownerPrincipalId: "reviewer-1", reviewerPrincipalId: "reviewer-1" });
      const thread = threads.activate({ activationSecret: activation.activationSecret, principalId: "reviewer-1", contextId: "review-context" });
      const binding = await controller.bindConversation({
        profileId: "controller-test", reviewThreadId: thread.id, targetId: "review-tab", principalId: "reviewer-1",
      });
      assert.equal(binding.bindingRevision, 1);
      const boundTarget = handoffTabs.find((candidate) => candidate.targetId === "review-tab")!;
      const savedReviewUrl = boundTarget.url;
      boundTarget.url = "https://accounts.google.com/signin";
      await assert.rejects(controller.restoreThread(thread.id),
        (error: unknown) => error instanceof Error && (error as { readiness?: string }).readiness === "identity_provider_rejected",
        "Google redirects from a bound conversation become a typed authentication block");
      assert.equal(controller.profiles.get("controller-test")?.authState, "auth_blocked",
        "an identity-provider redirect suspends the profile instead of leaving it eligible for automatic retry");
      boundTarget.url = savedReviewUrl;
      const restoredAfterAuth = await controller.restoreThread(thread.id);
      assert.equal(restoredAfterAuth.readiness?.status, "ready",
        "a fresh positive authenticated observation clears the transient identity-provider block");
      const now = new Date().toISOString();
      controllerDb.sqlite.prepare(`insert into review_thread_messages
        (id, thread_id, route_epoch, work_session_id, handoff_id, submission_id, review_epoch, round_number, kind,
         payload_json, payload_sha256, status, revision, created_at, updated_at)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'presenting', 1, ?, ?)`).run(
        "message-binding-active", thread.id, route.routeEpoch, "session-controller-binding", "handoff-binding-active",
        "submission-binding-active", 1, 1, "review", "{}", "b".repeat(64), now, now,
      );
      controllerDb.sqlite.prepare(`insert into review_browser_turns
        (id, review_message_id, review_thread_id, route_epoch, profile_id, conversation_fingerprint, binding_revision,
         attempt_number, browser_generation, state, prompt_sha256, created_at)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, 'dispatching', ?, ?)`).run(
        "turn-binding-active", "message-binding-active", thread.id, route.routeEpoch, "controller-test",
        "c".repeat(64), binding.bindingRevision, 1, binding.browserGeneration, "d".repeat(64), now,
      );
      controllerDb.sqlite.prepare("update review_threads set conversation_binding_status = 'recovery_required' where id = ?").run(thread.id);
      await assert.rejects(controller.bindConversation({
        profileId: "controller-test", reviewThreadId: thread.id, targetId: "review-tab", principalId: "reviewer-1",
      }), /active browser turn/i, "target rebinding cannot race a claimed prompt after the physical dispatch boundary");
      const health = await controller.inspectHealth("controller-test");
      assert.equal(health.cdpConnection, "connected");
      assert.deepEqual(health.bindings, { bound: 0, recoveryRequired: 1, other: 0 });
      assert.deepEqual(health.dispatch, { queued: 0, active: 1, uncertain: 0, blocked: 0 });
      await controller.close();
      assert.ok(controlledCloseCalls >= 2, "controller shutdown closes the owned CDP browser instead of detaching and leaving its endpoint running");
    } finally { controllerDb.close(); }

    const shutdownDb = openDatabase(join(root, "controller-shutdown-state"));
    let shutdownManualCloseCalls = 0;
    const shutdownController = createReviewerBrowserController({
      database: shutdownDb, stateDir: join(root, "controller-shutdown-state"),
      launchManualAuthentication: async () => ({
        browserProduct: "Google Chrome 136.0",
        launchDiagnostic: () => "",
        hasExited: () => false,
        async releaseAfterExit() {},
        async close() { shutdownManualCloseCalls += 1; return true; },
      }),
    });
    try {
      shutdownController.createProfile({ profileId: "shutdown-test", ownerPrincipalId: "reviewer-1" });
      await shutdownController.beginManualAuthentication("shutdown-test");
      await shutdownController.close();
      assert.equal(shutdownManualCloseCalls, 1, "controller shutdown closes an ordinary Chrome authentication process and releases ownership");
    } finally { shutdownDb.close(); }

    const restartDb = openDatabase(join(root, "controller-restart-state"));
    let restartLaunches = 0;
    let simulatedSessionSurvives = true;
    const restartedController = createReviewerBrowserController({
      database: restartDb,
      stateDir: join(root, "controller-restart-state"),
      launchControlled: async (options) => {
        restartLaunches += 1;
        return {
          profileDirectory: options.profileDirectory, generation: options.generation, browserPid: 777,
          version: { product: "Chrome/test" }, reused: false,
          launchDiagnostics: { product: "Chrome/test", remoteDebuggingEnabled: true, stderr: "" },
          cdp: { async send(method: string) {
            if (method === "Target.getTargets") return { targetInfos: [{ targetId: "recovered-auth-tab", type: "page", url: "https://chatgpt.com/", title: "ChatGPT" }] };
            if (method === "Target.attachToTarget") return { sessionId: "recovered-auth-session" };
            if (method === "Runtime.evaluate") return { result: { value: { url: "https://chatgpt.com/", authenticated: simulatedSessionSurvives, loginRequired: !simulatedSessionSurvives, verificationRequired: false, unsupportedBrowser: false } } };
            return {};
          } },
          async detach() {}, async close() {},
        } as any;
      },
    });
    try {
      restartedController.createProfile({ profileId: "restart-auth", ownerPrincipalId: "reviewer-1" });
      restartedController.profiles.transition({ profileId: "restart-auth", expectedGeneration: 0, status: "starting", authState: "manual_auth_in_progress" });
      restartedController.profiles.transition({
        profileId: "restart-auth", expectedGeneration: 1, status: "login_required", authState: "manual_auth_in_progress",
        manualAuthOwner: { pid: 2_000_000, generation: 1 },
      });
      const recovered = await restartedController.completeManualAuthentication("restart-auth");
      assert.equal(recovered.status, "authenticated", "a restarted controller reconciles a durably recorded, conclusively dead manual-browser owner");
      assert.equal(restartedController.profiles.get("restart-auth")?.manualAuthPid, undefined, "completed handoff clears durable manual-process ownership");
      assert.equal(restartedController.profiles.get("restart-auth")?.authState, "authenticated");
      simulatedSessionSurvives = false;
      restartedController.createProfile({ profileId: "restart-expired", ownerPrincipalId: "reviewer-1" });
      restartedController.profiles.transition({ profileId: "restart-expired", expectedGeneration: 0, status: "starting", authState: "manual_auth_in_progress" });
      restartedController.profiles.transition({ profileId: "restart-expired", expectedGeneration: 1, status: "login_required", authState: "manual_auth_in_progress",
        manualAuthOwner: { pid: 2_000_001, generation: 1 } });
      const expiredSession = await restartedController.completeManualAuthentication("restart-expired");
      assert.equal(expiredSession.status, "auth_required", "a session that does not survive CDP relaunch returns to manual authentication");
      assert.equal(expiredSession.reason, "chatgpt_session_not_authenticated_after_browser_handoff");
      assert.equal(restartedController.profiles.get("restart-expired")?.lastVerifiedAt, undefined,
        "a failed relaunch authentication observation never records lastVerifiedAt");
      restartedController.createProfile({ profileId: "restart-live", ownerPrincipalId: "reviewer-1" });
      restartedController.profiles.transition({ profileId: "restart-live", expectedGeneration: 0, status: "starting", authState: "manual_auth_in_progress" });
      restartedController.profiles.transition({ profileId: "restart-live", expectedGeneration: 1, status: "login_required", authState: "manual_auth_in_progress",
        manualAuthOwner: { pid: process.pid, generation: 1 } });
      const launchCountBeforeLiveOwner = restartLaunches;
      const liveOwnerResult = await restartedController.completeManualAuthentication("restart-live");
      assert.equal(liveOwnerResult.status, "auth_required", "a live or identity-ambiguous manual browser owner is not presumed closed after restart");
      assert.equal(liveOwnerResult.reason, "manual_browser_owner_unverified");
      assert.equal(restartLaunches, launchCountBeforeLiveOwner, "controlled CDP launch waits until durable manual-browser ownership is resolved");
    } finally { restartDb.close(); }
  }

  {
    const crashDb = openDatabase(join(root, "manual-auth-crash-reconciliation"));
    let controlledLaunches = 0;
    const crashController = createReviewerBrowserController({
      database: crashDb,
      stateDir: join(root, "manual-auth-crash-reconciliation"),
      launchControlled: async (options) => {
        controlledLaunches += 1;
        return {
          profileDirectory: options.profileDirectory, generation: options.generation, browserPid: 876,
          version: { product: "Chrome/test" }, reused: false,
          launchDiagnostics: { product: "Chrome/test", remoteDebuggingEnabled: true, stderr: "" },
          cdp: { async send(method: string) {
            if (method === "Target.getTargets") return { targetInfos: [{ targetId: "post-crash-tab", type: "page", url: "https://chatgpt.com/c/crash_12345678", title: "ChatGPT" }] };
            if (method === "Target.attachToTarget") return { sessionId: "post-crash-session" };
            if (method === "Runtime.evaluate") return { result: { value: {
              status: "ready", url: "https://chatgpt.com/c/crash_12345678", key: "crash_12345678",
              authenticated: true, loginRequired: false, verificationRequired: false, unsupportedBrowser: false,
            } } };
            return {};
          } },
          async detach() {}, async close() {},
        } as any;
      },
    });
    let simulatedChrome: ReturnType<typeof spawn> | undefined;
    try {
      crashController.createProfile({ profileId: "crash-handoff", ownerPrincipalId: "reviewer-1" });
      crashController.profiles.transition({ profileId: "crash-handoff", expectedGeneration: 0, status: "starting", authState: "manual_auth_in_progress" });
      const directory = await crashController.profiles.profileDirectory("crash-handoff");
      simulatedChrome = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", `--user-data-dir=${directory}`], { stdio: "ignore" });
      await new Promise<void>((resolve, reject) => {
        simulatedChrome!.once("spawn", resolve);
        simulatedChrome!.once("error", reject);
      });
      await symlink(`${hostname()}-${simulatedChrome.pid}`, join(directory, "SingletonLock"));
      let observedOwner: Awaited<ReturnType<typeof inspectChromeProfileOwner>> | undefined;
      for (let attempt = 0; attempt < 20; attempt++) {
        observedOwner = await inspectChromeProfileOwner(directory);
        if (observedOwner.status === "owned") break;
        assert.equal(observedOwner.status, "unknown", "an acquired lock remains fail-closed while its process identity settles");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.ok(observedOwner, "profile owner inspection returns an observation");
      assert.ok(["owned", "unknown"].includes(observedOwner.status),
        "a present Chrome profile lock is either identified or kept explicitly ambiguous");
      if (observedOwner.status === "owned") assert.equal(observedOwner.pid, simulatedChrome.pid);
      let reconciled: Awaited<ReturnType<typeof crashController.completeManualAuthentication>> | undefined;
      for (let attempt = 0; attempt < 20; attempt++) {
        reconciled = await crashController.completeManualAuthentication("crash-handoff");
        if (reconciled.reason === "close_all_chrome_windows_before_handoff") break;
        assert.equal(reconciled.status, "auth_required", "an ambiguous profile owner must remain gated while evidence settles");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.ok(reconciled, "manual authentication reconciliation returns a state");
      assert.equal(reconciled.status, "auth_required", "a crash between Chrome startup and PID persistence remains a manual handoff");
      assert.ok(["close_all_chrome_windows_before_handoff", "manual_browser_owner_unverified"].includes(reconciled.reason ?? ""),
        "ordinary Chrome is either identified as the owner or remains fail-closed as ambiguous");
      if (reconciled.reason === "close_all_chrome_windows_before_handoff") {
        assert.equal(crashController.profiles.get("crash-handoff")?.manualAuthPid, simulatedChrome.pid,
          "identified Chrome ownership is persisted for the next restart-safe reconciliation");
      } else {
        assert.equal(crashController.profiles.get("crash-handoff")?.manualAuthPid, undefined,
          "ambiguous process ownership is not persisted as fact");
      }
      assert.equal(controlledLaunches, 0, "CDP never launches over an ordinarily controlled Chrome profile");
      const childClosed = simulatedChrome.exitCode !== null || simulatedChrome.signalCode !== null
        ? Promise.resolve()
        : new Promise<void>((resolve) => simulatedChrome!.once("close", () => resolve()));
      simulatedChrome.kill("SIGTERM");
      await childClosed;
      simulatedChrome = undefined;
      await unlink(join(directory, "SingletonLock"));
      const completed = await crashController.completeManualAuthentication("crash-handoff");
      assert.equal(completed.status, "authenticated", "the recovered handoff continues after ordinary Chrome exits");
      assert.equal(controlledLaunches, 1);
    } finally {
      if (simulatedChrome && simulatedChrome.exitCode === null && simulatedChrome.signalCode === null) {
        const childClosed = new Promise<void>((resolve) => simulatedChrome!.once("close", () => resolve()));
        simulatedChrome.kill("SIGTERM");
        await childClosed;
      }
      await crashController.close();
      crashDb.close();
    }
  }

  const driverCommands: string[] = [];
  let enteredPrompt: string | undefined;
  const driverCdp = {
    async send(method: string, params: Record<string, unknown> = {}) {
      driverCommands.push(method);
      if (method === "Input.insertText") enteredPrompt = String(params.text);
      if (method === "Runtime.evaluate") {
        const expression = String(params.expression);
        let value: unknown = {};
        if (expression.includes("location.href")) value = { status: "ready", url: canonical.url, key: canonical.key };
        else if (expression.includes("userMessageCount")) value = { userMessageCount: 0, assistantMessageCount: 0 };
        else if (expression.includes("users.filter")) value = { found: enteredPrompt !== undefined, exact: enteredPrompt === JSON.parse(JSON.stringify("bounded review packet")) };
        else if (expression.includes("composer_not_unique")) value = { ok: true };
        else if (expression.includes("return ('value'in e")) value = true;
        else if (expression.includes("send-button")) value = { ok: true, x: 20, y: 30 };
        else if (expression.includes("new Promise(resolve")) value = true;
        else if (expression.includes("assistants:")) value = { assistants: 1, generating: false };
        return { result: { value } };
      }
      return {};
    },
  } as unknown as CdpClient;
  const pageTarget: BoundReviewerTarget = { targetId: "tab-1", sessionId: "session-1", conversationUrl: canonical.url, conversationKey: canonical.key, browserGeneration: 2 };
  const driver = new ChatGptPageDriver(driverCdp, pageTarget);
  let identityProviderExpression = "";
  const identityProviderDriver = new ChatGptPageDriver({
    async send(method: string, params: Record<string, unknown> = {}) {
      if (method === "Runtime.evaluate") {
        identityProviderExpression = String(params.expression);
        return { result: { value: { status: "identity_provider_rejected" } } };
      }
      return {};
    },
  } as unknown as CdpClient, pageTarget);
  assert.deepEqual(await identityProviderDriver.inspect(), { status: "identity_provider_rejected" },
    "an identity-provider destination is classified without scraping its page body");
  assert.ok(identityProviderExpression.indexOf("accounts.google.com") < identityProviderExpression.indexOf("document.body"),
    "Google destination detection returns before any identity-provider body is read");
  const baseline = await driver.captureBaseline();
  const sent = await driver.submitPrompt({ prompt: "bounded review packet", attemptId: "attempt-1", expectedConversationKey: canonical.key, baseline });
  assert.equal(sent.status, "accepted", JSON.stringify(sent));
  assert.equal(driverCommands.filter((method) => method === "Input.dispatchMouseEvent").length, 3, "send is one mouse press/release sequence");
  const retry = await driver.submitPrompt({ prompt: "bounded review packet", attemptId: "attempt-1", expectedConversationKey: canonical.key, baseline });
  assert.equal(retry.status, "accepted", "an exact already-present attempt is reconciled without sending again");
  assert.equal(driverCommands.filter((method) => method === "Input.dispatchMouseEvent").length, 3, "an accepted retry does not click Send again");

  const fastGenerationCommands: string[] = [];
  let fastGenerationPrompt: string | undefined;
  let fastGenerationActive = false;
  const fastGenerationCdp = {
    async send(method: string, params: Record<string, unknown> = {}) {
      fastGenerationCommands.push(method);
      if (method === "Input.insertText") fastGenerationPrompt = String(params.text);
      if (method === "Input.dispatchMouseEvent" && params.type === "mouseReleased") fastGenerationActive = true;
      if (method !== "Runtime.evaluate") return {};
      const expression = String(params.expression);
      let value: unknown = {};
      if (expression.includes("location.href")) value = fastGenerationActive
        ? { status: "generation_active", url: canonical.url, key: canonical.key }
        : { status: "ready", url: canonical.url, key: canonical.key };
      else if (expression.includes("userMessageCount")) value = { userMessageCount: 0, assistantMessageCount: 0 };
      else if (expression.includes("users.filter")) value = { found: fastGenerationPrompt !== undefined, exact: fastGenerationPrompt === "fast review packet" };
      else if (expression.includes("composer_not_unique")) value = { ok: true };
      else if (expression.includes("return ('value'in e")) value = true;
      else if (expression.includes("send-button")) value = { ok: true, x: 20, y: 30 };
      else if (expression.includes("new Promise(resolve")) value = fastGenerationPrompt === "fast review packet";
      return { result: { value } };
    },
  } as unknown as CdpClient;
  const fastGenerationDriver = new ChatGptPageDriver(fastGenerationCdp, pageTarget);
  const fastBaseline = await fastGenerationDriver.captureBaseline();
  const fastAccepted = await fastGenerationDriver.submitPrompt({ prompt: "fast review packet", attemptId: "attempt-fast", expectedConversationKey: canonical.key, baseline: fastBaseline });
  assert.equal(fastAccepted.status, "accepted", "visible exact prompt acceptance remains accepted after generation starts immediately");
  assert.equal(fastGenerationCommands.filter((method) => method === "Input.dispatchMouseEvent").length, 3, "the fast-generation send crosses the boundary once");
  const fastRetry = await fastGenerationDriver.submitPrompt({ prompt: "fast review packet", attemptId: "attempt-fast", expectedConversationKey: canonical.key, baseline: fastBaseline });
  assert.equal(fastRetry.status, "accepted", "retry reconciles the exact prompt while the conversation is generating");
  assert.equal(fastGenerationCommands.filter((method) => method === "Input.dispatchMouseEvent").length, 3, "generation reconciliation does not send a duplicate");

  const makeDispatcher = (driver: any, failPromptAcknowledgement = false) => {
    let claimed = false;
    const transitions: string[] = [];
    let failed = false;
    let completed = false;
    const claim = {
      attemptId: "attempt-shutdown", messageId: "message-shutdown", reviewThreadId: "thread-shutdown", handoffId: "handoff-shutdown", routeId: "route-shutdown",
      routeEpoch: 1, attemptNumber: 1, profileId: "reviewer-shutdown", browserGeneration: 7,
      leaseToken: "lease-shutdown", leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(), conversationUrl: canonical.url,
      conversationKey: canonical.key, conversationFingerprint: "f".repeat(64), bindingRevision: 1,
      promptPayloadSha256: "a".repeat(64), prompt: "prompt",
    };
    const event = { id: "event-shutdown", aggregateId: "message-shutdown", payload: { messageId: "message-shutdown", threadId: "thread-shutdown", profileId: "reviewer-shutdown" }, status: "claimed", claimToken: "token", claimedBy: "worker" };
    const dispatcher = createReviewerTurnDispatcher({
      drainTimeoutMs: 20,
      outbox: {
        subscribe: () => () => undefined,
        reapExpiredClaims: () => 0,
        claimNext: () => { if (claimed) return undefined; claimed = true; return event; },
        listPending: () => [],
        markFailed: () => { failed = true; return true; },
        markCompleted: () => { completed = true; return true; },
        get: () => event,
      } as any,
      jobs: {
        claim: () => claim,
        transition: (input: { nextStatus: string }) => {
          transitions.push(input.nextStatus);
          if (failPromptAcknowledgement && input.nextStatus === "prompt_accepted") throw new Error("simulated durable acknowledgement failure after host acceptance");
          return {};
        },
        renewLease: () => new Date(Date.now() + 60_000).toISOString(),
        reconcileExpiredAttempts: () => ({ reconciled: 0, uncertain: 0, fenced: 0 }),
      } as any,
      browser: {
        profiles: { get: () => ({ id: "reviewer-shutdown", generation: 7, status: "ready", mode: "headed" }) },
        startProfile: async () => ({ generation: 7, status: "ready" }),
        restoreThread: async () => ({ target: pageTarget, driver }),
      } as any,
    });
    return { dispatcher, transitions, wasFailed: () => failed, wasCompleted: () => completed };
  };

  let releaseBaseline!: (value: TurnBaseline) => void;
  let baselineEntered!: () => void;
  const baselineStarted = new Promise<void>((resolve) => { baselineEntered = resolve; });
  const slowBaselineDriver = {
    captureBaseline: () => { baselineEntered(); return new Promise<TurnBaseline>((resolve) => { releaseBaseline = resolve; }); },
    submitPrompt: async () => { throw new Error("shutdown before dispatch must not submit"); },
  };
  const beforeDispatch = makeDispatcher(slowBaselineDriver);
  beforeDispatch.dispatcher.start();
  await baselineStarted;
  const beforeDrain = beforeDispatch.dispatcher.stopAndDrain();
  releaseBaseline({ conversationKey: canonical.key, userMessageCount: 0, assistantMessageCount: 0, capturedAt: new Date().toISOString() });
  await beforeDrain;
  assert.equal(beforeDispatch.wasFailed(), true, "shutdown before prompt submission releases the durable dispatch claim");
  assert.equal(beforeDispatch.transitions.includes("dispatching"), false);

  let submitEntered!: () => void;
  let releaseSubmit!: (value: { status: "accepted"; submittedAt: string; conversationKey: string }) => void;
  const submitStarted = new Promise<void>((resolve) => { submitEntered = resolve; });
  const slowSubmitDriver = {
    captureBaseline: async () => ({ conversationKey: canonical.key, userMessageCount: 0, assistantMessageCount: 0, capturedAt: new Date().toISOString() }),
    submitPrompt: () => { submitEntered(); return new Promise<{ status: "accepted"; submittedAt: string; conversationKey: string }>((resolve) => { releaseSubmit = resolve; }); },
  };
  const duringDispatch = makeDispatcher(slowSubmitDriver);
  duringDispatch.dispatcher.start();
  await submitStarted;
  await duringDispatch.dispatcher.stopAndDrain();
  assert.equal(duringDispatch.transitions.at(-1), "uncertain", "shutdown after the irreversible send boundary preserves uncertainty");
  assert.equal(duringDispatch.wasCompleted(), true, "uncertain delivery is not automatically redelivered");
  releaseSubmit({ status: "accepted", submittedAt: new Date().toISOString(), conversationKey: canonical.key });

  const acceptedThenAckFailed = makeDispatcher({
    captureBaseline: async () => ({ conversationKey: canonical.key, userMessageCount: 0, assistantMessageCount: 0, capturedAt: new Date().toISOString() }),
    submitPrompt: async () => ({ status: "accepted", submittedAt: new Date().toISOString(), conversationKey: canonical.key }),
  }, true);
  acceptedThenAckFailed.dispatcher.start();
  await acceptedThenAckFailed.dispatcher.drainOnce();
  assert.ok(acceptedThenAckFailed.transitions.includes("dispatching"));
  assert.ok(acceptedThenAckFailed.transitions.includes("prompt_accepted"));
  assert.equal(acceptedThenAckFailed.transitions.at(-1), "uncertain", "a lost durable acknowledgement after host acceptance keeps the send boundary uncertain");
  assert.equal(acceptedThenAckFailed.wasCompleted(), true, "the accepted prompt's outbox item is fenced against redelivery after acknowledgement failure");
  await acceptedThenAckFailed.dispatcher.stopAndDrain();

  {
    const event = { id: "event-auth-handoff", aggregateId: "message-auth-handoff", payload: { messageId: "message-auth-handoff", threadId: "thread-auth-handoff", profileId: "profile-auth-handoff" }, status: "claimed", claimToken: "token", claimedBy: "worker" };
    let suspended = false;
    let launched = false;
    let eventClaimed = false;
    const dispatcher = createReviewerTurnDispatcher({
      outbox: {
        subscribe: () => () => undefined, reapExpiredClaims: () => 0,
        claimNext: () => { if (eventClaimed) return null; eventClaimed = true; return event; }, listPending: () => [], get: () => event,
        markSuspended: (_claim: unknown, reason: string) => { suspended = reason === "review_browser_auth_suspended:handoff_pending"; return true; },
        markFailed: () => false, markCompleted: () => false,
      } as any,
      jobs: { claim: () => { throw new Error("auth-blocked work must remain queued before attempt claim"); }, reconcileExpiredAttempts: () => ({ reconciled: 0, uncertain: 0, fenced: 0 }) } as any,
      browser: {
        profiles: { get: () => ({ id: "profile-auth-handoff", generation: 3, status: "login_required", mode: "headed", authState: "handoff_pending" }) },
        startProfile: async () => { launched = true; throw new Error("authentication blocks must not auto-restart Chrome"); },
      } as any,
    });
    dispatcher.start();
    await dispatcher.drainOnce();
    assert.equal(suspended, true, "queued work stays suspended while ordinary Chrome authentication ownership is unresolved");
    assert.equal(launched, false, "a pending manual-auth handoff never triggers automatic controlled-browser restart");
    await dispatcher.stopAndDrain();
  }

  {
    const event = { id: "event-binding-ambiguous", aggregateId: "message-binding-ambiguous", payload: { messageId: "message-binding-ambiguous", threadId: "thread-binding-ambiguous", profileId: "profile-binding-ambiguous" }, status: "claimed", claimToken: "token", claimedBy: "worker" };
    let suspensionReason = "";
    let eventClaimed = false;
    let attemptClaimed = false;
    const dispatcher = createReviewerTurnDispatcher({
      outbox: {
        subscribe: () => () => undefined, reapExpiredClaims: () => 0,
        claimNext: () => { if (eventClaimed) return null; eventClaimed = true; return event; }, listPending: () => [], get: () => event,
        markSuspended: (_claim: unknown, reason: string) => { suspensionReason = reason; return true; },
        markFailed: () => false, markCompleted: () => false,
      } as any,
      jobs: { claim: () => { attemptClaimed = true; return undefined; }, reconcileExpiredAttempts: () => ({ reconciled: 0, uncertain: 0, fenced: 0 }) } as any,
      browser: {
        profiles: { get: () => ({ id: "profile-binding-ambiguous", generation: 4, status: "ready", mode: "headed", authState: "authenticated" }) },
        restoreThread: async () => { throw new ReviewerTargetError("target_ambiguous", "Two tabs show the saved conversation."); },
      } as any,
    });
    dispatcher.start();
    await dispatcher.drainOnce();
    assert.equal(suspensionReason, "reviewer.browser_binding_suspended:target_ambiguous",
      "ambiguous exact-target recovery suspends the queued packet without consuming retries");
    assert.equal(attemptClaimed, false, "no review attempt is claimed until the conversation binding is explicit");
    await dispatcher.stopAndDrain();
  }

  {
    const event = { id: "event-verification-required", aggregateId: "message-verification-required", payload: { messageId: "message-verification-required", threadId: "thread-verification-required", profileId: "profile-verification-required" }, status: "claimed", claimToken: "token", claimedBy: "worker" };
    let profile = { id: "profile-verification-required", generation: 5, status: "ready", mode: "headed", authState: "authenticated" };
    let suspensionReason = "";
    let eventClaimed = false;
    const dispatcher = createReviewerTurnDispatcher({
      outbox: {
        subscribe: () => () => undefined, reapExpiredClaims: () => 0,
        claimNext: () => { if (eventClaimed) return null; eventClaimed = true; return event; }, listPending: () => [], get: () => event,
        markSuspended: (_claim: unknown, reason: string) => { suspensionReason = reason; return true; },
        markFailed: () => false, markCompleted: () => false,
      } as any,
      jobs: { claim: () => { throw new Error("a verification challenge must stop before claiming a turn"); }, reconcileExpiredAttempts: () => ({ reconciled: 0, uncertain: 0, fenced: 0 }) } as any,
      browser: {
        profiles: { get: () => profile },
        restoreThread: async () => {
          profile = { ...profile, status: "blocked", authState: "auth_blocked" };
          throw new BrowserReadinessError("verification_required");
        },
      } as any,
    });
    dispatcher.start();
    await dispatcher.drainOnce();
    assert.equal(suspensionReason, "review_browser_auth_suspended:verification_required",
      "verification challenges retain the exact failure category while suspending queued work");
    await dispatcher.stopAndDrain();
  }

  {
    const event = { id: "event-generation-active", aggregateId: "message-generation-active", payload: { messageId: "message-generation-active", threadId: "thread-generation-active", profileId: "profile-generation-active" }, status: "claimed", claimToken: "token", claimedBy: "worker" };
    let releasedDelay = -1;
    let claimedAttempt = false;
    let eventClaimed = false;
    const dispatcher = createReviewerTurnDispatcher({
      outbox: {
        subscribe: () => () => undefined, reapExpiredClaims: () => 0,
        claimNext: () => { if (eventClaimed) return null; eventClaimed = true; return event; }, listPending: () => [], get: () => event,
        release: (_claim: unknown, delay: number) => { releasedDelay = delay; return true; },
        markFailed: () => false, markCompleted: () => false,
      } as any,
      jobs: { claim: () => { claimedAttempt = true; return undefined; }, reconcileExpiredAttempts: () => ({ reconciled: 0, uncertain: 0, fenced: 0 }) } as any,
      browser: {
        profiles: { get: () => ({ id: "profile-generation-active", generation: 4, status: "busy", mode: "headed", authState: "authenticated" }) },
        restoreThread: async () => ({ target: pageTarget, driver: {}, readiness: { status: "generation_active", conversationUrl: canonical.url, conversationKey: canonical.key } }),
      } as any,
    });
    dispatcher.start();
    await dispatcher.drainOnce();
    assert.equal(claimedAttempt, false, "a generating conversation is not claimed for a second turn");
    assert.equal(releasedDelay, 5_000, "work waits briefly for the exact conversation generation to settle");
    await dispatcher.stopAndDrain();
  }

  // Independent selected conversations must progress concurrently; a slow
  // review in one conversation must not hold the global browser dispatcher.
  {
    const conversationTwo = "conversation_87654321";
    const events = [
      { id: "event-one", aggregateId: "message-one", payload: { messageId: "message-one", threadId: "thread-one", profileId: "reviewer-parallel" }, status: "claimed", claimToken: "one", claimedBy: "worker" },
      { id: "event-two", aggregateId: "message-two", payload: { messageId: "message-two", threadId: "thread-two", profileId: "reviewer-parallel" }, status: "claimed", claimToken: "two", claimedBy: "worker" },
    ];
    let nextEvent = 0;
    let secondBaseline = false;
    let releaseFirstBaseline!: () => void;
    const secondEntered = new Promise<void>((resolve) => { releaseFirstBaseline = resolve; });
    const captured: string[] = [];
    const dispatcher = createReviewerTurnDispatcher({
      outbox: {
        subscribe: () => () => undefined,
        reapExpiredClaims: () => 0,
        claimNext: () => events[nextEvent++] as any,
        listPending: () => [],
        markFailed: () => true,
        markCompleted: () => true,
        get: (id: string) => events.find((event) => event.id === id),
      } as any,
      jobs: {
        claim: ({ messageId }: { messageId: string }) => ({
          attemptId: `attempt-${messageId}`, messageId, reviewThreadId: messageId === "message-one" ? "thread-one" : "thread-two",
          handoffId: `handoff-${messageId}`, routeId: "route", routeEpoch: 1, attemptNumber: 1, profileId: "reviewer-parallel",
          browserGeneration: 3, leaseToken: `lease-${messageId}`, leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          conversationUrl: canonical.url, conversationKey: messageId === "message-one" ? canonical.key : conversationTwo,
          conversationFingerprint: "f".repeat(64), bindingRevision: 1, promptPayloadSha256: "a".repeat(64), prompt: "review",
        }),
        transition: () => ({}), renewLease: () => new Date(Date.now() + 60_000).toISOString(),
        reconcileExpiredAttempts: () => ({ reconciled: 0, uncertain: 0, fenced: 0 }),
      } as any,
      browser: {
        profiles: { get: () => ({ id: "reviewer-parallel", generation: 3, status: "ready", mode: "headed" }) },
        restoreThread: async (threadId: string) => {
          const conversationKey = threadId === "thread-one" ? canonical.key : conversationTwo;
          return {
            target: { conversationKey },
            driver: {
              captureBaseline: async () => {
                captured.push(threadId);
                if (threadId === "thread-one") await secondEntered;
                else { secondBaseline = true; releaseFirstBaseline(); }
                return { conversationKey, userMessageCount: 0, assistantMessageCount: 0, capturedAt: new Date().toISOString() };
              },
              submitPrompt: async () => ({ status: "accepted", submittedAt: new Date().toISOString(), conversationKey }),
              waitForGeneration: async () => "finished",
            },
          };
        },
      } as any,
    });
    dispatcher.start();
    await dispatcher.drainOnce();
    assert.deepEqual(captured.sort(), ["thread-one", "thread-two"]);
    assert.equal(secondBaseline, true, "separate conversation entered while the first conversation's baseline was held");
    await dispatcher.stopAndDrain();
  }
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("review-browser contracts: PASS");
