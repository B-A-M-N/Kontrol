#!/usr/bin/env node
/**
 * Multipath ingress qualification harness (audit §6).
 *
 * Runs the audit's adversarial matrix as a REPEATABLE qualification harness
 * instead of a collection of manually interpreted logs:
 *
 *   - every scenario's canonical source-level guard runs as its own child
 *     process, so one scenario's timers, HTTP servers, or durable state can
 *     never make the next scenario appear healthy by accident;
 *   - deployment observations (real tailnet / real public-internet evidence)
 *     are ingested from an operator-supplied evidence file and are never
 *     invented by the harness;
 *   - the evidence tier of every observation is DERIVED from the origin it
 *     was collected against, so a loopback result can never be recorded as
 *     public-internet evidence and a lower tier can never satisfy a higher
 *     claim.
 *
 * The report is a bounded, redacted artifact: no credentials, no response
 * bodies, no project content.
 *
 * Exit code:
 *   0 — every scenario passed (the matrix is qualified)
 *   1 — at least one scenario failed
 *   2 — at least one scenario is unverified (evidence is still missing)
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { testHarnessEnvironment } from "./lib/tool-environment.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

function option(name, fallback) {
  const args = process.argv.slice(2);
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1];
}

const evidencePath = option("--evidence");
const reportPath = resolve(option("--report", join(root, "ingress-qualification-matrix.json")));
const only = (option("--only", "") ?? "").split(",").map((value) => value.trim()).filter(Boolean);
const skip = (option("--skip", "") ?? "").split(",").map((value) => value.trim()).filter(Boolean);
const guardTimeoutMs = Number(option("--guard-timeout-ms", "600000"));

/** The matrix catalog and evaluation rule live in the server source tree so
 * the Workspace App, the CLI, and this harness share one implementation. */
const { INGRESS_QUALIFICATION_SCENARIOS, evaluateIngressMatrix, formatIngressMatrixReport, observationFromHealthRecord, validateIngressMatrixObservation } =
  await import(new URL("../src/ingress/qualification-matrix.ts", import.meta.url));

function resolveToolchainBinary(binary, envVar) {
  const override = envVar ? process.env[envVar] : undefined;
  if (override) return override.trim();
  const paths = (process.env.PATH ?? "").split(":").filter(Boolean);
  for (const directory of paths) {
    const candidate = join(directory, binary);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function runGuard(guard) {
  if (guard.toolchain) {
    const binary = resolveToolchainBinary(guard.toolchain.binary, guard.toolchain.envVar);
    if (!binary) {
      return {
        command: `${guard.command} ${guard.args.join(" ")}`,
        passed: false,
        skipped: true,
        failureClass: "toolchain_unavailable",
        detail: `${guard.toolchain.binary} is not available on PATH`,
      };
    }
  }
  const startedAt = Date.now();
  const result = spawnSync(guard.command, guard.args, {
    cwd: root,
    env: testHarnessEnvironment(process.env, { overrides: { KONTROL_INGRESS_QUALIFICATION: "1" } }),
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    timeout: guardTimeoutMs,
  });
  const passed = result.status === 0 && result.signal === null;
  const stderr = (result.stderr ?? "").split("\n").filter(Boolean).slice(-3).join(" | ").slice(0, 500);
  return {
    command: `${guard.command} ${guard.args.join(" ")}`,
    passed,
    exitCode: result.status,
    signal: result.signal,
    durationMs: Date.now() - startedAt,
    failureClass: passed ? undefined : "source_guard_failed",
    detail: passed ? undefined : stderr,
  };
}

/**
 * Load deployment evidence.
 *
 * Two operator shapes are accepted:
 *   - a matrix observation (or an array of them);
 *   - a durable ingress health record (the artifact the bridge/tailnet
 *     probes write), converted into matrix evidence without the operator
 *     restating a field.
 */
function loadObservations() {
  if (!evidencePath) return [];
  const absolute = resolve(evidencePath);
  if (!existsSync(absolute)) throw new Error(`evidence file not found: ${absolute}`);
  const parsed = JSON.parse(readFileSync(absolute, "utf8"));
  const records = Array.isArray(parsed) ? parsed : parsed.observations ?? [parsed];
  return records.map((record) => {
    if (record && typeof record === "object" && "probeOrigin" in record && !("endpoint" in record)) {
      // A durable health record: attach it to the deployment scenario whose
      // expectation the probe's checks cover.
      const scenarioId = record.scenarioId ?? healthRecordScenario(record);
      return observationFromHealthRecord(record, scenarioId);
    }
    return validateIngressMatrixObservation(record);
  });
}

/**
 * Map a health record onto the matrix scenario its evidence covers. The
 * mapping is by observed capability, not by operator choice, so a health
 * record cannot be attached to an unrelated scenario.
 */
function healthRecordScenario(record) {
  const checks = record.checks ?? {};
  if (checks.externalHttps === false) return "external-tls-or-dns-failure";
  if (checks.sse === false || checks.longPost === false) return "sse-idle-timeout-and-45s-post";
  if (record.principalClass === "owner_public" && checks.externalHttps === true) return "funnel-public-authenticated";
  throw new Error("health evidence could not be mapped to a matrix scenario");
}

const observations = loadObservations();
const observationsByScenario = new Map(observations.map((observation) => [observation.scenarioId, observation]));
const scenarios = INGRESS_QUALIFICATION_SCENARIOS.filter((scenario) => {
  if (only.length > 0 && !only.includes(scenario.id)) return false;
  if (skip.includes(scenario.id)) return false;
  return true;
});

const guards = new Map();
for (const scenario of scenarios) {
  console.log(`[ingress-qualification] ${scenario.id}: running ${scenario.guards.length} source guard(s)`);
  const outcomes = scenario.guards.map((guard) => runGuard(guard));
  guards.set(scenario.id, outcomes);
  for (const outcome of outcomes) {
    console.log(`[ingress-qualification] ${scenario.id}: ${outcome.skipped ? "SKIP" : outcome.passed ? "PASS" : "FAIL"} ${outcome.command}`);
  }
}

const buildMetaPath = join(root, "dist", "build-meta.json");
let buildId = process.env.KONTROL_BUILD_ID ?? null;
if (!buildId && existsSync(buildMetaPath)) {
  try {
    buildId = JSON.parse(readFileSync(buildMetaPath, "utf8")).buildId ?? null;
  } catch {
    buildId = null;
  }
}
const configSha256 = observations
  .map((observation) => observation.configSha256)
  .find((value) => typeof value === "string") ?? null;

const report = evaluateIngressMatrix({
  scenarios,
  guards,
  observations: scenarios
    .map((scenario) => observationsByScenario.get(scenario.id))
    .filter((observation) => observation !== undefined),
  buildId,
  configSha256,
});

mkdirSync(dirname(reportPath), { recursive: true, mode: 0o700 });
const temporary = `${reportPath}.tmp-${process.pid}`;
writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
renameSync(temporary, reportPath);

console.log(formatIngressMatrixReport(report));
console.log(`[ingress-qualification] report: ${reportPath}`);

if (report.scenarios.some((scenario) => scenario.status === "fail")) process.exitCode = 1;
else if (!report.qualified) process.exitCode = 2;
