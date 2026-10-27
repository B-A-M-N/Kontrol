/**
 * Durable, bounded ingress qualification observations.
 *
 * This is an evidence store, not a supervisor command channel: recording a
 * profile failure never restarts or mutates the Kontrol runtime. Probe callers
 * must supply already-redacted results; response bodies and credentials are
 * intentionally not part of the schema.
 */
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { syncDirectory } from "../fs-durability.js";
import { join } from "node:path";
import { isIngressEvidenceTier, type IngressEvidenceTier } from "./evidence-tier.js";

export type IngressHealthState = "DOWN" | "DEGRADED" | "UNVERIFIED" | "READY";
// The tier vocabulary is owned by evidence-tier.ts so the health store, the
// management projection, and the qualification matrix cannot drift apart.
export type { IngressEvidenceTier } from "./evidence-tier.js";

export interface IngressHealthObservation {
  observationId: string;
  profileId: string;
  listener: string;
  buildId: string;
  probeOrigin: string;
  principalClass: "owner_public" | "peer" | "none";
  state: IngressHealthState;
  evidenceTier: IngressEvidenceTier;
  observedAt: string;
  checks: {
    daemon?: boolean;
    mapping?: boolean;
    localListener?: boolean;
    externalHttps?: boolean;
    oauthChallenge?: boolean;
    mcpInitialize?: boolean;
    toolsList?: boolean;
    sse?: boolean;
    longPost?: boolean;
    freshInitialize?: boolean;
  };
  metrics?: {
    latencyMs?: number;
    failures?: number;
    reconnects?: number;
    maxHeartbeatGapMs?: number;
    /**
     * The server's OWN record of the correlated operation, when the probe
     * could reach the authenticated diagnostics boundary. The identifiers
     * and counters are bounded and carry no project content.
     */
    serverEvidenceRecordId?: string;
    serverEvidenceContentSha256?: string;
    serverEvidenceHeartbeatBytes?: number;
    serverEvidenceResponseBytes?: number;
    serverEvidenceCloseClassification?: string;
    serverEvidenceServerBuildId?: string;
  };
  operationId?: string;
  sessionIdentityHash?: string;
  failureClass?: string;
}

interface HealthStore { version: 1; observations: IngressHealthObservation[] }
const STORE_NAME = "ingress-health.json";
const MAX_OBSERVATIONS = 512;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const STATES = new Set<IngressHealthState>(["DOWN", "DEGRADED", "UNVERIFIED", "READY"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateObservation(value: unknown): asserts value is IngressHealthObservation {
  const allowedFields = new Set(["observationId", "profileId", "listener", "buildId", "probeOrigin", "principalClass", "state", "evidenceTier", "observedAt", "checks", "metrics", "operationId", "sessionIdentityHash", "failureClass"]);
  if (!isRecord(value) || Object.keys(value).some((key) => !allowedFields.has(key))
    || typeof value.observationId !== "string" || typeof value.profileId !== "string"
    || !/^[A-Za-z0-9._-]{1,64}$/.test(value.profileId) || typeof value.listener !== "string"
    || typeof value.buildId !== "string" || typeof value.probeOrigin !== "string"
    || !["owner_public", "peer", "none"].includes(String(value.principalClass))
    || !STATES.has(value.state as IngressHealthState) || !isIngressEvidenceTier(value.evidenceTier)
    || typeof value.observedAt !== "string" || !Number.isFinite(Date.parse(value.observedAt))
    || !isRecord(value.checks)) {
    throw new Error("invalid ingress health observation");
  }
  let origin: URL;
  try { origin = new URL(value.probeOrigin); } catch { throw new Error("invalid ingress health probe origin"); }
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/") {
    throw new Error("ingress health probe origin must be a credential-free HTTPS origin");
  }
  const allowedChecks = new Set(["daemon", "mapping", "localListener", "externalHttps", "oauthChallenge", "mcpInitialize", "toolsList", "sse", "longPost", "freshInitialize", "serverOperationCorrelation"]);
  for (const [key, item] of Object.entries(value.checks)) {
    if (!allowedChecks.has(key) || typeof item !== "boolean") throw new Error("invalid ingress health check evidence");
  }
  if (value.metrics !== undefined) {
    if (!isRecord(value.metrics)) throw new Error("invalid ingress health metrics");
    for (const [key, item] of Object.entries(value.metrics)) {
      if (["latencyMs", "failures", "reconnects", "maxHeartbeatGapMs", "serverEvidenceHeartbeatBytes", "serverEvidenceResponseBytes"].includes(key)) {
        if (typeof item !== "number" || !Number.isFinite(item) || item < 0) throw new Error("invalid ingress health metric");
        continue;
      }
      if (!["serverEvidenceRecordId", "serverEvidenceContentSha256", "serverEvidenceCloseClassification", "serverEvidenceServerBuildId"].includes(key)) {
        throw new Error("invalid ingress health metric");
      }
      if (typeof item !== "string" || item.length > 256) throw new Error("invalid ingress health metric");
      if (key === "serverEvidenceContentSha256" && !/^[a-f0-9]{64}$/.test(item)) throw new Error("invalid ingress health metric");
    }
  }
  if (value.sessionIdentityHash !== undefined && (typeof value.sessionIdentityHash !== "string" || !/^[a-f0-9]{64}$/.test(value.sessionIdentityHash))) {
    throw new Error("invalid session identity hash");
  }
  for (const optional of ["operationId", "failureClass"]) {
    if (value[optional] !== undefined && (typeof value[optional] !== "string" || String(value[optional]).length > 128)) {
      throw new Error(`invalid ${optional}`);
    }
  }
}

function readStore(stateDir: string): HealthStore {
  const path = join(stateDir, STORE_NAME);
  if (!existsSync(path)) return { version: 1, observations: [] };
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, "utf8")); }
  catch { throw new Error("ingress health store is corrupt; refusing to replace prior evidence"); }
  if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.observations)) {
    throw new Error("ingress health store has an unsupported schema; refusing to replace prior evidence");
  }
  for (const item of parsed.observations) validateObservation(item);
  return parsed as unknown as HealthStore;
}

function writeStore(stateDir: string, store: HealthStore): void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const path = join(stateDir, STORE_NAME);
  const temporary = `${path}.tmp.${randomUUID()}`;
  const fd = openSync(temporary, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(store)); fsyncSync(fd); }
  finally { closeSync(fd); }
  renameSync(temporary, path);
  syncDirectory(stateDir);
}

function withLock<T>(stateDir: string, run: () => T): T {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const lockPath = join(stateDir, "ingress-health.lock");
  let fd: number;
  try { fd = openSync(lockPath, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("another ingress health update is active");
    throw error;
  }
  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    fsyncSync(fd);
    return run();
  } finally {
    closeSync(fd);
    try { unlinkSync(lockPath); } catch { /* evidence is already atomically committed */ }
  }
}

export function classifyIngressHealth(input: {
  requiredChecks: Array<keyof IngressHealthObservation["checks"]>;
  checks: IngressHealthObservation["checks"];
  localListener?: boolean;
  externalExpected: boolean;
}): IngressHealthState {
  const { checks } = input;
  // An OBSERVED failure is classified by severity; a check that was never
  // performed is merely unverified. A bridge whose upstream went away is
  // DOWN, not "unverified", and a failed external check must never be
  // mistaken for missing evidence.
  if (input.localListener === false || checks.daemon === false || checks.mapping === false) return "DOWN";
  if (input.externalExpected && checks.externalHttps === false) return "DOWN";
  if (checks.sse === false || checks.longPost === false || checks.oauthChallenge === false) return "DEGRADED";
  const missing = input.requiredChecks.some((key) => checks[key] !== true)
    || (input.externalExpected && checks.externalHttps !== true);
  if (missing) return "UNVERIFIED";
  return "READY";
}

export function appendIngressHealthObservation(
  stateDir: string,
  observation: Omit<IngressHealthObservation, "observationId"> & { observationId?: string },
  now = Date.now(),
): IngressHealthObservation {
  const record = { ...observation, observationId: observation.observationId ?? randomUUID() } as IngressHealthObservation;
  validateObservation(record);
  return withLock(stateDir, () => {
    const cutoff = now - MAX_AGE_MS;
    const observations = readStore(stateDir).observations
      .filter((item) => Date.parse(item.observedAt) >= cutoff)
      .concat(record)
      .slice(-MAX_OBSERVATIONS);
    writeStore(stateDir, { version: 1, observations });
    return record;
  });
}

export function listIngressHealthObservations(stateDir: string, profileId?: string): IngressHealthObservation[] {
  const store = readStore(stateDir);
  return profileId ? store.observations.filter((item) => item.profileId === profileId) : store.observations;
}

export function latestIngressHealthByProfile(stateDir: string): IngressHealthObservation[] {
  const latest = new Map<string, IngressHealthObservation>();
  for (const item of readStore(stateDir).observations) latest.set(item.profileId, item);
  return [...latest.values()].sort((a, b) => a.profileId.localeCompare(b.profileId));
}
