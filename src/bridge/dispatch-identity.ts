/**
 * Stable ACP dispatch identity.
 *
 * A dispatch idempotency key must identify the delivery INTENT, not the
 * call: the same intent retried (transport error, crash, reconnect) must
 * reuse the same run without spawning a duplicate worker, while a new
 * intent (new feedback round, new clientMutationId, different task, or a
 * definitively-rejected attempt) must get a new key. The gateway's
 * per-call `disp_<uuid>` minting cannot express that distinction, so
 * callers derive keys here and only the keyless fallback mints.
 *
 * Key shape: `disp_v1_<sha256hex(intent-root)>_g<generation>`. The root
 * binds workSessionId + intentId + feedbackEpoch + latestFeedbackId +
 * agentId + taskFingerprint. The generation increments past a terminal
 * (rejected) attempt with the same root, because a rejected attempt can
 * never be re-POSTed under its key. Everything else (attemptNumber,
 * timestamps, lease nonce/expiry, worker tokens) is derived output and
 * is deliberately excluded.
 */
import { createHash } from "node:crypto";
import type { AgentRegistryManager } from "../acp-registry.js";

export interface DispatchIntentInput {
  workSessionId: string;
  /** Durable per-intent id, in priority order: continuation.id,
   * clientMutationId, or the "initial" marker for a fresh session. */
  intentId: string;
  feedbackEpoch: number;
  latestFeedbackId?: string;
  /** Selected peer identity (NOT name/URL: a name can re-register). */
  agentId: string;
  task: string;
}

const TERMINAL_REPLAYABLE_STATUSES = new Set(["rejected", "unstarted"]);

export function dispatchIntentRoot(input: DispatchIntentInput): string {
  const hash = createHash("sha256");
  for (const part of [
    "disp-v1",
    input.workSessionId,
    input.intentId,
    String(input.feedbackEpoch),
    input.latestFeedbackId ?? "none",
    input.agentId,
    createHash("sha256").update(input.task).digest("hex"),
  ]) {
    hash.update(part).update("\n");
  }
  return hash.digest("hex");
}

export function dispatchIdempotencyKey(root: string, generation: number): string {
  return `disp_v1_${root}_g${generation}`;
}

/** Generation for a root: replay the existing generation while its latest
 * attempt is still live (dispatching/accepted/uncertain); bump past a
 * terminal rejected attempt. Attempts without this root never count. */
export function dispatchGenerationForRoot(
  attempts: Array<{ dispatchIdempotencyKey: string; status: string }>,
  root: string,
): number {
  const prefix = `disp_v1_${root}_g`;
  let latest: { generation: number; status: string } | undefined;
  for (const attempt of attempts) {
    if (!attempt.dispatchIdempotencyKey.startsWith(prefix)) continue;
    const generation = Number(attempt.dispatchIdempotencyKey.slice(prefix.length));
    if (!Number.isInteger(generation) || generation < 1) continue;
    if (!latest || generation > latest.generation) {
      latest = { generation, status: attempt.status };
    }
  }
  if (!latest) return 1;
  return TERMINAL_REPLAYABLE_STATUSES.has(latest.status) ? latest.generation + 1 : latest.generation;
}

export function deriveStableDispatchKey(
  registry: AgentRegistryManager,
  runId: string | undefined,
  input: DispatchIntentInput,
): string {
  const root = dispatchIntentRoot(input);
  const attempts = runId ? registry.listDispatchAttemptsForRun(runId) : [];
  return dispatchIdempotencyKey(root, dispatchGenerationForRoot(attempts, root));
}

export type DispatchReplayState =
  | { kind: "none" }
  | { kind: "accepted"; attempt: ReturnType<AgentRegistryManager["getDispatchAttemptByIdempotencyKey"]> }
  | { kind: "uncertain"; attempt: ReturnType<AgentRegistryManager["getDispatchAttemptByIdempotencyKey"]> };

/** Pre-flight replay check: an attempt bound to this exact key that is
 * not terminally rejected means the intent already reached an adapter
 * (or may have). Accepted replays return the stored run without a new
 * POST; dispatching/uncertain go to reconciliation, never a blind
 * duplicate launch. */
export function checkDispatchReplay(
  registry: AgentRegistryManager,
  key: string,
): DispatchReplayState {
  const attempt = registry.getDispatchAttemptByIdempotencyKey(key);
  if (!attempt) return { kind: "none" };
  if (attempt.status === "accepted") return { kind: "accepted", attempt };
  if (attempt.status === "rejected" || attempt.status === "unstarted") return { kind: "none" };
  return { kind: "uncertain", attempt };
}
