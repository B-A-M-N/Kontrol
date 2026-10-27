import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { openDatabase, type DatabaseHandle } from "../db/client.js";
import { reviewRoutes, reviewThreads } from "../db/schema.js";
import { createReviewerBrowserProfileStore } from "./profile-store.js";
import { createReviewerBrowserController, type ReviewerBrowserController } from "./browser-controller.js";
import { canonicalReviewerConversation, reviewerConversationFingerprint } from "./target-binding.js";
import type { CdpClient } from "./cdp-client.js";
import type { OwnedChrome } from "./chrome-process.js";

const CANONICAL_URL = "https://chatgpt.com/c/conversation_restorecleanup";
const { key: CONVERSATION_KEY } = canonicalReviewerConversation(CANONICAL_URL);
const FINGERPRINT = reviewerConversationFingerprint(CONVERSATION_KEY);

/** Minimal fake CDP that models flattened target attachments so a detach is
 * observable, and lets tests force an enable/evaluate failure or race the CAS. */
class FakeCdp {
  readonly commands: string[] = [];
  readonly detachedSessions: string[] = [];
  readonly attached = new Set<string>();
  nextSession = 1;
  failOnPageEnable = false;
  failOnRuntimeEnable = false;
  failOnEvaluate = false;
  /** Runs just before a successful inspect resolves, to simulate a concurrent commit. */
  beforeInspectResolve?: () => void;
  evaluateResult: Record<string, unknown> = { status: "ready", url: CANONICAL_URL, key: CONVERSATION_KEY };

  async send(method: string, params: Record<string, unknown> = {}, _sessionId?: string): Promise<Record<string, unknown>> {
    this.commands.push(method);
    switch (method) {
      case "Target.getTargets":
        return { targetInfos: [{ targetId: "tab-restore", type: "page", url: CANONICAL_URL, title: "Review" }] };
      case "Target.attachToTarget": {
        const sessionId = `session-${this.nextSession++}`;
        this.attached.add(sessionId);
        return { sessionId };
      }
      case "Target.detachFromTarget": {
        const sessionId = String(params.sessionId);
        if (this.attached.has(sessionId)) {
          this.attached.delete(sessionId);
          this.detachedSessions.push(sessionId);
        }
        return {};
      }
      case "Page.enable":
        if (this.failOnPageEnable) throw new Error("Page.enable failed");
        return {};
      case "Runtime.enable":
        if (this.failOnRuntimeEnable) throw new Error("Runtime.enable failed");
        return {};
      case "Runtime.evaluate":
        if (this.failOnEvaluate) throw new Error("evaluate failed");
        if (this.beforeInspectResolve) this.beforeInspectResolve();
        return { result: { value: this.evaluateResult } };
      default:
        return {};
    }
  }
}

function fakeChrome(cdp: FakeCdp, generation = 1): OwnedChrome {
  return {
    profileDirectory: "/tmp/kontrol-review-test-profile",
    generation,
    browserPid: 4242,
    version: { product: "Chromium" },
    cdp: cdp as unknown as CdpClient,
    reused: false,
    async detach() { /* no-op */ },
    async close() { /* no-op */ },
  };
}

interface Scenario {
  db: DatabaseHandle;
  stateDir: string;
  controller: ReviewerBrowserController;
  cdp: FakeCdp;
  routeId: string;
  threadId: string;
}

/** Seed a bound reviewer thread plus its route, work session and profile, then
 * build the controller with a fresh fake CDP. Each scenario gets its own temp
 * state directory and database. */
async function newScenario(): Promise<Scenario> {
  const dir = await mkdtemp(join(tmpdir(), "kontrol-restore-cleanup-"));
  const db = openDatabase(dir);
  const now = new Date().toISOString();
  db.sqlite.prepare(
    "insert into workspace_sessions (id, root, status, mode, managed, created_at, last_used_at) values ('ws', '/tmp', 'active', 'checkout', 'false', ?, ?)",
  ).run(now, now);
  db.sqlite.prepare(
    "insert into work_sessions (id, workspace_session_id, submitted_by, status, created_at, updated_at) values ('session', 'ws', 'owner', 'in_progress', ?, ?)",
  ).run(now, now);
  const routeId = "route-" + dir.slice(-6);
  const threadId = "thread-" + dir.slice(-6);
  db.db.insert(reviewRoutes).values({
    id: routeId, workSessionId: "session", ownerPrincipalId: "owner", ownerContextId: "owner-context",
    deliveryTransport: "native_cdp", browserProfileId: "reviewer", status: "active", routeEpoch: 1,
    maxReviewRounds: 3, createdAt: now, updatedAt: now,
  }).run();
  db.db.insert(reviewThreads).values({
    id: threadId, routeId, routeEpoch: 1, workSessionId: "session", ownerPrincipalId: "owner",
    reviewerPrincipalId: "reviewer", hostKind: "chatgpt", hostConversationId: "chat-1",
    browserProfileId: "reviewer", browserGeneration: 1, browserTargetId: "tab-restore",
    browserCdpSessionId: "legacy-session", conversationUrl: CANONICAL_URL, conversationKey: CONVERSATION_KEY,
    conversationFingerprint: FINGERPRINT, conversationBindingRevision: 1, conversationBindingStatus: "bound",
    conversationBindingAssurance: "browser_observed", bindingGeneration: 1, status: "active", maxRounds: 3,
    revision: 1, createdAt: now, activatedAt: now,
  }).run();

  const cdp = new FakeCdp();
  const profiles = createReviewerBrowserProfileStore(db, dir);
  profiles.create({ id: "reviewer", ownerPrincipalId: "owner" });
  const controller = createReviewerBrowserController({
    database: db, stateDir: dir, launchChrome: async () => fakeChrome(cdp),
  });
  return { db, stateDir: dir, controller, cdp, routeId, threadId };
}

const root = await mkdtemp(join(tmpdir(), "kontrol-restore-cleanup-scenarios-"));
const scenarios: Scenario[] = [];
try {
  // -------------------------------------------------------------------------
  // 1. Page.enable failure: freshly attached session is detached, durable
  //    session is untouched.
  // -------------------------------------------------------------------------
  {
    const s = await newScenario();
    scenarios.push(s);
    s.cdp.failOnPageEnable = true;
    await assert.rejects(() => s.controller.restoreThread(s.threadId), /Page.enable/i);
    assert.equal(s.cdp.attached.size, 0, `Page.enable failure leaks session: ${[...s.cdp.attached].join(",")}`);
    const thread = s.db.db.select().from(reviewThreads).where(eq(reviewThreads.id, s.threadId)).get()!;
    assert.equal(thread.browserCdpSessionId, "legacy-session", "failed enable restore must not replace the durable session");
  }

  // -------------------------------------------------------------------------
  // 2. Runtime.enable failure: freshly attached session is detached.
  // -------------------------------------------------------------------------
  {
    const s = await newScenario();
    scenarios.push(s);
    s.cdp.failOnRuntimeEnable = true;
    await assert.rejects(() => s.controller.restoreThread(s.threadId), /Runtime.enable/i);
    assert.equal(s.cdp.attached.size, 0, "Runtime.enable failure leaks the ephemeral session");
  }

  // -------------------------------------------------------------------------
  // 3. inspect "not ready": session detached and recovery recorded.
  // -------------------------------------------------------------------------
  {
    const s = await newScenario();
    scenarios.push(s);
    s.cdp.evaluateResult = { status: "verification_required" };
    await assert.rejects(() => s.controller.restoreThread(s.threadId), /not ready/i);
    assert.equal(s.cdp.attached.size, 0, "not-ready inspect leaks the ephemeral session");
    const thread = s.db.db.select().from(reviewThreads).where(eq(reviewThreads.id, s.threadId)).get()!;
    assert.equal(thread.conversationBindingStatus, "recovery_required", "not-ready restore marks recovery_required");
  }

  // -------------------------------------------------------------------------
  // 4. inspect throws (browser disappeared mid-attach): session detached.
  // -------------------------------------------------------------------------
  {
    const s = await newScenario();
    scenarios.push(s);
    s.cdp.failOnEvaluate = true;
    await assert.rejects(() => s.controller.restoreThread(s.threadId));
    assert.equal(s.cdp.attached.size, 0, "throwing inspect leaks the ephemeral session");
  }

  // -------------------------------------------------------------------------
  // 5. CAS race: a concurrent restore commits a newer binding between our
  //    inspect and our CAS write. Our restore must fail closed (no stale
  //    cache), dispose only its own session, and never detach the newer
  //    binding's session.
  // -------------------------------------------------------------------------
  {
    const s = await newScenario();
    scenarios.push(s);
    const winnerSession = "session-999";
    s.cdp.beforeInspectResolve = () => {
      // A concurrent (winning) restore that already committed a fresh binding and
      // bumped the thread revision while our restore was inspecting the page.
      s.cdp.attached.add(winnerSession);
      s.db.db.update(reviewThreads).set({
        browserTargetId: "tab-restore", browserCdpSessionId: winnerSession, revision: 9,
      }).where(eq(reviewThreads.id, s.threadId)).run();
    };
    await assert.rejects(() => s.controller.restoreThread(s.threadId), /compare-and-swap/);
    // Our own ephemeral session (a number >= 1 but not the winner) was detached.
    const ourSessions = s.cdp.detachedSessions.filter((id) => id !== winnerSession);
    assert.ok(ourSessions.length >= 1, "the losing restore must detach its own ephemeral session");
    assert.equal(s.cdp.attached.has(winnerSession), true, "the newer binding's session must stay attached");
    assert.equal(s.cdp.detachedSessions.includes(winnerSession), false, "the losing restore must not detach the newer binding");
    // No stale cache and no durable overwrite from the loser.
    const thread = s.db.db.select().from(reviewThreads).where(eq(reviewThreads.id, s.threadId)).get()!;
    assert.equal(thread.browserCdpSessionId, winnerSession, "loser must not overwrite the winning durable session");
  }

  // -------------------------------------------------------------------------
  // 6. Successful restores dispose only the superseded session; the newly
  //    committed durable session stays attached so a returned driver and any
  //    later dispatch keep driving the restored tab. This mirrors the
  //    claim-rejection shape (restore commits, then the turn is unused) so
  //    repeated cycles never accumulate orphaned attachments.
  // -------------------------------------------------------------------------
  {
    const s = await newScenario();
    scenarios.push(s);
    for (let i = 0; i < 3; i += 1) {
      const restored = await s.controller.restoreThread(s.threadId);
      assert.equal(restored.target.targetId, "tab-restore");
      // The committed durable binding must remain attached (never detached on success).
      assert.equal(s.cdp.attached.has(restored.target.sessionId), true, "the newly committed binding must stay attached");
    }
    // After several restores exactly one live attachment remains: every superseded
    // session was disposed, so no orphaned CDP attachments accumulate.
    assert.equal(s.cdp.attached.size, 1, "successful restores must not accumulate orphaned CDP attachments");
    const thread = s.db.db.select().from(reviewThreads).where(eq(reviewThreads.id, s.threadId)).get()!;
    assert.equal(thread.browserCdpSessionId, [...s.cdp.attached][0], "durable session matches the single live attachment");
  }

  console.log(`review-browser restore cleanup: PASS (${scenarios.length} scenarios)`);
} finally {
  for (const s of scenarios) s.db.close();
  for (const s of scenarios) await rm(s.stateDir, { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
}