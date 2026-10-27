/**
 * The multipath ingress adversarial qualification matrix (audit §6).
 *
 * The audit requires the deployment matrix to become "a repeatable
 * qualification harness, not a collection of manually interpreted logs", and
 * requires that "unit-tested, local-integration-tested, real-tailnet-tested,
 * public-internet-tested, and operationally-qualified" stay distinct: "a
 * lower evidence tier cannot satisfy a higher claim".
 *
 * This module owns:
 *   - the scenario catalog (the audit's matrix, one entry per row),
 *   - the single evaluation rule that decides pass / fail / unverified,
 *   - the redacted, durable evidence shape the harness records.
 *
 * It never probes anything by itself. The runner (scripts/ingress-
 * qualification-matrix.mjs) executes the source-level guards and ingests
 * deployment observations; this module only decides what the evidence means.
 *
 * The tier of an observation is DERIVED from the origin it was collected
 * against (see evidence-tier.ts), so an operator cannot relabel a loopback
 * probe as public-internet evidence.
 */
import {
  deriveEvidenceScope,
  evidenceSatisfies,
  evidenceTierRank,
  isIngressEvidenceScope,
  isIngressEvidenceTier,
  scopeForTier,
  tierForScope,
  type IngressEvidenceScope,
  type IngressEvidenceTier,
} from "./evidence-tier.js";

export type IngressMatrixArea =
  | "mapping"
  | "security"
  | "transport"
  | "durability"
  | "packaging"
  | "availability"
  | "recovery";

/**
 * A canonical source-level guard. The declared tier is the evidence tier the
 * guard's execution actually earns: a pure assertion earns "unit", a check
 * that boots the real components earns "local_integration". Declaring a tier
 * a guard does not earn would be exactly the tier inflation the audit
 * forbids, so the catalog states it explicitly per scenario.
 */
export interface IngressMatrixGuard {
  command: string;
  args: string[];
  tier: IngressEvidenceTier;
  /** Optional external binary the guard needs to run at all. */
  toolchain?: { binary: string; envVar?: string };
}

export interface IngressMatrixScenario {
  id: string;
  title: string;
  area: IngressMatrixArea;
  /** What "pass" means, taken from the audit's expected-evidence column. */
  expectation: string;
  /** The scope the claim must have been observed in. */
  scope: IngressEvidenceScope;
  /** The minimum evidence tier that may satisfy the claim. */
  tier: IngressEvidenceTier;
  /** True when the expectation is inherently about a deployed path. */
  deployment: boolean;
  guards: IngressMatrixGuard[];
  notes?: string;
}

const TS = (file: string): IngressMatrixGuard => ({ command: "node", args: ["--import", "tsx", file], tier: "unit" });
const TS_INTEGRATION = (file: string): IngressMatrixGuard => ({ command: "node", args: ["--import", "tsx", file], tier: "local_integration" });
const MJS = (file: string): IngressMatrixGuard => ({ command: "node", args: [file], tier: "unit" });
/** A guard that must run through npm (the packaged install resolves npm from
 * npm_execpath, so it cannot be spawned as a bare node process). */
const NPM = (script: string): IngressMatrixGuard => ({ command: "npm", args: ["run", script], tier: "local_integration" });

/**
 * The audit's matrix, one scenario per row. `scope`/`tier` state the evidence
 * that may satisfy the row:
 *
 *   - pure configuration, classification, and authorization logic is proven at
 *     the "unit" tier by the canonical source-level guard;
 *   - behavior that needs the running system is proven at
 *     "local_integration";
 *   - a deployed route is only proven by tailnet or public-internet
 *     evidence collected out of process.
 */
export const INGRESS_QUALIFICATION_SCENARIOS: readonly IngressMatrixScenario[] = [
  {
    id: "serve-mapping-exact-match",
    title: "Correct Serve mapping",
    area: "mapping",
    expectation: "Exact route match and authenticated MCP request from a tailnet client",
    scope: "tailnet",
    tier: "real_tailnet",
    deployment: true,
    guards: [TS("src/ingress/profile-status.test.ts")],
    notes: "The source guard proves exact-tuple classification only; the authenticated tailnet request needs real_tailnet evidence.",
  },
  {
    id: "serve-wrong-host-port-path",
    title: "Wrong Serve host/port/path",
    area: "mapping",
    expectation: "Mismatch; never READY",
    scope: "loopback",
    tier: "unit",
    deployment: false,
    guards: [TS("src/ingress/profile-status.test.ts")],
  },
  {
    id: "funnel-public-authenticated",
    title: "Funnel enabled publicly",
    area: "availability",
    expectation: "Authenticated HTTPS works from a non-tailnet client",
    scope: "public",
    tier: "public_internet",
    deployment: true,
    guards: [TS("src/server/public-mcp-app.test.ts")],
  },
  {
    id: "funnel-to-peer-listener-rejected",
    title: "Funnel accidentally targeting the peer listener",
    area: "security",
    expectation: "Configuration rejected",
    scope: "loopback",
    tier: "unit",
    deployment: false,
    guards: [TS("src/ingress/validate.test.ts"), TS("src/ingress/validate-config.test.ts")],
  },
  {
    id: "funnel-removed-during-sse",
    title: "Funnel removed during SSE",
    area: "transport",
    expectation: "Classified transport loss; no false execution completion",
    scope: "public",
    tier: "public_internet",
    deployment: true,
    guards: [MJS("scripts/analyze-mcp-stream-failure.test.mjs")],
  },
  {
    id: "caddy-forbidden-route-negative",
    title: "Caddy proxies forbidden routes",
    area: "security",
    expectation: "Explicit negative test fails (the bridge returns its own 404)",
    scope: "loopback",
    tier: "local_integration",
    deployment: false,
    guards: [
      TS("src/ingress/bridge-asset.test.ts"),
      MJS("scripts/qualify-caddy-bridge.test.mjs"),
      MJS("scripts/bridge-route-isolation.test.mjs"),
      {
        command: "node",
        args: ["--import", "tsx", "scripts/qualify-caddy-bridge.mjs", "--config", "deploy/bridge/Caddyfile.example", "--bridge-node", "local-qualification", "--public-host", "kontrol.example.com", "--upstream", "kontrol-node.tail-scale.ts.net:9443", "--build-id", "local-qualification", "--receipt", ".tmp-scratch/ingress-caddy-qualification.json"],
        tier: "local_integration",
        toolchain: { binary: "caddy", envVar: "KONTROL_CADDY_BIN" },
      },
      {
        command: "node",
        args: ["scripts/bridge-route-isolation.mjs", "--config", "deploy/bridge/Caddyfile.example", "--build-id", "local-qualification", "--receipt", ".tmp-scratch/ingress-bridge-isolation.json"],
        tier: "local_integration",
        toolchain: { binary: "caddy", envVar: "KONTROL_CADDY_BIN" },
      },
    ],
    notes: "The caddy adapt/validate and route-isolation guards need a Caddy binary; without one the scenario stays unverified instead of claiming a config proof. The route-isolation guard runs the packaged configuration against a controlled upstream that answers 200 on EVERY path, so a proxy that forwarded forbidden routes would fail it.",
  },
  {
    id: "forged-forwarded-and-x-kontrol-headers",
    title: "Forged forwarded and X-Kontrol-* headers",
    area: "security",
    expectation: "No authority escalation",
    scope: "public",
    tier: "public_internet",
    deployment: true,
    guards: [TS("src/ingress/proxy-context.test.ts"), TS("src/ingress/host-policy.test.ts")],
  },
  {
    id: "peer-credential-revoked-mid-session",
    title: "Peer credential revoked mid-session",
    area: "security",
    expectation: "Existing privileged transport fenced",
    scope: "loopback",
    tier: "local_integration",
    deployment: false,
    guards: [TS_INTEGRATION("src/peer-listener.test.ts")],
  },
  {
    id: "oauth-token-wrong-origin-resource",
    title: "OAuth token used on the wrong origin/resource",
    area: "security",
    expectation: "Denied",
    scope: "loopback",
    tier: "unit",
    deployment: false,
    guards: [TS("src/oauth-provider-guard.test.ts"), MJS("scripts/lib/mcp-endpoint-selector.test.mjs")],
  },
  {
    id: "bridge-upstream-disconnected-core-healthy",
    title: "Bridge upstream disconnected",
    area: "availability",
    expectation: "Bridge degraded; the Kontrol core stays healthy",
    scope: "loopback",
    tier: "local_integration",
    deployment: false,
    guards: [TS("src/ingress/health-store.test.ts"), TS_INTEGRATION("src/ingress/qualification.integration.test.ts")],
  },
  {
    id: "corrupted-peer-job-storage",
    title: "Corrupted peer-job storage",
    area: "durability",
    expectation: "Dispatch blocked, prior evidence retained",
    scope: "loopback",
    tier: "unit",
    deployment: false,
    guards: [TS("src/peer/jobs/store.test.ts")],
  },
  {
    id: "connection-lost-after-mutation-dispatch",
    title: "Connection lost after mutation dispatch",
    area: "durability",
    expectation: "Uncertain operation reconciled; not blindly replayed",
    scope: "loopback",
    tier: "unit",
    deployment: false,
    guards: [TS("src/mutation-receipts.test.ts")],
  },
  {
    id: "concurrent-clients-switching-routes",
    title: "Concurrent clients switching routes",
    area: "recovery",
    expectation: "No shared transport identity or cross-session state",
    scope: "loopback",
    tier: "unit",
    deployment: false,
    guards: [MJS("scripts/lib/mcp-endpoint-selector.test.mjs")],
  },
  {
    id: "runtime-restart-multiple-listeners",
    title: "Runtime restart with multiple listeners",
    area: "recovery",
    expectation: "All configured listeners restored or startup fails cleanly",
    scope: "loopback",
    tier: "local_integration",
    deployment: false,
    guards: [TS_INTEGRATION("src/server/startup-recovery.test.ts")],
  },
  {
    id: "credential-rotation-during-reconnect",
    title: "Credential rotation during reconnect",
    area: "security",
    expectation: "Fresh credentials and authority used",
    scope: "loopback",
    tier: "unit",
    deployment: false,
    guards: [TS("src/peer/credentials.test.ts")],
  },
  {
    id: "sse-idle-timeout-and-45s-post",
    title: "SSE idle timeout and 45-second POST",
    area: "transport",
    expectation: "Byte-level streaming evidence across the actual HTTPS chain",
    scope: "public",
    tier: "public_internet",
    deployment: true,
    guards: [TS("src/server/mcp-sse-heartbeat.test.ts"), MJS("scripts/probe-ingress-bridge.test.mjs")],
  },
  {
    id: "packaged-installation-bridge-assets",
    title: "Packaged installation",
    area: "packaging",
    expectation: "Exact bridge assets and configuration included",
    scope: "loopback",
    tier: "local_integration",
    deployment: false,
    guards: [NPM("test:package-release")],
  },
  {
    id: "external-tls-or-dns-failure",
    title: "External TLS or DNS failure",
    area: "availability",
    expectation: "Accurate profile-specific failure classification",
    scope: "public",
    tier: "public_internet",
    deployment: true,
    guards: [TS("src/ingress/tailscale-status.test.ts"), TS("src/ingress/health-store.test.ts")],
  },
];

export type IngressMatrixStatus = "pass" | "fail" | "source_verified" | "unverified";

export interface IngressMatrixGuardOutcome {
  command: string;
  passed: boolean;
  exitCode?: number | null;
  signal?: string | null;
  durationMs?: number;
  /** Stable classification of why the guard failed. */
  failureClass?: string;
  detail?: string;
  /** Set when the guard could not run at all (missing toolchain). */
  skipped?: boolean;
}

/** One deployment observation, as collected out of process. */
export interface IngressMatrixObservation {
  scenarioId: string;
  outcome: "pass" | "fail";
  /** Credential-free origin the evidence was collected against. */
  endpoint: string;
  observedAt: string;
  profileId?: string;
  listener?: string;
  principalClass?: "owner_public" | "peer" | "none";
  /** SHA-256 of the session identity; never the identity itself. */
  sessionIdentityHash?: string;
  operationId?: string;
  failureClass?: string;
  buildId?: string;
  configSha256?: string;
  /** True only for a sustained-operation receipt. */
  operational?: boolean;
  notes?: string;
}

const OBSERVATION_FIELDS = new Set([
  "scenarioId", "outcome", "endpoint", "observedAt", "profileId", "listener",
  "principalClass", "sessionIdentityHash", "operationId", "failureClass",
  "buildId", "configSha256", "operational", "notes",
]);

const CREDENTIAL_PATTERNS: RegExp[] = [
  /\bbearer\s+\S+/i,
  /\bauthorization\b\s*[:=]/i,
  /\bset-cookie\b/i,
  /\bsk-[A-Za-z0-9]{12,}/,
  /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
];

/** Reject evidence that could carry a credential or a response body. */
export function assertRedactedEvidence(value: unknown, label: string): void {
  if (typeof value === "string") {
    if (value.length > 512) throw new Error(`${label} exceeds the bounded evidence length`);
    for (const pattern of CREDENTIAL_PATTERNS) {
      if (pattern.test(value)) throw new Error(`${label} appears to carry credential material`);
    }
    return;
  }
  if (value === null || value === undefined) return;
  if (typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (key.toLowerCase() === "sessionidentityhash") {
        if (typeof item !== "string" || !/^[a-f0-9]{64}$/.test(item)) {
          throw new Error("sessionIdentityHash must be a lowercase SHA-256 hex digest");
        }
        continue;
      }
      assertRedactedEvidence(item, `${label}.${key}`);
    }
    return;
  }
  if (typeof value === "number" || typeof value === "boolean") return;
  throw new Error(`${label} has an unsupported type`);
}

/** Validate and normalize one deployment observation. */
export function validateIngressMatrixObservation(value: unknown): IngressMatrixObservation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("ingress matrix observation must be an object");
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!OBSERVATION_FIELDS.has(key)) throw new Error(`ingress matrix observation has unsupported field ${key}`);
  }
  if (typeof record.scenarioId !== "string" || !/^[a-z0-9-]{1,64}$/.test(record.scenarioId)) {
    throw new Error("ingress matrix observation has an invalid scenarioId");
  }
  if (record.outcome !== "pass" && record.outcome !== "fail") {
    throw new Error("ingress matrix observation outcome must be pass or fail");
  }
  if (typeof record.endpoint !== "string" || record.endpoint.length === 0) {
    throw new Error("ingress matrix observation needs the observed endpoint");
  }
  let endpoint: URL;
  try {
    endpoint = new URL(record.endpoint);
  } catch {
    throw new Error("ingress matrix observation endpoint is not a URL");
  }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error("ingress matrix observation endpoint must be credential-free and query-free");
  }
  if (typeof record.observedAt !== "string" || !Number.isFinite(Date.parse(record.observedAt))) {
    throw new Error("ingress matrix observation needs a valid observedAt timestamp");
  }
  if (record.principalClass !== undefined && !["owner_public", "peer", "none"].includes(String(record.principalClass))) {
    throw new Error("ingress matrix observation has an invalid principalClass");
  }
  if (record.operational !== undefined && typeof record.operational !== "boolean") {
    throw new Error("ingress matrix observation operational flag must be boolean");
  }
  for (const optional of ["profileId", "listener", "operationId", "failureClass", "buildId", "configSha256", "notes"]) {
    if (record[optional] !== undefined && typeof record[optional] !== "string") {
      throw new Error(`ingress matrix observation ${optional} must be a string`);
    }
  }
  if (record.configSha256 !== undefined && !/^[a-f0-9]{64}$/.test(String(record.configSha256))) {
    throw new Error("ingress matrix observation configSha256 must be a SHA-256 hex digest");
  }
  assertRedactedEvidence(record, "ingress matrix observation");
  return record as unknown as IngressMatrixObservation;
}

/** The scope/tier an observation actually carries, derived from its origin. */
export function observationEvidence(observation: IngressMatrixObservation): {
  scope: IngressEvidenceScope | null;
  tier: IngressEvidenceTier;
} {
  const scope = deriveEvidenceScope(observation.endpoint);
  if (scope === null) {
    // An unusable origin cannot earn evidence; fall back to the weakest tier
    // so the scenario is reported as unverified rather than accidentally
    // qualifying.
    return { scope: null, tier: "unit" };
  }
  return { scope, tier: tierForScope(scope, { operational: observation.operational === true }) };
}

/**
 * Convert a durable ingress health observation (the record the bridge and
 * tailnet probes write) into a matrix observation.
 *
 * The health record carries the same redacted evidence, but in the health
 * store's shape. Conversion keeps the operator workflow to one artifact: the
 * probe writes a health observation, and the matrix consumes it without the
 * operator having to restate any field by hand.
 */
export function observationFromHealthRecord(
  record: {
    profileId: string;
    listener?: string;
    buildId?: string;
    probeOrigin: string;
    principalClass?: string;
    state: string;
    observedAt: string;
    checks?: Record<string, boolean | undefined>;
    metrics?: Record<string, number | undefined>;
    sessionIdentityHash?: string;
    operationId?: string;
    failureClass?: string;
  },
  scenarioId: string,
): IngressMatrixObservation {
  const checks = record.checks ?? {};
  const failed = Object.entries(checks).some(([, value]) => value === false);
  const outcome = record.state === "READY" && !failed ? "pass" : "fail";
  const observation: IngressMatrixObservation = {
    scenarioId,
    outcome,
    endpoint: record.probeOrigin,
    observedAt: record.observedAt,
    profileId: record.profileId,
    principalClass: record.principalClass === "owner_public" || record.principalClass === "peer"
      ? record.principalClass
      : "none",
    ...(record.listener ? { listener: record.listener } : {}),
    ...(record.buildId ? { buildId: record.buildId } : {}),
    ...(record.sessionIdentityHash ? { sessionIdentityHash: record.sessionIdentityHash } : {}),
    ...(record.operationId ? { operationId: record.operationId } : {}),
    ...(record.failureClass ? { failureClass: record.failureClass } : {}),
    ...(Number.isFinite(record.metrics?.latencyMs) ? { notes: `latency=${record.metrics?.latencyMs}ms` } : {}),
  };
  return validateIngressMatrixObservation(observation);
}

export interface IngressMatrixScenarioResult {
  id: string;
  title: string;
  area: IngressMatrixArea;
  expectation: string;
  requiredScope: IngressEvidenceScope;
  requiredTier: IngressEvidenceTier;
  deployment: boolean;
  status: IngressMatrixStatus;
  evidenceTier: IngressEvidenceTier | null;
  evidenceScope: IngressEvidenceScope | null;
  evidenceSource: "guard" | "observation" | "none";
  failureClass?: string;
  reason?: string;
  guards: IngressMatrixGuardOutcome[];
  observation?: IngressMatrixObservation;
}

export interface IngressMatrixReport {
  kind: "kontrol-ingress-qualification-matrix";
  version: 1;
  generatedAt: string;
  buildId: string | null;
  configSha256: string | null;
  qualified: boolean;
  tierSummary: Record<IngressEvidenceTier, { required: number; passed: number; failed: number; unverified: number }>;
  scenarios: IngressMatrixScenarioResult[];
  blockers: string[];
}

function emptyTierSummary(): IngressMatrixReport["tierSummary"] {
  return {
    unit: { required: 0, passed: 0, failed: 0, unverified: 0 },
    local_integration: { required: 0, passed: 0, failed: 0, unverified: 0 },
    real_tailnet: { required: 0, passed: 0, failed: 0, unverified: 0 },
    public_internet: { required: 0, passed: 0, failed: 0, unverified: 0 },
    operational: { required: 0, passed: 0, failed: 0, unverified: 0 },
  };
}

export interface IngressMatrixEvaluation {
  scenarios?: readonly IngressMatrixScenario[];
  guards?: ReadonlyMap<string, IngressMatrixGuardOutcome[]>;
  observations?: readonly IngressMatrixObservation[];
  generatedAt?: string;
  buildId?: string | null;
  configSha256?: string | null;
}

/**
 * Evaluate the matrix. The rule is deliberately small:
 *
 *   - a failing guard or a failing deployment observation FAILS the scenario;
 *   - evidence that satisfies the scenario's scope AND tier PASSES it;
 *   - a source-level guard that passes but does not reach the required tier
 *     leaves the scenario source_verified (a regression guard, not a
 *     qualification);
 *   - everything else is unverified, with the reason recorded.
 *
 * `qualified` is true only when EVERY scenario passed.
 */
export function evaluateIngressMatrix(evaluation: IngressMatrixEvaluation): IngressMatrixReport {
  const scenarios = evaluation.scenarios ?? INGRESS_QUALIFICATION_SCENARIOS;
  const guards = evaluation.guards ?? new Map<string, IngressMatrixGuardOutcome[]>();
  const observations = evaluation.observations ?? [];
  const byScenario = new Map<string, IngressMatrixObservation>();
  for (const observation of observations) {
    if (byScenario.has(observation.scenarioId)) {
      throw new Error(`duplicate ingress matrix observation for ${observation.scenarioId}`);
    }
    byScenario.set(observation.scenarioId, observation);
  }

  const tierSummary = emptyTierSummary();
  const results: IngressMatrixScenarioResult[] = [];
  const blockers: string[] = [];

  for (const scenario of scenarios) {
    const scenarioGuards = guards.get(scenario.id) ?? [];
    const observation = byScenario.get(scenario.id) ?? null;
    const requirement = { scope: scenario.scope, tier: scenario.tier };

    let bestTier: IngressEvidenceTier | null = null;
    let bestScope: IngressEvidenceScope | null = null;
    let bestSource: "guard" | "observation" | "none" = "none";

    // The guard DECLARATION carries the evidence tier a guard may claim;
    // the outcome only says whether it ran. A guard outcome without its
    // declaration can never contribute evidence.
    const guardDeclarations = scenario.guards;
    for (const [index, guard] of scenarioGuards.entries()) {
      if (!guard.passed || guard.skipped) continue;
      const declaration = guardDeclarations[index]
        ?? guardDeclarations.find((candidate) => candidate.command === guard.command.split(" ")[0]);
      if (!declaration) continue;
      if (evidenceSatisfies({ scope: "loopback", tier: declaration.tier }, requirement)) {
        if (bestTier === null || evidenceTierRank(declaration.tier) > evidenceTierRank(bestTier)) {
          bestTier = declaration.tier;
          bestScope = "loopback";
          bestSource = "guard";
        }
      }
    }
    if (observation) {
      const evidence = observationEvidence(observation);
      if (evidence.scope !== null && evidenceSatisfies({ scope: evidence.scope, tier: evidence.tier }, requirement)) {
        bestTier = evidence.tier;
        bestScope = evidence.scope;
        bestSource = "observation";
      }
    }

    const failingGuard = scenarioGuards.find((guard) => guard.passed === false && guard.skipped !== true);
    const failingObservation = observation && observation.outcome === "fail" ? observation : null;

    let status: IngressMatrixStatus;
    let failureClass: string | undefined;
    let reason: string | undefined;

    if (failingObservation) {
      status = "fail";
      failureClass = failingObservation.failureClass ?? "deployment_evidence_failed";
      reason = "deployment evidence reported a failed outcome";
    } else if (failingGuard) {
      status = "fail";
      failureClass = failingGuard.failureClass ?? "source_guard_failed";
      reason = failingGuard.detail ?? "the canonical source-level guard failed";
    } else if (bestTier !== null) {
      status = "pass";
    } else if (observation) {
      status = "unverified";
      const evidence = observationEvidence(observation);
      reason = `supplied evidence (${evidence.tier}/${evidence.scope ?? "unscoped"}) does not qualify the required tier (${scenario.tier}/${scenario.scope})`;
    } else if (scenarioGuards.some((guard) => guard.skipped)) {
      status = "unverified";
      reason = "a required toolchain is unavailable, so the scenario could not be exercised";
    } else if (scenarioGuards.some((guard) => guard.passed && !guard.skipped)) {
      status = "source_verified";
      reason = `the source-level guard passed, but ${scenario.tier}/${scenario.scope} evidence is still required`;
    } else {
      status = "unverified";
      reason = "no source-level guard or deployment evidence was supplied";
    }

    tierSummary[scenario.tier].required += 1;
    if (status === "pass") tierSummary[scenario.tier].passed += 1;
    else if (status === "fail") tierSummary[scenario.tier].failed += 1;
    else tierSummary[scenario.tier].unverified += 1;

    if (status !== "pass") {
      blockers.push(`${scenario.id}: ${status}${reason ? ` (${reason})` : ""}`);
    }

    results.push({
      id: scenario.id,
      title: scenario.title,
      area: scenario.area,
      expectation: scenario.expectation,
      requiredScope: scenario.scope,
      requiredTier: scenario.tier,
      deployment: scenario.deployment,
      status,
      evidenceTier: bestTier,
      evidenceScope: bestScope,
      evidenceSource: bestSource,
      failureClass,
      reason,
      guards: scenarioGuards,
      observation: observation ?? undefined,
    });
  }

  const qualified = results.length > 0 && results.every((result) => result.status === "pass");
  return {
    kind: "kontrol-ingress-qualification-matrix",
    version: 1,
    generatedAt: evaluation.generatedAt ?? new Date().toISOString(),
    buildId: evaluation.buildId ?? null,
    configSha256: evaluation.configSha256 ?? null,
    qualified,
    tierSummary,
    scenarios: results,
    blockers,
  };
}

/** Human-readable one-line status per scenario, for operator output. */
export function formatIngressMatrixReport(report: IngressMatrixReport): string {
  const lines = [`ingress qualification matrix: ${report.qualified ? "QUALIFIED" : "NOT QUALIFIED"}`];
  for (const scenario of report.scenarios) {
    const tier = `${scenario.requiredTier}/${scenario.requiredScope}`;
    const evidence = scenario.evidenceTier
      ? `${scenario.evidenceTier}/${scenario.evidenceScope ?? "unscoped"}`
      : "none";
    lines.push(`  [${scenario.status.toUpperCase()}] ${scenario.id} (${tier}) evidence=${evidence}${scenario.failureClass ? ` failure=${scenario.failureClass}` : ""}`);
  }
  lines.push(`  blockers: ${report.blockers.length}`);
  return lines.join("\n");
}

export function isIngressMatrixScenarioId(value: string): boolean {
  return INGRESS_QUALIFICATION_SCENARIOS.some((scenario) => scenario.id === value);
}

export { isIngressEvidenceScope, isIngressEvidenceTier, scopeForTier };
