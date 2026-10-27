/**
 * Tests for src/peer/credentials.ts — hash domain separation, registry
 * parsing validation, and unix permission hygiene. Style: plain tsx script
 * with node:assert/strict (see src/config.test.ts).
 */
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  PEER_CREDENTIAL_HASH_DOMAIN,
  hashPeerCredential,
  loadPeerCredentialFile,
  parsePeerCredentialFile,
  type PeerCredentialFile,
} from "./credentials.js";

const secret = "enrolled-secret-that-is-at-least-32-characters";
const id = "meta-muse";
const credentialId = "cred-1";

// Domain separation: hash equals sha256(DOMAIN\0credentialId\0secret), and
// differs from a naive unseparated or unhashed-domain computation.
const expected = createHash("sha256")
  .update(`${PEER_CREDENTIAL_HASH_DOMAIN}\0${credentialId}\0${secret}`)
  .digest("hex");
assert.equal(hashPeerCredential(credentialId, secret), expected);
assert.equal(/^[a-f0-9]{64}$/.test(expected), true, "hash is lowercase hex sha256");
assert.notEqual(hashPeerCredential(credentialId, secret), createHash("sha256").update(secret).digest("hex"));
assert.notEqual(hashPeerCredential(credentialId, secret), createHash("sha256").update(`${credentialId}${secret}`).digest("hex"));
// Determinism + input sensitivity.
assert.equal(hashPeerCredential(credentialId, secret), hashPeerCredential(credentialId, secret));
assert.notEqual(hashPeerCredential(credentialId, secret), hashPeerCredential("cred-2", secret));
assert.notEqual(hashPeerCredential(credentialId, secret), hashPeerCredential(credentialId, "other-secret-long-enough"));

function validPeer(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "meta-muse",
    credentialId: "cred-1",
    credentialHash: hashPeerCredential("cred-1", secret),
    capabilities: ["workspace:inspect"],
    grantedRoots: ["/srv/workspace"],
    ...overrides,
  };
}

function serialize(peers: unknown[]): string {
  return JSON.stringify({ version: 1, peers });
}

// Valid file parses.
const good: PeerCredentialFile = parsePeerCredentialFile(serialize([
  {
    id: "meta-muse",
    credentialId: "cred-1",
    credentialHash: hashPeerCredential("cred-1", secret),
    capabilities: ["workspace:inspect", "job:claim"],
    grantedRoots: ["/srv/workspace"],
    notBefore: "2026-01-01T00:00:00.000Z",
    expiresAt: "2027-01-01T00:00:00.000Z",
  },
  {
    id: "other-peer",
    credentialId: "cred-2",
    credentialHash: hashPeerCredential("cred-2", secret),
    capabilities: ["workspace:propose_patch"],
    grantedRoots: ["/srv/other"],
    revokedAt: "2026-06-01T00:00:00.000Z",
  },
]));
assert.equal(good.version, 1);
assert.equal(good.peers.length, 2);
assert.equal(good.peers[0].id, "meta-muse");
assert.deepEqual(good.peers[0].capabilities, ["workspace:inspect", "job:claim"]);
assert.equal(good.peers[0].notBefore, "2026-01-01T00:00:00.000Z");

// Empty peers array is structurally valid (callers decide policy).
assert.equal(parsePeerCredentialFile(serialize([])).peers.length, 0);

const rejects = (raw: string, pattern: RegExp, label: string): void => {
  assert.throws(() => parsePeerCredentialFile(raw), pattern, label);
};

// Bad version.
rejects('{"version":2,"peers":[]}', /version must be 1/, "bad version rejected");
rejects('{"peers":[]}', /version must be 1/, "missing version rejected");

// Not an object / invalid JSON / missing peers array.
rejects("[]", /top level must be an object/, "array top level rejected");
rejects("not json", /invalid JSON/, "invalid JSON rejected");
rejects('{"version":1}', /peers must be an array/, "missing peers rejected");

// Shape validation.
rejects(serialize([validPeer({ id: "Bad-Id" })]), /\.id must match/, "bad peer id shape rejected");
rejects(serialize([validPeer({ id: "" })]), /\.id must match/, "empty peer id rejected");
rejects(serialize([validPeer({ credentialId: "bad id!" })]), /\.credentialId must match/, "bad credentialId shape rejected");
rejects(serialize([validPeer({ credentialHash: "not-hex" })]), /credentialHash must be 64 hex/, "bad credentialHash shape rejected");
rejects(serialize([validPeer({ credentialHash: "ABCDEF" })]), /credentialHash must be 64 hex/, "short hash rejected");
rejects(serialize([validPeer({ capabilities: ["not:a:capability"] })]), /unknown capability/, "unknown capability rejected");
rejects(serialize([validPeer({ capabilities: [] })]), /capabilities must be a nonempty array/, "empty capabilities rejected");
rejects(serialize([validPeer({ grantedRoots: ["/ok", ""] })]), /nonempty strings/, "empty root string rejected");
rejects(serialize([validPeer({ notBefore: "yesterday-ish" })]), /notBefore must be a valid ISO-8601/, "invalid notBefore rejected");
rejects(serialize([validPeer({ expiresAt: "someday" })]), /expiresAt must be a valid ISO-8601/, "invalid expiresAt rejected");
rejects(serialize([validPeer({ revokedAt: "revoked" })]), /revokedAt must be a valid ISO-8601/, "invalid revokedAt rejected");
rejects(serialize([validPeer({ expiresAt: null })]), /expiresAt must be a valid ISO-8601/, "null expiresAt rejected");

// Duplicates.
rejects(
  serialize([validPeer(), validPeer({ credentialId: "cred-2", credentialHash: hashPeerCredential("cred-2", secret) })]),
  /duplicate peer id/,
  "duplicate peer id rejected",
);
const samePair = { credentialHash: hashPeerCredential("cred-2", secret) };
rejects(
  serialize([validPeer({ credentialId: "cred-1" }), { ...validPeer({ credentialId: "cred-1" }), ...samePair }]),
  /duplicate \(id, credentialId\) pair/,
  "duplicate (id, credentialId) pair rejected",
);
rejects(
  serialize([
    validPeer(),
    validPeer({ id: "other-peer", credentialId: "cred-2", credentialHash: hashPeerCredential("cred-1", secret) }),
  ]),
  /duplicate credentialHash/,
  "equal credentialHash across peers rejected",
);

// Uppercase hex hash normalizes to lowercase.
const upperHash = hashPeerCredential("cred-1", secret).toUpperCase();
const upper = parsePeerCredentialFile(serialize([validPeer({ credentialHash: upperHash })]));
assert.equal(upper.peers[0].credentialHash, hashPeerCredential("cred-1", secret));

// File loading + permission hygiene.
const dir = mkdtempSync(join(tmpdir(), "kontrol-peer-credentials-test-"));
const credentialFile = join(dir, "peer-credentials.json");
writeFileSync(credentialFile, serialize([validPeer()]));

chmodSync(credentialFile, 0o644);
chmodSync(credentialFile, 0o666);
if (process.platform !== "win32") {
  assert.throws(() => loadPeerCredentialFile(credentialFile), /chmod 600 required/, "mode 0644 rejected");
  assert.throws(() => loadPeerCredentialFile(credentialFile), /chmod 600 required/, "mode 0666 rejected");
}
chmodSync(credentialFile, 0o600);
const loaded = loadPeerCredentialFile(credentialFile);
assert.equal(loaded.version, 1);
assert.equal(loaded.peers[0].credentialId, "cred-1");
chmodSync(credentialFile, 0o400);
assert.equal(loadPeerCredentialFile(credentialFile).peers.length, 1, "mode 0400 accepted");

console.log("src/peer/credentials.test.ts: all assertions passed");
