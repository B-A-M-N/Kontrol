import type { AgentRegistryManager, PersistentAcpRun, AgentInfo } from "./acp-registry.js";
import type { WorkspaceRegistry } from "./workspaces.js";
import type { WorkSessionManager } from "./work-sessions.js";
import {
  readFileTool,
  writeFileTool,
  editFileTool,
  grepFilesTool,
  findFilesTool,
  listDirectoryTool,
  runShellTool,
} from "./pi-tools.js";

const DEFAULT_ACP_TIMEOUT = 60_000;

export function isLoopbackAgentUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}

export function authHeadersForAgent(url: string, sharedSecret?: string): Record<string, string> {
  if (!sharedSecret || !isLoopbackAgentUrl(url)) return {};
  return { Authorization: `Bearer ${sharedSecret}` };
}

function hasOutboundCredential(url: string, sharedSecret?: string): boolean {
  return Object.keys(authHeadersForAgent(url, sharedSecret)).length > 0;
}

export interface PeerDispatchResult {
  status: number;
  body: Record<string, unknown>;
  text: string;
}

export async function dispatchToPeer(params: {
  agentUrl: string;
  sharedSecret?: string;
  body: Record<string, unknown>;
  timeoutMs?: number;
}): Promise<PeerDispatchResult> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  Object.assign(headers, authHeadersForAgent(params.agentUrl, params.sharedSecret));

  const response = await fetch(params.agentUrl.replace(/\/+$/, "") + "/runs", {
    method: "POST",
    headers,
    body: JSON.stringify(params.body),
    signal: AbortSignal.timeout(params.timeoutMs ?? DEFAULT_ACP_TIMEOUT),
  });
  const text = await response.text().catch(() => "");
  let parsed: Record<string, unknown> = {};
  if (text) {
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      parsed = {};
    }
  }
  if (!response.ok) {
    throw new Error(`ACP request failed (${response.status}): ${text.slice(0, 500) || "unknown"}`);
  }
  return { status: response.status, body: parsed, text };
}

export interface AgentProbeResult {
  healthy: boolean;
  status: number;
  error?: string;
  note?: string;
}

export async function probeAgent(url: string, sharedSecret?: string): Promise<AgentProbeResult> {
  const headers = authHeadersForAgent(url, sharedSecret);
  const baseUrl = url.replace(/\/+$/, "");
  try {
    const health = await fetch(baseUrl + "/health", {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(3000),
    });
    if (health.ok) return { healthy: true, status: health.status, note: "/health" };
    if (health.status !== 404 && health.status !== 405) {
      return { healthy: false, status: health.status };
    }

    // Generic ACP-style fallback: /health is a DevSpace adapter convention, not
    // a universal ACP requirement. A peer that exposes /runs is dispatchable.
    const runs = await fetch(baseUrl + "/runs", {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(3000),
    });
    if (runs.ok || runs.status === 405) {
      return { healthy: true, status: runs.status, note: "/runs" };
    }
    if (runs.status === 401 || runs.status === 403) {
      if (hasOutboundCredential(url, sharedSecret)) {
        return { healthy: true, status: runs.status, note: "/runs requires auth" };
      }
      return {
        healthy: false,
        status: runs.status,
        note: "ACP endpoint requires authentication but no peer credential is configured",
      };
    }
    return { healthy: false, status: runs.status };
  } catch (error) {
    return { healthy: false, status: 0, error: error instanceof Error ? error.message : String(error) };
  }
}

export interface HealthyAgentSelection {
  agent?: AgentInfo;
  deadUrls: string[];
}

/**
 * Among candidate peers (filtered by name/role), return the FIRST that passes
 * a protocol-readiness probe. Collects dead endpoints so callers can surface a
 * clear error instead of silently routing to a 404 endpoint.
 */
export async function selectHealthyAgent(
  peers: AgentInfo[],
  opts: { name?: string; role?: string; sharedSecret?: string },
): Promise<HealthyAgentSelection> {
  const candidates = peers.filter((a) => {
    if (opts.name && a.name !== opts.name) return false;
    if (opts.role && a.role !== opts.role) return false;
    return true;
  });
  const deadUrls: string[] = [];
  for (const peer of candidates) {
    const probe = await probeAgent(peer.url, opts.sharedSecret);
    if (probe.healthy) return { agent: peer, deadUrls };
    deadUrls.push(`${peer.url} (${probe.error ? probe.error : "HTTP " + probe.status})`);
  }
  return { deadUrls };
}

// Correlation between a work session and its ACP run is persisted on the
// acp_runs row (workSessionId column), not held in an in-memory map. That keeps
// it durable across DevSpace restarts — submit_for_review looks the run up by
// workSessionId via agentRegistry.getRunByWorkSessionId().

const AGENT_SUBMIT_TIMEOUT_MS = 5 * 60 * 1000; // bound the "did it submit?" wait
const TERMINAL_RUN_STATUSES = new Set(["approved", "rejected", "cancelled", "failed", "failed_protocol"]);
const TERMINAL_WORK_SESSION_STATUSES = new Set(["approved", "rejected", "cancelled", "failed", "failed_protocol"]);

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface GatewayConfig {
  agentRegistry: AgentRegistryManager;
  workspaces: WorkspaceRegistry;
  workSessions: WorkSessionManager;
  sharedSecret?: string;
}

export interface AgentCallResult {
  /** DevSpace-owned durable run ID (authoritative). */
  runId: string;
  /** Adapter-side execution-attempt identifier (informational only). */
  remoteRunId?: string;
  attemptNumber: number;
  agentName: string;
  status: string;
  output: string;
  error?: string;
  sessionId?: string;
  workSessionId?: string;
}

export interface AgentCancelResult {
  acknowledged: boolean;
  status?: number;
  error?: string;
}

export async function cancelRemoteRun(
  config: GatewayConfig,
  run: PersistentAcpRun,
): Promise<AgentCancelResult> {
  if (!run.remoteRunId) {
    return { acknowledged: false, error: "Run has no remoteRunId" };
  }
  const selection = await selectHealthyAgent(config.agentRegistry.listAlive(), {
    name: run.agentName,
    role: "agent",
    sharedSecret: config.sharedSecret,
  });
  if (!selection.agent) {
    return { acknowledged: false, error: `No healthy registered adapter for ${run.agentName}` };
  }

  return cancelRemoteRunById(selection.agent.url, config.sharedSecret, run.remoteRunId);
}

export async function cancelRemoteRunById(
  agentUrl: string,
  sharedSecret: string | undefined,
  remoteRunId: string,
): Promise<AgentCancelResult> {
  const baseUrl = agentUrl.replace(/\/+$/, "");
  try {
    const response = await fetch(`${baseUrl}/runs/${encodeURIComponent(remoteRunId)}/cancel`, {
      method: "POST",
      headers: authHeadersForAgent(agentUrl, sharedSecret),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await response.text().catch(() => "");
    if (!response.ok) {
      return { acknowledged: false, status: response.status, error: text.slice(0, 500) || `HTTP ${response.status}` };
    }
    return { acknowledged: true, status: response.status };
  } catch (error) {
    return { acknowledged: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Call a remote ACP agent with full lifecycle:
 * 1. Create persistent run
 * 2. Discover agent (by exact URL or registry lookup)
 * 3. Execute via HTTP POST /runs
 * 4. Poll for completion or wait for webhook
 * 5. Store result
 */
export async function callRemoteAgent(
  config: GatewayConfig,
  params: {
    agentUrl: string;
    agentName: string;
    task: string;
    webhookUrl?: string;
    workspaceSessionId?: string;
    workSessionId?: string;
    mode?: "sync" | "async";
    fireAndForget?: boolean;
    /** Reuse an existing logical run (continuation) instead of creating a new one. */
    existingRunId?: string;
    /** Continuation ID for resumed work (passed to the adapter, bound to the worker). */
    continuationId?: string;
  },
): Promise<AgentCallResult> {
  // Reuse the existing logical run across continuations so the UI keeps watching
  // one run while a resumed worker updates the same record (higher attempt #).
  let run: ReturnType<GatewayConfig["agentRegistry"]["createRun"]>;
  let attemptNumber = 1;
  let expectedDispatchStatus = "created";
  if (params.existingRunId) {
    const existing = config.agentRegistry.getRun(params.existingRunId);
    if (!existing) {
      throw new Error(`No logical run for continuation: ${params.existingRunId}`);
    }
    if (TERMINAL_RUN_STATUSES.has(existing.status)) {
      throw new Error(`Cannot resume terminal run ${existing.runId}: ${existing.status}`);
    }
    run = existing;
    attemptNumber = (existing.attemptNumber ?? 1) + 1;
    expectedDispatchStatus = "resuming";
    config.agentRegistry.updateRun(run.runId, {
      attemptNumber,
      status: "resuming",
      errorMessage: undefined,
      finishedAt: undefined,
    });
  } else {
    run = config.agentRegistry.createRun({
      agentName: params.agentName,
      workspaceSessionId: params.workspaceSessionId,
      workSessionId: params.workSessionId,
      inputPreview: params.task.slice(0, 500),
      webhookUrl: params.webhookUrl,
      status: "created",
    });
  }

  const started = Date.now();
  try {
    // Resolve the workspace root for the dispatch so the adapter can spawn
    // CRUSH in the correct repository, not in the DevSpace directory.
    const workspace = params.workspaceSessionId
      ? config.workspaces.getWorkspace(params.workspaceSessionId)
      : undefined;

    const body: Record<string, unknown> = {
      agent_name: params.agentName,
      mode: params.mode ?? "sync",
      input: [
        {
          role: "user",
          parts: [{ content_type: "text/plain", content: params.task }],
        },
      ],
      // Bind the DevSpace-owned identities into the adapter request so the
      // spawned CRUSH process can attribute its tool activity to the exact
      // work session. The MCP connection envelope carries these downstream.
      workspace_session_id: params.workspaceSessionId,
      workspace_root: workspace?.root,
      session_id: params.workSessionId,
      parent_run_id: run.runId,
      continuation_id: params.continuationId,
    };

    if (params.webhookUrl) {
      body.webhook_url = params.webhookUrl;
    }

    const useAsync = params.mode === "async";

    const dispatched = await dispatchToPeer({
      agentUrl: params.agentUrl,
      sharedSecret: config.sharedSecret,
      body,
      timeoutMs: DEFAULT_ACP_TIMEOUT,
    });

    const result = dispatched.body as {
      run_id?: string;
      status?: string;
      output?: Array<{ parts?: Array<{ content?: string }> }>;
      error?: { message?: string };
    };

    const remoteRunId = result.run_id ?? run.runId;
    const errorMessage = result.error?.message;

    if (useAsync) {
      const currentRun = config.agentRegistry.getRun(run.runId);
      const currentSession = params.workSessionId
        ? config.workSessions.get(params.workSessionId)
        : undefined;
      const runStillDispatchable =
        currentRun?.status === expectedDispatchStatus &&
        currentRun.attemptNumber === attemptNumber;
      const sessionTerminal =
        currentSession !== undefined &&
        TERMINAL_WORK_SESSION_STATUSES.has(currentSession.status);

      if (!runStillDispatchable || sessionTerminal) {
        await cancelRemoteRunById(params.agentUrl, config.sharedSecret, remoteRunId);
        const status = currentRun?.status ?? (sessionTerminal ? currentSession?.status : "failed") ?? "failed";
        return {
          runId: run.runId,
          remoteRunId,
          attemptNumber,
          agentName: params.agentName,
          status,
          output: `Adapter accepted the run after the logical session became ${status}; remote attempt was cancelled.`,
          error: sessionTerminal ? `Session is ${currentSession?.status}` : `Run is ${currentRun?.status ?? "missing"}`,
          workSessionId: params.workSessionId,
        };
      }

      // Fire-and-forget: the WebUI dispatch path returns immediately with the
      // DEVDESKTOP run ID (not the adapter's), and observes progress via the
      // durable event log / get_work_session. The authoritative run ID is
      // run.runId; remoteRunId is only an execution-attempt pointer.
      if (params.fireAndForget) {
        const updated = config.agentRegistry.updateRunIfCurrent(
          run.runId,
          { status: expectedDispatchStatus, attemptNumber },
          {
          status: "running",
          remoteRunId,
          attemptNumber,
          lastHeartbeatAt: new Date().toISOString(),
          },
        );
        if (!updated) {
          await cancelRemoteRunById(params.agentUrl, config.sharedSecret, remoteRunId);
          const latest = config.agentRegistry.getRun(run.runId);
          return {
            runId: run.runId,
            remoteRunId,
            attemptNumber,
            agentName: params.agentName,
            status: latest?.status ?? "failed",
            output: "Adapter accepted the run, but the logical run changed before it could be marked running; remote attempt was cancelled.",
            error: `Run changed before dispatch acceptance could be recorded.`,
            workSessionId: params.workSessionId,
          };
        }
        return {
          runId: run.runId,
          remoteRunId,
          attemptNumber,
          agentName: params.agentName,
          status: "running",
          output: "Agent accepted the task and is working. Observe via await_work_session_events or get_work_session.",
          workSessionId: params.workSessionId,
        };
      }

      // The adapter fired CRUSH in the background and returned immediately. The
      // agent now works (and may wait inside its own MCP session on
      // await_review_feedback) without being held inside this HTTP call. We poll
      // the registry run until the bridge sees a submission (status →
      // "awaiting_review") or the agent finishes the whole loop, then return.
      // If we hit the submit-timeout first, report "running" so the caller can
      // continue to observe via the work session instead of timing out.
      const pollStart = Date.now();
      while (Date.now() - pollStart < AGENT_SUBMIT_TIMEOUT_MS) {
        const current = config.agentRegistry.getRun(run.runId);
        const st = current?.status;
        if (st === "awaiting_review") {
          return {
            runId: run.runId,
            remoteRunId,
            attemptNumber,
            agentName: params.agentName,
            status: "awaiting_review",
            output: current?.outputPreview ?? "",
            workSessionId: params.workSessionId,
          };
        }
        if (st && (st === "completed" || st === "failed" || st === "approved" || st === "rejected")) {
          return {
            runId: run.runId,
            remoteRunId,
            attemptNumber,
            agentName: params.agentName,
            status: st,
            output: current?.outputPreview ?? "",
            error: current?.errorMessage,
            workSessionId: params.workSessionId,
          };
        }
        await sleep(2000);
      }
      // Agent hasn't submitted within the bound — hand observation back to the
      // work session. The agent keeps running in the background.
      return {
        runId: run.runId,
        remoteRunId,
        attemptNumber,
        agentName: params.agentName,
        status: "running",
        output: "Agent accepted the task and is working. Use list_pending_reviews or get_work_session to observe the submission.",
        workSessionId: params.workSessionId,
      };
    }


    // SYNC path (legacy): preserve the remote status; only force "failed" on error.
    const status = errorMessage ? "failed" : result.status ?? "completed";
    const outputText = result.output
      ?.flatMap((m) => m.parts?.map((p) => p.content ?? "").filter(Boolean) ?? [])
      .join("\n") ?? "";

    const elapsedMs = Date.now() - started;

    config.agentRegistry.updateRun(run.runId, {
      status,
      outputPreview: outputText.slice(0, 2000),
      outputJson: JSON.stringify(result).slice(0, 10_000),
      errorMessage,
      finishedAt: new Date().toISOString(),
    });


    // Log to work session if provided
    if (params.workSessionId) {
      config.workSessions.logToolEvent({
        workSessionId: params.workSessionId,
        workspaceSessionId: params.workspaceSessionId ?? "",
        tool: `acp:${params.agentName}`,
        inputJson: params.task,
        outputSummary: outputText.slice(0, 1000),
        success: !errorMessage,
        elapsedMs,
      });
    }

    return {
      runId: run.runId,
      remoteRunId,
      attemptNumber,
      agentName: params.agentName,
      status,
      output: outputText,
      error: errorMessage,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    config.agentRegistry.updateRun(run.runId, {
      status: "failed",
      errorMessage,
      finishedAt: new Date().toISOString(),
    });

    return {
      runId: run.runId,
      remoteRunId: run.remoteRunId,
      attemptNumber: run.attemptNumber ?? 1,
      agentName: params.agentName,
      status: "failed",
      output: "",
      error: errorMessage,
    };
  }
}

/**
 * Execute a Dev Desktop tool directly (used by ACP server for devdesktop-* agents).
 * Maps agent name to the underlying pi-tools function.
 */
export async function executeDevDesktopTool(
  agentName: string,
  input: string,
  cwd: string,
  root: string,
): Promise<string> {
  const parsed = tryParseJson(input);
  if (!parsed) return input; // treat raw text as default

  switch (agentName) {
    case "devdesktop-read": {
      const result = await readFileTool(
        { path: String(parsed.path ?? "."), offset: 1, limit: 500 },
        { cwd, root },
      );
      return result.content.map((c) => ("text" in c ? c.text : "")).join("");
    }

    case "devdesktop-write": {
      const result = await writeFileTool(
        { path: String(parsed.path), content: String(parsed.content ?? "") },
        { cwd, root },
      );
      return result.content.map((c) => ("text" in c ? c.text : "")).join("");
    }

    case "devdesktop-edit": {
      const result = await editFileTool(
        { path: String(parsed.path), edits: (parsed.edits ?? []) as { oldText: string; newText: string }[] },
        { cwd, root },
      );
      const text = result.content.map((c) => ("text" in c ? c.text : "")).join("");
      const details = result.details as { additions?: number; removals?: number } | undefined;
      return `${text}${details ? ` (+${details.additions ?? 0} -${details.removals ?? 0})` : ""}`;
    }

    case "devdesktop-grep": {
      const result = await grepFilesTool(
        { pattern: String(parsed.pattern), path: typeof parsed.path === "string" ? parsed.path : undefined },
        { cwd, root },
      );
      return result.content.map((c) => ("text" in c ? c.text : "")).join("");
    }

    case "devdesktop-glob": {
      const result = await findFilesTool(
        { pattern: String(parsed.pattern), path: typeof parsed.path === "string" ? parsed.path : undefined },
        { cwd, root },
      );
      return result.content.map((c) => ("text" in c ? c.text : "")).join("");
    }

    case "devdesktop-shell": {
      const result = await runShellTool(
        { command: String(parsed.command ?? input), timeout: Number(parsed.timeout ?? 30) },
        { cwd, root: cwd },
      );
      return result.content.map((c) => ("text" in c ? c.text : "")).join("");
    }

    default:
      throw new Error(`Unknown Dev Desktop agent: ${agentName}`);
  }
}

function tryParseJson(text: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}
