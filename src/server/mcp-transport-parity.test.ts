/**
 * MCP transport parity contract (audit item 8).
 *
 * The legacy stateful HTTP transport and the modern per-request (2026)
 * transport must both fail closed even though their session lifecycles
 * differ. Each scenario below runs against both modes and asserts
 * nonexecution parity: invalid authentication, unauthenticated access,
 * pre-acknowledgement tool gating, reviewer-gated denial, success catalog
 * equivalence, and concurrent-request handling. Denial mechanism may differ
 * by lifecycle (reviewer gate vs ack gate); what must match is that the
 * protected operation never executes.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../server.js";
import { loadConfig } from "../config.js";
import { fingerprintToolCatalog, TOOL_CATALOG_ACK_CAPABILITY, TOOL_CATALOG_ACK_METHOD } from "../mcp/tool-catalog-handshake.js";

const workspaceRoot = mkdtempSync(join(tmpdir(), "kontrol-transport-parity-workspace-"));
const stateDir = mkdtempSync(join(tmpdir(), "kontrol-transport-parity-state-"));
const configDir = mkdtempSync(join(tmpdir(), "kontrol-transport-parity-config-"));
const worktreeRoot = mkdtempSync(join(tmpdir(), "kontrol-transport-parity-worktrees-"));
mkdirSync(workspaceRoot, { recursive: true });
writeFileSync(join(workspaceRoot, "README.md"), "parity test\n");
const reviewerSecret = "parity-test-tunnel-reviewer-secret-32ch";
writeFileSync(join(configDir, "tunnel-reviewer.secret"), reviewerSecret, { mode: 0o600 });
const config = loadConfig({
  KONTROL_CONFIG_DIR: configDir,
  KONTROL_ALLOWED_ROOTS: workspaceRoot,
  KONTROL_STATE_DIR: stateDir,
  KONTROL_WORKTREE_ROOT: worktreeRoot,
  KONTROL_AUTH_MODE: "tunnel",
  KONTROL_ACP_ENABLED: "true",
  KONTROL_ACP_AGENT_SECRET: "parity-test-agent-secret-32chars-ok",
  KONTROL_ACP_REVIEWER_SECRET: "parity-test-reviewer-secret-32chars",
  KONTROL_ACP_ADAPTER_SECRET: "parity-test-adapter-secret-32chars",
  KONTROL_TUNNEL_REVIEWER_SECRET: reviewerSecret,
  KONTROL_POLICY_MODE: "allow",
  KONTROL_TOOL_MODE: "full",
  KONTROL_LOG_LEVEL: "error",
  KONTROL_DIAGNOSTICS_SECRET: "parity-test-diagnostics-secret",
  KONTROL_BUILD_ID: "parity-build-test",
  KONTROL_MCP_REQUIRE_TOOL_CATALOG_ACK: "1",
});

const running = createServer(config);
const httpServer = running.app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => httpServer.once("listening", resolve));
// P0-B: every socket this listener accepts is fixture-owned. Teardown must
// prove none remain; production shutdown must NOT force-close authoritative
// servers this way.
const openSockets = new Set<Socket>();
httpServer.on("connection", (socket) => {
  openSockets.add(socket);
  socket.on("close", () => openSockets.delete(socket));
});
const address = httpServer.address();
assert.ok(address && typeof address === "object");
const url = `http://127.0.0.1:${address.port}/mcp`;
let nextId = 0;

type SecretKind = "valid" | "wrong" | "missing";
function secretHeader(kind: SecretKind): Record<string, string> {
  if (kind === "valid") return { "x-kontrol-tunnel-reviewer": reviewerSecret };
  if (kind === "wrong") return { "x-kontrol-tunnel-reviewer": "wrong-secret-value" };
  return {};
}

async function legacyRpc(method: string, params: Record<string, unknown>, sessionId?: string, secret: SecretKind = "valid") {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...secretHeader(secret),
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++nextId, method, params }),
  });
  const body = await response.text();
  const eventData = body.split(/\r?\n/).filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim()).join("\n");
  return {
    response,
    payload: body.trim() ? JSON.parse(eventData || body) : undefined,
    sessionId: response.headers.get("mcp-session-id") ?? sessionId,
  };
}

const modernEnvelope = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "parity-modern-http-test", version: "1.0.0" },
  "io.modelcontextprotocol/clientCapabilities": {
    extensions: { [TOOL_CATALOG_ACK_CAPABILITY]: { contractVersion: 1 } },
  },
};

async function modernRpc(method: string, params: Record<string, unknown>, secret: SecretKind = "valid") {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": method,
      ...(typeof params.name === "string" ? { "mcp-name": params.name } : {}),
      ...secretHeader(secret),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: ++nextId,
      method,
      params: { ...params, _meta: modernEnvelope },
    }),
  });
  // Consume every response body (or explicitly cancel it) so no test-owned
  // connection stays open and complicates HTTP server shutdown.
  const payload = response.headers.get("content-type")?.includes("json")
    ? await response.json()
    : (await response.arrayBuffer(), undefined);
  return { response, payload };
}

function errorCode(payload: any): number | undefined {
  return payload?.error?.code;
}

try {
  // S1: a wrong credential degrades to the client role on both transports,
  // so the reviewer-gated approval tool denies identically. Legacy session
  // creation itself is credential-agnostic (200 even with a wrong secret);
  // enforcement happens at call time through the same policy barrier.
  const deniedArgs = { name: "provide_policy_approval", arguments: { approvalId: "parity-nonexistent", decision: "approve" } };
  async function ackModernCredential(secret: SecretKind): Promise<void> {
    const list = await modernRpc("tools/list", {}, secret);
    assert.equal(list.response.status, 200);
    const fp = fingerprintToolCatalog(list.payload?.result);
    assert.ok(fp, `${secret} modern catalog is fingerprintable`);
    const ack = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": TOOL_CATALOG_ACK_METHOD,
        ...secretHeader(secret),
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: TOOL_CATALOG_ACK_METHOD, params: {
        contractVersion: 1,
        serverVersion: list.payload?.result?._meta?.["io.modelcontextprotocol/serverInfo"]?.version,
        hostCatalogSha256: fp.sha256,
        hostToolCount: fp.toolCount,
        _meta: modernEnvelope,
      } }),
    });
    assert.ok([200, 202].includes(ack.status), `${secret} modern ack accepted, got ${ack.status}`);
    await ack.arrayBuffer();
  }
  async function ackLegacyCredential(secret: SecretKind): Promise<string> {
    const init = await legacyRpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: { extensions: { [TOOL_CATALOG_ACK_CAPABILITY]: { contractVersion: 1 } } },
      clientInfo: { name: `parity-${secret}`, version: "1.0.0" },
    }, undefined, secret);
    assert.equal(init.response.status, 200, `legacy initialize is credential-agnostic (${secret})`);
    const sid = init.sessionId;
    assert.ok(sid, `${secret} session is issued`);
    const initVersion = init.payload?.result?.serverInfo?.version;
    assert.equal(typeof initVersion, "string", `${secret} initialize reports a server version`);
    await (await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": sid,
        ...secretHeader(secret),
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }),
    })).arrayBuffer();
    const listed = await legacyRpc("tools/list", {}, sid, secret);
    const fp = fingerprintToolCatalog(listed.payload?.result);
    assert.ok(fp, `${secret} catalog is fingerprintable`);
    const ack = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": sid,
        ...secretHeader(secret),
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: TOOL_CATALOG_ACK_METHOD, params: {
        contractVersion: 1,
        serverVersion: initVersion,
        hostCatalogSha256: fp.sha256,
        hostToolCount: fp.toolCount,
      } }),
    });
    assert.ok([200, 202].includes(ack.status), `${secret} legacy ack accepted, got ${ack.status}`);
    await ack.arrayBuffer();
    return sid;
  }
  const badSession = await ackLegacyCredential("wrong");
  await ackModernCredential("wrong");
  const legacyDenied = await legacyRpc("tools/call", deniedArgs, badSession, "wrong");
  const modernDenied = await modernRpc("tools/call", deniedArgs, "wrong");
  assert.equal(legacyDenied.response.status, 200);
  assert.equal(modernDenied.response.status, 200);
  assert.equal(legacyDenied.payload?.error, undefined, JSON.stringify(legacyDenied.payload));
  assert.equal(legacyDenied.payload?.result?.isError, true, "legacy denies client-role approval");
  assert.ok(JSON.stringify(legacyDenied.payload?.result?.content ?? "").includes("requires reviewer authority"),
    "legacy denial names reviewer authority");
  // Modern ack state is keyed by principal identity; a wrong credential
  // yields no principal, so the ack gate (not the reviewer gate) denies
  // with -32012. Documented contract: anonymous modern clients cannot pass
  // strict catalog acknowledgment — no shared anonymous ack key exists, by
  // design, so one anonymous caller can never acknowledge for another.
  // This suite therefore asserts nonexecution parity (the protected
  // operation does not execute on either transport), not an identical
  // denial mechanism: legacy denies at the reviewer gate, modern denies
  // earlier at the ack gate. Both fail closed.
  assert.equal(errorCode(modernDenied.payload), -32012, "modern denies unidentified caller at ack gate");

  // S2: missing credentials behave exactly like wrong credentials.
  const anonSession = await ackLegacyCredential("missing");
  await ackModernCredential("missing");
  const legacyAnonDenied = await legacyRpc("tools/call", deniedArgs, anonSession, "missing");
  const modernAnonDenied = await modernRpc("tools/call", deniedArgs, "missing");
  assert.equal(legacyAnonDenied.response.status, 200);
  assert.equal(legacyAnonDenied.payload?.result?.isError, true, "legacy denies anonymous approval");
  assert.ok(JSON.stringify(legacyAnonDenied.payload?.result?.content ?? "").includes("requires reviewer authority"),
    "legacy denial names reviewer authority");
  assert.equal(modernAnonDenied.response.status, 200);
  assert.equal(errorCode(modernAnonDenied.payload), -32012, "modern denies anonymous caller at ack gate");

  // S3: success-path catalog equivalence with valid reviewer credentials.
  const legacyInit = await legacyRpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: { extensions: { [TOOL_CATALOG_ACK_CAPABILITY]: { contractVersion: 1 } } },
    clientInfo: { name: "parity-legacy-http-test", version: "1.0.0" },
  });
  assert.equal(legacyInit.response.status, 200, JSON.stringify(legacyInit.payload));
  const sessionId = legacyInit.sessionId;
  assert.ok(sessionId, "legacy initialize returns a session id");
  await (await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-session-id": sessionId,
      ...secretHeader("valid"),
    },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }),
  })).arrayBuffer();
  const legacyList = await legacyRpc("tools/list", {}, sessionId);
  const modernList = await modernRpc("tools/list", {});
  assert.equal(legacyList.response.status, 200, JSON.stringify(legacyList.payload));
  assert.equal(modernList.response.status, 200, JSON.stringify(modernList.payload));
  const legacyNames = (legacyList.payload?.result?.tools ?? []).map((t: any) => t.name).sort();
  const modernNames = (modernList.payload?.result?.tools ?? []).map((t: any) => t.name).sort();
  assert.deepEqual(modernNames, legacyNames, "both transports expose the identical tool catalog");

  // S4: pre-acknowledgement tool-call gating matches on both transports.
  const legacyCall = await legacyRpc("tools/call", { name: "open_workspace", arguments: { path: workspaceRoot, mode: "checkout" } }, sessionId);
  const modernCall = await modernRpc("tools/call", { name: "open_workspace", arguments: { path: workspaceRoot, mode: "checkout" } });
  assert.equal(legacyCall.response.status, 200);
  assert.equal(modernCall.response.status, 200);
  assert.equal(errorCode(legacyCall.payload), -32012, "legacy gates tools/call until catalog ack");
  assert.equal(errorCode(modernCall.payload), -32012, "modern gates tools/call until catalog ack");

  // S5: with valid reviewer credentials past the ack gate, the same
  // request reaches the same handler outcome on both transports: the
  // reviewer gate passes and the unknown id is reported identically.
  const ackValid = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-session-id": sessionId,
      ...secretHeader("valid"),
    },
    body: JSON.stringify({ jsonrpc: "2.0", method: TOOL_CATALOG_ACK_METHOD, params: {
      contractVersion: 1,
      serverVersion: legacyList.payload?.result?.serverInfo?.version,
      hostCatalogSha256: fingerprintToolCatalog(legacyList.payload?.result)?.sha256,
      hostToolCount: fingerprintToolCatalog(legacyList.payload?.result)?.toolCount,
    } }),
  });
  assert.ok([200, 202].includes(ackValid.status), `valid legacy ack accepted, got ${ackValid.status}`);
    await ackValid.arrayBuffer();
  await ackModernCredential("valid");
  // NOTE: the S3 session made a tools/call before acknowledging, which
  // leaves its handshake unaccepted; S5 uses freshly acknowledged sessions
  // (same shape as S1/S2) so both modes prove the reviewer-gate outcome.
  const validSession = await ackLegacyCredential("valid");
  const approvalArgs = { approvalId: "parity-nonexistent", decision: "approve" };
  const legacyApproval = await legacyRpc("tools/call", { name: "provide_policy_approval", arguments: approvalArgs }, validSession);
  const modernApproval = await modernRpc("tools/call", { name: "provide_policy_approval", arguments: approvalArgs });
  assert.equal(legacyApproval.response.status, modernApproval.response.status, "approval status parity");
  assert.deepEqual(modernApproval.payload?.error ?? null, legacyApproval.payload?.error ?? null, "approval denial parity");
  // Transport envelopes differ (modern adds resultType/_meta.serverInfo);
  // authority parity is the tool outcome: identical content and isError.
  for (const [label, approval] of [["legacy", legacyApproval], ["modern", modernApproval]] as const) {
    assert.equal(approval.payload?.result?.isError, true, `${label} reports unknown approval as error`);
  }
  assert.deepEqual(modernApproval.payload?.result?.content ?? null, legacyApproval.payload?.result?.content ?? null,
    "approval result content parity");
  assert.ok(!JSON.stringify(legacyApproval.payload ?? "").includes("requires reviewer authority"),
    "reviewer credential passes the authority gate on legacy");
  assert.ok(!JSON.stringify(modernApproval.payload ?? "").includes("requires reviewer authority"),
    "reviewer credential passes the authority gate on modern");

  // S6: concurrent requests are served on both transports.
  const legacyConcurrent = await Promise.all(Array.from({ length: 8 }, () => legacyRpc("tools/list", {}, sessionId)));
  const modernConcurrent = await Promise.all(Array.from({ length: 8 }, () => modernRpc("tools/list", {})));
  assert.ok(legacyConcurrent.every((r) => r.response.status === 200), "legacy serves concurrent tools/list");
  assert.ok(modernConcurrent.every((r) => r.response.status === 200), "modern serves concurrent tools/list");

  // S7: an unknown legacy session id fails closed.
  const ghost = await legacyRpc("tools/list", {}, "parity-ghost-session-id");
  assert.ok([400, 404].includes(ghost.response.status), `unknown session fails closed, got ${ghost.response.status}`);
} finally {
  try {
    // Reject new work and drain existing MCP activity. This also finalizes
    // the managed runtime. Same shutdown sequence as mcp-tool-catalog-http.
    await running.drain();
    // Destroy fixture-owned sockets first so a leaked keep-alive connection
    // cannot stall listener close, then close the listener under a bounded
    // deadline. A deadline expiry is a CLEANUP_FAILED teardown failure, not
    // a pass: closeAllConnections only releases fixture-owned sockets so the
    // process can exit and report the failure.
    for (const socket of openSockets) socket.destroy();
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => {
        httpServer.closeAllConnections();
        reject(new Error(
          `teardown CLEANUP_FAILED: http listener did not close within 5000ms, ` +
          `${openSockets.size} fixture-owned socket(s) still tracked`));
      }, 5000);
      deadline.unref?.();
      httpServer.close((error) => {
        clearTimeout(deadline);
        if (error) reject(error);
        else resolve();
      });
    });
    const leaked = [...openSockets].filter((socket) => !socket.destroyed).length;
    assert.equal(leaked, 0, `teardown CLEANUP_FAILED: ${leaked} socket(s) survived fixture close`);
    // Idempotent after a successful drain.
    await running.close();
  } finally {
    for (const dir of [worktreeRoot, stateDir, configDir, workspaceRoot]) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

console.log("mcp-transport-parity.test.ts: legacy/modern authorization parity assertions passed");
