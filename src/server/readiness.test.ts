import assert from "node:assert/strict";
import type { Request } from "express";
import type { ServerConfig } from "../config.js";
import { createCachedAgentDispatchabilityProbe, readinessChecks, sendReadiness, type ReadinessDeps } from "./readiness.js";

let probes = 0;
const failedProbe = {
  dispatchable: false,
  checkedAt: "2026-10-30T00:00:00.000Z",
  failureCategory: "protocol_incompatible",
};
const cachedProbe = createCachedAgentDispatchabilityProbe(async () => {
  probes += 1;
  return failedProbe;
}, 60_000);
const config = {
  stateDir: "/tmp/kontrol-readiness-test-no-runtime-identity",
  acpEnabled: true,
  acpKnownAgents: [{ name: "worker", url: "http://127.0.0.1:4321" }],
  policy: { defaultMode: "allow", toolRules: {}, pathRules: [] },
  authMode: "none",
} as unknown as ServerConfig;
const deps: ReadinessDeps = {
  config,
  databaseProbe: () => undefined,
  schemaVersion: () => 0,
  schemaContract: () => ({ ok: true, detail: "test" }),
  executionAdmissionStats: () => ({ active: 0, activeWeight: 0, availableWeight: 1, queued: 0, maxInflight: 1 }),
  workspaceRegistryInitialized: () => true,
  reviewSubsystemInitialized: () => true,
  acpDispatcherInitialized: () => true,
  buildId: () => undefined,
  listAgents: () => [{ name: "worker", url: "http://127.0.0.1:4321", role: "agent", alive: true }],
  probeAgentDispatchability: cachedProbe,
};

const checks = await readinessChecks(deps, {} as Request, true);
assert.equal(checks.agents?.ok, false, "heartbeat and registration do not prove ACP protocol dispatchability");
assert.equal((checks.agents?.agents as Array<{ protocolReady: boolean }>)[0]?.protocolReady, false);
const reviewerChecks = await readinessChecks({
  ...deps,
  listAgents: () => [{ name: "worker", url: "http://127.0.0.1:4321", role: "reviewer", alive: true }],
}, {} as Request, true);
assert.equal(reviewerChecks.agents?.ok, false, "a live reviewer peer cannot satisfy a configured worker requirement");
assert.equal((reviewerChecks.agents?.agents as Array<{ dispatchable: boolean; role?: string }>)[0]?.dispatchable, false);
const expiredChecks = await readinessChecks({
  ...deps,
  listAgents: () => [{ name: "worker", url: "http://127.0.0.1:4321", role: "agent", alive: false }],
}, {} as Request, true);
const expired = (expiredChecks.agents?.agents as Array<{ registered: boolean; alive: boolean; failureCategory?: string }>)[0];
assert.equal(expired.registered, true, "an expired record remains distinguishable from an absent registration");
assert.equal(expired.alive, false);
assert.equal(expired.failureCategory, "registration_expired");
const capabilityConfig = {
  ...config,
  acpKnownAgents: [{ name: "worker", url: "http://127.0.0.1:4321", requiredExecutionCapabilities: ["read_only_audit"] }],
} as ServerConfig;
const capabilityDeps: ReadinessDeps = {
  ...deps,
  config: capabilityConfig,
  listAgents: () => [{ name: "worker", url: "http://127.0.0.1:4321", role: "agent", alive: true }],
  probeAgentDispatchability: async () => ({
    dispatchable: true,
    checkedAt: "2026-10-30T00:00:00.000Z",
    executionCapabilities: [],
  }),
};
const missingCapabilityChecks = await readinessChecks(capabilityDeps, {} as Request, true);
assert.equal(missingCapabilityChecks.agents?.ok, false, "protocol reachability does not prove a configured execution capability");
assert.deepEqual((missingCapabilityChecks.agents?.agents as Array<{ missingExecutionCapabilities: string[] }>)[0]?.missingExecutionCapabilities, ["read_only_audit"]);
const capableChecks = await readinessChecks({
  ...capabilityDeps,
  probeAgentDispatchability: async () => ({
    dispatchable: true,
    checkedAt: "2026-10-30T00:00:00.000Z",
    executionCapabilities: ["read_only_audit"],
  }),
}, {} as Request, true);
assert.equal(capableChecks.agents?.ok, true, "a healthy required worker with its declared execution capability is dispatchable");
const concurrent = await Promise.all([
  cachedProbe("http://127.0.0.1:4321"),
  cachedProbe("http://127.0.0.1:4321"),
]);
assert.deepEqual(concurrent, [failedProbe, failedProbe]);
assert.equal(probes, 1, "failed probe is cached and concurrent probes are coalesced");

let expiringProbes = 0;
const shortCache = createCachedAgentDispatchabilityProbe(async () => ({
  dispatchable: ++expiringProbes > 1,
  checkedAt: new Date().toISOString(),
}), 1);
assert.equal((await shortCache("http://127.0.0.1:4322")).dispatchable, false);
await new Promise((resolve) => setTimeout(resolve, 5));
assert.equal((await shortCache("http://127.0.0.1:4322")).dispatchable, true, "stale readiness probes expire and are refreshed");
assert.equal(expiringProbes, 2);

let readinessStatus = 0;
let readinessBody: unknown;
sendReadiness({
  setHeader() {},
  status(status: number) { readinessStatus = status; return this; },
  json(body: unknown) { readinessBody = body; return this; },
} as unknown as import("express").Response, checks, false);
assert.equal(readinessStatus, 503);
assert.deepEqual((readinessBody as { checks: { agents: unknown } }).checks.agents, { ok: false },
  "unauthenticated readiness remains boolean-only and withholds probe details");

console.log("readiness.test.ts: all assertions passed");
