import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const adapter = readFileSync("scripts/acp-hermes-native-adapter.mjs", "utf8");
assert.match(adapter, /const execution = run\.boundedFileWrite/);
assert.match(adapter, /if \(run\.readOnlyAudit \|\| run\.boundedFileWrite\)/);
assert.match(adapter, /networkPolicy: run\.execution\.networkPolicy/);
assert.match(adapter, /grant_fingerprint: run\.execution\.grantFingerprint/);
assert.match(adapter, /mode: run\.execution\.mode/);
assert.match(adapter, /execution_grant: run\.execution\.grant/);
assert.doesNotMatch(adapter, /run\.readOnlyExecutionGrant\.networkPolicy/);
assert.doesNotMatch(adapter, /grant_fingerprint: createHash\("sha256"\)\.update\(run\.readOnlyExecutionGrant\.signature\)/);
assert.match(adapter, /run\.execution\.mode === "bounded_file_write" \? \{ KONTROL_BOUNDED_FILE_WRITE: "1" \} : \{ KONTROL_READ_ONLY_EXECUTION: "1" \}/);
console.log("scripts/hermes-execution-mode.test.mjs: execution-mode assertions passed");
