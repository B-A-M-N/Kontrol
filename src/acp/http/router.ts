/**
 * ACP HTTP router assembly: mounts the capability route modules over one
 * shared AcpContext.
 *
 * Extracted from acp-server.ts's createAcpServer closure (P1 decomposition).
 * `createAcpRouter` is the whole wiring story: build context, auth, SSE hub,
 * run support, review barrier — then mount. The signature of `createAcpServer`
 * (its sole caller) is unchanged.
 */
import { Router } from "express";
import type { WebhookPolicy } from "../../webhook-policy.js";
import { ACP_AGENTS } from "./context.js";
import type { AcpContext } from "./context.js";
import { makeAuth } from "./auth.js";
import { makeSseHub } from "./sse-hub.js";
import { makeRunSupport } from "./run-support.js";
import { makeReviewBarrier } from "./review-barrier.js";
import { registerAgentRoutes } from "./agent-routes.js";
import { registerRunRoutes } from "./run-routes.js";
import { registerEventRoutes } from "./event-routes.js";
import { registerReviewRoutes } from "./review-routes.js";

export function createAcpRouter(
  deps: Omit<AcpContext, "effectiveWebhookPolicy" | "sseClients" | "agentMap">,
  webhookPolicy?: WebhookPolicy,
): Router {
  const router = Router();
  const ctx: AcpContext = {
    ...deps,
    effectiveWebhookPolicy: webhookPolicy ?? { enabled: false, allowedHosts: [] },
    sseClients: new Map(),
    agentMap: new Map(ACP_AGENTS.map((a) => [a.name, a])),
  };

  const auth = makeAuth(ctx);
  const sse = makeSseHub(ctx);
  const support = makeRunSupport(ctx);
  const barrier = makeReviewBarrier(ctx);

  // GET /ping
  router.get("/ping", (req, res) => {

  });

  registerAgentRoutes(router, ctx, auth);
  registerRunRoutes(router, ctx, auth, sse, support, barrier);
  registerEventRoutes(router, ctx, auth, barrier);
  registerReviewRoutes(router, ctx, auth);

  return router;
}
