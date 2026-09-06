/**
 * P0.6 invariants: the shared sanitizer removes credentials from every
 * durable telemetry shape, and shell telemetry stores hash+preview instead
 * of raw command text.
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redactString, redactValue, redactedPreview, shellTelemetrySync, isSensitiveKeyName } from "./redaction.js";
import { runShellTool } from "./pi-tools.js";

// ── Key-name redaction ──
for (const key of ["API_TOKEN", "client_secret", "DB_PASSWORD", "SERVICE_CREDENTIAL", "TLS_PRIVATE_KEY", "AUTHORIZATION", "Cookie", "KONTROL_RUNTIME_LOCK_TOKEN", "ACP_REVIEWER_SECRET", "OAUTH_ACCESS_TOKEN"]) {
  assert.equal(isSensitiveKeyName(key), true, `${key} is a sensitive key name`);
}
for (const key of ["PATH", "HOME", "command", "path", "timeout", "workspaceId"]) {
  assert.equal(isSensitiveKeyName(key), false, `${key} is not a sensitive key name`);
}

// ── Value redaction ──
assert.ok(!redactString("Authorization: Bearer abc123.def456").includes("abc123"), "Bearer tokens are redacted");
assert.ok(!redactString("GITHUB_TOKEN=ghp_abcdefghijklmnop").includes("ghp_abcdefghijklmnop"), "TOKEN=value forms are redacted");
assert.ok(!redactString("KONTROL_ACP_WORKER_SECRET: super-secret-value").includes("super-secret-value"), "KONTROL_* assignments are redacted");
assert.ok(redactString("ordinary text survives"), "ordinary text is preserved");
assert.equal(redactString("git status --porcelain"), "git status --porcelain", "benign commands pass through unchanged");

// ── Deep value redaction ──
const redacted = redactValue({
  command: "echo $MY_SECRET && env",
  env: { API_TOKEN: "hunter2", PATH: "/bin" },
  nested: { authorization: "Bearer xyz" },
});
const serialized = JSON.stringify(redacted);
assert.ok(!serialized.includes("hunter2"), "sensitive env values are redacted in structured input");
assert.ok(serialized.includes("/bin"), "benign values survive structured redaction");
assert.ok(!serialized.includes("Bearer xyz"), "nested authorization headers are redacted");

// ── Preview bounding ──
const long = "x".repeat(500);
assert.ok(redactedPreview(long).length <= 163, "previews are bounded");

// ── Shell telemetry storage model ──
const secretCommand = "echo SECRET_VALUE=super-secret-12345";
const telemetry = shellTelemetrySync(secretCommand);
assert.equal(telemetry.commandHash.length, 64, "shell telemetry keeps a SHA-256 identity");
assert.ok(!telemetry.commandPreview.includes("super-secret-12345"), "shell preview is redacted");
assert.ok(telemetry.commandPreview.includes("SECRET_VALUE=[REDACTED]"), "the key shape survives redaction");
assert.ok(telemetry.commandLength >= secretCommand.length, "command length is preserved for shape analysis");

// ── End-to-end: real MCP bash output containing an env dump is redacted in the
// shape that would be persisted ──
const cwd = mkdtempSync(join(tmpdir(), "kontrol-redaction-test-"));
writeFileSync(join(cwd, "leaky.txt"), "token=abc123\n");
process.env.REDACTION_CANARY_TOKEN = "canary-secret-value-123456";
const response = await runShellTool(
  { command: "env | grep -c REDACTION_CANARY; echo token=$REDACTION_CANARY_TOKEN", timeout: 30 },
  { cwd, root: cwd, childEnvironmentAllowlist: [] },
);
const outputText = response.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
const persistedSummary = redactedPreview(outputText, 2000);
assert.ok(!persistedSummary.includes("canary-secret-value-123456"), "output summaries that would be persisted never contain the secret");
assert.ok(readFileSync(join(cwd, "leaky.txt"), "utf8").includes("abc123"), "sanity: fixture unchanged");

console.log("redaction.test.ts: all assertions passed");
