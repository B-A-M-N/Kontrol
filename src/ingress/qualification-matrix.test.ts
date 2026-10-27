import assert from "node:assert/strict";
import {
  evaluateIngressMatrix,
  observationFromHealthRecord,
  formatIngressMatrixReport,
  INGRESS_QUALIFICATION_SCENARIOS,
  observationEvidence,
  validateIngressMatrixObservation,
  type IngressMatrixGuardOutcome,
  type IngressMatrixObservation,
  type IngressMatrixScenario,
} from "./qualification-matrix.js";

// --- the catalog mirrors the audit's matrix ---
assert.equal(INGRESS_QUALIFICATION_SCENARIOS.length, 18, "the audit's matrix has 18 rows");
const ids = INGRESS_QUALIFICATION_SCENARIOS.map((scenario) => scenario.id);
assert.equal(new Set(ids).size, ids.length, "scenario ids are unique");
for (const scenario of INGRESS_QUALIFICATION_SCENARIOS) {
  assert.ok(scenario.expectation.length >= 3, `${scenario.id} states its expected evidence`);
  assert.ok(scenario.scope === "loopback" || scenario.scope === "tailnet" || scenario.scope === "public");
  assert.ok(scenario.deployment === true || scenario.scope === "loopback",
    `${scenario.id} is a deployment scenario unless it is a local source-level guard`);
  assert.ok(scenario.guards.length > 0, `${scenario.id} names a canonical source-level guard`);
  for (const guard of scenario.guards) {
    assert.ok(guard.command.length > 0 && guard.args.length > 0);
    assert.ok(guard.tier === "unit" || guard.tier === "local_integration",
      `${scenario.id} guards never claim a deployment tier`);
  }
}

// --- a passing local guard qualifies a local scenario ---
{
  const scenario: IngressMatrixScenario = {
    id: "local-case",
    title: "local",
    area: "security",
    expectation: "local expectation",
    scope: "loopback",
    tier: "unit",
    deployment: false,
    guards: [{ command: "node", args: ["local.test.mjs"], tier: "unit" }],
  };
  const guards = new Map<string, IngressMatrixGuardOutcome[]>([
    ["local-case", [{ command: "node local.test.mjs", passed: true, exitCode: 0 }]],
  ]);
  const report = evaluateIngressMatrix({ scenarios: [scenario], guards, generatedAt: "2026-10-25T00:00:00.000Z" });
  assert.equal(report.scenarios[0]?.status, "pass");
  assert.equal(report.scenarios[0]?.evidenceTier, "unit");
  assert.equal(report.scenarios[0]?.evidenceScope, "loopback");
  assert.equal(report.qualified, true);
  assert.equal(report.blockers.length, 0);
}

// --- a failing guard fails the scenario and blocks qualification ---
{
  const scenario: IngressMatrixScenario = {
    id: "failing-case",
    title: "failing",
    area: "security",
    expectation: "failing expectation",
    scope: "loopback",
    tier: "unit",
    deployment: false,
    guards: [{ command: "node", args: ["fail.test.mjs"], tier: "unit" }],
  };
  const guards = new Map<string, IngressMatrixGuardOutcome[]>([
    ["failing-case", [{ command: "node fail.test.mjs", passed: false, exitCode: 1, failureClass: "source_guard_failed" }]],
  ]);
  const report = evaluateIngressMatrix({ scenarios: [scenario], guards });
  assert.equal(report.scenarios[0]?.status, "fail");
  assert.equal(report.scenarios[0]?.failureClass, "source_guard_failed");
  assert.equal(report.qualified, false);
  assert.equal(report.blockers.length, 1);
  assert.equal(report.tierSummary.unit.failed, 1);
}

// --- a local guard can never qualify a deployment scenario ---
{
  const scenario: IngressMatrixScenario = {
    id: "deployment-case",
    title: "deployment",
    area: "availability",
    expectation: "deployment expectation",
    scope: "public",
    tier: "public_internet",
    deployment: true,
    guards: [{ command: "node", args: ["guard.test.mjs"], tier: "unit" }],
  };
  const guards = new Map<string, IngressMatrixGuardOutcome[]>([
    ["deployment-case", [{ command: "node guard.test.mjs", passed: true, exitCode: 0 }]],
  ]);
  const report = evaluateIngressMatrix({ scenarios: [scenario], guards });
  assert.equal(report.scenarios[0]?.status, "source_verified",
    "a passing source guard is a regression guard, not a public qualification");
  assert.equal(report.qualified, false);
  assert.match(report.blockers[0] ?? "", /public_internet\/public evidence is still required/);
}

// --- a deployment observation at the right tier qualifies the scenario ---
{
  const scenario: IngressMatrixScenario = {
    id: "observed-case",
    title: "observed",
    area: "availability",
    expectation: "observed expectation",
    scope: "public",
    tier: "public_internet",
    deployment: true,
    guards: [],
  };
  const observation: IngressMatrixObservation = {
    scenarioId: "observed-case",
    outcome: "pass",
    endpoint: "https://kontrol.example.com",
    observedAt: "2026-10-25T00:00:00.000Z",
    profileId: "bridge-1",
    listener: "public_oauth_listener:7678",
    principalClass: "owner_public",
    sessionIdentityHash: "b".repeat(64),
    operationId: "op-123",
    buildId: "build-123",
  };
  const report = evaluateIngressMatrix({ scenarios: [scenario], observations: [observation] });
  assert.equal(report.scenarios[0]?.status, "pass");
  assert.equal(report.scenarios[0]?.evidenceTier, "public_internet");
  assert.equal(report.scenarios[0]?.evidenceScope, "public");
  assert.equal(report.qualified, true);
}

// --- a tailnet observation never qualifies a public scenario and vice versa ---
{
  const scenario: IngressMatrixScenario = {
    id: "scope-case",
    title: "scope",
    area: "mapping",
    expectation: "scope expectation",
    scope: "public",
    tier: "public_internet",
    deployment: true,
    guards: [],
  };
  const tailnet = evaluateIngressMatrix({
    scenarios: [scenario],
    observations: [{
      scenarioId: "scope-case",
      outcome: "pass",
      endpoint: "https://node.tail8d285a.ts.net:8443",
      observedAt: "2026-10-25T00:00:00.000Z",
    }],
  });
  assert.equal(tailnet.scenarios[0]?.status, "unverified");
  assert.match(tailnet.scenarios[0]?.reason ?? "", /does not qualify the required tier/);

  const loopback = evaluateIngressMatrix({
    scenarios: [scenario],
    observations: [{
      scenarioId: "scope-case",
      outcome: "pass",
      endpoint: "http://127.0.0.1:7678",
      observedAt: "2026-10-25T00:00:00.000Z",
    }],
  });
  assert.equal(loopback.scenarios[0]?.status, "unverified",
    "a loopback observation cannot qualify a public scenario");
}

// --- a failed deployment observation fails the scenario ---
{
  const scenario: IngressMatrixScenario = {
    id: "failed-observation",
    title: "failed",
    area: "transport",
    expectation: "failed expectation",
    scope: "public",
    tier: "public_internet",
    deployment: true,
    guards: [],
  };
  const report = evaluateIngressMatrix({
    scenarios: [scenario],
    observations: [{
      scenarioId: "failed-observation",
      outcome: "fail",
      endpoint: "https://kontrol.example.com",
      observedAt: "2026-10-25T00:00:00.000Z",
      failureClass: "sse_idle_timeout",
    }],
  });
  assert.equal(report.scenarios[0]?.status, "fail");
  assert.equal(report.scenarios[0]?.failureClass, "sse_idle_timeout");
  assert.equal(report.qualified, false);
}

// --- a skipped toolchain guard leaves the scenario unverified, never passing ---
{
  const scenario: IngressMatrixScenario = {
    id: "toolchain-case",
    title: "toolchain",
    area: "security",
    expectation: "toolchain expectation",
    scope: "loopback",
    tier: "local_integration",
    deployment: false,
    guards: [{ command: "caddy", args: ["validate"], tier: "local_integration", toolchain: { binary: "caddy" } }],
  };
  const guards = new Map<string, IngressMatrixGuardOutcome[]>([
    ["toolchain-case", [{ command: "caddy validate", passed: false, skipped: true, failureClass: "toolchain_unavailable" }]],
  ]);
  const report = evaluateIngressMatrix({ scenarios: [scenario], guards });
  assert.equal(report.scenarios[0]?.status, "unverified");
  assert.notEqual(report.scenarios[0]?.status, "pass");
  assert.equal(report.qualified, false);
}

// --- observation validation rejects credential-bearing or malformed evidence ---
{
  assert.throws(() => validateIngressMatrixObservation({
    scenarioId: "x",
    outcome: "pass",
    endpoint: "https://user:secret@example.com",
    observedAt: "2026-10-25T00:00:00.000Z",
  }), /credential-free/);
  assert.throws(() => validateIngressMatrixObservation({
    scenarioId: "x",
    outcome: "pass",
    endpoint: "https://example.com",
    observedAt: "2026-10-25T00:00:00.000Z",
    notes: "Authorization: Bearer abc123",
  }), /credential material/);
  assert.throws(() => validateIngressMatrixObservation({
    scenarioId: "x",
    outcome: "pass",
    endpoint: "https://example.com",
    observedAt: "not-a-date",
  }), /observedAt/);
  assert.throws(() => validateIngressMatrixObservation({
    scenarioId: "x",
    outcome: "pass",
    endpoint: "https://example.com",
    observedAt: "2026-10-25T00:00:00.000Z",
    unexpected: true,
  }), /unsupported field/);
  const ok = validateIngressMatrixObservation({
    scenarioId: "x",
    outcome: "pass",
    endpoint: "https://example.com",
    observedAt: "2026-10-25T00:00:00.000Z",
    sessionIdentityHash: "c".repeat(64),
  });
  assert.equal(ok.scenarioId, "x");
}

// --- observation scope and tier are derived from the contacted origin ---
{
  assert.deepEqual(observationEvidence({
    scenarioId: "x", outcome: "pass", endpoint: "https://kontrol.example.com", observedAt: "2026-10-25T00:00:00.000Z",
  }), { scope: "public", tier: "public_internet" });
  assert.deepEqual(observationEvidence({
    scenarioId: "x", outcome: "pass", endpoint: "https://node.tail8d285a.ts.net:8443", observedAt: "2026-10-25T00:00:00.000Z",
  }), { scope: "tailnet", tier: "real_tailnet" });
  assert.deepEqual(observationEvidence({
    scenarioId: "x", outcome: "pass", endpoint: "https://kontrol.example.com", observedAt: "2026-10-25T00:00:00.000Z", operational: true,
  }), { scope: "public", tier: "operational" });
  assert.deepEqual(observationEvidence({
    scenarioId: "x", outcome: "pass", endpoint: "not-a-url", observedAt: "2026-10-25T00:00:00.000Z",
  }), { scope: null, tier: "unit" });
}

// --- a durable health observation converts into matrix evidence ---
{
  const observation = observationFromHealthRecord({
    profileId: "bridge-1",
    listener: "public_oauth_listener",
    buildId: "build-123",
    probeOrigin: "https://kontrol.example.com/",
    principalClass: "owner_public",
    state: "READY",
    observedAt: "2026-10-25T00:00:00.000Z",
    checks: { externalHttps: true, mcpInitialize: true, toolsList: true, sse: true },
    metrics: { latencyMs: 42 },
    sessionIdentityHash: "d".repeat(64),
  }, "funnel-public-authenticated");
  assert.equal(observation.outcome, "pass");
  assert.equal(observation.endpoint, "https://kontrol.example.com/");
  assert.deepEqual(observationEvidence(observation), { scope: "public", tier: "public_internet" });

  const failed = observationFromHealthRecord({
    profileId: "bridge-1",
    probeOrigin: "https://kontrol.example.com/",
    principalClass: "owner_public",
    state: "DEGRADED",
    observedAt: "2026-10-25T00:00:00.000Z",
    checks: { externalHttps: true, sse: false },
    failureClass: "sse_idle_timeout",
  }, "sse-idle-timeout-and-45s-post");
  assert.equal(failed.outcome, "fail");
  assert.equal(failed.failureClass, "sse_idle_timeout");
}

// --- duplicate observations are refused ---
{
  const scenario: IngressMatrixScenario = {
    id: "dup", title: "dup", area: "durability", expectation: "dup expectation",
    scope: "loopback", tier: "unit", deployment: false, guards: [],
  };
  const observation: IngressMatrixObservation = {
    scenarioId: "dup", outcome: "pass", endpoint: "http://127.0.0.1:7678", observedAt: "2026-10-25T00:00:00.000Z",
  };
  assert.throws(() => evaluateIngressMatrix({ scenarios: [scenario], observations: [observation, observation] }), /duplicate/);
}

// --- the report renders a readable status line ---
{
  const report = evaluateIngressMatrix({ scenarios: [INGRESS_QUALIFICATION_SCENARIOS[0]!] });
  const rendered = formatIngressMatrixReport(report);
  assert.match(rendered, /ingress qualification matrix: NOT QUALIFIED/);
  assert.match(rendered, /serve-mapping-exact-match/);
}

console.log("qualification-matrix: all assertions passed");
