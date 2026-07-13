import { randomUUID } from "node:crypto";
import { eq, and, lt, desc, sql } from "drizzle-orm";
import { openDatabase, type DatabaseHandle } from "./db/client.js";
import {
  agentRegistry,
  acpRuns,
  agentWebhookQueue,
  type AgentRegistryRow,
  type AcpRunRow,
  type AgentWebhookQueueRow,
} from "./db/schema.js";

export interface AgentRegistration {
  name: string;
  url: string;
  description?: string;
  publicKey?: string;
  capabilities?: string[];
  tags?: string[];
  role?: "agent" | "client" | string;
  ttlSeconds?: number;
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
  register(registration: AgentRegistration): AgentInfo;
  ensure(registration: AgentRegistration): AgentInfo;
  unregister(id: string): void;
  heartbeat(id: string): void;
  get(id: string): AgentInfo | undefined;
  listAlive(): AgentInfo[];
  listAll(): AgentInfo[];
  pruneExpired(): number;
  createRun(input: {
    agentName: string;
    workspaceSessionId?: string;
    workSessionId?: string;
    inputPreview?: string;
    webhookUrl?: string;
    status?: string;
    remoteRunId?: string;
    attemptNumber?: number;
  }): PersistentAcpRun;
  updateRun(runId: string, updates: Partial<PersistentAcpRun>): void;
  getRun(runId: string): PersistentAcpRun | undefined;
  getRunByWorkSessionId(workSessionId: string): PersistentAcpRun | undefined;
  listRuns(workspaceSessionId?: string, limit?: number): PersistentAcpRun[];
  enqueueWebhook(runId: string, targetUrl: string, payload: unknown): void;
  processWebhooks(): Promise<number>;
  close(): void;
}

export function createAgentRegistryManager(
  stateDirOrHandle: string | DatabaseHandle,
): AgentRegistryManager {
  const database =
    typeof stateDirOrHandle === "string" ? openDatabase(stateDirOrHandle) : stateDirOrHandle;
  return new SqliteAgentRegistryManager(database);
}

class SqliteAgentRegistryManager implements AgentRegistryManager {
  private readonly database: DatabaseHandle;
  private webhookTimer?: ReturnType<typeof setInterval>;

  constructor(database: DatabaseHandle) {
    this.database = database;
    this.pruneExpired();
    this.webhookTimer = setInterval(() => {
      this.processWebhooks().catch(() => {});
    }, 10_000);
  }

  register(registration: AgentRegistration): AgentInfo {
    const now = new Date().toISOString();
    const id = `agent_${randomUUID()}`;
    // A logical agent name maps to ONE current endpoint. Re-registering the same
    // name (e.g. a corrected URL) must replace the stale entry, not create a
    // duplicate. Without this, two `cli-coding-agent` rows (9876 + 9877) coexist
    // and name-based dispatch grabs the first — often the broken one.
    this.database.db
      .delete(agentRegistry)
      .where(eq(agentRegistry.name, registration.name))
      .run();
    this.database.db
      .insert(agentRegistry)
      .values({
        id,
        name: registration.name,
        url: registration.url,
        description: registration.description ?? null,
        publicKey: registration.publicKey ?? null,
        capabilitiesJson: registration.capabilities ? JSON.stringify(registration.capabilities) : null,
        tags: registration.tags?.join(",") ?? null,
        role: registration.role ?? "agent",
        lastHeartbeat: now,
        createdAt: now,
        ttlSeconds: registration.ttlSeconds ?? 60,
      })
      .run();

    return this.get(id)!;
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

  heartbeat(id: string): void {
    const now = new Date().toISOString();
    this.database.db
      .update(agentRegistry)
      .set({ lastHeartbeat: now })
      .where(eq(agentRegistry.id, id))
      .run();
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
        createdAt: now,
        nextRetryAt: now,
      })
      .run();
  }

  async processWebhooks(): Promise<number> {
    const now = new Date().toISOString();
    const pending = this.database.db
      .select()
      .from(agentWebhookQueue)
      .where(
        and(
          eq(agentWebhookQueue.status, "pending"),
          sql`${agentWebhookQueue.nextRetryAt} <= ${now}`,
        ),
      )
      .limit(10)
      .all();

    let delivered = 0;
    for (const item of pending) {
      try {
        const response = await fetch(item.targetUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: item.payloadJson,
          signal: AbortSignal.timeout(10_000),
        });

        if (response.ok) {
          this.database.db
            .update(agentWebhookQueue)
            .set({ status: "delivered" })
            .where(eq(agentWebhookQueue.id, item.id))
            .run();
          delivered++;
        } else {
          throw new Error(`HTTP ${response.status}`);
        }
      } catch (error) {
        const retryCount = item.retryCount + 1;
        const updates: Record<string, unknown> = {
          retryCount,
          lastError: error instanceof Error ? error.message : String(error),
        };

        if (retryCount >= item.maxRetries) {
          updates.status = "failed";
        } else {
          const delay = Math.pow(2, retryCount) * 5_000;
          updates.nextRetryAt = new Date(Date.now() + delay).toISOString();
        }

        this.database.db
          .update(agentWebhookQueue)
          .set(updates)
          .where(eq(agentWebhookQueue.id, item.id))
          .run();
      }
    }

    return delivered;
  }

  close(): void {
    if (this.webhookTimer) clearInterval(this.webhookTimer);
    this.database.close();
  }
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
