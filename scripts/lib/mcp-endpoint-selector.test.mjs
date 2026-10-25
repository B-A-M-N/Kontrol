import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authorizationForEndpoint, endpointFetch, EndpointPreferenceStore, McpEndpointSelector, parseMcpEndpointProfiles, restoreWorkerWorkspaceContext } from "./mcp-endpoint-selector.mjs";

const root = mkdtempSync(join(tmpdir(), "kontrol-mcp-endpoints-"));
try {
  const credential = join(root, "owner-a.bearer");
  const credentialB = join(root, "owner-b.bearer");
  writeFileSync(credential, "Bearer first-secret\n", { mode: 0o600 });
  writeFileSync(credentialB, "Bearer second-secret\n", { mode: 0o600 });
  chmodSync(credential, 0o600);
  chmodSync(credentialB, 0o600);
  const allowed = new Set(["read", "open_workspace", "bash"]);
  const profile = (id, hostname, options = {}) => ({
    id,
    url: "https://" + hostname + "/mcp",
    expectedTlsAuthority: hostname,
    principal: "owner_public",
    resourceIdentity: "https://" + hostname + "/mcp",
    allowedCapabilities: ["read", "open_workspace"],
    privacy: "public",
    auth: { type: "bearer_file", credentialRef: hostname.startsWith("mcp-b") ? credentialB : credential },
    circuitBreaker: { failureThreshold: 1, cooldownMs: 5000 },
    ...options,
  });
  const profiles = parseMcpEndpointProfiles(JSON.stringify([profile("primary", "mcp-a.example.test"), profile("secondary", "mcp-b.example.test")]), allowed, "owner_public");
  const preferenceStore = new EndpointPreferenceStore(join(root, "bridge-preference.json"), profiles);
  assert.deepEqual(preferenceStore.read(), ["primary", "secondary"], "missing preference uses configured endpoint order");
  preferenceStore.write(["secondary", "primary"]);
  assert.deepEqual(preferenceStore.read(), ["secondary", "primary"], "preference survives a fresh bridge process");
  assert.throws(() => preferenceStore.write(["secondary", "unknown"]), /exact ordering/);
  assert.equal(authorizationForEndpoint(profiles[0]), "Bearer first-secret");
  writeFileSync(credential, "Bearer rotated-secret\n", { mode: 0o600 });
  assert.equal(authorizationForEndpoint(profiles[0]), "Bearer rotated-secret", "credential content is reread on reconnect");
  assert.equal(JSON.stringify(profiles).includes("rotated-secret"), false, "profile snapshots never contain credential contents");

  for (const invalid of [
    profile("bad", "mcp-a.example.test", { expectedTlsAuthority: "other.example.test" }),
    profile("bad", "mcp-a.example.test", { principal: "reviewer" }),
    profile("bad", "mcp-a.example.test", { url: "https://mcp-a.example.test/mcp?x=1" }),
    profile("bad", "mcp-a.example.test", { resourceIdentity: "https://mcp-b.example.test/mcp" }),
    profile("bad", "mcp-a.example.test", { allowedCapabilities: ["provide_policy_approval"] }),
    profile("bad", "mcp-a.example.test", { auth: { type: "none" } }),
  ]) assert.throws(() => parseMcpEndpointProfiles(JSON.stringify([invalid]), allowed, "owner_public"));
  assert.throws(() => parseMcpEndpointProfiles(JSON.stringify([profile("same", "mcp-a.example.test"), profile("same", "mcp-b.example.test")]), allowed, "owner_public"), /unique/);
  assert.throws(() => parseMcpEndpointProfiles(JSON.stringify([profile("worker", "mcp-a.example.test")]), allowed, "worker"), /principals/);
  assert.throws(() => parseMcpEndpointProfiles(JSON.stringify([
    profile("a", "mcp-a.example.test"),
    profile("b", "mcp-b.example.test", { auth: { type: "bearer_file", credentialRef: credential } }),
  ]), allowed, "owner_public"), /cannot be shared across endpoint origins/);
  const ownerTools = new Set(["read", "provide_policy_approval"]);
  const ownerProfile = { ...profile("owner", "mcp-a.example.test", { allowedCapabilities: ["read", "provide_policy_approval"] }) };
  assert.equal(parseMcpEndpointProfiles(JSON.stringify([ownerProfile]), ownerTools, "owner_public")[0].principal, "owner_public");

  let now = 1000;
  const selector = new McpEndpointSelector(profiles, { now: () => now });
  assert.equal(selector.select().id, "primary", "selection respects configured order");
  selector.record("primary", false);
  assert.deepEqual(selector.snapshot()[0].state, "circuit_open");
  assert.equal(selector.select().id, "secondary", "an open primary circuit fails over to the next endpoint");
  selector.record("secondary", true);
  assert.equal(selector.snapshot()[1].successes, 1);
  selector.record("secondary", false);
  assert.equal(selector.snapshot()[1].state, "circuit_open");
  assert.throws(() => selector.select(), (error) => error.retryAfterMs === 5000, "all-open profiles wait out their cooldown instead of probing early");
  now += 5001;
  assert.equal(selector.select().id, "primary", "an expired circuit admits a fresh qualification attempt");
  selector.record("primary", true);
  assert.equal(selector.snapshot()[0].state, "eligible", "successful qualification closes the circuit");
  selector.setPreference(preferenceStore.read());
  assert.equal(selector.select().id, "secondary", "operator preference determines the next endpoint attempt");
  assert.deepEqual(selector.snapshot().map((endpoint) => endpoint.id), ["secondary", "primary"]);

  const privateLocal = parseMcpEndpointProfiles(JSON.stringify([{
    id: "loopback", url: "http://127.0.0.1:7676/mcp", expectedTlsAuthority: "127.0.0.1:7676",
    principal: "worker", allowedCapabilities: ["read"], privacy: "private", auth: { type: "worker_envelope" },
  }]), allowed, "worker")[0];
  assert.equal(authorizationForEndpoint(privateLocal), "");
  const guardedFetch = endpointFetch(profiles[0], async (url, options) => {
    assert.equal(new URL(url).origin, "https://mcp-a.example.test");
    assert.equal(options.redirect, "manual");
    return new Response("ok", { status: 200 });
  });
  assert.equal(await (await guardedFetch("https://mcp-a.example.test/mcp")).text(), "ok");
  await assert.rejects(() => guardedFetch("https://mcp-b.example.test/mcp"), /leave its configured origin/);
  await assert.rejects(() => endpointFetch(profiles[0], async () => new Response(null, { status: 302, headers: { location: "https://evil.example.test/mcp" } }))("https://mcp-a.example.test/mcp"), /cross-origin/);
  const restoredArguments = { path: "/approved/project", mode: "checkout" };
  let restoredCall;
  await restoreWorkerWorkspaceContext({
    async callTool(request) { restoredCall = request; return { structuredContent: { workspaceId: "workspace-1" } }; },
  }, { arguments: restoredArguments, workspaceId: "workspace-1" });
  assert.deepEqual(restoredCall, { name: "open_workspace", arguments: restoredArguments });
  await assert.rejects(() => restoreWorkerWorkspaceContext({
    async callTool() { return { structuredContent: { workspaceId: "other-workspace" } }; },
  }, { arguments: restoredArguments, workspaceId: "workspace-1" }), /authorized workspace context/);
  console.log("MCP endpoint selector tests passed");
} finally { rmSync(root, { recursive: true, force: true }); }
