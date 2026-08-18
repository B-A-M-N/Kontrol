import assert from "node:assert/strict";
import { resolve } from "node:path";

const baseUrl = process.env.KONTROL_UAT_URL ?? "http://127.0.0.1:7676/mcp";
const bearer = process.env.KONTROL_TUNNEL_TOKEN;
const reviewer = process.env.KONTROL_ACP_REVIEWER_SECRET;
if (!reviewer) throw new Error("KONTROL_ACP_REVIEWER_SECRET is required.");

let sessionId;
let id = 0;
function decode(text) {
  const body = text.trim();
  const data = body.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
  return JSON.parse(data || body);
}
async function rpc(method, params, { session = true } = {}) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "x-kontrol-reviewer-token": reviewer,
  };
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  if (session && sessionId) headers["mcp-session-id"] = sessionId;
  const response = await fetch(baseUrl, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
  const payload = decode(await response.text());
  if (method === "initialize") sessionId = response.headers.get("mcp-session-id") ?? sessionId;
  if (!response.ok || payload.error) throw new Error(`${method}: ${payload.error?.message ?? response.status}`);
  return payload.result;
}
async function tool(name, args) {
  const result = await rpc("tools/call", { name, arguments: args });
  if (result.isError) throw new Error(`${name}: ${result.content?.map((item) => item.text).join(" ")}`);
  return result.structuredContent ?? result;
}
async function notify(method, params) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "x-kontrol-reviewer-token": reviewer,
    "mcp-session-id": sessionId,
  };
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const response = await fetch(baseUrl, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", method, params }) });
  if (!response.ok) throw new Error(`${method}: ${response.status}`);
}

await rpc("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "kontrol-live-supervisor-uat", version: "1" },
}, { session: false });
if (!sessionId) throw new Error("Server did not return an MCP session id.");
await notify("notifications/initialized", {});

if (process.argv[2] === "cancel") {
  const sessionIdToCancel = process.argv[3];
  if (!sessionIdToCancel) throw new Error("usage: live-supervisor-uat.mjs cancel <workSessionId>");
  await tool("cancel_work_session", { sessionId: sessionIdToCancel });
  console.log(JSON.stringify({ cancelled: sessionIdToCancel }));
  process.exit(0);
}

if (process.argv[2] === "resume") {
  const sessionIdToResume = process.argv[3];
  if (!sessionIdToResume) throw new Error("usage: live-supervisor-uat.mjs resume <workSessionId>");
  const inspected = await tool("inspect_supervised_work", { workSessionId: sessionIdToResume });
  let packet = inspected.packet ?? inspected;
  assert.equal(packet?.supervisor?.status, "paused", `expected paused supervisor, got ${packet?.supervisor?.status ?? "unknown"}`);
  await tool("resume_supervisor_run", { workSessionId: sessionIdToResume, expectedRevision: packet.supervisor.revision });
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const next = await tool("inspect_supervised_work", { workSessionId: sessionIdToResume });
    packet = next.packet ?? next;
    if (["completed", "awaiting_human", "failed", "cancelled"].includes(packet.supervisor?.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  assert.equal(packet?.supervisor?.status, "completed", `recovered mission did not complete: ${packet?.supervisor?.status ?? "unknown"}`);
  assert.equal(packet?.mission?.approval?.allowed, true, "recovered completion must satisfy the mission predicate");
  assert.ok((packet?.mission?.completionReports ?? []).some((report) => report.status === "passed"), "recovered mission must record a passing final integration report");
  console.log(JSON.stringify({ workSessionId: sessionIdToResume, recovered: true, supervisorStatus: packet.supervisor.status, cycleNumber: packet.supervisor.cycleNumber }));
  process.exit(0);
}

const uatWorkspace = resolve(process.env.KONTROL_UAT_WORKSPACE ?? ".kontrol-uat");
const opened = await tool("open_workspace", { path: uatWorkspace, mode: "checkout" });
const criterionId = `tests-${Date.now()}`;
const started = await tool("begin_supervised_work", {
  workspaceSessionId: opened.workspaceId,
  objective: "Fix the add function so the supplied test passes.",
  acceptanceCriteria: [{ id: criterionId, description: "The fixture test suite passes", priority: "required", verificationType: "test", verificationCommand: "npm test" }],
  finalVerification: ["npm test"],
  autonomyMode: "correction_auto",
  approvalMode: "policy_auto",
  maxCorrectionRounds: 3,
  maxWallTimeMinutes: 20,
  workOrder: {
    objectiveForThisTurn: "Inspect only. Do not modify files in this first turn; submit the current snapshot for review.",
    prohibitedActions: ["Do not modify files during this first inspection turn."],
    expectedDeliverables: ["A review submission of the unchanged fixture."],
  },
  agentName: process.env.KONTROL_UAT_AGENT_NAME ?? "cli-coding-agent",
});
const workSessionId = started.workSessionId;
assert.ok(workSessionId, "begin_supervised_work must return a work session");

if (process.argv[2] === "stage1") {
  const initial = await tool("inspect_supervised_work", { workSessionId });
  const initialPacket = initial.packet ?? initial;
  assert.equal(initialPacket?.supervisor?.status, "worker_active", "new mission must be active before it can be paused for recovery UAT");
  await tool("pause_supervisor_run", { workSessionId, expectedRevision: initialPacket.supervisor.revision });
  let pausedPacket;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const inspected = await tool("inspect_supervised_work", { workSessionId });
    pausedPacket = inspected.packet ?? inspected;
    if (pausedPacket?.supervisor?.status === "paused" && pausedPacket?.session?.status === "awaiting_review" && pausedPacket?.submission?.id) break;
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  assert.equal(pausedPacket?.supervisor?.status, "paused", "supervisor must remain paused while Kontrol is restarted");
  assert.equal(pausedPacket?.session?.status, "awaiting_review", "native Hermes turn must persist its review submission before restart");
  assert.ok(pausedPacket?.submission?.id, "paused recovery UAT requires a persisted submission");
  console.log(JSON.stringify({ workSessionId, stage: "paused_after_submission", submissionId: pausedPacket.submission.id, supervisorRevision: pausedPacket.supervisor.revision }));
  process.exit(0);
}

let packet;
for (let attempt = 0; attempt < 80; attempt += 1) {
  const inspected = await tool("inspect_supervised_work", { workSessionId });
  packet = inspected.packet ?? inspected;
  const status = packet.supervisor?.status;
  if (["completed", "awaiting_human", "failed", "cancelled"].includes(status)) break;
  await new Promise((resolve) => setTimeout(resolve, 5_000));
}

assert.equal(packet?.supervisor?.status, "completed", `mission did not complete: ${packet?.supervisor?.status ?? "unknown"}`);
assert.equal(packet?.mission?.approval?.allowed, true, "completion packet must satisfy mission approval predicate");
assert.ok((packet?.mission?.completionReports ?? []).some((report) => report.status === "passed"), "final integration report must pass");
console.log(JSON.stringify({ workSessionId, supervisorStatus: packet.supervisor.status, cycleNumber: packet.supervisor.cycleNumber, completionReports: packet.mission.completionReports.length }));
