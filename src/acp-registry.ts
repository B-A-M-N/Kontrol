import { randomUUID, createHash, timingSafeEqual } from "node:crypto";
import { eq, and, lt, desc, sql } from "drizzle-orm";
import { openDatabase, type DatabaseHandle } from "./db/client.js";
import { validateWebhookUrl, type WebhookPolicy } from "./webhook-policy.js";
import {
  agentRegistry,
  acpRuns,
  agentWebhookQueue,
  type AgentRegistryRow,
  type AcpRunRow,
  type AgentWebhookQueueRow,
} from "./db/schema.js";

/**
 * The final agent report is authoritative run output, so it gets a larger
 * bounded channel than live telemetry. Keep the bound explicit and shared by
 * adapters, synchronous dispatch, and durable persistence.
 */
export const FINAL_RESULT_MAX_BYTES = 2 * 1024 * 1024;

export function truncateUtf8Tail(value: string, maxBytes = FINAL_RESULT_MAX_BYTES): string {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.byteLength <= maxBytes) return value;
  let start = Math.max(0, encoded.byteLength - maxBytes);
  while (start < encoded.byteLength && (encoded[start]! & 0xc0) === 0x80) start += 1;
  return encoded.subarray(start).toString("utf8");
}

function acpOutputText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .flatMap((message) => {
      if (!message || typeof message !== "object") return [];
      const parts = (message as { parts?: unknown }).parts;
      if (!Array.isArray(parts)) return [];
      return parts.flatMap((part) => {
        if (!part || typeof part !== "object") return [];
        const content = (part as { content?: unknown }).content;
        return typeof content === "string" ? [content] : [];
      });
    })
    .join("\n");
}

function withFinalOutput(source: Record<string, unknown>, outputText: string): Record<string, unknown> {
  return {
    ...source,
    output: [{
      role: "agent",
      parts: [{ content_type: "text/plain", content: outputText }],
    }],
  };
}

function serializedUtf8(source: Record<string, unknown>, outputText: string): string {
  return JSON.stringify(withFinalOutput(source, outputText));
}

/** Fit the output by measuring the actual UTF-8 JSON serialization. */
function fitSerializedOutput(source: Record<string, unknown>, outputText: string): string {
  const full = serializedUtf8(source, outputText);
  if (Buffer.byteLength(full, "utf8") <= FINAL_RESULT_MAX_BYTES) return full;

  let low = 0;
  let high = Buffer.byteLength(outputText, "utf8");
  let best = serializedUtf8(source, "");
  while (low <= high) {
    const candidateBytes = Math.floor((low + high) / 2);
    const candidate = serializedUtf8(source, truncateUtf8Tail(outputText, candidateBytes));
    if (Buffer.byteLength(candidate, "utf8") <= FINAL_RESULT_MAX_BYTES) {
      best = candidate;
      low = candidateBytes + 1;
    } else {
      high = candidateBytes - 1;
    }
  }
  return best;
}

/** Serialize a final ACP result without turning the persisted JSON invalid. */
export function serializeFinalAcpResult(result: unknown, finalOutput?: string): string {
  const source = result && typeof result === "object" && !Array.isArray(result)
    ? { ...(result as Record<string, unknown>) }
    : {};
  const outputText = finalOutput ?? acpOutputText(source.output);
  const encoded = fitSerializedOutput(source, outputText);
  if (Buffer.byteLength(encoded, "utf8") <= FINAL_RESULT_MAX_BYTES) return encoded;

  // A peer may include an unexpectedly large diagnostic field. Preserve only
  // stable scalar identity/status fields, bounded by bytes, before fitting the
  // authoritative final report. The final fallback is always valid JSON under
  // the protocol budget, even for a hostile result object.
  const compact: Record<string, unknown> = {};
  for (const key of ["run_id", "remote_run_id", "status", "accepted", "mode", "error"]) {
    const value = source[key];
    if (typeof value === "string") compact[key] = truncateUtf8Tail(value, 4_096);
    else if (typeof value === "boolean" || typeof value === "number" || value === null) compact[key] = value;
  }
  const compactEncoded = fitSerializedOutput(compact, outputText);
  if (Buffer.byteLength(compactEncoded, "utf8") <= FINAL_RESULT_MAX_BYTES) return compactEncoded;
  return serializedUtf8({}, "");
}

export interface AgentRegistration {
  name: string;
  url: string;
  description?: string;
  publicKey?: string;
  capabilities?: string[];
  tags?: string[];
  role?: "agent" | "client" | string;
  ttlSeconds?: number;
  /** Existing durable identity, supplied only for authenticated re-registration. */
  agentId?: string;
  /** Existing raw credential, supplied only for authenticated re-registration. */
  agentCredential?: string;
}

export interface AgentRegistrationResult extends AgentInfo {
  /** Present only when a new identity is created; never persisted or returned later. */
  agentCredential?: string;
}

export class AgentRegistrationError extends Error {
  constructor(
    message: string,
    readonly code: "agent_identity_not_found" | "agent_identity_conflict" | "agent_credential_required" | "agent_credential_invalid",
    readonly status = code === "agent_credential_required" ? 409 : code === "agent_identity_not_found" ? 404 : 403,
  ) {
    super(message);
    this.name = "AgentRegistrationError";
  }
}

function credentialHashMatches(expected: string | null | undefined, presented: string | undefined): boolean {
  if (!expected || !presented) return false;
  const actual = Buffer.from(createHash("sha256").update(presented).digest("hex"), "utf8");
  const wanted = Buffer.from(expected, "utf8");
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

export interface AgentInfo {
  id: string;
  name: string;
  url: string;
  description?: string;
  publicKey?: string;
  capabilities: string[];
  tags: string[];
  role: string;
  lastHeartbeat: string;
  createdAt: string;
  alive: boolean;
}

export interface PersistentAcpRun {
  runId: string;
  agentName: string;
  agentId?: string;
  workspaceSessionId?: string;
  workSessionId?: string;
  /** Adapter-side execution-attempt identifier (e.g. crush_local_*). */
  remoteRunId?: string;
  /** Attempt number within the same logical run (continuations bump this). */
  attemptNumber: number;
  status: string;
  inputPreview?: string;
  outputPreview?: string;
  outputJson?: string;
  errorMessage?: string;
  webhookUrl?: string;
  webhookDelivered: boolean;
  lastHeartbeatAt?: string;
  /** Adapter-worker lease expiry. Cleared (null) when the worker attempt ends. */
  workerLeaseUntil?: string | null;
  createdAt: string;
  finishedAt?: string;
}

export interface AgentRegistryManager {
  register(registration: AgentRegistration): AgentRegistrationResult;
  /** P1 #11: verify a presented per-agent credential against the durable hash. */
  verifyAgentCredential(agentId: string, presented: string | undefined): boolean;
  /** Rotate an identity credential; raw output is returned once only. */
  rotateAgentCredential(agentId: string, presentedCredential?: string, operatorAuthorized?: boolean): string;
  /** Revoke an identity credential without deleting its durable identity row. */
  revokeAgentCredential(agentId: string, presentedCredential?: string, operatorAuthorized?: boolean): void;
  ensure(registration: AgentRegistration): AgentInfo;
  unregister(id: string): void;
  heartbeat(id: string, presentedCredential?: string): boolean;
  get(id: string): AgentInfo | undefined;
  listAlive(): AgentInfo[];
  listAll(): AgentInfo[];
  pruneExpired(): number;
  createRun(input: {
    agentName: string;
    agentId?: string;
    workspaceSessionId?: string;
    workSessionId?: string;
    inputPreview?: string;
    webhookUrl?: string;
    status?: string;
    remoteRunId?: string;
    attemptNumber?: number;
  }): PersistentAcpRun;
  updateRun(runId: string, updates: Partial<PersistentAcpRun>): void;
  updateRunIfCurrent(
    runId: string,
    expected: { status: string; attemptNumber: number },
    updates: Partial<PersistentAcpRun>,
  ): boolean;
  getRun(runId: string): PersistentAcpRun | undefined;
  getRunByWorkSessionId(workSessionId: string): PersistentAcpRun | undefined;
  listRuns(workspaceSessionId?: string, limit?: number): PersistentAcpRun[];
  enqueueWebhook(runId: string, targetUrl: string, payload: unknown): void;
  processWebhooks(): Promise<number>;
  /** Stop scheduling and wait for an in-flight delivery batch. */
  drain?(): Promise<void>;
  close(): void;
}

export function createAgentRegistryManager(
  stateDirOrHandle: string | DatabaseHandle,
  webhookPolicy?: WebhookPolicy,
): AgentRegistryManager {
  const database =
    typeof stateDirOrHandle === "string" ? openDatabase(stateDirOrHandle) : stateDirOrHandle;
  return new SqliteAgentRegistryManager(database, webhookPolicy);
}

class SqliteAgentRegistryManager implements AgentRegistryManager {
  private readonly database: DatabaseHandle;
  private readonly webhookPolicy: WebhookPolicy;
  private readonly webhookWorkerId = `webhook_worker_${randomUUID()}`;
  private webhookTimer?: ReturnType<typeof setInterval>;
  private webhookRun?: Promise<number>;

  constructor(database: DatabaseHandle, webhookPolicy?: WebhookPolicy) {
    this.database = database;
    // Delivery-time policy binding: the CURRENT policy governs every delivery
    // attempt. A queued event enqueued under yesterday's permissive policy is
    // blocked rather than delivered after the operator disables webhooks or
    // shrinks the allowlist and Kontrol restarts.
    this.webhookPolicy = webhookPolicy ?? { enabled: false, allowedHosts: [] };
    this.pruneExpired();
    if (!this.webhookPolicy.enabled) return; // no timer when webhooks are disabled
    this.webhookTimer = setInterval(() => {
      this.processWebhooks().catch((error) => {
        console.error(`[kontrol] webhook maintenance failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, 10_000);
  }

  register(registration: AgentRegistration): AgentRegistrationResult {
    const now = new Date().toISOString();
    const result = this.database.sqlite.transaction(() => {
      const byId = registration.agentId
        ? this.database.sqlite.prepare("select id, name, agent_credential_hash from agent_registry where id = ?")
          .get(registration.agentId) as { id: string; name: string; agent_credential_hash?: string | null } | undefined
        : undefined;
      const byName = this.database.sqlite
        .prepare("select id, name, agent_credential_hash from agent_registry where name = ?")
        .get(registration.name) as { id: string; name: string; agent_credential_hash?: string | null } | undefined;

      if (registration.agentId && !byId) {
        throw new AgentRegistrationError(
          `Unknown agent identity: ${registration.agentId}`,
          "agent_identity_not_found",
          404,
        );
      }
      if (byId && byName && byId.id !== byName.id) {
        throw new AgentRegistrationError(
          `Agent name ${registration.name} belongs to another identity`,
          "agent_identity_conflict",
          409,
        );
      }

      const existing = byId ?? byName;
      if (existing) {
        if (existing.name !== registration.name) {
          throw new AgentRegistrationError(
            `Agent identity ${existing.id} is registered as ${existing.name}, not ${registration.name}`,
            "agent_identity_conflict",
            409,
          );
        }
        // A bootstrap secret authenticates the caller to ACP, but does not
        // prove ownership of an existing agent identity. Re-registration must
        // carry both the durable ID and its prior credential.
        if (!registration.agentId || registration.agentId !== existing.id) {
          throw new AgentRegistrationError(
            `Agent identity ${existing.id} already exists; agentId and its credential are required to re-register it`,
            "agent_credential_required",
            409,
          );
        }
        if (!credentialHashMatches(existing.agent_credential_hash, registration.agentCredential)) {
          throw new AgentRegistrationError(
            `Invalid credential for agent identity ${existing.id}`,
            "agent_credential_invalid",
            403,
          );
        }
        // Preserve the credential on ordinary re-registration. Rotation is a
        // separate operator-controlled operation, so a bootstrap-secret holder
        // cannot silently seize a live identity by name.
        this.database.sqlite.prepare(`
          update agent_registry
             set url = ?, description = ?, public_key = ?, capabilities_json = ?,
                 tags = ?, role = ?, last_heartbeat = ?, ttl_seconds = ?
           where id = ?
        `).run(
          registration.url,
          registration.description ?? null,
          registration.publicKey ?? null,
          registration.capabilities ? JSON.stringify(registration.capabilities) : null,
          registration.tags?.join(",") ?? null,
          registration.role ?? "agent",
          now,
          registration.ttlSeconds ?? 60,
          existing.id,
        );
        return { id: existing.id, agentCredential: undefined };
      }

      if (registration.agentCredential) {
        throw new AgentRegistrationError(
          "An agent credential cannot create a new identity",
          "agent_credential_invalid",
          403,
        );
      }

      const newId = `agent_${randomUUID()}`;
      const agentCredential = `agcred_${randomUUID()}`;
      this.database.sqlite.prepare(`
        insert into agent_registry
          (id, name, url, description, public_key, capabilities_json, tags, role, agent_credential_hash, last_heartbeat, created_at, ttl_seconds)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        newId,
        registration.name,
        registration.url,
        registration.description ?? null,
        registration.publicKey ?? null,
        registration.capabilities ? JSON.stringify(registration.capabilities) : null,
        registration.tags?.join(",") ?? null,
        registration.role ?? "agent",
        createHash("sha256").update(agentCredential).digest("hex"),
        now,
        now,
        registration.ttlSeconds ?? 60,
      );
      return { id: newId, agentCredential };
    })();

    const agent = this.get(result.id)! as AgentRegistrationResult;
    if (result.agentCredential) agent.agentCredential = result.agentCredential;
    return agent;
  }

  /**
   * P1 #11: verify that a presented per-agent credential matches the durable
   * credential issued for that agent ID. Returns false when the agent has no
   * credential (pre-migration rows) or the value does not match.
   */
  verifyAgentCredential(agentId: string, presented: string | undefined): boolean {
    if (!presented) return false;
    const row = this.database.sqlite.prepare("select agent_credential_hash from agent_registry where id = ?")
      .get(agentId) as { agent_credential_hash?: string | null } | undefined;
    if (!row?.agent_credential_hash) return false;
    return credentialHashMatches(row.agent_credential_hash, presented);
  }

  rotateAgentCredential(agentId: string, presentedCredential?: string, operatorAuthorized = false): string {
    const nextCredential = `agcred_${randomUUID()}`;
    const changed = this.database.sqlite.transaction(() => {
      const row = this.database.sqlite.prepare("select agent_credential_hash from agent_registry where id = ?")
        .get(agentId) as { agent_credential_hash?: string | null } | undefined;
      if (!row) throw new AgentRegistrationError(`Unknown agent identity: ${agentId}`, "agent_identity_not_found", 404);
      if (!operatorAuthorized && !credentialHashMatches(row.agent_credential_hash, presentedCredential)) {
        throw new AgentRegistrationError(`Invalid credential for agent identity ${agentId}`, "agent_credential_invalid", 403);
      }
      return this.database.sqlite.prepare("update agent_registry set agent_credential_hash = ? where id = ?")
        .run(createHash("sha256").update(nextCredential).digest("hex"), agentId).changes > 0;
    })();
    if (!changed) throw new AgentRegistrationError(`Unknown agent identity: ${agentId}`, "agent_identity_not_found", 404);
    return nextCredential;
  }

  revokeAgentCredential(agentId: string, presentedCredential?: string, operatorAuthorized = false): void {
    this.database.sqlite.transaction(() => {
      const row = this.database.sqlite.prepare("select agent_credential_hash from agent_registry where id = ?")
        .get(agentId) as { agent_credential_hash?: string | null } | undefined;
      if (!row) throw new AgentRegistrationError(`Unknown agent identity: ${agentId}`, "agent_identity_not_found", 404);
      if (!operatorAuthorized && !credentialHashMatches(row.agent_credential_hash, presentedCredential)) {
        throw new AgentRegistrationError(`Invalid credential for agent identity ${agentId}`, "agent_credential_invalid", 403);
      }
      this.database.sqlite.prepare("update agent_registry set agent_credential_hash = null where id = ?").run(agentId);
    })();
  }

  ensure(registration: AgentRegistration): AgentInfo {
    const existing = this.listAll().find((a) => a.name === registration.name);
    if (existing) {
      if (existing.alive) {
        // Reconcile authoritative mutable fields rather than merely
        // heartbeating. This lets a corrected seed upgrade a stale role
        // (e.g. webui "client" → "reviewer") on restart instead of
        // preserving the outdated row for its full TTL (P0 #1).
        this.reconcile(existing.id, registration);
        return this.get(existing.id)!;
      }
      this.unregister(existing.id);
    }
    return this.register(registration);
  }

  /** Update authoritative mutable fields for an existing registration. */
  private reconcile(id: string, registration: AgentRegistration): void {
    const now = new Date().toISOString();
    this.database.db
      .update(agentRegistry)
      .set({
        url: registration.url,
        description: registration.description ?? null,
        role: registration.role ?? "agent",
        capabilitiesJson: registration.capabilities ? JSON.stringify(registration.capabilities) : null,
        tags: registration.tags?.join(",") ?? null,
        ttlSeconds: registration.ttlSeconds ?? 60,
        lastHeartbeat: now,
      })
      .where(eq(agentRegistry.id, id))
      .run();
  }

  unregister(id: string): void {
    this.database.db
      .delete(agentRegistry)
      .where(eq(agentRegistry.id, id))
      .run();
  }

  heartbeat(id: string, presentedCredential?: string): boolean {
    const now = new Date().toISOString();
    const result = presentedCredential
      ? this.database.sqlite.prepare(
        "update agent_registry set last_heartbeat = ? where id = ? and agent_credential_hash = ?",
      ).run(now, id, createHash("sha256").update(presentedCredential).digest("hex"))
      : this.database.db.update(agentRegistry).set({ lastHeartbeat: now }).where(eq(agentRegistry.id, id)).run();
    return result.changes > 0;
  }

  get(id: string): AgentInfo | undefined {
    const row = this.database.db
      .select()
      .from(agentRegistry)
      .where(eq(agentRegistry.id, id))
      .get();

    return row ? rowToAgentInfo(row) : undefined;
  }

  listAlive(): AgentInfo[] {
    const now = new Date();
    const rows = this.database.db
      .select()
      .from(agentRegistry)
      .all();

    return rows
      .map(rowToAgentInfo)
      .filter((a) => a.alive);
  }

  listAll(): AgentInfo[] {
    return this.database.db
      .select()
      .from(agentRegistry)
      .all()
      .map(rowToAgentInfo);
  }

  pruneExpired(): number {
    const now = new Date();
    // Find expired agents by checking if lastHeartbeat + ttlSeconds < now
    const rows = this.database.db
      .select()
      .from(agentRegistry)
      .all();

    let count = 0;
    for (const row of rows) {
      const heartbeat = new Date(row.lastHeartbeat);
      const ttl = row.ttlSeconds * 1000;
      if (now.getTime() - heartbeat.getTime() > ttl) {
        this.database.db
          .delete(agentRegistry)
          .where(eq(agentRegistry.id, row.id))
          .run();
        count++;
      }
    }
    return count;
  }

  createRun(input: {
    agentName: string;
    agentId?: string;
    workspaceSessionId?: string;
    workSessionId?: string;
    inputPreview?: string;
    webhookUrl?: string;
    status?: string;
    remoteRunId?: string;
    attemptNumber?: number;
  }): PersistentAcpRun {
    const now = new Date().toISOString();
    const runId = `acp_run_${randomUUID()}`;
    const run: PersistentAcpRun = {
      runId,
      agentName: input.agentName,
      agentId: input.agentId,
      workspaceSessionId: input.workspaceSessionId,
      workSessionId: input.workSessionId,
      remoteRunId: input.remoteRunId,
      attemptNumber: input.attemptNumber ?? 1,
      status: input.status ?? "created",
      inputPreview: input.inputPreview,
      webhookUrl: input.webhookUrl,
      webhookDelivered: false,
      createdAt: now,
    };

    this.database.db
      .insert(acpRuns)
      .values({
        runId: run.runId,
        agentName: run.agentName,
        agentId: run.agentId ?? null,
        workspaceSessionId: run.workspaceSessionId ?? null,
        workSessionId: run.workSessionId ?? null,
        remoteRunId: run.remoteRunId ?? null,
        attemptNumber: run.attemptNumber,
        status: run.status,
        inputPreview: run.inputPreview ?? null,
        outputPreview: null,
        outputJson: null,
        errorMessage: null,
        webhookUrl: run.webhookUrl ?? null,
        webhookDelivered: 0,
        lastHeartbeatAt: null,
        workerLeaseUntil: null,
        createdAt: run.createdAt,
        finishedAt: null,
      })
      .run();

    return run;
  }

  updateRun(runId: string, updates: Partial<PersistentAcpRun>): void {
    const values: Record<string, unknown> = {};
    if (updates.status !== undefined) values.status = updates.status;
    if (updates.outputPreview !== undefined) values.outputPreview = updates.outputPreview;
    if (updates.outputJson !== undefined) values.outputJson = updates.outputJson;
    if (updates.errorMessage !== undefined) values.errorMessage = updates.errorMessage;
    if (updates.webhookDelivered !== undefined) values.webhookDelivered = updates.webhookDelivered ? 1 : 0;
    if (updates.finishedAt !== undefined) values.finishedAt = updates.finishedAt;
    if (updates.remoteRunId !== undefined) values.remoteRunId = updates.remoteRunId;
    if (updates.attemptNumber !== undefined) values.attemptNumber = updates.attemptNumber;
    if (updates.lastHeartbeatAt !== undefined) values.lastHeartbeatAt = updates.lastHeartbeatAt;
    // Clear the lease when the caller explicitly passes null. Use property
    // presence rather than value presence so `null` updates the nullable column
    // while an omitted key remains a no-op.
    if (Object.prototype.hasOwnProperty.call(updates, "workerLeaseUntil")) {
      values.workerLeaseUntil = updates.workerLeaseUntil ?? null;
    }

    if (Object.keys(values).length === 0) return;
    this.database.db
      .update(acpRuns)
      .set(values)
      .where(eq(acpRuns.runId, runId))
      .run();
  }

  updateRunIfCurrent(
    runId: string,
    expected: { status: string; attemptNumber: number },
    updates: Partial<PersistentAcpRun>,
  ): boolean {
    const values = runUpdateValues(updates);
    if (Object.keys(values).length === 0) return true;
    const result = this.database.db
      .update(acpRuns)
      .set(values)
      .where(and(
        eq(acpRuns.runId, runId),
        eq(acpRuns.status, expected.status),
        eq(acpRuns.attemptNumber, expected.attemptNumber),
      ))
      .run();
    return result.changes > 0;
  }

  getRun(runId: string): PersistentAcpRun | undefined {
    const row = this.database.db
      .select()
      .from(acpRuns)
      .where(eq(acpRuns.runId, runId))
      .get();

    return row ? rowToPersistentRun(row) : undefined;
  }

  getRunByWorkSessionId(workSessionId: string): PersistentAcpRun | undefined {
    const row = this.database.db
      .select()
      .from(acpRuns)
      .where(eq(acpRuns.workSessionId, workSessionId))
      .orderBy(desc(acpRuns.createdAt))
      .limit(1)
      .get();

    return row ? rowToPersistentRun(row) : undefined;
  }

  listRuns(workspaceSessionId?: string, limit = 20): PersistentAcpRun[] {
    let query = this.database.db
      .select()
      .from(acpRuns)
      .orderBy(desc(acpRuns.createdAt))
      .limit(limit);

    if (workspaceSessionId) {
      query = query.where(eq(acpRuns.workspaceSessionId, workspaceSessionId)) as typeof query;
    }

    return query.all().map(rowToPersistentRun);
  }

  enqueueWebhook(runId: string, targetUrl: string, payload: unknown): void {
    const now = new Date().toISOString();
    this.database.db
      .insert(agentWebhookQueue)
      .values({
        id: `wh_${randomUUID()}`,
        runId,
        targetUrl,
        payloadJson: JSON.stringify(payload),
        status: "pending",
        retryCount: 0,
        maxRetries: 3,
        lastError: null,
        claimedBy: null,
        claimExpiresAt: null,
        createdAt: now,
        nextRetryAt: now,
      })
      .run();
  }

  processWebhooks(): Promise<number> {
    if (this.webhookRun) return this.webhookRun;
    const run = this.processWebhooksOnce();
    let trackedRun!: Promise<number>;
    trackedRun = run.finally(() => {
      if (this.webhookRun === trackedRun) this.webhookRun = undefined;
    });
    this.webhookRun = trackedRun;
    return trackedRun;
  }

  private async processWebhooksOnce(): Promise<number> {
    const now = new Date().toISOString();

    // Recover claims abandoned by a crashed worker. A live claim is never
    // handled by a second registry instance.
    this.database.sqlite.prepare(`
      update agent_webhook_queue
         set status = 'pending', claimed_by = null, claim_expires_at = null
       where status = 'processing' and claim_expires_at <= ?
    `).run(now);

    let delivered = 0;
    for (let index = 0; index < 10; index += 1) {
      const item = this.database.sqlite.transaction(() => {
        const candidate = this.database.sqlite.prepare(`
          select * from agent_webhook_queue
           where status = 'pending'
             and (next_retry_at is null or next_retry_at <= ?)
           order by created_at asc
           limit 1
        `).get(now) as AgentWebhookQueueRow | undefined;
        if (!candidate) return undefined;
        const claimUntil = new Date(Date.now() + 60_000).toISOString();
        const claimed = this.database.sqlite.prepare(`
          update agent_webhook_queue
             set status = 'processing', claimed_by = ?, claim_expires_at = ?
           where id = ? and status = 'pending'
        `).run(this.webhookWorkerId, claimUntil, candidate.id);
        return claimed.changes === 1 ? { ...candidate, status: "processing", claimedBy: this.webhookWorkerId, claimExpiresAt: claimUntil } : undefined;
      })();
      if (!item) break;

      // Raw `select *` returns snake_case columns; normalize the fields the
      // delivery loop reads. (Previously targetUrl/retryCount/maxRetries were
      // silently undefined — masked by tests whose fetch mock ignored them.)
      const raw = item as unknown as Record<string, unknown>;
      const targetUrl = (raw.target_url ?? raw.targetUrl ?? "") as string;
      if (!targetUrl) {
        throw new Error(`webhook queue row ${item.id} has no target_url`);
      }
      const retryCount = Number(raw.retry_count ?? raw.retryCount ?? 0);
      const maxRetries = Number(raw.max_retries ?? raw.maxRetries ?? 3);

      // Delivery-time revalidation: the CURRENT policy decides. A queued event
      // whose target was allowlisted at enqueue time but has since been
      // removed (or whose webhooks were disabled) is marked blocked_policy,
      // never delivered.
      const policyError = validateWebhookUrl(targetUrl, this.webhookPolicy);
      if (policyError) {
        this.database.db
          .update(agentWebhookQueue)
          .set({ status: "failed", lastError: `blocked_policy: ${policyError}`, claimedBy: null, claimExpiresAt: null })
          .where(and(eq(agentWebhookQueue.id, item.id), eq(agentWebhookQueue.status, "processing"), eq(agentWebhookQueue.claimedBy, this.webhookWorkerId)))
          .run();
        continue;
      }

      try {
        // redirect: "manual" — an allowed host must not be able to redirect
        // Kontrol to a destination that was never allowlisted. Any 3xx is
        // treated as an error (retried/failed like other non-OK responses).
        const response = await fetch(targetUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: item.payloadJson,
          redirect: "manual",
          signal: AbortSignal.timeout(10_000),
        });

        if (response.status >= 300 && response.status < 400) {
          throw new Error(`webhook redirects are not permitted by delivery policy (HTTP ${response.status})`);
        }
        if (response.ok) {
          this.database.db
            .update(agentWebhookQueue)
            .set({ status: "delivered", claimedBy: null, claimExpiresAt: null })
            .where(and(eq(agentWebhookQueue.id, item.id), eq(agentWebhookQueue.status, "processing"), eq(agentWebhookQueue.claimedBy, this.webhookWorkerId)))
            .run();
          delivered++;
        } else {
          throw new Error(`HTTP ${response.status}`);
        }
      } catch (error) {
        const nextRetryCount = retryCount + 1;
        let nextRetryAt: string | null = null;
        let finalStatus: "pending" | "failed" = "pending";
        const lastError = error instanceof Error ? error.message : String(error);

        if (nextRetryCount >= maxRetries) {
          finalStatus = "failed";
        } else {
          const delay = Math.pow(2, nextRetryCount) * 5_000;
          nextRetryAt = new Date(Date.now() + delay).toISOString();
        }

        this.database.db
          .update(agentWebhookQueue)
          .set({ retryCount: nextRetryCount, lastError, status: finalStatus, nextRetryAt, claimedBy: null, claimExpiresAt: null })
          .where(and(eq(agentWebhookQueue.id, item.id), eq(agentWebhookQueue.status, "processing"), eq(agentWebhookQueue.claimedBy, this.webhookWorkerId)))
          .run();
      }
    }

    // Webhook delivery is an integration aid, not immutable workflow history.
    // Retain terminal queue rows long enough for diagnosis, then compact them.
    const retentionCutoff = new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString();
    this.database.sqlite.prepare(`
      delete from agent_webhook_queue
       where status in ('delivered', 'failed') and created_at < ?
    `).run(retentionCutoff);

    return delivered;
  }

  // P1 #11: DB owned by server
  async drain(): Promise<void> {
    if (this.webhookTimer) clearInterval(this.webhookTimer);
    await this.webhookRun;
  }

  close(): void {
    if (this.webhookTimer) clearInterval(this.webhookTimer);
  }
}

function runUpdateValues(updates: Partial<PersistentAcpRun>): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  if (updates.status !== undefined) values.status = updates.status;
  if (updates.outputPreview !== undefined) values.outputPreview = updates.outputPreview;
  if (updates.outputJson !== undefined) values.outputJson = updates.outputJson;
  if (updates.errorMessage !== undefined) values.errorMessage = updates.errorMessage;
  if (updates.webhookDelivered !== undefined) values.webhookDelivered = updates.webhookDelivered ? 1 : 0;
  if (updates.finishedAt !== undefined) values.finishedAt = updates.finishedAt;
  if (updates.remoteRunId !== undefined) values.remoteRunId = updates.remoteRunId;
  if (updates.attemptNumber !== undefined) values.attemptNumber = updates.attemptNumber;
  if (updates.lastHeartbeatAt !== undefined) values.lastHeartbeatAt = updates.lastHeartbeatAt;
  if (Object.prototype.hasOwnProperty.call(updates, "workerLeaseUntil")) {
    values.workerLeaseUntil = updates.workerLeaseUntil ?? null;
  }
  return values;
}

function rowToAgentInfo(row: AgentRegistryRow): AgentInfo {
  const heartbeat = new Date(row.lastHeartbeat);
  const ttl = row.ttlSeconds * 1000;
  const alive = Date.now() - heartbeat.getTime() < ttl;

    return {
      id: row.id,
      name: row.name,
      url: row.url,
      description: row.description ?? undefined,
      publicKey: row.publicKey ?? undefined,
      capabilities: row.capabilitiesJson ? JSON.parse(row.capabilitiesJson) : [],
      tags: row.tags ? row.tags.split(",").filter(Boolean) : [],
      role: row.role ?? "agent",
      lastHeartbeat: row.lastHeartbeat,
      createdAt: row.createdAt,
      alive,
    };
}

function rowToPersistentRun(row: AcpRunRow): PersistentAcpRun {
  return {
    runId: row.runId,
    agentName: row.agentName,
    agentId: row.agentId ?? undefined,
    workspaceSessionId: row.workspaceSessionId ?? undefined,
    workSessionId: row.workSessionId ?? undefined,
    remoteRunId: row.remoteRunId ?? undefined,
    attemptNumber: row.attemptNumber ?? 1,
    status: row.status,
    inputPreview: row.inputPreview ?? undefined,
    outputPreview: row.outputPreview ?? undefined,
    outputJson: row.outputJson ?? undefined,
    errorMessage: row.errorMessage ?? undefined,
    webhookUrl: row.webhookUrl ?? undefined,
    webhookDelivered: row.webhookDelivered === 1,
    lastHeartbeatAt: row.lastHeartbeatAt ?? undefined,
    workerLeaseUntil: row.workerLeaseUntil ?? undefined,
    createdAt: row.createdAt,
    finishedAt: row.finishedAt ?? undefined,
  };
}
