import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { validateBetaExternalCatalogReceipt } from "../scripts/beta-external-catalog-contract.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const fixture = mkdtempSync(join(tmpdir(), "kontrol-beta-final-"));
const fakeBin = join(fixture, "bin");
const codeReceiptPath = join(fixture, "beta-code.json");
const soakReportPath = join(fixture, "beta-soak.json");
const externalCatalogReceiptPath = join(fixture, "beta-external-catalog.json");
const receiptPath = join(fixture, "beta-final.json");
const sha = "a".repeat(40);
const buildId = "candidate-build";
const contentSha256 = "b".repeat(64);
const expectedMcpVersion = `1.0.4+${contentSha256}`;
const workspaceAppUri = "ui://kontrol/workspace-app-abcdef123456.html";
const workspaceAppCompatibilityUri = "ui://kontrol/workspace-app-abcdef123456.skybridge.html";
const requiredTools = ["read", "grep", "glob", "ls", "git_status", "git_log", "git_diff", "git_show", "poll_process"];
const catalogTools = [...requiredTools, "open_workspace", "show_workspace_ui"];
const inputProperties = {
  read: ["workspaceId", "path", "approvalResumeId"],
  grep: ["workspaceId", "pattern", "approvalResumeId"],
  glob: ["workspaceId", "pattern", "approvalResumeId"],
  ls: ["workspaceId", "path", "approvalResumeId"],
  git_status: ["workspaceId", "path", "approvalResumeId"],
  git_log: ["workspaceId", "path", "approvalResumeId"],
  git_diff: ["workspaceId", "path", "approvalResumeId"],
  git_show: ["workspaceId", "path", "approvalResumeId"],
  poll_process: ["workspaceId", "sessionId"],
  open_workspace: ["path", "mode", "baseRef"],
  show_workspace_ui: ["workspaceId"],
};
const toolMetadata = catalogTools.map((name) => ({
  name,
  inputFields: {
    properties: [...inputProperties[name]].sort(),
    required: (name === "open_workspace" ? ["path"] : name === "poll_process" ? ["workspaceId", "sessionId"] : name === "show_workspace_ui" ? ["workspaceId"] : ["workspaceId"]).sort(),
    types: Object.fromEntries(inputProperties[name].sort().map((field) => [field, field === "mode" ? "anyOf" : "string"]).sort(([a], [b]) => a.localeCompare(b))),
  },
  ...(name === "show_workspace_ui" ? { resourceUri: workspaceAppUri, visibility: ["model"], legacyOutputTemplate: workspaceAppCompatibilityUri } : {}),
}));
mkdirSync(fakeBin, { recursive: true });
const fakeGit = join(fakeBin, "git");
writeFileSync(fakeGit, "#!/bin/sh\ncase \"$1 $2\" in\n  'rev-parse HEAD') printf '%s\\n' '" + sha + "' ;;\n  'status --porcelain') ;;\n  *) exit 1 ;;\nesac\n");
chmodSync(fakeGit, 0o755);

const code = {
  codeQualified: true,
  faultMatrix: { buildId, qualified: true, cases: [{ id: "supervised-mission-loop", passed: true }] },
  candidate: {
    buildId,
    artifactPath: "/immutable/releases/candidate-build",
    metadata: { buildId, version: "1.0.4", contentSha256, gitSha: sha, gitDirty: 0 },
  },
  source: {
    started: { gitSha: sha, dirtyPaths: [] },
    finished: { gitSha: sha, dirtyPaths: [] },
  },
};
const assertions = {
  noUnexpectedCoreRestarts: true,
  noUnexpectedSupervisorRestarts: true,
  noUnexpectedTunnelRestarts: true,
  noUnexpectedAdapterRestarts: true,
  noRestartFailures: true,
  noOrphanedApprovals: true,
  noPendingApprovalRows: true,
  noLivePolicyWaiters: true,
  noLeakedProcessSessions: true,
  diagnosticsContract: true,
  tunnelEndpointsHealthy: true,
  databaseIntegrityHealthy: true,
  noMaintenanceError: true,
  schemaConsistent: true,
  buildIdentityConsistent: true,
  sourceIdentityConsistent: true,
  continuityBounded: true,
  resourceAdmissionRecovered: true,
  expiredHandlerAccounting: true,
  approvalContinuityCapable: true,
  conversationContinuityProven: true,
  supervisedMissionLoopQualified: true,
};
const soak = {
  status: "passed",
  requestedHours: 12,
  startedAt: "2026-08-27T00:00:00.000Z",
  finishedAt: "2026-08-27T12:00:00.000Z",
  expectedBuildId: buildId,
  monitoring: { diagnosticsRequired: true, tunnelRequired: true },
  snapshots: {
    started: { buildId, gitSha: sha, gitDirty: 0, generation: { activeBuildId: buildId } },
    finished: { buildId, gitSha: sha, gitDirty: 0, generation: { activeBuildId: buildId } },
  },
  assertions,
  targetUrl: "https://kontrol.example.trycloudflare.com",
};
const externalCatalog = {
  kind: "kontrol-external-catalog-probe",
  status: "passed",
  expectedBuildId: buildId,
  expectedMcpVersion,
  serverInfoVersion: expectedMcpVersion,
  hostCatalogVersion: expectedMcpVersion,
  serverTools: catalogTools,
  hostTools: catalogTools,
  serverToolMetadata: toolMetadata,
  hostToolMetadata: toolMetadata,
  workspaceApp: {
    deployedResourceUri: workspaceAppUri,
    deployedCompatibilityUri: workspaceAppCompatibilityUri,
    hostRendererResourceUri: workspaceAppUri,
    hostRendererCompatibilityUri: workspaceAppCompatibilityUri,
    hostRendererUrisMatchCandidate: true,
    resources: [{
      uri: workspaceAppUri,
      mimeType: "text/html;profile=mcp-app",
      htmlBytes: 1234,
      listed: true,
      read: true,
    }, {
      uri: workspaceAppCompatibilityUri,
      mimeType: "text/html+skybridge",
      htmlBytes: 1234,
      listed: true,
      read: true,
    }],
  },
  catalogParity: true,
  inputSchemaParity: true,
  hostCapture: {
    source: "operator_supplied",
    captureId: "capture-fixture-1",
    machineVerified: false,
    sha256: "c".repeat(64),
  },
  liveServerProbe: {
    source: "fresh_http_initialize_and_tools_list",
    machineVerified: true,
    startedAt: "2026-08-27T12:05:00.000Z",
    finishedAt: "2026-08-27T12:06:00.000Z",
    url: "https://kontrol.example.trycloudflare.com",
  },
  hostCatalogEvidenceSource: "operator_supplied",
  hostCatalogMachineVerified: false,
  liveServerProbeMachineVerified: true,
  dualSession: true,
  heartbeatCountPerSession: 2,
  heartbeatBytesObserved: 4,
  drainRecoveryEvents: 2,
  resourceLoadReads: 2,
  boundedInspectionCalls: 8,
  postHeartbeat: {
    method: "POST",
    tool: "await_workspace_events",
    requestedWaitMs: 45_000,
    durationMs: 45_010,
    heartbeatCount: 3,
    terminalResponseReceived: true,
    contentType: "text/event-stream; charset=utf-8",
    diagnosticsVerified: true,
    heartbeatBytes: 60,
    responseBytes: 512,
    responseCloseClassification: "response_finished",
    handlerStillRunning: false,
    stalledWriterEvents: 0,
  },
  hostCatalogCapturedAt: "2026-08-27T12:04:00.000Z",
  startedAt: "2026-08-27T12:05:00.000Z",
  finishedAt: "2026-08-27T12:06:00.000Z",
  url: "https://kontrol.example.trycloudflare.com",
  cycles: 1,
};
assert.equal(validateBetaExternalCatalogReceipt(externalCatalog, {
  candidateBuildId: buildId,
  expectedMcpVersion,
  soak,
}).valid, true, "fresh matching host and server catalogs should qualify");
assert.equal(validateBetaExternalCatalogReceipt({
  ...externalCatalog,
  hostCatalogCapturedAt: "2026-08-26T23:59:00.000Z",
}, {
  candidateBuildId: buildId,
  expectedMcpVersion,
  soak,
}).valid, false, "a catalog captured before deployment must be rejected");
assert.equal(validateBetaExternalCatalogReceipt({
  ...externalCatalog,
  hostTools: [...requiredTools, "stale_tool"],
}, {
  candidateBuildId: buildId,
  expectedMcpVersion,
  soak,
}).valid, false, "missing or extra external tools must be rejected");
const hostToolsWithoutResumeId = toolMetadata.map((tool) => tool.name === "read" ? {
  ...tool,
  inputFields: {
    ...tool.inputFields,
    properties: tool.inputFields.properties.filter((field) => field !== "approvalResumeId"),
    types: Object.fromEntries(Object.entries(tool.inputFields.types).filter(([field]) => field !== "approvalResumeId")),
  },
} : tool);
assert.equal(validateBetaExternalCatalogReceipt({
  ...externalCatalog,
  hostToolMetadata: hostToolsWithoutResumeId,
}, {
  candidateBuildId: buildId,
  expectedMcpVersion,
  soak,
}).valid, false, "host schema dropping approvalResumeId must invalidate catalog evidence");
assert.equal(validateBetaExternalCatalogReceipt({
  ...externalCatalog,
  postHeartbeat: { ...externalCatalog.postHeartbeat, heartbeatCount: 1 },
}, {
  candidateBuildId: buildId,
  expectedMcpVersion,
  soak,
}).valid, false, "GET-only streaming evidence must not qualify without repeated POST SSE heartbeats");
assert.equal(validateBetaExternalCatalogReceipt({
  ...externalCatalog,
  boundedInspectionCalls: 7,
}, {
  candidateBuildId: buildId,
  expectedMcpVersion,
  soak,
}).valid, false, "the concurrent eight-call inspection evidence must be required");
assert.equal(validateBetaExternalCatalogReceipt({
  ...externalCatalog,
  workspaceApp: {
    ...externalCatalog.workspaceApp,
    hostRendererResourceUri: "ui://kontrol/workspace-app-deadbeefcafe.html",
    hostRendererUrisMatchCandidate: false,
  },
}, {
  candidateBuildId: buildId,
  expectedMcpVersion,
  soak,
}).valid, false, "a host-captured renderer hash from another bundle must be rejected");
assert.equal(validateBetaExternalCatalogReceipt({
  ...externalCatalog,
  workspaceApp: {
    ...externalCatalog.workspaceApp,
    resources: [{ ...externalCatalog.workspaceApp.resources[0], mimeType: "text/html" }],
  },
}, {
  candidateBuildId: buildId,
  expectedMcpVersion,
  soak,
}).valid, false, "Workspace App resource MIME mismatches must be rejected");

function runFinal(extraEnv = {}) {
  return spawnSync(process.execPath, ["scripts/beta-gate-final.mjs"], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: fakeBin + ":" + process.env.PATH,
      KONTROL_BETA_CODE_RECEIPT: codeReceiptPath,
      KONTROL_BETA_SOAK_REPORT: soakReportPath,
      KONTROL_BETA_EXTERNAL_CATALOG_RECEIPT: externalCatalogReceiptPath,
      KONTROL_BETA_RECEIPT: receiptPath,
      ...extraEnv,
    },
  });
}

try {
  writeFileSync(codeReceiptPath, JSON.stringify(code));
  writeFileSync(soakReportPath, JSON.stringify(soak));
  writeFileSync(externalCatalogReceiptPath, JSON.stringify(externalCatalog));
  const passed = runFinal();
  assert.equal(passed.status, 0, `status=${passed.status} error=${passed.error?.message ?? "none"}\n${passed.stdout}\n${passed.stderr}`);
  const qualifiedReceipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  assert.equal(qualifiedReceipt.qualified, true);
  assert.equal(qualifiedReceipt.stage, "combined");
  assert.equal(qualifiedReceipt.checks.externalCatalogFresh, true);
  assert.equal(qualifiedReceipt.externalCatalog.workspaceApp.valid, true);

  writeFileSync(codeReceiptPath, JSON.stringify({
    ...code,
    faultMatrix: { ...code.faultMatrix, cases: [] },
  }));
  const missingMissionLoop = runFinal();
  assert.notEqual(missingMissionLoop.status, 0, "the code receipt must include the supervised mission loop fault case");
  assert.equal(JSON.parse(readFileSync(receiptPath, "utf8")).checks.supervisedMissionLoopQualified, false);
  writeFileSync(codeReceiptPath, JSON.stringify(code));

  writeFileSync(soakReportPath, JSON.stringify({ ...soak, expectedBuildId: "different-build" }));
  const rejected = runFinal();
  assert.notEqual(rejected.status, 0, "a soak for a different build must not qualify");
  const rejectedReceipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  assert.equal(rejectedReceipt.qualified, false);
  assert.equal(rejectedReceipt.checks.soakIdentity, false);

  writeFileSync(soakReportPath, JSON.stringify(soak));
  writeFileSync(externalCatalogReceiptPath, JSON.stringify({
    ...externalCatalog,
    hostCatalogVersion: "1.0.3+stale",
  }));
  const staleHostCatalog = runFinal();
  assert.notEqual(staleHostCatalog.status, 0, "a stale external host catalog must not qualify the deployment");
  assert.equal(JSON.parse(readFileSync(receiptPath, "utf8")).checks.externalCatalogFresh, false);

  writeFileSync(externalCatalogReceiptPath, JSON.stringify({
    ...externalCatalog,
    hostCatalogCapturedAt: "2026-08-26T23:59:00.000Z",
  }));
  const preDeploymentCatalog = runFinal();
  assert.notEqual(preDeploymentCatalog.status, 0, "a host catalog captured before the candidate soak must not qualify");
  assert.equal(JSON.parse(readFileSync(receiptPath, "utf8")).checks.externalCatalogFresh, false);

  writeFileSync(externalCatalogReceiptPath, JSON.stringify(externalCatalog));

  writeFileSync(soakReportPath, JSON.stringify({
    ...soak,
    requestedHours: 2,
    finishedAt: "2026-08-27T02:00:00.000Z",
  }));
  const tooShort = runFinal();
  assert.notEqual(tooShort.status, 0, "the canonical gate must reject a soak shorter than 12 hours");
  const tooShortReceipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  assert.equal(tooShortReceipt.policy.minimumSoakHours, 12);
  assert.equal(tooShortReceipt.checks.soakDuration, false);

  const attemptedPolicyOverride = runFinal({ KONTROL_BETA_MIN_SOAK_HOURS: "1" });
  assert.notEqual(attemptedPolicyOverride.status, 0, "the environment must not lower the 12-hour stable-beta floor");
  const attemptedOverrideReceipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  assert.equal(attemptedOverrideReceipt.policy.minimumSoakHours, 12);
  assert.equal(attemptedOverrideReceipt.checks.soakDuration, false);

  writeFileSync(soakReportPath, JSON.stringify({
    ...soak,
    assertions: { noUnexpectedCoreRestarts: true },
  }));
  const incomplete = runFinal();
  assert.notEqual(incomplete.status, 0, "an incomplete soak assertion set must not qualify");
  const incompleteReceipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  assert.equal(incompleteReceipt.checks.soakAssertionsPass, false);
  assert.ok(incompleteReceipt.soak.missingAssertions.includes("databaseIntegrityHealthy"));
  console.log("beta-gate-final.test.mjs: candidate, soak, and fresh external catalog qualification passed");
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
