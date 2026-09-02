import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const state = await mkdtemp(join(tmpdir(), "kontrol-stdio-integration-"));
const events = [];
const control = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
  if (req.url?.endsWith("/agents/register")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "stdio-test-agent", agentCredential: "stdio-test-credential" }));
    return;
  }
  if (req.url?.includes("/events")) events.push(body);
  res.writeHead(202, { "content-type": "application/json" });
  res.end(JSON.stringify({ accepted: true }));
});
await new Promise((resolve) => control.listen(0, "127.0.0.1", resolve));
const controlPort = control.address().port;
const adapterPort = await new Promise((resolve) => {
  const probe = createServer();
  probe.listen(0, "127.0.0.1", () => {
    const port = probe.address().port;
    probe.close(() => resolve(port));
  });
});
const childCode = `let b="";process.stdin.setEncoding("utf8");process.stdin.on("data",c=>{b+=c;for(const line of b.split(/\\r?\\n/).slice(0,-1)){const m=JSON.parse(line);if(m.method==="session/prompt"){process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:m.id,result:{received:m.params.prompt}})+"\\n");setTimeout(()=>process.exit(0),20)}}b=b.split(/\\r?\\n/).at(-1)||""})`;
const adapter = spawn(process.execPath, ["scripts/acp-stdio-duplex-adapter.mjs"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    KONTROL_ACP_URL: `http://127.0.0.1:${controlPort}/acp`,
    KONTROL_ACP_AGENT_SECRET: "agent-secret",
    KONTROL_ACP_ADAPTER_SECRET: "adapter-secret",
    KONTROL_ACP_AGENT_STATE_FILE: join(state, "identity.json"),
    ACP_STDIO_AGENT_NAME: "stdio-test-agent",
    ACP_STDIO_COMMAND: process.execPath,
    ACP_STDIO_ARGS_JSON: JSON.stringify(["-e", childCode]),
    ACP_STDIO_ADAPTER_PORT: String(adapterPort),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
try {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${adapterPort}/health`);
      if (response.ok) break;
    } catch { /* adapter is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const emptyResponse = await fetch(`http://127.0.0.1:${adapterPort}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer adapter-secret" },
    body: JSON.stringify({ workspace_root: process.cwd(), input: [{ parts: [{ content: "   " }] }] }),
  });
  assert.equal(emptyResponse.status, 400, "empty ACP tasks must be rejected before spawning");
  const response = await fetch(`http://127.0.0.1:${adapterPort}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer adapter-secret" },
    body: JSON.stringify({ workspace_root: process.cwd(), input: [{ parts: [{ content: "task reaches stdio child" }] }] }),
  });
  assert.equal(response.status, 202);
  const deadlineForEvent = Date.now() + 5_000;
  while (Date.now() < deadlineForEvent && !events.some((event) => JSON.stringify(event).includes("task reaches stdio child"))) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(events.some((event) => JSON.stringify(event).includes("task reaches stdio child")), "dispatched task did not reach child stdin");
  console.log("acp-stdio-duplex-integration: task reached child stdin");
} finally {
  adapter.kill("SIGTERM");
  await new Promise((resolve) => adapter.once("exit", resolve));
  await new Promise((resolve) => control.close(resolve));
  await rm(state, { recursive: true, force: true });
}
