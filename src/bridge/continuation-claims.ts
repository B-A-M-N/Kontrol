/**
 * Durable outbox claims: enqueue ready continuations for this dispatcher.
 */
import { DEFAULT_CLAIM_LEASE_MS } from "../continuation.js";
import type { DispatchContext } from "./dispatch-context.js";

import type { Continuation } from "../continuation.js";
import type { DispatchOutboxEvent } from "../dispatch-outbox.js";

/** Durable outbox claims: enqueue ready continuations for this dispatcher. */

export function enqueueReadyContinuations(ctx: DispatchContext): void {
  const outbox = ctx.config.dispatchOutbox;
  if (!outbox) return;
        for (const cont of ctx.config.continuationManager.listPending()) {
          if (!outbox.hasLogical("continuation.ready", cont.id, cont.reviewEpoch)) {
            outbox.enqueue({
              eventType: "continuation.ready",
              aggregateId: cont.id,
              aggregateRevision: cont.reviewEpoch,
              payload: {
                sessionId: cont.sessionId,
                continuationId: cont.id,
                revision: cont.reviewEpoch,
              },
            });
          }
        }
}
