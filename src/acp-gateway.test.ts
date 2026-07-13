import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import Database from "better-sqlite3";
import { authHeadersForAgent, dispatchToPeer, probeAgent } from "./acp-gateway.js";
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
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ run_id: "remote-direct", status: "completed", output: [] }));
        return;
      }
      res.writeHead(404).end();
    });
    servers.push(peer);
    const peerPort = await listen(peer, "0.0.0.0");

    const root = await mkdtemp(join(tmpdir(), "devdesktop-acp-gateway-"));
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
    assert.equal(response.status, 200);
    assert.equal(peerAuth, undefined, "direct /acp/runs forwarding does not leak shared bearer to non-loopback peers");
    assert.equal(peerBody?.agent_name, "remote-agent");

    workSessions.close();
    agentRegistry.close();
  }

  console.log("acp-gateway.test.ts: all assertions passed");
} finally {
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
}
