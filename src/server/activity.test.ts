/**
 * Finding 9: Kontrol-native activity surface. Mounts the REAL /activity
 * and /activity/data routes over loopback HTTP and asserts:
 * - the diagnostics-credential gate (403 without it, 200 with it),
 * - a real direct operation with no work session is projected with
 *   owner + tool + status + timing,
 * - operations from unattributed (foreign/unjoined) sessions are excluded,
 * - no raw arguments, commands, credentials, or outputs leak.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import type { Server } from "node:http";
import { loadConfig } from "../config.js";
import { handleActivityData, handleActivityPage } from "./activity.js";
import type { ActivityDeps } from "./activity.js";
import { McpOperationDiagnostics } from "./mcp-operation-diagnostics.js";
import type { McpSessionState } from "./mcp-session-state.js";

const root = mkdtempSync(join(tmpdir(), "kontrol-activity-test-"));
const stateDir = mkdtempSync(join(tmpdir(), "kontrol-activity-state-"));
const configDir = mkdtempSync(join(tmpdir(), "kontrol-activity-config-"));
const config = loadConfig({
  KONTROL_CONFIG_DIR: configDir,
  KONTROL_STATE_DIR: stateDir,
  KONTROL_ALLOWED_ROOTS: root,
  KONTROL_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
  KONTROL_DIAGNOSTICS_SECRET: "test-diagnostics-secret-that-is-long",
  KONTROL_ACP_REVIEWER_SECRET: "test-reviewer-secret-that-is-long-enough",
});

const sessionId = "test-session-activity-1";
const digest = createHash("sha256").update(sessionId).digest("hex");
const mcpSessions = new Map<string, McpSessionState>();
mcpSessions.set(sessionId, {
  sessionId,
  sessionLabel: "test",
  logicalClientId: "test-client",
  identitySource: "oauth",
  authenticatedRole: "reviewer",
  authenticatedPrincipalId: "reviewer-token",
  authSource: "reviewer_token",
  listenerKind: "owner",
  createdAt: Date.now(),
  lastTransportActivityAt: Date.now(),
  lastApplicationActivityAt: Date.now(),
  inFlightRequests: 0,
  requestCount: 1,
  notificationCount: 0,
  toolCallCount: 1,
  resourceReadCount: 0,
  activeLongPollCount: 0,
  activeSseStreams: 0,
  transportAttached: true,
} as unknown as McpSessionState);

const operationDiagnostics = new McpOperationDiagnostics();
// A real direct operation: no work session, no agent — just a tool call.
operationDiagnostics.begin({
  operationId: "op-direct-1",
  sessionIdSha256: digest,
  method: "tools/call",
  rpcMethod: "tools/call",
  toolName: "open_workspace",
  startedAtMs: Date.now() - 42,
  admissionClass: "execution",
  authenticatedPrincipalId: "reviewer-token",
});
operationDiagnostics.finish("op-direct-1", {
  finishedAtMs: Date.now(),
  httpStatus: 200,
  responseBytes: 1234,
  responseCloseClassification: "normal",
  admissionWaitMs: 0,
  executionDurationMs: 42,
  handlerStillRunning: false,
  executionAdmission: {},
  resourceAdmission: {},
  connectionMetrics: {},
});
// An unattributed operation (foreign session that never joined): excluded.
operationDiagnostics.begin({
  operationId: "op-foreign-1",
  sessionIdSha256: createHash("sha256").update("someone-elses-session").digest("hex"),
  method: "tools/call",
  toolName: "get_workspace_overview",
  startedAtMs: Date.now() - 10,
  admissionClass: "execution",
});
operationDiagnostics.finish("op-foreign-1", {
  finishedAtMs: Date.now(),
  httpStatus: 200,
  responseBytes: 10,
  responseCloseClassification: "normal",
  admissionWaitMs: 0,
  executionDurationMs: 10,
  handlerStillRunning: false,
  executionAdmission: {},
  resourceAdmission: {},
  connectionMetrics: {},
});
// An interrupted (never finished) direct operation: still shown, marked by age.
operationDiagnostics.begin({
  operationId: "op-active-1",
  sessionIdSha256: digest,
  method: "tools/call",
  toolName: "await_workspace_events",
  startedAtMs: Date.now() - 5000,
  admissionClass: "waiter",
});

const deps: ActivityDeps = { config, mcpSessions, operationDiagnostics };
// A second authenticated owner with its own session.
const otherSessionId = "test-session-activity-2";
const otherDigest = createHash("sha256").update(otherSessionId).digest("hex");
mcpSessions.set(otherSessionId, {
  ...mcpSessions.get(sessionId)!,
  sessionId: otherSessionId,
  authenticatedPrincipalId: "owner:other-2",
} as unknown as McpSessionState);
operationDiagnostics.begin({
  operationId: "op-other-1",
  sessionIdSha256: otherDigest,
  method: "tools/call",
  toolName: "get_workspace_overview",
  startedAtMs: Date.now() - 7,
  admissionClass: "execution",
  authenticatedPrincipalId: "owner:other-2",
});
operationDiagnostics.finish("op-other-1", {
  finishedAtMs: Date.now(),
  httpStatus: 200,
  responseBytes: 10,
  responseCloseClassification: "normal",
  admissionWaitMs: 0,
  executionDurationMs: 7,
  handlerStillRunning: false,
  executionAdmission: {},
  resourceAdmission: {},
  connectionMetrics: {},
});
// A peer session (another installation): never projected.
const peerSessionId = "test-session-activity-peer";
const peerDigest = createHash("sha256").update(peerSessionId).digest("hex");
mcpSessions.set(peerSessionId, {
  ...mcpSessions.get(sessionId)!,
  sessionId: peerSessionId,
  listenerKind: "peer",
  authenticatedPrincipalId: "peer-installation-9",
} as unknown as McpSessionState);
operationDiagnostics.begin({
  operationId: "op-peer-1",
  sessionIdSha256: peerDigest,
  method: "tools/call",
  toolName: "open_workspace",
  startedAtMs: Date.now() - 3,
  admissionClass: "execution",
  authenticatedPrincipalId: "peer-installation-9",
});
operationDiagnostics.finish("op-peer-1", {
  finishedAtMs: Date.now(),
  httpStatus: 200,
  responseBytes: 10,
  responseCloseClassification: "normal",
  admissionWaitMs: 0,
  executionDurationMs: 3,
  handlerStillRunning: false,
  executionAdmission: {},
  resourceAdmission: {},
  connectionMetrics: {},
});
const app = express();
app.get("/activity", (req, res) => handleActivityPage(deps, req, res));
app.get("/activity/data", (req, res) => handleActivityData(deps, req, res));
const server: Server = await new Promise((resolve) => {
  const s = app.listen(0, "127.0.0.1", () => resolve(s));
});
try {
  const { port } = server.address() as { port: number };
  const base = `http://127.0.0.1:${port}`;

  // Page is static and reachable.
  const page = await fetch(`${base}/activity`);
  assert.equal(page.status, 200, "activity page serves");
  assert.match(await page.text(), /Kontrol activity/);

  // Gate: no credential -> 403; wrong credential -> 403.
  assert.equal((await fetch(`${base}/activity/data`)).status, 403, "data requires the credential");
  assert.equal((await fetch(`${base}/activity/data`, { headers: { "x-kontrol-diagnostics": "wrong" } })).status, 403, "wrong credential is refused");

  const data = await (await fetch(`${base}/activity/data`, {
    headers: { "x-kontrol-diagnostics": "test-diagnostics-secret-that-is-long" },
  })).json() as {
    active: Array<Record<string, unknown>>;
    recent: Array<Record<string, unknown>>;
    counts: { excludedUnattributed: number };
  };
  const recent = data.recent.find((row) => row.operationId === "op-direct-1");
  assert.ok(recent, "completed direct operation is projected");
  assert.equal(recent.owner, "reviewer-token");
  assert.equal(recent.toolName, "open_workspace");
  assert.equal(recent.status, "completed");
  assert.equal(recent.elapsedMs, 42);
  assert.equal(recent.workSessionId, undefined, "direct operation has no work session and is still shown");
  const active = data.active.find((row) => row.operationId === "op-active-1");
  assert.ok(active, "in-flight operation is projected as active");
  assert.equal(active.status, "active");
  assert.equal(data.counts.excludedUnattributed, 2, "foreign unattributed + peer operations excluded");
  assert.ok(!JSON.stringify(data).includes("op-foreign-1"), "foreign operation not exposed");
  // Sanitization: only scoped metadata keys exist on the wire.
  const allowed = new Set(["operationId", "toolName", "method", "status", "startedAt", "finishedAt", "elapsedMs", "owner", "role", "workSessionId", "workspaceSessionId", "errorClass", "stale"]);
  for (const row of [...data.active, ...data.recent]) {
    for (const key of Object.keys(row)) assert.ok(allowed.has(key), `no raw payload key on the wire: ${key}`);
  }

  // Operator mode (diagnostics credential only): both non-peer owners
  // are visible; the peer installation's operation is never projected.
  assert.ok(data.recent.some((row) => row.owner === "owner:other-2"), "operator mode shows the second owner");
  assert.ok(!JSON.stringify(data).includes("op-peer-1"), "peer operation never projected in operator mode");
  assert.ok(!JSON.stringify(data).includes("peer-installation-9"), "peer principal never projected");

  // Viewer mode (verified reviewer credential): scoped to that
  // reviewer's principal only.
  const viewer = await (await fetch(`${base}/activity/data`, {
    headers: {
      "x-kontrol-diagnostics": "test-diagnostics-secret-that-is-long",
      "x-kontrol-reviewer-token": "test-reviewer-secret-that-is-long-enough",
    },
  })).json() as { recent: Array<Record<string, unknown>>; active: Array<Record<string, unknown>> };
  assert.ok(viewer.recent.some((row) => row.owner === "reviewer-token"), "viewer mode shows the reviewer's own operations");
  assert.ok(!viewer.recent.some((row) => row.owner === "owner:other-2"), "viewer mode excludes other owners");

  // Markup regression: the page contains no innerHTML interpolation of
  // projected values (rows are built with textContent).
  const pageText = await (await fetch(`${base}/activity`)).text();
  assert.ok(!pageText.includes("innerHTML"), "activity page never interpolates via innerHTML");
  assert.ok(pageText.includes("textContent"), "activity page renders via textContent");

  // Immutable attribution: with the originating session retired, the
  // completed operation still reports its captured owner.
  mcpSessions.delete(sessionId);
  mcpSessions.delete(otherSessionId);
  mcpSessions.delete(peerSessionId);
  const retired = await (await fetch(`${base}/activity/data`, {
    headers: {
      "x-kontrol-diagnostics": "test-diagnostics-secret-that-is-long",
      "x-kontrol-reviewer-token": "test-reviewer-secret-that-is-long-enough",
    },
  })).json() as { recent: Array<Record<string, unknown>> };
  const survivor = retired.recent.find((row) => row.operationId === "op-direct-1");
  assert.ok(survivor, "retired-session operation remains projected via captured attribution");
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

console.log("activity.test.ts: all assertions passed");
