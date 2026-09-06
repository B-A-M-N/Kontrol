/**
 * Liveness and readiness endpoints: /healthz, /core-readyz, /readyz.
 * Extracted verbatim from src/server.ts (P1.2); the createServer closures
 * become an explicit dependency object.
 */
import type { ServerConfig } from "../config.js";
import { LATEST_SCHEMA_VERSION } from "../db/migrations.js";
import { policyCanAsk } from "../policy.js";
import { readRuntimeIdentity } from "../runtime-identity.js";
import type { Request, Response } from "express";

export type ReadinessCheck = { ok: boolean; detail?: string; agents?: unknown[] };

export interface ReadinessDeps {
  readonly config: ServerConfig;
  databaseProbe(): void;
  schemaVersion(): number;
  executionAdmissionStats(): { active: number; activeWeight: number; availableWeight: number; queued: number; maxInflight: number };
  workspaceRegistryInitialized(): boolean;
  reviewSubsystemInitialized(): boolean;
  acpDispatcherInitialized(): boolean;
  buildId(): string | undefined;
  listAliveAgents(): Array<{ name: string; url?: string; alive?: boolean }>;
}

export function readinessChecks(deps: ReadinessDeps, req: Request, includeAgents: boolean): Record<string, ReadinessCheck> {
  const { config } = deps;
  const checks: Record<string, ReadinessCheck> = {};
  const runtime = readRuntimeIdentity(config.stateDir);
  let schemaVersion = 0;
  try {
    deps.databaseProbe();
    // P1 #17: readiness requires the EXACT current schema, not just a
    // migrated-at-some-point database. A partial/older schema must fail.
    schemaVersion = deps.schemaVersion();
    checks.database = { ok: true, detail: "select 1 ok" };
    checks.schema = {
      ok: schemaVersion === LATEST_SCHEMA_VERSION,
      detail: `version=${schemaVersion} expected=${LATEST_SCHEMA_VERSION}`,
    };
  } catch (error) {
    checks.database = { ok: false, detail: error instanceof Error ? error.message : String(error) };
    checks.schema = { ok: false, detail: "schema query failed" };
  }
  // Full integrity scans are intentionally absent from readiness. They run
  // in a separate worker and are exposed through authenticated diagnostics;
  // a stale/slow diagnostic must not make a serving core fail closed.
  checks.mcpHandler = { ok: true, detail: `HTTP handler is serving ${includeAgents ? "/readyz" : "/core-readyz"}` };
  const executionAdmission = deps.executionAdmissionStats();
  checks.mcpExecutionAdmission = {
    // Busy execution is healthy and must not make readiness flap. This
    // check only detects an impossible accounting state that would strand
    // capacity (negative counters or weight beyond the configured budget).
    ok: executionAdmission.active >= 0
      && executionAdmission.activeWeight >= 0
      && executionAdmission.activeWeight <= executionAdmission.maxInflight,
    detail: `active=${executionAdmission.active}; activeWeight=${executionAdmission.activeWeight}; availableWeight=${executionAdmission.availableWeight}; queued=${executionAdmission.queued}`,
  };
  checks.workspaceRegistry = { ok: deps.workspaceRegistryInitialized(), detail: "workspace registry initialized" };
  checks.reviewSubsystem = { ok: deps.reviewSubsystemInitialized(), detail: "review managers initialized" };
  checks.acpBridge = { ok: !config.acpEnabled || deps.acpDispatcherInitialized(), detail: config.acpEnabled ? "dispatcher initialized" : "ACP disabled" };
  // Configuration-level proof that ask-capable policies have a reviewer
  // credential source. loadConfig already rejects tunnel+ask-without-secret,
  // so this can only fail for non-tunnel modes whose credential wiring is
  // broken at runtime; report it as a first-class readiness check either way
  // so an operator sees the approval boundary's posture without reading
  // startup logs.
  const askCapable = policyCanAsk(config.policy);
  checks.approvalReviewerConfig = {
    ok: !askCapable || config.authMode !== "tunnel" || Boolean(config.tunnelReviewerSecret),
    detail: askCapable
      ? `policy can produce approvals; reviewer credential configured (authMode=${config.authMode})`
      : "policy cannot produce approvals; reviewer credential not required",
  };
  const buildMetaBuildId = deps.buildId();
  checks.build = {
    // Source-mode `tsx src/cli.ts serve` has no embedded build-meta.json;
    // its explicit `dev` identity is still valid. Release artifacts must
    // continue to match their immutable embedded build ID exactly.
    ok: Boolean(runtime) && (!buildMetaBuildId
      ? runtime?.buildId === "dev"
      : runtime?.buildId === buildMetaBuildId),
    detail: `expected=${buildMetaBuildId ?? "missing"} live=${runtime?.buildId ?? "missing"}`,
  };

  if (!includeAgents) {
    checks.agents = { ok: true, detail: "agent checks deferred to strict /readyz" };
    return checks;
  }

  // P1 #16: public readiness is deterministic from server configuration
  // alone. Query-string agent selection was removed — arbitrary "check
  // these agents" requests could replace the configured requirement set.
  // Diagnostics/doctor tooling covers ad-hoc agent checks instead.
  const configuredAgents = config.acpKnownAgents;
  const aliveAgents = deps.listAliveAgents();
  // P1 #12 review note: an empty configured list with zero registered
  // workers is a legitimate deployment posture ("no ACP workers wanted"),
  // not a readiness failure. Strict /readyz only fails when the operator
  // has *configured* required agents that are absent/unhealthy.
  const agentResults = configuredAgents.map((required) => {
    const found = aliveAgents.find((agent) => agent.name === required.name);
    const urlMatches = !required.url || found?.url === required.url;
    return {
      name: required.name,
      expectedUrl: required.url,
      registeredUrl: found?.url,
      alive: Boolean(found?.alive),
      healthy: Boolean(found?.alive) && urlMatches,
    };
  });
  checks.agents = {
    ok: agentResults.every((agent) => agent.healthy),
    detail: configuredAgents.length > 0
      ? "required agents checked"
      : "no agents configured; deployments without ACP workers are ready",
    agents: agentResults,
  };
  return checks;
}

export function sendReadiness(res: Response, checks: Record<string, ReadinessCheck>, approvalInteractive: boolean): void {
  const ready = Object.values(checks).every((check) => check.ok);
  const publicChecks = Object.fromEntries(Object.entries(checks).map(([name, check]) => [name, { ok: check.ok }]));
  res.setHeader("Cache-Control", "no-store");
  res.status(ready ? 200 : 503).json({
    ok: ready,
    ready,
    name: "kontrol",
    // Non-sensitive policy posture so probes can decide whether the
    // reviewer path is part of the readiness contract without guessing
    // from environment variables.
    approvalInteractive,
    checks: publicChecks,
  });
}

export function healthz(res: Response): void {
  // Keep unauthenticated liveness deliberately minimal. Build/runtime
  // identity, process details, session counts, and workflow diagnostics
  // belong behind readiness/diagnostics controls.
  res.setHeader("Cache-Control", "no-store");
  res.json({
    ok: true,
    name: "kontrol",
  });
}
