#!/usr/bin/env node
// P1-C focused regression: harness qualification separates per-capability
// verdicts, and a required-but-undemonstrated capability fails the profile.
// Runs entirely offline with an inline fixture agent (no model, no network).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const harness = join(root, "scripts", "qualify-acp-harness.mjs");

function fixtureAgent({ loadSession }) {
  return [
    "const rl = require('readline').createInterface({ input: process.stdin, terminal: false });",
    "rl.on('line', (line) => {",
    "  let msg; try { msg = JSON.parse(line); } catch { return; }",
    "  if (msg.id === undefined) return;",
    "  const respond = (result, error) => process.stdout.write(JSON.stringify(",
    "    error ? { jsonrpc: '2.0', id: msg.id, error } : { jsonrpc: '2.0', id: msg.id, result }) + '\\n');",
    "  if (msg.method === 'initialize') respond({ protocolVersion: 1,",
    `    agentCapabilities: ${loadSession ? "{ loadSession: true }" : "{}"}, agentInfo: { name: 'fixture', version: '0' } });`,
    "  else if (msg.method === 'session/new') respond({ sessionId: 'sess-1' });",
    loadSession
      ? "  else if (msg.method === 'session/load') respond({ sessionId: 'sess-1' });"
      : "  else if (msg.method === 'session/load') respond(null, { code: -32601, message: 'loadSession not supported' });",
    "  else if (msg.method === 'session/cancel') respond({});",
    "  else respond(null, { code: -32601, message: 'unknown method' });",
    "});",
    "process.on('SIGTERM', () => process.exit(0));",
    "rl.on('close', () => process.exit(0));",
  ].join("\n");
}

function qualify({ loadSession, require: required }) {
  const args = [
    harness,
    "--command", process.execPath,
    "--args-json", JSON.stringify(["-e", fixtureAgent({ loadSession })]),
    "--cwd", root,
    "--timeout-ms", "5000",
  ];
  if (required) args.push("--require", required);
  try {
    const stdout = execFileSync(process.execPath, args, { encoding: "utf8", timeout: 30_000 });
    return { status: 0, receipt: JSON.parse(stdout) };
  } catch (error) {
    return { status: error.status ?? "signal", stdout: error.stdout };
  }
}

// 1. Fully capable harness, full profile: qualified.
{
  const { status, receipt } = qualify({ loadSession: true, require: "handshake,new-session,continuation,cancellation" });
  assert.equal(status, 0, `capable harness must exit 0, got ${status}`);
  assert.equal(receipt.qualification.continuationQualified, true);
  assert.equal(receipt.qualification.cancellationQualified, true);
  assert.equal(receipt.qualification.overallQualifiedForRequestedCapabilities, true);
  console.log("qualify-acp-harness.test: full profile qualified — ok");
}

// 2. No loadSession, default one-shot profile: still qualifies overall.
{
  const { status, receipt } = qualify({ loadSession: false });
  assert.equal(status, 0, `one-shot harness must exit 0, got ${status}`);
  assert.equal(receipt.lifecycle.sessionLoad, "unsupported");
  assert.equal(receipt.qualification.continuationQualified, false);
  assert.equal(receipt.qualification.overallQualifiedForRequestedCapabilities, true);
  console.log("qualify-acp-harness.test: one-shot profile qualified — ok");
}

// 3. No loadSession, continuation required: nonzero, names the gap.
{
  const { status } = qualify({ loadSession: false, require: "handshake,new-session,continuation" });
  assert.equal(status, 1, `continuation profile must exit 1, got ${status}`);
  console.log("qualify-acp-harness.test: continuation gap fails closed — ok");
}

// 4. Unknown capability: usage error.
{
  const { status } = qualify({ loadSession: true, require: "teleportation" });
  assert.equal(status, 2, `unknown capability must exit 2, got ${status}`);
  console.log("qualify-acp-harness.test: unknown capability rejected — ok");
}

console.log("qualify-acp-harness.test: ALL CHECKS PASSED");
