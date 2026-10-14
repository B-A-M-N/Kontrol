import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  EXTERNAL_CATALOG_OBSERVATION_MAX_BYTES,
  fingerprintExternalToolCatalog,
  validateExternalCatalogObservation,
} from "./external-catalog-capture.js";

const tools = [
  {
    name: "read",
    description: "Read a file",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", minLength: 1 } },
      required: ["path"],
    },
  },
];
const fingerprint = fingerprintExternalToolCatalog(tools)!;
const now = new Date().toISOString();
const base = {
  contractVersion: 1,
  captureId: "capture-external-1",
  capturedAt: now,
  hostKind: "chatgpt",
  serverVersion: "1.0.4+build-a",
  sessionIdSha256: createHash("sha256").update("session-a").digest("hex"),
  initializeResult: { serverInfo: { name: "kontrol", version: "1.0.4+build-a" } },
  toolsListResult: { tools },
};

const unsupported = validateExternalCatalogObservation(base, now);
assert.equal(unsupported.status, "host_capture_unsupported");
assert.equal(unsupported.observationSource, "operator_reported");
assert.equal(unsupported.hostCatalogSha256, undefined);
assert.ok(unsupported.validationReasons.includes("host_capture_unsupported"));

const matched = validateExternalCatalogObservation({
  ...base,
  registeredCatalog: structuredClone(tools),
  acknowledgement: {
    method: "notifications/experimental/kontrol/tool-catalog-accepted",
    contractVersion: 1,
    captureId: base.captureId,
    serverVersion: base.serverVersion,
    hostCatalogSha256: fingerprint.sha256,
    hostToolCount: fingerprint.toolCount,
  },
}, now);
assert.equal(matched.status, "operator_reported_match");
assert.equal(matched.observationSource, "operator_reported",
  "caller-supplied registration evidence cannot be upgraded to host integration evidence");
assert.deepEqual(matched.registeredCatalog, tools, "the complete registered descriptors are retained");

const changedNestedSchema = structuredClone(tools);
changedNestedSchema[0].inputSchema.properties.path.minLength = 2;
const mismatch = validateExternalCatalogObservation({
  ...base,
  registeredCatalog: changedNestedSchema,
  acknowledgement: {
    method: "notifications/experimental/kontrol/tool-catalog-accepted",
    contractVersion: 1,
    captureId: base.captureId,
    serverVersion: base.serverVersion,
    hostCatalogSha256: fingerprint.sha256,
    hostToolCount: fingerprint.toolCount,
  },
}, now);
assert.equal(mismatch.status, "operator_reported_mismatch");
assert.ok(mismatch.validationReasons.includes("registered_catalog_mismatch"));
assert.ok(mismatch.validationReasons.includes("acknowledgement_catalog_mismatch"));

assert.throws(() => validateExternalCatalogObservation({
  ...base,
  observationSource: "host_integration",
}, now), /Invalid input|Unrecognized key/,
"the submission cannot self-assert host integration provenance");

assert.throws(() => validateExternalCatalogObservation({
  ...base,
  initializeResult: { serverInfo: { name: "kontrol", version: "different" } },
}, now), /initializeResult.serverInfo.version/);

assert.throws(() => validateExternalCatalogObservation({
  ...base,
  toolsListResult: { tools: [{ ...tools[0], description: "x".repeat(EXTERNAL_CATALOG_OBSERVATION_MAX_BYTES) }] },
}, now), /exceeds/);

console.log("external-catalog-capture.test.ts: provenance and exact descriptor validation passed");
