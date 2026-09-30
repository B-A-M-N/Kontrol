#!/usr/bin/env node
// Black-box MCP transport regression for a local origin or a running
// Secure MCP Tunnel endpoint. It deliberately opens a fresh MCP transport,
// starts a GET SSE stream, runs a concurrent tool call, disconnects only the
// SSE response, and then proves the same session remains usable.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { extractCatalog, extractServerInfoVersion, extractWorkspaceAppResourceUris, matchJsonRpcResponse, parseSseEventChunks } from "./lib/mcp-probe-protocol.mjs";

const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}
function has(name) { return args.includes(name); }
const dualSession = has("--dual");
const REQUIRED_INSPECTION_TOOLS = ["read", "grep", "glob", "ls", "git_status", "git_log", "git_diff", "git_show"];

const target = option("--url", "http://127.0.0.1:7676");
const workspacePath = resolve(option("--workspace", process.cwd()));
const cycles = Math.max(1, Number(option("--cycles", dualSession ? "25" : "3")));
const buildMetaPath = option("--build-meta", undefined);
const expectedMcpVersion = option("--expected-mcp-version", undefined);
const expectedBuildId = option("--expected-build-id", undefined);
const hostCatalogPath = option("--host-catalog-file", undefined);
const resultFilePath = option("--result-file", undefined);
const diagnosticsSecret = option("--diagnostics-secret", process.env.KONTROL_DIAGNOSTICS_SECRET);
const toolName = option("--tool-name", "bash");
const toolCommand = option("--tool-command", "sleep 0.25; printf tunnel-regression-ok");
const readPath = option("--read-path", "AGENTS.md");
const authorizationFile = option("--authorization-file", undefined);
const authorization = authorizationFile
  ? readFileSync(resolve(authorizationFile), "utf8").trim()
  : process.env.KONTROL_MCP_CANARY_AUTHORIZATION;
const tunnelReviewerFile = option("--tunnel-reviewer-file", undefined);
const tunnelReviewer = tunnelReviewerFile
  ? readFileSync(resolve(tunnelReviewerFile), "utf8").trim()
  : process.env.KONTROL_MCP_TUNNEL_REVIEWER;
const watcherTimeoutMs = Number(option("--watcher-timeout-ms", dualSession ? "18000" : "1000"));
const heartbeatIntervalMs = Number(option("--heartbeat-interval-ms", process.env.KONTROL_MCP_SSE_HEARTBEAT_MS ?? "20000"));
const heartbeatCount = Number(option("--heartbeat-count", dualSession ? "2" : "1"));
const heartbeatTimeoutMs = Number(option("--heartbeat-timeout-ms", String(heartbeatIntervalMs * heartbeatCount + 5_000)));
const minimumDrainEvents = Number(option("--minimum-drain-events", "0"));
const resourceLoadReads = Number(option("--resource-load-reads", dualSession ? "2" : "0"));
const requestTimeoutMs = Math.max(10_000, watcherTimeoutMs + 5_000, heartbeatTimeoutMs + 5_000);
const probeStartedAt = new Date().toISOString();
const url = `${target.replace(/\/$/, "")}/mcp`;
const diagnosticsUrl = `${target.replace(/\/$/, "")}/diagnostics`;

if (!Number.isInteger(cycles) || cycles < 1) throw new Error("--cycles must be a positive integer");
if (!Number.isInteger(watcherTimeoutMs) || watcherTimeoutMs < 1_000 || watcherTimeoutMs > 120_000) {
  throw new Error("--watcher-timeout-ms must be an integer between 1000 and 120000");
}
if (!Number.isInteger(heartbeatIntervalMs) || heartbeatIntervalMs < 1 || heartbeatIntervalMs > 120_000) {
  throw new Error("--heartbeat-interval-ms must be an integer between 1 and 120000");
}
if (!Number.isInteger(heartbeatCount) || heartbeatCount < 1 || heartbeatCount > 10) {
  throw new Error("--heartbeat-count must be an integer between 1 and 10");
}
if (!Number.isInteger(heartbeatTimeoutMs) || heartbeatTimeoutMs < heartbeatIntervalMs * heartbeatCount) {
  throw new Error("--heartbeat-timeout-ms must cover all requested heartbeat intervals");
}
if (!Number.isInteger(minimumDrainEvents) || minimumDrainEvents < 0) {
  throw new Error("--minimum-drain-events must be a non-negative integer");
}
if (!Number.isInteger(resourceLoadReads) || resourceLoadReads < 0 || resourceLoadReads > 16) {
  throw new Error("--resource-load-reads must be an integer between 0 and 16");
}
if (minimumDrainEvents > 0) assert.ok(diagnosticsSecret, "--minimum-drain-events requires --diagnostics-secret");
if (resultFilePath) {
  assert.ok(dualSession, "external qualification receipts require --dual streaming coverage");
  assert.ok(heartbeatCount >= 2, "external qualification receipts require repeated heartbeat bytes");
  assert.ok(resourceLoadReads >= 2, "external qualification receipts require concurrent resource-load reads");
  assert.ok(minimumDrainEvents >= 2, "external qualification receipts require at least two observed SSE drain recoveries");
  const targetUrl = new URL(target);
  assert.equal(targetUrl.protocol, "https:", "qualification receipts require the deployed HTTPS tunnel endpoint");
  assert.ok(!["localhost", "127.0.0.1", "::1"].includes(targetUrl.hostname),
    "qualification receipts cannot be generated by a localhost harness");
}
let expectedVersion = expectedMcpVersion;
if (!expectedVersion && buildMetaPath) {
  const meta = JSON.parse(readFileSync(resolve(buildMetaPath), "utf8"));
  if (typeof meta.version === "string" && typeof meta.contentSha256 === "string") {
    expectedVersion = `${meta.version}+${meta.contentSha256}`;
  }
}

const hostCatalogDocument = hostCatalogPath
  ? JSON.parse(readFileSync(resolve(hostCatalogPath), "utf8"))
  : undefined;
const hostCatalog = hostCatalogDocument
  ? extractCatalog(hostCatalogDocument)
  : undefined;
if (resultFilePath) {
  const document = hostCatalogDocument?.payload ?? hostCatalogDocument;
  assert.ok(hostCatalogPath, "--result-file requires --host-catalog-file");
  assert.ok(expectedVersion, "--result-file requires --expected-mcp-version or --build-meta");
  assert.ok(expectedBuildId, "--result-file requires --expected-build-id");
  assert.ok(typeof document?.capturedAt === "string" && Number.isFinite(Date.parse(document.capturedAt)),
    "--result-file requires a timestamped external host catalog envelope");
  assert.ok(typeof document?.captureId === "string" && document.captureId.length > 0,
    "--result-file requires an operator-supplied captureId identifying the external host connection");
  assert.ok(document?.initialize && document?.toolsList,
    "--result-file requires initialize and toolsList from the same fresh external host connection");
  const capturedVersion = extractServerInfoVersion(document.initialize);
  assert.ok(capturedVersion,
    "--result-file requires serverInfo.version in the captured initialize response");
  assert.equal(hostCatalog.version, capturedVersion,
    "initialize.serverInfo.version and toolsList must come from the same unambiguous host envelope");
  const explicitToolsList = extractCatalog(document.toolsList);
  assert.deepEqual([...explicitToolsList.names].sort(), [...hostCatalog.names].sort(),
    "the captured toolsList must be the one authoritative catalog in the host envelope");
}

const observedCatalogs = [];
const sessionVersions = new Map();
const observedRequestCorrelations = [];
const validatedWorkspaceAppResources = new Map();
let deployedWorkspaceAppUri;
let hostOpenWorkspaceUri;
let totalHeartbeatBytesObserved = 0;
let totalDrainRecoveryEvents = 0;
let totalResourceLoadReads = 0;

function assertCatalogParity(label, listed, sessionId) {
  const actual = extractCatalog(listed);
  const requiredTools = [...REQUIRED_INSPECTION_TOOLS, "poll_process"];
  const missingFromServer = requiredTools.filter((required) => !actual.names.has(required));
  if (missingFromServer.length > 0) {
    throw new Error(`${label} raw server tools/list is incomplete; diagnosis=deployed_server_catalog_incomplete; missing=${missingFromServer.join(",")}`);
  }
  if (!hostCatalog) return actual;
  const missingCapturedByServer = [...hostCatalog.names].filter((name) => !actual.names.has(name)).sort();
  const missingFromHost = [...actual.names].filter((name) => !hostCatalog.names.has(name)).sort();
  if (missingCapturedByServer.length > 0 || missingFromHost.length > 0) {
    const liveVersion = sessionId ? sessionVersions.get(sessionId) : undefined;
    const diagnosis = hostCatalog.version !== liveVersion
      ? "host_catalog_version_stale_or_from_another_generation"
      : missingFromHost.length > 0
        ? "host_exposes_subset_or_additional_tools"
        : "host_capture_contains_tools_missing_from_live_server";
    throw new Error(`${label} catalog mismatch; diagnosis=${diagnosis}; missingFromServer=${missingCapturedByServer.join(",")}; missingFromHost=${missingFromHost.join(",")}; hostVersion=${hostCatalog.version}; liveVersion=${liveVersion}`);
  }
  if (expectedVersion) {
    assert.equal(hostCatalog.version, expectedVersion,
      `${label} external host catalog is missing or has a stale immutable MCP version`);
  }
  observedCatalogs.push({
    label,
    serverInfoVersion: sessionId ? sessionVersions.get(sessionId) : undefined,
    serverTools: [...actual.names].sort(),
    serverToolMetadata: actual.tools,
  });
  return actual;
}

async function assertWorkspaceAppResources(listed, sessionId, label) {
  const actual = extractCatalog(listed);
  const renderTool = actual.tools.find((tool) => tool.name === "show_workspace_ui");
  const candidateUri = renderTool?.resourceUri;
  if (!candidateUri) {
    assert.equal(Boolean(resultFilePath), false,
      `${label} external qualification requires show_workspace_ui to advertise the deployed Workspace App resource`);
    return { candidateUri: undefined, resources: [] };
  }
  if (deployedWorkspaceAppUri) assert.equal(candidateUri, deployedWorkspaceAppUri, "fresh server catalogs disagree on the deployed Workspace App URI");
  deployedWorkspaceAppUri = candidateUri;

  const serverOpenWorkspaceUri = actual.tools.find((tool) => tool.name === "open_workspace")?.resourceUri;
  const capturedOpenWorkspaceUri = hostCatalog?.tools.find((tool) => tool.name === "open_workspace")?.resourceUri;
  if (serverOpenWorkspaceUri) {
    assert.equal(serverOpenWorkspaceUri, candidateUri,
      "server open_workspace resource URI differs from the deployed Workspace App candidate");
  }
  if (capturedOpenWorkspaceUri) {
    assert.equal(capturedOpenWorkspaceUri, candidateUri,
      `external host open_workspace resource URI ${capturedOpenWorkspaceUri} differs from deployed candidate ${candidateUri}`);
  }
  hostOpenWorkspaceUri = capturedOpenWorkspaceUri;

  const resourcesResult = await rpc("resources/list", {}, sessionId);
  const listedResources = resourcesResult.payload?.result?.resources ?? [];
  const resourceUris = [...new Set([
    ...extractWorkspaceAppResourceUris(actual),
    ...extractWorkspaceAppResourceUris(hostCatalog),
  ])].sort();
  for (const uri of resourceUris) {
    const listedResource = listedResources.find((resource) => resource?.uri === uri);
    assert.ok(listedResource, `${label} resources/list did not expose exact Workspace App URI ${uri}`);
    const cached = validatedWorkspaceAppResources.get(uri);
    if (cached) continue;
    const readResult = await rpc("resources/read", { uri }, sessionId);
    const contents = readResult.payload?.result?.contents ?? [];
    const content = contents.find((entry) => entry?.uri === uri);
    assert.ok(content, `${label} resources/read did not return exact requested URI ${uri}`);
    const expectedMimeType = /^ui:\/\/kontrol\/workspace-app-[a-f0-9]{12}\.html$/i.test(uri)
      ? "text/html;profile=mcp-app"
      : "text/html+skybridge";
    assert.equal(content.mimeType, expectedMimeType, `${label} resource ${uri} has the wrong MIME type`);
    assert.equal(typeof content.text, "string", `${label} resource ${uri} did not return HTML text`);
    assert.ok(content.text.trim().length > 0 && /<html\b/i.test(content.text), `${label} resource ${uri} returned empty or non-HTML content`);
    validatedWorkspaceAppResources.set(uri, {
      uri,
      mimeType: content.mimeType,
      htmlBytes: Buffer.byteLength(content.text, "utf8"),
      listed: true,
      read: true,
    });
  }
  return { candidateUri, resources: [...validatedWorkspaceAppResources.values()] };
}

function writeProbeReceipt(cycles) {
  if (!resultFilePath) return;
  const document = hostCatalogDocument?.payload ?? hostCatalogDocument;
  const observed = observedCatalogs[0];
  assert.ok(observed, "no fresh server tools/list exchange was observed");
  const finishedAt = new Date().toISOString();
  const hostCatalogSha256 = createHash("sha256").update(JSON.stringify(hostCatalogDocument)).digest("hex");
  const receipt = {
    kind: "kontrol-external-catalog-probe",
    status: "passed",
    expectedBuildId,
    expectedMcpVersion: expectedVersion,
    serverInfoVersion: observed.serverInfoVersion,
    hostCatalogVersion: hostCatalog.version,
    serverTools: observed.serverTools,
    serverToolMetadata: observed.serverToolMetadata,
    hostTools: [...hostCatalog.names].sort(),
    hostToolMetadata: hostCatalog.tools,
    catalogParity: true,
    workspaceApp: {
      deployedResourceUri: deployedWorkspaceAppUri,
      hostOpenWorkspaceResourceUri: hostOpenWorkspaceUri ?? null,
      openWorkspaceUriMatchesCandidate: !hostOpenWorkspaceUri || hostOpenWorkspaceUri === deployedWorkspaceAppUri,
      resources: [...validatedWorkspaceAppResources.values()],
    },
    hostCapture: {
      source: "operator_supplied",
      captureId: document.captureId,
      machineVerified: false,
      sha256: hostCatalogSha256,
    },
    liveServerProbe: {
      source: "fresh_http_initialize_and_tools_list",
      machineVerified: true,
      startedAt: probeStartedAt,
      finishedAt,
      url: target,
    },
    hostCatalogCapturedAt: document.capturedAt,
    hostCatalogCaptureId: document.captureId,
    hostCatalogEvidenceSource: "operator_supplied",
    hostCatalogMachineVerified: false,
    hostCatalogSha256,
    liveServerProbeMachineVerified: true,
    serverRequestCorrelations: observedRequestCorrelations.slice(0, 64),
    dualSession: true,
    heartbeatCountPerSession: heartbeatCount,
    heartbeatBytesObserved: totalHeartbeatBytesObserved,
    drainRecoveryEvents: totalDrainRecoveryEvents,
    resourceLoadReads: totalResourceLoadReads,
    startedAt: probeStartedAt,
    finishedAt,
    url: target,
    cycles,
  };
  const path = resolve(resultFilePath);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

let requestId = 0;
async function decodeResponse(response, expectedId) {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.includes("text/event-stream")) {
    assert.ok(response.body, "SSE response has no readable body");
    const reader = response.body.getReader();
    const chunks = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const events = parseSseEventChunks(chunks);
    const matched = matchJsonRpcResponse(events, expectedId);
    assert.ok(matched.response,
      `SSE stream ended before the final JSON-RPC response for request ID ${String(expectedId)}`);
    return matched.response;
  }
  const text = await response.text();
  if (!text.trim()) return undefined;
  const payload = JSON.parse(text);
  if (expectedId !== undefined) {
    assert.equal(payload?.id, expectedId, `JSON response ID does not match request ID ${expectedId}`);
  }
  return payload;
}

async function rpc(method, params, sessionId) {
  const isNotification = method.startsWith("notifications/");
  const id = isNotification ? undefined : ++requestId;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(authorization ? { authorization } : {}),
      ...(tunnelReviewer ? { "x-kontrol-tunnel-reviewer": tunnelReviewer } : {}),
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      ...(isNotification ? {} : { id }),
      method,
      params,
    }),
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  const responseCorrelation = {
    method,
    requestId: id,
    operationId: response.headers.get("x-kontrol-operation-id") ?? undefined,
    kontrolRequestId: response.headers.get("x-kontrol-request-id") ?? undefined,
    externalCorrelationId: response.headers.get("x-kontrol-correlation-id")
      ?? response.headers.get("cf-ray")
      ?? undefined,
  };
  observedRequestCorrelations.push(responseCorrelation);
  if (observedRequestCorrelations.length > 128) observedRequestCorrelations.shift();
  const payload = await decodeResponse(response, id);
  assert.ok(isNotification ? [200, 202].includes(response.status) : response.status === 200,
    `${method} returned HTTP ${response.status}: ${JSON.stringify(payload)}`);
  if (isNotification) {
    assert.equal(payload, undefined, `notification ${method} unexpectedly returned a JSON-RPC response`);
  } else {
    assert.ok(!payload?.error, `${method}: ${payload?.error?.message ?? "JSON-RPC error"}`);
  }
  return {
    response,
    payload,
    sessionId: response.headers.get("mcp-session-id") ?? sessionId,
    ...responseCorrelation,
  };
}

async function call(name, arguments_, sessionId) {
  const result = await rpc("tools/call", { name, arguments: arguments_ }, sessionId);
  assert.notEqual(result.payload?.result?.isError, true,
    `${name} returned an MCP tool error: ${JSON.stringify(result.payload)}`);
  return result.payload?.result;
}

async function openSession(cycle) {
  const initialized = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp:tunnel-regression", version: "1.0.0" },
  });
  const sessionId = initialized.sessionId;
  assert.ok(sessionId, `cycle ${cycle} initialize did not return mcp-session-id`);
  sessionVersions.set(sessionId, initialized.payload?.result?.serverInfo?.version);
  if (expectedVersion) {
    assert.equal(initialized.payload?.result?.serverInfo?.version, expectedVersion,
      `cycle ${cycle} server version does not match immutable build metadata`);
  }
  const notification = await rpc("notifications/initialized", {}, sessionId);
  assert.ok([200, 202].includes(notification.response.status));
  return sessionId;
}

async function openSse(sessionId) {
  const controller = new AbortController();
  const response = await fetch(url, {
    method: "GET",
    headers: {
      accept: "text/event-stream",
      ...(authorization ? { authorization } : {}),
      ...(tunnelReviewer ? { "x-kontrol-tunnel-reviewer": tunnelReviewer } : {}),
      "mcp-session-id": sessionId,
    },
    signal: controller.signal,
  });
  assert.equal(response.status, 200, `GET SSE returned HTTP ${response.status}`);
  assert.ok(response.body, "GET SSE response has no readable body");
  return { controller, response, reader: response.body.getReader() };
}

async function waitForHeartbeatBytes(stream, expectedCount, timeoutMs) {
  const decoder = new TextDecoder();
  const heartbeatPattern = /: kontrol-heartbeat\r?\n\r?\n/g;
  let pending = "";
  let observed = 0;
  const timeout = setTimeout(() => stream.controller.abort(new Error("SSE heartbeat deadline exceeded")), timeoutMs);
  try {
    while (observed < expectedCount) {
      const { done, value } = await stream.reader.read();
      if (done) throw new Error(`SSE stream ended after ${observed}/${expectedCount} heartbeats`);
      pending += decoder.decode(value, { stream: true });
      const matches = pending.match(heartbeatPattern) ?? [];
      observed += matches.length;
      pending = pending.replace(heartbeatPattern, "");
      if (pending.length > 512) pending = pending.slice(-512);
    }
    return observed;
  } catch (error) {
    if (stream.controller.signal.aborted) {
      throw new Error(`SSE heartbeat bytes were not observed within ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function disconnectSse(stream) {
  stream.controller.abort();
  await stream.reader.cancel().catch(() => {});
}

async function diagnostics() {
  if (!diagnosticsSecret) return undefined;
  const response = await fetch(diagnosticsUrl, {
    headers: { "x-kontrol-diagnostics": diagnosticsSecret },
    signal: AbortSignal.timeout(3_000),
  });
  assert.equal(response.status, 200, `diagnostics returned HTTP ${response.status}`);
  return response.json();
}

function diagnosticEventCount(snapshot, eventName) {
  const events = snapshot?.mcpSessionMetrics?.connectionRecovery?.events;
  return typeof events?.[eventName] === "number" ? events[eventName] : 0;
}

async function qualifyDualSession(cycle) {
  let a = await openSession(cycle * 2);
  let b = await openSession(cycle * 2 + 1);
  let streamA;
  let streamB;
  try {
    const [catalogA, catalogB] = await Promise.all([
      rpc("tools/list", {}, a),
      rpc("tools/list", {}, b),
    ]);
    for (const [label, catalog] of [["A", catalogA], ["B", catalogB]]) {
      assertCatalogParity(`tab ${label}`, catalog, label === "A" ? a : b);
    }
    await assertWorkspaceAppResources(catalogA, a, "tab A");
    await assertWorkspaceAppResources(catalogB, b, "tab B");
    const openedA = await call("open_workspace", { path: workspacePath, mode: "checkout" }, a);
    const openedB = await call("open_workspace", { path: workspacePath, mode: "checkout" }, b);
    const workspaceA = (openedA?.structuredContent ?? openedA).workspaceId;
    const workspaceB = (openedB?.structuredContent ?? openedB).workspaceId;
    assert.equal(typeof workspaceA, "string");
    assert.equal(typeof workspaceB, "string");
    const resourcesA = await rpc("resources/list", {}, a);
    const resourcesB = await rpc("resources/list", {}, b);
    const resourceA = (resourcesA.payload?.result?.resources ?? []).find((resource) => typeof resource.uri === "string" && resource.mimeType === "text/html;profile=mcp-app");
    const resourceB = (resourcesB.payload?.result?.resources ?? []).find((resource) => typeof resource.uri === "string" && resource.mimeType === "text/html;profile=mcp-app");
    assert.ok(resourceA?.uri && resourceB?.uri, "both tabs must discover the Workspace App resource");
    const widgetA = await rpc("resources/read", { uri: resourceA.uri }, a);
    const widgetB = await rpc("resources/read", { uri: resourceB.uri }, b);
    assert.equal(widgetA.response.status, 200);
    assert.equal(widgetB.response.status, 200);
    const [readA, grepA, readB, grepB] = await Promise.all([
      call("read", { workspaceId: workspaceA, path: "package.json" }, a),
      call("grep", { workspaceId: workspaceA, pattern: "kontrol", path: "package.json" }, a),
      call("read", { workspaceId: workspaceB, path: "package.json" }, b),
      call("grep", { workspaceId: workspaceB, pattern: "kontrol", path: "package.json" }, b),
    ]);
    assert.ok(readA && grepA && readB && grepB, "both tabs must complete interleaved reads/searches");
    // Exercise the same bounded POST long-poll used by both Workspace App
    // tabs. Empty responses are normal heartbeats; one tab must not consume or
    // cancel the other tab's waiter.
    const [eventsA, eventsB] = await Promise.all([
      call("await_workspace_events", { workspaceId: workspaceA, afterSeq: 0, timeoutMs: watcherTimeoutMs }, a),
      call("await_workspace_events", { workspaceId: workspaceB, afterSeq: 0, timeoutMs: watcherTimeoutMs }, b),
    ]);
    assert.ok(eventsA && eventsB, "both tab event watchers must complete independently");
    const nextSeqA = Number((eventsA?.structuredContent ?? eventsA)?.nextSeq ?? 0);
    const nextSeqB = Number((eventsB?.structuredContent ?? eventsB)?.nextSeq ?? 0);
    const [idleEventsA, idleEventsB] = await Promise.all([
      call("await_workspace_events", { workspaceId: workspaceA, afterSeq: nextSeqA, timeoutMs: watcherTimeoutMs }, a),
      call("await_workspace_events", { workspaceId: workspaceB, afterSeq: nextSeqB, timeoutMs: watcherTimeoutMs }, b),
    ]);
    assert.ok(idleEventsA && idleEventsB, "both tabs must survive an empty watcher heartbeat");
    const diagnosticsBeforeStreams = await diagnostics();
    const drainEventsBefore = diagnosticEventCount(diagnosticsBeforeStreams, "sse_writer_drained");
    streamA = await openSse(a);
    streamB = await openSse(b);
    const resourceLoadTasks = [];
    for (let index = 0; index < resourceLoadReads; index++) {
      const sessionId = index % 2 === 0 ? a : b;
      const resourceUri = index % 2 === 0 ? resourceA.uri : resourceB.uri;
      resourceLoadTasks.push(rpc("resources/read", { uri: resourceUri }, sessionId));
    }
    const resourceLoadResults = await Promise.all(resourceLoadTasks);
    for (const result of resourceLoadResults) {
      assert.equal(result.response.status, 200, "resource-load read must complete while SSE streams are active");
    }
    totalResourceLoadReads += resourceLoadResults.length;
    const [heartbeatCountA, heartbeatCountB] = await Promise.all([
      waitForHeartbeatBytes(streamA, heartbeatCount, heartbeatTimeoutMs),
      waitForHeartbeatBytes(streamB, heartbeatCount, heartbeatTimeoutMs),
    ]);
    totalHeartbeatBytesObserved += heartbeatCountA + heartbeatCountB;
    await disconnectSse(streamA);
    const diagnosticsAfterAStreamClose = await diagnostics();
    const drainEventDelta = diagnosticEventCount(diagnosticsAfterAStreamClose, "sse_writer_drained") - drainEventsBefore;
    totalDrainRecoveryEvents += Math.max(0, drainEventDelta);
    assert.ok(drainEventDelta >= minimumDrainEvents,
      `observed ${drainEventDelta} SSE drain recoveries; required ${minimumDrainEvents}`);
    const bAfterA = await rpc("tools/list", {}, b);
    assert.equal(bAfterA.response.status, 200, "B must remain live after A SSE disconnect");
    const bRead = await call("read", { workspaceId: workspaceB, path: "package.json" }, b);
    assert.ok(bRead, "B must keep reading after A disconnect");
    await fetch(url, { method: "DELETE", headers: { "mcp-session-id": a }, signal: AbortSignal.timeout(3_000) }).catch(() => {});
    a = await openSession(cycle * 2 + 2);
    const aReconnect = await rpc("tools/list", {}, a);
    assert.equal(aReconnect.response.status, 200, "A reconnect must establish a fresh usable transport");
    const openedAReconnect = await call("open_workspace", { path: workspacePath, mode: "checkout" }, a);
    const workspaceReconnect = (openedAReconnect?.structuredContent ?? openedAReconnect).workspaceId;
    assert.equal(typeof workspaceReconnect, "string", "replacement transport must open its own workspace context");
    await disconnectSse(streamB);
    const aAfterB = await rpc("tools/list", {}, a);
    assert.equal(aAfterB.response.status, 200, "A must remain live after B SSE disconnect");
    const aRead = await call("read", { workspaceId: workspaceReconnect, path: "package.json" }, a);
    assert.ok(aRead, "A must keep reading after B disconnect");
  } finally {
    if (streamA) await disconnectSse(streamA);
    if (streamB) await disconnectSse(streamB);
    await fetch(url, { method: "DELETE", headers: { "mcp-session-id": a }, signal: AbortSignal.timeout(3_000) }).catch(() => {});
    await fetch(url, { method: "DELETE", headers: { "mcp-session-id": b }, signal: AbortSignal.timeout(3_000) }).catch(() => {});
  }
}

if (dualSession) {
  for (let cycle = 0; cycle < cycles; cycle++) await qualifyDualSession(cycle);
  writeProbeReceipt(cycles);
  console.log(JSON.stringify({ ok: true, url, dualSession: true, cycles, heartbeatBytesObserved: totalHeartbeatBytesObserved,
    drainRecoveryEvents: totalDrainRecoveryEvents, resourceLoadReads: totalResourceLoadReads,
    correlatedServerResponses: observedRequestCorrelations.filter((item) => item.operationId).length,
    requiredTools: [...REQUIRED_INSPECTION_TOOLS, "poll_process"] }));
  process.exit(0);
}

for (let cycle = 0; cycle < cycles; cycle++) {
  const sessionId = await openSession(cycle);
  const listed = await rpc("tools/list", {}, sessionId);
  assertCatalogParity(`cycle ${cycle}`, listed, sessionId);
  await assertWorkspaceAppResources(listed, sessionId, `cycle ${cycle}`);

  const opened = await call("open_workspace", { path: workspacePath, mode: "checkout" }, sessionId);
  const structured = opened?.structuredContent ?? opened;
  const workspaceId = structured?.workspaceId;
  assert.equal(typeof workspaceId, "string", `cycle ${cycle} open_workspace did not return workspaceId`);

  const stream = await openSse(sessionId);
  const concurrent = call(toolName, toolName === "read"
    ? { workspaceId, path: readPath }
    : { workspaceId, command: toolCommand, timeout: 10 }, sessionId);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  await disconnectSse(stream);

  const completed = await concurrent;
  assert.ok(completed, `cycle ${cycle} concurrent call did not complete after SSE disconnect`);
  const afterDisconnect = await rpc("tools/list", {}, sessionId);
  assert.equal(afterDisconnect.response.status, 200, `cycle ${cycle} session was lost after SSE disconnect`);
  assertCatalogParity(`cycle ${cycle} post-disconnect`, afterDisconnect, sessionId);

  const snapshot = await diagnostics();
  if (snapshot) {
    assert.equal(snapshot.mcpSessionMetrics?.activeSseStreams, 0,
      `cycle ${cycle} retained an SSE stream after disconnect`);
    const session = (snapshot.mcpSessionMetrics?.sessions ?? []).find((candidate) => candidate.sessionLabel?.endsWith(`/mcp:${sessionId.slice(0, 8)}`));
    assert.ok(session, `cycle ${cycle} session disappeared after SSE disconnect`);
  }

  await fetch(url, {
    method: "DELETE",
    headers: { "mcp-session-id": sessionId },
    signal: AbortSignal.timeout(3_000),
  }).catch(() => {});
}

writeProbeReceipt(cycles);
console.log(JSON.stringify({ ok: true, url, cycles,
  correlatedServerResponses: observedRequestCorrelations.filter((item) => item.operationId).length,
  requiredTools: [...REQUIRED_INSPECTION_TOOLS, "poll_process"] }));
