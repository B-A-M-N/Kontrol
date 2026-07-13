import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import Database from "better-sqlite3";
import { authHeadersForAgent, callRemoteAgent, dispatchToPeer, probeAgent } from "./acp-gateway.js";
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
      sharedSecret: "secret",
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
          sharedSecret: "secret",
        },
        {
          agentUrl: "http://127.0.0.1:9",
          agentName: "remote-agent",
          task: "resume",
          existingRunId: run.runId,
          mode: "async",
        },
      ),
      /Cannot resume terminal run/,
    );

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
        sharedSecret: "secret",
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
