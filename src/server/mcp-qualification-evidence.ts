import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  canonicalQualificationJson,
  type ExternalCatalogObservationRecord,
  type ValidatedExternalCatalogObservation,
} from "../qualification/external-catalog-capture.js";

export const MCP_QUALIFICATION_EVIDENCE_RETENTION_MS = 90 * 24 * 60 * 60_000;
const DEFAULT_QUERY_LIMIT = 200;
const MAX_QUERY_LIMIT = 500;
const MAX_RECORDS = 20_000;
const MAX_PRUNE_PER_WRITE = 250;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export interface CatalogAcknowledgementEvidence {
  recordId: string;
  recordType: "catalog_acknowledgement";
  captureId?: string;
  serverBuildId?: string;
  serverVersion: string;
  sessionIdSha256: string;
  observedAt: string;
  expiresAt: string;
  contentSha256: string;
  status: "accepted" | "rejected";
  serverCatalogSha256?: string;
  hostCatalogSha256?: string;
  toolCount?: number;
  rejectionReason?: string;
}

export interface ExternalSseEvidence {
  recordId: string;
  recordType: "external_sse";
  captureId?: string;
  serverBuildId?: string;
  serverVersion: string;
  sessionIdSha256: string;
  operationId: string;
  observedAt: string;
  expiresAt: string;
  contentSha256: string;
  httpMethod: string;
  rpcMethod: string;
  toolName: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  httpStatus: number;
  responseBytes: number;
  heartbeatBytes: number;
  responseCloseClassification: string;
  handlerStillRunning: boolean;
}

export type McpQualificationEvidenceRecord = CatalogAcknowledgementEvidence | ExternalSseEvidence;

export interface McpQualificationEvidenceFilter {
  serverBuildId?: string;
  captureId?: string;
  sessionIdSha256?: string;
  operationId?: string;
  limit?: number;
}

export interface QualificationEvidenceAssociation {
  recordId: string;
  serverBuildId: string;
  captureId: string;
  sessionIdSha256: string;
  soakId?: string;
  observationRecordId?: string;
  acknowledgementRecordId: string;
  externalSseRecordId?: string;
  createdAt: string;
  expiresAt: string;
  contentSha256: string;
}

export interface CatalogAcknowledgementInput {
  sessionId: string;
  captureId?: string;
  serverBuildId?: string;
  serverVersion: string;
  status: "accepted" | "rejected";
  serverCatalogSha256?: string;
  hostCatalogSha256?: string;
  toolCount?: number;
  rejectionReason?: string;
  observedAt?: string;
}

export interface CompletedSseOperationInput {
  operationId: string;
  qualificationCaptureId?: string;
  serverBuildId?: string;
  serverVersion?: string;
  sessionIdSha256?: string;
  httpMethod: string;
  rpcMethod?: string;
  toolName?: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  isSseResponse: boolean;
  httpStatus: number;
  responseBytes: number;
  heartbeatBytes: number;
  responseCloseClassification: string;
  handlerStillRunning: boolean;
}

interface RawEvidenceRow {
  record_id: string;
  record_type: "catalog_acknowledgement" | "external_sse";
  capture_id: string | null;
  server_build_id: string | null;
  server_version: string;
  session_id_sha256: string;
  operation_id: string | null;
  observed_at: string;
  expires_at: string;
  content_sha256: string;
  accepted: number | null;
  server_catalog_sha256: string | null;
  host_catalog_sha256: string | null;
  tool_count: number | null;
  rejection_reason: string | null;
  http_method: string | null;
  rpc_method: string | null;
  tool_name: string | null;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  http_status: number | null;
  response_bytes: number | null;
  heartbeat_bytes: number | null;
  response_close_classification: string | null;
  handler_still_running: number | null;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function optionalText(value: string | undefined, maxLength = 256): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length <= maxLength ? trimmed : undefined;
}

function sessionHash(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex");
}

/**
 * SQLite-backed, body-free records used by the external MCP qualification
 * probe. Session identifiers are hashed before they cross this boundary.
 */
export class McpQualificationEvidenceJournal {
  constructor(
    private readonly sqlite: Database.Database,
    private readonly options: { retentionMs?: number; maxRecords?: number } = {},
  ) {
    const retentionMs = options.retentionMs ?? MCP_QUALIFICATION_EVIDENCE_RETENTION_MS;
    const maxRecords = options.maxRecords ?? MAX_RECORDS;
    if (!Number.isSafeInteger(retentionMs) || retentionMs < 1) throw new Error("qualification evidence retention must be positive");
    if (!Number.isSafeInteger(maxRecords) || maxRecords < 1) throw new Error("qualification evidence record cap must be positive");
  }

  recordCatalogAcknowledgement(input: CatalogAcknowledgementInput): CatalogAcknowledgementEvidence {
    const now = input.observedAt && Number.isFinite(Date.parse(input.observedAt))
      ? Date.parse(input.observedAt)
      : Date.now();
    const recordId = randomUUID();
    const row = {
      recordId,
      recordType: "catalog_acknowledgement" as const,
      captureId: optionalText(input.captureId),
      serverBuildId: optionalText(input.serverBuildId),
      serverVersion: optionalText(input.serverVersion) ?? "unknown",
      sessionIdSha256: sessionHash(input.sessionId),
      observedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + (this.options.retentionMs ?? MCP_QUALIFICATION_EVIDENCE_RETENTION_MS)).toISOString(),
      status: input.status,
      ...(input.serverCatalogSha256 && SHA256_PATTERN.test(input.serverCatalogSha256)
        ? { serverCatalogSha256: input.serverCatalogSha256 }
        : {}),
      ...(input.hostCatalogSha256 && SHA256_PATTERN.test(input.hostCatalogSha256)
        ? { hostCatalogSha256: input.hostCatalogSha256 }
        : {}),
      ...(Number.isInteger(input.toolCount) && input.toolCount! >= 0 ? { toolCount: input.toolCount } : {}),
      ...(optionalText(input.rejectionReason) ? { rejectionReason: optionalText(input.rejectionReason) } : {}),
    };
    const evidence = { ...row, contentSha256: createHash("sha256").update(canonicalJson(row)).digest("hex") };
    this.insert(evidence);
    if (evidence.status === "accepted") this.recordAutomaticAssociationFor(evidence);
    return evidence;
  }

  recordCompletedSseOperation(input: CompletedSseOperationInput): ExternalSseEvidence | undefined {
    if (
      !input.isSseResponse
      || input.httpMethod !== "POST"
      || input.rpcMethod !== "tools/call"
      || input.toolName !== "await_workspace_events"
      || !input.serverVersion
      || !input.sessionIdSha256
      || !SHA256_PATTERN.test(input.sessionIdSha256)
    ) return undefined;

    const finishedAtMs = Date.parse(input.finishedAt);
    const startedAtMs = Date.parse(input.startedAt);
    if (!Number.isFinite(finishedAtMs) || !Number.isFinite(startedAtMs) || finishedAtMs < startedAtMs) return undefined;
    const recordId = randomUUID();
    const row = {
      recordId,
      recordType: "external_sse" as const,
      captureId: optionalText(input.qualificationCaptureId),
      serverBuildId: optionalText(input.serverBuildId),
      serverVersion: optionalText(input.serverVersion) ?? "unknown",
      sessionIdSha256: input.sessionIdSha256,
      operationId: input.operationId,
      observedAt: new Date(finishedAtMs).toISOString(),
      expiresAt: new Date(finishedAtMs + (this.options.retentionMs ?? MCP_QUALIFICATION_EVIDENCE_RETENTION_MS)).toISOString(),
      httpMethod: input.httpMethod,
      rpcMethod: input.rpcMethod,
      toolName: input.toolName,
      startedAt: new Date(startedAtMs).toISOString(),
      finishedAt: new Date(finishedAtMs).toISOString(),
      durationMs: Math.max(0, Math.trunc(input.durationMs)),
      httpStatus: Math.trunc(input.httpStatus),
      responseBytes: Math.max(0, Math.trunc(input.responseBytes)),
      heartbeatBytes: Math.max(0, Math.trunc(input.heartbeatBytes)),
      responseCloseClassification: optionalText(input.responseCloseClassification) ?? "unknown",
      handlerStillRunning: input.handlerStillRunning,
    };
    const evidence = { ...row, contentSha256: createHash("sha256").update(canonicalJson(row)).digest("hex") };
    this.insert(evidence);
    this.recordAutomaticAssociationFor(evidence);
    return evidence;
  }

  recordExternalCatalogObservation(input: ValidatedExternalCatalogObservation, attribution: {
    serverBuildId?: string;
    workSessionId?: string;
    handoffId?: string;
  } = {}): ExternalCatalogObservationRecord {
    const now = Date.parse(input.submittedAt);
    const recordId = randomUUID();
    const row = {
      ...input,
      recordId,
      ...(optionalText(attribution.serverBuildId) ? { serverBuildId: optionalText(attribution.serverBuildId) } : {}),
      ...(optionalText(attribution.workSessionId) ? { workSessionId: optionalText(attribution.workSessionId) } : {}),
      ...(optionalText(attribution.handoffId) ? { handoffId: optionalText(attribution.handoffId) } : {}),
      expiresAt: new Date(now + (this.options.retentionMs ?? MCP_QUALIFICATION_EVIDENCE_RETENTION_MS)).toISOString(),
    };
    const record = {
      ...row,
      contentSha256: createHash("sha256").update(canonicalQualificationJson(row)).digest("hex"),
    } as ExternalCatalogObservationRecord;
    this.sqlite.prepare(`
      insert into mcp_external_catalog_observations (
        record_id, capture_id, host_kind, server_build_id, server_version,
        session_id_sha256, captured_at, submitted_at, observation_source, status,
        server_catalog_sha256, host_catalog_sha256, host_tool_count, record_json,
        content_sha256, work_session_id, handoff_id, expires_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.recordId,
      record.captureId,
      record.hostKind,
      record.serverBuildId ?? null,
      record.serverVersion,
      record.sessionIdSha256,
      record.capturedAt,
      record.submittedAt,
      record.observationSource,
      record.status,
      record.serverCatalogSha256,
      record.hostCatalogSha256 ?? null,
      record.hostToolCount ?? null,
      JSON.stringify(record),
      record.contentSha256,
      record.workSessionId ?? null,
      record.handoffId ?? null,
      record.expiresAt,
    );
    this.pruneAuxiliaryTable("mcp_external_catalog_observations", record.submittedAt);
    return record;
  }

  listExternalCatalogObservations(filter: {
    serverBuildId?: string;
    captureId?: string;
    sessionIdSha256?: string;
    workSessionId?: string;
    handoffId?: string;
    limit?: number;
  } = {}): ExternalCatalogObservationRecord[] {
    const conditions = ["expires_at > ?"];
    const values: Array<string | number> = [new Date().toISOString()];
    for (const [key, column] of [
      ["serverBuildId", "server_build_id"],
      ["captureId", "capture_id"],
      ["sessionIdSha256", "session_id_sha256"],
      ["workSessionId", "work_session_id"],
      ["handoffId", "handoff_id"],
    ] as const) {
      const value = filter[key];
      if (!value) continue;
      if (key === "sessionIdSha256" && !SHA256_PATTERN.test(value)) return [];
      if (value.length > (key === "sessionIdSha256" ? 64 : 256)) return [];
      conditions.push(`${column} = ?`);
      values.push(value);
    }
    const requestedLimit = filter.limit ?? DEFAULT_QUERY_LIMIT;
    const limit = Number.isSafeInteger(requestedLimit) && requestedLimit > 0
      ? Math.min(MAX_QUERY_LIMIT, requestedLimit)
      : DEFAULT_QUERY_LIMIT;
    const rows = this.sqlite.prepare(`
      select record_json from mcp_external_catalog_observations
       where ${conditions.join(" and ")}
       order by submitted_at desc, record_id desc
       limit ?
    `).all(...values, limit) as Array<{ record_json: string }>;
    return rows.map((row) => JSON.parse(row.record_json) as ExternalCatalogObservationRecord);
  }

  getExternalCatalogObservation(recordId: string): ExternalCatalogObservationRecord | undefined {
    if (!recordId || recordId.length > 128) return undefined;
    const row = this.sqlite.prepare(`
      select record_json from mcp_external_catalog_observations
       where record_id = ? and expires_at > ?
    `).get(recordId, new Date().toISOString()) as { record_json: string } | undefined;
    return row ? JSON.parse(row.record_json) as ExternalCatalogObservationRecord : undefined;
  }

  recordQualificationAssociation(input: {
    serverBuildId: string;
    captureId: string;
    sessionIdSha256: string;
    soakId?: string;
    observationRecordId?: string;
    acknowledgementRecordId: string;
    externalSseRecordId?: string;
  }): QualificationEvidenceAssociation {
    if (!SHA256_PATTERN.test(input.sessionIdSha256)) throw new Error("Invalid qualification session hash");
    const now = new Date().toISOString();
    const ack = this.sqlite.prepare(`
      select record_id, record_type, capture_id, server_build_id, session_id_sha256, accepted
        from mcp_qualification_evidence
       where record_id = ? and expires_at > ?
    `).get(input.acknowledgementRecordId, now) as {
      record_id: string; record_type: string; capture_id: string | null; server_build_id: string | null;
      session_id_sha256: string; accepted: number | null;
    } | undefined;
    if (!ack || ack.record_type !== "catalog_acknowledgement" || ack.accepted !== 1
      || ack.capture_id !== input.captureId || ack.server_build_id !== input.serverBuildId
      || ack.session_id_sha256 !== input.sessionIdSha256) {
      throw new Error("Qualification acknowledgement does not match the build, capture, session, and accepted state");
    }
    if (input.externalSseRecordId) {
      const sse = this.sqlite.prepare(`
        select record_id, record_type, capture_id, server_build_id, session_id_sha256
          from mcp_qualification_evidence
         where record_id = ? and expires_at > ?
      `).get(input.externalSseRecordId, now) as {
        record_id: string; record_type: string; capture_id: string | null; server_build_id: string | null;
        session_id_sha256: string;
      } | undefined;
      if (!sse || sse.record_type !== "external_sse" || sse.capture_id !== input.captureId
        || sse.server_build_id !== input.serverBuildId || sse.session_id_sha256 !== input.sessionIdSha256) {
        throw new Error("Qualification SSE evidence does not match the build, capture, and session");
      }
    }
    if (input.observationRecordId) {
      const observation = this.getExternalCatalogObservation(input.observationRecordId);
      if (!observation || observation.captureId !== input.captureId || observation.serverBuildId !== input.serverBuildId
        || observation.sessionIdSha256 !== input.sessionIdSha256) {
        throw new Error("External catalog observation does not match the build, capture, and session");
      }
    }
    const existing = this.sqlite.prepare(`
      select record_id as recordId, server_build_id as serverBuildId,
             capture_id as captureId, session_id_sha256 as sessionIdSha256,
             soak_id as soakId, observation_record_id as observationRecordId,
             acknowledgement_record_id as acknowledgementRecordId,
             external_sse_record_id as externalSseRecordId,
             created_at as createdAt, expires_at as expiresAt,
             content_sha256 as contentSha256
        from mcp_qualification_associations
       where server_build_id = ? and capture_id = ? and session_id_sha256 = ?
         and acknowledgement_record_id = ?
         and ifnull(external_sse_record_id, '') = ifnull(?, '')
         and ifnull(observation_record_id, '') = ifnull(?, '')
         and ifnull(soak_id, '') = ifnull(?, '')
         and expires_at > ?
       limit 1
    `).get(
      input.serverBuildId,
      input.captureId,
      input.sessionIdSha256,
      input.acknowledgementRecordId,
      input.externalSseRecordId ?? null,
      input.observationRecordId ?? null,
      input.soakId ?? null,
      now,
    ) as QualificationEvidenceAssociation | undefined;
    if (existing) return existing;
    const recordId = randomUUID();
    const expiresAt = new Date(Date.now() + (this.options.retentionMs ?? MCP_QUALIFICATION_EVIDENCE_RETENTION_MS)).toISOString();
    const row = {
      recordId,
      serverBuildId: input.serverBuildId,
      captureId: input.captureId,
      sessionIdSha256: input.sessionIdSha256,
      ...(optionalText(input.soakId) ? { soakId: optionalText(input.soakId) } : {}),
      ...(input.observationRecordId ? { observationRecordId: input.observationRecordId } : {}),
      acknowledgementRecordId: input.acknowledgementRecordId,
      ...(input.externalSseRecordId ? { externalSseRecordId: input.externalSseRecordId } : {}),
      createdAt: now,
      expiresAt,
    };
    const contentSha256 = createHash("sha256").update(canonicalQualificationJson(row)).digest("hex");
    const association = { ...row, contentSha256 };
    this.sqlite.prepare(`
      insert into mcp_qualification_associations (
        record_id, server_build_id, capture_id, session_id_sha256, soak_id,
        observation_record_id, acknowledgement_record_id, external_sse_record_id,
        created_at, content_sha256, expires_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      association.recordId,
      association.serverBuildId,
      association.captureId,
      association.sessionIdSha256,
      association.soakId ?? null,
      association.observationRecordId ?? null,
      association.acknowledgementRecordId,
      association.externalSseRecordId ?? null,
      association.createdAt,
      association.contentSha256,
      association.expiresAt,
    );
    this.pruneAuxiliaryTable("mcp_qualification_associations", association.createdAt);
    return association;
  }

  listQualificationAssociations(filter: {
    serverBuildId?: string;
    captureId?: string;
    sessionIdSha256?: string;
    soakId?: string;
    limit?: number;
  } = {}): QualificationEvidenceAssociation[] {
    const conditions = ["expires_at > ?"];
    const values: Array<string | number> = [new Date().toISOString()];
    for (const [key, column] of [
      ["serverBuildId", "server_build_id"],
      ["captureId", "capture_id"],
      ["sessionIdSha256", "session_id_sha256"],
      ["soakId", "soak_id"],
    ] as const) {
      const value = filter[key];
      if (!value) continue;
      if (key === "sessionIdSha256" && !SHA256_PATTERN.test(value)) return [];
      if (value.length > (key === "sessionIdSha256" ? 64 : 256)) return [];
      conditions.push(`${column} = ?`);
      values.push(value);
    }
    const requestedLimit = filter.limit ?? DEFAULT_QUERY_LIMIT;
    const limit = Number.isSafeInteger(requestedLimit) && requestedLimit > 0
      ? Math.min(MAX_QUERY_LIMIT, requestedLimit)
      : DEFAULT_QUERY_LIMIT;
    const rows = this.sqlite.prepare(`
      select record_id as recordId, server_build_id as serverBuildId,
             capture_id as captureId, session_id_sha256 as sessionIdSha256,
             soak_id as soakId, observation_record_id as observationRecordId,
             acknowledgement_record_id as acknowledgementRecordId,
             external_sse_record_id as externalSseRecordId,
             created_at as createdAt, expires_at as expiresAt,
             content_sha256 as contentSha256
        from mcp_qualification_associations
       where ${conditions.join(" and ")}
       order by created_at desc, record_id desc
       limit ?
    `).all(...values, limit) as Array<QualificationEvidenceAssociation & {
      soakId: string | null;
      observationRecordId: string | null;
      externalSseRecordId: string | null;
    }>;
    return rows.map(({ soakId, observationRecordId, externalSseRecordId, ...row }) => ({
      ...row,
      ...(soakId ? { soakId } : {}),
      ...(observationRecordId ? { observationRecordId } : {}),
      ...(externalSseRecordId ? { externalSseRecordId } : {}),
    }));
  }

  attachObservationToHandoff(input: {
    observationRecordId: string;
    workSessionId: string;
    handoffId: string;
    reviewerPrincipalId: string;
    reviewerOwnerContextId: string;
    investigationDirection: string;
  }): {
    attachmentId: string;
    observationRecordId: string;
    workSessionId: string;
    handoffId: string;
    reviewerPrincipalId: string;
    reviewerOwnerContextId: string;
    investigationDirection: string;
    attachedAt: string;
    expiresAt: string;
    contentSha256: string;
  } {
    const observation = this.sqlite.prepare(`
      select record_id, work_session_id, handoff_id from mcp_external_catalog_observations
       where record_id = ? and expires_at > ?
    `).get(input.observationRecordId, new Date().toISOString()) as {
      record_id: string;
      work_session_id: string | null;
      handoff_id: string | null;
    } | undefined;
    if (!observation) throw new Error("External catalog observation is missing or expired");
    if (observation.work_session_id !== input.workSessionId || observation.handoff_id !== input.handoffId) {
      throw new Error("External catalog observation attribution does not match the target handoff");
    }
    const attachedAt = new Date().toISOString();
    const attachmentId = randomUUID();
    const row = {
      attachmentId,
      observationRecordId: input.observationRecordId,
      workSessionId: input.workSessionId,
      handoffId: input.handoffId,
      reviewerPrincipalId: input.reviewerPrincipalId,
      reviewerOwnerContextId: input.reviewerOwnerContextId,
      investigationDirection: input.investigationDirection,
      attachedAt,
      expiresAt: new Date(Date.parse(attachedAt) + (this.options.retentionMs ?? MCP_QUALIFICATION_EVIDENCE_RETENTION_MS)).toISOString(),
    };
    const contentSha256 = createHash("sha256").update(canonicalQualificationJson(row)).digest("hex");
    const record = { ...row, contentSha256 };
    this.sqlite.prepare(`
      insert into review_handoff_external_catalog_attachments (
        attachment_id, observation_record_id, work_session_id, handoff_id,
        reviewer_principal_id, reviewer_owner_context_id, investigation_direction,
        attached_at, content_sha256, expires_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.attachmentId,
      record.observationRecordId,
      record.workSessionId,
      record.handoffId,
      record.reviewerPrincipalId,
      record.reviewerOwnerContextId,
      record.investigationDirection,
      record.attachedAt,
      record.contentSha256,
      record.expiresAt,
    );
    this.pruneAuxiliaryTable("review_handoff_external_catalog_attachments", record.attachedAt);
    return record;
  }

  listHandoffObservationAttachments(handoffId: string): Array<{
    attachmentId: string;
    observationRecordId: string;
    workSessionId: string;
    handoffId: string;
    reviewerPrincipalId: string;
    reviewerOwnerContextId: string;
    investigationDirection: string;
    attachedAt: string;
    expiresAt: string;
    contentSha256: string;
  }> {
    return this.sqlite.prepare(`
      select attachment_id as attachmentId,
             observation_record_id as observationRecordId,
             work_session_id as workSessionId,
             handoff_id as handoffId,
             reviewer_principal_id as reviewerPrincipalId,
             reviewer_owner_context_id as reviewerOwnerContextId,
             investigation_direction as investigationDirection,
             attached_at as attachedAt,
             expires_at as expiresAt,
             content_sha256 as contentSha256
        from review_handoff_external_catalog_attachments
       where handoff_id = ? and expires_at > ?
       order by attached_at, attachment_id
       limit ?
    `).all(handoffId, new Date().toISOString(), MAX_QUERY_LIMIT) as Array<{
      attachmentId: string;
      observationRecordId: string;
      workSessionId: string;
      handoffId: string;
      reviewerPrincipalId: string;
      reviewerOwnerContextId: string;
      investigationDirection: string;
      attachedAt: string;
      expiresAt: string;
      contentSha256: string;
    }>;
  }

  listRecent(filter: McpQualificationEvidenceFilter = {}): McpQualificationEvidenceRecord[] {
    const conditions = ["expires_at > ?"];
    const values: Array<string | number> = [new Date().toISOString()];
    if (filter.serverBuildId) {
      conditions.push("server_build_id = ?");
      values.push(filter.serverBuildId);
    }
    if (filter.captureId) {
      conditions.push("capture_id = ?");
      values.push(filter.captureId);
    }
    if (filter.sessionIdSha256) {
      if (!SHA256_PATTERN.test(filter.sessionIdSha256)) return [];
      conditions.push("session_id_sha256 = ?");
      values.push(filter.sessionIdSha256);
    }
    if (filter.operationId) {
      conditions.push("operation_id = ?");
      values.push(filter.operationId);
    }
    const requestedLimit = filter.limit ?? DEFAULT_QUERY_LIMIT;
    const limit = Number.isSafeInteger(requestedLimit) && requestedLimit > 0
      ? Math.min(MAX_QUERY_LIMIT, requestedLimit)
      : DEFAULT_QUERY_LIMIT;
    const rows = this.sqlite.prepare(`
      select * from mcp_qualification_evidence
       where ${conditions.join(" and ")}
       order by observed_at desc, record_id desc
       limit ?
    `).all(...values, limit) as RawEvidenceRow[];
    return rows.map(toEvidenceRecord);
  }

  private insert(evidence: McpQualificationEvidenceRecord): void {
    const ack = evidence.recordType === "catalog_acknowledgement" ? evidence : undefined;
    const stream = evidence.recordType === "external_sse" ? evidence : undefined;
    this.sqlite.prepare(`
      insert into mcp_qualification_evidence (
        record_id, record_type, capture_id, server_build_id, server_version,
        session_id_sha256, operation_id, observed_at, expires_at, content_sha256,
        accepted, server_catalog_sha256, host_catalog_sha256, tool_count, rejection_reason,
        http_method, rpc_method, tool_name, started_at, finished_at, duration_ms,
        http_status, response_bytes, heartbeat_bytes, response_close_classification,
        handler_still_running
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      evidence.recordId,
      evidence.recordType,
      evidence.captureId ?? null,
      evidence.serverBuildId ?? null,
      evidence.serverVersion,
      evidence.sessionIdSha256,
      stream?.operationId ?? null,
      evidence.observedAt,
      evidence.expiresAt,
      evidence.contentSha256,
      ack ? Number(ack.status === "accepted") : null,
      ack?.serverCatalogSha256 ?? null,
      ack?.hostCatalogSha256 ?? null,
      ack?.toolCount ?? null,
      ack?.rejectionReason ?? null,
      stream?.httpMethod ?? null,
      stream?.rpcMethod ?? null,
      stream?.toolName ?? null,
      stream?.startedAt ?? null,
      stream?.finishedAt ?? null,
      stream?.durationMs ?? null,
      stream?.httpStatus ?? null,
      stream?.responseBytes ?? null,
      stream?.heartbeatBytes ?? null,
      stream?.responseCloseClassification ?? null,
      stream ? Number(stream.handlerStillRunning) : null,
    );
    this.prune(evidence.observedAt);
  }

  private recordAutomaticAssociationFor(evidence: McpQualificationEvidenceRecord): void {
    if (!evidence.captureId || !evidence.serverBuildId) return;
    const records = this.listRecent({
      serverBuildId: evidence.serverBuildId,
      captureId: evidence.captureId,
      sessionIdSha256: evidence.sessionIdSha256,
      limit: MAX_QUERY_LIMIT,
    });
    const acknowledgement = records.find((record) => record.recordType === "catalog_acknowledgement" && record.status === "accepted");
    const stream = records.find((record) => record.recordType === "external_sse");
    if (!acknowledgement) return;
    this.recordQualificationAssociation({
      serverBuildId: evidence.serverBuildId,
      captureId: evidence.captureId,
      sessionIdSha256: evidence.sessionIdSha256,
      acknowledgementRecordId: acknowledgement.recordId,
      ...(stream ? { externalSseRecordId: stream.recordId } : {}),
    });
  }

  private prune(now: string): void {
    const pageLimit = Math.min(MAX_PRUNE_PER_WRITE, this.options.maxRecords ?? MAX_RECORDS);
    this.sqlite.prepare(`
      delete from mcp_qualification_evidence
       where record_id in (
         select record_id from mcp_qualification_evidence
          where expires_at <= ?
          order by expires_at, record_id
          limit ?
       )
    `).run(now, pageLimit);
    const count = this.sqlite.prepare("select count(*) as count from mcp_qualification_evidence").get() as { count: number };
    const excess = Math.min(pageLimit, Math.max(0, count.count - (this.options.maxRecords ?? MAX_RECORDS)));
    if (excess === 0) return;
    this.sqlite.prepare(`
      delete from mcp_qualification_evidence
       where record_id in (
         select record_id from mcp_qualification_evidence
          order by observed_at, record_id
          limit ?
       )
    `).run(excess);
  }

  private pruneAuxiliaryTable(
    table: "mcp_external_catalog_observations" | "review_handoff_external_catalog_attachments" | "mcp_qualification_associations",
    now: string,
  ): void {
    const pageLimit = Math.min(MAX_PRUNE_PER_WRITE, this.options.maxRecords ?? MAX_RECORDS);
    const createdAtColumn = table === "mcp_external_catalog_observations"
      ? "submitted_at"
      : table === "review_handoff_external_catalog_attachments"
        ? "attached_at"
        : "created_at";
    this.sqlite.prepare(`
      delete from ${table}
       where rowid in (
         select rowid from ${table}
          where expires_at <= ?
          order by expires_at, rowid
          limit ?
       )
    `).run(now, pageLimit);
    const count = this.sqlite.prepare(`select count(*) as count from ${table}`).get() as { count: number };
    const excess = Math.min(pageLimit, Math.max(0, count.count - (this.options.maxRecords ?? MAX_RECORDS)));
    if (excess > 0) {
      this.sqlite.prepare(`
        delete from ${table}
         where rowid in (
           select rowid from ${table}
            order by ${createdAtColumn}, rowid
            limit ?
         )
      `).run(excess);
    }
  }
}

function toEvidenceRecord(row: RawEvidenceRow): McpQualificationEvidenceRecord {
  const common = {
    recordId: row.record_id,
    recordType: row.record_type,
    ...(row.capture_id ? { captureId: row.capture_id } : {}),
    ...(row.server_build_id ? { serverBuildId: row.server_build_id } : {}),
    serverVersion: row.server_version,
    sessionIdSha256: row.session_id_sha256,
    observedAt: row.observed_at,
    expiresAt: row.expires_at,
    contentSha256: row.content_sha256,
  };
  if (row.record_type === "catalog_acknowledgement") {
    return {
      ...common,
      recordType: "catalog_acknowledgement",
      status: row.accepted === 1 ? "accepted" : "rejected",
      ...(row.server_catalog_sha256 ? { serverCatalogSha256: row.server_catalog_sha256 } : {}),
      ...(row.host_catalog_sha256 ? { hostCatalogSha256: row.host_catalog_sha256 } : {}),
      ...(row.tool_count !== null ? { toolCount: row.tool_count } : {}),
      ...(row.rejection_reason ? { rejectionReason: row.rejection_reason } : {}),
    };
  }
  return {
    ...common,
    recordType: "external_sse",
    operationId: row.operation_id ?? "",
    httpMethod: row.http_method ?? "",
    rpcMethod: row.rpc_method ?? "",
    toolName: row.tool_name ?? "",
    startedAt: row.started_at ?? "",
    finishedAt: row.finished_at ?? "",
    durationMs: row.duration_ms ?? 0,
    httpStatus: row.http_status ?? 0,
    responseBytes: row.response_bytes ?? 0,
    heartbeatBytes: row.heartbeat_bytes ?? 0,
    responseCloseClassification: row.response_close_classification ?? "unknown",
    handlerStillRunning: row.handler_still_running === 1,
  };
}
