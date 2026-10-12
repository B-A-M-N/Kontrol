import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import Database from "better-sqlite3";
import { authHeadersForAgent, callRemoteAgent, dispatchToPeer, lookupPeerDispatch, probeAgent, selectHealthyAgent } from "./acp-gateway.js";
import { createAcpServer } from "./acp-server.js";
import { openDatabase, databasePath } from "./db/client.js";
import { createAgentRegistryManager } from "./acp-registry.js";
import { createWorkSessionManager } from "./work-sessions.js";

function seedWorkspace(dir: string, id: string): void {
  const db = new Database(databasePath(dir));
  db.pragma("foreign_keys = OFF");
  db.exec(
    `insert into workspace_sessions (id, root, status, mode, managed, created_at, last_used_at) ` +
    `values ('${id}', '/tmp', 'active', 'checkout', 'false', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')`,
  );
  db.close();
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown> : {};
}

async function listen(server: Server, host: string): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  const addr = server.address();
  return typeof addr === "object" && addr ? addr.port : 0;
}

const servers: Server[] = [];
const tempDirs: string[] = [];

try {
  assert.deepEqual(authHeadersForAgent("http://127.0.0.1:9877", "secret"), {
    Authorization: "Bearer secret",
  });
  assert.deepEqual(authHeadersForAgent("http://0.0.0.0:9877", "secret"), {});
  assert.deepEqual(authHeadersForAgent("https://agent.example.test", "secret"), {});
  const unsupportedProbe = await probeAgent("stdio://agent");
  assert.equal(unsupportedProbe.healthy, false, "non-HTTP ACP transports are not dispatchable by the HTTP gateway");
  assert.equal(unsupportedProbe.status, 0);
  assert.match(unsupportedProbe.note ?? "", /unsupported probe transport/);

  {
    const probeServer = createServer((req, res) => {
      if (req.method === "GET" && req.url === "/health") res.writeHead(200).end("ok");
      else res.writeHead(404).end();
    });
    servers.push(probeServer);
    const port = await listen(probeServer, "127.0.0.1");
    const url = `http://127.0.0.1:${port}`;
    const candidates = [
      { id: "generic-id", name: "registered-acp-harness", url, role: "agent", capabilities: ["acp"] },
      { id: "codex-id", name: "codex", url, role: "agent", capabilities: ["native:openai"] },
      { id: "reviewer-id", name: "reviewer-only", url, role: "reviewer", capabilities: ["native:openai"] },
    ] as any;
    const native = await selectHealthyAgent(candidates, { role: "agent", clientPlatformHint: "ChatGPT OpenAI" });
    assert.equal(native.agent?.name, "codex", "ChatGPT/OpenAI prefers its registered native harness");
    const fallback = await selectHealthyAgent([candidates[0], candidates[2]], { role: "agent", clientPlatformHint: "ChatGPT OpenAI" });
    assert.equal(fallback.agent?.name, "registered-acp-harness", "any healthy registered ACP agent remains an eligible fallback");
    const explicit = await selectHealthyAgent(candidates, { role: "agent", name: "registered-acp-harness", clientPlatformHint: "ChatGPT OpenAI" });
    assert.equal(explicit.agent?.name, "registered-acp-harness", "an explicit registered harness choice overrides platform preference");
  }

  {
    let postAuth: string | undefined;
    const server = createServer(async (req, res) => {
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(404).end();
        return;
      }
      if (req.method === "GET" && req.url === "/runs") {
        res.writeHead(405).end();
        return;
      }
      if (req.method === "POST" && req.url === "/runs") {
        postAuth = req.headers.authorization;
        await readJson(req);
        res.writeHead(202, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ run_id: "remote-loopback", status: "running", output: [] }));
        return;
      }
      res.writeHead(404).end();
    });
    servers.push(server);
    const port = await listen(server, "127.0.0.1");
    const result = await dispatchToPeer({
      agentUrl: `http://127.0.0.1:${port}`,
      adapterSecret: "secret",
      body: { agent_name: "local", input: [] },
    });
    assert.equal(result.status, 202);
    assert.equal(postAuth, "Bearer secret", "loopback dispatch includes shared bearer");
  }

  {
    const server = createServer((req, res) => {
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(404).end();
        return;
      }
      if (req.method === "GET" && req.url === "/runs") {
        res.writeHead(401).end();
        return;
      }
      res.writeHead(404).end();
    });
    servers.push(server);
    const port = await listen(server, "0.0.0.0");
    const probe = await probeAgent(`http://0.0.0.0:${port}`, "secret");
    assert.equal(probe.healthy, false, "non-loopback 401 is not dispatchable without peer credentials");
    assert.equal(probe.status, 401);
  }

  {
    let peerAuth: string | undefined;
    let peerBody: Record<string, unknown> | undefined;
    const peer = createServer(async (req, res) => {
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(404).end();
        return;
      }
      if (req.method === "GET" && req.url === "/runs") {
        res.writeHead(405).end();
        return;
      }
      if (req.method === "POST" && req.url === "/runs") {
        peerAuth = req.headers.authorization;
        peerBody = await readJson(req);
        res.writeHead(202, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ run_id: "remote-direct", remote_run_id: "remote-direct", accepted: true }));
        return;
      }
      res.writeHead(404).end();
    });
    servers.push(peer);
    const peerPort = await listen(peer, "0.0.0.0");

    const root = await mkdtemp(join(tmpdir(), "kontrol-acp-gateway-"));
    tempDirs.push(root);
    const db = openDatabase(root);
    seedWorkspace(root, "ws-gateway");
    const workSessions = createWorkSessionManager(db);
    const agentRegistry = createAgentRegistryManager(db);
    const workSession = workSessions.create({ workspaceSessionId: "ws-gateway", submittedBy: "test" });
    agentRegistry.register({
      name: "remote-agent",
      url: `http://0.0.0.0:${peerPort}`,
      role: "agent",
      ttlSeconds: 600,
    });

    const app = express();
    app.use(express.json());
    app.use("/acp", createAcpServer(
      { getWorkspace: () => ({ id: "ws-gateway", root: "/tmp", mode: "checkout" }) } as any,
      workSessions,
      agentRegistry,
      "server-secret",
    ));
    const acpServer = app.listen(0, "127.0.0.1");
    servers.push(acpServer);
    await new Promise<void>((resolve) => acpServer.once("listening", resolve));
    const addr = acpServer.address();
    const acpPort = typeof addr === "object" && addr ? addr.port : 0;

    const response = await fetch(`http://127.0.0.1:${acpPort}/acp/runs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer server-secret",
      },
      body: JSON.stringify({
        agent_name: "remote-agent",
        session_id: workSession.id,
        input: [{ parts: [{ content: "hello" }] }],
      }),
    });
    const responseBody = await response.json() as Record<string, unknown>;
    assert.equal(response.status, 202);
    assert.equal(peerAuth, undefined, "direct /acp/runs forwarding does not leak shared bearer to non-loopback peers");
    assert.equal(peerBody?.agent_name, "remote-agent");
    assert.equal(peerBody?.work_session_id, workSession.id);
    assert.equal(peerBody?.workspace_session_id, "ws-gateway");
    assert.equal(peerBody?.workspace_root, "/tmp");
    assert.equal(responseBody.remote_run_id, "remote-direct");
    const persistedRun = agentRegistry.getRun(String(responseBody.kontrol_run_id));
    assert.equal(persistedRun?.status, "running", "adapter acceptance keeps logical run running");
    assert.equal(persistedRun?.remoteRunId, "remote-direct");

    workSessions.close();
    agentRegistry.close();
  }

  {
    const root = await mkdtemp(join(tmpdir(), "kontrol-acp-roles-"));
    tempDirs.push(root);
    const db = openDatabase(root);
    seedWorkspace(root, "ws-roles");
    const workSessions = createWorkSessionManager(db);
    const agentRegistry = createAgentRegistryManager(db);
    const run = agentRegistry.createRun({
      agentName: "role-agent",
      workspaceSessionId: "ws-roles",
      workSessionId: "wsess-roles",
      inputPreview: "role test",
      status: "running",
    });

    const app = express();
    app.use(express.json());
    app.use("/acp", createAcpServer(
      { getWorkspace: () => ({ id: "ws-roles", root: "/tmp", mode: "checkout" }) } as any,
      workSessions,
      agentRegistry,
      "operator-secret",
      "operator-secret",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "agent-secret",
      "reviewer-secret",
    ));
    const acpServer = app.listen(0, "127.0.0.1");
    servers.push(acpServer);
    await new Promise<void>((resolve) => acpServer.once("listening", resolve));
    const addr = acpServer.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const base = `http://127.0.0.1:${port}/acp`;

    const agentList = await fetch(`${base}/agents`, { headers: { Authorization: "Bearer agent-secret" } });
    assert.equal(agentList.status, 403, "agent secret cannot enumerate registry");
    const reviewerEvent = await fetch(`${base}/runs/${run.runId}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer reviewer-secret" },
      body: JSON.stringify({ type: "started" }),
    });
    assert.equal(reviewerEvent.status, 403, "reviewer secret cannot publish adapter events");
    const operatorRuns = await fetch(`${base}/runs`, { headers: { Authorization: "Bearer operator-secret" } });
    assert.equal(operatorRuns.status, 200, "legacy shared secret acts as operator principal");

    workSessions.close();
    agentRegistry.close();
  }

  {
    const root = await mkdtemp(join(tmpdir(), "kontrol-acp-gateway-terminal-"));
    tempDirs.push(root);
    const db = openDatabase(root);
    seedWorkspace(root, "ws-terminal");
    const workSessions = createWorkSessionManager(db);
    const agentRegistry = createAgentRegistryManager(db);
    const run = agentRegistry.createRun({
      agentName: "remote-agent",
      workspaceSessionId: "ws-terminal",
      workSessionId: "wsess-terminal",
      inputPreview: "resume terminal",
      status: "running",
    });
    agentRegistry.updateRun(run.runId, { status: "cancelled" });

    await assert.rejects(
      () => callRemoteAgent(
        {
          agentRegistry,
          workspaces: { getWorkspace: () => ({ id: "ws-terminal", root: "/tmp", mode: "checkout" }) } as any,
          workSessions,
          adapterSecret: "secret",
        },
        {
          agentUrl: "http://127.0.0.1:9",
          agentName: "remote-agent",
          task: "resume",
          existingRunId: run.runId,
          mode: "async",
        },
      ),
      /Cannot resume non-resumable run/,
    );

    const cancellingRun = agentRegistry.createRun({
      agentName: "remote-agent",
      workspaceSessionId: "ws-terminal",
      workSessionId: "wsess-cancelling",
      inputPreview: "must remain fenced",
      status: "cancelling",
    });
    await assert.rejects(
      () => callRemoteAgent(
        {
          agentRegistry,
          workspaces: { getWorkspace: () => ({ id: "ws-terminal", root: "/tmp", mode: "checkout" }) } as any,
          workSessions,
          adapterSecret: "secret",
        },
        {
          agentUrl: "http://127.0.0.1:9",
          agentName: "remote-agent",
          task: "resume while cancelling",
          existingRunId: cancellingRun.runId,
          mode: "async",
        },
      ),
      /Cannot resume non-resumable run/,
      "a cancelling logical run cannot be resumed into a new adapter dispatch",
    );

    workSessions.close();
    agentRegistry.close();
  }

  {
    const dispatchKey = "disp-response-dropped";
    let acceptedRecord: { run_id: string; dispatch_idempotency_key: string } | undefined;
    let dispatchRequests = 0;
    const peer = createServer(async (req, res) => {
      if (req.method === "POST" && req.url === "/runs") {
        dispatchRequests += 1;
        const body = await readJson(req);
        acceptedRecord = {
          run_id: "remote-after-drop",
          dispatch_idempotency_key: String(body.dispatch_idempotency_key),
        };
        // Model an adapter that persisted/started the real run before the
        // acceptance response was lost at the transport boundary.
        res.destroy();
        return;
      }
      if (req.method === "GET" && req.url === `/runs/by-dispatch-id/${dispatchKey}`) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ accepted: true, run_id: acceptedRecord?.run_id, status: "running" }));
        return;
      }
      res.writeHead(404).end();
    });
    servers.push(peer);
    const peerPort = await listen(peer, "127.0.0.1");
    const root = await mkdtemp(join(tmpdir(), "kontrol-acp-response-loss-"));
    tempDirs.push(root);
    const db = openDatabase(root);
    seedWorkspace(root, "ws-response-loss");
    const workSessions = createWorkSessionManager(db);
    const agentRegistry = createAgentRegistryManager(db);
    const workSession = workSessions.create({ workspaceSessionId: "ws-response-loss", submittedBy: "test" });
    const gateway = {
      agentRegistry,
      workspaces: { getWorkspace: () => ({ id: "ws-response-loss", root: "/tmp", mode: "checkout" }) } as any,
      workSessions,
      adapterSecret: "secret",
    };
    const result = await callRemoteAgent(gateway, {
      agentUrl: `http://127.0.0.1:${peerPort}`,
      agentName: "remote-agent",
      task: "audit after connection loss",
      workspaceSessionId: "ws-response-loss",
      workSessionId: workSession.id,
      dispatchIdempotencyKey: dispatchKey,
      mode: "async",
      fireAndForget: true,
    });
    assert.equal(result.status, "uncertain");
    assert.equal(acceptedRecord?.dispatch_idempotency_key, dispatchKey);
    const uncertainRun = agentRegistry.getRunByDispatchIdempotencyKey(dispatchKey);
    assert.equal(uncertainRun?.status, "dispatch_uncertain");
    assert.equal(uncertainRun?.finishedAt, undefined, "transport uncertainty does not terminally fail the logical run");
    const attempt = agentRegistry.getDispatchAttemptByIdempotencyKey(dispatchKey);
    assert.equal(attempt?.status, "uncertain");

    const lookup = await lookupPeerDispatch({
      agentUrl: `http://127.0.0.1:${peerPort}`,
      adapterSecret: "secret",
      dispatchIdempotencyKey: dispatchKey,
    });
    assert.deepEqual(lookup, { status: "found", remoteRunId: "remote-after-drop", executionStatus: "running" });
    agentRegistry.updateDispatchAttempt(dispatchKey, { status: "accepted", remoteRunId: lookup.remoteRunId });
    agentRegistry.updateRun(uncertainRun!.runId, { status: "running", remoteRunId: lookup.remoteRunId });
    const submission = workSessions.submitForReview({ workSessionId: workSession.id, diff: "report", snapshotKind: "git", snapshotRef: "snapshot-a" });
    assert.ok(submission.id);
    assert.equal(agentRegistry.getRunByWorkSessionId(workSession.id)?.runId, uncertainRun?.runId,
      "the later submission still correlates to the original logical run after recovery");
    assert.equal(dispatchRequests, 1, "recovery lookup does not create a second remote run");
    acceptedRecord = undefined;
    assert.deepEqual(await lookupPeerDispatch({
      agentUrl: `http://127.0.0.1:${peerPort}`,
      adapterSecret: "secret",
      dispatchIdempotencyKey: dispatchKey,
    }), { status: "unknown" }, "an unrecognized successful lookup body remains unresolved");
    workSessions.close();
    agentRegistry.close();
  }

  {
    let resolveDispatch: (() => void) | undefined;
    let cancelSeen = false;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const delayedServer = createServer(async (req, res) => {
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200).end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.method === "POST" && req.url === "/runs") {
        await readJson(req);
        markStarted();
        await new Promise<void>((r) => { resolveDispatch = r; });
        res.writeHead(202, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ run_id: "remote-delayed", status: "running", output: [] }));
        return;
      }
      if (req.method === "POST" && req.url === "/runs/remote-delayed/cancel") {
        cancelSeen = true;
        res.writeHead(202, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ run_id: "remote-delayed", status: "cancelled" }));
        return;
      }
      res.writeHead(404).end();
    });
    servers.push(delayedServer);
    const delayedPort = await listen(delayedServer, "127.0.0.1");

    const root = await mkdtemp(join(tmpdir(), "kontrol-acp-gateway-race-"));
    tempDirs.push(root);
    const db = openDatabase(root);
    seedWorkspace(root, "ws-race");
    const workSessions = createWorkSessionManager(db);
    const agentRegistry = createAgentRegistryManager(db);
    const workSession = workSessions.create({ workspaceSessionId: "ws-race", submittedBy: "test" });
    const run = agentRegistry.createRun({
      agentName: "remote-agent",
      workspaceSessionId: "ws-race",
      workSessionId: workSession.id,
      inputPreview: "race",
      status: "running",
    });

    const call = callRemoteAgent(
      {
        agentRegistry,
        workspaces: { getWorkspace: () => ({ id: "ws-race", root: "/tmp", mode: "checkout" }) } as any,
        workSessions,
        adapterSecret: "secret",
      },
      {
        agentUrl: `http://127.0.0.1:${delayedPort}`,
        agentName: "remote-agent",
        task: "resume",
        workspaceSessionId: "ws-race",
        workSessionId: workSession.id,
        existingRunId: run.runId,
        mode: "async",
        fireAndForget: true,
      },
    );
    await started;
    workSessions.updateStatus(workSession.id, "cancelled");
    agentRegistry.updateRun(run.runId, { status: "cancelled" });
    resolveDispatch?.();
    const result = await call;
    assert.equal(result.status, "cancelled", "in-flight cancellation keeps logical run cancelled");
    assert.equal(cancelSeen, true, "accepted remote attempt is cancelled after late cancellation");
    const finalRun = agentRegistry.getRun(run.runId);
    assert.equal(finalRun?.status, "cancelled");
    assert.equal(finalRun?.remoteRunId, undefined, "late remote id is not recorded on cancelled logical run");

    workSessions.close();
    agentRegistry.close();
  }

  console.log("acp-gateway.test.ts: all assertions passed");
} finally {
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
}
