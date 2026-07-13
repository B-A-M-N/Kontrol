// Shared HMAC-signed worker envelope (PURE JavaScript — no TypeScript).
//
// The adapter (trusted, server-side) signs a WorkerToken when it dispatches a
// coding-agent run. The stdio bridge (which runs INSIDE the untrusted worker
// process) merely relays the token to Kontrol. Kontrol verifies the HMAC and
// derives the caller's role + bound work session from the SIGNED payload — so a
// worker cannot drop its work-session identity to acquire reviewer rights, nor
// forge a token it was not issued.
//
// This module is plain JS (no deps) so both the TypeScript server (src/) and
// the JavaScript adapter (scripts/acp-crush-adapter.mjs) can import it.

import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * @typedef {Object} WorkerTokenClaims
 * @property {"worker"} role
 * @property {string} workSessionId
 * @property {string} workspaceSessionId
 * @property {string} [runId]
 * @property {string} [continuationId]
 * @property {number} exp - epoch ms
 */

export const TOKEN_TTL_MS = 60 * 60 * 1000; // 1h — a run seldom outlives this

function base64url(input) {
  return Buffer.from(input)
    .toString("base64url")
    .replace(/=+$/, "");
}

function base64urlJson(value) {
  return base64url(JSON.stringify(value));
}

// Node's native base64url decoder — returns the raw bytes. This is the correct
// inverse of base64url(); do NOT use toString("base64") which would re-encode.
function decodeBase64url(value) {
  return Buffer.from(value, "base64url");
}

/**
 * @param {WorkerTokenClaims} claims
 * @param {string} secret
 * @returns {string}
 */
export function signWorkerToken(claims, secret) {
  const header = base64urlJson({ alg: "HS256", typ: "JWT" });
  const payload = base64urlJson(claims);
  const signature = base64url(
    createHmac("sha256", secret).update(`${header}.${payload}`).digest(),
  );
  return `${header}.${payload}.${signature}`;
}

export class WorkerTokenError extends Error {
  constructor(message) {
    super(message);
    this.name = "WorkerTokenError";
  }
}

/**
 * @param {string} token
 * @param {string} secret
 * @returns {WorkerTokenClaims}
 */
export function verifyWorkerToken(token, secret) {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new WorkerTokenError("malformed worker token");
  }
  const [header, payload, signature] = parts;

  // Verify the HMAC over the raw bytes of the signature (not a re-encoding).
  const actualSignature = decodeBase64url(signature);
  const expectedSignature = createHmac("sha256", secret)
    .update(`${header}.${payload}`)
    .digest();

  if (
    actualSignature.length !== expectedSignature.length ||
    !timingSafeEqual(actualSignature, expectedSignature)
  ) {
    throw new WorkerTokenError("invalid worker token signature");
  }

  let claims;
  try {
    claims = JSON.parse(decodeBase64url(payload).toString("utf8"));
  } catch {
    throw new WorkerTokenError("corrupt worker token payload");
  }
  if (typeof claims.exp !== "number" || Date.now() > claims.exp) {
    throw new WorkerTokenError("worker token expired");
  }
  if (claims.role !== "worker" || typeof claims.workSessionId !== "string") {
    throw new WorkerTokenError("worker token missing required claims");
  }
  return claims;
}
