/**
 * Tests for src/peer/auth.ts — registry authenticate semantics, windowed
 * descriptors, mtime-based hot reload, and the middleware's fail-closed
 * responses. Style: plain tsx script with node:assert/strict.
 */
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PeerCredentialRegistry, createPeerAuthMiddleware } from "./auth.js";
import { hashPeerCredential, type PeerCredentialFile } from "./credentials.js";
import type { PeerDescriptor } from "./config-types.js";

const dir = mkdtempSync(join(tmpdir(), "kontrol-peer-auth-test-"));
const registryPath = join(dir, "peer-credentials.json");

const secret = "peer-auth-valid-secret-that-is-at-least-32-chars";
const hash = hashPeerCredential("cred-1", secret);
const token = `Bearer cred-1:${secret}`;

function serialize(peers: PeerCredentialFile["peers"]): string {
  return JSON.stringify({ version: 1, peers });
}

function writeRegistry(peers: PeerCredentialFile["peers"], mtime?: Date): void {
  writeFileSync(registryPath, serialize(peers));
  chmodSync(registryPath, 0o600);
  if (mtime) utimesSync(registryPath, mtime, mtime);
}

const pastIso = "2020-01-01T00:00:00.000Z";
const futureIso = "2099-01-01T00:00:00.000Z";

const baseDescriptor: PeerDescriptor = {
  id: "meta-muse",
  credentialId: "cred-1",
  credentialHash: hash,
  capabilities: ["workspace:inspect", "job:claim"],
  grantedRoots: ["/srv/workspace"],
};

// Fresh registry with a valid descriptor.
writeRegistry([baseDescriptor]);
const registry = PeerCredentialRegistry.open(registryPath);

const principal = registry.authenticate(token);
assert.notEqual(principal, undefined, "valid token authenticates");
assert.equal(principal!.peerId, "meta-muse");
assert.equal(principal!.credentialId, "cred-1");
assert.equal(principal!.principalId, "peer:meta-muse:cred-1");
assert.deepEqual([...principal!.capabilities], ["workspace:inspect", "job:claim"]);
assert.deepEqual([...principal!.grantedRoots], ["/srv/workspace"]);
const dispatchDescriptor = registry.getActiveDescriptor("meta-muse");
assert.deepEqual(dispatchDescriptor, baseDescriptor, "trusted dispatch resolves the active enrolled descriptor");
dispatchDescriptor?.grantedRoots.push("/outside");
assert.deepEqual(registry.getActiveDescriptor("meta-muse")?.grantedRoots, ["/srv/workspace"], "dispatch descriptor is defensive-copied");
assert.equal(registry.getActiveDescriptor("unknown-peer"), undefined, "unknown peer cannot be resolved for dispatch");

assert.equal(registry.authenticate(`Bearer cred-1:wrong-secret-entirely-but-long-enough`), undefined, "wrong secret rejected");
assert.equal(registry.authenticate("Bearer unknown-cred:some-secret-long-enough"), undefined, "unknown credentialId rejected");
assert.equal(registry.authenticate(`Bearer cred-1:short`), undefined, "short secret rejected");
assert.equal(registry.authenticate("Basic cred-1:some-secret-long-enough"), undefined, "non-Bearer scheme rejected");
assert.equal(registry.authenticate("Bearer no-separator"), undefined, "missing secret separator rejected");
assert.equal(registry.authenticate(undefined), undefined, "missing header rejected");

// Windowed descriptors fail closed.
writeRegistry([{ ...baseDescriptor, revokedAt: pastIso }], new Date());
let hot = PeerCredentialRegistry.open(registryPath);
assert.equal(hot.authenticate(token), undefined, "revoked credential rejected");
assert.equal(hot.getActiveDescriptor("meta-muse"), undefined, "revoked peer cannot be selected for dispatch");

writeRegistry([{ ...baseDescriptor, expiresAt: pastIso }], new Date());
hot = PeerCredentialRegistry.open(registryPath);
assert.equal(hot.authenticate(token), undefined, "expired credential rejected");
assert.equal(hot.getActiveDescriptor("meta-muse"), undefined, "expired peer cannot be selected for dispatch");

writeRegistry([{ ...baseDescriptor, notBefore: futureIso }], new Date());
hot = PeerCredentialRegistry.open(registryPath);
assert.equal(hot.authenticate(token), undefined, "not-yet-valid credential rejected");
assert.equal(hot.getActiveDescriptor("meta-muse"), undefined, "not-yet-valid peer cannot be selected for dispatch");

// Future revokedAt / past notBefore still authenticate (window checks only).
writeRegistry([{ ...baseDescriptor, revokedAt: futureIso, notBefore: pastIso }], new Date());
hot = PeerCredentialRegistry.open(registryPath);
assert.notEqual(hot.authenticate(token), undefined, "future revokedAt does not reject");

// Hot reload: rewrite the file with revokedAt in the past, bump mtime, and
// the SAME registry instance must pick up the revocation.
writeRegistry([baseDescriptor], new Date());
const persistent = PeerCredentialRegistry.open(registryPath);
assert.notEqual(persistent.authenticate(token), undefined, "pre-revocation authenticate succeeds");

const revokedDescriptor = { ...baseDescriptor, revokedAt: pastIso };
writeRegistry([revokedDescriptor], new Date(Date.now() + 2000));
assert.equal(persistent.authenticate(token), undefined, "hot reload picks up revocation after mtime change");

// Missing/malformed/over-permissive registry observations fail closed. A
// malformed CHANGED publication may retain the prior generation only during a
// narrow atomic-rename grace; the second observation clears it.
const atomicWindow = new Date(Date.now() + 5000);
writeRegistry([baseDescriptor], atomicWindow);
const failClosed = PeerCredentialRegistry.open(registryPath);
assert.notEqual(failClosed.authenticate(token), undefined, "pre-failure authenticate succeeds");
writeFileSync(registryPath, "{ truncated");
chmodSync(registryPath, 0o600);
const malformedTime = new Date(Date.now() + 6000);
utimesSync(registryPath, malformedTime, malformedTime);
assert.equal(failClosed.authenticate(token), undefined, "malformed changed registry never authenticates while its invalid bytes are present");
assert.equal(failClosed.snapshot().degraded, true, "malformed registry reports degraded");

// A successful atomic replacement installs a new monotonic generation.
writeRegistry([baseDescriptor], new Date(Date.now() + 7000));
assert.notEqual(failClosed.authenticate(token), undefined, "valid replacement restores authentication");
assert.ok(failClosed.snapshot().generation > 1, "registry generation advances on successful reload");

// Registry disappearance is immediate revocation, not transient operation.
const missingPath = registryPath;
writeRegistry([baseDescriptor]);
const missing = PeerCredentialRegistry.open(missingPath);
assert.notEqual(missing.authenticate(token), undefined);
rmSync(missingPath);
assert.equal(missing.authenticate(token), undefined, "missing registry fails closed on first observation");
assert.equal(missing.snapshot().reason, "missing", "missing registry reports its reason");

// Wrong permissions are also an immediate revocation event.
writeRegistry([baseDescriptor]);
if (process.platform !== "win32") {
  chmodSync(registryPath, 0o640);
  assert.equal(failClosed.authenticate(token), undefined, "over-permissive POSIX registry fails closed");
}
chmodSync(registryPath, 0o600);

// Middleware: success sets req.peerPrincipal; failure responds 401 with a
// fixed body; >30 failures per IP within 60s respond 429.
const logging = { level: "silent" };
writeRegistry([baseDescriptor], new Date(Date.now() + 3000));
const workingMiddleware = createPeerAuthMiddleware(PeerCredentialRegistry.open(registryPath), { logging });
type FakeResponse = { statusCode?: number; body?: unknown; status(code: number): FakeResponse; json(body: unknown): FakeResponse };
function fakeResponse(): FakeResponse {
  const res: FakeResponse = {
    statusCode: undefined,
    body: undefined,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.body = body;
      return res;
    },
  };
  return res;
}
const fakeRequest = (authorization?: string) => ({ header: (name: string) => (name === "authorization" ? authorization : undefined), ip: "10.0.0.1" } as never);
const fakeNext = (() => {
  let called = false;
  const next = () => {
    called = true;
  };
  next.wasCalled = () => called;
  return next;
})() as (() => void) & { wasCalled(): boolean };

// Verify principal lands on the request object: use a mutable req carrier.
const reqCarrier: { peerPrincipal?: unknown } = {};
const reqWithPrincipal = {
  header: (name: string) => (name === "authorization" ? token : undefined),
  ip: "10.0.0.2",
  get peerPrincipal() {
    return reqCarrier.peerPrincipal;
  },
  set peerPrincipal(value: unknown) {
    reqCarrier.peerPrincipal = value;
  },
} as never;
workingMiddleware(reqWithPrincipal, fakeResponse() as never, (() => {}) as never);
assert.notEqual(reqCarrier.peerPrincipal, undefined, "middleware sets req.peerPrincipal");

// Failure path: bad token → 401 unauthorized_peer.
const resFail = fakeResponse();
let nextAfterFail = false;
workingMiddleware(fakeRequest("Bearer cred-1:totally-wrong-secret-value"), resFail as never, (() => {
  nextAfterFail = true;
}) as never);
assert.equal(nextAfterFail, false, "failed auth does not call next");
assert.equal(resFail.statusCode, 401);
assert.deepEqual(resFail.body, { error: { code: "unauthorized_peer", message: "Peer authentication failed" } });

// Rate limit: 31+ failures from one IP within 60s → 429 peer_auth_rate_limited.
const rateLimitedMiddleware = createPeerAuthMiddleware(PeerCredentialRegistry.open(registryPath), { logging });
let saw429 = false;
let lastBody: unknown;
for (let i = 0; i < 35; i++) {
  const res = fakeResponse();
  rateLimitedMiddleware(fakeRequest("Bearer cred-1:still-the-wrong-secret"), res as never, (() => {}) as never);
  if (res.statusCode === 429) {
    saw429 = true;
    lastBody = res.body;
    break;
  }
}
assert.equal(saw429, true, "rate limiter engages after 30 failures");
assert.deepEqual(lastBody, { error: { code: "peer_auth_rate_limited", message: "Too many failed peer authentication attempts" } });

// Per-credential budget: a single credential ID reaches 429 even when each
// failure comes from a distinct IP.
const credentialLimitedMiddleware = createPeerAuthMiddleware(PeerCredentialRegistry.open(registryPath), { logging });
let credentialSaw429 = false;
for (let i = 0; i < 35; i++) {
  const res = fakeResponse();
  const req = {
    header: (name: string) => (name === "authorization" ? `Bearer cred-1:wrong-secret-${i}-long-enough-for-validation` : undefined),
    ip: `10.20.${i % 250}.${Math.floor(i / 250) + 1}`,
  };
  credentialLimitedMiddleware(req as never, res as never, (() => {}) as never);
  if (res.statusCode === 429) {
    credentialSaw429 = true;
    break;
  }
}
assert.equal(credentialSaw429, true, "per-credential failure budget engages independently of IP");

console.log("src/peer/auth.test.ts: all assertions passed");
