import assert from "node:assert/strict";
import {
  probeFailureCategory,
  probeFailureDetail,
  scrubAdapterDiagnostic,
  scrubbedDiagnosticTail,
} from "../scripts/lib/adapter-diagnostics.mjs";

const chr = (code) => String.fromCharCode(code);

// A launcher traceback must not turn the adapter log into a credential store.
assert.ok(
  !scrubAdapterDiagnostic("Authorization: Bearer abc123def456").includes("abc123def456"),
  "an authorization header never keeps its credential value",
);
assert.equal(
  scrubAdapterDiagnostic("failed with Bearer abc123def456"),
  "failed with Bearer [REDACTED]",
  "a bearer token keeps its scheme but loses its value",
);
assert.equal(
  scrubAdapterDiagnostic("KONTROL_ACP_AGENT_SECRET=supersecretvalue"),
  "KONTROL_ACP_AGENT_SECRET=[REDACTED]",
  "a control-plane secret never reaches the log",
);
assert.equal(
  scrubAdapterDiagnostic("refresh_token: rt-abcdefghijkl"),
  "refresh_token=[REDACTED]",
  "a sensitive key/value pair is redacted whatever its name",
);
assert.equal(
  scrubAdapterDiagnostic("agent_key=eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefgh"),
  "agent_key=[REDACTED]",
  "an agent key is redacted",
);
assert.equal(
  scrubAdapterDiagnostic("raw jwt eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefgh in text"),
  "raw jwt [REDACTED] in text",
  "a bare JWT is redacted even without a key name",
);

// A non-secret diagnostic keeps its content.
assert.equal(
  scrubAdapterDiagnostic("Hermes ACP launcher preflight failed: exit 1"),
  "Hermes ACP launcher preflight failed: exit 1",
  "ordinary diagnostics are not mangled",
);

// The tail is bounded and never splits a UTF-8 sequence.
const long = "x".repeat(500) + "y";
assert.equal(scrubbedDiagnosticTail(long, 100).length, 100,
  "the scrubbed tail is bounded to the requested byte budget");
const multibyte = "z".repeat(50) + "e" + chr(233);
const multibyteTail = scrubbedDiagnosticTail(multibyte, 4);
assert.equal(Buffer.byteLength(multibyteTail, "utf8"), 4,
  "the multibyte tail honors the byte budget");
assert.ok(multibyteTail.endsWith(chr(233)),
  "the tail keeps the last complete UTF-8 sequence");


// A failed probe may travel into an error message that becomes a
// scheduled-job receipt, so the category must carry no path, no stderr and
// no credential material.
assert.equal(probeFailureCategory({ status: 1 }), "exit_1",
  "a non-zero exit keeps only its status");
assert.equal(probeFailureCategory({ status: 0 }), "exit_0",
  "a successful probe still has a stable category");
assert.equal(probeFailureCategory({ status: null }), "terminated_without_status",
  "a child killed by a signal has no status to report");
assert.equal(probeFailureCategory({ status: null, error: { code: "ETIMEDOUT" } }), "timed_out",
  "a probe timeout is its own category");
assert.equal(probeFailureCategory({ status: null, error: { code: "ENOENT" } }), "spawn_failed",
  "a probe that could not spawn is its own category");

const secretFailure = {
  status: null,
  error: { code: "ENOENT", message: "spawnSync /opt/kontrol/hermes-bin/python ENOENT" },
  stderr: "Traceback: KONTROL_ACP_AGENT_SECRET=supersecretvalue",
};
const category = probeFailureCategory(secretFailure);
assert.ok(!category.includes("supersecretvalue"), "the category carries no credential material");
assert.ok(!category.includes("/opt/kontrol"), "the category carries no path");
assert.ok(!category.includes("Traceback"), "the category carries no stderr");

const detail = probeFailureDetail(secretFailure);
assert.ok(!detail.includes("supersecretvalue"),
  "the log detail is scrubbed of credential material before it is printed");
assert.ok(detail.includes("KONTROL_ACP_AGENT_SECRET=[REDACTED]"),
  "the log detail keeps the shape of the diagnostic without the secret");
assert.ok(detail.includes("stderr="), "the log detail carries the bounded stderr tail");
assert.ok(detail.includes("error="), "the log detail carries the bounded spawn error");
console.log("adapter-diagnostics.test.mjs: all assertions passed");
