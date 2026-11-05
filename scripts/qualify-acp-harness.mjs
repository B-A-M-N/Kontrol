#!/usr/bin/env node
/**
 * Operator-run ACP harness qualification.
 *
 * Spawns one generic ACP agent command over stdio and walks the
 * inference-free lifecycle: initialize → session/new → session/load →
 * session/cancel (or close). No prompt is ever sent, so no model call, no
 * credentials, and no workspace mutation occur.
 *
 * On success it writes a capability receipt recording the harness's
 * self-reported protocol version and session capabilities — observed, never
 * inferred from configuration. On any failure it exits non-zero with the
 * failing step; a harness that cannot complete this walk is not qualified.
 *
 * Usage:
 *   node scripts/qualify-acp-harness.mjs --command /path/to/agent \
 *     --args-json '["acp"]' --cwd /tmp --out /tmp/harness-receipt.json \
 *     [--require handshake,new-session,continuation,cancellation]
 *
 * --require selects the qualification profile (default: handshake,new-session).
 * A harness that cannot demonstrate every required capability exits non-zero.
 */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

function usageError(message) {
  console.error(`usage: qualify-acp-harness.mjs --command <path> [--args-json <json>] [--cwd <dir>] [--out <path>] [--timeout-ms <n>] [--require <caps>]\nerror: ${message}`);
  process.exit(2);
}

const argv = process.argv.slice(2);
function flag(name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

const command = flag("--command");
if (!command) usageError("--command is required");
const args = flag("--args-json") ? JSON.parse(flag("--args-json")) : [];
if (!Array.isArray(args) || !args.every((entry) => typeof entry === "string")) usageError("--args-json must be a JSON array of strings");
const cwd = flag("--cwd") || process.cwd();
const outPath = flag("--out") || "";
const timeoutMs = Number(flag("--timeout-ms") || "30000");
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) usageError("--timeout-ms must be positive");
// P1-C: the qualification profile under test. A harness without loadSession
// may qualify for one-shot execution but must not qualify for
// continuation-dependent workflows: a required capability that is not
// demonstrated produces a nonzero exit for that profile.
const KNOWN_CAPABILITIES = ["handshake", "new-session", "continuation", "cancellation"];
const requiredCapabilities = (flag("--require") ?? "handshake,new-session")
  .split(",").map((entry) => entry.trim()).filter(Boolean);
for (const entry of requiredCapabilities) {
  if (!KNOWN_CAPABILITIES.includes(entry)) usageError(`--require capability must be one of ${KNOWN_CAPABILITIES.join(",")}: ${entry}`);
}

const child = spawn(command, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
let buffer = "";
const pending = new Map();
let nextId = 1;
let settled = false;

function fail(step, detail) {
  if (settled) return;
  settled = true;
  console.error(`harness qualification FAILED at ${step}: ${detail}`);
  child.kill("SIGKILL");
  process.exit(1);
}

child.stdout.on("data", (chunk) => {
  buffer += String(chunk);
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message.id !== undefined && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  }
});
child.stderr.on("data", () => { /* harness diagnostics stay out of the receipt */ });
child.on("error", (error) => fail("spawn", error.message));
child.on("exit", (code) => {
  if (!settled) fail("lifecycle", `harness exited early with code ${code}`);
});

function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timed out waiting for ${method}`));
    }, timeoutMs);
    pending.set(id, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`, (error) => {
      if (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(error);
      }
    });
  });
}

const globalTimer = setTimeout(() => fail("lifecycle", `global deadline exceeded (${timeoutMs}ms per step)`), timeoutMs * 5 + 10_000);

try {
  const initialize = await request("initialize", {
    protocolVersion: 1,
    clientCapabilities: {},
    clientInfo: { name: "kontrol-harness-qualification", version: "1" },
  });
  if (initialize.error) fail("initialize", JSON.stringify(initialize.error));
  const protocolVersion = initialize.result?.protocolVersion;
  if (protocolVersion !== 1 && protocolVersion !== 2) {
    fail("initialize", `unsupported protocol version: ${JSON.stringify(protocolVersion)}`);
  }
  const agentCapabilities = initialize.result?.agentCapabilities ?? {};
  const agentInfo = initialize.result?.agentInfo ?? {};

  const created = await request("session/new", { cwd, mcpServers: [] });
  if (created.error) fail("session/new", JSON.stringify(created.error));
  const sessionId = created.result?.sessionId;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    fail("session/new", `no sessionId returned: ${JSON.stringify(created.result)}`);
  }

  // session/load proves the harness honors the resumability it advertises.
  // A harness without loadSession must fail here rather than silently
  // starting a fresh conversation; that failure disqualifies it for
  // continuation but is recorded, not retried.
  let loadSession = "unsupported";
  let loadDetail = "";
  if (agentCapabilities?.loadSession === true || protocolVersion === 2) {
    const loaded = await request("session/load", { sessionId, cwd, mcpServers: [] });
    if (loaded.error) {
      loadSession = "failed";
      loadDetail = JSON.stringify(loaded.error);
    } else {
      loadSession = "supported";
    }
  }

  // Cancel the idle session; no prompt was ever sent, so no model inference
  // could have started. A harness without session/cancel still qualifies if
  // it exits cleanly on stdin close.
  let cancel = "unsupported";
  try {
    const cancelled = await request("session/cancel", { sessionId });
    cancel = cancelled.error ? `failed: ${JSON.stringify(cancelled.error)}` : "supported";
  } catch (error) {
    cancel = `failed: ${error.message}`;
  }

  // P1-C: per-capability verdicts. A successful handshake never implies
  // resumability: continuation requires an observed session/load round-trip.
  const qualification = {
    handshake: true, // reaching this line proves initialize succeeded
    "new-session": true, // reaching this line proves session/new succeeded
    continuation: loadSession === "supported",
    cancellation: cancel === "supported",
  };
  const missing = requiredCapabilities.filter((entry) => !qualification[entry]);
  const receipt = {
    tool: "qualify-acp-harness",
    qualifiedAt: new Date().toISOString(),
    harness: { command, args, cwd },
    protocolVersion,
    agentName: typeof agentInfo?.name === "string" ? agentInfo.name : "unknown",
    agentVersion: typeof agentInfo?.version === "string" ? agentInfo.version : "unknown",
    capabilities: {
      loadSession: agentCapabilities?.loadSession === true,
      sessionCapabilities: agentCapabilities?.sessionCapabilities ?? null,
      promptCapabilities: agentCapabilities?.promptCapabilities ?? null,
      mcpCapabilities: agentCapabilities?.mcpCapabilities ?? null,
    },
    lifecycle: {
      initialize: "supported",
      sessionNew: "supported",
      sessionLoad: loadSession,
      ...(loadDetail ? { sessionLoadDetail: loadDetail } : {}),
      sessionCancel: cancel,
    },
    qualification: {
      handshakeQualified: qualification.handshake,
      newSessionQualified: qualification["new-session"],
      continuationQualified: qualification.continuation,
      cancellationQualified: qualification.cancellation,
      requiredCapabilities,
      overallQualifiedForRequestedCapabilities: missing.length === 0,
    },
    inferenceFree: true,
    note: "Handshake and session lifecycle only; permission requests, tool execution, prompts, and restart recovery need a live review session and are not covered.",
  };
  if (outPath) writeFileSync(outPath, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(JSON.stringify(receipt, null, 2));
  settled = true;
  clearTimeout(globalTimer);
  // P1-C: never claim a clean shutdown without the child's confirmed exit.
  // SIGTERM first (clean harness shutdown), bounded wait, then SIGKILL.
  child.kill("SIGTERM");
  const exited = await new Promise((resolvePromise) => {
    const timer = setTimeout(() => resolvePromise(false), 5_000);
    child.once("exit", () => { clearTimeout(timer); resolvePromise(true); });
  });
  if (!exited) {
    child.kill("SIGKILL");
    const reaped = await new Promise((resolvePromise) => {
      const timer = setTimeout(() => resolvePromise(false), 5_000);
      child.once("exit", () => { clearTimeout(timer); resolvePromise(true); });
    });
    if (!reaped) {
      console.error("harness qualification CLEANUP_FAILED: agent child survived SIGKILL");
      process.exit(3);
    }
  }
  if (missing.length > 0) {
    console.error(`harness qualification FAILED for profile [${requiredCapabilities.join(",")}]: missing ${missing.join(",")}`);
    process.exit(1);
  }
  process.exit(0);
} catch (error) {
  fail("lifecycle", error.message);
}
