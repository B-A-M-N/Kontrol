/**
 * Peer credential registry parsing and loading. The operator owns a JSON
 * registry of peer descriptors; only lowercase hex hashes are stored and
 * plaintext secrets never reach the filesystem. Parsing is structural and
 * fail-closed: any ambiguity is a concrete Error, never a lenient default.
 */
import { statSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { PeerCapability, PeerDescriptor } from "./config-types.js";
import { isPeerCapability } from "./config-types.js";

/** Domain separator for enrolled peer tokens. Never hash raw secrets alone. */
export const PEER_CREDENTIAL_HASH_DOMAIN = "kontrol-peer-credential-v1";

/** Lowercase hex sha256 of `${DOMAIN}\0${credentialId}\0${secret}`. */
export function hashPeerCredential(credentialId: string, secret: string): string {
  return createHash("sha256")
    .update(`${PEER_CREDENTIAL_HASH_DOMAIN}\0${credentialId}\0${secret}`)
    .digest("hex");
}

export interface PeerCredentialFingerprint {
  revision: number;
  hash: string;
}

export interface PeerCredentialFile {
  version: 1;
  peers: PeerDescriptor[];
}

const PEER_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const CREDENTIAL_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const CREDENTIAL_HASH_PATTERN = /^[a-f0-9]{64}$/;

function assertPlainObject(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Peer credential file: ${what} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertStringArray(value: unknown, what: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`Peer credential file: ${what} must be an array of strings`);
  }
  for (const entry of value) {
    if (typeof entry !== "string" || entry.trim() === "") {
      throw new Error(`Peer credential file: ${what} entries must be nonempty strings`);
    }
  }
  return value as string[];
}

function assertValidTimestamp(value: unknown, what: string): asserts value is string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new Error(`Peer credential file: ${what} must be a valid ISO-8601 date string`);
  }
}

function validatePeerDescriptor(raw: unknown, index: number): PeerDescriptor {
  const peer = assertPlainObject(raw, `peers[${index}]`);
  const where = `peers[${index}]`;

  if (typeof peer.id !== "string" || !PEER_ID_PATTERN.test(peer.id)) {
    throw new Error(`Peer credential file: ${where}.id must match /^[a-z0-9][a-z0-9_-]{0,63}$/`);
  }
  if (typeof peer.credentialId !== "string" || !CREDENTIAL_ID_PATTERN.test(peer.credentialId)) {
    throw new Error(`Peer credential file: ${where}.credentialId must match /^[A-Za-z0-9._-]{1,64}$/`);
  }
  if (typeof peer.credentialHash !== "string") {
    throw new Error(`Peer credential file: ${where}.credentialHash must be a string`);
  }
  const credentialHash = peer.credentialHash.toLowerCase();
  if (!CREDENTIAL_HASH_PATTERN.test(credentialHash)) {
    throw new Error(`Peer credential file: ${where}.credentialHash must be 64 hex characters`);
  }

  if (!Array.isArray(peer.capabilities) || peer.capabilities.length === 0) {
    throw new Error(`Peer credential file: ${where}.capabilities must be a nonempty array`);
  }
  for (const capability of peer.capabilities) {
    if (typeof capability !== "string" || !isPeerCapability(capability)) {
      throw new Error(`Peer credential file: ${where}.capabilities contains unknown capability: ${String(capability)}`);
    }
  }

  const grantedRoots = assertStringArray(peer.grantedRoots, `${where}.grantedRoots`);

  const descriptor: PeerDescriptor = {
    id: peer.id,
    credentialId: peer.credentialId,
    // Normalize once at the trust boundary so every consumer sees lowercase.
    credentialHash,
    capabilities: peer.capabilities as PeerCapability[],
    grantedRoots: [...grantedRoots],
  };
  if (peer.notBefore !== undefined) {
    assertValidTimestamp(peer.notBefore, `${where}.notBefore`);
    descriptor.notBefore = peer.notBefore as string;
  }
  if (peer.expiresAt !== undefined) {
    assertValidTimestamp(peer.expiresAt, `${where}.expiresAt`);
    descriptor.expiresAt = peer.expiresAt as string;
  }
  if (peer.revokedAt !== undefined) {
    assertValidTimestamp(peer.revokedAt, `${where}.revokedAt`);
    descriptor.revokedAt = peer.revokedAt as string;
  }
  return descriptor;
}

/** Parse + validate registry JSON. Throws a concrete Error on ANY structural problem. */
export function parsePeerCredentialFile(raw: string): PeerCredentialFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Peer credential file: invalid JSON (${(error as Error).message})`);
  }

  const root = assertPlainObject(parsed, "top level");
  if (root.version !== 1) {
    throw new Error(`Peer credential file: version must be 1 (got ${JSON.stringify(root.version)})`);
  }
  if (!Array.isArray(root.peers)) {
    throw new Error("Peer credential file: peers must be an array");
  }

  const peers = root.peers.map(validatePeerDescriptor);

  const seenIds = new Set<string>();
  const seenIdCredentialPairs = new Set<string>();
  const seenHashes = new Set<string>();
  for (const peer of peers) {
    const pair = `${peer.id}\0${peer.credentialId}`;
    if (seenIdCredentialPairs.has(pair)) {
      throw new Error(`Peer credential file: duplicate (id, credentialId) pair: ${peer.id}/${peer.credentialId}`);
    }
    seenIdCredentialPairs.add(pair);
    if (seenIds.has(peer.id)) {
      throw new Error(`Peer credential file: duplicate peer id: ${peer.id}`);
    }
    seenIds.add(peer.id);
    if (seenHashes.has(peer.credentialHash)) {
      throw new Error(`Peer credential file: duplicate credentialHash across peers (equal credentials undermine per-peer separation)`);
    }
    seenHashes.add(peer.credentialHash);
  }

  return { version: 1, peers };
}

/**
 * Load + validate the registry file. Enforces unix permission hygiene
 * BEFORE reading: the file must exist and (stat.mode & 0o077) must be 0
 * (i.e. 0600 or 0400); otherwise throw. Throws on parse errors too.
 */
export function loadPeerCredentialFile(filePath: string): PeerCredentialFile {
  const stat = statSync(filePath);
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(`Peer credential file ${filePath} must not be group/other accessible (chmod 600 required)`);
  }
  return parsePeerCredentialFile(readFileSync(filePath, "utf8"));
}
