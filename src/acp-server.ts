import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { Router } from "express";
import type { Request, Response } from "express";
import type { WorkspaceRegistry } from "./workspaces.js";
import type { WorkSessionManager } from "./work-sessions.js";
import type { AgentRegistryManager, AgentInfo } from "./acp-registry.js";
import type { EventStore } from "./event-log.js";
import type { ContinuationManager } from "./continuation.js";
import type { ReviewCheckpointManager } from "./review-checkpoints.js";
import type { ReviewWorkflowService } from "./review-workflow.js";
import { cancelRemoteRun, dispatchToPeer, executeKontrolTool, selectHealthyAgent } from "./acp-gateway.js";
import { createPolicyEnforcer, type PolicyEnforcer, type PolicyInvocation, ACP_TOOL_POLICY_NAMES, type PrincipalRole } from "./policy-enforcement.js";
import type { ApprovalRequestManager, ApprovalOption } from "./approval-requests.js";
import { authorizeWorkSessionAction } from "./work-session-action-guard.js";

/**
 * Long-poll window for a blocking agent permission request. This is NOT a
 * deadline: when it elapses the approval stays pending and the caller re-parks
 * (people step away for a long time). It only bounds how long a single HTTP
 * request is held so sockets/proxies don't die mid-wait.
 */
const APPROVAL_WAIT_TIMEOUT_MS = 300_000;

const ACP_AGENTS = [
  { name: "kontrol-read", description: "Read a file from the workspace." },
  { name: "kontrol-write", description: "Write or overwrite a file in the workspace." },
  { name: "kontrol-edit", description: "Edit a file by replacing exact text blocks." },
  { name: "kontrol-grep", description: "Search file contents by pattern." },
  { name: "kontrol-glob", description: "Find files by glob pattern." },
  { name: "kontrol-shell", description: "Execute a shell command in the workspace." },
  { name: "kontrol-review", description: "Submit work for human review and await feedback." },
  {
    name: "kontrol-agent-registry",
    description: "Register, discover, and list peer agents. For agent-to-agent routing.",
  },
  {
    name: "kontrol-submit-work-to-webui",
    description: "Submit completed work (diff/checkpoint) to the Kontrol WebUI for human review. (Ralphie Muntz Loop terminus: the WebUI's 'A-okay' is the only completion criterion.)",
  },
];

const MUTATING_LOCAL_AGENTS = new Set([
  "kontrol-write",
  "kontrol-edit",
  "kontrol-shell",
  "kontrol-review",
  "kontrol-submit-work-to-webui",
]);

export function createAcpServer(
  workspaces: WorkspaceRegistry,
  workSessions: WorkSessionManager,
  agentRegistry: AgentRegistryManager,
  sharedSecret?: string,
  eventStore?: EventStore,
  continuationManager?: ContinuationManager,
  reviewCheckpoints?: ReviewCheckpointManager,
  reviewWorkflow?: ReviewWorkflowService,
  policyEnforcer?: PolicyEnforcer,
  approvalRequests?: ApprovalRequestManager,
  agentSecret?: string,
  reviewerSecret?: string,
): Router {
  const router = Router();
  const sseClients = new Map<string, Set<Response>>();
  const agentMap = new Map(ACP_AGENTS.map((a) => [a.name, a]));

  /**
   * Authenticate with the appropriate secret based on the claimed role.
   * A worker/agent must use the agent secret; a reviewer/client must use the
   * reviewer secret. An agent secret must NOT allow self-registration as
   * "client" or "reviewer".
   */
  type AcpRole = "agent" | "reviewer" | "operator";

  function authenticateAcpRequest(req: Request): AcpRole | undefined {
    const auth = req.headers.authorization;
    if (agentSecret && auth === `Bearer ${agentSecret}`) return "agent";
    if (reviewerSecret && auth === `Bearer ${reviewerSecret}`) return "reviewer";
    if (sharedSecret && auth === `Bearer ${sharedSecret}`) return "operator";
    return undefined;
  }

  function authGate(req: Request, res: Response, allowedRoles: AcpRole[] = ["agent", "reviewer", "operator"]): boolean {
    if (!sharedSecret && !agentSecret && !reviewerSecret) {
      res.status(401).json({ error: { code: "unauthorized", message: "ACP is disabled: no shared secret configured" } });
      return false;
    }
    const role = authenticateAcpRequest(req);
    if (role && allowedRoles.includes(role)) return true;
    if (role) {
      res.status(403).json({ error: { code: "forbidden", message: `ACP role ${role} is not allowed for this operation` } });
      return false;
    }
    res.status(401).json({ error: { code: "unauthorized", message: "Missing or invalid authorization" } });
    return false;
  }

  function emitSse(runId: string, event: string, data: unknown): void {
    const clients = sseClients.get(runId);
    if (!clients) return;
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) {
      try { res.write(payload); } catch { clients.delete(res); }
    }
    if (clients.size === 0) sseClients.delete(runId);
  }

  function sseSubscribe(runId: string, req: Request, res: Response): void {
    if (!sseClients.has(runId)) sseClients.set(runId, new Set());
    sseClients.get(runId)!.add(res);
    req.on("close", () => {
      const clients = sseClients.get(runId);
      if (clients) { clients.delete(res); if (clients.size === 0) sseClients.delete(runId); }
    });
  }

  function resolveCwd(sessionId: string): { cwd: string; root: string } | undefined {
    const session = workSessions.get(sessionId);
    if (!session) return undefined;
    try {
      const ws = workspaces.getWorkspace(session.workspaceSessionId);
      return { cwd: ws.root, root: ws.root };
    } catch { return undefined; }
  }

  function extractTaskText(input: Array<{ parts?: Array<{ content?: string }> }>): string {
    return input.map((m) => m.parts?.map((p) => p.content ?? "").join("\n") ?? "").filter(Boolean).join("\n");
  }

  function resolveRunContext(
    res: Response,
    input: {
      workspace_id?: string;
      workspace_session_id?: string;
      work_session_id?: string;
      session_id?: string;
      submittedBy: string;
      title: string;
    },
  ): { workspaceId: string; workspaceRoot: string; session: ReturnType<WorkSessionManager["create"]>; createdSession: boolean } | undefined {
    const suppliedWorkSessionId = input.work_session_id ?? input.session_id;
    const suppliedWorkspaceId = input.workspace_id ?? input.workspace_session_id;

    let session = suppliedWorkSessionId ? workSessions.get(suppliedWorkSessionId) : undefined;
    if (suppliedWorkSessionId && !session) {
      res.status(404).json({ error: { code: "not_found", message: `Unknown work session: ${suppliedWorkSessionId}` } });
      return undefined;
    }

    const workspaceId = suppliedWorkspaceId ?? session?.workspaceSessionId;
    if (!workspaceId) {
      res.status(400).json({
        error: {
          code: "invalid_input",
          message: "workspace_id or workspace_session_id is required unless work_session_id/session_id names an existing work session",
        },
      });
      return undefined;
    }

    if (session && session.workspaceSessionId !== workspaceId) {
      res.status(409).json({ error: { code: "conflict", message: "work_session_id does not belong to the supplied workspace" } });
      return undefined;
    }

    let workspaceRoot: string;
    try {
      workspaceRoot = workspaces.getWorkspace(workspaceId).root;
    } catch (error) {
      res.status(400).json({
        error: {
          code: "invalid_workspace",
          message: error instanceof Error ? error.message : `Unknown workspace: ${workspaceId}`,
        },
      });
      return undefined;
    }

    let createdSession = false;
    if (!session) {
      session = workSessions.create({
        workspaceSessionId: workspaceId,
        submittedBy: input.submittedBy,
        title: input.title,
      });
      createdSession = true;
    }

    return { workspaceId, workspaceRoot, session, createdSession };
  }

  async function acquireCheckoutModifyLease(
    res: Response,
    workspaceId: string,
    workspaceRoot: string,
    workSessionId: string,
  ): Promise<boolean> {
    let workspaceMode = "checkout";
    try {
      workspaceMode = workspaces.getWorkspace(workspaceId).mode;
    } catch {
      workspaceMode = "checkout";
    }
    if (workspaceMode !== "checkout") return true;

    let canonicalRoot: string;
    try {
      canonicalRoot = await realpath(workspaceRoot);
    } catch (error) {
      res.status(400).json({
        error: {
          code: "invalid_workspace",
          message: `Unable to resolve checkout root: ${error instanceof Error ? error.message : String(error)}`,
        },
      });
      return false;
    }

    const lease = workSessions.acquireWorkspaceLease({
      canonicalRoot,
      workspaceSessionId: workspaceId,
      workSessionId,
    });
    if (lease.acquired) return true;
    res.status(409).json({
      error: {
        code: "checkout_busy",
        message: `Checkout is already controlled by work session ${lease.conflictingWorkSessionId}. Use an isolated worktree or cancel the existing session before dispatching another modifying worker.`,
        conflicting_work_session_id: lease.conflictingWorkSessionId,
        workspace_session_id: lease.workspaceSessionId,
        expires_at: lease.expiresAt,
      },
    });
    return false;
  }

  // GET /ping
  router.get("/ping", (req, res) => {
    if (!authGate(req, res)) return;
    res.json({ ok: true });
  });

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
    const local = agentMap.get(req.params.name);
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
    if (!authGate(req, res, ["agent", "operator"])) return;
    const { name, url, description, publicKey, capabilities, tags, ttlSeconds, role } = req.body;
    if (!name || !url) {
      res.status(400).json({ error: { code: "invalid_input", message: "name and url are required" } });
      return;
    }
    // An agent secret must NOT allow self-registration as "client" or "reviewer".
    // Those roles are reserved for the WebUI / reviewer, which uses the reviewer secret.
    if (role === "client" || role === "reviewer") {
      res.status(403).json({ error: { code: "forbidden", message: "Agent secret cannot register as client or reviewer" } });
      return;
    }
    const agent = agentRegistry.register({ name, url, description, publicKey, capabilities, tags, ttlSeconds });
    res.status(201).json(agent);
  });

  router.post("/agents/:id/heartbeat", (req, res) => {
    if (!authGate(req, res, ["agent", "operator"])) return;
    agentRegistry.heartbeat(req.params.id);
    res.json({ ok: true });
  });

  router.delete("/agents/:id", (req, res) => {
    if (!authGate(req, res, ["reviewer", "operator"])) return;
    agentRegistry.unregister(req.params.id);
    res.status(204).end();
  });

  // ── Run Execution ──────────────────────────────────

  router.post("/runs", async (req: Request, res: Response) => {
    if (!authGate(req, res, ["reviewer", "operator"])) return;

    const { agent_name, input, mode, session_id, work_session_id, workspace_id, workspace_session_id, webhook_url } = req.body as {
      agent_name?: string;
      input?: Array<{ parts?: Array<{ content?: string }> }>;
      mode?: string;
      session_id?: string;
      work_session_id?: string;
      workspace_id?: string;
      workspace_session_id?: string;
      webhook_url?: string;
    };

    if (!agent_name || !input?.length) {
      res.status(400).json({ error: { code: "invalid_input", message: "agent_name and input are required" } });
      return;
    }

    const agent = agentMap.get(agent_name);
    if (!agent) {
      const selection = await selectHealthyAgent(agentRegistry.listAlive(), {
        name: agent_name,
        role: "agent",
        sharedSecret,
      });
      if (!selection.agent) {
        const dead = selection.deadUrls.length
          ? ` Dead/unhealthy endpoints found: ${selection.deadUrls.join("; ")}.`
          : "";
        if (dead) {
          res.status(502).json({ error: { code: "unavailable", message: `No healthy ACP agent named ${agent_name}.${dead}` } });
        } else {
          res.status(404).json({ error: { code: "not_found", message: `Unknown agent: ${agent_name}` } });
        }
        return;
      }
      const peer = selection.agent;
      const taskText = extractTaskText(input);
      const context = resolveRunContext(res, {
        workspace_id,
        workspace_session_id,
        work_session_id,
        session_id,
        submittedBy: "acp",
        title: `${agent_name}: ${taskText.slice(0, 100)}`,
      });
      if (!context) return;
      const { session, workspaceRoot, createdSession } = context;
      if (!(await acquireCheckoutModifyLease(res, session.workspaceSessionId, workspaceRoot, session.id))) {
        if (createdSession) workSessions.updateStatus(session.id, "cancelled");
        return;
      }

      const run = agentRegistry.createRun({ agentName: agent_name, workspaceSessionId: session.workspaceSessionId, workSessionId: session.id, inputPreview: taskText.slice(0, 500), webhookUrl: webhook_url, status: "running" });

      try {
        const peerResp = await dispatchToPeer({
          agentUrl: peer.url,
          sharedSecret,
          body: {
            agent_name,
            mode: mode ?? "async",
            input,
            session_id: session.id,
            work_session_id: session.id,
            workspace_session_id: session.workspaceSessionId,
            workspace_root: workspaceRoot,
            parent_run_id: run.runId,
            webhook_url,
          },
          timeoutMs: 120_000,
        });
        const peerResult = peerResp.body;
        const remoteRunId = typeof peerResult.remote_run_id === "string"
          ? peerResult.remote_run_id
          : typeof peerResult.run_id === "string"
            ? peerResult.run_id
            : undefined;
        agentRegistry.updateRun(run.runId, {
          status: peerResp.status === 202 || peerResult.accepted === true ? "running" : "completed",
          remoteRunId,
          outputJson: JSON.stringify(peerResult).slice(0, 10_000),
          finishedAt: peerResp.status === 202 || peerResult.accepted === true ? undefined : new Date().toISOString(),
        });
        res.status(peerResp.status === 202 || mode === "async" ? 202 : 200).json({ ...peerResult, kontrol_run_id: run.runId, session_id: session.id });
      } catch (error) {
        agentRegistry.updateRun(run.runId, { status: "failed", errorMessage: error instanceof Error ? error.message : String(error), finishedAt: new Date().toISOString() });
        res.status(502).json({ agent_name, run_id: run.runId, status: "failed", error: { message: `Peer routing failed: ${error instanceof Error ? error.message : String(error)}` }, output: [], created_at: run.createdAt, finished_at: new Date().toISOString() });
      }
      return;
    }

    // ── Local agent execution ──

    const taskText = extractTaskText(input);
    const context = resolveRunContext(res, {
      workspace_id,
      workspace_session_id,
      work_session_id,
      session_id,
      submittedBy: "acp",
      title: `${agent_name}: ${taskText.slice(0, 100)}`,
    });
    if (!context) return;
    const { session, workspaceRoot, createdSession } = context;
    if (MUTATING_LOCAL_AGENTS.has(agent_name) && !(await acquireCheckoutModifyLease(res, session.workspaceSessionId, workspaceRoot, session.id))) {
      if (createdSession) workSessions.updateStatus(session.id, "cancelled");
      return;
    }

    const run = agentRegistry.createRun({ agentName: agent_name, workspaceSessionId: session.workspaceSessionId, workSessionId: session.id, inputPreview: taskText.slice(0, 500), webhookUrl: webhook_url, status: "in-progress" });

    // kontrol-review: enter awaiting
    if (agent_name === "kontrol-review") {
      agentRegistry.updateRun(run.runId, { status: "awaiting" });
      emitSse(run.runId, "run.awaiting", { run });

      if (mode === "stream") {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
        sseSubscribe(run.runId, req, res);
        res.write(`event: run.awaiting\ndata: ${JSON.stringify({ agent_name, run_id: run.runId, session_id: session.id, status: "awaiting", output: [], created_at: run.createdAt })}\n\n`);
        return;
      }
      res.status(mode === "async" ? 202 : 200).json({ agent_name, run_id: run.runId, session_id: session.id, status: "awaiting", output: [], created_at: run.createdAt });
      return;
    }

    // kontrol-agent-registry: list registered peers
    if (agent_name === "kontrol-agent-registry") {
      const alive = agentRegistry.listAlive();
      const output = `Discovered ${alive.length} peer(s):\n${alive.map((a) => `  ${a.name} [${a.role}] → ${a.url}${a.alive ? "" : " (stale)"}`).join("\n")}`;
      agentRegistry.updateRun(run.runId, { status: "completed", outputPreview: output, finishedAt: new Date().toISOString() });

      if (webhook_url) agentRegistry.enqueueWebhook(run.runId, webhook_url, { agent_name, run_id: run.runId, status: "completed", output: [{ role: "agent", parts: [{ content_type: "text/plain", content: output }] }] });

      res.status(mode === "async" ? 202 : 200).json({ agent_name, run_id: run.runId, session_id: session.id, status: "completed", output: [{ role: "agent", parts: [{ content_type: "text/plain", content: output }] }], created_at: run.createdAt, finished_at: new Date().toISOString() });
      return;
    }

    // kontrol-submit-work-to-webui: agent → WebUI review surface
    if (agent_name === "kontrol-submit-work-to-webui") {
      if (!reviewCheckpoints) {
        agentRegistry.updateRun(run.runId, { status: "failed", errorMessage: "Review checkpoints are not available.", finishedAt: new Date().toISOString() });
        res.status(500).json({ agent_name, run_id: run.runId, status: "failed", error: { message: "Review checkpoints unavailable" }, output: [], created_at: run.createdAt, finished_at: new Date().toISOString() });
        return;
      }

      // P1 #3: enforce the reviewer's allowedNextActions on resubmission. A
      // reviewer that omitted "resubmit" cannot be bypassed by calling
      // kontrol-submit-work-to-webui again while changes_requested.
      const resubmitDecision = authorizeWorkSessionAction(workSessions, {
        workSessionId: session.id,
        tool: "kontrol-submit-work-to-webui",
      });
      if (!resubmitDecision.allowed) {
        agentRegistry.updateRun(run.runId, { status: "failed", errorMessage: resubmitDecision.reason, finishedAt: new Date().toISOString() });
        res.status(403).json({ agent_name, run_id: run.runId, status: "failed", error: { message: resubmitDecision.reason ?? "Resubmission not permitted by the reviewer's allowedNextActions." }, output: [], created_at: run.createdAt, finished_at: new Date().toISOString() });
        return;
      }

      let wsRoot: string;
      try {
        wsRoot = workspaces.getWorkspace(session.workspaceSessionId).root;
      } catch {
        agentRegistry.updateRun(run.runId, { status: "failed", errorMessage: "Workspace not found. Open a workspace via MCP first.", finishedAt: new Date().toISOString() });
        res.status(400).json({ agent_name, run_id: run.runId, status: "failed", error: { message: "Workspace not found" }, output: [], created_at: run.createdAt, finished_at: new Date().toISOString() });
        return;
      }

      try {
        // Capture the diff WITHOUT advancing the checkpoint. The checkpoint is
        // only committed AFTER the submission is persisted, so a failure between
        // capture and persistence cannot silently drop the diff (mirrors the
        // safe MCP path; P1 #2).
        const review = await reviewCheckpoints.reviewChanges({
          workspaceId: session.workspaceSessionId,
          root: wsRoot,
          since: "work_session",
          workSessionId: session.id,
          markReviewed: false,
        });

        // Delegate the state transition to the authoritative workflow service.
        const submitted = reviewWorkflow
          ? reviewWorkflow.submitForReview({ workSessionId: session.id, diff: review.patch, message: taskText || review.result, summaryJson: JSON.stringify(review.summary), files: review.summary.files, additions: review.summary.additions, removals: review.summary.removals, snapshotCommit: review.snapshotCommit })
          : (() => {
              const s = workSessions.submitForReview({ workSessionId: session.id, diff: review.patch, message: taskText || review.result, summaryJson: JSON.stringify(review.summary), snapshotCommit: review.snapshotCommit });
              return { submissionId: s.id, submissionNumber: s.submissionNumber, diffSha256: s.diffSha256, reviewEpoch: s.reviewEpoch };
            })();

        // Advance the review baseline to the EXACT captured snapshot only after
        // the submission was persisted, so a crash cannot strand the diff.
        if (reviewWorkflow) {
          await reviewCheckpoints.commitReviewed({
            workspaceId: session.workspaceSessionId,
            root: wsRoot,
            workSessionId: session.id,
            snapshotCommit: review.snapshotCommit,
          });
        }

        agentRegistry.updateRun(run.runId, { status: "awaiting", finishedAt: new Date().toISOString() });

        const card = {
          tool: "submit_for_review",
          workspaceId: session.workspaceSessionId,
          status: "awaiting_review",
          summary: { ...review.summary, submissionId: submitted.submissionId, sessionId: session.id, submissionNumber: submitted.submissionNumber, message: taskText || review.result, diffSha256: submitted.diffSha256, reviewEpoch: submitted.reviewEpoch },
          files: review.files,
          payload: { patch: review.patch },
        };

        // NOTE: The reviewWorkflow.submitForReview() call above already emits the
        // canonical `review.submitted` event with file stats. Do NOT emit a second
        // one here — that caused duplicate watcher activity and duplicate UI fetches.
        emitSse(run.runId, "run.submitted", { run, card });

        res.status(200).json({
          agent_name,
          run_id: run.runId,
          session_id: session.id,
          status: "awaiting_review",
          output: [{ role: "agent", parts: [{ content_type: "text/plain", content: `Submitted #${submitted.submissionNumber}: ${review.summary.files} file(s), +${review.summary.additions} -${review.summary.removals}. Awaiting WebUI sign-off (A-okay).` }] }],
          card,
          created_at: run.createdAt,
          finished_at: new Date().toISOString(),
        });
        return;
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        agentRegistry.updateRun(run.runId, { status: "failed", errorMessage: errorMsg, finishedAt: new Date().toISOString() });
        res.status(500).json({ agent_name, run_id: run.runId, status: "failed", error: { message: errorMsg }, output: [], created_at: run.createdAt, finished_at: new Date().toISOString() });
        return;
      }
    }

    // Execute Kontrol tool with policy enforcement
    const wsCtx = resolveCwd(session.id);
    if (!wsCtx) {
      agentRegistry.updateRun(run.runId, { status: "failed", errorMessage: "Workspace not found. Open a workspace via MCP first.", finishedAt: new Date().toISOString() });
      res.status(400).json({ agent_name, run_id: run.runId, status: "failed", error: { message: "Workspace not found" }, output: [], created_at: run.createdAt, finished_at: new Date().toISOString() });
      return;
    }

    try {
      const canonicalTool = ACP_TOOL_POLICY_NAMES[agent_name] ?? agent_name;
      const sessionDecision = authorizeWorkSessionAction(workSessions, {
        workSessionId: session.id,
        tool: canonicalTool,
        path: wsCtx.cwd,
      });
      if (!sessionDecision.allowed) {
        agentRegistry.updateRun(run.runId, { status: "failed", errorMessage: sessionDecision.reason, finishedAt: new Date().toISOString() });
        res.status(403).json({ agent_name, run_id: run.runId, status: "failed", error: { message: sessionDecision.reason ?? `Tool "${agent_name}" denied by work-session policy.` }, output: [], created_at: run.createdAt, finished_at: new Date().toISOString() });
        return;
      }

      // Policy enforcement for ACP tools (kontrol-*)
      if (policyEnforcer) {
        const { allowed } = await policyEnforcer.enforce({
          principalId: session.id,
          principalRole: "worker",
          workspaceId: session.workspaceSessionId,
          workSessionId: session.id,
          runId: run.runId,
          tool: canonicalTool,
          path: wsCtx.cwd, // working dir for shell tools
        });
        if (!allowed) {
          agentRegistry.updateRun(run.runId, { status: "failed", errorMessage: `Tool "${agent_name}" denied by policy.`, finishedAt: new Date().toISOString() });
          res.status(403).json({ agent_name, run_id: run.runId, status: "failed", error: { message: `Tool "${agent_name}" denied by policy.` }, output: [], created_at: run.createdAt, finished_at: new Date().toISOString() });
          return;
        }
      }

      const output = await executeKontrolTool(agent_name, taskText, wsCtx.cwd, wsCtx.root);
      agentRegistry.updateRun(run.runId, { status: "completed", outputPreview: output.slice(0, 2000), finishedAt: new Date().toISOString() });

      workSessions.logToolEvent({ workSessionId: session.id, workspaceSessionId: session.workspaceSessionId, tool: agent_name, inputJson: taskText, outputSummary: output.slice(0, 500), success: true, elapsedMs: 0 });

      if (webhook_url) agentRegistry.enqueueWebhook(run.runId, webhook_url, { agent_name, run_id: run.runId, status: "completed", output: [{ role: "agent", parts: [{ content_type: "text/plain", content: output }] }] });

      if (mode === "stream") {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
        res.write(`event: run.completed\ndata: ${JSON.stringify({ agent_name, run_id: run.runId, status: "completed", output: [{ role: "agent", parts: [{ content_type: "text/plain", content: output }] }] })}\n\n`);
        res.end();
        return;
      }

      res.status(mode === "async" ? 202 : 200).json({ agent_name, run_id: run.runId, session_id: session.id, status: "completed", output: [{ role: "agent", parts: [{ content_type: "text/plain", content: output }] }], created_at: run.createdAt, finished_at: new Date().toISOString() });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      agentRegistry.updateRun(run.runId, { status: "failed", errorMessage: errorMsg, finishedAt: new Date().toISOString() });

      if (webhook_url) agentRegistry.enqueueWebhook(run.runId, webhook_url, { agent_name, run_id: run.runId, status: "failed", error: { message: errorMsg } });

      res.status(500).json({ agent_name, run_id: run.runId, status: "failed", error: { message: errorMsg }, output: [], created_at: run.createdAt, finished_at: new Date().toISOString() });
    }
  });

  // GET /runs/{run_id}
  router.get("/runs/:run_id", (req, res) => {
    if (!authGate(req, res, ["reviewer", "operator"])) return;
    const run = agentRegistry.getRun(req.params.run_id);
    if (!run) { res.status(404).json({ error: { code: "not_found", message: "Run not found" } }); return; }
    res.json({
      agent_name: run.agentName,
      run_id: run.runId,
      session_id: run.workSessionId,
      status: run.status,
      output: run.outputJson ? JSON.parse(run.outputJson).output ?? [] : [],
      error: run.errorMessage ? { message: run.errorMessage } : undefined,
      created_at: run.createdAt,
      finished_at: run.finishedAt,
    });
  });

  // GET /runs/{run_id}/events — SSE stream
  router.get("/runs/:run_id/events", (req, res) => {
    if (!authGate(req, res, ["reviewer", "operator"])) return;
    const run = agentRegistry.getRun(req.params.run_id);
    if (!run) { res.status(404).json({ error: { code: "not_found", message: "Run not found" } }); return; }

    if ((req.headers.accept ?? "").includes("text/event-stream")) {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
      res.write(`event: run.${run.status}\ndata: ${JSON.stringify(run)}\n\n`);
      sseSubscribe(run.runId, req, res);
      return;
    }
    res.json({ events: [{ type: `run.${run.status}`, run }] });
  });

  // POST /runs/{run_id} — resume an awaiting run (submit feedback)
  router.post("/runs/:run_id", async (req, res) => {
    if (!authGate(req, res, ["reviewer", "operator"])) return;

    const run = agentRegistry.getRun(req.params.run_id);
    if (!run) { res.status(404).json({ error: { code: "not_found", message: "Run not found" } }); return; }

    // Accept both the legacy await_resume envelope and flat fields. The work
    // session is identified by work_session_id (NOT the run's session_id field
    // which is overloaded elsewhere).
    const body = req.body as {
      await_resume?: { session_id?: string; submission_id?: string; diff_sha256?: string; review_epoch?: number; verdict?: string; comments?: string };
      work_session_id?: string;
      submission_id?: string;
      diff_sha256?: string;
      review_epoch?: number;
      verdict?: string;
      comments?: string;
      mode?: string;
    };
    const awaitResume = body.await_resume;
    const sessionId = body.work_session_id ?? awaitResume?.session_id;
    const submissionId = body.submission_id ?? awaitResume?.submission_id;
    const diffSha256 = body.diff_sha256 ?? awaitResume?.diff_sha256;
    const reviewEpoch = body.review_epoch ?? awaitResume?.review_epoch;
    const verdict = body.verdict ?? awaitResume?.verdict;
    const comments = body.comments ?? awaitResume?.comments;
    const mode = body.mode;

    if (!sessionId || !verdict) {
      res.status(400).json({ error: { code: "invalid_input", message: "work_session_id and verdict are required" } });
      return;
    }

    const allowedVerdicts = ["approve", "changes_requested", "reject"];
    if (!allowedVerdicts.includes(verdict)) {
      res.status(400).json({ error: { code: "invalid_input", message: `verdict must be one of: ${allowedVerdicts.join(", ")}` } });
      return;
    }

    // The run must belong to the session being reviewed; a mismatched run/session
    // is rejected (guards against cross-session feedback).
    if (run.workSessionId && run.workSessionId !== sessionId) {
      res.status(409).json({ error: { code: "conflict", message: "run does not belong to this work session" } });
      return;
    }

    if (!reviewWorkflow) {
      res.status(500).json({ error: { code: "server_error", message: "Review workflow is unavailable" } });
      return;
    }

    try {
      const result = await reviewWorkflow.provideFeedback({
        sessionId,
        submissionId: submissionId ?? "",
        diffSha256,
        reviewEpoch,
        verdict: verdict as "approve" | "changes_requested" | "reject",
        comments,
      });

      // NOTE: All canonical lifecycle events (continuation.created,
      // agent.run.approved, agent.run.rejected) are emitted INSIDE the workflow
      // transaction. Do NOT emit duplicates here.

      // Never report "completed" merely because feedback was accepted.
      evaluateCompletionOnFeedback(run.runId, sessionId, result.status);
      emitSse(run.runId, `run.${result.status}`, { run_id: run.runId, status: result.status });

      res.status(mode === "async" ? 202 : 200).json({
        agent_name: run.agentName,
        run_id: run.runId,
        status: result.status,
        output: [{ role: "agent", parts: [{ content_type: "text/plain", content: `Feedback submitted: ${verdict}` }] }],
        created_at: run.createdAt,
        finished_at: new Date().toISOString(),
      });
    } catch (error) {
      const status = error instanceof Error && "httpStatus" in error ? (error as { httpStatus: number }).httpStatus : 500;
      const message = error instanceof Error ? error.message : "Failed";
      res.status(status).json({ error: { code: "server_error", message } });
      return;
    }
  });

  // Reflect the feedback verdict onto the correlated run. Terminal verdicts are
  // terminal; changes_requested keeps the run alive for the resumed worker.
  function evaluateCompletionOnFeedback(runId: string, _sessionId: string, status: string): void {
    if (status === "approved" || status === "rejected" || status === "cancelled" || status === "failed") {
      agentRegistry.updateRun(runId, { status, finishedAt: new Date().toISOString() });
    } else {
      agentRegistry.updateRun(runId, { status });
    }
  }

  // POST /runs/{run_id}/cancel
  router.post("/runs/:run_id/cancel", async (req, res) => {
    if (!authGate(req, res, ["reviewer", "operator"])) return;
    const run = agentRegistry.getRun(req.params.run_id);
    if (!run) {
      res.status(404).json({ error: { code: "not_found", message: "Run not found" } });
      return;
    }
    const workSessionId = run.workSessionId;
    // Resolve the correlated work session and delegate to the authoritative
    // workflow so the session transitions to `cancelled` and emits exactly one
    // canonical agent.run.cancelled terminal event (P2 #2).
    let remoteCancellation: unknown = undefined;
    if (workSessionId && reviewWorkflow) {
      try {
        await reviewWorkflow.cancelSession({ sessionId: workSessionId, reason: "cancelled via ACP" });
      } catch (error) {
        const status = error instanceof Error && "httpStatus" in error ? (error as { httpStatus: number }).httpStatus : 500;
        // A 4xx (e.g. already terminal) is not fatal; a 5xx is.
        if (status >= 500) {
          res.status(status).json({ error: { code: "server_error", message: error instanceof Error ? error.message : "Failed" } });
          return;
        }
      }
    } else {
      agentRegistry.updateRun(run.runId, { status: "cancelled", finishedAt: new Date().toISOString() });
      if (workSessionId) {
        eventStore?.appendEvent({
          type: "agent.run.cancelled",
          sessionId: workSessionId,
          payload: { runId: run.runId, reason: "cancelled via ACP" },
        });
      }
    }
    remoteCancellation = await cancelRemoteRun(
      { agentRegistry, workspaces, workSessions, sharedSecret },
      run,
    );
    emitSse(run.runId, "run.cancelled", { run_id: run.runId, status: "cancelled" });
    res.status(202).json({ run_id: run.runId, status: "cancelled", remote_cancellation: remoteCancellation, output: [], created_at: run.createdAt, finished_at: new Date().toISOString() });
  });

  // ── Adapter → Kontrol lifecycle events ──────────────
  // The CRUSH adapter POSTs run lifecycle events here (authenticated with the
  // shared secret). Kontrol turns them into durable work-session events that
  // drive the WebUI watcher, and updates the run's heartbeat/lease.
  const ADAPTER_EVENT_TYPE_TO_RUN: Record<string, string> = {
    started: "agent.run.started",
    heartbeat: "agent.run.heartbeat",
    output_delta: "agent.run.output_delta",
    thought_delta: "agent.run.thought_delta",
    tool_started: "agent.tool.started",
    tool_completed: "agent.tool.completed",
    tool_failed: "agent.tool.failed",
    plan_updated: "agent.plan.updated",
    completed: "agent.run.completed",
    failed: "agent.run.failed",
    cancelled: "agent.run.cancelled",
    // Migration: older adapters reported a nonzero exit as `exited`, which
    // Kontrol rejected with HTTP 400 and silently stranded the work session.
    // Map it to the same durable event as `failed` so legacy adapters still work.
    exited: "agent.run.failed",
  };

  // Session statuses after which a fresh `failed`/`completed` event must not
  // overwrite the logical outcome (the reviewer's verdict is authoritative).
  const TERMINAL_SESSION_STATUSES = new Set([
    "approved",
    "rejected",
    "cancelled",
    "failed",
    "failed_protocol",
  ]);

  const APPROVAL_EVENT_TYPES = new Set([
    "approval.requested",
    "approval_requested",
    "permission.requested",
    "permission_requested",
    "confirmation.requested",
    "confirmation_requested",
    "user_input.required",
    "user_input_required",
  ]);

  // A zero exit code is NOT approval. Inspect the work session to decide what the
  // exit actually means (P0 #13 completion rule).
  async function submitReviewBarrierForCompletedTurn(runId: string, workSessionId: string): Promise<boolean> {
    if (!reviewCheckpoints || !reviewWorkflow) return false;
    const session = workSessions.get(workSessionId);
    if (!session) return false;
    let root: string;
    try {
      root = workspaces.getWorkspace(session.workspaceSessionId).root;
    } catch {
      return false;
    }
    const review = await reviewCheckpoints.reviewChanges({
      workspaceId: session.workspaceSessionId,
      root,
      since: "work_session",
      workSessionId,
      markReviewed: false,
    });
    const submitted = reviewWorkflow.submitForReview({
      workSessionId,
      diff: review.patch,
      diffSha256: createHash("sha256").update(review.patch).digest("hex"),
      snapshotCommit: review.snapshotCommit,
      message: review.result,
      summaryJson: JSON.stringify(review.summary),
      files: review.summary.files,
      additions: review.summary.additions,
      removals: review.summary.removals,
    });
    await reviewCheckpoints.commitReviewed({
      workspaceId: session.workspaceSessionId,
      root,
      workSessionId,
      snapshotCommit: review.snapshotCommit,
    });
    agentRegistry.updateRun(runId, {
      status: "awaiting_review",
      finishedAt: new Date().toISOString(),
      workerLeaseUntil: null,
    });
    eventStore?.appendEvent({
      type: "worker.turn.completed_review_submitted",
      sessionId: workSessionId,
      payload: { runId, submissionId: submitted.submissionId, submissionNumber: submitted.submissionNumber },
    });
    return true;
  }

  async function evaluateCompletion(runId: string, workSessionId: string): Promise<void> {
    const session = workSessions.get(workSessionId);
    if (!session) return;
    if (session.completionPolicy !== "webui_approval_required") {
      agentRegistry.updateRun(runId, { status: "completed", finishedAt: new Date().toISOString() });
      return;
    }

    // A zero-exit (`completed`) event means the worker process ended. What that
    // MEANS depends entirely on the work-session state — the durable Ralphie
    // table. A zero exit is NOT approval and is NOT automatically a protocol
    // failure; only specific state combinations are.
    switch (session.status) {
      case "approved":
        agentRegistry.updateRun(runId, { status: "approved", finishedAt: new Date().toISOString() });
        break;
      case "rejected":
        agentRegistry.updateRun(runId, { status: "rejected", finishedAt: new Date().toISOString() });
        break;
      case "awaiting_review":
        // The worker exited AFTER submitting, but BEFORE the reviewer responded.
        // The durable review remains OPEN and the reviewer's verdict is still the
        // only completion criterion — so do NOT destroy the session. Mark the
        // worker attempt detached (resumable) and stop; no terminal agent.run.*
        // event is emitted here.
        agentRegistry.updateRun(runId, {
          status: "awaiting_review",
          finishedAt: new Date().toISOString(),
          workerLeaseUntil: null,
        });
        eventStore?.appendEvent({
          type: "worker.attempt.exited",
          sessionId: workSessionId,
          payload: { runId, resumable: true, reason: "worker exited after submitting review" },
        });
        break;
      case "changes_requested":
        // A continuation is already queued; keep it resumable, not terminal.
        agentRegistry.updateRun(runId, { status: "changes_requested", finishedAt: new Date().toISOString() });
        break;
      case "in_progress":
      case "resuming":
        // Native ACP agents are supervised from the outside: when a turn ends,
        // Kontrol owns the review barrier. Capture the current diff and create
        // the review submission instead of requiring the agent to call
        // submit_for_review/await_review_feedback itself.
        if (await submitReviewBarrierForCompletedTurn(runId, workSessionId)) break;
        workSessions.updateStatus(workSessionId, "failed_protocol");
        agentRegistry.updateRun(runId, { status: "failed_protocol", finishedAt: new Date().toISOString() });
        eventStore?.appendEvent({
          type: "agent.run.failed_protocol",
          sessionId: workSessionId,
          payload: { runId, reason: `agent exited zero while session was ${session.status} and Kontrol could not create a review barrier` },
        });
        break;
      default:
        // Anything else (cancelled, failed, failed_protocol, or an unexpected
        // state) is left as-is; a terminal state is never overwritten.
        break;
    }
  }

  router.post("/runs/:run_id/events", async (req, res) => {
    if (!authGate(req, res, ["agent", "operator"])) return;

    const run = agentRegistry.getRun(req.params.run_id);
    if (!run) { res.status(404).json({ error: { code: "not_found", message: "Run not found" } }); return; }

    const body = req.body as {
      remote_run_id?: string;
      work_session_id?: string;
      type?: string;
      payload?: Record<string, unknown>;
    };

    if (!body.type || (!ADAPTER_EVENT_TYPE_TO_RUN[body.type] && !APPROVAL_EVENT_TYPES.has(body.type))) {
      res.status(400).json({ error: { code: "invalid_input", message: "unknown or missing event type" } });
      return;
    }
    // The adapter must report the same work session the run was created for.
    if (body.work_session_id && run.workSessionId && body.work_session_id !== run.workSessionId) {
      res.status(409).json({ error: { code: "conflict", message: "work_session_id does not match run" } });
      return;
    }

    const now = new Date().toISOString();
    if (APPROVAL_EVENT_TYPES.has(body.type)) {
      if (!approvalRequests) {
        res.status(500).json({ error: { code: "server_error", message: "Approval request store unavailable" } });
        return;
      }
      const sessionId = run.workSessionId;
      const workspaceSessionId = run.workspaceSessionId;
      if (!workspaceSessionId) {
        res.status(409).json({ error: { code: "conflict", message: "run has no workspace session" } });
        return;
      }
      const payload = body.payload ?? {};
      // The agent may either fire-and-forget (wait:false) or block for the human
      // decision (default). A blocking request holds this HTTP call open until
      // the reviewer resolves the approval, then returns the decision inline so
      // the agent's tool call can proceed or abort. Without this the generic
      // approval flow was write-only: the agent could never learn the outcome.
      const wantsDecision = payload.wait !== false && eventStore !== undefined;
      const eventSessionId = sessionId ?? workspaceSessionId;

      // The predicate closes over this ref; it is populated with the concrete
      // approvalId immediately after create() but BEFORE we await, and the
      // subscription is installed first so a fast human decision can never
      // resolve in the gap between create and wait (lost-wakeup safe).
      const approvalIdRef: { id?: string } = {};
      const resolutionPromise = wantsDecision
        ? eventStore.waitForEvent(
            eventSessionId,
            "approval.resolved",
            (e: { payload?: Record<string, unknown> }) =>
              approvalIdRef.id !== undefined && e.payload?.approvalId === approvalIdRef.id,
            APPROVAL_WAIT_TIMEOUT_MS,
          )
        : undefined;

      const request = approvalRequests.create({
        kind: body.type.startsWith("user_input") ? "user_input" : "agent_permission",
        workspaceSessionId,
        workSessionId: sessionId,
        runId: run.runId,
        agentId: run.agentName,
        title: stringPayload(payload.title) ?? stringPayload(payload.tool) ?? "Agent approval requested",
        description: stringPayload(payload.description) ?? stringPayload(payload.message),
        risk: stringPayload(payload.risk),
        tool: stringPayload(payload.tool),
        command: stringPayload(payload.command),
        path: stringPayload(payload.path),
        options: parseApprovalOptions(payload.options),
        expiresAt: stringPayload(payload.expiresAt),
      });
      approvalIdRef.id = request.approvalId;
      eventStore?.appendEvent({
        type: "approval.requested",
        sessionId: eventSessionId,
        payload: approvalToEventPayload(request),
      });

      if (!resolutionPromise) {
        res.status(202).json({ approval_id: request.approvalId, status: request.status });
        return;
      }

      const resolution = await resolutionPromise;
      if (!resolution) {
        // The long-poll window elapsed WITHOUT a human decision. This is NOT a
        // denial — people step away, and (like the CLI coding agents) the tool
        // call must simply keep waiting. The approval row stays pending; we tell
        // the caller to re-park via GET /approvals/:id/decision. No verdict is
        // fabricated and no work is dropped.
        res.status(200).json({
          approval_id: request.approvalId,
          status: "pending",
          decision: null,
          still_pending: true,
          poll_url: `/approvals/${encodeURIComponent(request.approvalId)}/decision`,
        });
        return;
      }
      const rp = resolution.payload ?? {};
      res.status(200).json({
        approval_id: request.approvalId,
        status: stringPayload(rp.status) ?? (rp.decision === "approve" ? "approved" : "denied"),
        decision: stringPayload(rp.decision) ?? "deny",
        option_id: stringPayload(rp.optionId),
        reason: stringPayload(rp.reason),
      });
      return;
    }

    const terminalRunStatus = new Set(["approved", "rejected", "cancelled", "failed", "failed_protocol"]);
    if (terminalRunStatus.has(run.status) && body.type !== "completed" && body.type !== "failed") {
      // Harmless duplicate terminal delivery — ignore but ack.
      res.status(202).json({ run_id: run.runId, status: run.status, ignored: true });
      return;
    }

    const sessionId = run.workSessionId;
    const session = sessionId ? workSessions.get(sessionId) : undefined;
    const gatedCompletedTurn =
      body.type === "completed" &&
      session?.completionPolicy === "webui_approval_required";

    agentRegistry.updateRun(run.runId, {
      status: body.type === "started" ? "running" : run.status,
      remoteRunId: body.remote_run_id ?? run.remoteRunId,
      lastHeartbeatAt: now,
      workerLeaseUntil: body.type === "started" || body.type === "heartbeat"
        ? new Date(Date.now() + 30_000).toISOString()
        : run.workerLeaseUntil,
    });

    // Defect #1: a worker CRASH while the review is still open must not emit the
    // terminal agent.run.failed — the WebUI would drop a resumable session. That
    // case is handled below with the non-terminal worker.attempt.failed event.
    const awaitingReviewCrash =
      (body.type === "failed" || body.type === "exited") &&
      sessionId !== undefined &&
      workSessions.get(sessionId)?.status === "awaiting_review";
    const workflowHandledCancellation =
      body.type === "cancelled" &&
      sessionId !== undefined &&
      reviewWorkflow !== undefined &&
      session !== undefined &&
      !TERMINAL_SESSION_STATUSES.has(session.status);
    if (sessionId && eventStore && !awaitingReviewCrash && !workflowHandledCancellation) {
      eventStore.appendEvent({
        type: gatedCompletedTurn ? "worker.turn.completed" : ADAPTER_EVENT_TYPE_TO_RUN[body.type],
        sessionId,
        payload: {
          runId: run.runId,
          remoteRunId: body.remote_run_id ?? run.remoteRunId,
          workSessionId: sessionId,
          ...(body.payload ?? {}),
        },
      });
    }

    if (body.type === "completed") {
      await evaluateCompletion(run.runId, sessionId ?? "");
    } else if (body.type === "cancelled") {
      const session = sessionId ? workSessions.get(sessionId) : undefined;
      if (session && !TERMINAL_SESSION_STATUSES.has(session.status) && reviewWorkflow) {
        await reviewWorkflow.cancelSession({ sessionId: session.id, reason: stringPayload(body.payload?.message) ?? "worker cancelled" });
      } else {
        agentRegistry.updateRun(run.runId, { status: "cancelled", finishedAt: now, workerLeaseUntil: null });
      }
    } else if (body.type === "failed" || body.type === "exited") {
      // An execution/infrastructure failure is distinct from a protocol
      // violation. Conflation (the old `failed_protocol` rewrite) wrongly
      // stranded sessions whose only crime was a crashed worker — including a
      // worker that crashed AFTER submitting, while the durable review was
      // still open. Map to `failed`; only a zero-exit in the wrong session
      // state (handled by evaluateCompletion) is a protocol failure.
      const session = sessionId ? workSessions.get(sessionId) : undefined;
      const errorMessage = stringPayload(body.payload?.message) ?? "worker process exited";
      if (session && session.status === "awaiting_review") {
        // Worker died after submitting but before the reviewer responded. Keep
        // the durable review OPEN (resumable): mark the attempt detached and do
        // NOT mark the session terminal — the reviewer can still approve/reject.
        // Emit the NON-terminal worker.attempt.failed (not agent.run.failed) so
        // the WebUI keeps watching the resumable session (defect #1).
        agentRegistry.updateRun(run.runId, {
          status: "awaiting_review",
          finishedAt: new Date().toISOString(),
          workerLeaseUntil: null,
        });
        eventStore?.appendEvent({
          type: "worker.attempt.failed",
          sessionId: session.id,
          payload: { runId: run.runId, resumable: true, reason: errorMessage },
        });
      } else if (session && !TERMINAL_SESSION_STATUSES.has(session.status)) {
        workSessions.updateStatus(session.id, "failed");
        eventStore?.appendEvent({
          type: "agent.run.failed",
          sessionId: session.id,
          payload: { runId: run.runId, reason: errorMessage },
        });
        agentRegistry.updateRun(run.runId, { status: "failed", errorMessage, finishedAt: now });
      } else {
        agentRegistry.updateRun(run.runId, { status: "failed", errorMessage, finishedAt: now });
      }
    }

    res.status(202).json({ run_id: run.runId, status: run.status, accepted: true });
  });

  // GET /session/{session_id}
  router.get("/session/:session_id", (req, res) => {
    if (!authGate(req, res, ["reviewer", "operator"])) return;
    const session = workSessions.get(req.params.session_id);
    if (!session) { res.status(404).json({ error: { code: "not_found", message: "Session not found" } }); return; }

    const submissions = workSessions.getSubmissions(session.id);
    const toolEvents = workSessions.getToolEvents(session.id, 50);
    const runs = agentRegistry.listRuns(session.workspaceSessionId, 10);

    res.json({
      id: session.id,
      workspaceSessionId: session.workspaceSessionId,
      status: session.status,
      submittedBy: session.submittedBy,
      title: session.title,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      submissionCount: submissions.length,
      feedbackCount: submissions.filter((s) => s.feedback).length,
      latestSubmission: session.latestSubmission,
      latestFeedback: session.latestFeedback,
      recentToolEvents: toolEvents.slice(0, 10),
      recentRuns: runs,
    });
  });

  router.get("/approvals/:approval_id", (req, res) => {
    if (!authGate(req, res, ["agent", "reviewer", "operator"])) return;
    const approval = approvalRequests?.get(req.params.approval_id);
    if (!approval) {
      res.status(404).json({ error: { code: "not_found", message: "Approval request not found" } });
      return;
    }
    res.json(approvalToEventPayload(approval));
  });

  // Long-poll for an approval's decision. An agent that reconnected (or whose
  // original blocking POST hit the long-poll window) parks here until the human
  // decides. Crucially there is NO fail-closed timeout: if the window elapses
  // with the approval still pending, we return `still_pending` so the agent
  // simply re-parks — the human may be away for hours, exactly like the CLI
  // coding agents. A resolved approval returns its decision immediately.
  router.get("/approvals/:approval_id/decision", async (req, res) => {
    if (!authGate(req, res, ["agent", "operator"])) return;
    if (!approvalRequests) {
      res.status(500).json({ error: { code: "server_error", message: "Approval request store unavailable" } });
      return;
    }
    const approval = approvalRequests.get(req.params.approval_id);
    if (!approval) {
      res.status(404).json({ error: { code: "not_found", message: "Approval request not found" } });
      return;
    }

    const decisionFor = (a: NonNullable<ReturnType<ApprovalRequestManager["get"]>>) => {
      const resolution = a.resolution ?? {};
      const decision = a.status === "approved" ? "approve" : a.status === "denied" ? "deny" : null;
      return {
        approval_id: a.approvalId,
        status: a.status,
        decision,
        option_id: stringPayload(resolution.optionId),
        reason: stringPayload(resolution.reason),
      };
    };

    // Already decided — return now.
    if (approval.status !== "pending") {
      res.json(decisionFor(approval));
      return;
    }

    const eventSessionId = approval.workSessionId ?? approval.workspaceSessionId;
    const resolution = eventStore
      ? await eventStore.waitForEvent(
          eventSessionId,
          "approval.resolved",
          (e: { payload?: Record<string, unknown> }) => e.payload?.approvalId === approval.approvalId,
          APPROVAL_WAIT_TIMEOUT_MS,
        )
      : null;

    if (resolution) {
      const rp = resolution.payload ?? {};
      res.json({
        approval_id: approval.approvalId,
        status: stringPayload(rp.status) ?? (rp.decision === "approve" ? "approved" : "denied"),
        decision: stringPayload(rp.decision) ?? "deny",
        option_id: stringPayload(rp.optionId),
        reason: stringPayload(rp.reason),
      });
      return;
    }

    // Re-check the store in case it resolved outside the event stream, then
    // (still pending) tell the caller to keep parking. Never fail-closed.
    const latest = approvalRequests.get(approval.approvalId);
    if (latest && latest.status !== "pending") {
      res.json(decisionFor(latest));
      return;
    }
    res.json({
      approval_id: approval.approvalId,
      status: "pending",
      decision: null,
      still_pending: true,
      poll_url: `/approvals/${encodeURIComponent(approval.approvalId)}/decision`,
    });
  });

  function stringPayload(value: unknown): string | undefined {
    return typeof value === "string" && value.length > 0 ? value : undefined;
  }

  function parseApprovalOptions(value: unknown): ApprovalOption[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const options = value.flatMap((entry): ApprovalOption[] => {
      if (!entry || typeof entry !== "object") return [];
      const obj = entry as Record<string, unknown>;
      const id = stringPayload(obj.id);
      const label = stringPayload(obj.label);
      const effect = obj.effect === "approve" || obj.effect === "deny" || obj.effect === "changes_requested"
        ? obj.effect
        : undefined;
      if (!id || !label || !effect) return [];
      return [{ id, label, effect, scope: obj.scope as ApprovalOption["scope"] }];
    });
    return options.length ? options : undefined;
  }

  function approvalToEventPayload(approval: NonNullable<ReturnType<ApprovalRequestManager["get"]>>): Record<string, unknown> {
    return {
      approvalId: approval.approvalId,
      kind: approval.kind,
      workspaceId: approval.workspaceSessionId,
      workspaceSessionId: approval.workspaceSessionId,
      workSessionId: approval.workSessionId,
      runId: approval.runId,
      agentId: approval.agentId,
      title: approval.title,
      description: approval.description,
      risk: approval.risk,
      tool: approval.tool,
      command: approval.command,
      path: approval.path,
      options: approval.options,
      status: approval.status,
      createdAt: approval.createdAt,
      expiresAt: approval.expiresAt,
    };
  }

  // GET /runs — list runs
  router.get("/runs", (req, res) => {
    if (!authGate(req, res, ["reviewer", "operator"])) return;
    const workspaceId = req.query.workspace_id as string | undefined;
    const limit = parseInt(req.query.limit as string, 10) || 20;
    const runs = agentRegistry.listRuns(workspaceId, limit);
    res.json({ runs });
  });

  return router;
}
