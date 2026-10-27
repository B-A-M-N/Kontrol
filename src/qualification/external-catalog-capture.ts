import { createHash } from "node:crypto";
import { z } from "zod/v4";

export const EXTERNAL_CATALOG_OBSERVATION_CONTRACT_VERSION = 1 as const;
export const EXTERNAL_CATALOG_OBSERVATION_MAX_BYTES = 1_000_000;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const toolDescriptorSchema = z.record(z.string(), z.unknown());

export const ExternalCatalogObservationSubmissionSchema = z.object({
  contractVersion: z.literal(EXTERNAL_CATALOG_OBSERVATION_CONTRACT_VERSION),
  captureId: z.string().min(1).max(256).regex(/^[A-Za-z0-9._:-]+$/),
  capturedAt: z.string().datetime({ offset: true }),
  hostKind: z.string().trim().min(1).max(128),
  serverVersion: z.string().min(1).max(256),
  sessionIdSha256: sha256Schema,
  soakId: z.string().min(1).max(256).optional(),
  streamingOperationId: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/).optional(),
  initializeResult: z.record(z.string(), z.unknown()),
  toolsListResult: z.object({ tools: z.array(toolDescriptorSchema).max(512) }).strict(),
  registeredCatalog: z.union([
    z.array(toolDescriptorSchema).max(512),
    z.object({ tools: z.array(toolDescriptorSchema).max(512) }).strict(),
  ]).optional(),
  acknowledgement: z.object({
    method: z.literal("notifications/experimental/kontrol/tool-catalog-accepted"),
    contractVersion: z.literal(1),
    captureId: z.string().min(1).max(256),
    serverVersion: z.string().min(1).max(256),
    hostCatalogSha256: sha256Schema,
    hostToolCount: z.number().int().nonnegative().max(512),
  }).strict().optional(),
  transport: z.record(z.string(), z.unknown()).optional(),
  streamingCall: z.object({
    toolName: z.literal("await_workspace_events"),
    operationId: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/),
    requestedWaitMs: z.number().int().min(1).max(120_000),
    startedAt: z.string().datetime({ offset: true }),
    finishedAt: z.string().datetime({ offset: true }),
    terminalResultReceived: z.boolean(),
    captureId: z.string().min(1).max(256).optional(),
  }).strict().optional(),
}).strict();

export type ExternalCatalogObservationSubmission = z.infer<typeof ExternalCatalogObservationSubmissionSchema>;

export type ExternalCatalogObservationStatus =
  | "host_capture_unsupported"
  | "operator_reported_match"
  | "operator_reported_mismatch";

export interface ValidatedExternalCatalogObservation {
  contractVersion: typeof EXTERNAL_CATALOG_OBSERVATION_CONTRACT_VERSION;
  captureId: string;
  capturedAt: string;
  submittedAt: string;
  hostKind: string;
  serverVersion: string;
  sessionIdSha256: string;
  soakId?: string;
  streamingOperationId?: string;
  initializeResult: Record<string, unknown>;
  toolsListResult: { tools: Array<Record<string, unknown>> };
  registeredCatalog?: Array<Record<string, unknown>>;
  serverCatalogSha256: string;
  hostCatalogSha256?: string;
  hostToolCount?: number;
  acknowledgement?: ExternalCatalogObservationSubmission["acknowledgement"];
  transport?: Record<string, unknown>;
  streamingCall?: ExternalCatalogObservationSubmission["streamingCall"];
  observationSource: "operator_reported";
  status: ExternalCatalogObservationStatus;
  validationReasons: string[];
}

export interface ExternalCatalogObservationRecord extends ValidatedExternalCatalogObservation {
  recordId: string;
  serverBuildId?: string;
  expiresAt: string;
  contentSha256: string;
  workSessionId?: string;
  handoffId?: string;
}

export class ExternalCatalogObservationError extends Error {
  constructor(readonly code: "invalid_observation" | "host_capture_unsupported", message: string) {
    super(message);
    this.name = "ExternalCatalogObservationError";
  }
}

export function canonicalQualificationJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalQualificationJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalQualificationJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function fingerprintExternalToolCatalog(tools: unknown): { sha256: string; toolCount: number } | undefined {
  if (!Array.isArray(tools)) return undefined;
  const descriptors = tools as Array<Record<string, unknown>>;
  if (descriptors.some((tool) => typeof tool?.name !== "string" || tool.name.length === 0)) return undefined;
  const sorted = [...descriptors].sort((a, b) => String(a.name).localeCompare(String(b.name)));
  if (new Set(sorted.map((tool) => tool.name)).size !== sorted.length) return undefined;
  return {
    sha256: createHash("sha256").update(canonicalQualificationJson(sorted)).digest("hex"),
    toolCount: sorted.length,
  };
}

function initializeServerVersion(value: Record<string, unknown>): string | undefined {
  const direct = value.serverInfo;
  if (direct && typeof direct === "object" && !Array.isArray(direct)) {
    const version = (direct as Record<string, unknown>).version;
    if (typeof version === "string") return version;
  }
  return undefined;
}

export function validateExternalCatalogObservation(
  value: unknown,
  submittedAt = new Date().toISOString(),
): ValidatedExternalCatalogObservation {
  const parsed = ExternalCatalogObservationSubmissionSchema.safeParse(value);
  if (!parsed.success) {
    throw new ExternalCatalogObservationError("invalid_observation", parsed.error.issues[0]?.message ?? "Invalid external catalog observation");
  }
  const observation = parsed.data;
  const inputBytes = Buffer.byteLength(canonicalQualificationJson(observation), "utf8");
  if (inputBytes > EXTERNAL_CATALOG_OBSERVATION_MAX_BYTES) {
    throw new ExternalCatalogObservationError("invalid_observation", `External catalog observation exceeds ${EXTERNAL_CATALOG_OBSERVATION_MAX_BYTES} bytes`);
  }
  if (initializeServerVersion(observation.initializeResult) !== observation.serverVersion) {
    throw new ExternalCatalogObservationError("invalid_observation", "initializeResult.serverInfo.version must match serverVersion");
  }
  const serverCatalog = fingerprintExternalToolCatalog(observation.toolsListResult.tools);
  if (!serverCatalog) throw new ExternalCatalogObservationError("invalid_observation", "toolsListResult must contain unique, named tool descriptors");
  const registeredTools = Array.isArray(observation.registeredCatalog)
    ? observation.registeredCatalog
    : observation.registeredCatalog?.tools;
  const hostCatalog = registeredTools ? fingerprintExternalToolCatalog(registeredTools) : undefined;
  if (registeredTools && !hostCatalog) {
    throw new ExternalCatalogObservationError("invalid_observation", "registeredCatalog must contain unique, named tool descriptors");
  }
  const reasons: string[] = [];
  if (!registeredTools) reasons.push("host_capture_unsupported");
  else if (hostCatalog?.sha256 !== serverCatalog.sha256) reasons.push("registered_catalog_mismatch");
  if (observation.acknowledgement) {
    if (observation.acknowledgement.captureId !== observation.captureId) reasons.push("acknowledgement_capture_mismatch");
    if (observation.acknowledgement.serverVersion !== observation.serverVersion) reasons.push("acknowledgement_version_mismatch");
    if (observation.acknowledgement.hostCatalogSha256 !== hostCatalog?.sha256) reasons.push("acknowledgement_catalog_mismatch");
    if (observation.acknowledgement.hostToolCount !== hostCatalog?.toolCount) reasons.push("acknowledgement_tool_count_mismatch");
  } else {
    reasons.push("host_acknowledgement_missing");
  }
  const unsupported = !registeredTools;
  const matched = !unsupported && reasons.length === 0;
  return {
    contractVersion: EXTERNAL_CATALOG_OBSERVATION_CONTRACT_VERSION,
    captureId: observation.captureId,
    capturedAt: observation.capturedAt,
    submittedAt,
    hostKind: observation.hostKind,
    serverVersion: observation.serverVersion,
    sessionIdSha256: observation.sessionIdSha256,
    ...(observation.soakId ? { soakId: observation.soakId } : {}),
    ...(observation.streamingOperationId ? { streamingOperationId: observation.streamingOperationId } : {}),
    initializeResult: observation.initializeResult,
    toolsListResult: observation.toolsListResult,
    ...(registeredTools ? { registeredCatalog: registeredTools } : {}),
    serverCatalogSha256: serverCatalog.sha256,
    ...(hostCatalog ? { hostCatalogSha256: hostCatalog.sha256, hostToolCount: hostCatalog.toolCount } : {}),
    ...(observation.acknowledgement ? { acknowledgement: observation.acknowledgement } : {}),
    ...(observation.transport ? { transport: observation.transport } : {}),
    ...(observation.streamingCall ? { streamingCall: observation.streamingCall } : {}),
    observationSource: "operator_reported",
    status: unsupported ? "host_capture_unsupported" : matched ? "operator_reported_match" : "operator_reported_mismatch",
    validationReasons: reasons,
  };
}
