/**
 * Lifecycle coordinator: the single decision library shared by the systemd
 * backend (src/service.ts), the tmux backend (start-all.sh / stop-all.sh via
 * src/lifecycle-cli.ts), and tests.
 *
 * This module owns no processes and runs no supervisor loop — it only
 * answers: which backend owns a live stack, which components belong to it,
 * in which order they start/stop, whether a candidate artifact may open the
 * live database, and what the aggregate verdict over the stack is. Both
 * launch backends consult it so tmux and systemd can never silently become
 * competing owners of the same deployment.
 */

import { spawnSync } from "node:child_process";
import type { KontrolServiceComponent } from "./user-config.js";
import { componentServiceName } from "./service.js";

// ── Component manifest ────────────────────────────────────────────────

export type LifecycleComponentKind = "core" | "tunnel" | "adapter" | "supervisor";

export interface LifecycleComponentSpec {
  /** Stable component name, e.g. "core", "tunnel", "crush". */
  name: string;
  kind: LifecycleComponentKind;
  /** systemd unit name, e.g. "kontrol-core.service". */
  systemdUnit: string;
  /** tmux session name when the tmux backend manages this component. */
  tmuxSession: string | null;
  /** TCP port the component serves, when applicable. */
  port?: number;
  /** Required components gate the READY verdict; all configured ones are. */
  required: boolean;
}

/**
 * Canonical tmux sessions owned by the tmux backend. This is the single
 * source of truth: start-all.sh launches exactly these, and stop-all.sh
 * stops exactly these. A session not in this set is never signaled, so an
 * unrelated user session can never be stopped by name collision.
 */
export const MANAGED_TMUX_SESSIONS = [
  "kontrol-server",
  "kontrol-tunnel",
  "kontrol-supervisor",
  "kontrol-adapter",
  "kontrol-adapter-crush",
  "kontrol-adapter-hermes",
  "kontrol-adapter-muse",
  "kontrol-adapter-musefi",
  "kontrol-adapter-openmuse",
  "kontrol-beta-soak",
] as const;

export function isManagedTmuxSession(name: string): boolean {
  return (MANAGED_TMUX_SESSIONS as readonly string[]).includes(name);
}

/**
 * Build the single component manifest both backends enumerate. The core is
 * always first (starts first, stops last); configured tunnel/adapter
 * components follow in configuration order. Every configured component is
 * required: a missing one degrades the aggregate verdict instead of being
 * silently ignored.
 */
export function buildLifecycleManifest(options: {
  coreServiceName: string;
  coreTmuxSession?: string;
  components: KontrolServiceComponent[];
}): LifecycleComponentSpec[] {
  const manifest: LifecycleComponentSpec[] = [{
    name: "core",
    kind: "core",
    systemdUnit: options.coreServiceName,
    tmuxSession: options.coreTmuxSession ?? "kontrol-server",
    required: true,
  }];
  for (const component of options.components) {
    manifest.push({
      name: component.name,
      kind: component.kind,
      systemdUnit: componentServiceName(component.name),
      tmuxSession: component.kind === "tunnel" ? "kontrol-tunnel" : `kontrol-adapter-${component.name}`,
      ...(component.port !== undefined ? { port: component.port } : {}),
      required: true,
    });
  }
  return manifest;
}

/** Start order: core first, then tunnel/adapters in manifest order. */
export function startOrder(manifest: LifecycleComponentSpec[]): LifecycleComponentSpec[] {
  return [...manifest];
}

/** Stop order: reverse of start — adapters/tunnel drain before the core. */
export function stopOrder(manifest: LifecycleComponentSpec[]): LifecycleComponentSpec[] {
  return [...manifest].reverse();
}

// ── Backend resolution ────────────────────────────────────────────────

export type ActiveBackend = "systemd" | "tmux" | "none" | "mixed" | "unknown";

export interface BackendSnapshot {
  backend: ActiveBackend;
  /** Kontrol-owned systemd units observed active (core, target, components). */
  systemdUnits: string[];
  /** Kontrol-owned tmux sessions observed live. */
  tmuxSessions: string[];
  /** Probe failures that prevented a backend verdict; never empty when unknown. */
  probeErrors: string[];
}

/**
 * Discriminated probe outcome. A probe that cannot inspect its backend must
 * report `unavailable`, never an empty list: inspection failure is not
 * evidence of absence, and treating it as "no owner" would let a second
 * stack start on top of a live one.
 */
export type ProbeOutcome = { status: "ok"; names: string[] } | { status: "unavailable"; reason: string };

export interface LifecycleProbes {
  /** Active unit names, e.g. from `systemctl --user list-units`. */
  listActiveSystemdUnits: () => ProbeOutcome;
  /** Live session names, e.g. from `tmux list-sessions`. */
  listTmuxSessions: () => ProbeOutcome;
}

function isOwnedSystemdUnit(unit: string, coreServiceName: string): boolean {
  if (unit === "kontrol.target" || unit === coreServiceName) return true;
  return /^kontrol-.+\.service$/.test(unit);
}

export function resolveActiveBackend(
  probes: LifecycleProbes,
  coreServiceName = "kontrol-core.service",
): BackendSnapshot {
  const probeErrors: string[] = [];
  const systemdOutcome = (() => {
    try {
      return probes.listActiveSystemdUnits();
    } catch (error) {
      return { status: "unavailable", reason: `systemd probe threw: ${error instanceof Error ? error.message : String(error)}` } as const;
    }
  })();
  const tmuxOutcome = (() => {
    try {
      return probes.listTmuxSessions();
    } catch (error) {
      return { status: "unavailable", reason: `tmux probe threw: ${error instanceof Error ? error.message : String(error)}` } as const;
    }
  })();
  if (systemdOutcome.status === "unavailable") probeErrors.push(systemdOutcome.reason);
  if (tmuxOutcome.status === "unavailable") probeErrors.push(tmuxOutcome.reason);
  const systemdUnits = systemdOutcome.status === "ok"
    ? systemdOutcome.names.filter((unit) => isOwnedSystemdUnit(unit, coreServiceName))
    : [];
  const tmuxSessions = tmuxOutcome.status === "ok" ? tmuxOutcome.names.filter(isManagedTmuxSession) : [];
  const systemdActive = systemdUnits.length > 0;
  const tmuxActive = tmuxSessions.length > 0;
  const backend: ActiveBackend =
    probeErrors.length > 0
      ? "unknown"
      : systemdActive && tmuxActive
        ? "mixed"
        : systemdActive
          ? "systemd"
          : tmuxActive
            ? "tmux"
            : "none";
  return { backend, systemdUnits, tmuxSessions, probeErrors };
}

// ── Start fencing ─────────────────────────────────────────────────────

export interface StackStartRequest {
  requested: "systemd" | "tmux";
  active: BackendSnapshot;
}

export type StackStartDecision = { ok: true } | { ok: false; reason: string };

/**
 * A backend may start only when resolution positively shows no conflicting
 * owner. Same-backend restarts are allowed (idempotent start). Anything
 * else — a foreign owner, a mixed stack, or an `unknown` backend caused by
 * probe failure — refuses. There is deliberately no authorization bypass
 * here: a conflicting stack must be stopped through the fenced takeover
 * transaction (planFencedTakeover) before any start proceeds.
 */
export function decideStackStart(request: StackStartRequest): StackStartDecision {
  const { requested, active } = request;
  if (active.backend === "none") return { ok: true };
  if (active.backend === requested) return { ok: true };
  if (active.backend === "unknown") {
    return {
      ok: false,
      reason: `refusing ${requested} start: backend ownership is unknown (${active.probeErrors.join("; ")}); refusing to risk a second conflicting stack`,
    };
  }
  if (active.backend === "mixed") {
    return {
      ok: false,
      reason: `refusing ${requested} start: both systemd (${active.systemdUnits.join(", ")}) and tmux (${active.tmuxSessions.join(", ")}) own live Kontrol components; stop one stack explicitly first`,
    };
  }
  const held = active.backend === "systemd" ? active.systemdUnits.join(", ") : active.tmuxSessions.join(", ");
  return {
    ok: false,
    reason: `refusing ${requested} start: ${active.backend} backend already owns live Kontrol components (${held}); stop that stack first`,
  };
}

export type FencedTakeoverPlan =
  | { status: "clear" }
  | { status: "takeover"; stopBackend: "systemd" | "tmux"; owned: string[] }
  | { status: "refused"; reason: string };

/**
 * Fenced takeover: never a permission to launch a second stack, only a
 * plan to stop the conflicting owner and verify it is gone before the
 * caller starts anything. Mixed stacks and unknown backends are not
 * take-over-able: the operator must resolve them explicitly.
 */
export function planFencedTakeover(request: StackStartRequest): FencedTakeoverPlan {
  const { requested, active } = request;
  if (active.backend === "none" || active.backend === requested) return { status: "clear" };
  if (active.backend === "unknown") {
    return { status: "refused", reason: `takeover refused: backend ownership is unknown (${active.probeErrors.join("; ")})` };
  }
  if (active.backend === "mixed") {
    return { status: "refused", reason: "takeover refused: both backends own live components; stop one stack explicitly first" };
  }
  return {
    status: "takeover",
    stopBackend: active.backend,
    owned: active.backend === "systemd" ? active.systemdUnits : active.tmuxSessions,
  };
}

// ── Tunnel ownership ──────────────────────────────────────────────────

export interface TunnelObservation {
  /** Observed owner from BackendSnapshot: which backend owns the tunnel unit/session. */
  owningBackend: "systemd" | "tmux" | "none" | "unknown";
  /** Tunnel health port observed listening (e.g. 8080), if any. */
  healthPort?: number;
  /** Application-level channel state (from probeTunnelChannel in service.ts). */
  channelOperational?: boolean;
  /** Profile the observed tunnel was started with, when known. */
  profile?: string;
  /** Configured MCP target the observed tunnel points at, when known. */
  mcpTarget?: string;
  /** Own lookup errors; never conflate with absence. */
  probeErrors?: string[];
}

export interface TunnelExpectation {
  requestedBackend: "systemd" | "tmux";
  expectedProfile: string;
  expectedMcpTarget: string;
  healthPort: number;
}

export type TunnelReuseDecision = { ok: true; reason: string } | { ok: false; reason: string };

/**
 * Decide whether an existing tunnel may be reused. A process-alive tunnel with
 * a disabled channel, a foreign backend owner, a mismatched profile/MCP
 * target, or an unrelated daemon on the same port must never be assumed to
 * belong to this deployment. No bypass: reuse requires all four checks.
 */
export function decideTunnelReuse(observation: TunnelObservation, expected: TunnelExpectation): TunnelReuseDecision {
  if (observation.owningBackend === "unknown") {
    return { ok: false, reason: `refusing tunnel reuse: tunnel ownership unknown (${(observation.probeErrors ?? []).join("; ") || "probe unavailable"}); refusing to assume an unrelated daemon belongs to this deployment` };
  }
  if (observation.owningBackend === "none") {
    return { ok: false, reason: "no existing tunnel; start a new tunnel (not a reuse)" };
  }
  if (observation.owningBackend !== expected.requestedBackend) {
    return {
      ok: false,
      reason: `refusing tunnel reuse: tunnel owned by ${observation.owningBackend} backend but ${expected.requestedBackend} launch requested; stop the foreign tunnel first (fenced takeover)`,
    };
  }
  if (observation.healthPort !== undefined && observation.healthPort !== expected.healthPort) {
    return { ok: false, reason: `refusing tunnel reuse: observed tunnel on port ${observation.healthPort}, expected ${expected.healthPort}` };
  }
  if (observation.profile !== undefined && observation.profile !== expected.expectedProfile) {
    return { ok: false, reason: `refusing tunnel reuse: observed profile ${observation.profile}, expected ${expected.expectedProfile}` };
  }
  if (observation.mcpTarget !== undefined && observation.mcpTarget !== expected.expectedMcpTarget) {
    return { ok: false, reason: `refusing tunnel reuse: observed MCP target ${observation.mcpTarget}, expected ${expected.expectedMcpTarget}` };
  }
  if (observation.channelOperational !== true) {
    return { ok: false, reason: `refusing tunnel reuse: main MCP channel is not operational; a process-alive tunnel with a disabled channel must be recovered, not reused` };
  }
  return { ok: true, reason: `tunnel owned by ${observation.owningBackend}, profile ${expected.expectedProfile}, target ${expected.expectedMcpTarget}, channel operational — safe to reuse` };
}

// ── Aggregate status ──────────────────────────────────────────────────

export type LifecycleVerdict = "READY" | "RUNNING" | "DEGRADED" | "BLOCKED" | "STOPPED";

export interface ComponentLiveness {
  name: string;
  required: boolean;
  /** Observed live (systemd active / tmux session present). */
  active: boolean;
  /** Observed failed (systemd failed state, crash loop, permanent refusal). */
  failed: boolean;
  detail?: string;
}

export interface AggregateStatusInput {
  components: ComponentLiveness[];
  /** True when the core answered readiness with the exact expected identity. */
  coreReady: boolean;
  /** Permanent failure signatures, e.g. schema-incompatibility refusal. */
  permanentFailures?: string[];
}

export interface AggregateStatus {
  verdict: LifecycleVerdict;
  reasons: string[];
}

export function aggregateLifecycleStatus(input: AggregateStatusInput): AggregateStatus {
  const reasons: string[] = [];
  const required = input.components.filter((c) => c.required);
  const activeRequired = required.filter((c) => c.active);
  const failedRequired = required.filter((c) => c.failed);
  const core = input.components.find((c) => c.name === "core") ?? null;

  if ((input.permanentFailures ?? []).length > 0) {
    for (const failure of input.permanentFailures ?? []) reasons.push(failure);
    return { verdict: "BLOCKED", reasons };
  }
  if (failedRequired.length > 0) {
    for (const c of failedRequired) reasons.push(`${c.name} failed${c.detail ? `: ${c.detail}` : ""}`);
    const tunnelAlive = input.components.some((c) => c.name !== "core" && c.active);
    if (core && !core.active && tunnelAlive) {
      reasons.push("core is down while auxiliary components remain alive; the control plane is not functioning end to end");
    }
    // A failed core is BLOCKED (needs operator action); a failed auxiliary
    // with a live core is DEGRADED (the core still serves).
    if (core && core.failed) return { verdict: "BLOCKED", reasons };
    return { verdict: "DEGRADED", reasons };
  }
  if (required.length > 0 && activeRequired.length === 0) {
    reasons.push("no required components are active");
    return { verdict: "STOPPED", reasons };
  }
  if (activeRequired.length < required.length) {
    for (const c of required.filter((c) => !c.active)) reasons.push(`${c.name} is not active`);
    return { verdict: "DEGRADED", reasons };
  }
  if (!input.coreReady) {
    reasons.push("core is active but has not confirmed readiness with the exact expected identity");
    return { verdict: "RUNNING", reasons };
  }
  // "active" is the evidence-accurate word for auxiliaries: only the core
  // has a protocol-level readiness proof. Per-component qualification
  // (endpoint reachability vs systemd-state-only) is reported alongside.
  reasons.push("core readiness verified; all required components active");
  return { verdict: "READY", reasons };
}

// ── Failure classification ────────────────────────────────────────────

/**
 * Exit code for deterministic configuration failures (schema/build
 * incompatibility). Mirrors sysexits EX_CONFIG so operators recognize it,
 * and — crucially — is listed in the unit's RestartPreventExitStatus so
 * systemd stops retrying what will never succeed instead of burning the
 * start budget (the 9:06–9:07 AM crash loop).
 */
export const SCHEMA_INCOMPATIBLE_EXIT_CODE = 78;

/** Exit codes that must never be retried: retrying cannot change the outcome. */
export const PERMANENT_CONFIG_EXIT_CODES: ReadonlySet<number> = new Set([SCHEMA_INCOMPATIBLE_EXIT_CODE]);

const PERMANENT_FAILURE_SIGNATURES = [
  /newer than this candidate can read/i,
  /refusing startup before mutation/i,
  /database schema .* exceeds .* read limit/i,
];

export function isPermanentConfigFailure(observation: { exitCode?: number; stderr?: string }): boolean {
  if (observation.exitCode !== undefined && PERMANENT_CONFIG_EXIT_CODES.has(observation.exitCode)) return true;
  const stderr = observation.stderr ?? "";
  return PERMANENT_FAILURE_SIGNATURES.some((pattern) => pattern.test(stderr));
}

// ── Candidate preflight ───────────────────────────────────────────────

export interface CandidateCompatibility {
  buildId: string;
  schemaVersion: number;
  minReadableSchemaVersion: number;
  maxReadableSchemaVersion: number;
}

export type PreflightResult = { compatible: true } | { compatible: false; reason: string };

/**
 * Decide whether a candidate artifact may open the live database, without
 * mutating anything. A candidate whose maximum readable schema is below the
 * live database schema must be rejected before any unit rewrite, process
 * start, or migration — this is the check whose absence left the obsolete
 * 113 build crash-looping against the schema-116 database.
 */
export function preflightArtifactCompatibility(candidate: CandidateCompatibility, dbSchemaVersion: number): PreflightResult {
  if (!Number.isInteger(dbSchemaVersion) || dbSchemaVersion < 0) {
    return { compatible: false, reason: `cannot preflight candidate ${candidate.buildId}: live database schema is unreadable (${String(dbSchemaVersion)})` };
  }
  if (dbSchemaVersion > candidate.maxReadableSchemaVersion) {
    return {
      compatible: false,
      reason: `refusing candidate ${candidate.buildId}: database schema ${dbSchemaVersion} exceeds candidate read limit ${candidate.maxReadableSchemaVersion}. The active generation was left untouched.`,
    };
  }
  if (dbSchemaVersion < candidate.minReadableSchemaVersion) {
    return {
      compatible: false,
      reason: `refusing candidate ${candidate.buildId}: database schema ${dbSchemaVersion} predates candidate minimum readable schema ${candidate.minReadableSchemaVersion}. The active generation was left untouched.`,
    };
  }
  return { compatible: true };
}

// ── Live probes (injectable for tests) ────────────────────────────────

/**
 * Real systemd probe. Exit 0 with parseable output is the only success;
 * any other outcome (missing binary, dead bus, denied access) is
 * `unavailable`, never evidence of an empty stack.
 */
export function listActiveSystemdUnits(): ProbeOutcome {
  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync("systemctl", ["--user", "list-units", "--type=service,target", "--state=active", "--no-legend", "--plain"], { encoding: "utf8" });
  } catch (error) {
    return { status: "unavailable", reason: `systemctl could not be executed: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (result.status !== 0) {
    return { status: "unavailable", reason: `systemctl list-units exited ${String(result.status ?? "unknown")}: ${String(result.stderr ?? "").trim().slice(0, 200)}` };
  }
  return {
    status: "ok",
    names: String(result.stdout ?? "")
      .split("\n")
      .map((line) => line.trim().split(/\s+/)[0] ?? "")
      .filter(Boolean),
  };
}

/**
 * Real tmux probe. Exit 0 lists sessions; exit 1 reporting "no server
 * running" (no daemon at all) or "no sessions" (daemon alive, zero
 * sessions) means a genuinely empty backend. Any other outcome (missing
 * binary, socket errors) is `unavailable`, never evidence of emptiness.
 */
export function listTmuxSessions(): ProbeOutcome {
  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync("tmux", ["list-sessions", "-F", "#{session_name}"], { encoding: "utf8" });
  } catch (error) {
    return { status: "unavailable", reason: `tmux could not be executed: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (result.status === 0) {
    return { status: "ok", names: String(result.stdout ?? "").split("\n").map((line) => line.trim()).filter(Boolean) };
  }
  const stderr = String(result.stderr ?? "");
  if (result.status === 1 && /no server running|no sessions/i.test(stderr)) return { status: "ok", names: [] };
  return { status: "unavailable", reason: `tmux list-sessions exited ${String(result.status ?? "unknown")}: ${stderr.trim().slice(0, 200)}` };
}

export const liveProbes: LifecycleProbes = {
  listActiveSystemdUnits,
  listTmuxSessions,
};
