import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { z } from "zod/v4";
import { createReadOnlyExecutionGrant } from "./read-only-execution.mjs";
import { createBoundedFileWriteGrant } from "./bounded-file-write.mjs";
import {
  serializeFinalAcpResult,
  truncateUtf8Tail,
  type AgentRegistryManager,
  type PersistentAcpRun,
  type AgentInfo,
} from "./acp-registry.js";
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

// Dispatch is only the adapter handshake. The adapter should answer quickly,
// but a busy host must not strand a durable run after an arbitrary one-minute
// cap. The run itself remains supervised independently after the 202 response.
// Keep the window tunable for slow local model startup without changing the
// independent run/watchdog limits.
// P0.3: the value is resolved by loadConfig (acpDispatchTimeoutMs) and
// injected via setDefaultAcpTimeout at server assembly — no ambient
// process.env read at module load. Per-call timeoutMs still wins.
export const DEFAULT_ACP_TIMEOUT_FALLBACK_MS = 5 * 60_000;
let defaultAcpTimeoutMs = DEFAULT_ACP_TIMEOUT_FALLBACK_MS;
export function setDefaultAcpTimeout(ms: number | undefined): void {
  defaultAcpTimeoutMs = ms !== undefined && Number.isSafeInteger(ms) && ms > 0 ? ms : DEFAULT_ACP_TIMEOUT_FALLBACK_MS;
}
export function getAcpTimeout(): number {
  return defaultAcpTimeoutMs;
}

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
  executionReceipt?: ReadOnlyExecutionReceipt;
}

export interface ReadOnlyExecutionReceipt {
  mode: "read_only_audit" | "bounded_file_write";
  execution_grant: Record<string, unknown>;
  issuer: "kontrol";
  work_session_id: string;
  workspace_session_id: string;
  parent_run_id: string;
  remote_run_id: string;
  attempt_number: number;
  dispatch_idempotency_key: string;
  grant_expires_at: number;
  grant_fingerprint: string;
  network_policy: "disabled" | "host";
  confinement: "bubblewrap-read-only-workspace-no-network" | "bubblewrap-read-only-workspace-host-network";
}

const readOnlyExecutionReceiptSchema = z.object({
  mode: z.enum(["read_only_audit", "bounded_file_write"]),
  execution_grant: z.record(z.string(), z.unknown()),
  issuer: z.literal("kontrol"),
  work_session_id: z.string().min(1),
  workspace_session_id: z.string().min(1),
  parent_run_id: z.string().min(1),
  remote_run_id: z.string().min(1),
  attempt_number: z.number().int().positive(),
  dispatch_idempotency_key: z.string().min(1),
  grant_expires_at: z.number().int().positive(),
  grant_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  network_policy: z.enum(["disabled", "host"]),
  confinement: z.enum(["bubblewrap-read-only-workspace-no-network", "bubblewrap-read-only-workspace-host-network"]),
}).strict();

function correlateExecutionReceipt(
  value: unknown,
  requestBody: Record<string, unknown>,
  remoteRunId: string,
  grantField: "read_only_execution_grant" | "bounded_file_write_grant",
  expectedMode: ReadOnlyExecutionReceipt["mode"],
): ReadOnlyExecutionReceipt | undefined {
  const grant = requestBody[grantField];
  if (!grant || typeof grant !== "object" || Array.isArray(grant)) return undefined;
  const claims = grant as Record<string, unknown>;
  const signature = claims.signature;
  if (typeof signature !== "string" || typeof claims.expiresAt !== "number") return undefined;
  const parsed = readOnlyExecutionReceiptSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const receipt = parsed.data;
  if (receipt.mode !== expectedMode || JSON.stringify(receipt.execution_grant) !== JSON.stringify(claims)) return undefined;
  const grantFingerprint = createHash("sha256").update(signature).digest("hex");
  if (receipt.work_session_id !== requestBody.session_id
    || receipt.workspace_session_id !== requestBody.workspace_session_id
    || receipt.parent_run_id !== requestBody.parent_run_id
    || receipt.remote_run_id !== remoteRunId
    || receipt.attempt_number !== requestBody.attempt_number
    || receipt.dispatch_idempotency_key !== requestBody.dispatch_idempotency_key
    || receipt.grant_expires_at !== claims.expiresAt
    || receipt.grant_fingerprint !== grantFingerprint
    || receipt.network_policy !== claims.networkPolicy
    || receipt.confinement !== (claims.networkPolicy === "host"
      ? "bubblewrap-read-only-workspace-host-network"
      : "bubblewrap-read-only-workspace-no-network")) return undefined;
  return receipt;
}

export class AcpDispatchError extends Error {
  constructor(
    message: string,
    readonly certainty: "rejected" | "uncertain",
    readonly httpStatus?: number,
    readonly errorCode?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AcpDispatchError";
  }
}

function networkErrorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth++) {
    const record = current as { code?: unknown; cause?: unknown };
    if (typeof record.code === "string") return record.code;
    current = record.cause;
  }
  return undefined;
}

function dispatchFailureCertainty(error: unknown): "rejected" | "uncertain" {
  const code = networkErrorCode(error);
  // These errors prove that no HTTP request reached the peer. Timeouts,
  // resets, and generic fetch failures do not prove that and stay uncertain.
  if (code && ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH"].includes(code)) {
    return "rejected";
  }
  return "uncertain";
}

export async function dispatchToPeer(params: {
  agentUrl: string;
  adapterSecret?: string;
  body: Record<string, unknown>;
  timeoutMs?: number;
}): Promise<PeerDispatchResult> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  Object.assign(headers, authHeadersForAgent(params.agentUrl, params.adapterSecret));

  let response: Response;
  try {
    response = await fetch(params.agentUrl.replace(/\/+$/, "") + "/runs", {
      method: "POST",
      headers,
      body: JSON.stringify(params.body),
      signal: AbortSignal.timeout(params.timeoutMs ?? getAcpTimeout()),
    });
  } catch (error) {
    throw new AcpDispatchError(
      error instanceof Error ? error.message : String(error),
      dispatchFailureCertainty(error),
      undefined,
      undefined,
      { cause: error },
    );
  }
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    throw new AcpDispatchError(
      `ACP response body was interrupted after HTTP ${response.status}.`,
      "uncertain",
      response.status,
      undefined,
      { cause: error },
    );
  }
  let parsed: Record<string, unknown> | undefined;
  if (text) {
    try {
      const value: unknown = JSON.parse(text);
      if (value && typeof value === "object" && !Array.isArray(value)) parsed = value as Record<string, unknown>;
    } catch {
      parsed = undefined;
    }
  }
  if (!response.ok) {
    const code = typeof parsed?.error === "object" && parsed.error && "code" in parsed.error
      && typeof (parsed.error as { code?: unknown }).code === "string"
      ? (parsed.error as { code: string }).code
      : undefined;
    const sessionId = typeof params.body.session_id === "string" ? params.body.session_id : undefined;
    const dispatchKey = typeof params.body.dispatch_idempotency_key === "string" ? params.body.dispatch_idempotency_key : undefined;
    const duplicateRemoteRunId = typeof parsed?.remote_run_id === "string" ? parsed.remote_run_id
      : typeof parsed?.run_id === "string" ? parsed.run_id : undefined;
    const grantField = params.body.read_only_execution_grant !== undefined
      ? "read_only_execution_grant"
      : params.body.bounded_file_write_grant !== undefined ? "bounded_file_write_grant" : undefined;
    const executionMode = grantField === "read_only_execution_grant" ? "read_only_audit"
      : grantField === "bounded_file_write_grant" ? "bounded_file_write" : undefined;
    const duplicateExecutionReceipt = duplicateRemoteRunId && grantField && executionMode
      ? correlateExecutionReceipt(parsed?.execution_receipt, params.body, duplicateRemoteRunId, grantField, executionMode)
      : undefined;
    const duplicateIsCorrelated = response.status === 409
      && code === "duplicate_session"
      && Boolean(duplicateRemoteRunId)
      && (!sessionId || parsed?.work_session_id === sessionId)
      && (!dispatchKey || parsed?.dispatch_idempotency_key === dispatchKey)
      && (grantField === undefined || Boolean(duplicateExecutionReceipt));
    if (duplicateIsCorrelated && parsed) {
      parsed = {
        ...parsed,
        run_id: duplicateRemoteRunId,
        remote_run_id: duplicateRemoteRunId,
        accepted: true,
        status: "running",
      };
      return { status: response.status, body: parsed, text, executionReceipt: duplicateExecutionReceipt };
    }
    const certainty = code === "workspace_lease_lost" || code === "dispatch_receipt_capacity"
      ? "rejected"
      : response.status >= 400 && response.status < 500
        && ![408, 409, 425, 429].includes(response.status)
        ? "rejected"
        : "uncertain";
    throw new AcpDispatchError(
      `ACP request failed (${response.status})${code ? ` ${code}` : ""}: ${text.slice(0, 500) || "unknown"}`,
      certainty,
      response.status,
      code,
    );
  }
  const acceptedResponse = z.object({
    run_id: z.string().trim().min(1),
    remote_run_id: z.string().trim().min(1).optional(),
    accepted: z.literal(true),
    status: z.enum(["accepted", "starting", "running", "completed", "failed", "cancelled"]),
    dispatch_idempotency_key: z.string().min(1).optional(),
  }).passthrough().safeParse(parsed);
  if (!acceptedResponse.success) {
    throw new AcpDispatchError(
      `ACP peer returned a malformed successful acceptance response (${response.status}); dispatch outcome is uncertain.`,
      "uncertain",
      response.status,
    );
  }
  const body = acceptedResponse.data as Record<string, unknown>;
  if (body.remote_run_id !== undefined && body.remote_run_id !== body.run_id) {
    throw new AcpDispatchError("ACP peer returned conflicting run_id and remote_run_id values; dispatch outcome is uncertain.", "uncertain", response.status);
  }
  const expectedDispatchKey = params.body.dispatch_idempotency_key;
  if (typeof expectedDispatchKey === "string"
    && body.dispatch_idempotency_key !== expectedDispatchKey) {
    throw new AcpDispatchError("ACP peer acceptance did not confirm the current dispatch idempotency key; dispatch outcome is uncertain.", "uncertain", response.status);
  }
  const grantField = params.body.read_only_execution_grant !== undefined
    ? "read_only_execution_grant"
    : params.body.bounded_file_write_grant !== undefined ? "bounded_file_write_grant" : undefined;
  const executionMode = grantField === "read_only_execution_grant" ? "read_only_audit"
    : grantField === "bounded_file_write_grant" ? "bounded_file_write" : undefined;
  const executionReceipt = grantField && executionMode
    ? correlateExecutionReceipt(body.execution_receipt, params.body, body.run_id as string, grantField, executionMode)
    : undefined;
  if (grantField && !executionReceipt) {
    throw new AcpDispatchError("ACP peer acceptance did not return a correlated signed execution receipt; dispatch outcome is uncertain.", "uncertain", response.status);
  }
  if (executionReceipt) body.execution_receipt = executionReceipt;
  if (body.status === "accepted" || body.status === "starting") body.status = "running";
  return { status: response.status, body, text, executionReceipt };
}

export interface PeerDispatchLookupResult {
  status: "found" | "unstarted" | "unknown";
  remoteRunId?: string;
  executionStatus?: string;
  executionReceipt?: ReadOnlyExecutionReceipt;
}

/** Query an adapter using the same idempotency key sent to POST /runs. */
export async function lookupPeerDispatch(params: {
  agentUrl: string;
  adapterSecret?: string;
  dispatchIdempotencyKey: string;
  requireExecutionReceipt?: boolean;
  expectedExecutionMode?: ReadOnlyExecutionReceipt["mode"];
  expectedNetworkPolicy?: "disabled" | "host";
  expectedReceipt?: {
    workSessionId?: string;
    workspaceSessionId?: string;
    parentRunId?: string;
    attemptNumber?: number;
    dispatchIdempotencyKey: string;
  };
  timeoutMs?: number;
}): Promise<PeerDispatchLookupResult> {
  const endpoint = `${params.agentUrl.replace(/\/+$/, "")}/runs/by-dispatch-id/${encodeURIComponent(params.dispatchIdempotencyKey)}`;
  const response = await fetch(endpoint, {
    method: "GET",
    headers: authHeadersForAgent(params.agentUrl, params.adapterSecret),
    signal: AbortSignal.timeout(params.timeoutMs ?? 5_000),
  });
  if (response.status === 404 || response.status === 405) return { status: "unknown" };
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try { body = text ? JSON.parse(text) as Record<string, unknown> : {}; } catch { /* unknown response shape */ }
  if (!response.ok) throw new Error(`ACP dispatch lookup failed (${response.status}): ${text.slice(0, 300)}`);
  if (body.authoritatively_unstarted === true) return { status: "unstarted" };
  const remoteRunId = typeof body.remote_run_id === "string" ? body.remote_run_id
    : typeof body.run_id === "string" ? body.run_id : undefined;
  if (body.accepted === true && remoteRunId) {
    const parsedReceipt = body.execution_receipt === undefined
      ? undefined
      : readOnlyExecutionReceiptSchema.safeParse(body.execution_receipt);
    const executionReceipt = parsedReceipt?.success ? parsedReceipt.data : undefined;
    if (params.requireExecutionReceipt && !executionReceipt) return { status: "unknown" };
    if (body.execution_receipt !== undefined && (!executionReceipt
      || executionReceipt.remote_run_id !== remoteRunId
      || executionReceipt.dispatch_idempotency_key !== params.dispatchIdempotencyKey
      || (params.expectedExecutionMode !== undefined && executionReceipt.mode !== params.expectedExecutionMode)
      || (params.expectedNetworkPolicy !== undefined && executionReceipt.network_policy !== params.expectedNetworkPolicy)
      || (params.expectedReceipt?.workSessionId !== undefined && executionReceipt.work_session_id !== params.expectedReceipt.workSessionId)
      || (params.expectedReceipt?.workspaceSessionId !== undefined && executionReceipt.workspace_session_id !== params.expectedReceipt.workspaceSessionId)
      || (params.expectedReceipt?.parentRunId !== undefined && executionReceipt.parent_run_id !== params.expectedReceipt.parentRunId)
      || (params.expectedReceipt?.attemptNumber !== undefined && executionReceipt.attempt_number !== params.expectedReceipt.attemptNumber))) {
      return { status: "unknown" };
    }
    return {
      status: "found",
      remoteRunId,
      executionStatus: typeof body.status === "string" ? body.status : undefined,
      ...(executionReceipt ? { executionReceipt } : {}),
    };
  }
  return { status: "unknown" };
}

export interface AgentProbeResult {
  healthy: boolean;
  status: number;
  error?: string;
  note?: string;
  executionCapabilities?: Record<string, unknown>;
}

export async function probeAgent(url: string, sharedSecret?: string): Promise<AgentProbeResult> {
  if (!/^https?:\/\//i.test(url)) {
    return {
      healthy: false,
      status: 0,
      note: "unsupported probe transport; only HTTP ACP adapters are dispatchable",
    };
  }
  const headers = authHeadersForAgent(url, sharedSecret);
  const baseUrl = url.replace(/\/+$/, "");
  try {
    const health = await fetch(baseUrl + "/health", {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(3000),
    });
    if (health.ok) {
      let executionCapabilities: Record<string, unknown> | undefined;
      try {
        const payload: unknown = await health.clone().json();
        if (payload && typeof payload === "object" && !Array.isArray(payload)) {
          const value = (payload as Record<string, unknown>).executionCapabilities;
          if (value && typeof value === "object" && !Array.isArray(value)) executionCapabilities = value as Record<string, unknown>;
        }
      } catch { /* a generic ACP health body carries no mode-specific capability contract */ }
      return { healthy: true, status: health.status, note: "/health", ...(executionCapabilities ? { executionCapabilities } : {}) };
    }
    if (health.status !== 404 && health.status !== 405) {
      return { healthy: false, status: health.status };
    }

    // Generic ACP-style fallback: /health is a Kontrol adapter convention, not
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
  permanentBlocker?: boolean;
}

/**
 * Among candidate peers (filtered by name/role), return the FIRST that passes
 * a protocol-readiness probe. Collects dead endpoints so callers can surface a
 * clear error instead of silently routing to a 404 endpoint.
 */
export async function selectHealthyAgent(
  peers: AgentInfo[],
  opts: { name?: string; role?: string; adapterSecret?: string; clientPlatformHint?: string },
): Promise<HealthyAgentSelection> {
  const candidates = peers.filter((a) => {
    if (opts.name && a.name !== opts.name) return false;
    if (opts.role && a.role !== opts.role) return false;
    return true;
  });
  const platform = normalizePlatformHint(opts.clientPlatformHint);
  if (platform) {
    const nativeName = ({ openai: "codex", anthropic: "claude", google: "gemini" } as Record<string, string>)[platform];
    const capability = `native:${platform}`;
    candidates.sort((a, b) => {
      const score = (peer: AgentInfo) => Number(peer.capabilities.includes(capability)) * 2
        + Number(nativeName !== undefined && peer.name.toLowerCase() === nativeName);
      return score(b) - score(a);
    });
  }
  const deadUrls: string[] = [];
  let allFailuresPermanent = candidates.length > 0;
  for (const peer of candidates) {
    const probe = await probeAgent(peer.url, opts.adapterSecret);
    if (probe.healthy) return { agent: peer, deadUrls };
    deadUrls.push(`${peer.url} (${probe.error ? probe.error : "HTTP " + probe.status})`);
    allFailuresPermanent = allFailuresPermanent && (
      probe.note?.startsWith("unsupported") === true
      || probe.note?.includes("requires authentication") === true
      || probe.status === 401
      || probe.status === 403
      || probe.status === 404
      || probe.status === 405
    );
  }
  return { deadUrls, permanentBlocker: allFailuresPermanent };
}

function normalizePlatformHint(value: string | undefined): string | undefined {
  const hint = value?.trim().toLowerCase();
  if (!hint) return undefined;
  if (/openai|chatgpt|codex/.test(hint)) return "openai";
  if (/anthropic|claude/.test(hint)) return "anthropic";
  if (/google|gemini/.test(hint)) return "google";
  return hint.replace(/[^a-z0-9_-]/g, "").slice(0, 64) || undefined;
}

// Correlation between a work session and its ACP run is persisted on the
// acp_runs row (workSessionId column), not held in an in-memory map. That keeps
// it durable across Kontrol restarts — submit_for_review looks the run up by
// workSessionId via agentRegistry.getRunByWorkSessionId().

const AGENT_SUBMIT_TIMEOUT_MS = 5 * 60 * 1000; // bound the "did it submit?" wait
const NON_RESUMABLE_RUN_STATUSES = new Set(["cancelling", "approved", "rejected", "cancelled", "failed", "failed_protocol"]);
const TERMINAL_WORK_SESSION_STATUSES = new Set(["approved", "rejected", "cancelled", "failed", "failed_protocol"]);

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface GatewayConfig {
  agentRegistry: AgentRegistryManager;
  workspaces: WorkspaceRegistry;
  workSessions: WorkSessionManager;
  /** P0 #9: outbound adapter credential (KONTROL_ACP_ADAPTER_SECRET). */
  adapterSecret?: string;
  readOnlyExecutionNetworkPolicy?: "disabled" | "host";
}

export interface AgentCallResult {
  /** Kontrol-owned durable run ID (authoritative). */
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
  executionReceipt?: ReadOnlyExecutionReceipt;
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
    adapterSecret: config.adapterSecret,
  });
  if (!selection.agent) {
    return { acknowledged: false, error: `No healthy registered adapter for ${run.agentName}` };
  }

  return cancelRemoteRunById(selection.agent.url, config.adapterSecret, run.remoteRunId);
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
    agentId?: string;
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
    /** Nonce of the checkout lease held by this work session. */
    workspaceLeaseNonce?: string;
    /** Expiry of the checkout lease that the worker must renew before its local deadline. */
    workspaceLeaseExpiresAt?: string;
    /** Stable logical launch identity for exactly-once adapter dispatch. */
    dispatchIdempotencyKey?: string;
    /** Persist the allocated ACP identity before an adapter can start its worker. */
    onAcpAttemptAllocated?: (identity: {
      runId: string;
      attemptNumber: number;
      dispatchIdempotencyKey: string;
    }) => void;
    /** Server-owned scheduled execution policy forwarded to the adapter. */
    scheduledExecutionPolicy?: {
      executionMode?: string;
      workspaceAccess?: string;
      mutate?: boolean;
      allowedTools?: string[];
      allowedOutputs?: Array<Record<string, unknown>>;
      executionGrantTtlMs?: number;
      maxRuntimeMs?: number;
    };
  },
): Promise<AgentCallResult> {
  const dispatchIdempotencyKey = params.dispatchIdempotencyKey ?? `disp_${randomUUID()}`;
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
    if (NON_RESUMABLE_RUN_STATUSES.has(existing.status)) {
      throw new Error(`Cannot resume non-resumable run ${existing.runId}: ${existing.status}`);
    }
    run = existing;
    attemptNumber = (existing.attemptNumber ?? 1) + 1;
    expectedDispatchStatus = "resuming";
    config.agentRegistry.updateRun(run.runId, {
      attemptNumber,
      status: "resuming",
      outputPreview: "",
      outputJson: "",
      errorMessage: undefined,
      finishedAt: undefined,
    });
  } else {
    const prior = config.agentRegistry.getRunByDispatchIdempotencyKey(dispatchIdempotencyKey);
    run = prior ?? config.agentRegistry.createRun({
      agentName: params.agentName,
      agentId: params.agentId,
      workspaceSessionId: params.workspaceSessionId,
      workSessionId: params.workSessionId,
      inputPreview: params.task.slice(0, 500),
      webhookUrl: params.webhookUrl,
      scheduledExecutionMode: params.scheduledExecutionPolicy?.executionMode === "read_only_audit"
        ? "read_only_audit"
        : params.scheduledExecutionPolicy?.executionMode,
      status: "created",
    });
    if (run.agentId !== params.agentId || run.workSessionId !== params.workSessionId) {
      throw new Error("ACP dispatch idempotency key is already bound to a different agent or work session.");
    }
    expectedDispatchStatus = run.status;
    attemptNumber = run.attemptNumber ?? 1;
  }
  if (params.scheduledExecutionPolicy?.executionMode === "read_only_audit"
    && run.scheduledExecutionMode !== "read_only_audit") {
    config.agentRegistry.updateRun(run.runId, { scheduledExecutionMode: "read_only_audit" });
    run.scheduledExecutionMode = "read_only_audit";
  }
  if (params.scheduledExecutionPolicy?.executionMode === "bounded_file_write"
    && run.scheduledExecutionMode !== "bounded_file_write") {
    config.agentRegistry.updateRun(run.runId, { scheduledExecutionMode: "bounded_file_write" });
    run.scheduledExecutionMode = "bounded_file_write";
  }
  config.agentRegistry.beginDispatchAttempt({
    key: dispatchIdempotencyKey,
    runId: run.runId,
    agentId: run.agentId,
    attemptNumber,
  });

  const started = Date.now();
  let requestState: "not_sent" | "in_flight" | "accepted" = "not_sent";
  try {
    if (params.scheduledExecutionPolicy?.executionMode === "bounded_file_write") {
      if (!params.workSessionId || !params.onAcpAttemptAllocated) {
        throw new Error("bounded_file_write_attempt_binding_unavailable");
      }
      params.onAcpAttemptAllocated({
        runId: run.runId,
        attemptNumber,
        dispatchIdempotencyKey,
      });
    }
    // Resolve the workspace root for the dispatch so the adapter can spawn
    // CRUSH in the correct repository, not in the Kontrol directory.
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
      // Bind the Kontrol-owned identities into the adapter request so the
      // spawned CRUSH process can attribute its tool activity to the exact
      // work session. The MCP connection envelope carries these downstream.
      workspace_session_id: params.workspaceSessionId,
      workspace_root: workspace?.root,
      session_id: params.workSessionId,
      parent_run_id: run.runId,
      agent_id: run.agentId,
      continuation_id: params.continuationId,
      attempt_number: attemptNumber,
      workspace_lease_nonce: params.workspaceLeaseNonce,
      workspace_lease_expires_at: params.workspaceLeaseExpiresAt,
      dispatch_idempotency_key: dispatchIdempotencyKey,
      scheduled_execution_policy: params.scheduledExecutionPolicy,
    };

    if (params.scheduledExecutionPolicy?.executionMode === "read_only_audit") {
      if (
        params.scheduledExecutionPolicy.workspaceAccess !== "read_only"
        || params.scheduledExecutionPolicy.mutate !== false
        || !params.workSessionId
        || !params.workspaceSessionId
        || !run.agentId
        || !config.adapterSecret
        || !workspace
      ) {
        throw new Error("read_only_grant_claims_invalid");
      }
      const canonicalWorkspaceRoot = realpathSync(workspace.root);
      body.workspace_root = canonicalWorkspaceRoot;
      body.read_only_execution_grant = createReadOnlyExecutionGrant({
        workSessionId: params.workSessionId,
        workspaceSessionId: params.workspaceSessionId,
        workspaceRoot: canonicalWorkspaceRoot,
        agentId: run.agentId,
        runId: run.runId,
        attemptNumber,
        dispatchIdempotencyKey,
        networkPolicy: config.readOnlyExecutionNetworkPolicy ?? "disabled",
        ttlMs: params.scheduledExecutionPolicy.executionGrantTtlMs,
      }, config.adapterSecret);
    }

    if (params.scheduledExecutionPolicy?.executionMode === "bounded_file_write") {
      if (
        params.scheduledExecutionPolicy.workspaceAccess !== "staged_write"
        || params.scheduledExecutionPolicy.mutate !== true
        || !params.scheduledExecutionPolicy.allowedOutputs?.length
        || !params.workSessionId
        || !params.workspaceSessionId
        || !run.agentId
        || !config.adapterSecret
        || !workspace
      ) {
        throw new Error("bounded_file_write_grant_claims_invalid");
      }
      const canonicalWorkspaceRoot = realpathSync(workspace.root);
      body.workspace_root = canonicalWorkspaceRoot;
      body.bounded_file_write_grant = createBoundedFileWriteGrant({
        workSessionId: params.workSessionId,
        workspaceSessionId: params.workspaceSessionId,
        workspaceRoot: canonicalWorkspaceRoot,
        agentId: run.agentId,
        runId: run.runId,
        attemptNumber,
        dispatchIdempotencyKey,
        allowedOutputs: params.scheduledExecutionPolicy.allowedOutputs,
        networkPolicy: config.readOnlyExecutionNetworkPolicy ?? "disabled",
        ttlMs: params.scheduledExecutionPolicy.executionGrantTtlMs,
      }, config.adapterSecret);
      // The top-level echo is part of the canonical dispatch request. The
      // adapter verifies it against the signed grant before selecting its
      // bubblewrap network namespace.
      body.execution_network_policy = config.readOnlyExecutionNetworkPolicy ?? "disabled";
    }

    if (params.webhookUrl) {
      body.webhook_url = params.webhookUrl;
    }

    const useAsync = params.mode === "async";

    requestState = "in_flight";
    const dispatched = await dispatchToPeer({
      agentUrl: params.agentUrl,
      adapterSecret: config.adapterSecret,
      body,
      timeoutMs: getAcpTimeout(),
    });
    requestState = "accepted";

    const result = dispatched.body as {
      run_id?: string;
      remote_run_id?: string;
      status?: string;
      output?: Array<{ parts?: Array<{ content?: string }> }>;
      error?: { message?: string };
    };

    const remoteRunId = result.remote_run_id ?? result.run_id;
    if (!remoteRunId) {
      // dispatchToPeer enforces this schema. Keep the durable boundary
      // defensive in case a caller is introduced without that helper.
      throw new AcpDispatchError("ACP peer acceptance did not include an adapter run ID.", "uncertain", dispatched.status);
    }
    config.agentRegistry.updateDispatchAttempt(dispatchIdempotencyKey, { status: "accepted", remoteRunId });
    const errorMessage = result.error?.message;

    // A scheduled bounded-write run is an async logical execution. An adapter may
    // synchronously report a provisional terminal result before its worker has
    // published artifacts or delivered lifecycle events. Preserve the logical
    // run/session so publication remains authorized; final terminal evidence is
    // observed through the durable lifecycle event route.
    if (useAsync && params.fireAndForget && params.scheduledExecutionPolicy?.executionMode === "bounded_file_write" &&
      ["completed", "failed", "cancelled"].includes(String(result.status))) {
      const currentRun = config.agentRegistry.getRun(run.runId);
      const runStillDispatchable =
        currentRun?.status === expectedDispatchStatus &&
        currentRun.attemptNumber === attemptNumber;
      if (!runStillDispatchable) {
        throw new Error("Run changed before provisional bounded-write acceptance could be recorded.");
      }
      config.agentRegistry.updateRun(run.runId, {
        status: "running",
        remoteRunId,
        attemptNumber,
        lastHeartbeatAt: new Date().toISOString(),
      });
      return {
        runId: run.runId,
        remoteRunId,
        attemptNumber,
        agentName: params.agentName,
        status: "running",
        output: "Agent accepted the task and is working. Observe via await_work_session_events or get_work_session.",
        workSessionId: params.workSessionId,
        ...(dispatched.executionReceipt ? { executionReceipt: dispatched.executionReceipt } : {}),
      };
    }
    if (useAsync && ["completed", "failed", "cancelled"].includes(String(result.status))) {
      const outputText = Array.isArray(result.output)
        ? result.output.flatMap((m) => m.parts?.map((p) => p.content ?? "").filter(Boolean) ?? []).join("\n")
        : "";
      config.agentRegistry.updateRun(run.runId, {
        status: result.status as "completed" | "failed" | "cancelled",
        remoteRunId,
        attemptNumber,
        outputPreview: outputText.slice(0, 2000),
        outputJson: serializeFinalAcpResult(result, outputText),
        errorMessage,
        finishedAt: new Date().toISOString(),
      });
      return {
        runId: run.runId,
        remoteRunId,
        attemptNumber,
        agentName: params.agentName,
        status: result.status as "completed" | "failed" | "cancelled",
        output: outputText,
        error: errorMessage,
        workSessionId: params.workSessionId,
        ...(dispatched.executionReceipt ? { executionReceipt: dispatched.executionReceipt } : {}),
      };
    }

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
        await cancelRemoteRunById(params.agentUrl, config.adapterSecret, remoteRunId);
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
          ...(dispatched.executionReceipt ? { executionReceipt: dispatched.executionReceipt } : {}),
        };
      }

      // Fire-and-forget: the WebUI dispatch path returns immediately with the
      // KONTROL run ID (not the adapter's), and observes progress via the
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
          await cancelRemoteRunById(params.agentUrl, config.adapterSecret, remoteRunId);
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
            ...(dispatched.executionReceipt ? { executionReceipt: dispatched.executionReceipt } : {}),
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
          ...(dispatched.executionReceipt ? { executionReceipt: dispatched.executionReceipt } : {}),
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
      outputJson: serializeFinalAcpResult(result, outputText),
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
    const certainty = error instanceof AcpDispatchError
      ? error.certainty
      : requestState === "in_flight" ? "uncertain" : "rejected";
    const status = certainty === "uncertain" || requestState === "accepted" ? "dispatch_uncertain" : "failed";
    config.agentRegistry.updateDispatchAttempt(dispatchIdempotencyKey, {
      status: status === "dispatch_uncertain" ? "uncertain" : "rejected",
    });
    config.agentRegistry.updateRun(run.runId, status === "dispatch_uncertain"
      ? { status, errorMessage, finishedAt: undefined }
      : { status, errorMessage, finishedAt: new Date().toISOString() });

    return {
      runId: run.runId,
      remoteRunId: run.remoteRunId,
      attemptNumber: run.attemptNumber ?? 1,
      agentName: params.agentName,
      status: status === "dispatch_uncertain" ? "uncertain" : "failed",
      output: "",
      error: errorMessage,
    };
  }
}

/**
 * Execute a Kontrol tool directly (used by ACP server for kontrol-* agents).
 * Maps agent name to the underlying pi-tools function.
 */
export async function executeKontrolTool(
  agentName: string,
  input: string,
  cwd: string,
  root: string,
): Promise<string> {
  const parsed = tryParseJson(input);
  if (!parsed) return input; // treat raw text as default

  switch (agentName) {
    case "kontrol-read": {
      const result = await readFileTool(
        { path: String(parsed.path ?? "."), offset: 1, limit: 500 },
        { cwd, root },
      );
      return result.content.map((c) => ("text" in c ? c.text : "")).join("");
    }

    case "kontrol-write": {
      const result = await writeFileTool(
        { path: String(parsed.path), content: String(parsed.content ?? "") },
        { cwd, root },
      );
      return result.content.map((c) => ("text" in c ? c.text : "")).join("");
    }

    case "kontrol-edit": {
      const result = await editFileTool(
        { path: String(parsed.path), edits: (parsed.edits ?? []) as { oldText: string; newText: string }[] },
        { cwd, root },
      );
      const text = result.content.map((c) => ("text" in c ? c.text : "")).join("");
      const details = result.details as { additions?: number; removals?: number } | undefined;
      return `${text}${details ? ` (+${details.additions ?? 0} -${details.removals ?? 0})` : ""}`;
    }

    case "kontrol-grep": {
      const result = await grepFilesTool(
        { pattern: String(parsed.pattern), path: typeof parsed.path === "string" ? parsed.path : undefined },
        { cwd, root },
      );
      return result.content.map((c) => ("text" in c ? c.text : "")).join("");
    }

    case "kontrol-glob": {
      const result = await findFilesTool(
        { pattern: String(parsed.pattern), path: typeof parsed.path === "string" ? parsed.path : undefined },
        { cwd, root },
      );
      return result.content.map((c) => ("text" in c ? c.text : "")).join("");
    }

    case "kontrol-shell": {
      const result = await runShellTool(
        { command: String(parsed.command ?? input), timeout: Number(parsed.timeout ?? 30) },
        { cwd, root: cwd },
      );
      return result.content.map((c) => ("text" in c ? c.text : "")).join("");
    }

    default:
      throw new Error(`Unknown Kontrol agent: ${agentName}`);
  }
}

function tryParseJson(text: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}
