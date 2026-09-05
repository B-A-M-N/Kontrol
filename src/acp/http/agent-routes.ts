/**
 * ACP agent discovery + registration routes (/agents*).
 *
 * Extracted verbatim from acp-server.ts's createAcpServer closure (P1
 * decomposition). Covers local agent discovery, peer registration (loopback
 * only in this release), heartbeat, and per-agent credential lifecycle.
 */
import type { Router } from "express";
import { AgentRegistrationError } from "../../acp-registry.js";
import { isLoopbackAgentUrl } from "../../acp-gateway.js";
import { ACP_AGENTS } from "./context.js";
import { agentRegistrationSchema } from "./schemas.js";
import type { AcpContext } from "./context.js";
import type { makeAuth } from "./auth.js";

export function registerAgentRoutes(router: Router, ctx: AcpContext, auth: ReturnType<typeof makeAuth>) {
  const { agentRegistry, agentMap } = ctx;
  const { authGate, requireAgentOwnership } = auth;

  // ── Agent Discovery ──────────────────────────────────

  router.get("/agents", (req, res) => {
    if (!authGate(req, res, ["reviewer", "operator"])) return;
    const local = ACP_AGENTS.map((a) => ({
      name: a.name,
      description: a.description,
      input_content_types: ["application/json", "text/plain"],
      output_content_types: ["text/plain"],
      metadata: {
        tags: ["Code", "Kontrol"],
        capabilities: [{ name: a.name, description: a.description }],
      },
    }));
    const peers = agentRegistry.listAlive().map((a) => ({
      name: a.name,
      description: a.description ?? "Remote peer agent",
      input_content_types: ["application/json", "text/plain"],
      output_content_types: ["text/plain"],
      metadata: {
        role: a.role,
        tags: a.tags,
        capabilities: (a.capabilities ?? []).map((c: string) => ({ name: c, description: c })),
      },
    }));
    res.json({ agents: [...local, ...peers] });
  });

  router.get("/agents/:name", (req, res) => {
    if (!authGate(req, res, ["reviewer", "operator"])) return;
    const local = ctx.agentMap.get(req.params.name);
    if (local) {
      res.json({ name: local.name, description: local.description, input_content_types: ["application/json", "text/plain"], output_content_types: ["text/plain"], metadata: { tags: ["Code", "Kontrol"] } });
      return;
    }
    const peer = agentRegistry.listAlive().find((a) => a.name === req.params.name);
    if (!peer) {
      res.status(404).json({ error: { code: "not_found", message: `Unknown agent: ${req.params.name}` } });
      return;
    }
    res.json({
      name: peer.name,
      url: peer.url,
      description: peer.description,
      input_content_types: ["application/json", "text/plain"],
      output_content_types: ["text/plain"],
      metadata: { role: peer.role, tags: peer.tags, capabilities: peer.capabilities },
    });
  });

  // ── Agent Registration ──────────────────────────────

  router.post("/agents/register", (req, res) => {
    const role = authGate(req, res, ["agent", "operator"]);
    if (!role) return;
    const parsed = agentRegistrationSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "invalid_input", message: "Invalid agent registration", issues: parsed.error.issues } });
      return;
    }
    const { name, url, description, publicKey, capabilities, tags, ttlSeconds, role: registeredRole } = parsed.data;
    // An agent secret must NOT allow self-registration as "client" or "reviewer".
    // Those roles are reserved for the WebUI / reviewer, which uses the reviewer secret.
    if (registeredRole === "client" || registeredRole === "reviewer") {
      res.status(403).json({ error: { code: "forbidden", message: "Agent secret cannot register as client or reviewer" } });
      return;
    }
    // P1 #10: the MVP local-agent path only accepts loopback endpoints.
    // Kontrol would otherwise probe and dispatch to an arbitrary URL,
    // turning agent registration into a generic internal-network fetcher.
    // Remote peers require an explicit host allowlist (future work).
    if (!isLoopbackAgentUrl(url)) {
      res.status(400).json({ error: { code: "invalid_input", message: "ACP agent registrations must use a loopback URL (127.0.0.1, localhost, ::1). Remote peers are not supported in this release." } });
      return;
    }
    try {
      const agent = agentRegistry.register({
        name,
        url,
        description,
        publicKey,
        capabilities,
        tags,
        ttlSeconds,
        agentId: req.header("x-kontrol-agent-id") ?? undefined,
        agentCredential: req.header("x-kontrol-agent-credential") ?? undefined,
      });
      res.status(201).json(agent);
    } catch (error) {
      if (error instanceof AgentRegistrationError) {
        res.status(error.status).json({ error: { code: error.code, message: error.message } });
        return;
      }
      throw error;
    }
  });

  router.post("/agents/:id/heartbeat", (req, res) => {
    const role = authGate(req, res, ["agent", "operator"]);
    if (!role) return;
    if (!requireAgentOwnership(req, res, role, req.params.id)) return;
    const credential = role === "agent" ? req.header("x-kontrol-agent-credential") ?? undefined : undefined;
    if (!agentRegistry.heartbeat(req.params.id, credential)) {
      res.status(404).json({ error: { code: "not_found", message: `Unknown agent: ${req.params.id}` } });
      return;
    }
    res.json({ ok: true });
  });

  router.post("/agents/:id/credential/rotate", (req, res) => {
    const role = authGate(req, res, ["agent", "operator"]);
    if (!role) return;
    const presentedCredential = req.header("x-kontrol-agent-credential") ?? undefined;
    try {
      const agentCredential = agentRegistry.rotateAgentCredential(req.params.id, presentedCredential, role === "operator");
      // This is the only response that contains the new raw credential. It is
      // never persisted in the registry or written to logs.
      res.json({ agentId: req.params.id, agentCredential });
    } catch (error) {
      if (error instanceof AgentRegistrationError) {
        res.status(error.status).json({ error: { code: error.code, message: error.message } });
        return;
      }
      throw error;
    }
  });

  router.delete("/agents/:id/credential", (req, res) => {
    const role = authGate(req, res, ["agent", "operator"]);
    if (!role) return;
    try {
      agentRegistry.revokeAgentCredential(req.params.id, req.header("x-kontrol-agent-credential") ?? undefined, role === "operator");
      res.status(204).end();
    } catch (error) {
      if (error instanceof AgentRegistrationError) {
        res.status(error.status).json({ error: { code: error.code, message: error.message } });
        return;
      }
      throw error;
    }
  });

  router.delete("/agents/:id", (req, res) => {
    if (!authGate(req, res, ["reviewer", "operator"])) return;
    agentRegistry.unregister(req.params.id);
    res.status(204).end();
  });
}
