import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../db/client.js";
import { createReviewerBrowserProfileStore } from "./profile-store.js";
import { createReviewerBrowserController } from "./browser-controller.js";
import { createReviewRouteStore } from "../review-handoff/route-store.js";
import { createReviewThreadStore } from "../review-thread/thread-store.js";
import { bindReviewerTarget, canonicalReviewerConversation, restoreReviewerTarget, reviewerConversationFingerprint } from "./target-binding.js";
import type { CdpClient } from "./cdp-client.js";
import { ChatGptPageDriver, type TurnBaseline } from "./chatgpt-page-driver.js";
import type { BoundReviewerTarget } from "./target-binding.js";
import { chromeArguments } from "./chrome-process.js";
import { createReviewerTurnDispatcher } from "./turn-dispatcher.js";

const root = await mkdtemp(join(tmpdir(), "kontrol-review-browser-test-"));
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

  const db = openDatabase(join(root, "state"));
  try {
    const profiles = createReviewerBrowserProfileStore(db, join(root, "state"));
    const profile = profiles.create({ id: "reviewer-default", ownerPrincipalId: "reviewer-1" });
    assert.equal(profile.status, "stopped");
    assert.equal(profile.authState, "unknown", "authentication status is independent of browser process status");
    const directory = await profiles.profileDirectory(profile.id);
    assert.ok(directory.startsWith(join(root, "state", "reviewer-browser", "profiles")));
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
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
    const fakeChrome = (generation: number, authenticated = false) => ({
      profileDirectory: join(root, "controller-state", "profile"), generation, browserPid: 999,
      version: { product: "Chrome/test" }, reused: false,
      cdp: { async send(method: string) {
        if (method === "Target.getTargets") return { targetInfos: [
          { targetId: "auth-tab", type: "page", url: "https://chatgpt.com/", title: "ChatGPT" },
          { targetId: "review-tab", type: "page", url: "https://chatgpt.com/c/conversation_binding1", title: "Review" },
        ] };
        if (method === "Target.attachToTarget") return { sessionId: "auth-session" };
        if (method === "Runtime.evaluate") return { result: { value: { authenticated, loginRequired: false, verificationRequired: false } } };
        return {};
      } },
      async detach() {}, async close() {},
    });
    const controller = createReviewerBrowserController({
      database: controllerDb, stateDir: join(root, "controller-state"),
      launchControlled: async (options) => {
        controlledLaunches += 1;
        if (controlledLaunches === 1) return initialLaunch;
        if (controlledLaunches === 2) return handoffLaunch;
        return fakeChrome(options.generation, true) as any;
      },
      launchManualAuthentication: async (options) => ({
        browserPid: 1000,
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
      const auth = await controller.beginManualAuthentication("controller-test");
      assert.equal(auth.generation, 2);
      assert.equal(controller.profiles.get("controller-test")?.authState, "manual_auth_in_progress");
      await assert.rejects(controller.startProfile("controller-test"), /manual authentication owns this profile/i,
        "controlled mode cannot start while ordinary Chrome owns the profile");
      manualExited = true;
      const completing = controller.completeManualAuthentication("controller-test");
      for (let i = 0; i < 50 && controlledLaunches < 2; i += 1) await new Promise((resolve) => setTimeout(resolve, 2));
      await assert.rejects(controller.startProfile("controller-test"), /operation is already running/i,
        "profile restart cannot overlap authentication handoff verification");
      releaseHandoffLaunch(fakeChrome(3, true) as any);
      const completed = await completing;
      assert.equal(completed.status, "authenticated", "controlled relaunch verifies the persisted ChatGPT session");
      assert.equal(controller.profiles.get("controller-test")?.authState, "authenticated");

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
      await controller.close();
    } finally { controllerDb.close(); }

    const shutdownDb = openDatabase(join(root, "controller-shutdown-state"));
    let shutdownManualCloseCalls = 0;
    const shutdownController = createReviewerBrowserController({
      database: shutdownDb, stateDir: join(root, "controller-shutdown-state"),
      launchManualAuthentication: async () => ({
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
  const baseline = await driver.captureBaseline();
  const sent = await driver.submitPrompt({ prompt: "bounded review packet", attemptId: "attempt-1", expectedConversationKey: canonical.key, baseline });
  assert.equal(sent.status, "accepted", JSON.stringify(sent));
  assert.equal(driverCommands.filter((method) => method === "Input.dispatchMouseEvent").length, 3, "send is one mouse press/release sequence");
  const retry = await driver.submitPrompt({ prompt: "bounded review packet", attemptId: "attempt-1", expectedConversationKey: canonical.key, baseline });
  assert.equal(retry.status, "accepted", "an exact already-present attempt is reconciled without sending again");
  assert.equal(driverCommands.filter((method) => method === "Input.dispatchMouseEvent").length, 3, "an accepted retry does not click Send again");

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
