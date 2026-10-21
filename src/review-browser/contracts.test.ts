import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../db/client.js";
import { createReviewerBrowserProfileStore } from "./profile-store.js";
import { bindReviewerTarget, canonicalReviewerConversation, restoreReviewerTarget, reviewerConversationFingerprint } from "./target-binding.js";
import type { CdpClient } from "./cdp-client.js";
import { ChatGptPageDriver } from "./chatgpt-page-driver.js";
import type { BoundReviewerTarget } from "./target-binding.js";

const root = await mkdtemp(join(tmpdir(), "kontrol-review-browser-test-"));
try {
  const canonical = canonicalReviewerConversation("https://www.chatgpt.com/c/conversation_12345678?foo=1#x");
  assert.deepEqual(canonical, { url: "https://chatgpt.com/c/conversation_12345678", key: "conversation_12345678" });
  assert.equal(reviewerConversationFingerprint(canonical.key).length, 64);
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
    const directory = await profiles.profileDirectory(profile.id);
    assert.ok(directory.startsWith(join(root, "state", "reviewer-browser", "profiles")));
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.throws(() => profiles.create({ id: "../outside", ownerPrincipalId: "reviewer-1" }));
    assert.throws(() => profiles.create({ id: "reviewer-default", ownerPrincipalId: "reviewer-2" }), /another principal/i);
  } finally { db.close(); }

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
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("review-browser contracts: PASS");
